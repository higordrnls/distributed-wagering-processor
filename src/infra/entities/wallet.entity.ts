import { EntitySchema } from "@mikro-orm/core";

export class WalletEntity {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const walletSchema = new EntitySchema({
  class: WalletEntity,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string", fieldName: "player_id" },
    currency: { type: "string" },
    balance: { type: "decimal", precision: 18, scale: 2 },
    version: { type: "integer" },
    createdAt: { type: "Date", fieldName: "created_at" },
    updatedAt: { type: "Date", fieldName: "updated_at" },
  },
});
