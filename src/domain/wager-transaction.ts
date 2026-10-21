import { InvalidTransactionError, InvalidTransactionStateError } from "./errors";
import type { FailureCode } from "./failure-code";
import { LedgerDirection } from "./ledger-entry";
import { Money } from "./money";

export enum WagerTransactionKind {
  Opening = "OPENING", // interno
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED", // terminal
  Rejected = "REJECTED", // terminal
  Failed = "FAILED", // terminal
}

/**
 * Transições válidas:
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
 *   PROCESSED / REJECTED / FAILED -> nenhuma (terminais)
 */
export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor, não o id interno */
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  "status" | "referenceTransactionId" | "failureCode" | "processedAt"
>;

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência e o valor. */
  static create(p: CreateWagerTransactionProps): WagerTransaction {
    if (p.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError("OPENING é interno e não pode ser submetido");
    }
    const needsRef = p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback;
    if (needsRef && !p.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${p.kind} exige referenceExternalTransactionId`);
    }
    const zeroAllowed = p.kind === WagerTransactionKind.Loss && p.money.isZero();
    if (!p.money.isPositive() && !zeroAllowed) {
      throw new InvalidTransactionError("O valor deve ser positivo (apenas LOSS aceita zero)");
    }
    return WagerTransaction.build({ ...p, status: WagerTransactionStatus.Pending });
  }

  /** Reconstrução a partir do banco: não revalida. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return WagerTransaction.build(s);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal("PROCESSED");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal("PENDING_REFERENCE");
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal("REJECTED");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal("FAILED");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direção do lançamento. Para ROLLBACK é o inverso da direção da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionError("ROLLBACK precisa da referência para a direção");
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError("LOSS não movimenta saldo");
    }
  }

  private assertNotTerminal(target: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Transação ${this.id} está ${this._status}; não pode ir para ${target}`);
    }
  }

  private static build(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id, s.providerId, s.externalTransactionId, s.idempotencyKey, s.payloadHash,
      s.walletId, s.playerId, s.roundId, s.gameId, s.kind, s.money,
      s.referenceExternalTransactionId, s.createdAt,
      s.status, s.referenceTransactionId, s.failureCode, s.processedAt,
    );
  }
}
