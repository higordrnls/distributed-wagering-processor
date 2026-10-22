import {
  Body,
  Controller,
  Headers,
  Post,
  Res,
} from "@nestjs/common";

import { WagerTransactionService } from "./wager-transaction.service";

@Controller("wagering/transactions")
export class WagerTransactionController {
  constructor(
    private readonly wagerTransactionService: WagerTransactionService,
  ) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true })
    response: { status: (code: number) => unknown },
  ) {
    const result = await this.wagerTransactionService.submit(
      body,
      idempotencyKey,
    );

    response.status(result.httpStatus);
    return result.body;
  }
}
