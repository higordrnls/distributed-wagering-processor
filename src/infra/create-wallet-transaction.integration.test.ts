import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { Pool } from "pg";
import { Money } from "../domain/money";
import { Wallet } from "../domain/wallet";
import { ormOptions } from "./orm-config";
import { createTestOrm } from "./test-db";
import { createWalletTransaction } from "./create-wallet-transaction";
import { WalletService } from "../api/wallet.service";
import { OrmProvider } from "../api/orm.provider";

let orm: MikroORM;
let pool: Pool;

beforeAll(async () => {
  const setup = await createTestOrm();
  await setup.close(true);

  orm = await MikroORM.init(ormOptions("wager_test"));

  pool = new Pool({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "wager",
    password: process.env.DB_PASSWORD ?? "wager",
    database: "wager_test",
  });
});

afterAll(async () => {
  await orm?.close(true);
  await pool?.end();
});

describe("WalletService — integração com MikroORM", () => {
  test("cria carteira com saldo inicial pelo caminho transacional do ORM", async () => {
    const ormProvider = {
      getOrm: async () => orm,
    } as OrmProvider;

    const service = new WalletService(pool, undefined, ormProvider);

    const result = await service.create({
      playerId: randomUUID(),
      initialBalance: { amount: "125.50", currency: "BRL" },
    });

    const wallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [result.walletId],
    );

    const transaction = await pool.query(
      `SELECT id, status FROM wager_transactions
       WHERE wallet_id = $1 AND kind = 'OPENING'`,
      [result.walletId],
    );

    const ledger = await pool.query(
      `SELECT balance_before, balance_after
       FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [result.walletId],
    );

    expect(wallet.rows[0]?.balance).toBe("125.50");
    expect(transaction.rows).toHaveLength(1);
    expect(transaction.rows[0]?.status).toBe("PROCESSED");
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]?.balance_before).toBe("0.00");
    expect(ledger.rows[0]?.balance_after).toBe("125.50");
  });
});

describe("Criação de carteira — MikroORM", () => {
  test("persiste carteira, transação de abertura e ledger", async () => {
    const walletId = randomUUID();
    const openingTransactionId = randomUUID();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: randomUUID(),
      initialBalance: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
      now: new Date(),
      openingEntryId: randomUUID(),
      openingTransactionId,
    });

    await createWalletTransaction(
      orm,
      wallet,
      openingEntry,
      openingTransactionId,
    );

    const persistedWallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );
    const persistedTransaction = await pool.query(
      "SELECT status FROM wager_transactions WHERE id = $1",
      [openingTransactionId],
    );
    const persistedLedger = await pool.query(
      "SELECT balance_after FROM wallet_ledger_entries WHERE transaction_id = $1",
      [openingTransactionId],
    );

    expect(persistedWallet.rows[0]?.balance).toBe("100.00");
    expect(persistedTransaction.rows[0]?.status).toBe("PROCESSED");
    expect(persistedLedger.rows[0]?.balance_after).toBe("100.00");
  });

  test("reverte toda a operação quando a transação de abertura viola unicidade", async () => {
    const openingTransactionId = randomUUID();
    const firstWalletId = randomUUID();

    const first = Wallet.open({
      id: firstWalletId,
      playerId: randomUUID(),
      initialBalance: Money.from({
        amount: "50.00",
        currency: "BRL",
      }),
      now: new Date(),
      openingEntryId: randomUUID(),
      openingTransactionId,
    });

    await createWalletTransaction(
      orm,
      first.wallet,
      first.openingEntry,
      openingTransactionId,
    );

    const secondWalletId = randomUUID();
    const second = Wallet.open({
      id: secondWalletId,
      playerId: randomUUID(),
      initialBalance: Money.from({
        amount: "75.00",
        currency: "BRL",
      }),
      now: new Date(),
      openingEntryId: randomUUID(),
      openingTransactionId,
    });

    await expect(
      createWalletTransaction(
        orm,
        second.wallet,
        second.openingEntry,
        openingTransactionId,
      ),
    ).rejects.toThrow();

    const walletResult = await pool.query(
      "SELECT id FROM wallets WHERE id = $1",
      [secondWalletId],
    );

    const ledgerResult = await pool.query(
      "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
      [secondWalletId],
    );

    expect(walletResult.rows).toHaveLength(0);
    expect(ledgerResult.rows).toHaveLength(0);
  });
});
