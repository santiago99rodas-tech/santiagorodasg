// Matemática del market maker de la casa. Módulo puro (sin base de datos): lo usan el market maker
// real (services/marketmaker.ts) y el simulador (src/sim/), así lo que se prueba es lo que se ejecuta.
//
// v1: precio justo con media móvil, spread fijo y corrimiento simple por inventario.
// v2:
//   1. Precio justo combinando fuentes en log-odds (poolLogOdds).
//   2. Niveles de cotización sacados de la curva LMSR: el precio se mueve con lo que los jugadores
//      ya compraron, las opciones de un evento múltiple suman 100% y la pérdida del tramo LMSR
//      tiene techo b·ln(1/π) (b·ln n con probabilidades iguales).
//   3. Spread al estilo Avellaneda-Stoikov en log-odds: ½·γ·σ²·h + (1/γ)·ln(1 + γ/κ).
//   4. Liquidez que baja con la raíz del tiempo al cierre: b y el tamaño por nivel escalan con √(τ/τref).
//   5. Límites duros: pérdida en el peor escenario por evento y total, y botón de pánico.

export type QuoteKind = "BUY_YES" | "BUY_NO";

export interface Quote {
  outcome: number; // índice del mercado (opción) dentro del evento
  kind: QuoteKind; // BUY_YES = puja por Sí (bid); BUY_NO = oferta de Sí (ask)
  yesPrice: number; // centavos 1..99 en espacio Sí
  shares: number; // acciones enteras
}

export interface OutcomeState {
  fair: number; // precio justo del Sí en centavos (1..99)
  yesShares: number; // acciones Sí que tiene la casa en este mercado
  noShares: number; // acciones No que tiene la casa
  costUsd: number; // lo que la casa pagó por esas acciones (sin contar lo ya realizado)
  sigma?: number; // volatilidad observada del log-odds por √día (opcional)
  imbalance?: number; // desequilibrio del flujo reciente de jugadores, −1 (todo No) a 1 (todo Sí)
  shock?: boolean; // freno de emergencia o noticia reciente: más spread y menos tamaño
}

export interface EventState {
  kind: "binary" | "multi";
  tauDays: number; // días hasta el cierre
  outcomes: OutcomeState[]; // binario: un solo mercado; múltiple: un mercado por opción
}

export interface QuoteParamsV1 {
  spreadCents: number;
  levels: number;
  levelSizeShares: number;
  maxExposureUsd: number;
}

export interface QuoteParamsV2 {
  levels: number;
  levelSizeShares: number; // tamaño por nivel con liquidez completa
  bShares: number; // profundidad LMSR con liquidez completa (acciones)
  minLiquidity: number; // fracción mínima de liquidez cerca del cierre (0..1)
  tauRefDays: number; // con más de esto al cierre la liquidez es completa
  gamma: number; // aversión al riesgo
  kappa: number; // qué tan rápido cae la llegada de órdenes al alejarse del precio
  sigmaFloor: number; // volatilidad mínima del log-odds (por √día) si faltan datos
  holdDays: number; // horizonte en que la casa espera rotar su inventario
  minHalfSpreadCents: number;
  maxLossUsd: number; // pérdida máxima en el peor escenario por evento
  riskOff?: boolean; // límite total superado: solo cotiza lo que reduce el riesgo
  // Protección contra informados (engine/toxicity.ts); sin esto no hay ajuste
  imbalanceSpread?: number; // log-odds extra de medio spread, del lado golpeado, con todo el flujo a un lado
  shockSpreadMult?: number;
  shockSizeFactor?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const logit = (p: number) => Math.log(p / (1 - p));
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const toProb = (cents: number) => clamp(cents, 0.5, 99.5) / 100;

/**
 * Combina probabilidades en log-odds: logit(p) = Σ wᵢ·logit(pᵢ) / Σ wᵢ.
 * 90% y 50% con el mismo peso dan 75% (el promedio simple daría 70%): respeta que pasar de 50% a 90%
 * es mucha más convicción de lo que parece en porcentaje.
 */
export function poolLogOdds(sources: { p: number; w: number }[]): number {
  const valid = sources.filter((s) => s.w > 0 && Number.isFinite(s.p));
  const W = valid.reduce((a, s) => a + s.w, 0);
  if (!W) throw new Error("poolLogOdds: sin fuentes");
  return sigmoid(valid.reduce((a, s) => a + s.w * logit(clamp(s.p, 0.005, 0.995)), 0) / W);
}

// ---------- LMSR ----------

function logSumExp(xs: number[]) {
  const m = Math.max(...xs);
  return m + Math.log(xs.reduce((a, x) => a + Math.exp(x - m), 0));
}

/** Función de costo C(s) = b·ln Σ πᵢ·e^(sᵢ/b), con s = acciones netas que compraron los jugadores. */
export function lmsrCost(s: number[], logPrior: number[], b: number) {
  return b * logSumExp(s.map((si, i) => logPrior[i] + si / b));
}

export function lmsrPrices(s: number[], logPrior: number[], b: number) {
  const xs = s.map((si, i) => logPrior[i] + si / b);
  const z = logSumExp(xs);
  return xs.map((x) => Math.exp(x - z));
}

/** Precio promedio por acción de comprar (Δ > 0) o vender (Δ < 0) |Δ| acciones de la opción i. */
export function lmsrAvgPrice(s: number[], logPrior: number[], b: number, i: number, delta: number) {
  const s2 = s.slice();
  s2[i] += delta;
  return (lmsrCost(s2, logPrior, b) - lmsrCost(s, logPrior, b)) / delta;
}

/** Pérdida máxima del tramo LMSR si gana la opción menos probable: b·ln(1/π_min) (b·ln n si son iguales). */
export const lmsrMaxLoss = (prior: number[], b: number) => b * Math.log(1 / Math.min(...prior));

/**
 * Aprendizaje del flujo (LMSR): cada acción Sí neta que compran los jugadores sube el log-odds en 1/b.
 * Es la curva LMSR aplicada paso a paso: el precio justo queda donde lo dejó el dinero y la casa
 * pierde a lo sumo b·ln(1/π) por el tramo, aunque todos los que compraron tuvieran razón.
 * fair en probabilidad (0..1); flow = acciones Sí netas de jugadores por opción (compras − ventas).
 */
export function flowUpdate(kind: "binary" | "multi", fair: number[], flow: number[], b: number): number[] {
  if (kind === "binary") return [sigmoid(logit(clamp(fair[0], 0.005, 0.995)) + flow[0] / b)];
  const xs = fair.map((f, i) => Math.log(clamp(f, 0.001, 0.999)) + (flow[i] ?? 0) / b);
  const z = logSumExp(xs);
  return xs.map((x) => Math.exp(x - z));
}

// ---------- Riesgo ----------

/**
 * Resultado de la casa en cada escenario (gana la opción w), en dólares: lo que cobra menos lo que pagó.
 * Binario: escenario 0 = gana Sí, 1 = gana No. Múltiple: escenario w = gana la opción w.
 */
export function scenarioPnl(ev: EventState): number[] {
  const cost = ev.outcomes.reduce((a, o) => a + o.costUsd, 0);
  if (ev.kind === "binary") {
    const o = ev.outcomes[0];
    return [o.yesShares - cost, o.noShares - cost];
  }
  return ev.outcomes.map((_, w) =>
    ev.outcomes.reduce((a, o, i) => a + (i === w ? o.yesShares : o.noShares), 0) - cost);
}

export const worstCaseLoss = (ev: EventState) => Math.max(0, -Math.min(...scenarioPnl(ev)));

/** Una cotización que, si se llena, empeora el escenario donde la casa más pierde. */
function worsensWorst(ev: EventState, q: { outcome: number; kind: QuoteKind }) {
  const pnl = scenarioPnl(ev);
  const w = pnl.indexOf(Math.min(...pnl));
  if (ev.kind === "binary") return w === 0 ? q.kind === "BUY_NO" : q.kind === "BUY_YES";
  // Gana w: le conviene tener Sí de w y No de las demás
  return q.outcome === w ? q.kind === "BUY_NO" : q.kind === "BUY_YES";
}

// ---------- v1 ----------

export function quoteV1(ev: EventState, p: QuoteParamsV1): Quote[] {
  const half = Math.ceil(p.spreadCents / 2);
  const out: Quote[] = [];
  ev.outcomes.forEach((o, idx) => {
    const net = o.yesShares - o.noShares;
    const skew = clamp(Math.round(net / (p.levelSizeShares * 2)), -5, 5); // largo en Sí => baja precios
    const fair = clamp(o.fair - skew, 2, 98);
    const overLimit = o.costUsd > p.maxExposureUsd;
    for (let i = 0; i < p.levels; i++) {
      const bidYes = fair - half - i, askYes = fair + half + i;
      if (bidYes >= 1 && !(overLimit && net > 0)) out.push({ outcome: idx, kind: "BUY_YES", yesPrice: bidYes, shares: p.levelSizeShares });
      if (askYes <= 99 && !(overLimit && net < 0)) out.push({ outcome: idx, kind: "BUY_NO", yesPrice: askYes, shares: p.levelSizeShares });
    }
  });
  return out;
}

// ---------- v2 ----------

export interface V2Diagnostics {
  liquidity: number; // fracción de liquidez por el tiempo al cierre (0..1)
  b: number; // profundidad LMSR efectiva (acciones)
  halfSpreadLogit: number;
  halfSpreadCents: number; // a 50%, para mostrar
  prices: number[]; // precio LMSR (centavos) de cada opción, ya con inventario
  lmsrMaxLossUsd: number; // techo de pérdida del tramo LMSR desde el estado actual
  worstCaseLossUsd: number; // pérdida actual de la casa en el peor escenario
  limited: boolean; // superó un límite: solo cotiza lo que reduce el riesgo
  shock: boolean; // freno de emergencia activo
}

/** Fracción de liquidez según el tiempo al cierre: √(τ/τref), con un mínimo. */
export const liquidityFactor = (tauDays: number, p: Pick<QuoteParamsV2, "tauRefDays" | "minLiquidity">) =>
  clamp(Math.sqrt(Math.max(0, tauDays) / p.tauRefDays), p.minLiquidity, 1);

/**
 * Medio spread en log-odds (Avellaneda-Stoikov): ½·γ·σ²·h + (1/γ)·ln(1 + γ/κ).
 * Si no hay volatilidad observada se usa un piso que crece cerca del cierre (σ² ∝ 1/τ): en un mercado
 * de predicción la información llega cada vez más rápido a medida que se acerca el resultado.
 */
export function halfSpreadLogit(tauDays: number, sigma: number | undefined, p: QuoteParamsV2) {
  const floor2 = (p.sigmaFloor * p.sigmaFloor) / Math.max(tauDays, 1 / 24);
  const s2 = Math.max(floor2, (sigma ?? 0) ** 2);
  const h = Math.min(Math.max(tauDays, 0), p.holdDays);
  return 0.5 * p.gamma * s2 * h + Math.log(1 + p.gamma / p.kappa) / p.gamma;
}

export function quoteV2(ev: EventState, p: QuoteParamsV2): { quotes: Quote[]; diag: V2Diagnostics } {
  const liq = liquidityFactor(ev.tauDays, p);
  const b = p.bShares * liq;
  const shocked = ev.outcomes.some((o) => o.shock);
  const size = Math.max(1, Math.round(p.levelSizeShares * liq * (shocked ? p.shockSizeFactor ?? 1 : 1)));

  // Curva LMSR anclada en el precio justo actual. Lo que ya compraron los jugadores está dentro del
  // precio justo (flowUpdate), así que aquí la curva arranca en s = 0 y solo define los niveles.
  let prior: number[];
  if (ev.kind === "binary") {
    const f = toProb(ev.outcomes[0].fair);
    prior = [f, 1 - f];
  } else {
    const fs = ev.outcomes.map((o) => toProb(o.fair));
    const sum = fs.reduce((a, x) => a + x, 0);
    prior = fs.map((x) => x / sum);
  }
  const s = prior.map(() => 0);
  const logPrior = prior.map(Math.log);
  const prices = lmsrPrices(s, logPrior, b);

  const worst = worstCaseLoss(ev);
  const limited = !!p.riskOff || worst > p.maxLossUsd;
  const markets = ev.kind === "binary" ? [0] : ev.outcomes.map((_, i) => i);
  const sigmaOf = (i: number) => ev.outcomes[i]?.sigma;
  const quotes: Quote[] = [];
  let halfL = 0;

  for (const i of markets) {
    const hl = Math.max(halfSpreadLogit(ev.tauDays, sigmaOf(i), p), 0) * (shocked ? p.shockSpreadMult ?? 1 : 1);
    halfL = Math.max(halfL, hl);
    // Glosten-Milgrom: si el flujo reciente va todo a un lado, ese lado probablemente trae información
    const imb = ev.outcomes[i]?.imbalance ?? 0;
    const hlAsk = hl + (p.imbalanceSpread ?? 0) * Math.max(0, imb);
    const hlBid = hl + (p.imbalanceSpread ?? 0) * Math.max(0, -imb);
    const minHalf = p.minHalfSpreadCents / 100;
    const bids: number[] = [], asks: number[] = [];
    for (let k = 0; k < p.levels; k++) {
      // Nivel k: precio marginal de la curva LMSR después de que los jugadores compren (o vendan)
      // k niveles completos, más el medio spread. Una orden chica paga el precio actual + spread.
      const up = s.slice(); up[i] += k * size;
      const down = s.slice(); down[i] -= k * size;
      const buyAt = lmsrPrices(up, logPrior, b)[i];
      const sellAt = lmsrPrices(down, logPrior, b)[i];
      const ask = Math.max(sigmoid(logit(clamp(buyAt, 0.001, 0.999)) + hlAsk), prices[i] + minHalf);
      const bid = Math.min(sigmoid(logit(clamp(sellAt, 0.001, 0.999)) - hlBid), prices[i] - minHalf);
      asks.push(clamp(Math.ceil(ask * 100 - 1e-9), 2, 99));
      bids.push(clamp(Math.floor(bid * 100 + 1e-9), 1, 98));
    }
    // Niveles monótonos y sin cruzarse
    for (let k = 1; k < p.levels; k++) {
      asks[k] = Math.max(asks[k], asks[k - 1]);
      bids[k] = Math.min(bids[k], bids[k - 1]);
    }
    const push = (kind: QuoteKind, price: number) => {
      const q = { outcome: i, kind, yesPrice: price, shares: size };
      if (limited && worsensWorst(ev, q)) return;
      const same = quotes.find((x) => x.outcome === i && x.kind === kind && x.yesPrice === price);
      if (same) same.shares += size; else quotes.push(q);
    };
    for (let k = 0; k < p.levels; k++) {
      if (bids[k] >= asks[0]) continue;
      if (bids[k] >= 1) push("BUY_YES", bids[k]);
      if (asks[k] <= 99 && asks[k] > bids[0]) push("BUY_NO", asks[k]);
    }
  }

  return {
    quotes,
    diag: {
      liquidity: liq,
      b,
      halfSpreadLogit: halfL,
      halfSpreadCents: Math.max(p.minHalfSpreadCents, (sigmoid(halfL) - 0.5) * 100),
      prices: (ev.kind === "binary" ? [prices[0]] : prices).map((x) => Math.round(x * 1000) / 10),
      lmsrMaxLossUsd: lmsrMaxLoss(prices.map((x) => Math.max(x, 1e-6)), b),
      worstCaseLossUsd: worst,
      limited,
      shock: shocked,
    },
  };
}
