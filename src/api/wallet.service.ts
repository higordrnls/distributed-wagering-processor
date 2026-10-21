import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
import { Wallet } from "../domain/wallet";
import { Money } from "../domain/money";
import { WagerTransactionKind } from "../domain/wager-transaction";
import { DATABASE_POOL } from "./database.provider";

@Injectable()
export class WalletService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
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
      throw new ConflictException("Dados da carteira inválidos");
    }

    const initialBalance = Money.from({
      amount: input.initialBalance.amount,
      currency: input.initialBalance.currency,
    });

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

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO wallets (
          id, player_id, currency, balance, version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          wallet.balance.toString(),
          wallet.version,
          wallet.createdAt,
          wallet.updatedAt,
        ],
      );

      if (openingEntry) {
        const payloadHash = createHash("sha256")
          .update(JSON.stringify({
            walletId,
            playerId: wallet.playerId,
            balance: initialBalance.toJSON(),
          }))
          .digest("hex");

        await client.query(
          `INSERT INTO wager_transactions (
            id, provider_id, external_transaction_id, idempotency_key,
            payload_hash, wallet_id, player_id, round_id, game_id,
            kind, amount, currency, status, created_at, processed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PROCESSED', $13, $13)`,
          [
            openingTransactionId,
            "internal",
            `opening:${walletId}`,
            `opening:${walletId}`,
            payloadHash,
            wallet.id,
            wallet.playerId,
            "opening",
            "internal",
            WagerTransactionKind.Opening,
            initialBalance.toString(),
            initialBalance.currency,
            now,
          ],
        );

        await client.query(
          `INSERT INTO wallet_ledger_entries (
            id, wallet_id, transaction_id, direction, amount,
            currency, balance_before, balance_after, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            openingEntry.id,
            openingEntry.walletId,
            openingEntry.transactionId,
            openingEntry.direction,
            openingEntry.money.toString(),
            openingEntry.money.currency,
            openingEntry.balanceBefore.toString(),
            openingEntry.balanceAfter.toString(),
            openingEntry.createdAt,
          ],
        );
      }

      await client.query("COMMIT");

      return {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toString(),
        version: wallet.version,
      };
    } catch (error) {
      await client.query("ROLLBACK");

      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new ConflictException(
          "Já existe uma carteira para este jogador e moeda",
        );
      }

      throw error;
    } finally {
      client.release();
    }
  }
}
