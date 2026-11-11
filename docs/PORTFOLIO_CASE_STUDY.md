# Estudo de caso — Distributed Wagering Processor

## Problema

Um sistema de apostas recebe operações financeiras de múltiplos provedores. Uma mesma mensagem pode chegar repetida, fora de ordem ou ser processada por instâncias diferentes. O objetivo é preservar a integridade dos saldos e a rastreabilidade das operações nessas condições.

## Solução implementada

- Domínio financeiro com valores monetários em centavos (`bigint`), operações BET, WIN, LOSS, REFUND e ROLLBACK.
- PostgreSQL como fonte de verdade, com transações, locks por carteira, constraints e ledger imutável.
- Idempotência persistente para identificar reenvios e rejeitar payloads conflitantes.
- Integração SQS com inbox, outbox transacional, tentativas de reprocessamento e DLQ.
- Worker de reconciliação para referências que chegam fora de ordem.
- Endpoints de health, métricas Prometheus e testes de integração.

## Decisões e compromissos

| Decisão | Motivação | Limitação |
|---|---|---|
| `bigint` para centavos | Aritmética exata para escala fixa de 2 casas | Não atende diretamente moedas com outras escalas |
| Lock pessimista por carteira | Serializar débitos e créditos concorrentes na mesma carteira | Contenção em carteiras muito disputadas |
| Inbox e outbox no banco | Persistir efeitos financeiros e registros de mensageria de forma atômica | Eventos publicados podem ser entregues mais de uma vez |
| Domínio separado da infraestrutura | Isolar regras financeiras do framework e do banco | Mais camadas para compreender e manter |

## Evidências documentadas

O repositório inclui testes de integração com PostgreSQL e SQS, cenários multiprocesso e testes de recuperação após falhas. O relatório [LOAD_TEST.md](LOAD_TEST.md) registra benchmarks locais do caso de uso com validação financeira e zero erros reportados nas execuções descritas.

**Atenção:** estes resultados são registros de execuções anteriores; não equivalem a uma nova validação automatizada nesta revisão. O benchmark não mede o caminho HTTP/SQS completo nem capacidade de produção.

## O que aprendi e o que ainda quero aprofundar

Este projeto oferece uma base concreta para estudar transações SQL, concorrência, idempotência e sistemas distribuídos. Os próximos passos são revisar criticamente a implementação, reduzir complexidade onde possível, ampliar a clareza dos testes e conseguir justificar cada decisão técnica com autonomia.

## Limitações conhecidas

- Autenticação e autorização não implementadas.
- Estado `FAILED` modelado, mas sem fluxo atual que o produza.
- Algumas partes do caso de uso combinam ORM e SQL explícito.
- Resultados de carga restritos ao ambiente e aos cenários documentados.

Mais detalhes: [ARCHITECTURE.md](../ARCHITECTURE.md).
