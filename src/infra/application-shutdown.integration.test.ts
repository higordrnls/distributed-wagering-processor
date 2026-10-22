import { describe, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../api/app.module";
import { DATABASE_POOL } from "../api/database.provider";
import type { Pool } from "pg";

describe("Encerramento da aplicação NestJS", () => {
  test("libera o pool PostgreSQL após encerrar os workers", async () => {
    const app = await NestFactory.create(AppModule, {
      logger: false,
    });

    const pool = app.get<Pool>(DATABASE_POOL);

    await app.init();
    await pool.query("SELECT 1");

    await app.close();

    expect(pool.ended).toBe(true);
    await expect(pool.query("SELECT 1")).rejects.toThrow();
  }, 30000);
});
