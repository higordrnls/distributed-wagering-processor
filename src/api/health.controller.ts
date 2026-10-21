import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Pool } from "pg";
import { DATABASE_POOL } from "./database.provider";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    try {
      await this.pool.query("SELECT 1");
      return { status: "ok", database: "connected" };
    } catch {
      throw new ServiceUnavailableException({
        status: "error",
        database: "unavailable",
      });
    }
  }
}
