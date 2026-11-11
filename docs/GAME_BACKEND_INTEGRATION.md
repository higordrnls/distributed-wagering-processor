# Integração do jogo com o backend financeiro

## Estado atual

O frontend está publicado na Cloudflare Pages e usa moedas virtuais em `localStorage`. Foi adicionado um cliente HTTP para `/api/game/session` e `/api/game/spin`, além de uma Pages Function que **retorna 503 enquanto o gateway não estiver configurado**. Isso é intencional: a API NestJS não possui autenticação para exposição pública.

**O jogo continua funcionando no modo local. Não há integração financeira ativa em produção.**

## Contrato proposto

### GET /api/game/session

Resposta de sucesso: `{ "balance": 1000, "spins": 0, "wins": 0, "best": 0 }`.

### POST /api/game/spin

Corpo: `{ "bet": 10, "requestId": "uuid" }`.

Resposta de sucesso: `{ "symbols": ["🍊","⭐","🍀"], "prize": 0, "balance": 990, "spins": 1, "wins": 0, "best": 0 }`.

A camada de jogo deve validar o valor da aposta, autenticar a sessão, aplicar rate limiting, definir o resultado no servidor, processar BET e WIN/LOSS com IDs idempotentes e retornar o saldo confirmado. Um mesmo `requestId` precisa retornar o mesmo resultado sem novo débito.

## Requisitos antes de ativar

1. Hospedar NestJS, PostgreSQL e infraestrutura de mensageria compatível, com segredos privados.
2. Implementar gateway seguro de jogo, com cookies de sessão HttpOnly/Secure/SameSite e proteção contra abuso.
3. Nunca expor `POST /wallets` ou a API financeira diretamente a usuários anônimos.
4. Tratar rodada como unidade de negócio: evitar debitar BET sem concluir o resultado e oferecer recuperação de rodadas interrompidas.
5. Integrar o frontend ao contrato acima, com indicador de indisponibilidade e sem trocar silenciosamente para saldo local.
6. Executar testes end-to-end, concorrência, idempotência, refresh e falhas de rede antes do deploy.

Os créditos são fictícios: sem dinheiro real, depósitos ou saques.
