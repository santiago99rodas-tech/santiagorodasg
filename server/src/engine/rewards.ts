// Incentivos de liquidez (como las "liquidity rewards" de Polymarket). Puro: sin base de datos, para
// que lo usen el servidor y el simulador.
//
// Cada muestra (por defecto, cada minuto) puntúa las órdenes abiertas de cada market maker cerca del
// precio medio:  S = ((v − s) / v)² × tamaño,  con v = spread máximo premiado (¢) y s = distancia al
// medio (¢). Cotizar más ajustado vale mucho más que cotizar más grande. Se suman las de compra (Q1) y
// las de venta (Q2) y el puntaje del market maker es
//     Qmin = max(min(Q1, Q2), max(Q1, Q2) / c)   si el medio está entre 10¢ y 90¢
//     Qmin = min(Q1, Q2)                          fuera de ese rango (ahí hay que cotizar los dos lados)
// así que cotizar de un solo lado rinde 1/c (c = 3). Su parte de la muestra es Qmin / ΣQmin, y el pozo
// diario del mercado se reparte según el promedio de esas partes en todas las muestras del día.

export interface RewardParams { maxSpreadCents: number; minShares: number; singleSidedFactor: number }
export const DEFAULT_REWARDS: RewardParams = { maxSpreadCents: 3, minShares: 50, singleSidedFactor: 3 };

/** Orden en términos del Sí: compra de Sí (o venta de No) = bid; venta de Sí (o compra de No) = ask. */
export interface RewardOrder { owner: string | number; side: "BUY" | "SELL"; outcome: "YES" | "NO"; price: number; shares: number }

export function asYesQuote(o: RewardOrder): { kind: "bid" | "ask"; price: number } {
  const yesBid = (o.side === "BUY") === (o.outcome === "YES");
  return { kind: yesBid ? "bid" : "ask", price: o.outcome === "YES" ? o.price : 100 - o.price };
}

/** Precio medio del libro en ¢ del Sí (mejor bid y mejor ask), o el de respaldo si falta un lado. */
export function bookMid(orders: RewardOrder[], fallback: number) {
  let bid = -Infinity, ask = Infinity;
  for (const o of orders) {
    const q = asYesQuote(o);
    if (q.kind === "bid") bid = Math.max(bid, q.price); else ask = Math.min(ask, q.price);
  }
  return Number.isFinite(bid) && Number.isFinite(ask) && ask > bid ? (bid + ask) / 2 : fallback;
}

export function orderScore(distanceCents: number, shares: number, p: RewardParams = DEFAULT_REWARDS) {
  if (distanceCents < 0 || distanceCents > p.maxSpreadCents || shares < p.minShares) return 0;
  return ((p.maxSpreadCents - distanceCents) / p.maxSpreadCents) ** 2 * shares;
}

/** Qmin de cada dueño de órdenes en una muestra. */
export function sampleScores(orders: RewardOrder[], mid: number, p: RewardParams = DEFAULT_REWARDS) {
  const q = new Map<string | number, { bid: number; ask: number }>();
  for (const o of orders) {
    const y = asYesQuote(o);
    const s = orderScore(y.kind === "bid" ? mid - y.price : y.price - mid, o.shares, p);
    if (!s) continue;
    const e = q.get(o.owner) ?? { bid: 0, ask: 0 };
    e[y.kind] += s;
    q.set(o.owner, e);
  }
  const twoSidedOnly = mid < 10 || mid > 90;
  const out = new Map<string | number, number>();
  for (const [owner, { bid, ask }] of q) {
    const v = twoSidedOnly ? Math.min(bid, ask) : Math.max(Math.min(bid, ask), Math.max(bid, ask) / p.singleSidedFactor);
    if (v > 0) out.set(owner, v);
  }
  return out;
}

/** Parte de cada dueño en la muestra (suma 1 si alguien puntuó). */
export function sampleShares(scores: Map<string | number, number>) {
  const total = [...scores.values()].reduce((a, v) => a + v, 0);
  return new Map([...scores].map(([k, v]) => [k, total ? v / total : 0]));
}
