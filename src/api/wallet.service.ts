import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Wallet } from "../domain/wallet";
import { DomainError } from "../domain/errors";
import { Money } from "../domain/money";
import { DATABASE_POOL } from "./database.provider";
import { MetricsService } from "./metrics.service";
import { OrmProvider } from "./orm.provider";
import { createWalletTransaction } from "../infra/create-wallet-transaction";

@Injectable()
export class WalletService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Optional() private readonly metrics: MetricsService | undefined,
    private readonly ormProvider: OrmProvider,
  ) {}

  async create(input: {
    playerId: string;
    initialBalance: { amount: string; currency: string };
  }) {
    if (
      typeof input?.playerId !== "string" ||
      !input.playerId.trim() ||
      typeof input?.initialBalance?.amount !== "string" ||
      typeof input?.initialBalance?.currency !== "string"
    ) {
      throw new BadRequestException("Dados da carteira inválidos");
    }

    let initialBalance: Money;

    try {
      initialBalance = Money.from({
        amount: input.initialBalance.amount,
        currency: input.initialBalance.currency,
      });
    } catch (error) {
      if (error instanceof DomainError) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }

    const now = new Date();
    const walletId = randomUUID();
    const openingTransactionId = randomUUID();
    const openingEntryId = randomUUID();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: input.playerId.trim(),
      initialBalance,
      now,
      openingEntryId,
      openingTransactionId,
    });

    try {
      const orm = await this.ormProvider.getOrm();

      await createWalletTransaction(
        orm,
        wallet,
        openingEntry,
        openingTransactionId,
      );

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    } catch (error) {
      // O MikroORM encapsula erros de restrição do PostgreSQL.
      const cause = error instanceof Error ? error.cause : undefined;
      const dbError = cause ?? error;

      if (
        typeof dbError === "object" &&
        dbError !== null &&
        "code" in dbError &&
        dbError.code === "23505"
      ) {
        throw new ConflictException(
          "Já existe uma carteira para este jogador e moeda",
        );
      }

      throw error;
    }
  }

  async findLedger(
    walletId: string,
    options: { cursor?: string; limit?: string },
  ) {
    const wallet = await this.pool.query(
      "SELECT id FROM wallets WHERE id = $1",
      [walletId],
    );

    if (wallet.rowCount === 0) {
      throw new NotFoundException("Carteira não encontrada");
    }

    const rawLimit = options.limit ?? "50";
    if (!/^\d+$/.test(rawLimit)) {
      throw new BadRequestException("Parâmetro limit inválido");
    }

    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException("limit deve estar entre 1 e 100");
    }

    let afterSeq = "0";
    if (options.cursor !== undefined) {
      try {
        const decoded = Buffer.from(options.cursor, "base64url").toString("utf8");
        if (!/^\d+$/.test(decoded) || decoded.length > 19) {
          throw new Error("Cursor inválido");
        }
        afterSeq = BigInt(decoded).toString();
        if (BigInt(afterSeq) < 0n) throw new Error("Cursor inválido");
      } catch {
        throw new BadRequestException("Cursor inválido");
      }
    }

    const result = await this.pool.query(
      `SELECT seq, id, wallet_id, transaction_id, direction, amount,
              currency, balance_before, balance_after, created_at
       FROM wallet_ledger_entries
       WHERE wallet_id = $1 AND seq > $2::bigint
       ORDER BY seq ASC
       LIMIT $3`,
      [walletId, afterSeq, limit + 1],
    );

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const lastSeq = rows.length ? String(rows[rows.length - 1].seq) : null;

    return {
      walletId,
      entries: rows.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        direction: row.direction,
        amount: {
          amount: String(row.amount),
          currency: row.currency,
        },
        balanceBefore: {
          amount: String(row.balance_before),
          currency: row.currency,
        },
        balanceAfter: {
          amount: String(row.balance_after),
          currency: row.currency,
        },
        createdAt: row.created_at,
      })),
      nextCursor: hasMore && lastSeq !== null
        ? Buffer.from(lastSeq, "utf8").toString("base64url")
        : null,
    };
  }

  async reconcile(walletId: string) {
    const result = await this.pool.query(
      `SELECT
         w.id,
         w.currency,
         w.balance AS stored_balance,
         COALESCE(
           SUM(
             CASE
               WHEN l.direction = 'CREDIT' THEN l.amount
               WHEN l.direction = 'DEBIT' THEN -l.amount
             END
           ),
           0
         ) AS calculated_balance,
         (w.balance - COALESCE(
           SUM(
             CASE
               WHEN l.direction = 'CREDIT' THEN l.amount
               WHEN l.direction = 'DEBIT' THEN -l.amount
             END
           ),
           0
         ))::numeric(18,2) AS difference,
         COUNT(l.id)::integer AS checked_entries
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE w.id = $1
       GROUP BY w.id, w.currency, w.balance`,
      [walletId],
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException("Carteira não encontrada");
    }

    const currency = String(row.currency);
    const storedBalance = String(row.stored_balance);
    const calculatedBalance = String(row.calculated_balance);
    const difference = String(row.difference);
    const consistent = Number(difference) === 0;

    if (!consistent) {
      this.metrics?.reconciliationMismatches.inc();

      console.warn(JSON.stringify({
        level: "warn",
        event: "wallet_reconciliation_mismatch",
        walletId: row.id,
        checkedEntries: row.checked_entries,
      }));
    }

    return {
      walletId: row.id,
      storedBalance: { amount: storedBalance, currency },
      calculatedBalance: { amount: calculatedBalance, currency },
      difference: { amount: difference, currency },
      consistent,
      checkedEntries: row.checked_entries,
    };
  }

  async findById(walletId: string) {
    const result = await this.pool.query(
      `SELECT id, player_id, currency, balance, version, created_at, updated_at
       FROM wallets
       WHERE id = $1`,
      [walletId],
    );

    const wallet = result.rows[0];

    if (!wallet) {
      throw new NotFoundException("Carteira não encontrada");
    }

    return {
      id: wallet.id,
      playerId: wallet.player_id,
      balance: {
        amount: String(wallet.balance),
        currency: wallet.currency,
      },
      version: wallet.version,
      createdAt: wallet.created_at,
      updatedAt: wallet.updated_at,
    };
  }

}
