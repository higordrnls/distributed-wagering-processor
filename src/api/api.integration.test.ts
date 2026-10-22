import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { createTestOrm } from "../infra/test-db";
import { WalletService } from "./wallet.service";
import { WagerTransactionService } from "./wager-transaction.service";
import { MetricsService } from "./metrics.service";

let pool: Pool;
let wallets: WalletService;
let transactions: WagerTransactionService;

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

  wallets = new WalletService(pool);
  transactions = new WagerTransactionService(pool);
});

afterAll(async () => {
  await pool?.end();
});

describe("API — consultas e reconciliação", () => {
  test("consulta uma transação por ID e por provider + ID externo", async () => {
    const providerId = `provider-${randomUUID()}`;
    const externalId = randomUUID();

    const wallet = await wallets.create({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const submitted = await transactions.submit(
      {
        providerId,
        externalTransactionId: externalId,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
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

  test("reconciliação confirma saldo consistente", async () => {
    const wallet = await wallets.create({
      playerId: randomUUID(),
      initialBalance: { amount: "75.00", currency: "BRL" },
    });

    const result = await wallets.reconcile(wallet.walletId);

    expect(result.storedBalance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(result.calculatedBalance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(result.checkedEntries).toBe(1);
    expect(result.difference).toEqual({ amount: "0.00", currency: "BRL" });
    expect(result.consistent).toBe(true);
  });

  test("reconciliação detecta divergência, incrementa métrica e não altera o saldo", async () => {
    const metrics = new MetricsService();
    const instrumentedWallets = new WalletService(pool, metrics);

    const wallet = await instrumentedWallets.create({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    await pool.query(
      "UPDATE wallets SET balance = 95.00 WHERE id = $1",
      [wallet.walletId],
    );

    const before = await metrics.render();
    expect(before).toContain("wager_reconciliation_mismatches_total 0");

    const result = await instrumentedWallets.reconcile(wallet.walletId);

    expect(result.storedBalance).toEqual({ amount: "95.00", currency: "BRL" });
    expect(result.calculatedBalance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(result.difference).toEqual({ amount: "-5.00", currency: "BRL" });
    expect(result.consistent).toBe(false);

    const after = await metrics.render();
    expect(after).toContain("wager_reconciliation_mismatches_total 1");

    const persisted = await instrumentedWallets.findById(wallet.walletId);
    expect(persisted.balance).toBe("95.00");
  });

  test("reconciliação de carteira inexistente retorna NotFoundException", async () => {
    await expect(
      wallets.reconcile(randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
