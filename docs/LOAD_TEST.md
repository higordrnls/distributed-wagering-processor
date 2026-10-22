# Benchmark de carga — Distributed Wagering Processor

## Objetivo e escopo

Medição local do caminho de processamento financeiro com PostgreSQL, usando
`ProcessWagerTransaction`. O script exercita três cenários: uma carteira
compartilhada (hot wallet), carteiras independentes e replays idempotentes.

Este benchmark **não mede a API HTTP nem o fluxo completo via SQS** e não
representa capacidade de produção. É uma execução exploratória, não um teste
de capacidade certificado.

## Ambiente reportado

- Bun: 1.4.3
- Plataforma: Linux
- CPUs lógicas reportadas: 12
- Memória reportada: 3,71 GiB
- Banco: `wager_test`
- Valor por aposta: `1.00 BRL`
- Concorrência: 3 para 10 operações; 10 para 100; 25 para 500 e 1.000.

## Resultados observados

Vazão em operações por segundo; latências em milissegundos.

| Operações | Cenário | Vazão (op/s) | p50 (ms) | p95 (ms) | p99 (ms) | Erros | Replays |
|---:|---|---:|---:|---:|---:|---:|---:|
| 10 | Hot wallet | 109,70 | 17,80 | 50,60 | 50,60 | 0 | 0 |
| 10 | Carteiras independentes | 372,37 | 6,48 | 10,82 | 10,82 | 0 | 0 |
| 10 | Replays idempotentes | 354,69 | 7,38 | 9,68 | 9,68 | 0 | 9 |
| 100 | Hot wallet | 180,42 | 45,90 | 88,53 | 117,10 | 0 | 0 |
| 100 | Carteiras independentes | 1.180,05 | 7,95 | 10,06 | 11,41 | 0 | 0 |
| 100 | Replays idempotentes | 402,84 | 24,03 | 27,86 | 27,96 | 0 | 99 |
| 500 | Hot wallet | 216,59 | 83,61 | 243,86 | 471,73 | 0 | 0 |
| 500 | Carteiras independentes | 1.673,55 | 14,48 | 20,09 | 21,84 | 0 | 0 |
| 500 | Replays idempotentes | 432,83 | 55,96 | 67,67 | 73,36 | 0 | 499 |
| 1.000 | Hot wallet | 229,55 | 80,35 | 229,38 | 605,92 | 0 | 0 |
| 1.000 | Carteiras independentes | 1.858,29 | 12,76 | 18,37 | 22,24 | 0 | 0 |
| 1.000 | Replays idempotentes | 316,36 | 78,22 | 83,93 | 85,57 | 0 | 999 |

## Validações realizadas

O script verifica que o saldo final corresponde ao esperado e reconstrói o
saldo usando os lançamentos do ledger, validando `balance_before` e
`balance_after`. Também verifica contagens de transações e débitos, e que
replays idempotentes não criem transações ou débitos adicionais.

Todas as execuções listadas terminaram com a mensagem `Validação financeira
concluída.` e reportaram zero erros técnicos, conflitos ou resultados
inesperados.

## Interpretação e limitações

- Carteiras independentes apresentaram maior vazão neste ambiente, consistente
  com menor contenção pelo lock por carteira.
- O cenário hot wallet apresentou cauda de latência maior, compatível com
  contenção; estes resultados isolados não provam a causa.
- A vazão de replays variou entre execuções. Não houve repetição estatística,
  perfilamento nem controle de fatores externos.
- O número de CPUs e a memória são os reportados pelo ambiente local; o
  resultado pode depender de containers, banco, cache, aquecimento e carga
  concorrente.
- O teste usa o processador e o banco diretamente. Não mede latência HTTP,
  SQS, publicação da outbox, múltiplas máquinas ou condições de produção.
- Não se define meta de RPS a partir destas medições.

## Como reproduzir

```bash
LOAD_OPERATIONS=10 LOAD_CONCURRENCY=3 bun run test:load
LOAD_OPERATIONS=100 LOAD_CONCURRENCY=10 bun run test:load
LOAD_OPERATIONS=500 LOAD_CONCURRENCY=25 bun run test:load
LOAD_OPERATIONS=1000 LOAD_CONCURRENCY=25 bun run test:load
```

Execute com os serviços de banco configurados e as migrations aplicadas.
