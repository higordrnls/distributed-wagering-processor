import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createTestOrm } from "./test-db";

let pool: Pool;

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
});

afterAll(async () => {
  await pool?.end();
});

type WorkerResult = {
  status: string;
  transactionId: string;
  idempotentReplay?: boolean;
};

async function runWorker(
  walletId: string,
  playerId: string,
  externalId: string,
): Promise<WorkerResult> {
  const workerProcess = Bun.spawn(
    [
      "bun",
      "run",
      "src/infra/test-workers/wager-process.worker.ts",
      walletId,
      playerId,
      "80.00",
      externalId,
    ],
    {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(workerProcess.stdout).text(),
    new Response(workerProcess.stderr).text(),
    workerProcess.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `Worker falhou (${exitCode}): ${stderr}`,
    );
  }

  return JSON.parse(stdout.trim()) as WorkerResult;
}

describe("Concorrência distribuída — 3 processos Bun", () => {
  test("impede saldo negativo com apostas simultâneas", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();

    await pool.query(
      `INSERT INTO wallets (
         id, player_id, currency, balance,
         version, created_at, updated_at
       ) VALUES ($1, $2, 'BRL', '100.00', 1, NOW(), NOW())`,
      [walletId, playerId],
    );

    const results = await Promise.all([
      runWorker(walletId, playerId, randomUUID()),
      runWorker(walletId, playerId, randomUUID()),
      runWorker(walletId, playerId, randomUUID()),
    ]);

    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.status === "PROCESSED")).toHaveLength(1);
    expect(results.filter((r) => r.status === "REJECTED")).toHaveLength(2);

    const wallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );

    const ledger = await pool.query(
      `SELECT direction, amount, balance_before, balance_after
       FROM wallet_ledger_entries
       WHERE wallet_id = $1`,
      [walletId],
    );

    const transactions = await pool.query(
      `SELECT status, failure_code
       FROM wager_transactions
       WHERE wallet_id = $1`,
      [walletId],
    );

    expect(String(wallet.rows[0].balance)).toBe("20.00");
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].direction).toBe("DEBIT");
    expect(String(ledger.rows[0].amount)).toBe("80.00");
    expect(String(ledger.rows[0].balance_before)).toBe("100.00");
    expect(String(ledger.rows[0].balance_after)).toBe("20.00");

    expect(transactions.rows).toHaveLength(3);
    expect(
      transactions.rows.filter((r) => r.status === "PROCESSED"),
    ).toHaveLength(1);
    expect(
      transactions.rows.filter((r) => r.status === "REJECTED"),
    ).toHaveLength(2);
  }, 30000);

  test("mesma aposta em 3 processos gera apenas um débito", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const externalId = randomUUID();

    await pool.query(
      `INSERT INTO wallets (
         id, player_id, currency, balance,
         version, created_at, updated_at
       ) VALUES ($1, $2, 'BRL', '100.00', 1, NOW(), NOW())`,
      [walletId, playerId],
    );

    const results = await Promise.all([
      runWorker(walletId, playerId, externalId),
      runWorker(walletId, playerId, externalId),
      runWorker(walletId, playerId, externalId),
    ]);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "PROCESSED")).toBe(true);
    expect(results.filter((r) => r.idempotentReplay === true)).toHaveLength(2);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);

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

    const transactions = await pool.query(
      `SELECT id, status
       FROM wager_transactions
       WHERE wallet_id = $1`,
      [walletId],
    );

    expect(String(wallet.rows[0].balance)).toBe("20.00");
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].direction).toBe("DEBIT");
    expect(String(ledger.rows[0].amount)).toBe("80.00");
    expect(transactions.rows).toHaveLength(1);
    expect(transactions.rows[0].status).toBe("PROCESSED");
  }, 30000);

});
