import { Controller, Get, Param } from "@nestjs/common";
import { WagerTransactionService } from "./wager-transaction.service";

@Controller("providers/:providerId/wagering/transactions")
export class ProviderTransactionController {
  constructor(
    private readonly wagerTransactionService: WagerTransactionService,
  ) {}

  @Get(":externalTransactionId")
  findByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.wagerTransactionService.findByExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
