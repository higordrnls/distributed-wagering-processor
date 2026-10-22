import { EntitySchema } from "@mikro-orm/core";

export class InboxMessageEntity {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const inboxMessageSchema = new EntitySchema({
  class: InboxMessageEntity,
  tableName: "inbox_messages",
  properties: {
    consumerName: {
      type: "string",
      fieldName: "consumer_name",
      primary: true,
    },
    messageId: {
      type: "string",
      fieldName: "message_id",
      primary: true,
    },
    payloadHash: {
      type: "string",
      fieldName: "payload_hash",
    },
    receivedAt: {
      type: "Date",
      fieldName: "received_at",
    },
    processedAt: {
      type: "Date",
      fieldName: "processed_at",
      nullable: true,
    },
  },
});
