import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { WagerTransactionConsumer } from "./wager-transaction-consumer";
import { WagerTransactionService } from "../api/wager-transaction.service";

const sqs = new SQSClient({
  region: "us-east-1",
  endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
  credentials: {
    accessKeyId: "test",
    secretAccessKey: "test",
  },
});

let queueUrl: string;
let originalQueueUrl: string | undefined;

beforeAll(async () => {
  originalQueueUrl = process.env.SQS_INPUT_QUEUE_URL;

  const result = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-visibility-${randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }),
  );

  if (!result.QueueUrl) throw new Error("Fila não criada");

  queueUrl = result.QueueUrl;
  process.env.SQS_INPUT_QUEUE_URL = queueUrl;
});

afterAll(async () => {
  if (originalQueueUrl === undefined) {
    delete process.env.SQS_INPUT_QUEUE_URL;
  } else {
    process.env.SQS_INPUT_QUEUE_URL = originalQueueUrl;
  }

  if (queueUrl) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  }

  sqs.destroy();
});

describe("SQS — renovação de visibilidade", () => {
  test("mensagem permanece invisível após 30 segundos de processamento", async () => {
    let releaseProcessing!: () => void;
    let signalStarted!: () => void;

    const processingStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    const processingGate = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });

    const service = {
      submit: async () => {
        signalStarted();
        await processingGate;

        return {
          body: {
            transactionId: randomUUID(),
            status: "PROCESSED",
            idempotentReplay: false,
          },
        };
      },
    } as unknown as WagerTransactionService;

    const consumer = new WagerTransactionConsumer(service);

    const messageId = randomUUID();

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          messageId,
          type: "WagerTransactionRequested",
          data: { idempotencyKey: `visibility:${messageId}` },
        }),
        MessageGroupId: messageId,
        MessageDeduplicationId: messageId,
      }),
    );

    consumer.onModuleInit();

    try {
      await Promise.race([
        processingStarted,
        Bun.sleep(10000).then(() => {
          throw new Error("Consumer não iniciou processamento");
        }),
      ]);

      // O timeout inicial é 30s; a renovação ocorre a cada 10s.
      await Bun.sleep(32000);

      const competingReceive = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );

      expect(competingReceive.Messages ?? []).toHaveLength(0);
    } finally {
      releaseProcessing();
      await consumer.onModuleDestroy();
    }
  }, 45000);
});
