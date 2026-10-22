import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { ormOptions } from "../infra/orm-config";

@Injectable()
export class OrmProvider implements OnModuleDestroy {
  private ormPromise?: Promise<MikroORM>;

  getOrm(): Promise<MikroORM> {
    if (!this.ormPromise) {
      this.ormPromise = MikroORM.init(ormOptions()).catch((error) => {
        this.ormPromise = undefined;
        throw error;
      });
    }

    return this.ormPromise;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ormPromise) {
      const orm = await this.ormPromise;
      await orm.close(true);
    }
  }
}
