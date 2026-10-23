# Arquitetura e decisões técnicas

## 1. Visão geral

Um único processo NestJS (Bun) expõe a API HTTP e roda três workers em background:
consumidor SQS, publisher do outbox e reconciliador de `PENDING_REFERENCE`.
Todas as instâncias rodam tudo. A correção com N instâncias vem do PostgreSQL
(locks e constraints), não de coordenação entre processos.

    HTTP POST  ──┐
                 ├─> ProcessWagerTransaction (UMA transação SQL) ─> PostgreSQL
    SQS FIFO   ──┘     wallets · wager_transactions · wallet_ledger_entries · inbox · outbox
    Publisher do outbox ─> fila de eventos (wager-events.fifo)
    Reconciliador ─> reavalia transações PENDING_REFERENCE com a mesma regra de domínio

Camadas: `domain/` (TypeScript puro, sem decorators, sem ORM), `application/` (use case e
seleção de eventos), `api/` (controllers e services Nest) e `infra/` (migrations, workers, SQS).
A regra de negócio vive em `domain/process-wager.ts`, uma função pura que recebe a wallet e a
referência já carregadas. Quem carrega, trava e persiste é o use case.

## 2. Decisões

### 2.1 Dinheiro
`Money` guarda **centavos em `bigint`**. É exato, não usa `number` nem biblioteca extra, e a escala
fixa de 2 casas do enunciado torna isso suficiente. Entrada aceita `"25"`, `"25.5"` e `"25.00"`
(normaliza para 2 casas), rejeita 3+ casas, negativos, notação científica e vazio, com no máximo
15 dígitos inteiros. No banco: `numeric(18,2)`. Operações aritméticas também verificam o intervalo representável por `numeric(18,2)` e rejeitam overflow antes da persistência. Na reidratação:
`Money.from({ amount: String(row.amount), currency })`. Trade-off: não serve para moedas com outra
escala (ex.: 3 casas), o que está fora do escopo.

### 2.2 Concorrência: lock pessimista por wallet
O processamento financeiro utiliza `LockMode.PESSIMISTIC_WRITE` do MikroORM
sobre a entidade `WalletEntity`, dentro de `EntityManager.transactional()`.
O PostgreSQL aplica o bloqueio por wallet, serializando operações concorrentes
sobre o mesmo saldo sem impor um lock global.

O domínio continua responsável pelas regras financeiras. A coluna `version`
incrementa somente quando o saldo muda; a proteção principal contra lost updates
é o bloqueio pessimista.

Trade-off: operações sobre uma mesma wallet são serializadas, limitando o
throughput de wallets muito disputadas. Wallets diferentes podem avançar
concorrentemente.

### 2.3 Idempotência persistente
`INSERT ... ON CONFLICT DO NOTHING` em `wager_transactions`, com `UNIQUE(provider_id,
external_transaction_id)` e `UNIQUE(provider_id, idempotency_key)`. Se o insert não ocorre, a
transação existente é lida: mesmo `payload_hash` é replay (devolve o resultado e o **saldo observado
na época**, guardado em `observed_balance`); hash diferente é conflito (HTTP 409). O hash é SHA-256 do
JSON canônico (chaves ordenadas recursivamente, `undefined` omitido, valor normalizado a 2 casas) dos
campos de negócio. O header `Idempotency-Key` e metadados de transporte ficam fora. No caminho SQS,
a inbox (`PRIMARY KEY (consumer_name, message_id)`) é gravada na mesma transação.

### 2.4 MikroORM, Unit of Work e transações
O MikroORM v6 gerencia o contexto transacional do processamento financeiro.
Cada execução utiliza um `EntityManager` isolado (`fork`) e
`EntityManager.transactional()` para garantir atomicidade.

A wallet é carregada com `LockMode.PESSIMISTIC_WRITE`. A instância gerenciada
participa do Identity Map e suas alterações de saldo, versão e atualização
são persistidas pelo Unit of Work por meio de `flush()`.

As operações auxiliares de persistência de transações, ledger, inbox e outbox
utilizam SQL explícito por meio de `OrmTransactionQuery`, compartilhando o
mesmo contexto transacional do MikroORM. Assim, todas as alterações financeiras
são confirmadas ou revertidas juntas.

A escolha híbrida preserva o domínio independente de ORM e mantém explícitas
as operações SQL que dependem de constraints, `ON CONFLICT` e outros recursos
do PostgreSQL.

Trade-off: parte da persistência utiliza SQL explícito, exigindo atenção
para manter o contexto transacional e o estado gerenciado sincronizados.

### 2.5 Estados e transições
    PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
    PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
    PROCESSED, REJECTED, FAILED: terminais (tentar transicionar é erro de programação)
Um trigger no banco também proíbe `UPDATE` e `DELETE` de transações já terminais.

### 2.6 Referências e reversões
`REFUND` referencia só `BET`; `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`; `WIN` pode referenciar
uma `BET`. A referência é resolvida por `(provider_id, referenceExternalTransactionId)` e deve ter
mesmo provider, player, wallet, moeda e rodada, com valor igual. **Interpretação adotada:** uma
referência só pode ser revertida **uma vez, qualquer que seja o tipo** (o enunciado fala em "mesmo
tipo" na regra 4 mas em "uma única vez" na tabela; `REFUND` + `ROLLBACK` na mesma `BET` creditaria
em dobro). Imposto por índice único parcial em `reference_transaction_id`
(`status = 'PROCESSED'` e `kind` em `REFUND`/`ROLLBACK`).

### 2.7 Ledger
Imutável: trigger bloqueia `UPDATE` e `DELETE`. `CHECK` confere a aritmética
(`before ± amount = after`), valor positivo e saldos não negativos. `UNIQUE (wallet_id,
transaction_id)` dá no máximo um lançamento por transação e wallet. A coluna `seq` (identity) é a
base do cursor estável da paginação. `LOSS` e transações `REJECTED` não geram lançamento.

### 2.8 Taxonomia de `failureCode`
| Código | Quando | Provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | desistir (ou nova transação após depósito) |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão deixaria saldo negativo | desistir; caso operacional |
| `REFERENCE_NOT_FOUND` | referência não chegou após as tentativas | verificar se a original foi enviada |
| `REFERENCE_NOT_PROCESSED` | referência foi `REJECTED`/`FAILED` | desistir |
| `INVALID_REFERENCE_KIND` | tipo de referência não aceito | corrigir o payload |
| `REFERENCE_MISMATCH` | outro provider, player, wallet, moeda ou rodada | corrigir o payload |
| `AMOUNT_MISMATCH` | valor diferente da referência | corrigir o payload |
| `ALREADY_REVERSED` | referência já revertida | desistir |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | wallet não pertence ao player | corrigir o payload |
| `WALLET_NOT_FOUND` | wallet inexistente | corrigir o payload |
| `INTERNAL_ERROR` | falha permanente de infraestrutura (`FAILED`) | contatar o suporte |

### 2.9 Mapeamento HTTP
| Situação | Status |
|---|---|
| processada ou replay | 200 |
| wallet criada | 201 |
| `PENDING_REFERENCE` (aceita, aguarda referência) | 202 |
| payload inválido | 400 (corpo com `code`) |
| conflito de idempotência / wallet duplicada | 409 |
| `REJECTED` por regra de negócio | 422 (com `failureCode`) |
| `FAILED`, ou readiness com dependência fora | 503 |

## 3. Mensageria (SQS)
Filas FIFO `wager-transactions.fifo` e `wager-transactions-dlq.fifo`, criadas por
`scripts/setup-sqs.sh`, com `RedrivePolicy` de `maxReceiveCount = 5`. O FIFO é otimização; a
garantia final de consistência é do banco. O consumidor usa long polling, uma mensagem por vez,
visibilidade de 30 s, e **chama o mesmo use case da HTTP**. O `DeleteMessage` (ack) só acontece
**depois do commit**. Classificação de erros:
- conflito de idempotência: **ACK** (terminal, conflito de negócio);
- envelope inválido ou `messageId` reutilizado com outro conteúdo: **não dá ack**, e a mensagem vai
  para a DLQ pela redrive policy ao atingir 5 recebimentos;
- demais erros (transitórios): `ChangeMessageVisibility` com backoff `5 * 2^(n-1)` s, teto de 120 s.
Uma transação `REJECTED` é resultado normal de negócio e leva ack.
Shutdown: `enableShutdownHooks`; consumidor e reconciliador aguardam o ciclo em andamento antes de encerrar.

## 4. Outbox transacional
Os eventos são gravados na **mesma transação** do saldo, do ledger e da inbox. Eventos:
`WagerTransactionProcessed` (inclui `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged`
(somente se o saldo muda) e `WagerTransactionPendingReference`. O publisher usa
`FOR UPDATE SKIP LOCKED`, reserva o lote incrementando `attempts` e empurrando `next_attempt_at`
30 s à frente (se o processo morrer, outra instância reassume após a reserva expirar), publica e marca
`published_at`. Em falha, backoff `min(300, 2^tentativas)` s. A entrega é **at-least-once**, então o
consumidor dos eventos deve deduplicar por `eventId`. Um teste de integração mata o processo publisher com `SIGKILL` após a publicação no SQS e antes da confirmação no PostgreSQL, verificando a recuperação por outro publisher.

## 5. Worker de `PENDING_REFERENCE`
Roda a cada `REFERENCE_POLL_INTERVAL_MS` (padrão 5 s) com `FOR UPDATE SKIP LOCKED`. Limite de
**10 tentativas**, com backoff `min(300, 2^tentativa)` s, o que dá cerca de 13 minutos. Esgotado:
`REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`. O limite é um valor
escolhido: cobre atrasos normais de entrega sem manter transações pendentes indefinidamente.

## 6. Observabilidade
Métricas Prometheus em `GET /metrics`: `wager_transactions_total{status}`,
`wager_idempotent_replays_total`, `wager_processing_duration_seconds`, `wager_sqs_retries_total`,
`wager_sqs_dlq_candidates_total`, `wager_sqs_dlq_messages`,
`wager_sqs_dlq_collection_success`, `wager_lock_conflicts_total`,
`wager_reconciliation_mismatches_total`, `wager_outbox_lag_seconds` (idade do evento pendente mais antigo, inclusive em backoff).
Health: `/health/live` e `/health/ready` (PostgreSQL e SQS). A reconciliação compara o saldo
persistido com o calculado pelo ledger; divergências são logadas, contadas e sinalizadas, **nunca
corrigidas em silêncio**.

## 7. Autenticação

A autenticação não foi implementada, conforme permitido pela seção 2 do desafio, pois não integra a pontuação funcional.

O código contém um ponto de extensão explícito em `src/api/provider-identity.port.ts`:

- `ProviderIdentityPort` define o contrato `assertProviderAccess(providerId)`.
- `UnauthenticatedProviderIdentity` é uma implementação **no-op**, registrada no `AppModule`.
- Os controllers de submissão e consulta por identificador externo invocam esse contrato antes de delegar ao serviço.

**Importante:** a implementação atual não autentica nem autoriza requisições. Os endpoints permanecem públicos; o contrato existe apenas como ponto de integração.

Para produção, a implementação seria substituída por uma integração com um Identity Provider externo (Keycloak ou Zitadel), validando JWTs e verificando se o provedor autenticado corresponde ao `providerId` solicitado. Um guard global protegeria os endpoints de negócio, mantendo `/health/live` e `/health/ready` públicos. Mensagens SQS continuariam sendo tratadas como canal interno confiável, com validações de domínio preservadas.

## 8. Limitações e pendências conhecidas

- **Observabilidade:** `StructuredLogger` emite logs JSON para stderr e
  está configurado como logger da aplicação NestJS. A cobertura dos campos
  de contexto varia conforme o evento.
- **Métricas:** `wager_lock_conflicts_total` contabiliza erros de lock
  identificados pelo PostgreSQL, não toda espera por um bloqueio.
  `wager_sqs_dlq_messages` informa a quantidade observada na DLQ,
  acompanhada de `wager_sqs_dlq_collection_success` para indicar
  se a coleta foi bem-sucedida.
- **Autenticação:** não implementada, conforme a decisão documentada
  na seção 7. Os endpoints de negócio permanecem públicos.
- **Tratamento de erros:** falhas transitórias de infraestrutura
  identificadas pelo filtro global retornam HTTP 503 com o código
  `INFRASTRUCTURE_UNAVAILABLE`. Erros não classificados permanecem HTTP 500.
- **Testes:** existem testes com PostgreSQL e SQS reais, concorrência
  multiprocesso, redelivery, DLQ, crash antes do ACK e shutdown.
  A recuperação após reinicialização real da aplicação também foi validada:
  saldo, ledger, estado da transação e idempotência permanecem consistentes
  entre processos, com encerramento do pool PostgreSQL testado.
