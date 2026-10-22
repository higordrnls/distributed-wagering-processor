import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

let sqs: SQSClient;
let inputUrl: string;
let dlqUrl: string;

beforeAll(async () => {
  sqs = new SQSClient({
    region: "us-east-1",
    endpoint: "http://localhost:4566",
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  });

  const suffix = randomUUID();

  const dlq = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-dlq-test-${suffix}.fifo`,
      Attributes: { FifoQueue: "true" },
    }),
  );

  if (!dlq.QueueUrl) throw new Error("DLQ de teste não criada");
  dlqUrl = dlq.QueueUrl;

  const input = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-input-test-${suffix}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }),
  );

  if (!input.QueueUrl) throw new Error("Fila de entrada não criada");
  inputUrl = input.QueueUrl;

  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ["QueueArn"],
    }),
  );

  const dlqArn = attributes.Attributes?.QueueArn;
  if (!dlqArn) throw new Error("ARN da DLQ não encontrado");

  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: inputUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: "3",
        }),
      },
    }),
  );
});

afterAll(async () => {
  try {
    if (inputUrl) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: inputUrl }));
    }
    if (dlqUrl) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    }
  } finally {
    sqs?.destroy();
  }
});

describe("SQS real — redrive para DLQ", () => {
  test("move mensagem não confirmada para DLQ após tentativas esgotadas", async () => {
    const messageId = randomUUID();
    const body = JSON.stringify({
      messageId,
      type: "InvalidWagerMessage",
      data: { reason: "invalid-envelope" },
    });

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: inputUrl,
        MessageBody: body,
        MessageGroupId: messageId,
        MessageDeduplicationId: messageId,
      }),
    );

    const receivedCounts: number[] = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: inputUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
          VisibilityTimeout: 0,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );

      const message = response.Messages?.[0];
      expect(message).toBeDefined();
      expect(message?.Body).toBe(body);

      receivedCounts.push(
        Number(message?.Attributes?.ApproximateReceiveCount),
      );
    }

    expect(receivedCounts).toEqual([1, 2, 3]);

    let deadLetterBody: string | undefined;

    for (let attempt = 0; attempt < 10; attempt++) {
      // A consulta adicional pode disparar o redrive no emulador.
      await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: inputUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 0,
        }),
      );

      const dlq = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );

      if (dlq.Messages?.[0]?.Body) {
        deadLetterBody = dlq.Messages[0].Body;
        break;
      }
    }

    expect(deadLetterBody).toBe(body);
  }, 30000);
});
