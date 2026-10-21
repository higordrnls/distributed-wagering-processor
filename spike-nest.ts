import "reflect-metadata";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

@Injectable()
class Svc { hello() { return "ok"; } }

@Controller()
class Ctrl {
  constructor(private readonly svc: Svc) {}
  @Get() get() { return this.svc.hello(); }
}

@Module({ controllers: [Ctrl], providers: [Svc] })
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ["error"] });
await app.listen(3000);
console.log("up");
