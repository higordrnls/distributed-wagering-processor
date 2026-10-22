import { createHash } from "node:crypto";
import { Pool } from "pg";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { WagerTransactionService } from "../../api/wager-transaction.service";
import { canonicalJson } from "../../domain/payload-hash";

const [mode, queueUrl] = process.argv.slice(2);

if ((mode !== "crash" && mode !== "recover") || !queueUrl) {
  console.error("Uso: bun run sqs-crash.worker.ts <crash|recover> <queueUrl>");
  process.exit(2);
}

const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5433),
  user: process.env.DB_USER ?? "wager",
  password: process.env.DB_PASSWORD ?? "wager",
  database: "wager_test",
});

const sqs = new SQSClient({
  region: "us-east-1",
  endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
  credentials: {
    accessKeyId: "test",
    secretAccessKey: "test",
  },
});

try {
  const received = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
      VisibilityTimeout: 2,
    }),
  );

  const message = received.Messages?.[0];

  if (!message?.Body || !message.ReceiptHandle) {
    throw new Error("Nenhuma mensagem recebida");
  }

  const envelope = JSON.parse(message.Body);

  const payloadHash = createHash("sha256")
    .update(canonicalJson(envelope))
    .digest("hex");

  const service = new WagerTransactionService(pool);

  const result = await service.submit(
    envelope.data,
    envelope.data.idempotencyKey,
    {
      consumerName: "wager-transaction-consumer-v1",
      messageId: envelope.messageId,
      payloadHash,
    },
  );

  if (result.body.status !== "PROCESSED") {
    throw new Error(`Status inesperado: ${result.body.status}`);
  }

  if (mode === "crash") {
    if (result.body.idempotentReplay) {
      throw new Error("Primeira execução não deveria ser replay");
    }

    console.log(JSON.stringify({
      mode,
      status: result.body.status,
      transactionId: result.body.transactionId,
      committed: true,
      acknowledged: false,
    }));

    // Encerra o processo imediatamente, sem ACK e sem shutdown gracioso.
    process.exit(42);
  }

  if (result.body.idempotentReplay !== true) {
    throw new Error("Recuperação deveria ser replay idempotente");
  }

  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    }),
  );

  console.log(JSON.stringify({
    mode,
    status: result.body.status,
    transactionId: result.body.transactionId,
    idempotentReplay: result.body.idempotentReplay,
    acknowledged: true,
  }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (mode !== "crash") {
    await pool.end();
    sqs.destroy();
  }
}
