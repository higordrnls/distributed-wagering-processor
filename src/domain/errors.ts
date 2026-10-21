export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super("INVALID_MONEY", message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(a: string, b: string) {
    super("CURRENCY_MISMATCH", `Moedas diferentes: ${a} e ${b}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(balance: string, requested: string) {
    super("INSUFFICIENT_FUNDS", `Saldo ${balance} insuficiente para ${requested}`);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super("INVALID_LEDGER_ENTRY", message);
  }
}

export class InvalidWalletError extends DomainError {
  constructor(message: string) {
    super("INVALID_WALLET", message);
  }
}

export class InvalidTransactionError extends DomainError {
  constructor(message: string) {
    super("INVALID_TRANSACTION", message);
  }
}

/** Erro de programação: tentativa de transição a partir de um estado terminal. */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super("INVALID_TRANSACTION_STATE", message);
  }
}
