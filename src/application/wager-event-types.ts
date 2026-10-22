import { WagerTransactionStatus } from "../domain/wager-transaction";

export type WagerEventType =
  | "WagerTransactionProcessed"
  | "WagerTransactionRejected"
  | "WagerTransactionPendingReference"
  | "WalletBalanceChanged";

export function selectWagerEvents(input: {
  status: WagerTransactionStatus;
  balanceBefore?: string;
  balanceAfter?: string;
}): WagerEventType[] {
  const events: WagerEventType[] = [];

  switch (input.status) {
    case WagerTransactionStatus.Processed:
      events.push("WagerTransactionProcessed");
      break;

    case WagerTransactionStatus.Rejected:
      events.push("WagerTransactionRejected");
      break;

    case WagerTransactionStatus.PendingReference:
      events.push("WagerTransactionPendingReference");
      break;
  }

  if (
    input.balanceBefore !== undefined &&
    input.balanceAfter !== undefined &&
    input.balanceBefore !== input.balanceAfter
  ) {
    events.push("WalletBalanceChanged");
  }

  return events;
}
