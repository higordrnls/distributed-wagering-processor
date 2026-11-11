# Distributed Wagering Processor

**Backend distribuído para processamento de transações financeiras com consistência, idempotência e tolerância a falhas.**

Projeto em **Bun, TypeScript (strict), NestJS, PostgreSQL e SQS (MiniStack)**, desenvolvido para estudar e demonstrar desafios reais de engenharia backend em sistemas financeiros distribuídos.

O serviço processa operações **BET, WIN, LOSS, REFUND e ROLLBACK** e busca preservar a integridade das carteiras diante de requisições duplicadas, concorrência entre instâncias, mensagens fora de ordem e falhas de infraestrutura.

## Destaques técnicos

- **Precisão monetária:** centavos representados com `bigint`, sem aritmética de ponto flutuante.
- **Idempotência persistente:** chaves, hashes de payload e constraints no PostgreSQL evitam processamento financeiro duplicado.
- **Concorrência:** lock pessimista por carteira para evitar *lost updates* sem bloquear todas as carteiras.
- **Rastreabilidade:** ledger imutável e reconciliação de saldo.
- **Mensageria:** consumo SQS FIFO, retries, DLQ e recuperação de mensagens.
- **Consistência de eventos:** padrão *Transactional Outbox* com entrega *at-least-once*.
- **Testes:** cenários documentados de integração, concorrência, idempotência e recuperação após falhas.

## Arquitetura em resumo

```text
HTTP API ───────┐
                ├──> Caso de uso transacional ──> PostgreSQL
SQS Consumer ───┘      wallet · transações · ledger · inbox · outbox
                                               │
                                       Outbox Publisher ──> SQS Events
```

O domínio concentra as regras financeiras; a camada de aplicação coordena a transação; a infraestrutura implementa persistência e mensageria. O PostgreSQL é a fonte de verdade para saldo, idempotência e unicidade.

## Escopo e transparência

Projeto originalmente desenvolvido como exercício de avaliação técnica e posteriormente trabalhado como portfólio de backend. **Não é um serviço pronto para produção.** Autenticação não foi implementada; os endpoints de negócio estão públicos no ambiente de demonstração. Os benchmarks são medições locais do processador financeiro, não do fluxo HTTP/SQS de ponta a ponta.

- [Decisões arquiteturais, trade-offs e limitações](ARCHITECTURE.md)
- [Metodologia e resultados dos testes de carga](docs/LOAD_TEST.md)

---

## Pré-requisitos
Bun 1.4.x, Docker com Docker Compose, Git.

**Ubuntu no WSL2 com Docker Desktop:** se `docker` não estiver disponível
dentro do Ubuntu, utilize `docker.exe compose` nos comandos abaixo.
O script `scripts/setup-sqs.sh` detecta automaticamente essa situação.

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
