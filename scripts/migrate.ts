import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { ormOptions } from "../src/infra/orm-config";

async function main() {
  const orm = await MikroORM.init(ormOptions());

  try {
    const migrator = orm.getMigrator();
    const executed = await migrator.up();

    console.log(
      `Migrations concluídas. Aplicadas nesta execução: ${executed.length}`,
    );
  } finally {
    await orm.close(true);
  }
}

main().catch((error) => {
  console.error("Erro ao executar migrations:", error);
  process.exitCode = 1;
});
