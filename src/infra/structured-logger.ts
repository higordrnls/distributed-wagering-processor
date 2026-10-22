import type { LoggerService } from "@nestjs/common";

export class StructuredLogger implements LoggerService {
  log(message: unknown, context?: string) {
    this.write("info", message, context);
  }

  error(message: unknown, trace?: string, context?: string) {
    this.write("error", message, context, trace);
  }

  warn(message: unknown, context?: string) {
    this.write("warn", message, context);
  }

  debug(message: unknown, context?: string) {
    this.write("debug", message, context);
  }

  verbose(message: unknown, context?: string) {
    this.write("verbose", message, context);
  }

  fatal(message: unknown, context?: string) {
    this.write("fatal", message, context);
  }

  private write(
    level: string,
    message: unknown,
    context?: string,
    trace?: string,
  ) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      message: message instanceof Error ? message.message : message,
      ...(message instanceof Error ? { errorName: message.name } : {}),
      ...(trace ? { trace } : {}),
    };

    const line = JSON.stringify(entry);
    process.stderr.write(line + "\n");
  }
}
