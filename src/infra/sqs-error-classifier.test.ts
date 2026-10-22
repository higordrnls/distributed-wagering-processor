import { describe, expect, test } from "bun:test";
import {
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { classifySqsError } from "./sqs-error-classifier";

describe("SQS error classifier", () => {
  test("confirma conflitos de negócio com ACK", () => {
    const error = new ConflictException("IDEMPOTENCY_CONFLICT");

    expect(classifySqsError(error)).toBe("ACK");
  });

  test("encaminha mensagens inválidas para DLQ", () => {
    const error = new BadRequestException("Mensagem inválida");

    expect(classifySqsError(error)).toBe("DLQ");
  });

  test("encaminha conflitos de messageId para DLQ", () => {
    const error = new Error("INBOX_MESSAGE_ID_CONFLICT");

    expect(classifySqsError(error)).toBe("DLQ");
  });

  test("repete o processamento após erros de infraestrutura", () => {
    const error = new Error("ECONNREFUSED");

    expect(classifySqsError(error)).toBe("RETRY");
  });

  test("repete erros desconhecidos por segurança", () => {
    expect(classifySqsError(new Error("Unexpected error"))).toBe("RETRY");
  });
});
