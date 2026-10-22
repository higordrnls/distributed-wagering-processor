import { Pool } from "pg";
import { WagerTransactionService } from "../../api/wager-transaction.service";
import { WagerTransactionConsumer } from "../wager-transaction-consumer";

const [queueUrl] = process.argv.slice(2);

if (!queueUrl) {
  throw new Error("Informe a URL da fila");
}

process.env.SQS_INPUT_QUEUE_URL = queueUrl;

const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5433),
  user: process.env.DB_USER ?? "wager",
  password: process.env.DB_PASSWORD ?? "wager",
  database: "wager_test",
});

const service = new WagerTransactionService(pool);
const originalSubmit = service.submit.bind(service);

let releaseProcessing!: () => void;

const processingGate = new Promise<void>((resolve) => {
  releaseProcessing = resolve;
});

service.submit = (async (...args: Parameters<typeof service.submit>) => {
  console.log("PROCESSING_STARTED");
  await processingGate;
  return originalSubmit(...args);
}) as typeof service.submit;

const consumer = new WagerTransactionConsumer(service);

// Mantém o processo ativo durante o teste de sinais.
const keepAlive = setInterval(() => {}, 1000);

let shuttingDown = false;

process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("SIGTERM_RECEIVED");

  void (async () => {
    await consumer.onModuleDestroy();
    await pool.end();
    clearInterval(keepAlive);
    console.log("SHUTDOWN_COMPLETE");
    process.exit(0);
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
});

process.on("SIGUSR1", () => {
  releaseProcessing();
});

consumer.onModuleInit();
console.log("WORKER_READY");
