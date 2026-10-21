import { InsufficientFundsError } from "./errors";
import { FailureCode } from "./failure-code";
import { LedgerDirection, WalletLedgerEntry } from "./ledger-entry";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";
import { Wallet } from "./wallet";

export interface ProcessWagerInput {
  transaction: WagerTransaction; // PENDING ou PENDING_REFERENCE
  wallet: Wallet; // já carregada e travada pelo use case
  reference?: WagerTransaction; // resolvida por (providerId, referenceExternalTransactionId)
  referenceAlreadyReversed: boolean; // já existe reversão PROCESSED desta referência
  entryId: string;
  now: Date;
}

export interface ProcessWagerResult {
  entry?: WalletLedgerEntry; // ausente em LOSS, REJECTED e PENDING_REFERENCE
}

type RefCheck = { type: "ok" } | { type: "pending" } | { type: "reject"; code: FailureCode };

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

function checkReference(tx: WagerTransaction, ref: WagerTransaction | undefined, reversed: boolean): RefCheck {
  const reject = (code: FailureCode): RefCheck => ({ type: "reject", code });
  if (!ref || !ref.isTerminal()) return { type: "pending" };
  if (ref.status !== WagerTransactionStatus.Processed) return reject(FailureCode.ReferenceNotProcessed);
  if (!ALLOWED_REFERENCE_KINDS[tx.kind]?.includes(ref.kind)) return reject(FailureCode.InvalidReferenceKind);
  if (
    ref.providerId !== tx.providerId || ref.playerId !== tx.playerId || ref.walletId !== tx.walletId ||
    ref.money.currency !== tx.money.currency || ref.roundId !== tx.roundId
  ) {
    return reject(FailureCode.ReferenceMismatch);
  }
  if (tx.requiresReference()) {
    if (!tx.money.equals(ref.money)) return reject(FailureCode.AmountMismatch);
    if (reversed) return reject(FailureCode.AlreadyReversed);
  }
  return { type: "ok" };
}

/** Aplica as regras de negócio: muda a transação e a wallet de forma coerente. */
export function processWager(input: ProcessWagerInput): ProcessWagerResult {
  const { transaction: tx, wallet, reference, now } = input;
  const reject = (code: FailureCode): ProcessWagerResult => {
    tx.reject(code);
    return {};
  };

  if (tx.walletId !== wallet.id || tx.playerId !== wallet.playerId) {
    return reject(FailureCode.WalletPlayerMismatch);
  }
  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

  let referenceTransactionId: string | undefined;
  const hasReference =
    tx.requiresReference() || (tx.kind === WagerTransactionKind.Win && tx.referenceExternalTransactionId !== undefined);
  if (hasReference) {
    const check = checkReference(tx, reference, input.referenceAlreadyReversed);
    if (check.type === "pending") {
      tx.markPendingReference();
      return {};
    }
    if (check.type === "reject") return reject(check.code);
    referenceTransactionId = reference!.id;
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(referenceTransactionId, now); // LOSS: processada, sem lançamento
    return {};
  }

  const direction = tx.ledgerDirectionFor(reference);
  const ctx = { entryId: input.entryId, transactionId: tx.id, now };
  try {
    const entry = direction === LedgerDirection.Debit ? wallet.debit(tx.money, ctx) : wallet.credit(tx.money, ctx);
    tx.markProcessed(referenceTransactionId, now);
    return { entry };
  } catch (e) {
    if (e instanceof InsufficientFundsError) {
      return reject(
        tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds,
      );
    }
    throw e;
  }
}
