import {
  BadRequestException,
  ConflictException,
} from "@nestjs/common";

export type SqsErrorDisposition =
  | "ACK"
  | "RETRY"
  | "DLQ";

export function classifySqsError(error: unknown): SqsErrorDisposition {
  if (error instanceof ConflictException) {
    return "ACK";
  }

  if (error instanceof BadRequestException) {
    return "DLQ";
  }

  if (
    error instanceof Error &&
    error.message === "INBOX_MESSAGE_ID_CONFLICT"
  ) {
    return "DLQ";
  }

  return "RETRY";
}
