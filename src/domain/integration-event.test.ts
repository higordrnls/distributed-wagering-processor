import { describe, expect, test } from "bun:test";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from "./integration-event";

describe("IntegrationEvent — contrato de publicação", () => {
  const props = {
    eventId: "event-123",
    aggregateId: "transaction-456",
    correlationId: "request-789",
    causationId: "message-321",
    occurredAt: new Date("2026-10-22T12:00:00.000Z"),
    data: {
      transactionId: "transaction-456",
      money: { amount: "25.00", currency: "BRL" },
    },
  };

  const cases = [
    ["WagerTransactionProcessed", WagerTransactionProcessed],
    ["WagerTransactionRejected", WagerTransactionRejected],
    ["WagerTransactionPendingReference", WagerTransactionPendingReference],
    ["WalletBalanceChanged", WalletBalanceChanged],
  ] as const;

  for (const [eventType, EventClass] of cases) {
    test(`serializa ${eventType} com envelope versionado`, () => {
      const event = EventClass.from(props);
      const json = event.toJSON();

      expect(json.eventId).toBe("event-123");
      expect(json.eventType).toBe(eventType);
      expect(json.aggregateId).toBe("transaction-456");
      expect(json.correlationId).toBe("request-789");
      expect(json.causationId).toBe("message-321");
      expect(json.occurredAt).toBe("2026-10-22T12:00:00.000Z");
      expect(json.version).toBe(1);
      expect(json.data).toEqual(props.data);
      expect(json.data.money).toEqual({ amount: "25.00", currency: "BRL" });
    });
  }

  test("omite causationId quando não informado", () => {
    const { causationId, ...withoutCausation } = props;
    const event = WagerTransactionProcessed.from(withoutCausation);

    expect(event.toJSON()).not.toHaveProperty("causationId");
  });
});
