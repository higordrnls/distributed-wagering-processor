import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from "@nestjs/common";
import {
  GetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private refreshInProgress = false;
  private stopping = false;
  private activeRefresh?: Promise<void>;

  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
    maxAttempts: 1,
  });

  private readonly dlqUrl =
    process.env.SQS_DLQ_QUEUE_URL ??
    "http://localhost:4566/000000000000/wager-transactions-dlq.fifo";

  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "New wagering transactions by final status",
    labelNames: ["status"] as const,
    registers: [this.registry],
  });

  readonly replays = new Counter({
    name: "wager_idempotent_replays_total",
    help: "Idempotent transaction replays",
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: "wager_processing_duration_seconds",
    help: "Wager processing duration in seconds",
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  readonly sqsRetries = new Counter({
    name: "wager_sqs_retries_total",
    help: "SQS transient retries",
    registers: [this.registry],
  });

  readonly dlqCandidates = new Counter({
    name: "wager_sqs_dlq_candidates_total",
    help: "Messages classified for SQS DLQ redrive",
    registers: [this.registry],
  });

  readonly dlqMessages = new Gauge({
    name: "wager_sqs_dlq_messages",
    help: "Approximate number of messages in the SQS dead-letter queue",
    registers: [this.registry],
  });

  readonly dlqCollectionSuccess = new Gauge({
    name: "wager_sqs_dlq_collection_success",
    help: "Whether the latest SQS DLQ metrics collection succeeded (1=yes, 0=no)",
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: "wager_lock_conflicts_total",
    help: "PostgreSQL concurrency errors detected during wager processing",
    labelNames: ["code"] as const,
    registers: [this.registry],
  });

  readonly reconciliationMismatches = new Counter({
    name: "wager_reconciliation_mismatches_total",
    help: "Detected wallet reconciliation mismatches",
    registers: [this.registry],
  });

  readonly outboxLag = new Gauge({
    name: "wager_outbox_lag_seconds",
    help: "Age in seconds of the oldest unpublished outbox event",
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  onModuleInit(): void {
    const intervalMs = Number(
      process.env.SQS_DLQ_POLL_INTERVAL_MS ?? 15000,
    );

    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
      throw new Error("SQS_DLQ_POLL_INTERVAL_MS deve ser um inteiro >= 1000");
    }

    this.startRefresh();
    this.timer = setInterval(() => this.startRefresh(), intervalMs);
  }

  private startRefresh(): void {
    if (this.stopping || this.refreshInProgress) return;

    this.refreshInProgress = true;
    this.activeRefresh = this.refreshDlqMessages().finally(() => {
      this.refreshInProgress = false;
    });
  }

  async refreshDlqMessages(): Promise<void> {
    try {
      const response = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.dlqUrl,
          AttributeNames: [
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
          ],
        }),
        { abortSignal: AbortSignal.timeout(2000) },
      );

      const attributes = response.Attributes ?? {};
      const visible = Number(attributes.ApproximateNumberOfMessages);
      const notVisible = Number(
        attributes.ApproximateNumberOfMessagesNotVisible,
      );

      if (
        !Number.isSafeInteger(visible) ||
        !Number.isSafeInteger(notVisible) ||
        visible < 0 ||
        notVisible < 0
      ) {
        throw new Error("Atributos da DLQ ausentes ou inválidos");
      }

      this.dlqMessages.set(visible + notVisible);
      this.dlqCollectionSuccess.set(1);
    } catch (error) {
      this.dlqCollectionSuccess.set(0);
      this.logger.warn(
        `Falha ao coletar métricas da DLQ: ${String(error)}`,
      );
    }
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    if (this.timer) clearInterval(this.timer);

    try {
      await this.activeRefresh;
    } finally {
      this.sqs.destroy();
    }
  }
}
