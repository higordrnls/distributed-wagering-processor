import { Migration } from "@mikro-orm/migrations";

export class Migration20261021000002 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
      add column observed_balance numeric(18,2)
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
      drop column observed_balance
    `);
  }
}
