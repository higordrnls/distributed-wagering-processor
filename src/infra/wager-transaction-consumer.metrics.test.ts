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

    const output = await metrics.render();
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

    const output = await metrics.render();
    expect(output).toContain("wager_sqs_retries_total 1");
    expect(output).toContain("wager_sqs_dlq_candidates_total 0");

    await consumer.onModuleDestroy();
  });
});
