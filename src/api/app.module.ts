import { MetricsService } from "./metrics.service";
import { ProviderIdentityPort, UnauthenticatedProviderIdentity } from "./provider-identity.port";
import { OrmProvider } from "./orm.provider";
import { MetricsController } from "./metrics.controller";
import { ProviderTransactionController } from "./provider-transaction.controller";
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { databasePoolProvider } from "./database.provider";
import { WalletController } from "./wallet.controller";
import { WalletService } from "./wallet.service";
import { WagerTransactionController } from "./wager-transaction.controller";
import { WagerTransactionService } from "./wager-transaction.service";
import { OutboxPublisher } from "../infra/outbox-publisher";
import { WagerTransactionConsumer } from "../infra/wager-transaction-consumer";
import { PendingReferenceReconciler } from "../infra/pending-reference-reconciler";

@Module({
  controllers: [MetricsController, HealthController, WalletController, WagerTransactionController, ProviderTransactionController],
  providers: [{ provide: ProviderIdentityPort, useClass: UnauthenticatedProviderIdentity }, OrmProvider, MetricsService, databasePoolProvider, WalletService, WagerTransactionService, OutboxPublisher, WagerTransactionConsumer, PendingReferenceReconciler],
})
export class AppModule {}
