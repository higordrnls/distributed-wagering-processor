/* Frontend standalone demonstrativo: a integração com a API NestJS será feita depois.
   Não há apostas reais, autenticação, saques ou valores monetários. */
"use strict";

const STORAGE_KEY = "tigrinho-de-mentirinha-v1";
const INITIAL = Object.freeze({ balance: 1000, spins: 0, wins: 0, best: 0, bet: 10, history: [] });
const SYMBOLS = ["🐯", "⭐", "🍀", "🍊", "🍒", "💎"];
const MULTIPLIERS = { "🐯": 10, "⭐": 6, "🍀": 4, "🍊": 3, "🍒": 3, "💎": 3 };
const $ = (id) => document.getElementById(id);
const reels = [0, 1, 2].map((i) => $("reel-" + i));
const reelSymbols = reels.map((el) => el.querySelector(".reel-symbol"));
const betButtons = [...document.querySelectorAll("[data-bet]")];
const number = (n) => n.toLocaleString("pt-BR");

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!parsed || typeof parsed !== "object") return { ...INITIAL };
    const clean = {};
    for (const key of ["balance", "spins", "wins", "best"]) {
      if (!Number.isSafeInteger(parsed[key]) || parsed[key] < 0) return { ...INITIAL };
      clean[key] = parsed[key];
    }
    clean.bet = [10, 25, 50, 100].includes(parsed.bet) ? parsed.bet : 10;
    clean.history = Array.isArray(parsed.history) ? parsed.history.filter((item) => item && Array.isArray(item.symbols) && item.symbols.length === 3 && item.symbols.every((s) => SYMBOLS.includes(s)) && Number.isSafeInteger(item.bet) && item.bet > 0 && Number.isSafeInteger(item.prize) && item.prize >= 0).slice(0, 5) : [];
    return clean;
  } catch { return { ...INITIAL }; }
}
let state = load();
let online = false;
let onlineError = false;
let pendingRequestId = null;
let spinning = false;
let audioContext;
let soundEnabled = false;

function persist() {
  if (online) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { /* Navegador com armazenamento bloqueado: a sessão ainda funciona. */ }
}
function renderHistory() {
  const list = $("history-list");
  list.replaceChildren();
  if (!state.history.length) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "Suas rodadas aparecerão aqui ✨";
    list.append(empty);
    return;
  }
  for (const item of state.history) {
    const row = document.createElement("li");
    const symbols = document.createElement("span");
    symbols.className = "history-symbols";
    symbols.textContent = item.symbols.join(" ");
    const amount = document.createElement("span");
    amount.className = item.prize ? "history-prize" : "history-loss";
    amount.textContent = item.prize ? "+" + number(item.prize) + " moedas" : "−" + number(item.bet) + " moedas";
    row.append(symbols, amount);
    list.append(row);
  }
}
function render() {
  $("balance").textContent = number(state.balance);
  $("spins").textContent = number(state.spins);
  $("wins").textContent = number(state.wins);
  $("best").textContent = number(state.best);
  const canSpin = state.balance >= state.bet;
  $("spin-button").disabled = spinning || !canSpin;
  $("spin-button").innerHTML = spinning ? "GIRANDO…" : '<span aria-hidden="true">▶</span> GIRAR';
  $("spin-hint").textContent = canSpin ? "Cada giro custa " + state.bet + " moedas virtuais." : "Saldo insuficiente. Toque em Recomeçar para jogar novamente.";
  for (const button of betButtons) {
    const active = Number(button.dataset.bet) === state.bet;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = spinning;
  }
  $("reset-button").disabled = spinning || online;
  renderHistory();
}
function randomIndex(max) {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    const range = 0x100000000;
    const limit = range - (range % max);
    let value;
    do { globalThis.crypto.getRandomValues(values); value = values[0]; } while (value >= limit);
    return value % max;
  }
  return Math.floor(Math.random() * max);
}
function resultFor(symbols, bet) {
  if (symbols.every((s) => s === symbols[0])) return bet * MULTIPLIERS[symbols[0]];
  if (symbols.filter((s) => s === "🐯").length === 2) return bet * 2;
  return 0;
}
function tone(freq, duration = .08) {
  if (!soundEnabled) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = "sine"; osc.frequency.value = freq;
    gain.gain.setValueAtTime(.035, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
    osc.connect(gain); gain.connect(audioContext.destination);
    osc.start(); osc.stop(audioContext.currentTime + duration);
  } catch { /* Som é opcional. */ }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function celebrate() {
  const layer = $("celebration");
  layer.replaceChildren();
  const shapes = ["✨", "⭐", "🟡", "🎊"];
  for (let i = 0; i < 18; i++) {
    const item = document.createElement("span");
    item.className = "confetti";
    item.textContent = shapes[randomIndex(shapes.length)];
    item.style.setProperty("--x", (randomIndex(95) + 2) + "%");
    item.style.setProperty("--delay", (randomIndex(450) / 1000) + "s");
    item.style.setProperty("--size", (14 + randomIndex(15)) + "px");
    layer.append(item);
  }
  $("machine").classList.remove("big-win");
  void $("machine").offsetWidth;
  $("machine").classList.add("big-win");
  setTimeout(() => { layer.replaceChildren(); $("machine").classList.remove("big-win"); }, 2300);
}

async function spin() {
  if (spinning || state.balance < state.bet) return;
  spinning = true;
  const bet = state.bet;
  // A rodada é registrada somente após a animação: atualizar a página
  // durante o giro não deve cobrar uma aposta sem concluir o resultado.
  reels.forEach((el) => { el.classList.remove("winning", "stopping"); el.classList.add("spinning"); });
  $("celebration").replaceChildren();
  $("result").classList.remove("win");
  $("result").textContent = "Boa sorte! ✨";
  render();
  let serverRound = null;
  if (online) {
    pendingRequestId ||= crypto.randomUUID();
    try {
      serverRound = await TigrinhoAPI.spin(bet, pendingRequestId);
    } catch (error) {
      $("result").textContent = error.message || "Falha na conexão. Tente novamente.";
      reels.forEach(el => el.classList.remove("spinning"));
      spinning = false; render(); return;
    }
  }
  const symbols = serverRound ? serverRound.symbols : Array.from({ length: 3 }, () => SYMBOLS[randomIndex(SYMBOLS.length)]);
  // Resultados fixados antes da animação; cada rolo para em um instante diferente.
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!reducedMotion) {
    for (let frame = 0; frame < 20; frame++) {
      for (let i = 0; i < 3; i++) {
        if (frame < 8 + i * 6) reelSymbols[i].textContent = SYMBOLS[randomIndex(SYMBOLS.length)];
      }
      if (frame === 8 || frame === 14 || frame === 19) {
        const index = frame === 8 ? 0 : frame === 14 ? 1 : 2;
        reelSymbols[index].textContent = symbols[index];
        reels[index].classList.remove("spinning");
        reels[index].classList.add("stopping");
        tone(440 + index * 130, .12);
      }
      await delay(75);
    }
  }
  reels.forEach((el, i) => {
    reelSymbols[i].textContent = symbols[i];
    el.classList.remove("spinning", "stopping");
  });
  const prize = serverRound ? Number(serverRound.prize) : resultFor(symbols, bet);
  if (serverRound) {
    state.balance = Number(serverRound.balance);
    state.spins = Number(serverRound.spins);
    state.wins = Number(serverRound.wins);
    state.best = Number(serverRound.best);
    pendingRequestId = null;
  } else {
    state.balance = state.balance - bet + prize;
    state.spins += 1;
  }
  state.history = [{ symbols, bet, prize }, ...state.history].slice(0, 5);
  if (prize > 0) {
    if (!serverRound) { state.wins += 1; state.best = Math.max(state.best, prize); }
    $("result").textContent = "🎉 Você ganhou " + number(prize) + " moedas!";
    $("result").classList.add("win");
    reels.forEach((el) => el.classList.add("winning"));
    tone(660, .16);
    celebrate();
  } else {
    $("result").textContent = "Não foi dessa vez! Tente outro giro 🍀";
  }
  persist();
  spinning = false;
  render();
}
betButtons.forEach((button) => button.addEventListener("click", () => {
  if (spinning) return;
  state.bet = Number(button.dataset.bet);
  persist(); render(); tone(440);
}));
$("spin-button").addEventListener("click", spin);
$("sound-toggle").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  $("sound-toggle").textContent = soundEnabled ? "🔊" : "🔇";
  $("sound-toggle").setAttribute("aria-pressed", String(soundEnabled));
  $("sound-toggle").setAttribute("aria-label", soundEnabled ? "Desativar som" : "Ativar som");
  tone(520);
});
$("reset-button").addEventListener("click", () => $("reset-dialog").showModal());
$("reset-dialog").addEventListener("close", () => {
  if ($("reset-dialog").returnValue !== "confirm") return;
  state = { ...INITIAL, history: [] };
  reels.forEach((el, i) => { el.classList.remove("winning", "spinning", "stopping"); reelSymbols[i].textContent = ["🍊", "⭐", "🍀"][i]; });
  $("celebration").replaceChildren();
  $("machine").classList.remove("big-win");
  $("result").textContent = "Escolha sua aposta e toque em GIRAR!";
  $("result").classList.remove("win");
  persist(); render();
});
render();

async function connectGame() {
  try {
    const session = await TigrinhoAPI.session();
    online = true;
    state = { ...INITIAL, ...session, history: [] };
    $("reset-button").hidden = true;
    $("result").textContent = "Conectado! Suas moedas agora são salvas no servidor. 🟢";
    render();
  } catch (error) {
    // Modo local só é usado antes de habilitar o backend no ambiente.
    // Não migrar saldo local automaticamente para o banco.
    $("result").textContent = "Modo demonstração local · " + (error.message || "Servidor indisponível");
    render();
  }
}
connectGame();
