import { createHash } from "node:crypto";
import type { Money } from "./money";

/** Apenas campos de negócio. Header Idempotency-Key e metadados de transporte NÃO entram. */
export interface PayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string;
}

/** JSON canônico: chaves ordenadas recursivamente, valores undefined omitidos. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** SHA-256 (hex) do JSON canônico dos campos de negócio, com o valor normalizado a 2 casas. */
export function computePayloadHash(f: PayloadFields): string {
  const canonical = canonicalJson({ ...f, money: f.money.toJSON() });
  return createHash("sha256").update(canonical).digest("hex");
}
