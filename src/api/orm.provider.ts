import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { ormOptions } from "../infra/orm-config";

@Injectable()
export class OrmProvider implements OnModuleDestroy {
  private orm?: MikroORM;

  async getOrm(): Promise<MikroORM> {
    if (!this.orm) {
      this.orm = await MikroORM.init(ormOptions());
    }

    return this.orm;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.orm) {
      await this.orm.close(true);
    }
  }
}
