import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { Pool } from "pg";
import { ProcessWagerTransaction } from "../src/application/process-wager-transaction";
import { Money } from "../src/domain/money";
import { computePayloadHash } from "../src/domain/payload-hash";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../src/domain/wager-transaction";

const operations = Math.max(1, Number(process.env.LOAD_OPERATIONS ?? 30));
const concurrency = Math.max(1, Number(process.env.LOAD_CONCURRENCY ?? 10));
const amount = process.env.LOAD_AMOUNT ?? "1.00";

function toCents(value: string): bigint {
  if (!/^(0|[1-9]\d*)\.\d{2}$/.test(value)) {
    throw new Error(`Valor monetário inválido: ${value}`);
  }
  return BigInt(value.replace(".", ""));
}

function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

const amountCents = toCents(amount);
const providerId = `load-test-${randomUUID()}`;

const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5433),
  user: process.env.DB_USER ?? "wager",
  password: process.env.DB_PASSWORD ?? "wager",
  database: "wager_test",
  max: Math.min(concurrency + 2, 20),
});

const processor = new ProcessWagerTransaction(pool);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1] ?? 0;
}

function makeBet(walletId: string, playerId: string, externalId: string) {
  const money = Money.from({ amount, currency: "BRL" });
  const fields = {
    providerId,
    externalTransactionId: externalId,
    playerId,
    walletId,
    roundId: "load-test-round",
    gameId: "load-test-game",
    kind: WagerTransactionKind.Bet,
    money,
    referenceExternalTransactionId: undefined,
  };

  return WagerTransaction.create({
    id: randomUUID(),
    ...fields,
    idempotencyKey: `load:${externalId}`,
    payloadHash: computePayloadHash(fields),
    createdAt: new Date(),
  });
}

async function createWallet(balance: string) {
  const walletId = randomUUID();
  const playerId = randomUUID();

  await pool.query(
    `INSERT INTO wallets (
      id, player_id, currency, balance, version, created_at, updated_at
    ) VALUES ($1, $2, 'BRL', $3, 1, NOW(), NOW())`,
    [walletId, playerId, balance],
  );

  return { walletId, playerId };
}

async function runScenario(
  name: string,
  requests: Array<() => Promise<any>>,
) {
  const latencies: number[] = [];
  let next = 0;
  let errors = 0;
  let processed = 0;
  let rejected = 0;
  let replays = 0;
  let conflicts = 0;
  let unexpected = 0;

  const started = performance.now();

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= requests.length) return;

      const requestStarted = performance.now();

      try {
        const result = await requests[index]();
        const elapsed = performance.now() - requestStarted;
        latencies.push(elapsed);

        const status = result?.status;
        if (status === "PROCESSED") processed++;
        else if (status === "REJECTED") rejected++;
        else unexpected++;

        if (result?.idempotentReplay === true) replays++;
        if (result?.conflict === true) conflicts++;
      } catch (error) {
        errors++;
        console.error(`[${name}]`, error);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, requests.length) },
      () => worker(),
    ),
  );

  const durationSeconds = (performance.now() - started) / 1000;

  const report = {
    scenario: name,
    requests: requests.length,
    durationSeconds: Number(durationSeconds.toFixed(3)),
    throughputRps: Number((requests.length / durationSeconds).toFixed(2)),
    processed,
    rejected,
    replays,
    conflicts,
    unexpected,
    errors,
    latencyMs: {
      p50: Number(percentile(latencies, 0.50).toFixed(2)),
      p95: Number(percentile(latencies, 0.95).toFixed(2)),
      p99: Number(percentile(latencies, 0.99).toFixed(2)),
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (errors > 0 || unexpected > 0 || conflicts > 0) {
    throw new Error(
      `Cenário "${name}" inválido: errors=${errors}, ` +
      `unexpected=${unexpected}, conflicts=${conflicts}`,
    );
  }

  return report;
}

async function assertWallet(walletId: string, initialBalance: string, expectedBalance: string) {
  const wallet = await pool.query(
    "SELECT balance FROM wallets WHERE id = $1",
    [walletId],
  );

  const ledger = await pool.query(
    `SELECT direction, amount, balance_before, balance_after
     FROM wallet_ledger_entries
     WHERE wallet_id = $1
     ORDER BY seq`,
    [walletId],
  );

  if (String(wallet.rows[0]?.balance) !== expectedBalance) {
    throw new Error(
      `Saldo inesperado na carteira ${walletId}: ` +
      `${wallet.rows[0]?.balance}; esperado ${expectedBalance}`,
    );
  }

  let reconstructed = toCents(initialBalance);

  for (const entry of ledger.rows) {
    if (reconstructed !== toCents(String(entry.balance_before))) {
      throw new Error(`Saldo anterior inconsistente no ledger da carteira ${walletId}`);
    }

    const value = toCents(String(entry.amount));
    reconstructed += entry.direction === "CREDIT" ? value : -value;

    if (reconstructed !== toCents(String(entry.balance_after))) {
      throw new Error(`Saldo posterior inconsistente no ledger da carteira ${walletId}`);
    }
  }

  if (reconstructed !== toCents(expectedBalance)) {
    throw new Error(`Saldo reconstruído diverge na carteira ${walletId}`);
  }
}

async function main() {
  console.log(JSON.stringify({
    event: "load_test_environment",
    bun: Bun.version,
    platform: process.platform,
    logicalCpus: cpus().length,
    totalMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(2)),
    operations,
    concurrency,
    amount,
    database: "wager_test",
    note: "Medição local; não representa capacidade de produção.",
  }, null, 2));

  // Cenário 1: todas as operações disputam a mesma carteira.
  const hot = await createWallet(
    fromCents(amountCents * BigInt(operations)),
  );

  const hotReport = await runScenario(
    "hot_wallet",
    Array.from({ length: operations }, (_, i) => () =>
      processor.execute(
        makeBet(hot.walletId, hot.playerId, `hot-${i}-${randomUUID()}`),
      ),
    ),
  );

  if (hotReport.processed !== operations || hotReport.replays !== 0) {
    throw new Error("Hot wallet: quantidade inesperada de processamentos/replays");
  }

  const hotRows = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM wager_transactions
        WHERE provider_id = $1 AND wallet_id = $2) AS transactions,
       (SELECT COUNT(*) FROM wallet_ledger_entries
        WHERE wallet_id = $2 AND direction = 'DEBIT') AS debits`,
    [providerId, hot.walletId],
  );

  if (
    Number(hotRows.rows[0].transactions) !== operations ||
    Number(hotRows.rows[0].debits) !== operations
  ) {
    throw new Error("Hot wallet: quantidade inesperada de transações ou débitos");
  }

  await assertWallet(
    hot.walletId,
    fromCents(amountCents * BigInt(operations)),
    "0.00",
  );

  // Cenário 2: cada operação utiliza uma carteira independente.
  const independent = await Promise.all(
    Array.from({ length: operations }, () =>
      createWallet(fromCents(amountCents * 2n)),
    ),
  );

  const independentReport = await runScenario(
    "independent_wallets",
    independent.map((wallet, i) => () =>
      processor.execute(
        makeBet(
          wallet.walletId,
          wallet.playerId,
          `independent-${i}-${randomUUID()}`,
        ),
      ),
    ),
  );

  if (independentReport.processed !== operations || independentReport.replays !== 0) {
    throw new Error("Carteiras independentes: resultado inesperado");
  }

  for (const wallet of independent) {
    const rows = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM wager_transactions
          WHERE provider_id = $1 AND wallet_id = $2) AS transactions,
         (SELECT COUNT(*) FROM wallet_ledger_entries
          WHERE wallet_id = $2 AND direction = 'DEBIT') AS debits`,
      [providerId, wallet.walletId],
    );

    if (Number(rows.rows[0].transactions) !== 1 || Number(rows.rows[0].debits) !== 1) {
      throw new Error(`Carteira independente ${wallet.walletId}: contagem inesperada`);
    }

    await assertWallet(
      wallet.walletId,
      fromCents(amountCents * 2n),
      fromCents(amountCents),
    );
  }

  // Cenário 3: todas as chamadas repetem a mesma aposta.
  const replayWallet = await createWallet("1000.00");
  const replayId = `replay-${randomUUID()}`;
  const replayReport = await runScenario(
    "idempotent_replays",
    Array.from({ length: operations }, () => () =>
      processor.execute(
        makeBet(replayWallet.walletId, replayWallet.playerId, replayId),
      ),
    ),
  );

  if (replayReport.processed !== operations || replayReport.replays !== operations - 1) {
    throw new Error(
      `Replays: esperado 1 processamento original e ${operations - 1} replays; ` +
      `obtido ${replayReport.processed} processados e ${replayReport.replays} replays`,
    );
  }

  const replayRows = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM wager_transactions
        WHERE provider_id = $1 AND external_transaction_id = $2) AS transactions,
       (SELECT COUNT(*) FROM wallet_ledger_entries
        WHERE wallet_id = $3 AND direction = 'DEBIT') AS debits`,
    [providerId, replayId, replayWallet.walletId],
  );

  if (Number(replayRows.rows[0].transactions) !== 1 || Number(replayRows.rows[0].debits) !== 1) {
    throw new Error("Replay idempotente duplicou transação ou débito");
  }

  await assertWallet(
    replayWallet.walletId,
    "1000.00",
    fromCents(100000n - amountCents),
  );

  console.log("Validação financeira concluída.");
}

try {
  await main();
} finally {
  await pool.end();
}
