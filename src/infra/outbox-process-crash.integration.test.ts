import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const CRASH_TEST_DB = "wager_outbox_crash_test";
import { OutboxPublisher } from "./outbox-publisher";

let pool: Pool;
let sqs: SQSClient;
let queueUrl: string;

beforeAll(async () => {
  const { Client } = await import("pg");
  const admin = new Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "wager",
    password: process.env.DB_PASSWORD ?? "wager",
    database: "postgres",
  });

  await admin.connect();
  try {
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [CRASH_TEST_DB],
    );
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${CRASH_TEST_DB}`);
    }
  } finally {
    await admin.end();
  }

  const { MikroORM } = await import("@mikro-orm/postgresql");
  const { ormOptions } = await import("./orm-config");
  const orm = await MikroORM.init(ormOptions(CRASH_TEST_DB));
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
    database: CRASH_TEST_DB,
  });

  sqs = new SQSClient({
    region: "us-east-1",
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  });

  const queue = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-outbox-crash-${randomUUID()}.fifo`,
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

  const { Client } = await import("pg");
  const admin = new Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "wager",
    password: process.env.DB_PASSWORD ?? "wager",
    database: "postgres",
  });

  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${CRASH_TEST_DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

describe("Outbox — queda real após publicação no SQS", () => {
  test("recupera evento quando o processo morre antes de confirmar a publicação", async () => {
    const id = randomUUID();
    const suffix = randomUUID().replaceAll("-", "");
    const triggerName = `outbox_crash_${suffix}`;
    const functionName = `outbox_crash_fn_${suffix}`;

    const previousQueue = process.env.SQS_EVENTS_QUEUE_URL;
    const previousInterval = process.env.OUTBOX_POLL_INTERVAL_MS;
    const previousEndpoint = process.env.SQS_ENDPOINT;
    const previousTestDb = process.env.TEST_DB_NAME;

    let worker: ReturnType<typeof Bun.spawn> | undefined;
    let recoveryPublisher: OutboxPublisher | undefined;

    process.env.SQS_EVENTS_QUEUE_URL = queueUrl;
    process.env.OUTBOX_POLL_INTERVAL_MS = "60000";

    try {
      await pool.query(
        `INSERT INTO outbox_messages (
           id, aggregate_id, event_type, payload, occurred_at
         ) VALUES ($1::uuid, $1::uuid::text, 'OutboxCrashTestEvent', $2::jsonb, NOW())`,
        [id, JSON.stringify({ testId: id })],
      );

      // Mantém a atualização de published_at bloqueada após o envio ao SQS.
      // O processo pai poderá comprovar a publicação e matar o worker nessa janela.
      await pool.query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.id = '${id}'::uuid
             AND OLD.published_at IS NULL
             AND NEW.published_at IS NOT NULL THEN
            PERFORM pg_sleep(30);
          END IF;
          RETURN NEW;
        END;
        $$;
      `);

      await pool.query(`
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE OF published_at ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `);

      worker = Bun.spawn(
        ["bun", "run", "src/infra/test-workers/outbox-crash.worker.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...Bun.env,
            SQS_EVENTS_QUEUE_URL: queueUrl,
            OUTBOX_POLL_INTERVAL_MS: "60000",
            TEST_DB_NAME: CRASH_TEST_DB,
            ...(previousEndpoint
              ? { SQS_ENDPOINT: previousEndpoint }
              : {}),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      let publishedMessage = false;

      // Só prossegue depois de observar o evento que chegou ao SQS.
      for (let attempt = 0; attempt < 20 && !publishedMessage; attempt++) {
        const response = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );

        for (const message of response.Messages ?? []) {
          let matches = false;

          try {
            matches = JSON.parse(message.Body ?? "{}").eventId === id;
          } catch {
            // Mensagens não relacionadas não são o evento deste teste.
          }

          if (matches) publishedMessage = true;

          // A fila é exclusiva deste teste; removemos a mensagem observada
          // para que a recuperação não dependa de uma mensagem invisível.
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle!,
            }),
          );
        }

        if (worker.exitCode !== null) {
          throw new Error(
            `Worker encerrou antes da queda planejada: ${worker.exitCode}`,
          );
        }
      }

      if (!publishedMessage) {
        worker.kill("SIGKILL");
        await worker.exited;

        const stdout = worker.stdout instanceof ReadableStream
          ? await new Response(worker.stdout).text()
          : "";
        const stderr = worker.stderr instanceof ReadableStream
          ? await new Response(worker.stderr).text()
          : "";

        worker = undefined;

        throw new Error(
          `Evento não observado no SQS. Worker stdout: ${stdout}; stderr: ${stderr}`,
        );
      }

      // O SQS aceitou a mensagem, mas a atualização no banco está bloqueada.
      worker.kill("SIGKILL");
      await worker.exited;
      worker = undefined;

      // Encerrar explicitamente a consulta que o PostgreSQL pode continuar
      // executando após a morte do processo cliente.
      await pool.query(`
        SELECT pg_cancel_backend(pid)
        FROM pg_stat_activity
        WHERE application_name = 'outbox-crash-worker'
          AND state = 'active'
          AND query ILIKE 'UPDATE outbox_messages%'
      `);

      let queryStillRunning = true;
      for (let attempt = 0; attempt < 50; attempt++) {
        const active = await pool.query(`
          SELECT 1
          FROM pg_stat_activity
          WHERE application_name = 'outbox-crash-worker'
            AND state = 'active'
            AND query ILIKE 'UPDATE outbox_messages%'
        `);

        if (active.rowCount === 0) {
          queryStillRunning = false;
          break;
        }

        await Bun.sleep(100);
      }

      expect(queryStillRunning).toBe(false);

      const interrupted = await pool.query(
        `SELECT attempts, published_at
         FROM outbox_messages WHERE id = $1`,
        [id],
      );

      expect(interrupted.rows[0].attempts).toBe(1);
      expect(interrupted.rows[0].published_at).toBeNull();

      await pool.query(`DROP TRIGGER ${triggerName} ON outbox_messages`);
      await pool.query(`DROP FUNCTION ${functionName}()`);

      // Simula o vencimento da reserva abandonada após a queda.
      await pool.query(
        `UPDATE outbox_messages
         SET next_attempt_at = NOW() - INTERVAL '1 second'
         WHERE id = $1 AND published_at IS NULL`,
        [id],
      );

      recoveryPublisher = new OutboxPublisher(pool);
      recoveryPublisher.onModuleInit();

      let recovered = false;

      for (let attempt = 0; attempt < 150; attempt++) {
        const result = await pool.query(
          `SELECT attempts, published_at
           FROM outbox_messages WHERE id = $1`,
          [id],
        );

        if (result.rows[0].published_at !== null) {
          expect(result.rows[0].attempts).toBe(2);
          recovered = true;
          break;
        }

        await Bun.sleep(100);
      }

      expect(recovered).toBe(true);
    } finally {
      if (worker && worker.exitCode === null) {
        worker.kill("SIGKILL");
        await worker.exited;
      }

      if (recoveryPublisher) {
        await recoveryPublisher.onModuleDestroy();
      }

      try {
        await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_messages`);
        await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
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

      if (previousEndpoint === undefined) {
        delete process.env.SQS_ENDPOINT;
      } else {
        process.env.SQS_ENDPOINT = previousEndpoint;
      }

      if (previousTestDb === undefined) {
        delete process.env.TEST_DB_NAME;
      } else {
        process.env.TEST_DB_NAME = previousTestDb;
      }
      }
    }
  }, 60000);
});
