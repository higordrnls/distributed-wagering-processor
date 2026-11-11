/* Frontend standalone demonstrativo: a integração com a API NestJS será feita depois.
   Não há apostas reais, autenticação, saques ou valores monetários. */
"use strict";

const STORAGE_KEY = "tigrinho-de-mentirinha-v1";
const INITIAL = Object.freeze({ balance: 1000, spins: 0, wins: 0, best: 0, bet: 10 });
const SYMBOLS = ["🐯", "⭐", "🍀", "🍊", "🍒", "💎"];
const MULTIPLIERS = { "🐯": 10, "⭐": 6, "🍀": 4, "🍊": 3, "🍒": 3, "💎": 3 };
const $ = (id) => document.getElementById(id);
const reels = [0, 1, 2].map((i) => $("reel-" + i));
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
    return clean;
  } catch { return { ...INITIAL }; }
}
let state = load();
let spinning = false;
let audioContext;
let soundEnabled = false;

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { /* Navegador com armazenamento bloqueado: a sessão ainda funciona. */ }
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
  $("reset-button").disabled = spinning;
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
async function spin() {
  if (spinning || state.balance < state.bet) return;
  spinning = true;
  const bet = state.bet;
  state.balance -= bet;
  state.spins += 1;
  persist();
  reels.forEach((el) => { el.classList.remove("winning"); el.classList.add("spinning"); });
  $("result").classList.remove("win");
  $("result").textContent = "Boa sorte! ✨";
  render();
  const symbols = Array.from({ length: 3 }, () => SYMBOLS[randomIndex(SYMBOLS.length)]);
  // Animação visual: os resultados são definidos uma vez por giro.
  for (let frame = 0; frame < 12; frame++) {
    reels.forEach((el, i) => { el.textContent = SYMBOLS[randomIndex(SYMBOLS.length)]; });
    tone(250 + frame * 24, .035);
    await delay(65 + frame * 9);
  }
  reels.forEach((el, i) => { el.textContent = symbols[i]; el.classList.remove("spinning"); });
  const prize = resultFor(symbols, bet);
  if (prize > 0) {
    state.balance += prize;
    state.wins += 1;
    state.best = Math.max(state.best, prize);
    $("result").textContent = "🎉 Você ganhou " + number(prize) + " moedas!";
    $("result").classList.add("win");
    reels.forEach((el) => el.classList.add("winning"));
    tone(660, .16);
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
  state = { ...INITIAL };
  reels.forEach((el, i) => { el.classList.remove("winning", "spinning"); el.textContent = ["🍊", "⭐", "🍀"][i]; });
  $("result").textContent = "Escolha sua aposta e toque em GIRAR!";
  $("result").classList.remove("win");
  persist(); render();
});
render();
