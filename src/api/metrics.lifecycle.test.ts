import { afterEach, describe, expect, test, spyOn, mock } from "bun:test";
import { MetricsService } from "./metrics.service";

describe("MetricsService — ciclo de vida", () => {
  const originalInterval = process.env.SQS_DLQ_POLL_INTERVAL_MS;

  afterEach(() => {
    if (originalInterval === undefined) {
      delete process.env.SQS_DLQ_POLL_INTERVAL_MS;
    } else {
      process.env.SQS_DLQ_POLL_INTERVAL_MS = originalInterval;
    }

    mock.restore();
  });

  test("rejeita intervalo inválido antes de iniciar a coleta", () => {
    process.env.SQS_DLQ_POLL_INTERVAL_MS = "500";

    const metrics = new MetricsService();
    const refresh = spyOn(metrics, "refreshDlqMessages");

    expect(() => metrics.onModuleInit()).toThrow(
      "SQS_DLQ_POLL_INTERVAL_MS deve ser um inteiro >= 1000",
    );

    expect(refresh).not.toHaveBeenCalled();
    metrics.onModuleDestroy();
  });

  test("encerra o cliente SQS mesmo se a coleta ativa falhar", async () => {
    const metrics = new MetricsService();

    const sqs = (metrics as unknown as {
      sqs: { destroy: () => void };
    }).sqs;

    const destroy = spyOn(sqs, "destroy");
    const activeRefresh = Promise.reject(new Error("falha inesperada"));

    Object.defineProperty(metrics, "activeRefresh", {
      configurable: true,
      value: activeRefresh,
    });

    await expect(metrics.onModuleDestroy()).rejects.toThrow(
      "falha inesperada",
    );

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("aguarda a coleta ativa antes de fechar o cliente SQS", async () => {
    const metrics = new MetricsService();

    let finishRefresh!: () => void;
    const activeRefresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });

    const sqs = (metrics as unknown as {
      sqs: { destroy: () => void };
    }).sqs;

    const destroy = spyOn(sqs, "destroy");

    Object.defineProperty(metrics, "activeRefresh", {
      configurable: true,
      value: activeRefresh,
    });

    let shutdownFinished = false;
    const shutdown = metrics.onModuleDestroy().then(() => {
      shutdownFinished = true;
    });

    await Promise.resolve();

    expect(shutdownFinished).toBe(false);
    expect(destroy).not.toHaveBeenCalled();

    finishRefresh();
    await shutdown;

    expect(shutdownFinished).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("não inicia nova coleta após o início do encerramento", async () => {
    const metrics = new MetricsService();

    await metrics.onModuleDestroy();

    const refresh = spyOn(metrics, "refreshDlqMessages");

    const internal = metrics as unknown as {
      startRefresh: () => void;
    };

    internal.startRefresh();

    expect(refresh).not.toHaveBeenCalled();
  });
});
