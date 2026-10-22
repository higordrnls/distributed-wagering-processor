import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { databasePoolProvider } from "./database.provider";
import { WalletController } from "./wallet.controller";
import { WalletService } from "./wallet.service";
import { WagerTransactionController } from "./wager-transaction.controller";
import { WagerTransactionService } from "./wager-transaction.service";

@Module({
  controllers: [HealthController, WalletController, WagerTransactionController],
  providers: [databasePoolProvider, WalletService, WagerTransactionService],
})
export class AppModule {}
