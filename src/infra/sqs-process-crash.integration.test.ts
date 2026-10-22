import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
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
      QueueName: `wager-crash-${randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }),
  );

  if (!queue.QueueUrl) {
    throw new Error("Fila de teste não criada");
  }

  queueUrl = queue.QueueUrl;
});

afterAll(async () => {
  if (queueUrl && sqs) {
    await sqs.send(
      new DeleteQueueCommand({ QueueUrl: queueUrl }),
    );
  }

  await pool?.end();
  sqs?.destroy();
});

async function runWorker(mode: "crash" | "recover") {
  const worker = Bun.spawn(
    [
      "bun",
      "run",
      "src/infra/test-workers/sqs-crash.worker.ts",
      mode,
      queueUrl,
    ],
    {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
    worker.exited,
  ]);

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

describe("SQS — queda real após COMMIT e antes do ACK", () => {
  test("outro processo recupera sem duplicar débito", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const externalId = randomUUID();
    const messageId = randomUUID();

    await pool.query(
      `INSERT INTO wallets (
         id, player_id, currency, balance,
         version, created_at, updated_at
       ) VALUES ($1, $2, 'BRL', '100.00', 1, NOW(), NOW())`,
      [walletId, playerId],
    );

    const envelope = {
      messageId,
      type: "WagerTransactionRequested",
      data: {
        providerId: "sqs-crash-test",
        externalTransactionId: externalId,
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: "crash-test-game",
        kind: "BET",
        money: {
          amount: "10.00",
          currency: "BRL",
        },
        idempotencyKey: `crash:${externalId}`,
      },
    };

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: walletId,
        MessageDeduplicationId: messageId,
      }),
    );

    const crashed = await runWorker("crash");

    expect(crashed.exitCode).toBe(42);

    const first = JSON.parse(crashed.stdout);
    expect(first.committed).toBe(true);
    expect(first.acknowledged).toBe(false);

    const before = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );

    expect(String(before.rows[0].balance)).toBe("90.00");

    // Aguarda a expiração do VisibilityTimeout de 2 segundos.
    await Bun.sleep(2500);

    const recovered = await runWorker("recover");

    expect(recovered.exitCode).toBe(0);

    const second = JSON.parse(recovered.stdout);
    expect(second.idempotentReplay).toBe(true);
    expect(second.acknowledged).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    const wallet = await pool.query(
      "SELECT balance FROM wallets WHERE id = $1",
      [walletId],
    );

    const ledger = await pool.query(
      `SELECT direction, amount
       FROM wallet_ledger_entries
       WHERE wallet_id = $1`,
      [walletId],
    );

    const transactions = await pool.query(
      `SELECT id, status
       FROM wager_transactions
       WHERE wallet_id = $1`,
      [walletId],
    );

    const inbox = await pool.query(
      `SELECT message_id, processed_at
       FROM inbox_messages
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

    const queue = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );

    expect(
      Number(queue.Attributes?.ApproximateNumberOfMessages ?? -1),
    ).toBe(0);
  }, 30000);
});
