import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { computePayloadHash } from "../domain/payload-hash";
import { processWager } from "../domain/process-wager";
import { Money } from "../domain/money";
import {
  WagerTransaction,
  WagerTransactionStatus,
  type WagerTransactionState,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";

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

export class ProcessWagerTransaction {
  constructor(private readonly pool: Pool) {}

  async execute(transaction: WagerTransaction) {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const inserted = await client.query(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key,
          payload_hash, wallet_id, player_id, round_id, game_id,
          kind, amount, currency, reference_external_transaction_id,
          status, created_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING',$14
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
          await client.query("COMMIT");
          return { conflict: true as const };
        }

        await client.query("COMMIT");
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

      await client.query("COMMIT");

      return {
        conflict: false as const,
        idempotentReplay: false,
        transactionId: transaction.id,
        status: transaction.status,
        failureCode: transaction.failureCode,
        observedBalance: wallet.balance.toString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
