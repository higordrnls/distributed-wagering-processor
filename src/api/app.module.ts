import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { databasePoolProvider } from "./database.provider";
import { WalletController } from "./wallet.controller";
import { WalletService } from "./wallet.service";

@Module({
  controllers: [HealthController, WalletController],
  providers: [databasePoolProvider, WalletService],
})
export class AppModule {}
