# 🐯 Tigrinho de Mentirinha — jogo fullstack fictício

**[Jogar online](https://distributed-wagering-processor.pages.dev/)** · [Repositório principal](../README.md)

Caça-níquel fictício, mobile-first, com moedas virtuais e sem apostas com dinheiro real.

## Funcionalidades

- Três rolos animados, apostas de 10/25/50/100 moedas e premiações fictícias.
- Estatísticas de giros, vitórias e maior prêmio.
- Interface responsiva, som opcional e respeito à preferência de movimento reduzido.
- Sessão anônima com cookie HttpOnly/Secure; carteira e rodadas persistidas no Neon PostgreSQL.
- Resultado e saldo calculados **no servidor**, não pelo navegador, quando o modo online está ativo.
- Recomeçar cria uma nova carteira com 1.000 moedas virtuais; registros antigos permanecem no banco.
- Histórico visual das últimas cinco rodadas apenas no aparelho.

## Arquitetura

```text
frontend/ (HTML, CSS, JavaScript)
          ↓ /api/game/session, /spin, /reset
functions/api/game/[[path]].js (Cloudflare Pages Functions)
          ↓ SQL over HTTP
Neon PostgreSQL (game_players, game_rounds, game_spin)
```

A função PostgreSQL `game_spin` faz a atualização de saldo e o registro da rodada em uma transação, usando lock por jogador e identificador de requisição para evitar débito duplicado. A sessão anônima é vinculada a um token aleatório armazenado como hash no banco.

**Importante:** o jogo não está conectado à API financeira NestJS/SQS do projeto principal. É uma implementação serverless independente dentro do mesmo repositório.

## Deploy

Cloudflare Pages conectado ao GitHub:
- Framework preset: `None`
- Build command: vazio
- Build output directory: `frontend`
- Pages Functions: pasta `functions/` na raiz do repositório
- Variável secreta de produção: `DATABASE_URL` (connection string do Neon, nunca versionar)

No SQL Editor do Neon, executar [neon-game-schema.sql](../docs/neon-game-schema.sql). Instruções detalhadas em [GAME_BACKEND_INTEGRATION.md](../docs/GAME_BACKEND_INTEGRATION.md).

## Limitações

Projeto demonstrativo sem dinheiro real, saques, depósitos ou login entre dispositivos. O acesso à carteira depende do cookie no navegador. Antes de divulgação ampla, é recomendável configurar rate limiting e proteção contra criação excessiva de sessões. Não é uma plataforma de apostas pronta para produção.
