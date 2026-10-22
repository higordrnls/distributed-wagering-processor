import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { createTestOrm } from "./test-db";
import { WagerTransactionService } from "../api/wager-transaction.service";
import { canonicalJson } from "../domain/payload-hash";

const queueUrl =
  "http://localhost:4566/000000000000/wager-redelivery-test.fifo";

const consumerName = "wager-transaction-consumer-v1";

let pool: Pool;
let sqs: SQSClient;
let service: WagerTransactionService;

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

  service = new WagerTransactionService(pool);
});

afterAll(async () => {
  await pool?.end();
  sqs?.destroy();
});

describe("SQS real — redelivery após commit sem ACK", () => {
  test("a mesma mensagem recebida duas vezes gera apenas um débito", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const externalId = randomUUID();
    const messageId = randomUUID();

    await pool.query(
      `INSERT INTO wallets
       (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', 100.00, 1, NOW(), NOW())`,
      [walletId, playerId],
    );

    const envelope = {
      messageId,
      type: "WagerTransactionRequested",
      data: {
        providerId: "sqs-redelivery-test",
        externalTransactionId: externalId,
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: "redelivery-game",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
        idempotencyKey: `sqs:${externalId}`,
      },
    };

    const payloadHash = createHash("sha256")
      .update(canonicalJson(envelope))
      .digest("hex");

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: walletId,
        MessageDeduplicationId: messageId,
      }),
    );

    const firstReceive = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 5,
        VisibilityTimeout: 30,
      }),
    );

    const firstMessage = firstReceive.Messages?.[0];
    expect(firstMessage).toBeDefined();
    expect(firstMessage?.Body).toBeDefined();

    const firstEnvelope = JSON.parse(firstMessage!.Body!);

    const first = await service.submit(
      firstEnvelope.data,
      firstEnvelope.data.idempotencyKey,
      {
        consumerName,
        messageId: firstEnvelope.messageId,
        payloadHash,
      },
    );

    expect(first.body.status).toBe("PROCESSED");
    expect(first.body.idempotentReplay).toBe(false);

    // Simula falha após o COMMIT: não enviamos DeleteMessage.
    // Tornamos a mensagem visível novamente para testar a reentrega.
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: firstMessage!.ReceiptHandle!,
        VisibilityTimeout: 0,
      }),
    );

    const secondReceive = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 5,
        VisibilityTimeout: 30,
      }),
    );

    const secondMessage = secondReceive.Messages?.[0];
    expect(secondMessage).toBeDefined();

    const secondEnvelope = JSON.parse(secondMessage!.Body!);

    const replay = await service.submit(
      secondEnvelope.data,
      secondEnvelope.data.idempotencyKey,
      {
        consumerName,
        messageId: secondEnvelope.messageId,
        payloadHash,
      },
    );

    expect(replay.body.status).toBe("PROCESSED");
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);

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

    const inbox = await pool.query(
      `SELECT message_id, processed_at
       FROM inbox_messages
       WHERE consumer_name = $1 AND message_id = $2`,
      [consumerName, messageId],
    );

    expect(String(wallet.rows[0].balance)).toBe("90.00");
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].direction).toBe("DEBIT");
    expect(String(ledger.rows[0].amount)).toBe("10.00");
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0].processed_at).not.toBeNull();

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: secondMessage!.ReceiptHandle!,
      }),
    );
  }, 30000);
});
