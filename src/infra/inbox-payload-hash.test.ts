import { describe, expect, test } from "bun:test";
import { computeInboxPayloadHash as inboxHash } from "./inbox-payload-hash";

describe("deduplicação da inbox", () => {
  const data = {
    providerId: "provider-a",
    externalTransactionId: "bet-001",
    idempotencyKey: "provider-a:bet-001",
    walletId: "wallet-001",
    money: { amount: "25.00", currency: "BRL" },
  };

  test("metadados de transporte não alteram o hash", () => {
    const first = {
      messageId: "msg-001",
      correlationId: "correlation-a",
      occurredAt: "2026-10-21T10:00:00.000Z",
      data,
    };

    const second = {
      ...first,
      correlationId: "correlation-b",
      occurredAt: "2026-10-22T10:00:00.000Z",
    };

    expect(inboxHash(first.data)).toBe(inboxHash(second.data));
  });

  test("mudança nos dados de negócio altera o hash", () => {
    const changed = {
      ...data,
      money: { amount: "50.00", currency: "BRL" },
    };

    expect(inboxHash(data)).not.toBe(inboxHash(changed));
  });

  test("25 e 25.00 representam o mesmo valor monetário", () => {
    const equivalent = {
      ...data,
      money: { amount: "25", currency: "BRL" },
    };

    expect(inboxHash(data)).toBe(inboxHash(equivalent));
  });

  test("ordem das propriedades não altera o hash", () => {
    const reordered = {
      money: { currency: "BRL", amount: "25.00" },
      walletId: "wallet-001",
      idempotencyKey: "provider-a:bet-001",
      externalTransactionId: "bet-001",
      providerId: "provider-a",
    };

    expect(inboxHash(data)).toBe(inboxHash(reordered));
  });
});
