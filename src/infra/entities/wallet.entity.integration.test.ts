import { describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { ormOptions } from "../orm-config";
import { WalletEntity } from "./wallet.entity";

describe("WalletEntity — MikroORM", () => {
  test("consulta a tabela wallets usando o mapeamento", async () => {
    const orm = await MikroORM.init(ormOptions("wager_test"));

    try {
      const em = orm.em.fork();

      const wallets = await em.find(WalletEntity, {}, { limit: 1 });

      expect(Array.isArray(wallets)).toBe(true);
    } finally {
      await orm.close(true);
    }
  });
});
