import { afterAll, describe, expect, test } from "bun:test";
import { OrmProvider } from "./orm.provider";
import { MikroORM } from "@mikro-orm/postgresql";
import { ormOptions } from "../infra/orm-config";

const originalInit = MikroORM.init;
let initCalls = 0;

describe("OrmProvider — inicialização concorrente", () => {
  test("compartilha a mesma Promise e inicializa uma única vez", async () => {
    const provider = new OrmProvider();

    // Substituímos a inicialização real para testar apenas a concorrência.
    const fakeOrm = { close: async () => {} } as unknown as MikroORM;

    MikroORM.init = (async () => {
      initCalls++;
      await Promise.resolve();
      return fakeOrm;
    }) as typeof MikroORM.init;

    try {
      const [first, second, third] = await Promise.all([
        provider.getOrm(),
        provider.getOrm(),
        provider.getOrm(),
      ]);

      expect(initCalls).toBe(1);
      expect(first).toBe(fakeOrm);
      expect(second).toBe(fakeOrm);
      expect(third).toBe(fakeOrm);

      await provider.onModuleDestroy();
    } finally {
      MikroORM.init = originalInit;
    }
  });
});
