import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { createTestOrm } from "../infra/test-db";
import { WalletService } from "./wallet.service";
import { WagerTransactionService } from "./wager-transaction.service";
import { MetricsService } from "./metrics.service";
import { OrmProvider } from "./orm.provider";
import type { MikroORM } from "@mikro-orm/postgresql";

let pool: Pool;
let ormProvider: OrmProvider;
let orm: MikroORM;
let wallets: WalletService;
let transactions: WagerTransactionService;

beforeAll(async () => {
  orm = await createTestOrm();

  ormProvider = {
    getOrm: async () => orm,
  } as unknown as OrmProvider;

  pool = new Pool({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "wager",
    password: process.env.DB_PASSWORD ?? "wager",
    database: "wager_test",
  });

  wallets = new WalletService(pool, undefined, ormProvider);
  transactions = new WagerTransactionService(pool);
});

afterAll(async () => {
  await pool?.end();
  await orm?.close(true);
});

describe("API — consultas e reconciliação", () => {
  test("contrato HTTP de wallet e ledger usa objetos monetários", async () => {
    const created = await wallets.create({
      playerId: randomUUID(),
      initialBalance: { amount: "125.50", currency: "BRL" },
    });

    expect(created.id).toBeDefined();
    expect(created.balance).toEqual({
      amount: "125.50",
      currency: "BRL",
    });
    expect(created.version).toBe(1);

    const fetched = await wallets.findById(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.playerId).toBe(created.playerId);
    expect(fetched.balance).toEqual({
      amount: "125.50",
      currency: "BRL",
    });

    const ledger = await wallets.findLedger(created.id, {});

    expect(ledger.walletId).toBe(created.id);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0].direction).toBe("CREDIT");
    expect(ledger.entries[0].amount).toEqual({
      amount: "125.50",
      currency: "BRL",
    });
    expect(ledger.entries[0].balanceBefore).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
    expect(ledger.entries[0].balanceAfter).toEqual({
      amount: "125.50",
      currency: "BRL",
    });
  });

  test("consulta uma transação por ID e por provider + ID externo", async () => {
    const providerId = `provider-${randomUUID()}`;
    const externalId = randomUUID();

    const wallet = await wallets.create({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    expect(wallet.id).toBeDefined();
    expect(wallet.balance).toEqual({ amount: "100.00", currency: "BRL" });

    const submitted = await transactions.submit(
      {
        providerId,
        externalTransactionId: externalId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: randomUUID(),
        gameId: "integration-game",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      },
      randomUUID(),
    );

    expect(submitted.httpStatus).toBe(200);

    const transactionId = submitted.body.transactionId;

    const byId = await transactions.findById(transactionId);
    const byExternal = await transactions.findByExternalId(
      providerId,
      externalId,
    );

    expect(byId.transactionId).toBe(transactionId);
    expect(byExternal.transactionId).toBe(transactionId);
    expect(byId.status).toBe("PROCESSED");
    expect(byExternal.money.amount).toBe("10.00");
  });

  test("transação inexistente retorna NotFoundException", async () => {
    await expect(
      transactions.findById(randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      transactions.findByExternalId("provider-inexistente", randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test("aposta com carteira inexistente retorna 404 sem persistir dados financeiros", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const externalId = randomUUID();
    const providerId = `missing-wallet-${randomUUID()}`;

    const request = {
      providerId,
      externalTransactionId: externalId,
      playerId,
      walletId,
      roundId: randomUUID(),
      gameId: "missing-wallet-test",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    };

    await expect(
      transactions.submit(request, randomUUID()),
    ).rejects.toMatchObject({
      status: 404,
    });

    const persisted = await pool.query(
      `SELECT id FROM wager_transactions
       WHERE provider_id = $1 AND external_transaction_id = $2`,
      [providerId, externalId],
    );
    const ledger = await pool.query(
      "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
      [walletId],
    );
    const outbox = await pool.query(
      `SELECT id FROM outbox_messages
       WHERE aggregate_id IN (
         SELECT id::text FROM wager_transactions
         WHERE provider_id = $1 AND external_transaction_id = $2
       )`,
      [providerId, externalId],
    );

    expect(persisted.rows).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
    expect(outbox.rows).toHaveLength(0);
  });

  test("reconciliação confirma saldo consistente", async () => {
    const wallet = await wallets.create({
      playerId: randomUUID(),
      initialBalance: { amount: "75.00", currency: "BRL" },
    });

    const result = await wallets.reconcile(wallet.id);

    expect(result.storedBalance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(result.calculatedBalance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(result.checkedEntries).toBe(1);
    expect(result.difference).toEqual({ amount: "0.00", currency: "BRL" });
    expect(result.consistent).toBe(true);
  });

  test("reconciliação detecta divergência, incrementa métrica e não altera o saldo", async () => {
    const metrics = new MetricsService();
    const instrumentedWallets = new WalletService(pool, metrics, ormProvider);

    const wallet = await instrumentedWallets.create({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    await pool.query(
      "UPDATE wallets SET balance = 95.00 WHERE id = $1",
      [wallet.id],
    );

    const before = await metrics.render();
    expect(before).toContain("wager_reconciliation_mismatches_total 0");

    const result = await instrumentedWallets.reconcile(wallet.id);

    expect(result.storedBalance).toEqual({ amount: "95.00", currency: "BRL" });
    expect(result.calculatedBalance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(result.difference).toEqual({ amount: "-5.00", currency: "BRL" });
    expect(result.consistent).toBe(false);

    const after = await metrics.render();
    expect(after).toContain("wager_reconciliation_mismatches_total 1");

    const persisted = await instrumentedWallets.findById(wallet.id);
    expect(persisted.balance).toEqual({ amount: "95.00", currency: "BRL" });
  });

  test("reconciliação de carteira inexistente retorna NotFoundException", async () => {
    await expect(
      wallets.reconcile(randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test("dados inválidos na criação de carteira retornam erro 400", async () => {
    await expect(
      wallets.create({
        playerId: " ",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("valor inicial inválido retorna erro 400", async () => {
    await expect(
      wallets.create({
        playerId: randomUUID(),
        initialBalance: { amount: "invalido", currency: "BRL" },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("duplicidade de jogador e moeda retorna conflito 409", async () => {
    const playerId = randomUUID();

    const first = await wallets.create({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    await expect(
      wallets.create({
        playerId,
        initialBalance: { amount: "50.00", currency: "BRL" },
      }),
    ).rejects.toMatchObject({ status: 409 });

    const persisted = await wallets.findById(first.id);
    expect(persisted.balance).toEqual({ amount: "100.00", currency: "BRL" });
  });
});
