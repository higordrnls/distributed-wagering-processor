import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { WalletService } from "./wallet.service";

@Controller("wallets")
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get(":walletId/ledger")
  findLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.walletService.findLedger(walletId, { cursor, limit });
  }

  @Get(":walletId")
  findById(@Param("walletId") walletId: string) {
    return this.walletService.findById(walletId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body()
    body: {
      playerId: string;
      initialBalance: { amount: string; currency: string };
    },
  ) {
    return this.walletService.create(body);
  }
}
