export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(props: IntegrationEventProps<Record<string, unknown>>) {
    return new WagerTransactionProcessed(props);
  }
}

export class WagerTransactionRejected extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(props: IntegrationEventProps<Record<string, unknown>>) {
    return new WagerTransactionRejected(props);
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(props: IntegrationEventProps<Record<string, unknown>>) {
    return new WagerTransactionPendingReference(props);
  }
}

export class WalletBalanceChanged extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(props: IntegrationEventProps<Record<string, unknown>>) {
    return new WalletBalanceChanged(props);
  }
}
