import { describe, expect, test } from "bun:test";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import {
  InfrastructureExceptionFilter,
  isTransientInfrastructureError,
} from "./infrastructure-exception.filter";

function executeFilter(exception: unknown) {
  let statusCode = 0;
  let responseBody: unknown;

  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  new InfrastructureExceptionFilter().catch(exception, host);

  return { statusCode, responseBody };
}

describe("InfrastructureExceptionFilter", () => {
  for (const code of [
    "40001",
    "40P01",
    "55P03",
    "53300",
    "57P01",
    "08006",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
  ]) {
    test(`retorna 503 para falha transitória ${code}`, () => {
      const error = Object.assign(new Error("internal database detail"), {
        code,
      });

      expect(executeFilter(error)).toEqual({
        statusCode: 503,
        responseBody: {
          code: "INFRASTRUCTURE_UNAVAILABLE",
          message: "Serviço temporariamente indisponível",
        },
      });
    });
  }

  test("reconhece falha transitória dentro de cause", () => {
    const cause = Object.assign(new Error("connection lost"), {
      code: "ECONNRESET",
    });

    const error = new Error("Database operation failed", { cause });

    expect(isTransientInfrastructureError(error)).toBe(true);
    expect(executeFilter(error).statusCode).toBe(503);
  });

  test("preserva erros HTTP de validação e negócio", () => {
    for (const exception of [
      new BadRequestException({ code: "INVALID_PAYLOAD" }),
      new ConflictException({ code: "IDEMPOTENCY_CONFLICT" }),
      new NotFoundException("Carteira não encontrada"),
      new UnprocessableEntityException({ code: "INSUFFICIENT_FUNDS" }),
    ]) {
      expect(executeFilter(exception)).toEqual({
        statusCode: exception.getStatus(),
        responseBody: exception.getResponse(),
      });
    }
  });

  test("não transforma violação de unicidade em 503", () => {
    const error = Object.assign(new Error("unique violation"), {
      code: "23505",
    });

    expect(executeFilter(error)).toEqual({
      statusCode: 500,
      responseBody: {
        code: "INTERNAL_ERROR",
        message: "Erro interno do servidor",
      },
    });
  });

  test("não expõe detalhes de erros desconhecidos", () => {
    const result = executeFilter(
      new Error("sensitive database credentials"),
    );

    expect(result.statusCode).toBe(500);
    expect(JSON.stringify(result.responseBody)).not.toContain("credentials");
  });
});
