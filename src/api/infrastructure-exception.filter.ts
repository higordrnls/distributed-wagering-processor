import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";

const TRANSIENT_PG_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08006", // connection_failure
]);

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

export function isTransientInfrastructureError(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < 5; depth++) {
    if (current === null || typeof current !== "object") return false;
    if (visited.has(current)) return false;
    visited.add(current);

    const candidate = current as { code?: unknown; cause?: unknown };

    if (typeof candidate.code === "string") {
      if (
        TRANSIENT_PG_CODES.has(candidate.code) ||
        TRANSIENT_NETWORK_CODES.has(candidate.code)
      ) {
        return true;
      }
    }

    current = candidate.cause;
  }

  return false;
}

@Catch()
export class InfrastructureExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status: (statusCode: number) => {
        json: (body: unknown) => unknown;
      };
    }>();

    if (exception instanceof HttpException) {
      response
        .status(exception.getStatus())
        .json(exception.getResponse());
      return;
    }

    if (isTransientInfrastructureError(exception)) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        code: "INFRASTRUCTURE_UNAVAILABLE",
        message: "Serviço temporariamente indisponível",
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: "INTERNAL_ERROR",
      message: "Erro interno do servidor",
    });
  }
}
