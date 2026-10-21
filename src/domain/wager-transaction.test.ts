import { describe, expect, test } from "bun:test";
import { InvalidTransactionError, InvalidTransactionStateError } from "./errors";
import { FailureCode } from "./failure-code";
import { LedgerDirection } from "./ledger-entry";
import { Money } from "./money";
import { CreateWagerTransactionProps, WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from "./wager-transaction";

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

describe("WagerTransaction.create", () => {
  test("nasce PENDING", () => {
    expect(mk().status).toBe(S.Pending);
  });
  test("OPENING não pode ser submetido", () => {
    expect(() => mk({ kind: K.Opening })).toThrow(InvalidTransactionError);
  });
  test("REFUND e ROLLBACK exigem referência", () => {
    expect(() => mk({ kind: K.Refund })).toThrow(InvalidTransactionError);
    expect(() => mk({ kind: K.Rollback })).toThrow(InvalidTransactionError);
  });
  test("valor zero só é aceito em LOSS", () => {
    expect(() => mk({ money: brl("0.00") })).toThrow(InvalidTransactionError);
    expect(mk({ kind: K.Loss, money: brl("0.00") }).status).toBe(S.Pending);
  });
  test("consultas de domínio", () => {
    expect(mk({ kind: K.Loss }).affectsBalance()).toBe(false);
    expect(mk().affectsBalance()).toBe(true);
    expect(mk({ kind: K.Refund, referenceExternalTransactionId: "x" }).requiresReference()).toBe(true);
    expect(mk().requiresReference()).toBe(false);
    expect(mk({ payloadHash: "abc" }).matchesPayload("abc")).toBe(true);
    expect(mk({ payloadHash: "abc" }).matchesPayload("xyz")).toBe(false);
  });
});

describe("transições de estado", () => {
  test("PENDING -> PENDING_REFERENCE -> PROCESSED", () => {
    const t = mk();
    t.markPendingReference();
    t.markPendingReference(); // nova tentativa é permitida
    expect(t.status).toBe(S.PendingReference);
    t.markProcessed("ref-id", now);
    expect(t.status).toBe(S.Processed);
    expect(t.referenceTransactionId).toBe("ref-id");
    expect(t.processedAt).toEqual(now);
  });
  test("reject e fail guardam o failureCode", () => {
    const a = mk();
    a.reject(FailureCode.InsufficientFunds);
    expect(a.status).toBe(S.Rejected);
    expect(a.failureCode).toBe(FailureCode.InsufficientFunds);
    const b = mk();
    b.fail(FailureCode.InternalError);
    expect(b.status).toBe(S.Failed);
  });
  test("estados terminais não mudam mais", () => {
    for (const finish of [
      (t: WagerTransaction) => t.markProcessed(undefined, now),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds),
      (t: WagerTransaction) => t.fail(FailureCode.InternalError),
    ]) {
      const t = mk();
      finish(t);
      expect(t.isTerminal()).toBe(true);
      expect(() => t.markProcessed(undefined, now)).toThrow(InvalidTransactionStateError);
      expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
      expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
      expect(() => t.fail(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
    }
  });
});

describe("ledgerDirectionFor", () => {
  test("BET debita; WIN e REFUND creditam", () => {
    expect(mk().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(mk({ kind: K.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(mk({ kind: K.Refund, referenceExternalTransactionId: "x" }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
  test("ROLLBACK inverte a direção da referência", () => {
    const rb = mk({ kind: K.Rollback, referenceExternalTransactionId: "x" });
    expect(rb.ledgerDirectionFor(mk())).toBe(LedgerDirection.Credit); // reverte BET
    expect(rb.ledgerDirectionFor(mk({ kind: K.Win }))).toBe(LedgerDirection.Debit); // reverte WIN
    expect(rb.ledgerDirectionFor(mk({ kind: K.Refund, referenceExternalTransactionId: "y" }))).toBe(LedgerDirection.Debit);
  });
  test("LOSS e ROLLBACK sem referência lançam erro", () => {
    expect(() => mk({ kind: K.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionError);
    expect(() => mk({ kind: K.Rollback, referenceExternalTransactionId: "x" }).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
});
