# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK)
com idempotência persistente, ledger imutável, inbox/outbox e consumo SQS.
Stack: Bun, TypeScript (strict), NestJS, PostgreSQL 16, SQS (MiniStack), Docker Compose.

- Enunciado original: [docs/CHALLENGE.md](docs/CHALLENGE.md)
- Decisões técnicas, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)

## Pré-requisitos
Bun 1.4.x, Docker com Docker Compose, Git.

## Como executar
```bash
git clone https://github.com/higordrnls/distributed-wagering-processor.git
cd distributed-wagering-processor
bun install
cp .env.example .env
docker compose up -d          # PostgreSQL (5433) e MiniStack/SQS (4566)
bun run migrate               # aplica as migrations
bash scripts/setup-sqs.sh     # cria filas FIFO, DLQ e política de redrive
bun run start                 # API em http://localhost:3000
```
Verificação: `curl -i localhost:3000/health/live` e `curl -i localhost:3000/health/ready`
(o readiness checa PostgreSQL e SQS). Métricas Prometheus em `GET /metrics`.

## Múltiplas instâncias
Em terminais separados (compartilham o mesmo PostgreSQL e as mesmas filas):
```bash
PORT=3001 bun run start
PORT=3002 bun run start
```

## Testes
```bash
bun test                  # suíte completa (exige docker compose up -d)
bun run test:integration  # apenas src/infra
bun run typecheck
```
Os testes de integração usam PostgreSQL e SQS reais. O banco isolado `wager_test` é criado automaticamente.

## Endpoints
| Método | Rota |
|---|---|
| POST | /wallets |
| GET | /wallets/:walletId |
| GET | /wallets/:walletId/ledger?cursor=&limit= |
| POST | /wallets/:walletId/reconciliation |
| POST | /wagering/transactions (header `Idempotency-Key`) |
| GET | /wagering/transactions/:transactionId |
| GET | /providers/:providerId/wagering/transactions/:externalTransactionId |
| GET | /health/live, /health/ready, /metrics |

## Encerrar
Ctrl+C nos processos Bun e `docker compose down` (evite `-v` para preservar os dados).
