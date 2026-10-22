import { EntitySchema } from "@mikro-orm/core";

export class LedgerEntryEntity {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const ledgerEntrySchema = new EntitySchema({
  class: LedgerEntryEntity,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    transactionId: { type: "uuid", fieldName: "transaction_id" },
    direction: { type: "string" },
    amount: { type: "decimal", precision: 18, scale: 2 },
    currency: { type: "string" },
    balanceBefore: {
      type: "decimal", fieldName: "balance_before", precision: 18, scale: 2,
    },
    balanceAfter: {
      type: "decimal", fieldName: "balance_after", precision: 18, scale: 2,
    },
    createdAt: { type: "Date", fieldName: "created_at" },
  },
});
