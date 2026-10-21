import { describe, expect, test } from "bun:test";
import { FailureCode } from "./failure-code";
import { LedgerDirection, WalletLedgerEntry } from "./ledger-entry";
import { Money } from "./money";
import { processWager } from "./process-wager";
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S, CreateWagerTransactionProps } from "./wager-transaction";
import { Wallet } from "./wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-10-21T12:00:00Z");
let seq = 0;
const mk = (over: Partial<CreateWagerTransactionProps> = {}) => {
  seq++;
  return WagerTransaction.create({
    id: `tx${seq}`, providerId: "prov", externalTransactionId: `ext${seq}`,
    idempotencyKey: `prov:ext${seq}`, payloadHash: "h", walletId: "w1", playerId: "p1",
    roundId: "r1", gameId: "g1", kind: K.Bet, money: brl("10.00"), createdAt: now, ...over,
  });
};
const reversal = (kind: K.Refund | K.Rollback, ref: WagerTransaction, over: Partial<CreateWagerTransactionProps> = {}) =>
  mk({ kind, referenceExternalTransactionId: ref.externalTransactionId, money: ref.money, ...over });

const setup = (initial = "100.00") => {
  const { wallet, openingEntry } = Wallet.open({
    id: "w1", playerId: "p1", initialBalance: brl(initial), now,
    openingEntryId: "e0", openingTransactionId: "t0",
  });
  const entries: WalletLedgerEntry[] = [openingEntry!];
  const run = (t: WagerTransaction, reference?: WagerTransaction, reversed = false) => {
    const r = processWager({ transaction: t, wallet, reference, referenceAlreadyReversed: reversed, entryId: `e-${t.id}`, now });
    if (r.entry) entries.push(r.entry);
    return r;
  };
  const ledgerBalance = () =>
    entries.reduce((acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)), Money.zero("BRL"));
  return { wallet, entries, run, ledgerBalance };
};

describe("BET / WIN / LOSS", () => {
  test("BET debita e gera 1 lançamento DEBIT", () => {
    const { wallet, run } = setup();
    const t = mk({ money: brl("30.00") });
    const r = run(t);
    expect(t.status).toBe(S.Processed);
    expect(wallet.balance.toString()).toBe("70.00");
    expect(r.entry?.direction).toBe(LedgerDirection.Debit);
  });

  test("cenário obrigatório: saldo 100, duas apostas de 80 -> uma PROCESSED, outra REJECTED", () => {
    const { wallet, entries, run, ledgerBalance } = setup("100.00");
    const a = mk({ money: brl("80.00") });
    const b = mk({ money: brl("80.00") });
    run(a);
    run(b);
    expect([a.status, b.status]).toEqual([S.Processed, S.Rejected]);
    expect(b.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.toString()).toBe("20.00");
    expect(entries.filter((e) => e.direction === LedgerDirection.Debit)).toHaveLength(1);
    expect(ledgerBalance().equals(wallet.balance)).toBe(true);
  });

  test("WIN credita; WIN com referência a BET válida é aceita", () => {
    const { wallet, run } = setup();
    const bet = mk();
    run(bet);
    const win = mk({ kind: K.Win, money: brl("25.00"), referenceExternalTransactionId: bet.externalTransactionId });
    run(win, bet);
    expect(win.status).toBe(S.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toString()).toBe("115.00");
  });

  test("WIN com referência ausente fica PENDING_REFERENCE", () => {
    const { run } = setup();
    const win = mk({ kind: K.Win, referenceExternalTransactionId: "nao-chegou" });
    run(win);
    expect(win.status).toBe(S.PendingReference);
  });

  test("LOSS é processada sem lançamento e sem mudar saldo/version", () => {
    const { wallet, entries, run } = setup();
    const t = mk({ kind: K.Loss, money: brl("0.00") });
    const r = run(t);
    expect(t.status).toBe(S.Processed);
    expect(r.entry).toBeUndefined();
    expect(entries).toHaveLength(1);
    expect(wallet.version).toBe(1);
  });
});

describe("REFUND / ROLLBACK", () => {
  test("REFUND de BET devolve o valor", () => {
    const { wallet, run } = setup();
    const bet = mk({ money: brl("30.00") });
    run(bet);
    const refund = reversal(K.Refund, bet);
    const r = run(refund, bet);
    expect(refund.status).toBe(S.Processed);
    expect(r.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("REFUND de WIN é rejeitado (INVALID_REFERENCE_KIND)", () => {
    const { wallet, run } = setup();
    const win = mk({ kind: K.Win, money: brl("20.00") });
    run(win);
    const refund = reversal(K.Refund, win);
    run(refund, win);
    expect(refund.failureCode).toBe(FailureCode.InvalidReferenceKind);
    expect(wallet.balance.toString()).toBe("120.00");
  });

  test("ROLLBACK de BET credita; de WIN debita; de REFUND debita", () => {
    const { wallet, run } = setup("100.00");
    const bet = mk({ money: brl("30.00") });
    run(bet); // 70
    run(reversal(K.Rollback, bet), bet); // 100
    expect(wallet.balance.toString()).toBe("100.00");

    const win = mk({ kind: K.Win, money: brl("20.00") });
    run(win); // 120
    run(reversal(K.Rollback, win), win); // 100
    expect(wallet.balance.toString()).toBe("100.00");

    const bet2 = mk({ money: brl("10.00") });
    run(bet2); // 90
    const refund = reversal(K.Refund, bet2);
    run(refund, bet2); // 100
    run(reversal(K.Rollback, refund), refund); // 90
    expect(wallet.balance.toString()).toBe("90.00");
  });

  test("ROLLBACK que deixaria saldo negativo: REVERSAL_INSUFFICIENT_FUNDS, sem lançamento", () => {
    const { wallet, entries, run } = setup("100.00");
    const win = mk({ kind: K.Win, money: brl("50.00") });
    run(win); // 150
    run(mk({ money: brl("140.00") })); // 10
    const rb = reversal(K.Rollback, win);
    const before = entries.length;
    run(rb, win);
    expect(rb.status).toBe(S.Rejected);
    expect(rb.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(entries).toHaveLength(before);
    expect(wallet.balance.toString()).toBe("10.00");
  });

  test("referência ausente -> PENDING_REFERENCE; ao chegar a referência, é reprocessada", () => {
    const { wallet, run } = setup();
    const bet = mk({ money: brl("30.00") });
    const refund = reversal(K.Refund, bet);
    run(refund); // referência ainda não chegou
    expect(refund.status).toBe(S.PendingReference);
    expect(wallet.version).toBe(1);

    run(bet);
    run(refund, bet); // reprocessamento
    expect(refund.status).toBe(S.Processed);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("referência ainda não concluída mantém PENDING_REFERENCE", () => {
    const { run } = setup();
    const pendingRefund = reversal(K.Refund, mk());
    run(pendingRefund); // fica pendente
    const rb = reversal(K.Rollback, pendingRefund);
    run(rb, pendingRefund);
    expect(rb.status).toBe(S.PendingReference);
  });

  test("referência já revertida -> ALREADY_REVERSED", () => {
    const { wallet, run } = setup();
    const bet = mk({ money: brl("30.00") });
    run(bet);
    const refund = reversal(K.Refund, bet);
    run(refund, bet, true);
    expect(refund.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(wallet.balance.toString()).toBe("70.00");
  });

  test("valor diferente da referência -> AMOUNT_MISMATCH", () => {
    const { run } = setup();
    const bet = mk({ money: brl("30.00") });
    run(bet);
    const refund = reversal(K.Refund, bet, { money: brl("10.00") });
    run(refund, bet);
    expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
  });

  test("referência de outra rodada -> REFERENCE_MISMATCH", () => {
    const { run } = setup();
    const bet = mk({ money: brl("30.00"), roundId: "r-outra" });
    run(bet);
    const refund = reversal(K.Refund, bet, { roundId: "r1" });
    run(refund, bet);
    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test("referência REJECTED -> REFERENCE_NOT_PROCESSED", () => {
    const { run } = setup("100.00");
    const bet = mk({ money: brl("500.00") });
    run(bet); // rejeitada por saldo
    const refund = reversal(K.Refund, bet);
    run(refund, bet);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe("validações de contexto", () => {
  test("moeda da operação diferente da wallet -> CURRENCY_MISMATCH", () => {
    const { wallet, run } = setup();
    const t = mk({ money: Money.from({ amount: "5.00", currency: "USD" }) });
    run(t);
    expect(t.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(wallet.version).toBe(1);
  });

  test("playerId diferente do dono da wallet -> WALLET_PLAYER_MISMATCH", () => {
    const { wallet, run } = setup();
    const t = mk({ playerId: "outro" });
    run(t);
    expect(t.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    expect(wallet.version).toBe(1);
  });
});

describe("invariante final", () => {
  test("wallet.balance == saldo reconstruído pelo ledger após uma sequência mista", () => {
    const { wallet, run, ledgerBalance } = setup("200.00");
    const bet = mk({ money: brl("50.00") });
    run(bet);
    run(mk({ kind: K.Win, money: brl("120.00") }));
    run(mk({ kind: K.Loss, money: brl("0.00") }));
    run(mk({ money: brl("999.00") })); // rejeitada
    run(reversal(K.Refund, bet), bet);
    expect(ledgerBalance().equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toString()).toBe("320.00");
  });
});
