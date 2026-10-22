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


  test("não debita novamente uma mensagem SQS reentregue", async () => {
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

    const fields = {
      providerId: "orm-redelivery-test",
      externalTransactionId: externalId,
      playerId,
      walletId,
      roundId: "round-redelivery",
      gameId: "game-redelivery",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "30.00", currency: "BRL" }),
      referenceExternalTransactionId: undefined,
    };

    const createTransaction = () =>
      WagerTransaction.create({
        id: randomUUID(),
        ...fields,
        idempotencyKey: externalId,
        payloadHash: computePayloadHash(fields),
        createdAt: new Date(),
      });

    const inbox = {
      consumerName: "orm-redelivery-test",
      messageId: randomUUID(),
      payloadHash: computePayloadHash(fields),
    };

    const processor = new ProcessWagerTransaction(pool, orm);

    const first = await processor.execute(createTransaction(), inbox);
    const second = await processor.execute(createTransaction(), inbox);

    expect(first.status).toBe("PROCESSED");
    expect(second.idempotentReplay).toBe(true);
    expect(second.inboxReplay).toBe(true);

    const wallet = await orm.em.fork().findOneOrFail(
      WalletEntity,
      { id: walletId },
    );

    expect(wallet.balance).toBe("70.00");
    expect(wallet.version).toBe(2);

    const ledger = await pool.query(
      "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
      [walletId],
    );

    const transactions = await pool.query(
      "SELECT id FROM wager_transactions WHERE wallet_id = $1",
      [walletId],
    );

    const inboxRows = await pool.query(
      `SELECT processed_at FROM inbox_messages
       WHERE consumer_name = $1 AND message_id = $2`,
      [inbox.consumerName, inbox.messageId],
    );

    expect(ledger.rowCount).toBe(1);
    expect(transactions.rowCount).toBe(1);
    expect(inboxRows.rowCount).toBe(1);
    expect(inboxRows.rows[0].processed_at).not.toBeNull();
  });


  test("rejeita conflito de idempotência sem novo débito", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const idempotencyKey = randomUUID();

    await orm.em.fork().insert(WalletEntity, {
      id: walletId,
      playerId,
      currency: "BRL",
      balance: "100.00",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    function createBet(amount: string) {
      const fields = {
        providerId: "orm-idempotency-conflict",
        externalTransactionId: randomUUID(),
        playerId,
        walletId,
        roundId: "round-conflict",
        gameId: "game-conflict",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount, currency: "BRL" }),
        referenceExternalTransactionId: undefined,
      };

      return WagerTransaction.create({
        id: randomUUID(),
        ...fields,
        idempotencyKey,
        payloadHash: computePayloadHash(fields),
        createdAt: new Date(),
      });
    }

    const processor = new ProcessWagerTransaction(pool, orm);

    const first = await processor.execute(createBet("30.00"));
    const second = await processor.execute(createBet("50.00"));

    expect(first.status).toBe("PROCESSED");
    expect(second.conflict).toBe(true);

    const wallet = await orm.em.fork().findOneOrFail(
      WalletEntity,
      { id: walletId },
    );

    expect(wallet.balance).toBe("70.00");
    expect(wallet.version).toBe(2);

    const ledger = await pool.query(
      "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
      [walletId],
    );

    const transactions = await pool.query(
      "SELECT id FROM wager_transactions WHERE wallet_id = $1",
      [walletId],
    );

    expect(ledger.rowCount).toBe(1);
    expect(transactions.rowCount).toBe(1);
  });


  test("desfaz saldo e mensagens quando o ledger falha", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const externalId = randomUUID();
    const constraintName = "test_orm_ledger_rollback";

    await orm.em.fork().insert(WalletEntity, {
      id: walletId,
      playerId,
      currency: "BRL",
      balance: "100.00",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fields = {
      providerId: "orm-rollback-test",
      externalTransactionId: externalId,
      playerId,
      walletId,
      roundId: "round-rollback",
      gameId: "game-rollback",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "30.00", currency: "BRL" }),
      referenceExternalTransactionId: undefined,
    };

    const transaction = WagerTransaction.create({
      id: randomUUID(),
      ...fields,
      idempotencyKey: externalId,
      payloadHash: computePayloadHash(fields),
      createdAt: new Date(),
    });

    const inbox = {
      consumerName: "orm-rollback-test",
      messageId: randomUUID(),
      payloadHash: computePayloadHash(fields),
    };

    // A restrição atinge somente a carteira deste teste.
    await pool.query(
      `ALTER TABLE wallet_ledger_entries
       ADD CONSTRAINT test_orm_ledger_rollback
       CHECK (wallet_id <> '${walletId}')`,
    );

    try {
      const processor = new ProcessWagerTransaction(pool, orm);

      await expect(
        processor.execute(transaction, inbox),
      ).rejects.toThrow();

      const wallet = await orm.em.fork().findOneOrFail(
        WalletEntity,
        { id: walletId },
      );

      expect(wallet.balance).toBe("100.00");
      expect(wallet.version).toBe(1);

      const ledger = await pool.query(
        "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
        [walletId],
      );

      const transactions = await pool.query(
        "SELECT id FROM wager_transactions WHERE wallet_id = $1",
        [walletId],
      );

      const inboxRows = await pool.query(
        `SELECT message_id FROM inbox_messages
         WHERE consumer_name = $1 AND message_id = $2`,
        [inbox.consumerName, inbox.messageId],
      );

      const outbox = await pool.query(
        "SELECT id FROM outbox_messages WHERE aggregate_id = $1",
        [transaction.id],
      );

      expect(ledger.rowCount).toBe(0);
      expect(transactions.rowCount).toBe(0);
      expect(inboxRows.rowCount).toBe(0);
      expect(outbox.rowCount).toBe(0);
    } finally {
      await pool.query(
        "ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS test_orm_ledger_rollback",
      );
    }
  });

});
