import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Money } from "../domain/money";
import { Wallet } from "../domain/wallet";
import { processWager } from "../domain/process-wager";
import {
  WagerTransaction,
  WagerTransactionStatus,
  type WagerTransactionState,
} from "../domain/wager-transaction";
import { selectWagerEvents } from "../application/wager-event-types";
import { DATABASE_POOL } from "../api/database.provider";

@Injectable()
export class PendingReferenceReconciler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PendingReferenceReconciler.name);
  private timer?: ReturnType<typeof setInterval>;
  private activeCycle?: Promise<void>;
  private running = false;
  private stopping = false;

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  onModuleInit(): void {
    this.startCycle();

    this.timer = setInterval(() => {
      this.startCycle();
    }, Number(process.env.REFERENCE_POLL_INTERVAL_MS ?? 5000));
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearInterval(this.timer);
    }

    await this.activeCycle;
  }

  private startCycle(): void {
    if (this.stopping || this.running) return;

    this.running = true;
    this.activeCycle = this.reconcilePending().finally(() => {
      this.running = false;
    });
  }

  async reconcilePending(): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const pending = await client.query(`
        SELECT *
        FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE'
          AND next_reference_attempt_at <= NOW()
        ORDER BY next_reference_attempt_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);

      const row = pending.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return;
      }

      const transaction = WagerTransaction.rehydrate({
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
        money: Money.from({
          amount: String(row.amount),
          currency: row.currency,
        }),
        referenceExternalTransactionId:
          row.reference_external_transaction_id ?? undefined,
        createdAt: new Date(row.created_at),
        status: row.status,
        referenceTransactionId: row.reference_transaction_id ?? undefined,
        failureCode: row.failure_code ?? undefined,
        processedAt: row.processed_at
          ? new Date(row.processed_at)
          : undefined,
      } satisfies WagerTransactionState);

      const walletResult = await client.query(
        "SELECT * FROM wallets WHERE id = $1 FOR UPDATE",
        [transaction.walletId],
      );

      const walletRow = walletResult.rows[0];
      if (!walletRow) {
        throw new Error("Wallet não encontrada na reconciliação");
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

      const referenceResult = await client.query(
        `SELECT *
         FROM wager_transactions
         WHERE provider_id = $1
           AND external_transaction_id = $2`,
        [
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        ],
      );

      const referenceRow = referenceResult.rows[0];

      // Referência ausente ou ainda não terminal: apenas reagendar.
      if (
        !referenceRow ||
        !["PROCESSED", "REJECTED", "FAILED"].includes(referenceRow.status)
      ) {
        const attempts = Number(row.reference_attempts) + 1;
        const delay = Math.min(300, 2 ** Math.min(attempts, 8));

        await client.query(
          `UPDATE wager_transactions
           SET reference_attempts = $2,
               next_reference_attempt_at =
                 NOW() + ($3 * INTERVAL '1 second')
           WHERE id = $1`,
          [transaction.id, attempts, delay],
        );

        await client.query("COMMIT");
        return;
      }

      const reference = WagerTransaction.rehydrate({
        id: referenceRow.id,
        providerId: referenceRow.provider_id,
        externalTransactionId: referenceRow.external_transaction_id,
        idempotencyKey: referenceRow.idempotency_key,
        payloadHash: referenceRow.payload_hash,
        walletId: referenceRow.wallet_id,
        playerId: referenceRow.player_id,
        roundId: referenceRow.round_id,
        gameId: referenceRow.game_id,
        kind: referenceRow.kind,
        money: Money.from({
          amount: String(referenceRow.amount),
          currency: referenceRow.currency,
        }),
        referenceExternalTransactionId:
          referenceRow.reference_external_transaction_id ?? undefined,
        createdAt: new Date(referenceRow.created_at),
        status: referenceRow.status,
        referenceTransactionId:
          referenceRow.reference_transaction_id ?? undefined,
        failureCode: referenceRow.failure_code ?? undefined,
        processedAt: referenceRow.processed_at
          ? new Date(referenceRow.processed_at)
          : undefined,
      } satisfies WagerTransactionState);

      const reversed = await client.query(
        `SELECT 1
         FROM wager_transactions
         WHERE reference_transaction_id = $1
           AND status = 'PROCESSED'
           AND kind IN ('REFUND', 'ROLLBACK')
         LIMIT 1`,
        [reference.id],
      );

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
             reference_attempts = reference_attempts + 1,
             next_reference_attempt_at = NULL
         WHERE id = $6`,
        [
          transaction.status,
          transaction.referenceTransactionId ?? null,
          transaction.failureCode ?? null,
          transaction.processedAt ?? null,
          wallet.balance.toString(),
          transaction.id,
        ],
      );

      const eventTypes = selectWagerEvents({
        status: transaction.status,
        balanceBefore: entry?.balanceBefore.toString(),
        balanceAfter: entry?.balanceAfter.toString(),
      });

      for (const eventType of eventTypes) {
        const data =
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
            id, aggregate_id, event_type, payload, occurred_at
          ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            randomUUID(),
            transaction.id,
            eventType,
            JSON.stringify(data),
            now,
          ],
        );
      }

      await client.query("COMMIT");

      this.logger.log(
        `Transação ${transaction.id} reconciliada: ${transaction.status}`,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      this.logger.error(`Falha na reconciliação: ${String(error)}`);
    } finally {
      client.release();
    }
  }
}
