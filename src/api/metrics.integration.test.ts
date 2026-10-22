import { afterAll, describe, expect, test } from "bun:test";
import { MetricsService } from "./metrics.service";

describe("Métricas da DLQ — integração SQS", () => {
  const instances: MetricsService[] = [];

  afterAll(async () => {
    for (const instance of instances) {
      await instance.onModuleDestroy();
    }
  });

  function createMetrics(queueUrl?: string): MetricsService {
    const original = process.env.SQS_DLQ_QUEUE_URL;

    if (queueUrl) {
      process.env.SQS_DLQ_QUEUE_URL = queueUrl;
    }

    try {
      const metrics = new MetricsService();
      instances.push(metrics);
      return metrics;
    } finally {
      if (original === undefined) {
        delete process.env.SQS_DLQ_QUEUE_URL;
      } else {
        process.env.SQS_DLQ_QUEUE_URL = original;
      }
    }
  }

  function readGauge(output: string, name: string): number {
    const match = output.match(
      new RegExp(`^${name}\\s+(\\d+)$`, "m"),
    );

    if (!match) {
      throw new Error(`Métrica ausente ou inválida: ${name}`);
    }

    return Number(match[1]);
  }

  test("consulta a DLQ real e publica uma quantidade válida", async () => {
    const metrics = createMetrics();

    await metrics.refreshDlqMessages();

    const output = await metrics.render();

    expect(
      Number.isSafeInteger(readGauge(output, "wager_sqs_dlq_messages")),
    ).toBe(true);

    expect(readGauge(output, "wager_sqs_dlq_collection_success")).toBe(1);
  });

  test("preserva o último valor válido e se recupera após falha", async () => {
    const metrics = createMetrics();

    // Estabelece uma coleta bem-sucedida com a DLQ real.
    await metrics.refreshDlqMessages();

    const successfulOutput = await metrics.render();
    const previousCount = readGauge(
      successfulOutput,
      "wager_sqs_dlq_messages",
    );

    expect(
      readGauge(successfulOutput, "wager_sqs_dlq_collection_success"),
    ).toBe(1);

    // Simula uma indisponibilidade usando uma fila inexistente.
    const sqs = (metrics as unknown as {
      sqs: { send: (...args: any[]) => Promise<any> };
    }).sqs;

    const originalSend = sqs.send.bind(sqs);

    sqs.send = async () => {
      throw new Error("Falha SQS simulada");
    };

    try {
      await metrics.refreshDlqMessages();

      const failedOutput = await metrics.render();

      expect(
        readGauge(failedOutput, "wager_sqs_dlq_messages"),
      ).toBe(previousCount);

      expect(
        readGauge(failedOutput, "wager_sqs_dlq_collection_success"),
      ).toBe(0);
    } finally {
      sqs.send = originalSend;
    }

    // O SQS voltou: a coleta deve atualizar o valor e o estado.
    await metrics.refreshDlqMessages();

    const recoveredOutput = await metrics.render();

    expect(
      readGauge(recoveredOutput, "wager_sqs_dlq_collection_success"),
    ).toBe(1);

    expect(
      readGauge(recoveredOutput, "wager_sqs_dlq_messages"),
    ).toBe(previousCount);
  });

  test("mantém /metrics disponível quando a DLQ não existe", async () => {
    const metrics = createMetrics(
      "http://localhost:4566/000000000000/fila-inexistente.fifo",
    );

    await metrics.refreshDlqMessages();

    const output = await metrics.render();

    expect(output).toContain("wager_sqs_dlq_messages ");
    expect(readGauge(output, "wager_sqs_dlq_collection_success")).toBe(0);
  });
});
