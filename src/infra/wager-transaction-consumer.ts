import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { WagerTransactionService } from "../api/wager-transaction.service";
import { canonicalJson } from "../domain/payload-hash";
import { classifySqsError } from "./sqs-error-classifier";
import { MetricsService } from "../api/metrics.service";
import { Optional } from "@nestjs/common";

type WagerEnvelope = {
  messageId: string;
  correlationId?: string;
  type: "WagerTransactionRequested";
  data: Record<string, unknown> & { idempotencyKey: string };
};

@Injectable()
export class WagerTransactionConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });

  private readonly queueUrl =
    process.env.SQS_INPUT_QUEUE_URL ??
    "http://localhost:4566/000000000000/wager-transactions.fifo";

  private stopping = false;
  private loop?: Promise<void>;

  constructor(
    private readonly service: WagerTransactionService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit() {
    this.loop = this.poll();
  }

  async onModuleDestroy() {
    this.stopping = true;

    try {
      await this.loop;
    } finally {
      this.sqs.destroy();
    }
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 5,
            VisibilityTimeout: 30,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
        );

        for (const message of response.Messages ?? []) {
          if (this.stopping) {
            if (message.ReceiptHandle) {
              await this.sqs.send(
                new ChangeMessageVisibilityCommand({
                  QueueUrl: this.queueUrl,
                  ReceiptHandle: message.ReceiptHandle,
                  VisibilityTimeout: 0,
                }),
              );
            }
            continue;
          }

          await this.handle(message);
        }
      } catch (error) {
        this.logger.error("Falha no polling SQS", error);
        await Bun.sleep(1000);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) return;

    // Renova a visibilidade enquanto a operação estiver em andamento.
    // Evita redelivery concorrente durante processamentos demorados.
    let renewalInFlight: Promise<void> | undefined;

    const renewVisibility = () => {
      if (renewalInFlight) return;

      renewalInFlight = this.sqs
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle!,
            VisibilityTimeout: 30,
          }),
        )
        .then(() => {})
        .catch((error: unknown) => {
          this.logger.error("Falha ao renovar visibilidade SQS", error);
        })
        .finally(() => {
          renewalInFlight = undefined;
        });
    };

    const renewalTimer = setInterval(renewVisibility, 10000);

    const stopRenewal = async (): Promise<void> => {
      clearInterval(renewalTimer);
      await renewalInFlight;
    };

    try {
      const parsed: unknown = JSON.parse(message.Body);

      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new BadRequestException("Envelope SQS inválido");
      }

      const envelope = parsed as Partial<WagerEnvelope>;

      if (
        envelope.type !== "WagerTransactionRequested" ||
        typeof envelope.messageId !== "string" ||
        !envelope.messageId.trim() ||
        !envelope.data ||
        typeof envelope.data !== "object" ||
        Array.isArray(envelope.data) ||
        typeof envelope.data.idempotencyKey !== "string" ||
        !envelope.data.idempotencyKey.trim()
      ) {
        throw new BadRequestException("Mensagem SQS inválida");
      }

      const payloadHash = createHash("sha256")
        .update(canonicalJson(envelope))
        .digest("hex");

      const result = await this.service.submit(
        envelope.data,
        envelope.data.idempotencyKey,
        {
          consumerName: "wager-transaction-consumer-v1",
          messageId: envelope.messageId,
          payloadHash,
        },
        typeof envelope.correlationId === "string" &&
        envelope.correlationId.trim()
          ? envelope.correlationId.trim()
          : envelope.messageId,
      );

      await stopRenewal();
      await this.ack(message);
      this.logger.log({
        event: "sqs_message_processed",
        messageId: envelope.messageId,
        correlationId:
          typeof envelope.correlationId === "string" &&
          envelope.correlationId.trim()
            ? envelope.correlationId.trim()
            : envelope.messageId,
        transactionId: result.body.transactionId,
        providerId: envelope.data.providerId,
        walletId: envelope.data.walletId,
        status: result.body.status,
        idempotentReplay: result.body.idempotentReplay,
      });
    } catch (error) {
      await stopRenewal();
      const disposition = classifySqsError(error);

      if (disposition === "ACK") {
        this.logger.warn({
          event: "sqs_business_conflict",
          sqsMessageId: message.MessageId,
          disposition: "ACK",
        });
        await this.ack(message);
        return;
      }

      if (disposition === "DLQ") {
        this.metrics?.dlqCandidates.inc();
        this.logger.warn({
          event: "sqs_permanent_failure",
          sqsMessageId: message.MessageId,
          disposition: "DLQ",
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        return;
      }

      const receiveCount = Number(
        message.Attributes?.ApproximateReceiveCount ?? "1",
      );

      const backoffSeconds = Math.min(
        120,
        5 * 2 ** Math.max(0, receiveCount - 1),
      );

      this.metrics?.sqsRetries.inc();

      this.logger.error({
        event: "sqs_retry_scheduled",
        sqsMessageId: message.MessageId,
        disposition: "RETRY",
        receiveCount,
        backoffSeconds,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });

      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle!,
          VisibilityTimeout: backoffSeconds,
        }),
      );
    } finally {
      await stopRenewal();
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle!,
      }),
    );
  }
}
