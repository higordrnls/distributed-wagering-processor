import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { createTestOrm } from "./test-db";
import { OutboxPublisher } from "./outbox-publisher";

let pool: Pool;
let sqs: SQSClient;
let queueUrl: string;

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
      QueueName: `wager-recovery-${randomUUID()}.fifo`,
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

describe("Outbox — recuperação de reserva abandonada", () => {
  test("publica evento após expiração da reserva", async () => {
    const id = randomUUID();

    await pool.query(
      `INSERT INTO outbox_messages (
         id, aggregate_id, event_type, payload,
         occurred_at, attempts, next_attempt_at
       ) VALUES (
         $1::uuid, $1::uuid::text, 'RecoveryTestEvent', $2::jsonb,
         NOW(), 1, NOW() + INTERVAL '1 hour'
       )`,
      [id, JSON.stringify({ recoveryTestId: id })],
    );

    const previousQueue = process.env.SQS_EVENTS_QUEUE_URL;
    const previousInterval = process.env.OUTBOX_POLL_INTERVAL_MS;

    process.env.SQS_EVENTS_QUEUE_URL = queueUrl;
    process.env.OUTBOX_POLL_INTERVAL_MS = "60000";

    const publisher = new OutboxPublisher(pool);

    try {
      publisher.onModuleInit();

      await Bun.sleep(300);

      const before = await pool.query(
        `SELECT attempts, published_at
         FROM outbox_messages WHERE id = $1`,
        [id],
      );

      expect(before.rows[0].attempts).toBe(1);
      expect(before.rows[0].published_at).toBeNull();

      // Simula o vencimento da reserva abandonada.
      await pool.query(
        `UPDATE outbox_messages
         SET next_attempt_at = NOW() - INTERVAL '1 second'
         WHERE id = $1`,
        [id],
      );

      // Reinicia o ciclo do publisher para recuperar o evento.
      await publisher.onModuleDestroy();

      const recoveredPublisher = new OutboxPublisher(pool);

      try {
        recoveredPublisher.onModuleInit();

        await Bun.sleep(500);

        const after = await pool.query(
          `SELECT attempts, published_at
           FROM outbox_messages WHERE id = $1`,
          [id],
        );

        expect(after.rows[0].attempts).toBe(2);
        expect(after.rows[0].published_at).not.toBeNull();

        let found = false;

        for (let attempt = 0; attempt < 10 && !found; attempt++) {
          const response = await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 1,
            }),
          );

          for (const message of response.Messages ?? []) {
            const event = JSON.parse(message.Body!);

            if (event.eventId === id) {
              found = true;
            }

            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: message.ReceiptHandle!,
              }),
            );
          }
        }

        expect(found).toBe(true);
      } finally {
        await recoveredPublisher.onModuleDestroy();
      }
    } finally {
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
