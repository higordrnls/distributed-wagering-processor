import { InvalidLedgerEntryError } from "./errors";
import { Money } from "./money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/** Lançamento imutável: todos os campos são readonly e não há métodos de transição. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /** Valida a aritmética do lançamento. */
  static create(s: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.build(s);
    if (!entry.money.isPositive()) {
      throw new InvalidLedgerEntryError("O valor do lançamento deve ser positivo");
    }
    if (entry.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("O saldo após o lançamento não pode ser negativo");
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError("balanceBefore ± money deve ser igual a balanceAfter");
    }
    return entry;
  }

  /** Reconstrução a partir do banco: não revalida. */
  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(s);
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  private static build(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      s.id, s.walletId, s.transactionId, s.direction,
      s.money, s.balanceBefore, s.balanceAfter, s.createdAt,
    );
  }
}
