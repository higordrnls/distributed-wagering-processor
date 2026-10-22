import { Migrator } from "@mikro-orm/migrations";
import { migrationsList } from "./migrations";
import { walletSchema } from "./entities/wallet.entity";
import { wagerTransactionSchema } from "./entities/wager-transaction.entity";
import { ledgerEntrySchema } from "./entities/ledger-entry.entity";

export function ormOptions(dbName: string = process.env.DB_NAME ?? "wager") {
  return {
    dbName,
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "wager",
    password: process.env.DB_PASSWORD ?? "wager",
    entities: [walletSchema, wagerTransactionSchema, ledgerEntrySchema],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: { migrationsList },
  };
}
