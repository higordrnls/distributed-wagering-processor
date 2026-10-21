import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { Migration, Migrator } from "@mikro-orm/migrations";

class Migration20261021000000 extends Migration {
  async up(): Promise<void> {
    this.addSql("create table spike_t (id int primary key, v numeric(12,2) not null check (v >= 0));");
  }
  async down(): Promise<void> {
    this.addSql("drop table spike_t;");
  }
}

const orm = await MikroORM.init({
  dbName: "wager", host: "localhost", port: 5433,
  user: "wager", password: "wager",
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    migrationsList: [{ name: "Migration20261021000000", class: Migration20261021000000 }],
  },
});

const exists = async () =>
  (await orm.em.getConnection().execute("select to_regclass('spike_t') as t"))[0].t;

const migrator = orm.getMigrator();
await migrator.up();
console.log("depois do up   ->", await exists());
await migrator.down({ to: 0 });
console.log("depois do down ->", await exists());
await orm.close();
