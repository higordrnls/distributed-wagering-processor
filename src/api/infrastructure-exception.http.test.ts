import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Controller,
  Get,
  HttpException,
  Module,
} from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { InfrastructureExceptionFilter } from "./infrastructure-exception.filter";

@Controller("test-errors")
class TestErrorsController {
  @Get("database")
  database() {
    throw Object.assign(new Error("Database unavailable"), {
      code: "08006",
    });
  }

  @Get("business")
  business() {
    throw new HttpException(
      { code: "IDEMPOTENCY_CONFLICT", message: "Conflito" },
      409,
    );
  }

  @Get("unknown")
  unknown() {
    throw new Error("Internal secret");
  }
}

@Module({
  controllers: [TestErrorsController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: InfrastructureExceptionFilter,
    },
  ],
})
class TestAppModule {}

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await NestFactory.create(TestAppModule, { logger: false });
  await app.listen(0, "127.0.0.1");

  const address = app.getHttpServer().address();
  if (!address || typeof address === "string") {
    throw new Error("Endereço HTTP inválido");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
});

describe("InfrastructureExceptionFilter — HTTP real", () => {
  test("falha PostgreSQL retorna HTTP 503", async () => {
    const response = await fetch(`${baseUrl}/test-errors/database`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "INFRASTRUCTURE_UNAVAILABLE",
      message: "Serviço temporariamente indisponível",
    });
  });

  test("preserva HTTP 409", async () => {
    const response = await fetch(`${baseUrl}/test-errors/business`);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "IDEMPOTENCY_CONFLICT",
      message: "Conflito",
    });
  });

  test("erro desconhecido retorna HTTP 500 sem expor detalhes", async () => {
    const response = await fetch(`${baseUrl}/test-errors/unknown`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "INTERNAL_ERROR",
      message: "Erro interno do servidor",
    });
  });
});
