import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from "@nestjs/common";
import { WalletService } from "./wallet.service";

@Controller("wallets")
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

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
