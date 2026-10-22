import { Migration } from "@mikro-orm/migrations";

export class Migration20261022000003 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN correlation_id text
    `);

    this.addSql(`
      ALTER TABLE outbox_messages
      ADD COLUMN correlation_id text
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE outbox_messages
      DROP COLUMN correlation_id
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP COLUMN correlation_id
    `);
  }
}
