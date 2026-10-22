import { describe, expect, test } from "bun:test";
import { MetricsService } from "./metrics.service";

describe("MetricsService", () => {
  test("registra transações, replays e duração", async () => {
    const metrics = new MetricsService();

    metrics.transactions.inc({ status: "COMPLETED" });
    metrics.replays.inc();
    metrics.processingDuration.observe(0.125);

    const output = await metrics.render();

    expect(output).toContain(
      'wager_transactions_total{status="COMPLETED"} 1',
    );
    expect(output).toContain("wager_idempotent_replays_total 1");
    expect(output).toContain("wager_processing_duration_seconds_count 1");
    expect(output).toContain("wager_processing_duration_seconds_sum 0.125");
  });
});
