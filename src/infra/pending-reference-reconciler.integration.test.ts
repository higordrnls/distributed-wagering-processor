import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { WagerTransactionService } from "../api/wager-transaction.service";
import { PendingReferenceReconciler } from "./pending-reference-reconciler";
import { createTestOrm } from "./test-db";

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
    database: "wager_test",
  });

  service = new WagerTransactionService(pool);
  reconciler = new PendingReferenceReconciler(pool);
});

afterAll(async () => {
  await pool?.end();
});

describe("PendingReferenceReconciler — PostgreSQL", () => {
  test("reconcilia REFUND após chegada tardia da BET, sem duplicar ledger", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const providerId = `pending-test-${randomUUID()}`;
    const betExternalId = randomUUID();
    const refundExternalId = randomUUID();
    const roundId = randomUUID();

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
      gameId: "pending-reference-game",
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

    expect(refund.httpStatus).toBe(202);
    expect(refund.body.status).toBe("PENDING_REFERENCE");

    const pendingBalance = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );
    expect(String(pendingBalance.rows[0].balance)).toBe("100.00");

    const bet = await service.submit(
      {
        ...base,
        externalTransactionId: betExternalId,
        kind: "BET",
      },
      `bet:${betExternalId}`,
    );

    expect(bet.body.status).toBe("PROCESSED");

    const afterBet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );
    expect(String(afterBet.rows[0].balance)).toBe("70.00");

    await pool.query(
      `UPDATE wager_transactions
       SET next_reference_attempt_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [refund.body.transactionId],
    );

    await reconciler.reconcilePending();

    const transaction = await pool.query(
      `SELECT status, reference_transaction_id, failure_code
       FROM wager_transactions WHERE id = $1`,
      [refund.body.transactionId],
    );

    expect(transaction.rows[0].status).toBe("PROCESSED");
    expect(transaction.rows[0].reference_transaction_id).toBe(
      bet.body.transactionId,
    );
    expect(transaction.rows[0].failure_code).toBeNull();

    const wallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );
    expect(String(wallet.rows[0].balance)).toBe("100.00");

    const ledger = await pool.query(
      `SELECT transaction_id, direction, amount
       FROM wallet_ledger_entries
       WHERE wallet_id = $1
       ORDER BY seq`,
      [walletId],
    );

    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0].direction).toBe("DEBIT");
    expect(ledger.rows[1].direction).toBe("CREDIT");
    expect(String(ledger.rows[0].amount)).toBe("30.00");
    expect(String(ledger.rows[1].amount)).toBe("30.00");

    const outbox = await pool.query(
      `SELECT event_type FROM outbox_messages
       WHERE aggregate_id = $1`,
      [refund.body.transactionId],
    );

    expect(outbox.rows.some(
      (row) => row.event_type === "WagerTransactionProcessed",
    )).toBe(true);
    expect(outbox.rows.some(
      (row) => row.event_type === "WalletBalanceChanged",
    )).toBe(true);

    // Executar novamente não pode movimentar a carteira.
    await reconciler.reconcilePending();

    const ledgerAfterReplay = await pool.query(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [walletId],
    );
    expect(ledgerAfterReplay.rows).toHaveLength(2);
  });

  test("rejeita referência ausente após 10 tentativas, sem movimentar saldo", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const externalId = randomUUID();

    await pool.query(
      `INSERT INTO wallets
       (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', 100.00, 1, NOW(), NOW())`,
      [walletId, playerId],
    );

    const refund = await service.submit(
      {
        providerId: `missing-reference-${randomUUID()}`,
        externalTransactionId: externalId,
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: "missing-reference-game",
        kind: "REFUND",
        money: { amount: "30.00", currency: "BRL" },
        referenceExternalTransactionId: randomUUID(),
      },
      `refund:${externalId}`,
    );

    expect(refund.body.status).toBe("PENDING_REFERENCE");

    for (let attempt = 1; attempt <= 10; attempt++) {
      // Antecipamos o vencimento para não esperar o backoff real.
      await pool.query(
        `UPDATE wager_transactions
         SET next_reference_attempt_at = NOW() - INTERVAL '1 second'
         WHERE id = $1`,
        [refund.body.transactionId],
      );

      await reconciler.reconcilePending();

      const result = await pool.query(
        `SELECT status, failure_code, reference_attempts,
                next_reference_attempt_at
         FROM wager_transactions WHERE id = $1`,
        [refund.body.transactionId],
      );

      expect(Number(result.rows[0].reference_attempts)).toBe(attempt);

      if (attempt < 10) {
        expect(result.rows[0].status).toBe("PENDING_REFERENCE");
        expect(result.rows[0].failure_code).toBeNull();
        expect(result.rows[0].next_reference_attempt_at).not.toBeNull();
      } else {
        expect(result.rows[0].status).toBe("REJECTED");
        expect(result.rows[0].failure_code).toBe("REFERENCE_NOT_FOUND");
        expect(result.rows[0].next_reference_attempt_at).toBeNull();
      }
    }

    const wallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );
    expect(String(wallet.rows[0].balance)).toBe("100.00");

    const ledger = await pool.query(
      "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
      [walletId],
    );
    expect(ledger.rows).toHaveLength(0);

    const rejectedEvents = await pool.query(
      `SELECT event_type, payload
       FROM outbox_messages
       WHERE aggregate_id = $1
         AND event_type = 'WagerTransactionRejected'`,
      [refund.body.transactionId],
    );

    expect(rejectedEvents.rows).toHaveLength(1);
    expect(rejectedEvents.rows[0].payload.failureCode).toBe(
      "REFERENCE_NOT_FOUND",
    );

    // A transação terminal não pode voltar à fila de reconciliação.
    await reconciler.reconcilePending();

    const finalState = await pool.query(
      `SELECT status, reference_attempts
       FROM wager_transactions WHERE id = $1`,
      [refund.body.transactionId],
    );

    expect(finalState.rows[0].status).toBe("REJECTED");
    expect(Number(finalState.rows[0].reference_attempts)).toBe(10);
  });

});
