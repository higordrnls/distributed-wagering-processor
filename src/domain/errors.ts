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
