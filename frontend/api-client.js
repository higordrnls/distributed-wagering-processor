/* Cliente HTTP para o gateway do jogo.
   A API financeira não deve ser chamada diretamente pelo navegador. */
"use strict";
globalThis.TigrinhoAPI = (() => {
  const endpoint = "/api/game";
  async function request(path, options = {}) {
    const response = await fetch(endpoint + path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      ...options,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || "Não foi possível comunicar com o servidor.");
    return body;
  }
  return {
    session: () => request("/session"),
    reset: () => request("/reset", { method: "POST" }),
    spin: (bet, requestId) => request("/spin", { method: "POST", body: JSON.stringify({ bet, requestId }) }),
  };
})();
