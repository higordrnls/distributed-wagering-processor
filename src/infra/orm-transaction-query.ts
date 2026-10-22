import type { EntityManager } from "@mikro-orm/postgresql";
import type { QueryResult as OrmQueryResult } from "@mikro-orm/core";
import type { QueryResult } from "pg";

export class OrmTransactionQuery {
  constructor(private readonly em: EntityManager) {}

  async query(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<any>> {
    const connection = this.em.getConnection();
    const context = this.em.getTransactionContext();

    if (!context) {
      throw new Error("Consulta financeira fora de transação");
    }

    const bindings: unknown[] = [];

    const normalizedSql = sql.replace(
      /\$(\d+)/g,
      (_, index: string) => {
        const position = Number(index) - 1;

        if (position < 0 || position >= params.length) {
          throw new Error(`Parâmetro SQL inválido: $${index}`);
        }

        bindings.push(params[position]);
        return "?";
      },
    );

    const returnsRows =
      /^\s*(SELECT|WITH)\b/i.test(normalizedSql) ||
      /\bRETURNING\b/i.test(normalizedSql);

    if (!returnsRows) {
      const result = await connection.execute<OrmQueryResult>(
        normalizedSql,
        bindings,
        "run",
        context,
      );

      return {
        rows: [],
        rowCount: result.affectedRows ?? 0,
        command: "",
        oid: 0,
        fields: [],
      };
    }

    const rows = await connection.execute(
      normalizedSql,
      bindings,
      "all",
      context,
    );

    return {
      rows,
      rowCount: rows.length,
      command: "",
      oid: 0,
      fields: [],
    };
  }
}
