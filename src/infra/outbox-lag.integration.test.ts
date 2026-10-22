import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createTestOrm } from "./test-db";
import { MetricsService } from "../api/metrics.service";
import { OutboxPublisher } from "./outbox-publisher";

let pool: Pool;

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
});

afterAll(async () => {
  await pool?.end();
});

describe("Outbox — métrica de lag", () => {
  test("mede a idade do evento pendente mesmo durante o backoff", async () => {
    const id = randomUUID();
    const metrics = new MetricsService();
    const publisher = new OutboxPublisher(pool, metrics);

    try {
      await pool.query(
        `INSERT INTO outbox_messages (
          id, aggregate_id, event_type, payload,
          occurred_at, attempts, next_attempt_at
        ) VALUES (
          $1::uuid, $1::uuid::text, 'OutboxLagTestEvent',
          $2::jsonb, NOW() - INTERVAL '10 minutes',
          1, NOW() + INTERVAL '1 hour'
        )`,
        [id, JSON.stringify({ outboxLagTestId: id })],
      );

      const internalPublisher = publisher as unknown as {
        updateOutboxLag: () => Promise<void>;
      };

      await internalPublisher.updateOutboxLag();

      const output = await metrics.render();
      const match = output.match(
        /^wager_outbox_lag_seconds\s+([0-9.eE+-]+)$/m,
      );

      expect(match).not.toBeNull();

      const lagSeconds = Number(match![1]);

      expect(lagSeconds).toBeGreaterThanOrEqual(600);
      expect(lagSeconds).toBeLessThan(620);
    } finally {
      await pool.query(
        "UPDATE outbox_messages SET published_at = NOW(), next_attempt_at = NULL WHERE id = $1",
        [id],
      );

      await publisher.onModuleDestroy();
    }
  });
});
