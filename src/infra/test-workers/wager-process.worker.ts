import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ProcessWagerTransaction } from "../../application/process-wager-transaction";
import { Money } from "../../domain/money";
import { computePayloadHash } from "../../domain/payload-hash";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../domain/wager-transaction";

const [walletId, playerId, amount, externalId] = process.argv.slice(2);

if (!walletId || !playerId || !amount || !externalId) {
  console.error("Argumentos obrigatórios ausentes");
  process.exit(2);
}

const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5433),
  user: process.env.DB_USER ?? "wager",
  password: process.env.DB_PASSWORD ?? "wager",
  database: "wager_test",
  max: 2,
});

try {
  const money = Money.from({ amount, currency: "BRL" });

  const fields = {
    providerId: "multiprocess-test",
    externalTransactionId: externalId,
    playerId,
    walletId,
    roundId: "multiprocess-round",
    gameId: "multiprocess-game",
    kind: WagerTransactionKind.Bet,
    money,
    referenceExternalTransactionId: undefined,
  };

  const transaction = WagerTransaction.create({
    id: randomUUID(),
    ...fields,
    idempotencyKey: `multiprocess:${externalId}`,
    payloadHash: computePayloadHash(fields),
    createdAt: new Date(),
  });

  const processor = new ProcessWagerTransaction(pool);
  const result = await processor.execute(transaction);

  console.log(JSON.stringify({
    status: result.status,
    transactionId: result.transactionId,
    idempotentReplay: result.idempotentReplay,
  }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
