// Protección contra el apostador informado (selección adversa). Módulo puro: lo usan el servidor
// (services/toxicity.ts y marketmaker.ts) y el simulador.
//
// La idea viene de Glosten-Milgrom: si una parte de los que apuestan sabe más que el mercado, el
// que da liquidez pierde con ellos y tiene que cobrarlo. Tres herramientas:
//
//   1. Markout por jugador: cuánto ganó cada apuesta frente al precio que pagó, medido con el precio
//      justo una hora después y con el resultado final ($1 o $0). Un casual queda negativo (paga el
//      spread y no sabe más que el mercado); uno informado queda positivo: le gana a la casa de forma
//      sostenida. Solo se marca con evidencia estadística: el puntaje es el límite inferior del
//      promedio (promedio − z·error estándar), así unos cuantos aciertos de suerte no marcan a nadie.
//      Con puntaje alto paga un recargo en lo que le compra a la casa.
//
//      Por qué no el "closing line value" (precio al cierre) que usan las casas de apuestas: en el
//      simulador, una hinchada que compra siempre lo mismo empuja el precio de cierre a su favor y
//      salía marcada aunque perdía plata. Contra el resultado final eso no pasa.
//   2. Desequilibrio del flujo por mercado: si casi todo el dinero reciente va al mismo lado,
//      la casa abre el spread de ESE lado (el que están golpeando) y deja el otro igual.
//   3. Freno de emergencia: si el precio salta muchos centavos en poco tiempo, la casa retira sus
//      cotizaciones de ese mercado unos minutos y vuelve con más spread y menos tamaño.

export interface ToxicityParams {
  minTrades: number; // apuestas mínimas medidas antes de poder marcar a alguien
  confidenceZ: number; // z del límite inferior (2 ≈ 97,5% de confianza de que tiene ventaja)
  startCents: number; // markout promedio desde el que empieza el recargo
  fullCents: number; // markout con el recargo máximo
  maxSurchargeBps: number; // recargo máximo sobre lo que se le compra a la casa
  imbalanceSpread: number; // log-odds extra de medio spread con todo el flujo a un lado
  imbalanceMinUsd: number; // por debajo de este volumen reciente el desequilibrio no cuenta
  breakerCents: number; // salto de precio que activa el freno
  shockSpreadMult: number; // multiplicador del medio spread después del freno
  shockSizeFactor: number; // fracción del tamaño después del freno
}

export const DEFAULT_TOXICITY: ToxicityParams = {
  minTrades: 10,
  confidenceZ: 2,
  startCents: 0.5,
  fullCents: 3,
  maxSurchargeBps: 300,
  imbalanceSpread: 0.12,
  imbalanceMinUsd: 150,
  breakerCents: 12,
  shockSpreadMult: 2,
  shockSizeFactor: 0.5,
};

/**
 * Markout de una apuesta en centavos (espacio Sí): valor posterior (precio justo o resultado: 100/0)
 * menos el precio pagado, con el signo de la apuesta. Positivo = la apuesta le ganó a la casa.
 */
export function markoutCents(paidYesPrice: number, later: number, boughtYes: boolean) {
  return boughtYes ? later - paidYesPrice : paidYesPrice - later;
}

/** Acumulado por jugador, ponderado por dinero. */
export interface FlowStats { trades: number; w: number; w2: number; wm: number; wm2: number }
export const emptyStats = (): FlowStats => ({ trades: 0, w: 0, w2: 0, wm: 0, wm2: 0 });

export function addMarkout(s: FlowStats, markout: number, usd: number): FlowStats {
  return { trades: s.trades + 1, w: s.w + usd, w2: s.w2 + usd * usd, wm: s.wm + usd * markout, wm2: s.wm2 + usd * markout * markout };
}

/** Promedio ponderado del markout, en centavos. */
export const meanMarkout = (s: FlowStats) => (s.w > 0 ? s.wm / s.w : 0);

/**
 * Puntaje: límite inferior del markout promedio = promedio − z·error estándar (con el número
 * efectivo de apuestas (Σw)²/Σw²). Con pocas apuestas o resultados dispersos queda en 0 o negativo.
 */
export function toxicityScore(s: FlowStats, p: Pick<ToxicityParams, "minTrades" | "confidenceZ">) {
  if (s.trades < p.minTrades || s.w <= 0) return 0;
  const mean = s.wm / s.w;
  const variance = Math.max(0, s.wm2 / s.w - mean * mean);
  const nEff = (s.w * s.w) / s.w2;
  return mean - p.confidenceZ * Math.sqrt(variance / Math.max(1, nEff - 1));
}

/** Recargo en puntos básicos: 0 hasta startCents, lineal hasta maxSurchargeBps en fullCents. */
export function surchargeBps(score: number, p: Pick<ToxicityParams, "startCents" | "fullCents" | "maxSurchargeBps">) {
  if (score <= p.startCents) return 0;
  const x = Math.min(1, (score - p.startCents) / (p.fullCents - p.startCents));
  return Math.round(x * p.maxSurchargeBps);
}

/**
 * Desequilibrio del flujo reciente: (compras Sí − compras No) / total, entre −1 y 1.
 * Con poco volumen devuelve 0.
 */
export function flowImbalance(yesUsd: number, noUsd: number, p: Pick<ToxicityParams, "imbalanceMinUsd">) {
  const t = yesUsd + noUsd;
  if (t < p.imbalanceMinUsd) return 0;
  return (yesUsd - noUsd) / t;
}

/** Medio spread extra (log-odds) de cada lado: se abre el lado que están golpeando. */
export function asymmetricSpread(imbalance: number, p: Pick<ToxicityParams, "imbalanceSpread">) {
  return { ask: p.imbalanceSpread * Math.max(0, imbalance), bid: p.imbalanceSpread * Math.max(0, -imbalance) };
}

/** ¿Saltó el precio lo suficiente como para frenar? */
export const breakerTripped = (fromCents: number, toCents: number, p: Pick<ToxicityParams, "breakerCents">) =>
  Math.abs(toCents - fromCents) >= p.breakerCents;
