import {
  Injectable,
  Inject,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import {
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { Pool } from "pg";
import { DATABASE_POOL } from "../api/database.provider";
import { Optional } from "@nestjs/common";
import { MetricsService } from "../api/metrics.service";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from "../domain/integration-event";

type OutboxRow = {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
};

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly sqs: SQSClient;
  private readonly queueUrl =
    process.env.SQS_EVENTS_QUEUE_URL ??
    "http://localhost:4566/000000000000/wager-events.fifo";

  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopping = false;
  private activeCycle?: Promise<void>;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.sqs = new SQSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });
  }

  onModuleInit() {
    this.startCycle();

    this.timer = setInterval(() => {
      this.startCycle();
    }, Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 5000));
  }

  async onModuleDestroy() {
    this.stopping = true;

    if (this.timer) {
      clearInterval(this.timer);
    }

    await this.activeCycle;
    this.sqs.destroy();
  }

  private startCycle(): void {
    if (this.stopping || this.running) return;
    this.running = true;
    this.activeCycle = this.publishPending();
  }

  private async publishPending(): Promise<void> {
    try {
      const client = await this.pool.connect();
      let messages: OutboxRow[] = [];

      try {
        await client.query("BEGIN");

        const result = await client.query<OutboxRow>(`
          WITH available AS (
            SELECT id
            FROM outbox_messages
            WHERE published_at IS NULL
              AND (
                next_attempt_at IS NULL
                OR next_attempt_at <= NOW()
              )
            ORDER BY occurred_at
            LIMIT 20
            FOR UPDATE SKIP LOCKED
          )
          UPDATE outbox_messages AS o
          SET attempts = o.attempts + 1,
              next_attempt_at = NOW() + INTERVAL '30 seconds'
          FROM available
          WHERE o.id = available.id
          RETURNING o.id, o.aggregate_id, o.event_type,
                    o.payload, o.occurred_at, o.attempts
        `);

        messages = result.rows;

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      for (const message of messages) {
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: this.queueUrl,
              MessageBody: JSON.stringify(
                this.serializeEvent(message),
              ),
              MessageGroupId: message.aggregate_id,
              MessageDeduplicationId: message.id,
            }),
          );

          await this.pool.query(
            `UPDATE outbox_messages
             SET published_at = NOW(), next_attempt_at = NULL
             WHERE id = $1 AND published_at IS NULL`,
            [message.id],
          );

          this.logger.log(`Evento ${message.id} publicado no SQS`);
        } catch (error) {
          const attempts = message.attempts + 1;
          const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));

          try {
            await this.pool.query(
              `UPDATE outbox_messages
               SET next_attempt_at = NOW() + ($2 * INTERVAL '1 second')
               WHERE id = $1 AND published_at IS NULL`,
              [message.id, delaySeconds],
            );
          } catch (databaseError) {
            this.logger.error(
              `Falha ao reagendar evento ${message.id}: ${String(databaseError)}`,
            );
          }

          this.logger.error(
            `Falha ao publicar evento ${message.id}: ${String(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Falha no ciclo da outbox: ${String(error)}`);
    } finally {
      this.running = false;
      await this.updateOutboxLag();
    }
  }

  private serializeEvent(message: OutboxRow): Record<string, unknown> {
    const props = {
      eventId: message.id,
      aggregateId: message.aggregate_id,
      correlationId: message.aggregate_id,
      occurredAt: message.occurred_at,
      data: message.payload as Record<string, unknown>,
    };

    switch (message.event_type) {
      case "WagerTransactionProcessed":
        return WagerTransactionProcessed.from(props).toJSON();
      case "WagerTransactionRejected":
        return WagerTransactionRejected.from(props).toJSON();
      case "WagerTransactionPendingReference":
        return WagerTransactionPendingReference.from(props).toJSON();
      case "WalletBalanceChanged":
        return WalletBalanceChanged.from(props).toJSON();
      default:
        return {
          ...props,
          eventType: message.event_type,
          occurredAt: message.occurred_at.toISOString(),
          version: 1,
        };
    }
  }

  private async updateOutboxLag(): Promise<void> {
    try {
      const result = await this.pool.query<{ lag_seconds: number | string }>(`
        SELECT COALESCE(
          EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))),
          0
        ) AS lag_seconds
        FROM outbox_messages
        WHERE published_at IS NULL
      `);

      this.metrics?.outboxLag.set(Number(result.rows[0]?.lag_seconds ?? 0));
    } catch (error) {
      this.logger.error(
        `Falha ao atualizar outbox lag: ${String(error)}`,
      );
    }
  }
}
