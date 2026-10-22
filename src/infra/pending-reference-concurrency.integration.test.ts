import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createTestOrm } from "./test-db";
import { PendingReferenceReconciler } from "./pending-reference-reconciler";
import { WagerTransactionService } from "../api/wager-transaction.service";

let pool: Pool;
let service: WagerTransactionService;
let reconciler: PendingReferenceReconciler;

beforeAll(async () => {
  const orm = await createTestOrm();
  await orm.close(true);

  pool = new Pool({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "wager",
    password: process.env.DB_PASSWORD ?? "wager",
    database: process.env.TEST_DB_NAME ?? "wager_test",
  });

  service = new WagerTransactionService(pool);
  reconciler = new PendingReferenceReconciler(pool);
});

afterAll(async () => {
  await pool?.end();
});

describe("Reconciliação concorrente", () => {
  test("preserva saldo e ledger ao concorrer com uma nova aposta", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const providerId = `concurrency-${randomUUID()}`;
    const roundId = randomUUID();
    const betExternalId = randomUUID();
    const refundExternalId = randomUUID();

    await pool.query(
      `INSERT INTO wallets
       (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', 100.00, 1, NOW(), NOW())`,
      [walletId, playerId],
    );

    const base = {
      providerId,
      playerId,
      walletId,
      roundId,
      gameId: "concurrency-game",
      money: { amount: "30.00", currency: "BRL" },
    };

    const refund = await service.submit(
      {
        ...base,
        externalTransactionId: refundExternalId,
        kind: "REFUND",
        referenceExternalTransactionId: betExternalId,
      },
      `refund:${refundExternalId}`,
    );

    expect(refund.body.status).toBe("PENDING_REFERENCE");

    const bet = await service.submit(
      {
        ...base,
        externalTransactionId: betExternalId,
        kind: "BET",
      },
      `bet:${betExternalId}`,
    );

    expect(bet.body.status).toBe("PROCESSED");

    await pool.query(
      `UPDATE wager_transactions
       SET next_reference_attempt_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [refund.body.transactionId],
    );

    const extraBetExternalId = randomUUID();

    const [_, extraBet] = await Promise.all([
      reconciler.reconcilePending(),
      service.submit(
        {
          ...base,
          externalTransactionId: extraBetExternalId,
          kind: "BET",
        },
        `bet:${extraBetExternalId}`,
      ),
    ]);

    expect(extraBet.body.status).toBe("PROCESSED");

    const wallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );

    const ledger = await pool.query(
      `SELECT direction, amount
       FROM wallet_ledger_entries
       WHERE wallet_id = $1`,
      [walletId],
    );

    const pending = await pool.query(
      "SELECT status FROM wager_transactions WHERE id = $1",
      [refund.body.transactionId],
    );

    expect(wallet.rows[0].balance).toBe("70.00");
    expect(ledger.rows).toHaveLength(3);
    expect(pending.rows[0].status).toBe("PROCESSED");
  }, 30000);
});

describe("Ordem dos locks financeiros", () => {
  test("detecta inversão entre wallet e transação pendente", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const transactionId = randomUUID();
    const providerId = `lock-test-${randomUUID()}`;

    await pool.query(
      `INSERT INTO wallets
       (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', 100.00, 1, NOW(), NOW())`,
      [walletId, playerId],
    );

    await pool.query(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key,
         payload_hash, wallet_id, player_id, round_id, game_id,
         kind, amount, currency, reference_external_transaction_id,
         status, created_at, next_reference_attempt_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'lock-test',
         'REFUND', 30.00, 'BRL', $9,
         'PENDING_REFERENCE', NOW(), NOW()
       )`,
      [
        transactionId,
        providerId,
        randomUUID(),
        randomUUID(),
        "test-hash",
        walletId,
        playerId,
        randomUUID(),
        randomUUID(),
      ],
    );

    const normal = await pool.connect();
    const reconcilerConnection = await pool.connect();

    try {
      await normal.query("BEGIN");
      await reconcilerConnection.query("BEGIN");

      // Processamento normal: primeiro wallet.
      await normal.query(
        "SELECT id FROM wallets WHERE id = $1 FOR UPDATE",
        [walletId],
      );

      // Reconciliador atual: primeiro transação pendente.
      await reconcilerConnection.query(
        "SELECT id FROM wager_transactions WHERE id = $1 FOR UPDATE",
        [transactionId],
      );

      // O processamento normal passa a esperar a transação.
      const normalWaiting = normal.query(
        "SELECT id FROM wager_transactions WHERE id = $1 FOR UPDATE",
        [transactionId],
      );

      // O reconciliador passa a esperar a wallet.
      const reconcilerWaiting = reconcilerConnection.query(
        "SELECT id FROM wallets WHERE id = $1 FOR UPDATE",
        [walletId],
      );

      const results = await Promise.allSettled([
        normalWaiting,
        reconcilerWaiting,
      ]);

      const errors = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(
        errors.some(
          (result) =>
            (result.reason as { code?: string }).code === "40P01",
        ),
      ).toBe(true);
    } finally {
      await Promise.allSettled([
        normal.query("ROLLBACK"),
        reconcilerConnection.query("ROLLBACK"),
      ]);

      normal.release();
      reconcilerConnection.release();
    }
  }, 15000);
});

describe("Contenção real do reconciliador", () => {
  test("não espera por wallet bloqueada e processa após liberação", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const providerId = `contention-${randomUUID()}`;
    const roundId = randomUUID();
    const betExternalId = randomUUID();
    const refundExternalId = randomUUID();

    await pool.query(
      `INSERT INTO wallets
       (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', 100.00, 1, NOW(), NOW())`,
      [walletId, playerId],
    );

    const base = {
      providerId,
      playerId,
      walletId,
      roundId,
      gameId: "contention-game",
      money: { amount: "30.00", currency: "BRL" },
    };

    const refund = await service.submit(
      {
        ...base,
        externalTransactionId: refundExternalId,
        kind: "REFUND",
        referenceExternalTransactionId: betExternalId,
      },
      `refund:${refundExternalId}`,
    );

    const bet = await service.submit(
      {
        ...base,
        externalTransactionId: betExternalId,
        kind: "BET",
      },
      `bet:${betExternalId}`,
    );

    expect(refund.body.status).toBe("PENDING_REFERENCE");
    expect(bet.body.status).toBe("PROCESSED");

    await pool.query(
      `UPDATE wager_transactions
       SET next_reference_attempt_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [refund.body.transactionId],
    );

    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");

      await blocker.query(
        "SELECT id FROM wallets WHERE id = $1 FOR UPDATE",
        [walletId],
      );

      const started = performance.now();

      await reconciler.reconcilePending();

      const elapsed = performance.now() - started;

      expect(elapsed).toBeLessThan(3000);

      const pending = await pool.query(
        "SELECT status FROM wager_transactions WHERE id = $1",
        [refund.body.transactionId],
      );

      expect(pending.rows[0].status).toBe("PENDING_REFERENCE");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    await reconciler.reconcilePending();

    const finalTransaction = await pool.query(
      "SELECT status FROM wager_transactions WHERE id = $1",
      [refund.body.transactionId],
    );

    const wallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );

    const ledger = await pool.query(
      "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
      [walletId],
    );

    expect(finalTransaction.rows[0].status).toBe("PROCESSED");
    expect(wallet.rows[0].balance).toBe("100.00");
    expect(ledger.rows).toHaveLength(2);
  }, 15000);
});
