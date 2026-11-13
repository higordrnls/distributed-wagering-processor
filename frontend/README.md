# Tigrinho de Mentirinha — frontend mobile-first

Caça-níquel **fictício**, com moedas virtuais, desenvolvido como interface lúdica para o projeto Distributed Wagering Processor.

## Estado atual

- Layout responsivo, priorizando telas de celular.
- Três rolos animados, apostas de 10/25/50/100 moedas, prêmios e estatísticas.
- Saldo, estatísticas e histórico das últimas cinco rodadas persistidos em `localStorage` no mesmo navegador.
- Rodadas registradas somente após a animação, evitando debitar uma aposta incompleta se a página for atualizada durante o giro.
- Respeita a preferência de movimento reduzido do dispositivo.
- Botão de reinício e opção de áudio.
- Sem login, pagamentos, depósitos, saques ou dinheiro real.

**Importante:** esta primeira versão é uma demonstração frontend independente. Os giros e saldos são calculados **no navegador**, não na API NestJS. O objetivo da próxima etapa é integrar o frontend ao backend, com resultado da rodada determinado pelo servidor e transações BET/WIN/LOSS persistidas. Não usar esta versão para demonstrar garantias reais de consistência financeira ou segurança.

## Cloudflare Pages

Este frontend é estático, sem build e sem dependências. No Cloudflare Pages, conectar o repositório e configurar:

- Framework preset: `None`
- Build command: deixar vazio
- Build output directory: `frontend`

Para pré-visualização local, basta servir a pasta `frontend` com um servidor HTTP estático. Nenhum container ou banco é necessário para esta etapa.

## Próximos passos

1. Integrar API NestJS via endpoints de sessão e rodada, com geração de resultado no servidor.
2. Hospedar API, PostgreSQL e mensageria em serviços compatíveis.
3. Adicionar identidade de jogador e salvamento de progresso entre dispositivos.
4. Definir limites de uso e proteção dos endpoints públicos.

<!-- Cloudflare Pages: deployment refresh after production DATABASE_URL secret configuration, 2026-11-13. -->
