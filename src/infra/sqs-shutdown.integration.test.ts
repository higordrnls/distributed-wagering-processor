import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { createTestOrm } from "./test-db";

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
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  });

  const queue = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-shutdown-${randomUUID()}.fifo`,
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
  try {
    if (queueUrl) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  } finally {
    await pool?.end();
    sqs?.destroy();
  }
});

describe("SQS — shutdown gracioso com SIGTERM real", () => {
  test("aguarda processamento, confirma ACK e encerra sem duplicar débito", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const externalId = randomUUID();
    const messageId = randomUUID();

    await pool.query(
      `INSERT INTO wallets
       (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', '100.00', 1, NOW(), NOW())`,
      [walletId, playerId],
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          messageId,
          type: "WagerTransactionRequested",
          data: {
            providerId: "shutdown-test",
            externalTransactionId: externalId,
            playerId,
            walletId,
            roundId: randomUUID(),
            gameId: "shutdown-game",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
            idempotencyKey: `shutdown:${externalId}`,
          },
        }),
        MessageGroupId: walletId,
        MessageDeduplicationId: messageId,
      }),
    );

    const worker = Bun.spawn(
      [
        process.execPath,
        "src/infra/test-workers/sqs-shutdown.worker.ts",
        queueUrl,
      ],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    let output = "";
    let exited = false;
    const stderrPromise = new Response(worker.stderr).text();

    const reader = worker.stdout.getReader();

    const readOutput = (async () => {
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value);
      }
    })();

    const exitPromise = worker.exited.then(async (code) => {
      exited = true;
      console.error("WORKER_EXIT_CODE:", code);
      console.error("WORKER_STDERR:", await stderrPromise);
      return code;
    });

    async function waitFor(text: string, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;

      while (!output.includes(text)) {
        if (exited) {
          throw new Error(`Worker encerrou antes de ${text}: ${output}`);
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timeout esperando ${text}: ${output}`);
        }
        await Bun.sleep(20);
      }
    }

    try {
      await waitFor("WORKER_READY");
      await waitFor("PROCESSING_STARTED");

      worker.kill("SIGTERM");
      await waitFor("SIGTERM_RECEIVED");

      await Bun.sleep(200);
      expect(exited).toBe(false);
      expect(output).not.toContain("SHUTDOWN_COMPLETE");

      worker.kill("SIGUSR1");

      await waitFor("SHUTDOWN_COMPLETE");
      expect(await exitPromise).toBe(0);
      await readOutput;

      const wallet = await pool.query(
        "SELECT balance FROM wallets WHERE id = $1",
        [walletId],
      );

      const ledger = await pool.query(
        `SELECT direction, amount FROM wallet_ledger_entries
         WHERE wallet_id = $1`,
        [walletId],
      );

      const transactions = await pool.query(
        `SELECT status FROM wager_transactions
         WHERE wallet_id = $1`,
        [walletId],
      );

      const inbox = await pool.query(
        `SELECT processed_at FROM inbox_messages
         WHERE consumer_name = $1 AND message_id = $2`,
        ["wager-transaction-consumer-v1", messageId],
      );

      expect(String(wallet.rows[0].balance)).toBe("90.00");
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0].direction).toBe("DEBIT");
      expect(String(ledger.rows[0].amount)).toBe("10.00");
      expect(transactions.rows).toHaveLength(1);
      expect(transactions.rows[0].status).toBe("PROCESSED");
      expect(inbox.rows).toHaveLength(1);
      expect(inbox.rows[0].processed_at).not.toBeNull();
    } finally {
      if (!exited) {
        worker.kill("SIGKILL");
        await exitPromise;
      }
      await readOutput;
    }
  }, 30000);
});
