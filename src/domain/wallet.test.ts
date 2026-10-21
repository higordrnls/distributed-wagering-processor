import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError, InsufficientFundsError, InvalidLedgerEntryError,
} from "./errors";
import { LedgerDirection, WalletLedgerEntry } from "./ledger-entry";
import { Money } from "./money";
import { Wallet } from "./wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-10-21T12:00:00Z");
const ctx = (n: number) => ({ entryId: `e${n}`, transactionId: `t${n}`, now });

const newWallet = (initial = "100.00") =>
  Wallet.open({
    id: "w1", playerId: "p1", initialBalance: brl(initial), now,
    openingEntryId: "e0", openingTransactionId: "t0",
  });

describe("Wallet.open", () => {
  test("saldo inicial gera lançamento OPENING e version 1", () => {
    const { wallet, openingEntry } = newWallet("1000.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("1000.00");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe("0.00");
    expect(openingEntry?.balanceAfter.toString()).toBe("1000.00");
  });

  test("saldo inicial zero não gera lançamento", () => {
    expect(newWallet("0.00").openingEntry).toBeUndefined();
  });
});

describe("Wallet debit/credit", () => {
  test("debit reduz saldo, incrementa version e retorna lançamento balanceado", () => {
    const { wallet } = newWallet("100.00");
    const entry = wallet.debit(brl("80.00"), ctx(1));
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.toString()).toBe("20.00");
  });

  test("debit do saldo exato leva a zero (permitido)", () => {
    const { wallet } = newWallet("50.00");
    wallet.debit(brl("50.00"), ctx(1));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("saldo insuficiente lança erro e NÃO altera saldo nem version", () => {
    const { wallet } = newWallet("100.00");
    wallet.debit(brl("80.00"), ctx(1));
    expect(() => wallet.debit(brl("80.00"), ctx(2))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test("credit aumenta saldo e gera lançamento CREDIT", () => {
    const { wallet } = newWallet("10.00");
    const entry = wallet.credit(brl("5.50"), ctx(1));
    expect(wallet.balance.toString()).toBe("15.50");
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(wallet.version).toBe(2);
  });

  test("moeda diferente é rejeitada sem alterar o estado", () => {
    const { wallet } = newWallet("10.00");
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => wallet.debit(usd, ctx(1))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, ctx(1))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("valor zero não é movimentação válida (version não muda)", () => {
    const { wallet } = newWallet("10.00");
    expect(() => wallet.credit(brl("0.00"), ctx(1))).toThrow(InvalidLedgerEntryError);
    expect(wallet.version).toBe(1);
  });

  test("rehydrate reconstrói o estado sem revalidar", () => {
    const w = Wallet.rehydrate({
      id: "w9", playerId: "p9", currency: "BRL", balance: brl("7.00"),
      version: 42, createdAt: now, updatedAt: now,
    });
    expect(w.version).toBe(42);
    expect(w.balance.toString()).toBe("7.00");
  });
});

describe("WalletLedgerEntry.create", () => {
  const base = {
    id: "e", walletId: "w", transactionId: "t", createdAt: now,
    direction: LedgerDirection.Debit,
    money: brl("10.00"), balanceBefore: brl("100.00"), balanceAfter: brl("90.00"),
  };

  test("aceita lançamento balanceado", () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
  });

  test("rejeita aritmética inconsistente", () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl("80.00") })).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita valor zero", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, money: brl("0.00"), balanceAfter: brl("100.00") }),
    ).toThrow(InvalidLedgerEntryError);
  });
});
