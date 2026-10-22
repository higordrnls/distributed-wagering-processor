import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { QueryResult } from "pg";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { computePayloadHash } from "../domain/payload-hash";
import { processWager } from "../domain/process-wager";
import { Money } from "../domain/money";
import {
  WagerTransaction,
  WagerTransactionStatus,
  type WagerTransactionState,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { selectWagerEvents } from "./wager-event-types";
import { OrmTransactionQuery } from "../infra/orm-transaction-query";
import { LockMode } from "@mikro-orm/core";
import { WalletEntity } from "../infra/entities/wallet.entity";

type TransactionQuery = {
  query(
    sql: string,
    params?: any[],
  ): Promise<QueryResult<any>>;
};

type DbRow = Record<string, any>;

function hydrateTransaction(row: DbRow): WagerTransaction {
  const state: WagerTransactionState = {
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: Money.from({ amount: String(row.amount), currency: row.currency }),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    createdAt: new Date(row.created_at),
    status: row.status,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: row.failure_code ?? undefined,
    processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
  };
  return WagerTransaction.rehydrate(state);
}

export type InboxContext = {
  consumerName: string;
  messageId: string;
  payloadHash: string;
};

export class ProcessWagerTransaction {
  constructor(
    private readonly pool: Pool,
    private readonly orm?: MikroORM,
  ) {}

  private async withOrmTransaction<T>(
    operation: (
      db: OrmTransactionQuery,
      em: EntityManager,
    ) => Promise<T>,
  ): Promise<T> {
    if (!this.orm) {
      throw new Error("MikroORM não configurado");
    }

    return this.orm.em.fork().transactional(async (em) => {
      const db = new OrmTransactionQuery(em);
      return operation(db, em);
    });
  }

  async execute(
    transaction: WagerTransaction,
    inbox?: InboxContext,
    correlationId: string = randomUUID(),
  ) {
    if (this.orm) {
      return this.withOrmTransaction((db, em) =>
        this.executeWithClient(
          transaction,
          inbox,
          correlationId,
          db,
          true,
          em,
        ),
      );
    }

    const client = await this.pool.connect();
    try {
      return await this.executeWithClient(
        transaction, inbox, correlationId, client, false,
      );
    } finally {
      client.release();
    }
  }

  private async executeWithClient(
    transaction: WagerTransaction,
    inbox: InboxContext | undefined,
    correlationId: string,
    client: TransactionQuery,
    ormManaged: boolean,
    em?: EntityManager,
  ) {
    try {
      if (!ormManaged) {
        await client.query("BEGIN");
      }

      // Serializa operações financeiras da mesma carteira antes
      // de inserir transações ou registros de inbox.
      if (em) {
        const lockedWallet = await em.findOne(
          WalletEntity,
          { id: transaction.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!lockedWallet) {
          throw new Error("Wallet não encontrada");
        }
      } else {
        const lockedWallet = await client.query(
          "SELECT id FROM wallets WHERE id = $1 FOR UPDATE",
          [transaction.walletId],
        );

        if (lockedWallet.rowCount === 0) {
          throw new Error("Wallet não encontrada");
      }
      }

      if (inbox) {
        const received = await client.query(
          `INSERT INTO inbox_messages (
            consumer_name, message_id, payload_hash, received_at, processed_at
          ) VALUES ($1, $2, $3, NOW(), NULL)
          ON CONFLICT DO NOTHING
          RETURNING message_id`,
          [inbox.consumerName, inbox.messageId, inbox.payloadHash],
        );

        if (received.rowCount === 0) {
          const existingInbox = await client.query(
            `SELECT payload_hash, processed_at
             FROM inbox_messages
             WHERE consumer_name = $1 AND message_id = $2
             FOR UPDATE`,
            [inbox.consumerName, inbox.messageId],
          );

          const row = existingInbox.rows[0];
          if (!row) {
            throw new Error("Registro de inbox não encontrado após conflito");
          }

          if (row.payload_hash !== inbox.payloadHash) {
            throw new Error("INBOX_MESSAGE_ID_CONFLICT");
          }

          if (row.processed_at) {
            const previous = await client.query(
              `SELECT id, status, failure_code, observed_balance
               FROM wager_transactions
               WHERE provider_id = $1 AND idempotency_key = $2`,
              [transaction.providerId, transaction.idempotencyKey],
            );

            const existing = previous.rows[0];

            if (!ormManaged) await client.query("COMMIT");

            return {
              conflict: false as const,
              idempotentReplay: true,
              inboxReplay: true,
              transactionId: existing?.id ?? transaction.id,
              status: existing?.status ?? "REJECTED",
              failureCode: existing?.failure_code ?? undefined,
              observedBalance:
                existing?.observed_balance == null
                  ? undefined
                  : String(existing.observed_balance),
            };
          }
        }
      }

      const inserted = await client.query(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key,
          payload_hash, wallet_id, player_id, round_id, game_id,
          kind, amount, currency, reference_external_transaction_id,
          status, created_at, correlation_id
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING',$14,$15
        )
        ON CONFLICT DO NOTHING
        RETURNING id`,
        [
          transaction.id,
          transaction.providerId,
          transaction.externalTransactionId,
          transaction.idempotencyKey,
          transaction.payloadHash,
          transaction.walletId,
          transaction.playerId,
          transaction.roundId,
          transaction.gameId,
          transaction.kind,
          transaction.money.toString(),
          transaction.money.currency,
          transaction.referenceExternalTransactionId ?? null,
          transaction.createdAt,
          correlationId,
        ],
      );

      if (inserted.rowCount === 0) {
        const result = await client.query(
          `SELECT * FROM wager_transactions
           WHERE provider_id = $1
             AND (idempotency_key = $2 OR external_transaction_id = $3)
           FOR UPDATE`,
          [
            transaction.providerId,
            transaction.idempotencyKey,
            transaction.externalTransactionId,
          ],
        );

        const existing = result.rows[0] as DbRow | undefined;
        if (!existing) {
          throw new Error("Conflito de unicidade sem transação correspondente");
        }

        const sameRequest =
          existing.idempotency_key === transaction.idempotencyKey &&
          existing.payload_hash === transaction.payloadHash;

        if (!sameRequest) {
          if (inbox) {
            await client.query(
              `UPDATE inbox_messages SET processed_at = NOW()
               WHERE consumer_name = $1 AND message_id = $2`,
              [inbox.consumerName, inbox.messageId],
            );
          }
          if (!ormManaged) await client.query("COMMIT");
          return { conflict: true as const };
        }

        if (inbox) {
          await client.query(
            `UPDATE inbox_messages SET processed_at = NOW()
             WHERE consumer_name = $1 AND message_id = $2`,
            [inbox.consumerName, inbox.messageId],
          );
        }
        if (!ormManaged) await client.query("COMMIT");
        return {
          conflict: false as const,
          idempotentReplay: true,
          transactionId: existing.id,
          status: existing.status,
          failureCode: existing.failure_code ?? undefined,
          observedBalance:
            existing.observed_balance == null
              ? undefined
              : String(existing.observed_balance),
        };
      }

      const walletResult = await client.query(
        "SELECT * FROM wallets WHERE id = $1 FOR UPDATE",
        [transaction.walletId],
      );

      const walletRow = walletResult.rows[0] as DbRow | undefined;
      if (!walletRow) {
        throw new Error("Wallet não encontrada");
      }

      const wallet = Wallet.rehydrate({
        id: walletRow.id,
        playerId: walletRow.player_id,
        currency: walletRow.currency,
        balance: Money.from({
          amount: String(walletRow.balance),
          currency: walletRow.currency,
        }),
        version: Number(walletRow.version),
        createdAt: new Date(walletRow.created_at),
        updatedAt: new Date(walletRow.updated_at),
      });

      let reference: WagerTransaction | undefined;
      if (transaction.referenceExternalTransactionId) {
        const result = await client.query(
          `SELECT * FROM wager_transactions
           WHERE provider_id = $1 AND external_transaction_id = $2`,
          [
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          ],
        );

        if (result.rows[0]) {
          reference = hydrateTransaction(result.rows[0] as DbRow);
        }
      }

      const reversed = reference
        ? await client.query(
            `SELECT 1 FROM wager_transactions
             WHERE reference_transaction_id = $1
               AND status = 'PROCESSED'
               AND kind IN ('REFUND', 'ROLLBACK')
             LIMIT 1`,
            [reference.id],
          )
        : { rowCount: 0 };

      const previousVersion = wallet.version;
      const now = new Date();

      const { entry } = processWager({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed: (reversed.rowCount ?? 0) > 0,
        entryId: randomUUID(),
        now,
      });

      if (wallet.version !== previousVersion) {
        if (em) {
          const managedWallet = em.getUnitOfWork()
            .getById<WalletEntity>(
              WalletEntity.name,
              wallet.id,
            );

          if (!managedWallet) {
            throw new Error("Carteira não encontrada no Identity Map");
          }

          managedWallet.balance = wallet.balance.toString();
          managedWallet.version = wallet.version;
          managedWallet.updatedAt = wallet.updatedAt;

          await em.flush();
        } else {
          await client.query(
            `UPDATE wallets
             SET balance = $1, version = $2, updated_at = $3
             WHERE id = $4`,
            [
              wallet.balance.toString(),
              wallet.version,
              wallet.updatedAt,
              wallet.id,
            ],
          );
        }
      }

      if (entry) {
        await client.query(
          `INSERT INTO wallet_ledger_entries (
            id, wallet_id, transaction_id, direction, amount,
            currency, balance_before, balance_after, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            entry.id,
            entry.walletId,
            entry.transactionId,
            entry.direction,
            entry.money.toString(),
            entry.money.currency,
            entry.balanceBefore.toString(),
            entry.balanceAfter.toString(),
            entry.createdAt,
          ],
        );
      }

      await client.query(
        `UPDATE wager_transactions
         SET status = $1,
             reference_transaction_id = $2,
             failure_code = $3,
             processed_at = $4,
             observed_balance = $5,
             next_reference_attempt_at = $6
         WHERE id = $7`,
        [
          transaction.status,
          transaction.referenceTransactionId ?? null,
          transaction.failureCode ?? null,
          transaction.processedAt ?? null,
          wallet.balance.toString(),
          transaction.status === WagerTransactionStatus.PendingReference
            ? new Date(now.getTime() + 1000)
            : null,
          transaction.id,
        ],
      );

      const eventTypes = selectWagerEvents({
        status: transaction.status,
        balanceBefore: entry?.balanceBefore.toString(),
        balanceAfter: entry?.balanceAfter.toString(),
      });

      for (const eventType of eventTypes) {
        const eventData =
          eventType === "WalletBalanceChanged"
            ? {
                walletId: wallet.id,
                transactionId: transaction.id,
                playerId: transaction.playerId,
                balanceBefore: entry!.balanceBefore.toJSON(),
                balanceAfter: entry!.balanceAfter.toJSON(),
              }
            : {
                transactionId: transaction.id,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                walletId: transaction.walletId,
                playerId: transaction.playerId,
                kind: transaction.kind,
                status: transaction.status,
                money: transaction.money.toJSON(),
                balance: wallet.balance.toJSON(),
                failureCode: transaction.failureCode ?? null,
              };

        await client.query(
          `INSERT INTO outbox_messages (
            id, aggregate_id, event_type, payload, occurred_at, correlation_id
          ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [
            randomUUID(),
            transaction.id,
            eventType,
            JSON.stringify(eventData),
            now,
            correlationId,
          ],
        );
      }

      if (inbox) {
        await client.query(
          `UPDATE inbox_messages SET processed_at = NOW()
           WHERE consumer_name = $1 AND message_id = $2`,
          [inbox.consumerName, inbox.messageId],
        );
      }

      if (!ormManaged) await client.query("COMMIT");

      return {
        conflict: false as const,
        idempotentReplay: false,
        transactionId: transaction.id,
        status: transaction.status,
        failureCode: transaction.failureCode,
        observedBalance: wallet.balance.toString(),
      };
    } catch (error) {
      if (!ormManaged) await client.query("ROLLBACK");
      throw error;
    }
  }
}
