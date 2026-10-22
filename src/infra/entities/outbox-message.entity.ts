import { EntitySchema } from "@mikro-orm/core";

export class OutboxMessageEntity {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
  correlationId?: string | null;
}

export const outboxMessageSchema = new EntitySchema({
  class: OutboxMessageEntity,
  tableName: "outbox_messages",
  properties: {
    id: {
      type: "uuid",
      primary: true,
    },
    aggregateId: {
      type: "string",
      fieldName: "aggregate_id",
    },
    eventType: {
      type: "string",
      fieldName: "event_type",
    },
    payload: {
      type: "json",
    },
    occurredAt: {
      type: "Date",
      fieldName: "occurred_at",
    },
    attempts: {
      type: "integer",
      default: 0,
    },
    nextAttemptAt: {
      type: "Date",
      fieldName: "next_attempt_at",
      nullable: true,
    },
    publishedAt: {
      type: "Date",
      fieldName: "published_at",
      nullable: true,
    },
    correlationId: {
      type: "string",
      fieldName: "correlation_id",
      nullable: true,
    },
  },
});
