import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { ormOptions } from "./orm-config";

const testDb = `wager_outbox_multi_${randomUUID().replaceAll("-", "")}`;
const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
};

let pool: Pool;
let sqs: SQSClient;
let queueUrl: string;

function adminClient() {
  return new Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "wager",
    password: process.env.DB_PASSWORD ?? "wager",
    database: "postgres",
  });
}

beforeAll(async () => {
  const admin = adminClient();
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${testDb}`);
  } finally {
    await admin.end();
  }

  const orm = await MikroORM.init(ormOptions(testDb));
  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }

  pool = new Pool({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "wager",
    password: process.env.DB_PASSWORD ?? "wager",
    database: testDb,
  });

  sqs = new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint,
    credentials,
  });

  const queue = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-outbox-multi-${randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }),
  );

  if (!queue.QueueUrl) throw new Error("Fila SQS não criada");
  queueUrl = queue.QueueUrl;
});

afterAll(async () => {
  try {
    if (queueUrl && sqs) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  } finally {
    try {
      await pool?.end();
    } finally {
      sqs?.destroy();

      const admin = adminClient();
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }
});

async function runPublisher(): Promise<void> {
  const worker = Bun.spawn(
    ["bun", "run", "src/infra/test-workers/outbox-concurrency.worker.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_DB_NAME: testDb,
        SQS_EVENTS_QUEUE_URL: queueUrl,
        SQS_ENDPOINT: endpoint,
        OUTBOX_POLL_INTERVAL_MS: "60000",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
    worker.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `Publisher saiu com código ${exitCode}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`,
    );
  }
}

describe("Outbox — três processos Bun independentes", () => {
  test("publica 60 eventos sem reservas duplicadas", async () => {
    const ids = Array.from({ length: 60 }, () => randomUUID());

    for (const id of ids) {
      await pool.query(
        `INSERT INTO outbox_messages
         (id, aggregate_id, event_type, payload, occurred_at)
         VALUES ($1, $2, 'TestEvent', $3::jsonb, NOW())`,
        [id, id, JSON.stringify({ testId: id })],
      );
    }

    await Promise.all([
      runPublisher(),
      runPublisher(),
      runPublisher(),
    ]);

    const result = await pool.query<{
      id: string;
      attempts: number;
      published_at: Date | null;
    }>(
      `SELECT id, attempts, published_at
       FROM outbox_messages
       WHERE id = ANY($1::uuid[])`,
      [ids],
    );

    expect(result.rows).toHaveLength(60);
    expect(
      result.rows.every((row) => row.published_at !== null),
    ).toBe(true);
    expect(
      result.rows.every((row) => row.attempts === 1),
    ).toBe(true);

    const received = new Set<string>();
    let totalMessages = 0;

    for (let attempt = 0; attempt < 30 && received.size < 60; attempt++) {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );

      const entries = [];

      for (const message of response.Messages ?? []) {
        const event = JSON.parse(message.Body ?? "{}") as {
          eventId?: string;
          eventType?: string;
          data?: { testId?: string };
        };

        expect(typeof event.eventId).toBe("string");

        if (typeof event.eventId !== "string") {
          throw new Error("Mensagem SQS sem eventId válido");
        }

        expect(ids.some((id) => id === event.eventId)).toBe(true);
        expect(event.eventType).toBe("TestEvent");
        expect(event.data?.testId).toBe(event.eventId);

        received.add(event.eventId);

        totalMessages++;

        if (message.ReceiptHandle) {
          entries.push({
            Id: randomUUID(),
            ReceiptHandle: message.ReceiptHandle,
          });
        }
      }

      if (entries.length) {
        const deleted = await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: entries,
          }),
        );
        expect(deleted.Failed ?? []).toHaveLength(0);
      }
    }

    expect(received.size).toBe(60);
    expect(totalMessages).toBe(60);
  }, 60000);
});
