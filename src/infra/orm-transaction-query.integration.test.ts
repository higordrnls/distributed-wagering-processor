import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createTestOrm } from "./test-db";
import { OrmTransactionQuery } from "./orm-transaction-query";
import { WalletEntity } from "./entities/wallet.entity";

let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  await orm?.close(true);
});

describe("OrmTransactionQuery — PostgreSQL", () => {
  test("executa SQL dentro da transação e respeita rollback", async () => {
    const id = randomUUID();

    await expect(
      orm.em.fork().transactional(async (em) => {
        const db = new OrmTransactionQuery(em);

        const result = await db.query(
          `INSERT INTO wallets (
            id, player_id, currency, balance,
            version, created_at, updated_at
          ) VALUES ($1, $2, 'BRL', '100.00', 1, NOW(), NOW())
          RETURNING id`,
          [id, randomUUID()],
        );

        expect(result.rowCount).toBe(1);
        expect(result.rows[0].id).toBe(id);

        throw new Error("ROLLBACK_TEST");
      }),
    ).rejects.toThrow("ROLLBACK_TEST");

    const wallet = await orm.em.fork().findOne(
      WalletEntity,
      { id },
    );

    expect(wallet).toBeNull();
  });

  test("informa linhas afetadas por UPDATE sem RETURNING", async () => {
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
      const db = new OrmTransactionQuery(em);

      const result = await db.query(
        "UPDATE wallets SET balance = $1 WHERE id = $2",
        ["90.00", id],
      );

      expect(result.rowCount).toBe(1);
    });

    const wallet = await orm.em.fork().findOneOrFail(
      WalletEntity,
      { id },
    );

    expect(wallet.balance).toBe("90.00");
  });

  test("rejeita consultas fora de uma transação", async () => {
    const db = new OrmTransactionQuery(orm.em.fork());

    await expect(
      db.query("SELECT 1"),
    ).rejects.toThrow("Consulta financeira fora de transação");
  });
});
