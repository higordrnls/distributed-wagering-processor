import { describe, expect, test } from "bun:test";
import { WagerTransactionStatus } from "../domain/wager-transaction";
import { selectWagerEvents } from "./wager-event-types";

describe("Wager domain events", () => {
  test("BET processada com alteração de saldo", () => {
    expect(selectWagerEvents({
      status: WagerTransactionStatus.Processed,
      balanceBefore: "100.00",
      balanceAfter: "75.00",
    })).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("LOSS processada sem alteração de saldo", () => {
    expect(selectWagerEvents({
      status: WagerTransactionStatus.Processed,
    })).toEqual(["WagerTransactionProcessed"]);
  });

  test("transação rejeitada", () => {
    expect(selectWagerEvents({
      status: WagerTransactionStatus.Rejected,
    })).toEqual(["WagerTransactionRejected"]);
  });

  test("referência pendente", () => {
    expect(selectWagerEvents({
      status: WagerTransactionStatus.PendingReference,
    })).toEqual(["WagerTransactionPendingReference"]);
  });

  test("não emite WalletBalanceChanged quando o saldo permanece igual", () => {
    expect(selectWagerEvents({
      status: WagerTransactionStatus.Processed,
      balanceBefore: "100.00",
      balanceAfter: "100.00",
    })).toEqual(["WagerTransactionProcessed"]);
  });
});
