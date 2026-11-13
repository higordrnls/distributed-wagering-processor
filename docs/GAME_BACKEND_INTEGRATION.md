# Integração Cloudflare Pages + Neon PostgreSQL (jogo fictício)

## Implementação preparada

- Cloudflare Pages Function em `functions/api/game/[[path]].js`: sessão anônima com cookie HttpOnly/Secure e token aleatório cujo hash é armazenado no PostgreSQL.
- `GET /api/game/session`: cria ou consulta carteira fictícia de 1.000 moedas.
- `POST /api/game/spin`: valida aposta e UUID de idempotência; chama `game_spin` no Neon.
- `docs/neon-game-schema.sql`: tabelas `game_players` e `game_rounds` e função PostgreSQL transacional com lock por jogador, sorteio no servidor e replay idempotente.
- Frontend: usa API quando a sessão online responde; enquanto não estiver configurada, sinaliza **modo demonstração local**.

**Atenção: esta é uma implementação nova de backend serverless para o jogo, NÃO uma conexão com o NestJS original.** O processador distribuído do desafio permanece separado. Não afirmar que SQS/outbox/ledger original processam giros do jogo.

## Ativação (sem instalar nada)

1. No Neon recém-criado, abrir **SQL Editor** e executar integralmente [neon-game-schema.sql](neon-game-schema.sql) na branch/database correta.
2. Na Cloudflare Pages, abrir o projeto → **Settings → Variables and Secrets** (ou **Environment variables**).
3. Criar variável secreta **`DATABASE_URL`** com a connection string copiada de **Connect** no Neon. Usar tipo **Secret / Encrypt**; nunca publicar a URL no GitHub, capturas de tela ou conversa.
4. Salvar para **Production** e executar novo deployment da branch `main` (mudanças de variáveis exigem novo deploy).
5. Abrir o jogo em janela anônima. Deve aparecer **“Conectado! Suas moedas agora são salvas no servidor.”**
6. Girar, recarregar e verificar saldo; consultar `SELECT * FROM game_rounds ORDER BY created_at DESC LIMIT 5;` no Neon SQL Editor.
7. Confirmar funcionamento em celular e após várias rodadas, além de falhas de rede e giros duplicados.

## Limitações e pendências

- Ainda **não validado em produção**. Não marcar como integrado até executar SQL, configurar secret e realizar teste real.
- Sessão anônima por cookie: sem conta/senha nem sincronização entre dispositivos; perda do cookie perde o acesso ao saldo anterior.
- O frontend mantém histórico das cinco rodadas apenas no navegador; as rodadas completas ficam no PostgreSQL.
- Sem controle de taxa avançado; antes de divulgação ampla, configurar rate limiting no Cloudflare WAF e limites de recursos.
- A API de sessão cria carteira automaticamente: isso precisa de proteção contra criação excessiva de sessões.
- Sem dinheiro real, pagamentos, depósitos ou saques.
- Os ganhos são definidos pelo PostgreSQL; este jogo é apenas demonstrativo e não deve ser usado como sistema de apostas reais.

## Publicação honesta

Depois de confirmar o teste real, é correto dizer **“frontend Cloudflare integrado a backend serverless com persistência no Neon PostgreSQL”**. Ainda não é correto dizer **“frontend integrado ao backend NestJS/SQS do desafio”**.
