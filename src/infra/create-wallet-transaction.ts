import { MikroORM } from "@mikro-orm/postgresql";
import { Wallet } from "../domain/wallet";
import { WagerTransactionKind } from "../domain/wager-transaction";
import { createHash } from "node:crypto";
import { WalletEntity } from "./entities/wallet.entity";
import { WagerTransactionEntity } from "./entities/wager-transaction.entity";
import { LedgerEntryEntity } from "./entities/ledger-entry.entity";

export async function createWalletTransaction(
  orm: MikroORM,
  wallet: Wallet,
  openingEntry: ReturnType<typeof Wallet.open>["openingEntry"],
  openingTransactionId: string,
): Promise<void> {
  await orm.em.fork().transactional(async (em) => {
    const walletEntity = em.create(WalletEntity, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });

    em.persist(walletEntity);
    await em.flush();

    if (openingEntry) {
      const payloadHash = createHash("sha256")
        .update(JSON.stringify({
          walletId: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
        }))
        .digest("hex");

      em.persist(em.create(WagerTransactionEntity, {
        id: openingTransactionId,
        providerId: "internal",
        externalTransactionId: `opening:${wallet.id}`,
        idempotencyKey: `opening:${wallet.id}`,
        payloadHash,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "opening",
        gameId: "internal",
        kind: WagerTransactionKind.Opening,
        amount: wallet.balance.toString(),
        currency: wallet.currency,
        status: "PROCESSED",
        referenceAttempts: 0,
        createdAt: wallet.createdAt,
        processedAt: wallet.createdAt,
      }));

      // A transação de abertura precisa existir antes do ledger.
      await em.flush();

      em.persist(em.create(LedgerEntryEntity, {
        id: openingEntry.id,
        walletId: openingEntry.walletId,
        transactionId: openingEntry.transactionId,
        direction: openingEntry.direction,
        amount: openingEntry.money.toString(),
        currency: openingEntry.money.currency,
        balanceBefore: openingEntry.balanceBefore.toString(),
        balanceAfter: openingEntry.balanceAfter.toString(),
        createdAt: openingEntry.createdAt,
      }));
    }

    await em.flush();
  });
}
