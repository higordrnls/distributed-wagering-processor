import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createTestOrm } from "../test-db";
import { InboxMessageEntity } from "./inbox-message.entity";
import { OutboxMessageEntity } from "./outbox-message.entity";

let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  await orm?.close(true);
});

describe("Inbox e Outbox — MikroORM", () => {
  test("persiste e consulta Inbox com chave primária composta", async () => {
    const em = orm.em.fork();
    const consumerName = `consumer-${randomUUID()}`;
    const messageId = randomUUID();

    em.persist(
      em.create(InboxMessageEntity, {
        consumerName,
        messageId,
        payloadHash: "hash-teste",
        receivedAt: new Date(),
      }),
    );

    await em.flush();
    em.clear();

    const saved = await em.findOneOrFail(InboxMessageEntity, {
      consumerName,
      messageId,
    });

    expect(saved.payloadHash).toBe("hash-teste");
    expect(saved.processedAt).toBeNull();
  });

  test("persiste e consulta Outbox com payload JSONB", async () => {
    const em = orm.em.fork();
    const id = randomUUID();
    const payload = {
      transactionId: randomUUID(),
      balance: { amount: "125.50", currency: "BRL" },
    };

    em.persist(
      em.create(OutboxMessageEntity, {
        id,
        aggregateId: randomUUID(),
        eventType: "WagerTransactionProcessed",
        payload,
        occurredAt: new Date(),
        attempts: 0,
        correlationId: `correlation-${randomUUID()}`,
      }),
    );

    await em.flush();
    em.clear();

    const saved = await em.findOneOrFail(OutboxMessageEntity, { id });

    expect(saved.payload).toEqual(payload);
    expect(saved.attempts).toBe(0);
    expect(saved.publishedAt).toBeNull();
    expect(saved.correlationId).toStartWith("correlation-");
  });
});
