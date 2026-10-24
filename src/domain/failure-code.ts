/**
 * Taxonomia de falhas. O que o provedor deve fazer:
 *  - reenviar depois / corrigir o payload / desistir.
 */
export enum FailureCode {
  /** BET sem saldo. Desistir desta aposta (ou reenviar com nova transação após depósito). */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** Crédito excederia o limite monetário da carteira. Desistir da operação. */
  BalanceLimitExceeded = "BALANCE_LIMIT_EXCEEDED",
  /** Reversão deixaria o saldo negativo. Situação operacional: exige tratamento manual. */
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  /** Referência nunca chegou (tentativas esgotadas). Verificar se a original foi enviada. */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** Referência existe mas foi rejeitada/falhou: não há o que reverter. Desistir. */
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  /** Tipo da referência não é aceito (ex.: REFUND de WIN). Corrigir o payload. */
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  /** Referência de outro player, wallet, moeda ou rodada. Corrigir o payload. */
  ReferenceMismatch = "REFERENCE_MISMATCH",
  /** Valor diferente do valor da referência (reversão parcial não suportada). Corrigir. */
  AmountMismatch = "AMOUNT_MISMATCH",
  /** Referência já revertida. Desistir. */
  AlreadyReversed = "ALREADY_REVERSED",
  /** Moeda da operação diferente da moeda da wallet. Corrigir o payload. */
  CurrencyMismatch = "CURRENCY_MISMATCH",
  /** walletId não pertence ao playerId informado. Corrigir o payload. */
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  /** Wallet inexistente. Corrigir o payload. */
  WalletNotFound = "WALLET_NOT_FOUND",
  /** Falha permanente de infraestrutura (status FAILED). Contatar suporte. */
  InternalError = "INTERNAL_ERROR",
}
