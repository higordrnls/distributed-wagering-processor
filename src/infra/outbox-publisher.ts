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

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {
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
          SELECT id, aggregate_id, event_type, payload,
                 occurred_at, attempts
          FROM outbox_messages
          WHERE published_at IS NULL
            AND (
              next_attempt_at IS NULL
              OR next_attempt_at <= NOW()
            )
          ORDER BY occurred_at
          LIMIT 20
          FOR UPDATE SKIP LOCKED
        `);

        messages = result.rows;

        for (const message of messages) {
          await client.query(
            `UPDATE outbox_messages
             SET attempts = attempts + 1,
                 next_attempt_at = NOW() + INTERVAL '30 seconds'
             WHERE id = $1`,
            [message.id],
          );
        }

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
              MessageBody: JSON.stringify({
                eventId: message.id,
                eventType: message.event_type,
                aggregateId: message.aggregate_id,
                correlationId: message.aggregate_id,
                occurredAt: message.occurred_at,
                data: message.payload,
              }),
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
    }
  }
}
