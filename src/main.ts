import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./api/app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");

  console.log(`Jungle Wager API listening on port ${port}`);
}

bootstrap();
