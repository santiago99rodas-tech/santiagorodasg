// Simulador: un mercado falso con jugadores robot contra el market maker de la casa.
// La "verdad" se conoce: se sortea el ganador según la probabilidad inicial y la información llega
// como señales ruidosas (actualización bayesiana), cada vez más fuertes cerca del cierre. Así la
// probabilidad verdadera es una martingala y el mercado está bien calibrado por construcción.
//
// Usa el mismo motor de órdenes (engine/orderbook.ts) y las mismas fórmulas de cotización
// (engine/quoting.ts) que la plataforma real.

import { OrderBook, type Kind } from "../engine/orderbook.js";
import {
  quoteV1, quoteV2, poolLogOdds, worstCaseLoss, logit, sigmoid, flowUpdate, liquidityFactor,
  type EventState, type QuoteParamsV1, type QuoteParamsV2,
} from "../engine/quoting.js";

export interface Scenario {
  name: string;
  label: string;
  options: number; // 2 = binario Sí/No; más = evento múltiple
  days: number;
  stepHours: number;
  info: number; // intensidad de la información (señales)
  noise: { rate: number; meanUsd: number }; // apostadores casuales (por hora)
  informed: { rate: number; noise: number; edgeCents: number; maxUsd: number; lateBoost: number };
  fans: { rate: number; meanUsd: number }; // siempre al Sí de la opción 0 ("su" país o equipo)
  whales: { rate: number; usd: number; informedShare: number };
  externalRef: boolean; // hay una referencia externa (p. ej. Polymarket) con ruido
  openingNoise: number; // error de la probabilidad de apertura (desvío en log-odds)
}

export interface Strategy {
  name: "v1" | "v2";
  v1: QuoteParamsV1;
  v2: QuoteParamsV2;
  weights: { prev: number; external: number };
  feeBps: number;
}

type Agent = "ruido" | "informado" | "hinchada" | "ballena";
const AGENTS: Agent[] = ["ruido", "informado", "hinchada", "ballena"];

export interface RunResult {
  pnl: number; // resultado de la casa (incluye comisiones)
  fees: number;
  volume: number; // dinero apostado por los jugadores
  peakWorstLoss: number; // mayor pérdida en el peor escenario que llegó a tener la casa
  drawdown: number; // mayor caída del valor de la casa medido con la probabilidad verdadera
  brierOpen: number; // Brier del precio de apertura
  brier1d: number; // Brier del precio 1 día antes del cierre
  errorCents: number; // error medio |precio − verdad| durante la vida del mercado
  halfSpread: number; // medio spread medio que ve el jugador (centavos)
  agents: Record<Agent, number>; // resultado de cada tipo de jugador
}

// ---------- azar reproducible ----------

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  const poisson = (l: number) => { let k = 0, p = Math.exp(-l), s = p; const u = next(); while (u > s && k < 50) { k++; p *= l / k; s += p; } return k; };
  const exp = (mean: number) => -Math.log(1 - next()) * mean;
  return { next, normal, poisson, exp };
}

// ---------- una corrida ----------

export function runMarket(sc: Scenario, st: Strategy, seed: number, trace?: (row: Record<string, unknown>) => void): RunResult {
  const world = rng(seed * 7919 + 1), act = rng(seed * 104729 + 7);
  const n = sc.options;
  const binary = n === 2;
  const books = binary ? 1 : n;

  // Probabilidad inicial y ganador
  let prior: number[];
  if (binary) { const p = 0.1 + 0.8 * world.next(); prior = [p, 1 - p]; }
  else { const w = Array.from({ length: n }, () => Math.exp(0.9 * world.normal())); const s = w.reduce((a, x) => a + x, 0); prior = w.map((x) => x / s); }
  let u = world.next(), winner = 0;
  while (winner < n - 1 && u > prior[winner]) { u -= prior[winner]; winner++; }
  let truth = prior.slice();

  // Apertura con error (IA o moderador)
  const open = prior.map((p) => sigmoid(logit(Math.min(0.97, Math.max(0.03, p))) + sc.openingNoise * world.normal()));
  const openYes = binary ? [open[0]] : (() => { const s = open.reduce((a, x) => a + x, 0); return open.map((x) => x / s); })();
  const fair = openYes.map((p) => Math.round(Math.min(97, Math.max(3, p * 100))));
  let extErr = new Array(books).fill(0).map(() => 0.3 * world.normal());
  let fairExact = openYes.map((p) => Math.min(0.97, Math.max(0.03, p)));

  const house = { yes: new Array(books).fill(0), no: new Array(books).fill(0), cost: new Array(books).fill(0) };
  const agentCash: Record<Agent, number> = { ruido: 0, informado: 0, hinchada: 0, ballena: 0 };
  const agentYes: Record<Agent, number[]> = Object.fromEntries(AGENTS.map((a) => [a, new Array(books).fill(0)])) as any;
  const agentNo: Record<Agent, number[]> = Object.fromEntries(AGENTS.map((a) => [a, new Array(books).fill(0)])) as any;
  const hist: number[][] = Array.from({ length: books }, () => []);
  let fees = 0, volume = 0, spreadSum = 0, spreadN = 0, peakWorst = 0, peakValue = 0, drawdown = 0, errSum = 0, errN = 0;
  let brier1d = NaN;
  const truthYes = () => (binary ? [truth[0]] : truth);
  const brierOf = (pr: number[]) => (binary
    ? (pr[0] - (winner === 0 ? 1 : 0)) ** 2
    : pr.reduce((a, p, i) => a + (p - (i === winner ? 1 : 0)) ** 2, 0) / n);
  const brierOpen = brierOf(openYes);

  const steps = Math.round((sc.days * 24) / sc.stepHours);
  const dt = sc.stepHours / 24;
  let oid = 0;
  const HOUSE = 0;

  for (let step = 0; step < steps; step++) {
    const tau = sc.days - step * dt;

    // 1. Llega información: señal ruidosa por opción, más fuerte cerca del cierre
    const mu = Math.sqrt((sc.info * dt) / Math.max(tau, dt));
    const lp = truth.map((p, i) => Math.log(Math.max(p, 1e-12)) + mu * (mu * (i === winner ? 1 : 0) + world.normal()) - (mu * mu) / 2);
    const m = Math.max(...lp);
    const ex = lp.map((x) => Math.exp(x - m));
    const z = ex.reduce((a, x) => a + x, 0);
    truth = ex.map((x) => x / z);

    // 2. La casa cotiza
    const ev: EventState = {
      kind: binary ? "binary" : "multi",
      tauDays: tau,
      outcomes: fair.map((f, i) => ({ fair: f, yesShares: house.yes[i], noShares: house.no[i], costUsd: house.cost[i], sigma: sigmaOf(hist[i], sc.stepHours) })),
    };
    peakWorst = Math.max(peakWorst, worstCaseLoss(ev));
    const quotes = st.name === "v1" ? quoteV1(ev, st.v1) : quoteV2(ev, st.v2).quotes;
    const book = Array.from({ length: books }, () => new OrderBook());
    for (const q of quotes) book[q.outcome].add({ id: ++oid, ownerId: HOUSE, kind: q.kind as Kind, yesPrice: q.yesPrice, remaining: q.shares * 100 });

    for (const bk of book) { const a = bk.bestAsk(), b = bk.bestBid(); if (a !== undefined && b !== undefined) { spreadSum += (a - b) / 2; spreadN++; } }

    // 3. Llegan los jugadores
    const last: (number | undefined)[] = new Array(books).fill(undefined);
    const flow: number[] = new Array(books).fill(0);
    const take = (agent: Agent, i: number, buyYes: boolean, usd: number, yesLimit: number) => {
      if (usd < 1) return;
      const budget = Math.floor((usd * 1e6) / (1 + st.feeBps / 1e4));
      const r = book[i].match({ id: ++oid, ownerId: 1, kind: buyYes ? "BUY_YES" : "BUY_NO", yesLimit, qty: 1e9, budget });
      for (const f of r.fills) {
        const sh = f.qty / 100;
        const agentPrice = (buyYes ? f.yesPrice : 100 - f.yesPrice) / 100;
        const housePrice = 1 - agentPrice;
        const fee = (sh * agentPrice * st.feeBps) / 1e4;
        agentCash[agent] -= sh * agentPrice + fee;
        fees += fee;
        volume += sh * agentPrice;
        house.cost[i] += sh * housePrice;
        if (buyYes) { agentYes[agent][i] += sh; house.no[i] += sh; } else { agentNo[agent][i] += sh; house.yes[i] += sh; }
        last[i] = f.yesPrice;
        flow[i] += buyYes ? sh : -sh;
      }
    };
    const pick = () => Math.floor(act.next() * books);
    const late = tau < 2 ? 1 + sc.informed.lateBoost : 1;
    const h = sc.stepHours;

    for (let k = act.poisson(sc.noise.rate * h); k > 0; k--) {
      const i = pick();
      take("ruido", i, act.next() < 0.5, act.exp(sc.noise.meanUsd), act.next() < 0.5 ? 99 : 1);
    }
    for (let k = act.poisson(sc.informed.rate * h * late); k > 0; k--) {
      const i = pick();
      const belief = sigmoid(logit(Math.min(0.999, Math.max(0.001, truthYes()[i]))) + sc.informed.noise * act.normal()) * 100;
      const ask = book[i].bestAsk(), bid = book[i].bestBid();
      const e = sc.informed.edgeCents;
      if (ask !== undefined && belief > ask + e) take("informado", i, true, sc.informed.maxUsd * Math.min(1, (belief - ask) / 10), Math.floor(belief - e));
      else if (bid !== undefined && belief < bid - e) take("informado", i, false, sc.informed.maxUsd * Math.min(1, (bid - belief) / 10), Math.ceil(belief + e));
    }
    for (let k = act.poisson(sc.fans.rate * h); k > 0; k--) take("hinchada", 0, true, act.exp(sc.fans.meanUsd), 99);
    for (let k = act.poisson(sc.whales.rate * h); k > 0; k--) {
      const i = pick();
      const informedWhale = act.next() < sc.whales.informedShare;
      const buyYes = informedWhale ? truthYes()[i] * 100 > (book[i].mid() ?? 50) : act.next() < 0.5;
      take("ballena", i, buyYes, sc.whales.usd, buyYes ? 99 : 1);
    }

    // 4. El precio justo se actualiza para la próxima vuelta
    // Referencia externa: la verdad con un error persistente (AR(1), desvío 0,3 en log-odds); llega cada 3 h
    extErr = extErr.map((e) => 0.95 * e + 0.3 * Math.sqrt(1 - 0.95 ** 2) * world.normal());
    const ext = sc.externalRef && step % Math.max(1, Math.round(3 / sc.stepHours)) === 0
      ? truthYes().map((p, i) => sigmoid(logit(Math.min(0.995, Math.max(0.005, p))) + extErr[i])) : undefined;
    if (st.name === "v1") {
      for (let i = 0; i < books; i++) {
        if (last[i] !== undefined) fair[i] = Math.round(0.6 * fair[i] + 0.4 * last[i]!);
        fair[i] = Math.max(2, Math.min(98, fair[i]));
      }
      if (!binary) {
        const s = fair.reduce((a, x) => a + x, 0);
        if (Math.abs(s - 100) > 3) for (let i = 0; i < n; i++) fair[i] = Math.max(2, Math.min(98, Math.round((fair[i] * 100) / s)));
      }
    } else {
      const b = st.v2.bShares * liquidityFactor(tau, st.v2);
      fairExact = flowUpdate(binary ? "binary" : "multi", fairExact, flow, b);
      if (ext) fairExact = fairExact.map((f, i) => poolLogOdds([{ p: f, w: st.weights.prev }, { p: ext[i], w: st.weights.external }]));
      if (!binary) { const z = fairExact.reduce((a, x) => a + x, 0); fairExact = fairExact.map((x) => x / z); }
      fairExact = fairExact.map((f) => Math.min(0.98, Math.max(0.02, f)));
      for (let i = 0; i < books; i++) fair[i] = fairExact[i] * 100;
    }
    for (let i = 0; i < books; i++) hist[i].push(logit(fair[i] / 100));

    // 5. Métricas con la probabilidad verdadera
    const ty = truthYes();
    for (let i = 0; i < books; i++) { errSum += Math.abs(fair[i] - ty[i] * 100); errN++; }
    let value = fees;
    for (let i = 0; i < books; i++) value += house.yes[i] * ty[i] + house.no[i] * (1 - ty[i]) - house.cost[i];
    peakValue = Math.max(peakValue, value);
    drawdown = Math.max(drawdown, peakValue - value);
    trace?.({ step, truth: Math.round(ty[0] * 100), fair: fair[0], bid: book[0].bestBid(), ask: book[0].bestAsk(), yes: Math.round(house.yes[0]), no: Math.round(house.no[0]), cost: Math.round(house.cost[0]), value: Math.round(value) });
    if (Number.isNaN(brier1d) && tau - dt <= 1) brier1d = brierOf(fair.map((f) => f / 100));
  }

  // Resolución: $1 por acción ganadora
  const pays = (i: number) => (binary ? winner === 0 : winner === i);
  let pnl = fees;
  for (let i = 0; i < books; i++) pnl += (pays(i) ? house.yes[i] : house.no[i]) - house.cost[i];
  const agents = {} as Record<Agent, number>;
  for (const a of AGENTS) {
    let v = agentCash[a];
    for (let i = 0; i < books; i++) v += pays(i) ? agentYes[a][i] : agentNo[a][i];
    agents[a] = v;
  }
  return { pnl, fees, volume, peakWorstLoss: peakWorst, drawdown, brierOpen, brier1d, errorCents: errSum / Math.max(1, errN), halfSpread: spreadSum / Math.max(1, spreadN), agents };
}

/** Volatilidad del log-odds por √día con las últimas 24 h de precios. */
function sigmaOf(h: number[], stepHours: number) {
  const k = Math.max(2, Math.round(24 / stepHours));
  if (h.length < 3) return undefined;
  const xs = h.slice(-k - 1);
  let ss = 0;
  for (let i = 1; i < xs.length; i++) ss += (xs[i] - xs[i - 1]) ** 2;
  const days = ((xs.length - 1) * stepHours) / 24;
  return Math.sqrt(ss / days);
}

// ---------- muchas corridas ----------

export interface Summary {
  runs: number;
  pnlMean: number; pnlP5: number; pnlWorst: number; lossShare: number;
  feesMean: number; volumeMean: number; margin: number;
  peakWorstMean: number; peakWorstMax: number; drawdownMean: number;
  brierOpen: number; brier1d: number; errorCents: number; halfSpread: number;
  agents: Record<Agent, number>;
}

export function runMany(sc: Scenario, st: Strategy, runs: number, seed = 1): Summary {
  const rs: RunResult[] = [];
  for (let r = 0; r < runs; r++) rs.push(runMarket(sc, st, seed + r));
  const mean = (f: (r: RunResult) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  const pnls = rs.map((r) => r.pnl).sort((a, b) => a - b);
  const vol = mean((r) => r.volume);
  return {
    runs,
    pnlMean: mean((r) => r.pnl),
    pnlP5: pnls[Math.floor(0.05 * (pnls.length - 1))],
    pnlWorst: pnls[0],
    lossShare: rs.filter((r) => r.pnl < 0).length / rs.length,
    feesMean: mean((r) => r.fees),
    volumeMean: vol,
    margin: vol ? mean((r) => r.pnl) / vol : 0,
    peakWorstMean: mean((r) => r.peakWorstLoss),
    peakWorstMax: Math.max(...rs.map((r) => r.peakWorstLoss)),
    drawdownMean: mean((r) => r.drawdown),
    brierOpen: mean((r) => r.brierOpen),
    brier1d: mean((r) => r.brier1d),
    errorCents: mean((r) => r.errorCents),
    halfSpread: mean((r) => r.halfSpread),
    agents: Object.fromEntries(AGENTS.map((a) => [a, mean((r) => r.agents[a])])) as Record<Agent, number>,
  };
}

// ---------- escenarios ----------

const base: Scenario = {
  name: "normal", label: "Normal (mayoría casual)", options: 2, days: 30, stepHours: 1, info: 2.5,
  noise: { rate: 3, meanUsd: 15 },
  informed: { rate: 0.4, noise: 0.35, edgeCents: 2, maxUsd: 150, lateBoost: 0 },
  fans: { rate: 0, meanUsd: 25 },
  whales: { rate: 0.01, usd: 800, informedShare: 0.3 },
  externalRef: false, openingNoise: 0.4,
};

export const SCENARIOS: Scenario[] = [
  base,
  { ...base, name: "informados", label: "Muchos informados", noise: { rate: 1.5, meanUsd: 15 }, informed: { ...base.informed, rate: 2, noise: 0.2 } },
  { ...base, name: "cierre", label: "Noticia de último minuto", info: 4, informed: { ...base.informed, rate: 0.6, lateBoost: 6 } },
  { ...base, name: "hinchada", label: "Hinchada (todo al Sí)", fans: { rate: 2, meanUsd: 25 }, informed: { ...base.informed, rate: 0.8 } },
  { ...base, name: "ballenas", label: "Ballenas", whales: { rate: 0.06, usd: 1500, informedShare: 0.6 } },
  { ...base, name: "multi5", label: "Múltiple, 5 opciones", options: 5, noise: { rate: 5, meanUsd: 15 }, informed: { ...base.informed, rate: 1 }, fans: { rate: 0.8, meanUsd: 25 } },
  { ...base, name: "referencia", label: "Con referencia externa", externalRef: true, informed: { ...base.informed, rate: 1 } },
];
