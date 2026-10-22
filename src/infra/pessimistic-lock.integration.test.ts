import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LockMode } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createTestOrm } from "./test-db";
import { WalletEntity } from "./entities/wallet.entity";

let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  await orm?.close(true);
});

describe("MikroORM — bloqueio pessimista", () => {
  test("serializa duas transações na mesma carteira", async () => {
    const walletId = randomUUID();

    await orm.em.fork().insert(WalletEntity, {
      id: walletId,
      playerId: randomUUID(),
      currency: "BRL",
      balance: "100.00",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let releaseFirst!: () => void;
    let signalLocked!: () => void;

    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstLocked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    let secondAcquired = false;

    const first = orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(
        WalletEntity,
        { id: walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      signalLocked();
      await holdFirst;
    });

    await firstLocked;

    const second = orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(
        WalletEntity,
        { id: walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      secondAcquired = true;
    });

    try {
      // Confirma que a segunda transação não passou pelo bloqueio.
      await Bun.sleep(100);
      expect(secondAcquired).toBe(false);
    } finally {
      releaseFirst();
    }

    await Promise.all([first, second]);

    expect(secondAcquired).toBe(true);
  });
});
