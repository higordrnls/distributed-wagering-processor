import { EntitySchema } from "@mikro-orm/core";

export class WagerTransactionEntity {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  status!: string;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  observedBalance?: string | null;
  correlationId?: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const wagerTransactionSchema = new EntitySchema({
  class: WagerTransactionEntity,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", fieldName: "provider_id" },
    externalTransactionId: { type: "string", fieldName: "external_transaction_id" },
    idempotencyKey: { type: "string", fieldName: "idempotency_key" },
    payloadHash: { type: "string", fieldName: "payload_hash" },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    playerId: { type: "string", fieldName: "player_id" },
    roundId: { type: "string", fieldName: "round_id" },
    gameId: { type: "string", fieldName: "game_id" },
    kind: { type: "string" },
    amount: { type: "decimal", precision: 18, scale: 2 },
    currency: { type: "string" },
    referenceExternalTransactionId: {
      type: "string", fieldName: "reference_external_transaction_id",
      nullable: true,
    },
    status: { type: "string" },
    referenceTransactionId: {
      type: "uuid", fieldName: "reference_transaction_id", nullable: true,
    },
    failureCode: { type: "string", fieldName: "failure_code", nullable: true },
    observedBalance: {
      type: "decimal",
      precision: 18,
      scale: 2,
      fieldName: "observed_balance",
      nullable: true,
    },
    correlationId: {
      type: "string",
      fieldName: "correlation_id",
      nullable: true,
    },
    referenceAttempts: {
      type: "integer", fieldName: "reference_attempts", default: 0,
    },
    nextReferenceAttemptAt: {
      type: "Date", fieldName: "next_reference_attempt_at", nullable: true,
    },
    createdAt: { type: "Date", fieldName: "created_at" },
    processedAt: { type: "Date", fieldName: "processed_at", nullable: true },
  },
});
