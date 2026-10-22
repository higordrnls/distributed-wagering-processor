import { Controller, Get, Param } from "@nestjs/common";
import { WagerTransactionService } from "./wager-transaction.service";
import { ProviderIdentityPort } from "./provider-identity.port";

@Controller("providers/:providerId/wagering/transactions")
export class ProviderTransactionController {
  constructor(
    private readonly wagerTransactionService: WagerTransactionService,
    private readonly providerIdentity: ProviderIdentityPort,
  ) {}

  @Get(":externalTransactionId")
  async findByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    await this.providerIdentity.assertProviderAccess(providerId);
    return this.wagerTransactionService.findByExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
