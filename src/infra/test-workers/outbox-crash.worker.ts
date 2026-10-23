import { Pool } from "pg";
import { OutboxPublisher } from "../outbox-publisher";

const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5433),
  user: process.env.DB_USER ?? "wager",
  password: process.env.DB_PASSWORD ?? "wager",
  database: process.env.TEST_DB_NAME ?? "wager_test",
  application_name: "outbox-crash-worker",
});

const publisher = new OutboxPublisher(pool);

publisher.onModuleInit();

// O teste pai encerrará este processo abruptamente depois que
// o SQS aceitar a publicação e antes da confirmação no PostgreSQL.
await new Promise<void>(() => {});
