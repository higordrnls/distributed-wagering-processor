import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import { DomainError } from "../domain/errors";
import { computePayloadHash } from "../domain/payload-hash";
import { Money } from "../domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../domain/wager-transaction";
import { DATABASE_POOL } from "./database.provider";

@Injectable()
export class WagerTransactionService {
  private readonly processor: ProcessWagerTransaction;

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {
    this.processor = new ProcessWagerTransaction(pool);
  }

  async submit(input: unknown, idempotencyKey?: string) {
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "O header Idempotency-Key é obrigatório",
      });
    }

    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new BadRequestException("O corpo deve ser um objeto JSON");
    }

    const body = input as Record<string, unknown>;
    const requiredStrings = [
      "providerId",
      "externalTransactionId",
      "playerId",
      "walletId",
      "roundId",
      "gameId",
    ];

    for (const field of requiredStrings) {
      if (typeof body[field] !== "string" || !(body[field] as string).trim()) {
        throw new BadRequestException(`Campo ${field} inválido`);
      }
    }

    if (
      !body.money ||
      typeof body.money !== "object" ||
      Array.isArray(body.money)
    ) {
      throw new BadRequestException("Campo money inválido");
    }

    const moneyInput = body.money as Record<string, unknown>;
    if (
      typeof moneyInput.amount !== "string" ||
      typeof moneyInput.currency !== "string"
    ) {
      throw new BadRequestException("Valor ou moeda inválidos");
    }

    if (
      typeof body.kind !== "string" ||
      !Object.values(WagerTransactionKind).includes(
        body.kind as WagerTransactionKind,
      ) ||
      body.kind === WagerTransactionKind.Opening
    ) {
      throw new BadRequestException("Tipo de transação inválido");
    }

    if (
      body.referenceExternalTransactionId !== undefined &&
      (typeof body.referenceExternalTransactionId !== "string" ||
        !body.referenceExternalTransactionId.trim())
    ) {
      throw new BadRequestException(
        "referenceExternalTransactionId inválido",
      );
    }

    const key = idempotencyKey.trim();
    const kind = body.kind as WagerTransactionKind;
    let money: Money;

    try {
      money = Money.from({
        amount: moneyInput.amount,
        currency: moneyInput.currency,
      });
    } catch (error) {
      if (error instanceof DomainError) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }

    const fields = {
      providerId: body.providerId as string,
      externalTransactionId: body.externalTransactionId as string,
      playerId: body.playerId as string,
      walletId: body.walletId as string,
      roundId: body.roundId as string,
      gameId: body.gameId as string,
      kind,
      money,
      referenceExternalTransactionId:
        body.referenceExternalTransactionId as string | undefined,
    };

    let transaction: WagerTransaction;

    try {
      transaction = WagerTransaction.create({
        id: randomUUID(),
        ...fields,
        idempotencyKey: key,
        payloadHash: computePayloadHash(fields),
        createdAt: new Date(),
      });
    } catch (error) {
      if (error instanceof DomainError) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }

    const result = await this.processor.execute(transaction);

    if (result.conflict) {
      throw new ConflictException({
        code: "IDEMPOTENCY_CONFLICT",
        message:
          "A chave de idempotência ou a transação externa já foi usada com outro payload",
      });
    }

    let balance = result.observedBalance;
    if (balance === undefined) {
      const walletResult = await this.pool.query(
        "SELECT balance FROM wallets WHERE id = $1",
        [transaction.walletId],
      );
      balance = walletResult.rows[0]
        ? String(walletResult.rows[0].balance)
        : undefined;
    }

    const response = {
      transactionId: result.transactionId,
      status: result.status,
      ...(balance !== undefined
        ? { balance: { amount: balance, currency: money.currency } }
        : {}),
      idempotentReplay: result.idempotentReplay,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    };

    const httpStatus =
      result.status === "PENDING_REFERENCE"
        ? 202
        : result.status === "REJECTED"
          ? 422
          : result.status === "FAILED"
            ? 503
            : 200;

    return { httpStatus, body: response };
  }
}
