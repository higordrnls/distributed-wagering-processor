import { Pool } from "pg";
import { OutboxPublisher } from "../outbox-publisher";

const database = process.env.TEST_DB_NAME;
const queueUrl = process.env.SQS_EVENTS_QUEUE_URL;

if (!database || !queueUrl) {
  throw new Error("TEST_DB_NAME e SQS_EVENTS_QUEUE_URL são obrigatórios");
}

const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5433),
  user: process.env.DB_USER ?? "wager",
  password: process.env.DB_PASSWORD ?? "wager",
  database,
  application_name: `outbox-concurrency-${process.pid}`,
});

const publisher = new OutboxPublisher(pool);

try {
  publisher.onModuleInit();

  // O encerramento aguarda a conclusão do ciclo iniciado.
  await publisher.onModuleDestroy();
} finally {
  await pool.end();
}
