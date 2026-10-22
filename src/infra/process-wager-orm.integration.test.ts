import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createTestOrm } from "./test-db";
import { WalletEntity } from "./entities/wallet.entity";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import { Money } from "../domain/money";
import { computePayloadHash } from "../domain/payload-hash";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../domain/wager-transaction";

let orm: MikroORM;
let pool: Pool;

beforeAll(async () => {
  orm = await createTestOrm();

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
  await orm?.close(true);
});

describe("ProcessWagerTransaction — MikroORM", () => {
  test("processa aposta e persiste saldo e ledger atomicamente", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const externalId = randomUUID();

    await orm.em.fork().insert(WalletEntity, {
      id: walletId,
      playerId,
      currency: "BRL",
      balance: "100.00",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const money = Money.from({
      amount: "10.00",
      currency: "BRL",
    });

    const fields = {
      providerId: "orm-integration-test",
      externalTransactionId: externalId,
      playerId,
      walletId,
      roundId: "round-orm",
      gameId: "game-orm",
      kind: WagerTransactionKind.Bet,
      money,
      referenceExternalTransactionId: undefined,
    };

    const transaction = WagerTransaction.create({
      id: randomUUID(),
      ...fields,
      idempotencyKey: externalId,
      payloadHash: computePayloadHash(fields),
      createdAt: new Date(),
    });

    const processor = new ProcessWagerTransaction(pool, orm);
    const result = await processor.execute(transaction);

    expect(result.status).toBe("PROCESSED");
    expect(result.observedBalance).toBe("90.00");

    const wallet = await orm.em.fork().findOneOrFail(
      WalletEntity,
      { id: walletId },
    );

    expect(wallet.balance).toBe("90.00");
    expect(wallet.version).toBe(2);

    const ledger = await pool.query(
      "SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1",
      [transaction.id],
    );

    expect(ledger.rowCount).toBe(1);
  });

  test("serializa duas apostas concorrentes na mesma carteira", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();

    await orm.em.fork().insert(WalletEntity, {
      id: walletId,
      playerId,
      currency: "BRL",
      balance: "100.00",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    function createBet() {
      const externalId = randomUUID();
      const fields = {
        providerId: "orm-concurrency-test",
        externalTransactionId: externalId,
        playerId,
        walletId,
        roundId: "round-concurrent",
        gameId: "game-concurrent",
        kind: WagerTransactionKind.Bet,
        money: Money.from({
          amount: "80.00",
          currency: "BRL",
        }),
        referenceExternalTransactionId: undefined,
      };

      return WagerTransaction.create({
        id: randomUUID(),
        ...fields,
        idempotencyKey: externalId,
        payloadHash: computePayloadHash(fields),
        createdAt: new Date(),
      });
    }

    const first = createBet();
    const second = createBet();
    const processor = new ProcessWagerTransaction(pool, orm);

    const results = await Promise.all([
      processor.execute(first),
      processor.execute(second),
    ]);

    expect(results.filter((r) => r.status === "PROCESSED")).toHaveLength(1);
    expect(results.filter((r) => r.status !== "PROCESSED")).toHaveLength(1);

    const wallet = await orm.em.fork().findOneOrFail(
      WalletEntity,
      { id: walletId },
    );

    expect(wallet.balance).toBe("20.00");
    expect(wallet.version).toBe(2);

    const ledger = await pool.query(
      "SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1",
      [walletId],
    );

    expect(ledger.rowCount).toBe(1);
  });

});
