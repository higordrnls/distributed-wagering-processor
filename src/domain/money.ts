import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

export interface MoneyProps {
  amount: string; // string decimal, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

const AMOUNT_RE = /^\d{1,16}(\.\d{1,2})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Valor monetário imutável. Internamente guarda centavos como bigint (exato, sem float). */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    const maxCents = 999999999999999999n;
    if (cents > maxCents || cents < -maxCents) {
      throw new InvalidMoneyError("Valor monetário excede numeric(18,2)");
    }
  }

  /** Entrada externa: só aceita valores não negativos, com até 2 casas decimais. */
  static from(props: MoneyProps): Money {
    if (typeof props?.currency !== "string" || !CURRENCY_RE.test(props.currency)) {
      throw new InvalidMoneyError(`Moeda inválida: ${String(props?.currency)}`);
    }
    if (typeof props.amount !== "string" || !AMOUNT_RE.test(props.amount)) {
      throw new InvalidMoneyError(`Valor inválido: ${String(props.amount)}`);
    }
    const [integer, fraction = ""] = props.amount.split(".");
    const cents = BigInt(integer!) * 100n + BigInt(fraction.padEnd(2, "0"));
    return new Money(cents, props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }
  isPositive(): boolean {
    return this.cents > 0n;
  }
  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toString(): string {
    const abs = this.cents < 0n ? -this.cents : this.cents;
    const digits = abs.toString().padStart(3, "0");
    const sign = this.cents < 0n ? "-" : "";
    return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
