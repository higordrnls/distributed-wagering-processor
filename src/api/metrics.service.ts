import { Injectable } from "@nestjs/common";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

@Injectable()
export class MetricsService {
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

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
