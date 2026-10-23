import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";
import { Money } from "./money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from", () => {
  test("normaliza para 2 casas", () => {
    expect(brl("25").toString()).toBe("25.00");
    expect(brl("25.5").toString()).toBe("25.50");
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  test.each(["", "NaN", "Infinity", "1e3", "-5.00", "1.234", "1.", ".5", " 5", "abc"])(
    "rejeita amount inválido: %p",
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );

  test("rejeita amount que não é string", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each(["brl", "BR", "", "BRLL"])("rejeita moeda inválida: %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });
});

describe("Money limites de persistência", () => {
  test("aceita o maior valor representável em numeric(18,2)", () => {
    expect(brl("999999999999999.99").toString()).toBe("999999999999999.99");
  });

  test("permite soma dentro da capacidade de numeric(18,2)", () => {
    expect(brl("999999999999999.99").add(brl("0.01")).toString())
      .toBe("1000000000000000.00");
  });

});

describe("Money limites aritméticos", () => {
  test("rejeita resultado acima da capacidade do PostgreSQL", () => {
    const base = brl("999999999999999.99");
    const max = base.add(base).add(base).add(base)
      .add(base).add(base).add(base).add(base)
      .add(base).add(base);

    expect(max.toString()).toBe("9999999999999999.90");
    expect(() => max.add(brl("0.10"))).toThrow(InvalidMoneyError);
  });

  test("rejeita resultado negativo fora do intervalo", () => {
    const base = brl("999999999999999.99");
    const max = base.add(base).add(base).add(base)
      .add(base).add(base).add(base).add(base)
      .add(base).add(base);

    expect(() => max.negate().subtract(brl("0.10")))
      .toThrow(InvalidMoneyError);
  });
});

describe("Money operações", () => {
  test("não sofre erro de ponto flutuante (0.10 + 0.20)", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
  });

  test("add e subtract retornam novas instâncias (imutável)", () => {
    const a = brl("100.00");
    const b = a.subtract(brl("80.00"));
    expect(a.toString()).toBe("100.00");
    expect(b.toString()).toBe("20.00");
  });

  test("subtract pode resultar em valor negativo", () => {
    const r = brl("10.00").subtract(brl("30.50"));
    expect(r.isNegative()).toBe(true);
    expect(r.toString()).toBe("-20.50");
    expect(r.negate().toString()).toBe("20.50");
  });

  test("zero, positivo, comparações", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.00").equals(brl("1.0"))).toBe(true);
  });

  test("moedas diferentes: operações lançam erro, equals é false", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl("1.00").equals(usd)).toBe(false);
  });
});
