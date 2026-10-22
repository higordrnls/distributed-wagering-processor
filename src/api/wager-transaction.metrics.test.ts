import { afterEach, describe, expect, test } from "bun:test";
import { MetricsService } from "./metrics.service";
import { WagerTransactionService } from "./wager-transaction.service";

const validInput = {
  providerId: "provider-test",
  externalTransactionId: "external-test-001",
  playerId: "player-test",
  walletId: "00000000-0000-4000-8000-000000000001",
  roundId: "round-test",
  gameId: "game-test",
  kind: "BET",
  money: { amount: "10.00", currency: "BRL" },
};

describe("Métricas de conflitos PostgreSQL", () => {
  const metricsInstances: MetricsService[] = [];

  afterEach(() => {
    for (const metrics of metricsInstances.splice(0)) {
      metrics.onModuleDestroy();
    }
  });

  for (const code of ["40P01", "55P03", "40001"]) {
    test(`contabiliza ${code} e propaga o erro original`, async () => {
      const metrics = new MetricsService();
      metricsInstances.push(metrics);

      const service = new WagerTransactionService(
        {} as never,
        metrics,
      );

      const originalError = Object.assign(
        new Error(`PostgreSQL error ${code}`),
        { code },
      );

      Object.defineProperty(service, "getProcessor", {
        configurable: true,
        value: async () => ({
          execute: async () => {
            throw originalError;
          },
        }),
      });

      await expect(
        service.submit(validInput, `key-${code}`),
      ).rejects.toBe(originalError);

      const output = await metrics.registry.metrics();
      expect(output).toContain(
        `wager_lock_conflicts_total{code="${code}"} 1`,
      );
    });
  }

  test("não contabiliza erros PostgreSQL que não são de concorrência", async () => {
    const metrics = new MetricsService();
    metricsInstances.push(metrics);

    const service = new WagerTransactionService(
      {} as never,
      metrics,
    );

    const originalError = Object.assign(
      new Error("Unique constraint violation"),
      { code: "23505" },
    );

    Object.defineProperty(service, "getProcessor", {
      configurable: true,
      value: async () => ({
        execute: async () => {
          throw originalError;
        },
      }),
    });

    await expect(
      service.submit(validInput, "key-23505"),
    ).rejects.toBe(originalError);

    const output = await metrics.registry.metrics();
    expect(output).not.toContain("wager_lock_conflicts_total{");
  });
});
