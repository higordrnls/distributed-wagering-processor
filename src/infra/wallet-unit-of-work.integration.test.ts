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

describe("MikroORM — Identity Map e Unit of Work", () => {
  test("mantém identidade e persiste alterações da carteira", async () => {
    const id = randomUUID();

    await orm.em.fork().insert(WalletEntity, {
      id,
      playerId: randomUUID(),
      currency: "BRL",
      balance: "100.00",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await orm.em.fork().transactional(async (em) => {
      const first = await em.findOneOrFail(
        WalletEntity,
        { id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      const second = await em.findOneOrFail(
        WalletEntity,
        { id },
      );

      // Identity Map: mesma entidade, mesma instância.
      expect(first).toBe(second);

      first.balance = "90.00";
      first.version += 1;
      first.updatedAt = new Date();

      // Unit of Work: detecta e persiste as alterações.
      await em.flush();
    });

    const persisted = await orm.em.fork().findOneOrFail(
      WalletEntity,
      { id },
    );

    expect(persisted.balance).toBe("90.00");
    expect(persisted.version).toBe(2);
  });
});
