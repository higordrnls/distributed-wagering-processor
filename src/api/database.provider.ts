import { Pool } from "pg";

export const DATABASE_POOL = "DATABASE_POOL";

export const databasePoolProvider = {
  provide: DATABASE_POOL,
  useFactory: () =>
    new Pool({
      host: process.env.DB_HOST ?? "localhost",
      port: Number(process.env.DB_PORT ?? 5433),
      user: process.env.DB_USER ?? "wager",
      password: process.env.DB_PASSWORD ?? "wager",
      database: process.env.DB_NAME ?? "wager",
    }),
};
