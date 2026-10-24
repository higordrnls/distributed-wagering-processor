#!/usr/bin/env bash
set -euo pipefail

# Prefer a working native Docker CLI; fall back to Docker Desktop's Windows CLI.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DOCKER="docker"
elif command -v docker.exe >/dev/null 2>&1 && docker.exe info >/dev/null 2>&1; then
  DOCKER="docker.exe"
else
  echo "Docker CLI não disponível." >&2
  exit 1
fi

SQS="$DOCKER compose exec -T ministack awslocal sqs"

echo "Criando DLQ..."
$SQS create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true

echo "Criando fila de transações..."
$SQS create-queue \
  --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "Criando fila de eventos..."
$SQS create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "Configurando política de redrive..."

DLQ_URL="http://localhost:4566/000000000000/wager-transactions-dlq.fifo"
INPUT_URL="http://localhost:4566/000000000000/wager-transactions.fifo"

DLQ_ARN=$($SQS get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

REDRIVE_POLICY=$(printf \
  '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' \
  "$DLQ_ARN")

ATTRIBUTES_JSON=$(printf \
  '{"RedrivePolicy":"%s"}' \
  "$(printf '%s' "$REDRIVE_POLICY" | sed 's/"/\\"/g')")

$SQS set-queue-attributes \
  --queue-url "$INPUT_URL" \
  --attributes "$ATTRIBUTES_JSON"

echo "Filas configuradas:"
$SQS list-queues

echo "Política de redrive:"
$SQS get-queue-attributes \
  --queue-url "$INPUT_URL" \
  --attribute-names RedrivePolicy
