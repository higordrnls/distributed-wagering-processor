import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestOrm } from "./test-db";

type Row = Record<string, unknown>;
let orm: Awaited<ReturnType<typeof createTestOrm>>;

const run = (q: string) => orm.em.getConnection().execute(q);
const ts = () => new Date().toISOString();
const lit = (v: unknown) =>
  v === null || v === undefined ? "null" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const insert = async (table: string, row: Row) => {
  const cols = Object.keys(row);
  await run(`insert into ${table} (${cols.join(", ")}) values (${cols.map((c) => lit(row[c])).join(", ")})`);
};

const wallet = (o: Row = {}): Row => ({
  id: randomUUID(), player_id: randomUUID(), currency: "BRL", balance: 100, version: 1,
  created_at: ts(), updated_at: ts(), ...o,
});
const tx = (walletId: string, o: Row = {}): Row => {
  const n = randomUUID();
  return {
    id: randomUUID(), provider_id: "prov", external_transaction_id: n, idempotency_key: `prov:${n}`,
    payload_hash: "h", wallet_id: walletId, player_id: "p1", round_id: "r1", game_id: "g1",
    kind: "BET", amount: 10, currency: "BRL", status: "PROCESSED", processed_at: ts(), created_at: ts(), ...o,
  };
};
const entry = (walletId: string, txId: string, o: Row = {}): Row => ({
  id: randomUUID(), wallet_id: walletId, transaction_id: txId, direction: "DEBIT", amount: 10,
  currency: "BRL", balance_before: 100, balance_after: 90, created_at: ts(), ...o,
});
const newWallet = async (o: Row = {}) => {
  const w = wallet(o);
  await insert("wallets", w);
  return w.id as string;
};

beforeAll(async () => {
  orm = await createTestOrm();
});
afterAll(async () => {
  await orm.close();
});

describe("migrations", () => {
  test("são reversíveis: down remove tudo e up recria", async () => {
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    const gone = await run("select to_regclass('wallets') as w, to_regclass('outbox_messages') as o");
    expect(gone[0].w).toBeNull();
    expect(gone[0].o).toBeNull();
    await migrator.up();
    const back = await run("select to_regclass('wallets') as w");
    expect(back[0].w).toBe("wallets");
  });
});

describe("wallets", () => {
  test("uma wallet por player + moeda", async () => {
    const player = randomUUID();
    await insert("wallets", wallet({ player_id: player }));
    await insert("wallets", wallet({ player_id: player, currency: "USD" })); // outra moeda pode
    await expect(insert("wallets", wallet({ player_id: player }))).rejects.toThrow(/wallets_player_currency_unique/);
  });
  test("saldo negativo é rejeitado", async () => {
    await expect(insert("wallets", wallet({ balance: -0.01 }))).rejects.toThrow(/wallets_balance_non_negative/);
  });
  test("version deve ser >= 1", async () => {
    await expect(insert("wallets", wallet({ version: 0 }))).rejects.toThrow(/wallets_version_positive/);
  });
});

describe("wager_transactions", () => {
  test("mesmo (provider, externalTransactionId) é rejeitado", async () => {
    const w = await newWallet();
    const a = tx(w);
    await insert("wager_transactions", a);
    await expect(
      insert("wager_transactions", tx(w, { external_transaction_id: a.external_transaction_id })),
    ).rejects.toThrow(/wager_tx_provider_external_unique/);
  });
  test("mesma (provider, idempotencyKey) é rejeitada", async () => {
    const w = await newWallet();
    const a = tx(w);
    await insert("wager_transactions", a);
    await expect(
      insert("wager_transactions", tx(w, { idempotency_key: a.idempotency_key })),
    ).rejects.toThrow(/wager_tx_provider_idempotency_unique/);
  });
  test("REFUND sem referência é rejeitado", async () => {
    const w = await newWallet();
    await expect(insert("wager_transactions", tx(w, { kind: "REFUND" }))).rejects.toThrow(/wager_tx_reference_required/);
  });
  test("REJECTED exige failure_code; PROCESSED exige processed_at", async () => {
    const w = await newWallet();
    await expect(
      insert("wager_transactions", tx(w, { status: "REJECTED", processed_at: null })),
    ).rejects.toThrow(/wager_tx_failure_code_consistent/);
    await expect(
      insert("wager_transactions", tx(w, { status: "PROCESSED", processed_at: null })),
    ).rejects.toThrow(/wager_tx_processed_at_consistent/);
  });
  test("valor zero só é aceito em LOSS", async () => {
    const w = await newWallet();
    await expect(insert("wager_transactions", tx(w, { amount: 0 }))).rejects.toThrow(/wager_tx_amount_valid/);
    await insert("wager_transactions", tx(w, { kind: "LOSS", amount: 0 }));
  });
  test("a mesma referência só pode ser revertida uma vez (qualquer tipo)", async () => {
    const w = await newWallet();
    const bet = tx(w);
    await insert("wager_transactions", bet);
    const reversal = (kind: string, o: Row = {}) =>
      tx(w, { kind, reference_external_transaction_id: bet.external_transaction_id, reference_transaction_id: bet.id, ...o });
    await insert("wager_transactions", reversal("REFUND"));
    await expect(insert("wager_transactions", reversal("ROLLBACK"))).rejects.toThrow(/wager_tx_one_reversal_per_reference/);
    // uma tentativa REJECTED com a mesma referência não conta como reversão
    await insert("wager_transactions", reversal("REFUND", { status: "REJECTED", failure_code: "ALREADY_REVERSED", processed_at: null }));
  });
  test("estado terminal não muda e nada é apagado; PENDING pode avançar", async () => {
    const w = await newWallet();
    const done = tx(w);
    await insert("wager_transactions", done);
    await expect(run(`update wager_transactions set game_id = 'x' where id = '${done.id}'`)).rejects.toThrow(/terminal status/);
    await expect(run(`delete from wager_transactions where id = '${done.id}'`)).rejects.toThrow(/cannot be deleted/);

    const pending = tx(w, { status: "PENDING", processed_at: null });
    await insert("wager_transactions", pending);
    await run(`update wager_transactions set status = 'PROCESSED', processed_at = now() where id = '${pending.id}'`);
  });
});

describe("wallet_ledger_entries", () => {
  const withTx = async () => {
    const w = await newWallet();
    const t = tx(w);
    await insert("wager_transactions", t);
    return { w, t };
  };

  test("lançamento válido é aceito", async () => {
    const { w, t } = await withTx();
    await insert("wallet_ledger_entries", entry(w, t.id as string));
  });
  test("aritmética inconsistente é rejeitada", async () => {
    const { w, t } = await withTx();
    await expect(
      insert("wallet_ledger_entries", entry(w, t.id as string, { balance_after: 80 })),
    ).rejects.toThrow(/ledger_arithmetic/);
  });
  test("valor zero é rejeitado", async () => {
    const { w, t } = await withTx();
    await expect(
      insert("wallet_ledger_entries", entry(w, t.id as string, { amount: 0, balance_after: 100 })),
    ).rejects.toThrow(/ledger_amount_positive/);
  });
  test("saldo resultante negativo é rejeitado", async () => {
    const { w, t } = await withTx();
    await expect(
      insert("wallet_ledger_entries", entry(w, t.id as string, { balance_before: 5, balance_after: -5 })),
    ).rejects.toThrow(/ledger_balances_non_negative/);
  });
  test("no máximo um lançamento por (wallet, transação)", async () => {
    const { w, t } = await withTx();
    await insert("wallet_ledger_entries", entry(w, t.id as string));
    await expect(insert("wallet_ledger_entries", entry(w, t.id as string))).rejects.toThrow(/ledger_wallet_transaction_unique/);
  });
  test("UPDATE e DELETE são proibidos (imutável)", async () => {
    const { w, t } = await withTx();
    const e = entry(w, t.id as string);
    await insert("wallet_ledger_entries", e);
    await expect(run(`update wallet_ledger_entries set amount = 1 where id = '${e.id}'`)).rejects.toThrow(/immutable/);
    await expect(run(`delete from wallet_ledger_entries where id = '${e.id}'`)).rejects.toThrow(/immutable/);
  });
  test("seq cresce na ordem de inserção (base do cursor)", async () => {
    const w = await newWallet();
    const t1 = tx(w);
    const t2 = tx(w);
    await insert("wager_transactions", t1);
    await insert("wager_transactions", t2);
    await insert("wallet_ledger_entries", entry(w, t1.id as string));
    await insert("wallet_ledger_entries", entry(w, t2.id as string, { balance_before: 90, balance_after: 80 }));
    const rows = await run(`select seq from wallet_ledger_entries where wallet_id = '${w}' order by seq`);
    expect(BigInt(rows[1].seq) > BigInt(rows[0].seq)).toBe(true);
  });
});

describe("inbox_messages", () => {
  test("mesma (consumer, messageId) é rejeitada", async () => {
    const row = { consumer_name: "wager-consumer", message_id: randomUUID(), payload_hash: "h", received_at: ts() };
    await insert("inbox_messages", row);
    await expect(insert("inbox_messages", row)).rejects.toThrow(/inbox_messages_pkey/);
  });
});
