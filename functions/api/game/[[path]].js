// Server-side only: DATABASE_URL must be a Cloudflare secret.
// Neon SQL-over-HTTP. No database credentials reach the browser.
const COOKIE = "tigrinho_session";
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
async function query(connection, query, params = []) {
  const parsed = new URL(connection);
  if (!["postgresql:", "postgres:"].includes(parsed.protocol) || !parsed.hostname.endsWith(".neon.tech")) throw new Error("Invalid database host");
  const response = await fetch("https://" + parsed.hostname + "/sql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Neon-Connection-String": connection },
    body: JSON.stringify({ query, params }),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.message || "Database request failed");
  }
  const result = await response.json();
  return result.rows || [];
}
const hex = (bytes) => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
async function hash(value) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
function getCookie(request) {
  const cookies = request.headers.get("Cookie") || "";
  return cookies.split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) || null;
}
function makeCookie(token) { return COOKIE + "=" + token + "; HttpOnly; Secure; SameSite=Lax; Path=/api/game; Max-Age=2592000"; }
function validToken(token) { return typeof token === "string" && /^[0-9a-f]{64}$/.test(token); }
function normalize(row) {
  return { balance: Number(row.balance), spins: Number(row.spins), wins: Number(row.wins), best: Number(row.best) };
}
export async function onRequest({ request, env }) {
  const path = new URL(request.url).pathname;
  if (!["/api/game/session", "/api/game/spin", "/api/game/reset"].includes(path)) return json({ message: "Rota inexistente" }, 404);
  if (!env.DATABASE_URL) return json({ message: "Jogo online ainda não configurado" }, 503);
  try {
    if (path === "/api/game/session" && request.method === "GET") {
      const token = getCookie(request);
      if (validToken(token)) {
        const rows = await query(env.DATABASE_URL, "SELECT balance,spins,wins,best FROM game_players WHERE token_hash=$1", [await hash(token)]);
        if (rows.length) {
          const history = await query(env.DATABASE_URL,
            "SELECT symbols,bet,prize FROM game_rounds WHERE player_id=(SELECT id FROM game_players WHERE token_hash=$1) ORDER BY created_at DESC,id DESC LIMIT 5",
            [await hash(token)]);
          return json({ ...normalize(rows[0]), history });
        }
      }
      const newToken = hex(crypto.getRandomValues(new Uint8Array(32)));
      const id = crypto.randomUUID();
      const rows = await query(env.DATABASE_URL,
        "INSERT INTO game_players(id,token_hash) VALUES($1,$2) RETURNING balance,spins,wins,best",
        [id, await hash(newToken)]);
      return json(normalize(rows[0]), 200, { "Set-Cookie": makeCookie(newToken) });
    }
    if (path === "/api/game/reset" && request.method === "POST") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== new URL(request.url).origin) return json({ message: "Origem não autorizada" }, 403);
      const token = getCookie(request);
      if (!validToken(token)) return json({ message: "Sessão expirada. Atualize a página." }, 401);
      const previous = await query(env.DATABASE_URL, "SELECT id FROM game_players WHERE token_hash=$1", [await hash(token)]);
      if (!previous.length) return json({ message: "Sessão não encontrada" }, 401);
      // Uma nova carteira preserva o histórico antigo no banco para auditoria.
      // O token anterior deixa de ser usado pelo navegador.
      const newToken = hex(crypto.getRandomValues(new Uint8Array(32)));
      const rows = await query(env.DATABASE_URL,
        "INSERT INTO game_players(id,token_hash) VALUES($1,$2) RETURNING balance,spins,wins,best",
        [crypto.randomUUID(), await hash(newToken)]);
      return json(normalize(rows[0]), 200, { "Set-Cookie": makeCookie(newToken) });
    }
    if (path === "/api/game/spin" && request.method === "POST") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== new URL(request.url).origin) return json({ message: "Origem não autorizada" }, 403);
      const token = getCookie(request);
      if (!validToken(token)) return json({ message: "Sessão expirada. Atualize a página." }, 401);
      const body = await request.json().catch(() => null);
      if (!body || ![10,25,50,100].includes(body.bet) ||
          typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))
        return json({ message: "Rodada inválida" }, 400);
      const rows = await query(env.DATABASE_URL, "SELECT game_spin($1,$2::uuid,$3) AS result", [await hash(token), body.requestId, body.bet]);
      return json(rows[0].result);
    }
    return json({ message: "Método não permitido" }, 405);
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("INSUFFICIENT_BALANCE")) return json({ message: "Saldo insuficiente" }, 422);
    if (message.includes("SESSION_NOT_FOUND")) return json({ message: "Sessão não encontrada" }, 401);
    if (message.includes("IDEMPOTENCY_CONFLICT")) return json({ message: "Rodada já utilizada com outra aposta" }, 409);
    console.error("game_api_error", { path, error: message.slice(0, 100) });
    return json({ message: "Não foi possível processar. Tente novamente." }, 503);
  }
}
