import { describe, expect, test } from "bun:test";
import { Money } from "./money";
import { canonicalJson, computePayloadHash, PayloadFields } from "./payload-hash";

const base = (amount = "25.00"): PayloadFields => ({
  providerId: "prov", externalTransactionId: "t1", playerId: "p1", walletId: "w1",
  roundId: "r1", gameId: "g1", kind: "BET", money: Money.from({ amount, currency: "BRL" }),
});

describe("payload hash", () => {
  test("canonicalJson ordena chaves e omite undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: undefined } })).toBe('{"a":{"d":1},"b":1}');
  });
  test("mesmo conteúdo gera o mesmo hash (64 hex)", () => {
    expect(computePayloadHash(base())).toBe(computePayloadHash(base()));
    expect(computePayloadHash(base())).toMatch(/^[0-9a-f]{64}$/);
  });
  test('"25" e "25.00" geram o mesmo hash (valor normalizado)', () => {
    expect(computePayloadHash(base("25"))).toBe(computePayloadHash(base("25.00")));
  });
  test("qualquer mudança de negócio muda o hash", () => {
    expect(computePayloadHash(base("26.00"))).not.toBe(computePayloadHash(base()));
    expect(computePayloadHash({ ...base(), kind: "WIN" })).not.toBe(computePayloadHash(base()));
    expect(computePayloadHash({ ...base(), roundId: "r2" })).not.toBe(computePayloadHash(base()));
  });
  test("referência ausente equivale a undefined", () => {
    expect(computePayloadHash({ ...base(), referenceExternalTransactionId: undefined })).toBe(computePayloadHash(base()));
  });
});
