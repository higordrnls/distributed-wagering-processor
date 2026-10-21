import {
  CurrencyMismatchError, InsufficientFundsError, InvalidLedgerEntryError, InvalidWalletError,
} from "./errors";
import { LedgerDirection, WalletLedgerEntry } from "./ledger-entry";
import { Money } from "./money";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementContext {
  entryId: string;
  transactionId: string;
  now: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Abre a wallet com version 1. Se houver saldo inicial, devolve também o lançamento OPENING. */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now: Date;
    openingEntryId: string;
    openingTransactionId: string;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { initialBalance: initial, now } = props;
    if (initial.isNegative()) throw new InvalidWalletError("Saldo inicial não pode ser negativo");

    const wallet = new Wallet(props.id, props.playerId, initial.currency, initial, 1, now, now);
    if (initial.isZero()) return { wallet };

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initial,
      balanceBefore: Money.zero(initial.currency),
      balanceAfter: initial,
      createdAt: now,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(amount: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovable(amount);
    if (this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError(this._balance.toString(), amount.toString());
    }
    return this.apply(LedgerDirection.Debit, amount, this._balance.subtract(amount), ctx);
  }

  credit(amount: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovable(amount);
    return this.apply(LedgerDirection.Credit, amount, this._balance.add(amount), ctx);
  }

  /** Cria o lançamento ANTES de mudar o estado: se ele for inválido, a wallet não muda. */
  private apply(
    direction: LedgerDirection,
    amount: Money,
    newBalance: Money,
    ctx: MovementContext,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money: amount,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: ctx.now,
    });
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = ctx.now;
    return entry;
  }

  private assertMovable(amount: Money): void {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) throw new InvalidLedgerEntryError("O valor da movimentação deve ser positivo");
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
