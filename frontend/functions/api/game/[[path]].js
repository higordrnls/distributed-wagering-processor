/* Cloudflare Pages Function: proxy de integração, desabilitado até existir
   gateway de jogo autenticado, com sessões e resultados autoritativos.
   Não encaminhar requests diretamente aos endpoints /wallets e
   /wagering/transactions da API NestJS. */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname.slice("/api/game".length);
  if (!["/session", "/spin"].includes(path)) {
    return Response.json({ message: "Rota inexistente" }, { status: 404 });
  }
  return Response.json({
    code: "GAME_GATEWAY_NOT_CONFIGURED",
    message: "O modo online ainda não foi ativado. O jogo local continua disponível."
  }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
