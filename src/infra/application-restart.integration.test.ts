import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestOrm } from "./test-db";

type RunningApp = {
  process: ReturnType<typeof Bun.spawn>;
  baseUrl: string;
};

async function startApp(port: number): Promise<RunningApp> {
  const baseUrl = `http://127.0.0.1:${port}`;

  const childProcess = Bun.spawn(
    ["bun", "src/main.ts"],
    {
      cwd: Bun.env.PWD ?? ".",
      env: {
        ...Bun.env,
        PORT: String(port),
        DB_NAME: process.env.TEST_DB_NAME ?? "wager_test",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  for (let attempt = 0; attempt < 100; attempt++) {
    if (childProcess.exitCode !== null) {
      throw new Error(`Aplicação encerrou durante inicialização: ${childProcess.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(1000),
      });

      if (response.ok) {
        return { process: childProcess, baseUrl };
      }
    } catch {
      // Aguarda inicialização.
    }

    await Bun.sleep(200);
  }

  childProcess.kill();
  await childProcess.exited;
  throw new Error("Aplicação não ficou pronta em 20 segundos");
}

async function stopApp(app: RunningApp): Promise<void> {
  app.process.kill("SIGTERM");

  const result = await Promise.race([
    app.process.exited.then((code) => ({ code, timedOut: false })),
    Bun.sleep(15000).then(() => ({ code: -1, timedOut: true })),
  ]);

  if (result.timedOut) {
    app.process.kill("SIGKILL");
    await app.process.exited;
    throw new Error("Aplicação não encerrou em 15 segundos");
  }

  expect([0, 143]).toContain(result.code);

  // O processo precisa ter terminado e liberado a porta HTTP.
  // A segunda instância também deverá conseguir usar essa mesma porta.
  await expect(
    fetch(`${app.baseUrl}/health/live`, {
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow();
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  return {
    status: response.status,
    body: await response.json() as Record<string, any>,
  };
}

describe("Reinicialização real da aplicação", () => {
  test("preserva saldo, ledger e idempotência entre processos", async () => {
    const orm = await createTestOrm();
    await orm.close(true);

    const port = 31000 + Math.floor(Math.random() * 10000);
    const playerId = randomUUID();
    const externalTransactionId = randomUUID();
    const idempotencyKey = randomUUID();

    let app: RunningApp | undefined;

    try {
      app = await startApp(port);

      const created = await postJson(`${app.baseUrl}/wallets`, {
        playerId,
        initialBalance: {
          amount: "100.00",
          currency: "BRL",
        },
      });

      expect(created.status).toBe(201);
      const walletId = created.body.id as string;
      expect(walletId).toBeDefined();

      const wager = {
        providerId: `restart-${randomUUID()}`,
        externalTransactionId,
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: "restart-test",
        kind: "BET",
        money: {
          amount: "30.00",
          currency: "BRL",
        },
      };

      const first = await postJson(
        `${app.baseUrl}/wagering/transactions`,
        wager,
        { "Idempotency-Key": idempotencyKey },
      );

      expect(first.status).toBe(200);
      expect(first.body.status).toBe("PROCESSED");
      expect(first.body.balance).toEqual({
        amount: "70.00",
        currency: "BRL",
      });

      const transactionId = first.body.transactionId;

      await stopApp(app);
      app = undefined;

      app = await startApp(port);

      const walletResponse = await fetch(
        `${app.baseUrl}/wallets/${walletId}`,
      );
      expect(walletResponse.status).toBe(200);
      const wallet = await walletResponse.json() as Record<string, any>;
      expect(wallet.balance).toEqual({
        amount: "70.00",
        currency: "BRL",
      });

      const ledgerResponse = await fetch(
        `${app.baseUrl}/wallets/${walletId}/ledger`,
      );
      expect(ledgerResponse.status).toBe(200);
      const ledger = await ledgerResponse.json() as Record<string, any>;

      expect(ledger.entries).toHaveLength(2);
      expect(ledger.entries[1].direction).toBe("DEBIT");
      expect(ledger.entries[1].amount).toEqual({
        amount: "30.00",
        currency: "BRL",
      });
      expect(ledger.entries[1].balanceAfter).toEqual({
        amount: "70.00",
        currency: "BRL",
      });

      const transactionResponse = await fetch(
        `${app.baseUrl}/wagering/transactions/${transactionId}`,
      );
      expect(transactionResponse.status).toBe(200);
      const transaction = await transactionResponse.json() as Record<string, any>;
      expect(transaction.status).toBe("PROCESSED");

      const replay = await postJson(
        `${app.baseUrl}/wagering/transactions`,
        wager,
        { "Idempotency-Key": idempotencyKey },
      );

      expect(replay.status).toBe(200);
      expect(replay.body.idempotentReplay).toBe(true);
      expect(replay.body.transactionId).toBe(transactionId);

      const finalWalletResponse = await fetch(
        `${app.baseUrl}/wallets/${walletId}`,
      );
      const finalWallet = await finalWalletResponse.json() as Record<string, any>;
      expect(finalWallet.balance.amount).toBe("70.00");

      const finalLedgerResponse = await fetch(
        `${app.baseUrl}/wallets/${walletId}/ledger`,
      );
      const finalLedger = await finalLedgerResponse.json() as Record<string, any>;
      expect(finalLedger.entries).toHaveLength(2);
    } finally {
      if (app) {
        await stopApp(app);
      }
    }
  }, 90000);
});
