import { afterEach, describe, expect, test } from "bun:test";
import { WagerTransactionConsumer } from "./wager-transaction-consumer";
import { MetricsService } from "../api/metrics.service";
import { WagerTransactionService } from "../api/wager-transaction.service";
import { BadRequestException } from "@nestjs/common";
import { ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";

const originalEndpoint = process.env.SQS_ENDPOINT;

afterEach(() => {
  if (originalEndpoint === undefined) {
    delete process.env.SQS_ENDPOINT;
  } else {
    process.env.SQS_ENDPOINT = originalEndpoint;
  }
});


describe("Logs do consumer SQS", () => {
  test("registra processamento bem-sucedido com correlação", async () => {
    process.env.SQS_ENDPOINT = "http://127.0.0.1:4599";

    const service = {
      submit: async () => ({
        httpStatus: 200,
        body: {
          transactionId: "transaction-success",
          status: "PROCESSED",
          idempotentReplay: false,
        },
      }),
    } as unknown as WagerTransactionService;

    const consumer = new WagerTransactionConsumer(service);
    const events: unknown[] = [];

    (consumer as any).logger = {
      log: (value: unknown) => events.push(value),
      warn: (value: unknown) => events.push(value),
      error: (value: unknown) => events.push(value),
    };

    (consumer as any).ack = async () => {};

    await (consumer as any).handle({
      MessageId: "sqs-success",
      ReceiptHandle: "receipt-success",
      Body: JSON.stringify({
        messageId: "event-success",
        correlationId: "correlation-success",
        type: "WagerTransactionRequested",
        data: { idempotencyKey: "key-success" },
      }),
    });

    expect(events).toContainEqual({
      event: "sqs_message_processed",
      messageId: "event-success",
      correlationId: "correlation-success",
      transactionId: "transaction-success",
      status: "PROCESSED",
      idempotentReplay: false,
    });

    await consumer.onModuleDestroy();
  });

  test("registra conflito de negócio e confirma ACK", async () => {
    process.env.SQS_ENDPOINT = "http://127.0.0.1:4599";

    const { ConflictException } = await import("@nestjs/common");

    const service = {
      submit: async () => {
        throw new ConflictException("Conflito de idempotência");
      },
    } as unknown as WagerTransactionService;

    const consumer = new WagerTransactionConsumer(service);
    const events: unknown[] = [];
    let acknowledged = false;

    (consumer as any).logger = {
      log: (value: unknown) => events.push(value),
      warn: (value: unknown) => events.push(value),
      error: (value: unknown) => events.push(value),
    };

    (consumer as any).ack = async () => {
      acknowledged = true;
    };

    await (consumer as any).handle({
      MessageId: "sqs-conflict",
      ReceiptHandle: "receipt-conflict",
      Body: JSON.stringify({
        messageId: "event-conflict",
        type: "WagerTransactionRequested",
        data: { idempotencyKey: "key-conflict" },
      }),
    });

    expect(events).toContainEqual({
      event: "sqs_business_conflict",
      sqsMessageId: "sqs-conflict",
      disposition: "ACK",
    });
    expect(acknowledged).toBe(true);

    await consumer.onModuleDestroy();
  });

  test("registra falha permanente com evento e identificador", async () => {
    process.env.SQS_ENDPOINT = "http://127.0.0.1:4599";

    const service = {
      submit: async () => {
        throw new Error("Não deveria processar envelope inválido");
      },
    } as unknown as WagerTransactionService;

    const consumer = new WagerTransactionConsumer(service);
    const events: unknown[] = [];

    (consumer as any).logger = {
      log: (value: unknown) => events.push(value),
      warn: (value: unknown) => events.push(value),
      error: (value: unknown) => events.push(value),
    };

    await (consumer as any).handle({
      MessageId: "invalid-log-message",
      ReceiptHandle: "receipt-invalid",
      Body: JSON.stringify({ invalid: true }),
    });

    expect(events).toContainEqual({
      event: "sqs_permanent_failure",
      sqsMessageId: "invalid-log-message",
      disposition: "DLQ",
      errorName: "BadRequestException",
    });

    await consumer.onModuleDestroy();
  });

  test("registra retry com contagem e backoff", async () => {
    process.env.SQS_ENDPOINT = "http://127.0.0.1:4599";

    const service = {
      submit: async () => {
        throw new Error("ECONNREFUSED");
      },
    } as unknown as WagerTransactionService;

    const consumer = new WagerTransactionConsumer(service);
    const events: unknown[] = [];

    (consumer as any).logger = {
      log: (value: unknown) => events.push(value),
      warn: (value: unknown) => events.push(value),
      error: (value: unknown) => events.push(value),
    };

    try {
      await (consumer as any).handle({
        MessageId: "retry-log-message",
        ReceiptHandle: "receipt-retry",
        Body: JSON.stringify({
          messageId: "retry-1",
          type: "WagerTransactionRequested",
          data: { idempotencyKey: "retry-key" },
        }),
        Attributes: { ApproximateReceiveCount: "2" },
      });
    } catch {
      // O endpoint SQS intencionalmente indisponível falha após registrar o evento.
    }

    expect(events).toContainEqual({
      event: "sqs_retry_scheduled",
      sqsMessageId: "retry-log-message",
      disposition: "RETRY",
      receiveCount: 2,
      backoffSeconds: 10,
      errorName: "Error",
    });

    await consumer.onModuleDestroy();
  });
});

describe("Métricas do consumer SQS", () => {
  test("registra candidatos a DLQ para mensagens inválidas", async () => {
    process.env.SQS_ENDPOINT = "http://127.0.0.1:4599";

    const metrics = new MetricsService();
    const service = {
      submit: async () => {
        throw new Error("Não deveria processar envelope inválido");
      },
    } as unknown as WagerTransactionService;

    const consumer = new WagerTransactionConsumer(service, metrics);

    const message = {
      MessageId: "invalid-message",
      ReceiptHandle: "receipt-invalid",
      Body: JSON.stringify({ invalid: true }),
    };

    await (consumer as any).handle(message);

    const output = await metrics.registry.metrics();
    expect(output).toContain("wager_sqs_dlq_candidates_total 1");
    expect(output).toContain("wager_sqs_retries_total 0");

    await consumer.onModuleDestroy();
  });

  test("registra retries para erros transitórios", async () => {
    process.env.SQS_ENDPOINT = "http://127.0.0.1:4599";

    const metrics = new MetricsService();
    const service = {
      submit: async () => {
        throw new Error("ECONNREFUSED");
      },
    } as unknown as WagerTransactionService;

    const consumer = new WagerTransactionConsumer(service, metrics);

    const message = {
      MessageId: "transient-message",
      ReceiptHandle: "receipt-transient",
      Body: JSON.stringify({
        messageId: "message-1",
        type: "WagerTransactionRequested",
        data: { idempotencyKey: "key-1" },
      }),
      Attributes: { ApproximateReceiveCount: "1" },
    };

    try {
      await (consumer as any).handle(message);
    } catch {
      // A chamada ao SQS de teste deve falhar; o contador é incrementado antes dela.
    }

    const output = await metrics.registry.metrics();
    expect(output).toContain("wager_sqs_retries_total 1");
    expect(output).toContain("wager_sqs_dlq_candidates_total 0");

    await consumer.onModuleDestroy();
  });
});
