import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./api/app.module";
import { StructuredLogger } from "./infra/structured-logger";

async function bootstrap() {
  const logger = new StructuredLogger();
  const app = await NestFactory.create(AppModule, { logger });

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");

  logger.log(`Jungle Wager API listening on port ${port}`, "Bootstrap");
}

bootstrap();
