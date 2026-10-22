import { MikroORM } from "@mikro-orm/postgresql";
import { Client } from "pg";
import { ormOptions } from "./orm-config";

const TEST_DB = process.env.TEST_DB_NAME ?? "wager_test";

if (!/^[a-z][a-z0-9_]*$/.test(TEST_DB)) {
  throw new Error("Nome de banco de testes inválido");
}

async function ensureTestDatabase(): Promise<void> {
  const admin = new Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "wager",
    password: process.env.DB_PASSWORD ?? "wager",
    database: "postgres",
  });
  await admin.connect();
  const found = await admin.query("select 1 from pg_database where datname = $1", [TEST_DB]);
  if (found.rowCount === 0) await admin.query(`create database ${TEST_DB}`);
  await admin.end();
}

/** Cria o banco wager_test (se não existir), aplica as migrations e devolve o ORM. */
export async function createTestOrm() {
  await ensureTestDatabase();
  const orm = await MikroORM.init(ormOptions(TEST_DB));
  await orm.getMigrator().up();
  return orm;
}
