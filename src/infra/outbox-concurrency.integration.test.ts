import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageBatchCommand,
  CreateQueueCommand,
  DeleteQueueCommand,
} from "@aws-sdk/client-sqs";
import { createTestOrm } from "./test-db";
import { OutboxPublisher } from "./outbox-publisher";

let queueUrl: string;

let pool: Pool;
let sqs: SQSClient;

beforeAll(async () => {
  const orm = await createTestOrm();
  await orm.close(true);

  pool = new Pool({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "wager",
    password: process.env.DB_PASSWORD ?? "wager",
    database: "wager_test",
  });

  sqs = new SQSClient({
    region: "us-east-1",
    endpoint: "http://localhost:4566",
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  });

  const queue = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-outbox-${randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }),
  );

  if (!queue.QueueUrl) throw new Error("Fila de teste não criada");
  queueUrl = queue.QueueUrl;
});

afterAll(async () => {
  if (queueUrl) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  }
  await pool?.end();
  sqs?.destroy();
});

describe("Outbox — dois publishers concorrentes", () => {
  test("publica eventos sem duplicar reservas", async () => {
    const previousQueue = process.env.SQS_EVENTS_QUEUE_URL;
    const previousInterval = process.env.OUTBOX_POLL_INTERVAL_MS;

    process.env.SQS_EVENTS_QUEUE_URL = queueUrl;
    process.env.OUTBOX_POLL_INTERVAL_MS = "60000";

    const ids = Array.from({ length: 10 }, () => randomUUID());

    for (const id of ids) {
      await pool.query(
        `INSERT INTO outbox_messages
         (id, aggregate_id, event_type, payload, occurred_at)
         VALUES ($1, $2, 'TestEvent', $3::jsonb, NOW())`,
        [id, id, JSON.stringify({ testId: id })],
      );
    }

    const publisherA = new OutboxPublisher(pool);
    const publisherB = new OutboxPublisher(pool);

    try {
      publisherA.onModuleInit();
      publisherB.onModuleInit();

      await Bun.sleep(1000);

      const result = await pool.query(
        `SELECT id, attempts, published_at
         FROM outbox_messages
         WHERE id = ANY($1::uuid[])`,
        [ids],
      );

      expect(result.rows).toHaveLength(10);
      expect(result.rows.every((row) => row.published_at !== null)).toBe(true);
      expect(result.rows.every((row) => row.attempts === 1)).toBe(true);

      const receivedIds = new Set<string>();

      for (let i = 0; i < 15 && receivedIds.size < 10; i++) {
        const response = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );

        for (const message of response.Messages ?? []) {
          const event = JSON.parse(message.Body!);
          if (ids.includes(event.eventId)) {
            expect(event.eventType).toBe("TestEvent");
            expect(event.version).toBe(1);
            expect(event.aggregateId).toBe(event.eventId);
            expect(event.correlationId).toBe(event.aggregateId);
            expect(event.occurredAt).toEqual(expect.any(String));
            expect(event.data).toEqual({ testId: event.eventId });
            receivedIds.add(event.eventId);
          }

          await sqs.send(
            new DeleteMessageBatchCommand({
              QueueUrl: queueUrl,
              Entries: [{
                Id: randomUUID(),
                ReceiptHandle: message.ReceiptHandle!,
              }],
            }),
          );
        }
      }

      expect(receivedIds.size).toBe(10);
      expect(ids.every((id) => receivedIds.has(id))).toBe(true);
    } finally {
      await publisherA.onModuleDestroy();
      await publisherB.onModuleDestroy();

      if (previousQueue === undefined) {
        delete process.env.SQS_EVENTS_QUEUE_URL;
      } else {
        process.env.SQS_EVENTS_QUEUE_URL = previousQueue;
      }

      if (previousInterval === undefined) {
        delete process.env.OUTBOX_POLL_INTERVAL_MS;
      } else {
        process.env.OUTBOX_POLL_INTERVAL_MS = previousInterval;
      }
    }
  }, 30000);
});
