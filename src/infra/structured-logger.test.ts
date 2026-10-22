import { describe, expect, test } from "bun:test";
import { StructuredLogger } from "./structured-logger";

describe("StructuredLogger", () => {
  test("serializa entradas estruturadas em JSON", () => {
    const logger = new StructuredLogger();
    const originalWrite = process.stderr.write;
    const lines: string[] = [];

    try {
      process.stderr.write = ((chunk: string) => {
        lines.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      logger.log({
        event: "wager_processed",
        correlationId: "correlation-123",
        transactionId: "transaction-456",
        walletId: "wallet-789",
      }, "WagerTransactionService");
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe("info");
    expect(parsed.context).toBe("WagerTransactionService");
    expect(parsed.message.correlationId).toBe("correlation-123");
    expect(parsed.message.transactionId).toBe("transaction-456");
    expect(parsed.message.walletId).toBe("wallet-789");
    expect(typeof parsed.timestamp).toBe("string");
  });
});
