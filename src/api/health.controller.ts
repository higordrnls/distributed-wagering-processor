import {
  Controller,
  Get,
  Inject,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  GetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Pool } from "pg";
import { DATABASE_POOL } from "./database.provider";

@Controller("health")
export class HealthController implements OnModuleDestroy {
  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
    requestHandler: undefined,
    maxAttempts: 1,
  });

  private readonly inputQueueUrl =
    process.env.SQS_INPUT_QUEUE_URL ??
    "http://localhost:4566/000000000000/wager-transactions.fifo";

  private readonly eventsQueueUrl =
    process.env.SQS_EVENTS_QUEUE_URL ??
    "http://localhost:4566/000000000000/wager-events.fifo";

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    let database: "connected" | "unavailable" = "unavailable";
    let sqs: "connected" | "unavailable" = "unavailable";

    try {
      await this.pool.query("SELECT 1");
      database = "connected";
    } catch {
      // Readiness reports the dependency failure below.
    }

    try {
      await Promise.all([
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.inputQueueUrl,
            AttributeNames: ["QueueArn"],
          }),
          { abortSignal: AbortSignal.timeout(2000) },
        ),
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.eventsQueueUrl,
            AttributeNames: ["QueueArn"],
          }),
          { abortSignal: AbortSignal.timeout(2000) },
        ),
      ]);

      sqs = "connected";
    } catch {
      // Readiness reports the dependency failure below.
    }

    if (database !== "connected" || sqs !== "connected") {
      throw new ServiceUnavailableException({
        status: "error",
        database,
        sqs,
      });
    }

    return { status: "ok", database, sqs };
  }

  onModuleDestroy() {
    this.sqs.destroy();
  }
}
