import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import { WalletService } from "./wallet.service";

@Controller("wallets")
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

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
