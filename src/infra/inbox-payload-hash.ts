import { createHash } from "node:crypto";
import { Money } from "../domain/money";
import { canonicalJson } from "../domain/payload-hash";

export function computeInboxPayloadHash(data: Record<string, unknown>): string {
  const normalized = { ...data };

  if (
    normalized.money &&
    typeof normalized.money === "object" &&
    !Array.isArray(normalized.money)
  ) {
    const money = normalized.money as Record<string, unknown>;

    if (typeof money.amount === "string" && typeof money.currency === "string") {
      normalized.money = Money.from({
        amount: money.amount,
        currency: money.currency,
      }).toJSON();
    }
  }

  return createHash("sha256")
    .update(canonicalJson(normalized))
    .digest("hex");
}
