import {
  Body,
  Controller,
  Headers,
  Get,
  Param,
  Post,
  Res,
} from "@nestjs/common";

import { WagerTransactionService } from "./wager-transaction.service";

@Controller("wagering/transactions")
export class WagerTransactionController {
  constructor(
    private readonly wagerTransactionService: WagerTransactionService,
  ) {}

  @Get(":transactionId")
  findById(@Param("transactionId") transactionId: string) {
    return this.wagerTransactionService.findById(transactionId);
  }

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Res({ passthrough: true })
    response: { status: (code: number) => unknown },
  ) {
    const result = await this.wagerTransactionService.submit(
      body,
      idempotencyKey,
      undefined,
      correlationId?.trim() || undefined,
    );

    response.status(result.httpStatus);
    return result.body;
  }
}
