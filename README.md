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

## Exemplo rápido de uso

Com a API em execução, crie uma carteira:

```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{"playerId":"player-demo","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Copie o campo `id` retornado na criação da carteira e utilize-o como `walletId` para enviar uma aposta:

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-bet-001" \
  -H "X-Correlation-Id: demo-flow-001" \
  -d '{
    "providerId":"provider-demo",
    "externalTransactionId":"bet-demo-001",
    "playerId":"player-demo",
    "walletId":"SUBSTITUA_PELO_WALLET_ID",
    "roundId":"round-demo-001",
    "gameId":"game-demo-001",
    "kind":"BET",
    "money":{"amount":"100.00","currency":"BRL"}
  }'
```

Resultado esperado: `PROCESSED`, com saldo de `900.00 BRL`.

Repetir a mesma requisição com a mesma chave de idempotência retorna
`idempotentReplay: true`, sem gerar outro débito.

O header `X-Correlation-Id` é opcional e permite correlacionar a operação
ao longo do processamento e da publicação de eventos.

## Validação

Execute `bun test` e `bun run typecheck` para verificar o projeto.
A suíte cobre regras financeiras, idempotência, concorrência entre
processos, integração com PostgreSQL e SQS, redelivery, DLQ,
shutdown gracioso, renovação de visibilidade, recuperação do outbox
e reinicialização real da aplicação com preservação de saldo,
ledger e idempotência.

Os testes de integração utilizam PostgreSQL e SQS em containers,
não apenas mocks.

## Encerrar
Ctrl+C nos processos Bun e `docker compose down` (evite `-v` para preservar os dados).

## Benchmark de carga

Os resultados locais, a metodologia e as limitações estão em
[docs/LOAD_TEST.md](docs/LOAD_TEST.md).
Eles não representam capacidade de produção.
