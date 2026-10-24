import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import { Money } from "../domain/money";
import { computePayloadHash } from "../domain/payload-hash";
import {
  WagerTransaction,
  WagerTransactionKind as K,
} from "../domain/wager-transaction";
import { createTestOrm } from "./test-db";

let pool: Pool;
let service: ProcessWagerTransaction;

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

  service = new ProcessWagerTransaction(pool);
});

afterAll(async () => {
  await pool?.end();
});

async function createWallet(balance: string) {
  const id = randomUUID();
  const playerId = randomUUID();
  await pool.query(
    `INSERT INTO wallets (
       id, player_id, currency, balance, version, created_at, updated_at
     ) VALUES ($1, $2, 'BRL', $3, 1, NOW(), NOW())`,
    [id, playerId, balance],
  );
  return { id, playerId };
}

function makeBet(walletId: string, playerId: string, amount: string, externalId: string, key = externalId) {
  const money = Money.from({ amount, currency: "BRL" });
  const fields = {
    providerId: "integration-test",
    externalTransactionId: externalId,
    playerId,
    walletId,
    roundId: "round-test",
    gameId: "game-test",
    kind: K.Bet,
    money,
    referenceExternalTransactionId: undefined,
  };

  return WagerTransaction.create({
    id: randomUUID(),
    ...fields,
    idempotencyKey: key,
    payloadHash: computePayloadHash(fields),
    createdAt: new Date(),
  });
}

describe("ProcessWagerTransaction — PostgreSQL", () => {
  test("processa aposta e grava saldo e ledger atomicamente", async () => {
    const { id: walletId, playerId } = await createWallet("100.00");
    const result = await service.execute(makeBet(walletId, playerId, "10.00", randomUUID()));

    expect(result.status).toBe("PROCESSED");

    const wallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );
    const ledger = await pool.query(
      "SELECT amount, direction FROM wallet_ledger_entries WHERE wallet_id = $1",
      [walletId],
    );

    expect(String(wallet.rows[0].balance)).toBe("90.00");
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].direction).toBe("DEBIT");
    expect(String(ledger.rows[0].amount)).toBe("10.00");
  });

  test("overflow de crédito persiste REJECTED sem alterar saldo ou ledger", async () => {
    const { id: walletId, playerId } = await createWallet("999999999999999.90");

    const makeWin = (amount: string, externalId: string) => {
      const money = Money.from({ amount, currency: "BRL" });
      const fields = {
        providerId: "integration-test",
        externalTransactionId: externalId,
        playerId,
        walletId,
        roundId: "round-test",
        gameId: "game-test",
        kind: K.Win,
        money,
        referenceExternalTransactionId: undefined,
      };

      return WagerTransaction.create({
        id: randomUUID(),
        ...fields,
        idempotencyKey: externalId,
        payloadHash: computePayloadHash(fields),
        createdAt: new Date(),
      });
    };

    for (let i = 0; i < 9; i++) {
      const result = await service.execute(
        makeWin("999999999999999.99", randomUUID()),
      );
      expect(result.status).toBe("PROCESSED");
    }

    const externalId = randomUUID();
    const transaction = makeWin("0.20", externalId);
    const result = await service.execute(transaction);
    const replay = await service.execute(makeWin("0.20", externalId));

    expect(result.status).toBe("REJECTED");
    expect(result.failureCode).toBe("BALANCE_LIMIT_EXCEEDED");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe("REJECTED");
    expect(replay.failureCode).toBe("BALANCE_LIMIT_EXCEEDED");

    const wallet = await pool.query(
      "SELECT balance, version FROM wallets WHERE id = $1",
      [walletId],
    );
    const ledger = await pool.query(
      "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
      [walletId],
    );
    const persisted = await pool.query(
      "SELECT status, failure_code FROM wager_transactions WHERE id = $1",
      [result.transactionId],
    );

    expect(String(wallet.rows[0].balance)).toBe("9999999999999999.81");
    expect(Number(wallet.rows[0].version)).toBe(10);
    expect(ledger.rows).toHaveLength(9);
    expect(persisted.rows[0].status).toBe("REJECTED");
    expect(persisted.rows[0].failure_code).toBe("BALANCE_LIMIT_EXCEEDED");
  });

  test("duas apostas concorrentes de 80: apenas uma é processada", async () => {
    const { id: walletId, playerId } = await createWallet("100.00");

    const results = await Promise.all([
      service.execute(makeBet(walletId, playerId, "80.00", randomUUID())),
      service.execute(makeBet(walletId, playerId, "80.00", randomUUID())),
    ]);

    expect(results.filter((r) => r.status === "PROCESSED")).toHaveLength(1);
    expect(results.filter((r) => r.status === "REJECTED")).toHaveLength(1);

    const wallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );
    const ledger = await pool.query(
      "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
      [walletId],
    );

    expect(String(wallet.rows[0].balance)).toBe("20.00");
    expect(ledger.rows).toHaveLength(1);
  });

  test("50 apostas idênticas concorrentes geram um único débito", async () => {
    const { id: walletId, playerId } = await createWallet("100.00");
    const externalId = randomUUID();
    const key = `integration:${externalId}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        service.execute(
          makeBet(walletId, playerId, "10.00", externalId, key),
        ),
      ),
    );

    expect(results.filter((r) => r.status === "PROCESSED")).toHaveLength(50);
    expect(results.filter((r) => r.idempotentReplay === true)).toHaveLength(49);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);

    const wallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );
    const ledger = await pool.query(
      `SELECT amount, direction
       FROM wallet_ledger_entries
       WHERE wallet_id = $1`,
      [walletId],
    );
    const transactions = await pool.query(
      `SELECT id FROM wager_transactions
       WHERE provider_id = 'integration-test'
         AND external_transaction_id = $1`,
      [externalId],
    );

    expect(String(wallet.rows[0].balance)).toBe("90.00");
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].direction).toBe("DEBIT");
    expect(String(ledger.rows[0].amount)).toBe("10.00");
    expect(transactions.rows).toHaveLength(1);
  });

  test("repetir a mesma requisição não duplica o lançamento", async () => {
    const { id: walletId, playerId } = await createWallet("100.00");
    const externalId = randomUUID();
    const key = `integration:${externalId}`;

    const first = await service.execute(
      makeBet(walletId, playerId, "25.00", externalId, key),
    );
    const replay = await service.execute(
      makeBet(walletId, playerId, "25.00", externalId, key),
    );

    expect(first.status).toBe("PROCESSED");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);

    const wallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );
    const ledger = await pool.query(
      "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
      [walletId],
    );

    expect(String(wallet.rows[0].balance)).toBe("75.00");
    expect(ledger.rows).toHaveLength(1);
  });
});
