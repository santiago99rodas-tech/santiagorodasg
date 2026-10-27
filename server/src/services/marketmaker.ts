// Market maker de la casa. Polymarket depende de market makers externos (con incentivos de liquidez);
// en un casino casi nunca los hay, así que la casa cotiza siempre a ambos lados del libro para que
// cualquier jugador pueda comprar o vender al instante.
//
// Cotiza solo con órdenes de COMPRA (BUY_YES y BUY_NO): así no necesita inventario previo; cuando
// un jugador le compra, el cruce "mint" crea el par de acciones.
//
// La matemática está en engine/quoting.ts (la misma que usa el simulador, `npm run sim`).
// MM_STRATEGY=v2 (por defecto): precio justo que aprende del flujo (LMSR) y se combina en log-odds con
// referencias externas, spread Avellaneda-Stoikov, liquidez que baja con √(tiempo al cierre) y límites
// de pérdida en el peor escenario. MM_STRATEGY=v1: la versión anterior (media móvil y spread fijo).

import { pool, many, one } from "../db/pool.js";
import { config } from "../config.js";
import { placeOrder, cancelAllOf, bookOf } from "./trading.js";
import { houseAccount } from "./house.js";
import { MICRO } from "../lib/money.js";
import { flowImbalances, trackFair } from "./toxicity.js";
import {
  quoteV1, quoteV2, flowUpdate, tradePriceUpdate, poolLogOdds, liquidityFactor, worstCaseLoss,
  type EventState, type Quote, type QuoteParamsV2, type V2Diagnostics,
} from "../engine/quoting.js";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Botón de pánico: con killed = true la casa retira todas sus órdenes y no vuelve a cotizar. */
export const mmControl = { killed: false };

export async function setKillSwitch(on: boolean, by = "admin") {
  mmControl.killed = on;
  let cancelled = 0;
  if (on) {
    const house = await houseAccount();
    const ms = await many(pool, "SELECT DISTINCT market_id FROM orders WHERE player_id=$1 AND status='open'", [house]);
    for (const m of ms) { await cancelAllOf(house, m.market_id); cancelled++; }
  }
  console.log(`[mm] botón de pánico ${on ? "activado" : "desactivado"} por ${by}; mercados retirados: ${cancelled}`);
  return { killed: on, marketsCleared: cancelled };
}

/** ¿Ya hay liquidez de otros (market makers externos o jugadores) cerca del precio, a ambos lados? */
function hasExternalDepth(marketId: number, house: number, fairCents: number) {
  const d = bookOf(marketId).depthNear(house, Math.round(fairCents), config.p2p.backstopCents);
  const min = config.p2p.backstopMinShares * 100;
  return d.bids >= min && d.asks >= min;
}

export const v2Params = (): QuoteParamsV2 => ({
  backstopSpreadMult: config.p2p.backstopSpreadMult,
  ...(config.toxicity.enabled ? {
    imbalanceSpread: config.toxicity.imbalanceSpread, shockSpreadMult: config.toxicity.shockSpreadMult, shockSizeFactor: config.toxicity.shockSizeFactor,
  } : {}),
  levels: config.mm.levels, levelSizeShares: config.mm.levelSizeShares, bShares: config.mm.bShares,
  minLiquidity: config.mm.minLiquidity, tauRefDays: config.mm.tauRefDays, gamma: config.mm.gamma, kappa: config.mm.kappa,
  sigmaFloor: config.mm.sigmaFloor, holdDays: config.mm.holdDays, minHalfSpreadCents: config.mm.minHalfSpreadCents,
  maxLossUsd: config.mm.maxLossUsd,
});

// ---------- precio justo ----------

export async function updateFairPrices() {
  if (config.mm.strategy === "v1") return updateFairPricesV1();
  return updateFairPricesV2();
}

/** v1: media móvil hacia el último precio negociado y normalización de eventos múltiples a ~100%. */
async function updateFairPricesV1() {
  await pool.query(`UPDATE markets SET fair_price = GREATEST(2, LEAST(98, ROUND(0.6 * fair_price + 0.4 * last_price)))
                    WHERE status='open' AND fair_price <> last_price`);
  const events = await many(pool, "SELECT e.id FROM events e WHERE e.kind='multi' AND e.status='open'");
  for (const e of events) {
    const ms = await many(pool, "SELECT id, fair_price FROM markets WHERE event_id=$1 AND status='open'", [e.id]);
    const sum = ms.reduce((a, m) => a + m.fair_price, 0);
    if (!sum) continue;
    if (Math.abs(sum - 100) <= 3) continue;
    for (const m of ms) {
      const fair = clamp(Math.round((m.fair_price * 100) / sum), 2, 98);
      if (fair !== m.fair_price) await pool.query("UPDATE markets SET fair_price=$2 WHERE id=$1", [m.id, fair]);
    }
  }
}

/**
 * v2: cada acción Sí neta que los jugadores le compran a la casa mueve el log-odds en 1/b (curva LMSR).
 * Lo que negocian contra otros (market makers externos u otros jugadores) acerca el precio al que se
 * negoció (tradePriceUpdate). Después se combina en log-odds con la referencia externa nueva, si llegó
 * una (cada referencia se aplica una sola vez, así una foto vieja no arrastra el precio en cada pasada).
 * Las compras de la casa no cuentan.
 */
async function updateFairPricesV2() {
  const house = await houseAccount();
  const rows = await many(pool, `
    SELECT m.id, m.event_id, e.kind, m.fair_price, m.fair_exact, m.flow_cursor,
           EXTRACT(EPOCH FROM (m.close_time - now())) / 86400 AS tau,
           f.flow, f.other_qty, f.other_vwap, f.last_id,
           x.price AS ext, x.id AS ext_id
    FROM markets m JOIN events e ON e.id = m.event_id
    LEFT JOIN LATERAL (
      SELECT SUM(CASE WHEN om.player_id <> $1 THEN 0 WHEN (o.side='BUY' AND o.outcome='YES') OR (o.side='SELL' AND o.outcome='NO') THEN t.qty ELSE -t.qty END)::float8 / 100 AS flow,
             SUM(t.qty) FILTER (WHERE om.player_id <> $1)::float8 / 100 AS other_qty,
             (SUM(t.qty * t.yes_price) FILTER (WHERE om.player_id <> $1))::float8 / NULLIF(SUM(t.qty) FILTER (WHERE om.player_id <> $1), 0) / 100 AS other_vwap,
             MAX(t.id) AS last_id
      FROM trades t JOIN orders o ON o.id = t.taker_order_id JOIN orders om ON om.id = t.maker_order_id
      WHERE t.market_id = m.id AND t.id > m.flow_cursor AND o.player_id <> $1
    ) f ON TRUE
    LEFT JOIN LATERAL (
      SELECT r.id, r.price FROM reference_prices r
      WHERE r.market_id = m.id AND r.id > m.ref_cursor AND r.captured_at > now() - make_interval(hours => $2)
      ORDER BY r.id DESC LIMIT 1
    ) x ON TRUE
    WHERE m.status='open' ORDER BY m.event_id, m.id`, [house, config.mm.externalMaxAgeHours]);

  const byEvent = new Map<number, typeof rows>();
  for (const r of rows) byEvent.set(r.event_id, [...(byEvent.get(r.event_id) ?? []), r]);
  let changed = 0;
  for (const ms of byEvent.values()) {
    const kind = ms[0].kind === "multi" && ms.length > 1 ? "multi" : "binary";
    const flow = ms.map((m) => Number(m.flow ?? 0));
    const ext = ms.map((m) => (m.ext == null ? undefined : Number(m.ext) / 100));
    const otherQty = ms.map((m) => Number(m.other_qty ?? 0));
    if (flow.every((x) => x === 0) && otherQty.every((x) => x === 0) && ext.every((x) => x === undefined) && ms.every((m) => m.fair_exact != null)) {
      // Sin flujo ni referencias: solo avanzar el cursor si hubo cruces de la casa
      for (const m of ms) if (m.last_id && Number(m.last_id) > Number(m.flow_cursor)) await pool.query("UPDATE markets SET flow_cursor=$2 WHERE id=$1", [m.id, m.last_id]);
      continue;
    }
    const b = config.mm.bShares * liquidityFactor(Math.max(0, Number(ms[0].tau)), config.mm);
    const groups = kind === "binary" ? ms.map((m, i) => [i]) : [ms.map((_, i) => i)];
    for (const g of groups) {
      const prev = g.map((i) => (ms[i].fair_exact != null ? Number(ms[i].fair_exact) : ms[i].fair_price / 100));
      let next = flowUpdate(kind, kind === "multi" ? normalize(prev) : prev, g.map((i) => flow[i]), b);
      next = next.map((p, k) => tradePriceUpdate(p, Number(ms[g[k]].other_vwap), otherQty[g[k]], b));
      next = next.map((p, k) => {
        const e = ext[g[k]];
        return e === undefined ? p : poolLogOdds([{ p, w: config.mm.weightPrev }, { p: clamp(e, 0.01, 0.99), w: config.mm.weightExternal }]);
      });
      if (kind === "multi") next = normalize(next);
      for (let k = 0; k < g.length; k++) {
        const m = ms[g[k]];
        const exact = clamp(next[k], 0.02, 0.98);
        const cursor = m.last_id ? Math.max(Number(m.last_id), Number(m.flow_cursor)) : Number(m.flow_cursor);
        await pool.query("UPDATE markets SET fair_exact=$2, fair_price=$3, flow_cursor=$4, ref_cursor=GREATEST(ref_cursor, $5) WHERE id=$1",
          [m.id, exact, clamp(Math.round(exact * 100), 2, 98), cursor, m.ext_id ?? 0]);
        await trackFair(m.id, exact * 100); // freno de emergencia si saltó mucho en pocos minutos
        changed++;
      }
    }
  }
  return changed;
}

const normalize = (xs: number[]) => { const s = xs.reduce((a, x) => a + x, 0) || 1; return xs.map((x) => x / s); };

// ---------- cotizaciones ----------

interface EventQuotes { eventId: number; marketIds: number[]; state: EventState; quotes: Quote[]; diag?: V2Diagnostics; paused?: boolean }

/** Arma el estado de cada evento abierto (o del evento de un mercado) y calcula las cotizaciones objetivo. */
export async function planQuotes(marketId?: number): Promise<EventQuotes[]> {
  const house = await houseAccount();
  const rows = await many(pool, `
    SELECT m.id, m.event_id, e.kind, COALESCE(m.fair_exact * 100, m.fair_price) AS fair,
           COALESCE(m.paused_until > now(), FALSE) AS paused, COALESCE(m.shock_until > now(), FALSE) AS shock,
           EXTRACT(EPOCH FROM (m.close_time - now())) / 86400 AS tau,
           COALESCE(SUM(ps.qty) FILTER (WHERE ps.outcome='YES'),0)::float8 / 100 AS yes,
           COALESCE(SUM(ps.qty) FILTER (WHERE ps.outcome='NO'),0)::float8 / 100 AS no,
           COALESCE(SUM(ps.cost),0)::float8 / ${MICRO} AS cost
    FROM markets m JOIN events e ON e.id = m.event_id
    LEFT JOIN positions ps ON ps.market_id = m.id AND ps.player_id = $1
    WHERE m.status='open' AND m.close_time > now() + interval '1 minute'
      ${marketId ? "AND m.event_id = (SELECT event_id FROM markets WHERE id=$2)" : ""}
    GROUP BY m.id, e.kind ORDER BY m.event_id, m.id`, marketId ? [house, marketId] : [house]);
  const sigmas = config.mm.strategy === "v2" ? await realizedSigma(rows.map((r) => r.id)) : new Map<number, number>();
  const imbalances = config.mm.strategy === "v2" ? await flowImbalances(rows.map((r) => r.id)) : new Map<number, number>();

  const byEvent = new Map<number, typeof rows>();
  for (const r of rows) byEvent.set(r.event_id, [...(byEvent.get(r.event_id) ?? []), r]);
  const plans: EventQuotes[] = [];
  for (const [eventId, ms] of byEvent) {
    const multi = ms[0].kind === "multi" && ms.length > 1;
    // Binarios: cada mercado es su propio evento de riesgo. Múltiples: todas las opciones juntas.
    const groups = multi ? [ms] : ms.map((m) => [m]);
    for (const g of groups) {
      const state: EventState = {
        kind: multi ? "multi" : "binary",
        tauDays: Math.max(0, Number(g[0].tau)),
        outcomes: g.map((m) => ({
          fair: Number(m.fair), yesShares: Number(m.yes), noShares: Number(m.no), costUsd: Number(m.cost), sigma: sigmas.get(m.id),
          imbalance: imbalances.get(m.id), shock: m.shock, backstop: hasExternalDepth(m.id, house, Number(m.fair)),
        })),
      };
      plans.push({ eventId, marketIds: g.map((m) => m.id), state, quotes: [], paused: g.some((m) => m.paused) });
    }
  }

  if (config.mm.strategy === "v1") {
    const p = { spreadCents: config.mm.spreadCents, levels: config.mm.levels, levelSizeShares: config.mm.levelSizeShares, maxExposureUsd: config.mm.maxExposureUsd };
    for (const pl of plans) pl.quotes = quoteV1({ ...pl.state, outcomes: pl.state.outcomes.map((o) => ({ ...o, fair: Math.round(o.fair) })) }, p);
    return plans;
  }
  // Límite total: si la suma de las pérdidas en el peor escenario lo supera, solo se reduce riesgo
  const totalWorst = marketId ? (await riskTotals()).worstCaseLossUsd : plans.reduce((a, pl) => a + worstCaseLoss(pl.state), 0);
  const riskOff = totalWorst > config.mm.maxTotalLossUsd;
  for (const pl of plans) {
    const r = quoteV2(pl.state, { ...v2Params(), riskOff });
    pl.quotes = pl.paused ? [] : r.quotes; // freno de emergencia: sin cotizaciones hasta paused_until
    pl.diag = r.diag;
  }
  return plans;
}

/**
 * Volatilidad del log-odds por √día con las fotos del precio justo de las últimas 24 h (una cada
 * 15 min). No se usan los precios de cada cruce: rebotan entre compra y venta y llegan a segundos de
 * distancia, lo que inflaba la volatilidad y abría el spread hasta 1¢/99¢.
 */
async function realizedSigma(ids: number[]) {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  const rows = await many(pool, `
    WITH h AS (
      SELECT market_id, ts, LN(LEAST(99, GREATEST(1, fair))::float8 / (100 - LEAST(99, GREATEST(1, fair)))) AS x
      FROM price_history WHERE market_id = ANY($1) AND fair IS NOT NULL AND ts > now() - interval '24 hours'),
    d AS (SELECT market_id, x - LAG(x) OVER (PARTITION BY market_id ORDER BY ts) AS dx,
                 EXTRACT(EPOCH FROM ts - LAG(ts) OVER (PARTITION BY market_id ORDER BY ts)) / 86400 AS dt FROM h)
    SELECT market_id, SUM(dx * dx) AS ss, SUM(dt) AS days, COUNT(*) AS n FROM d WHERE dx IS NOT NULL AND dt >= 0.005 GROUP BY market_id`, [ids]);
  for (const r of rows) if (Number(r.n) >= 4 && Number(r.days) > 0) out.set(r.market_id, Math.min(SIGMA_MAX, Math.sqrt(Number(r.ss) / Number(r.days))));
  return out;
}
const SIGMA_MAX = 3; // tope por √día: más que esto ya es un salto, y de eso se ocupa el freno de emergencia

export async function refreshQuotes(marketId?: number) {
  if (!config.mm.enabled || mmControl.killed) return 0;
  const house = await houseAccount();
  const plans = await planQuotes(marketId);
  let requoted = 0;
  for (const pl of plans) {
    for (const [idx, id] of pl.marketIds.entries()) {
      const target = pl.quotes.filter((q) => q.outcome === idx);
      // Si las órdenes actuales ya coinciden y conservan al menos la mitad del tamaño, no se toca el mercado
      const current = bookOf(id).ordersOf(house);
      const key = (o: { kind: string; yesPrice: number }) => `${o.kind}@${o.yesPrice}`;
      const same = current.length === target.length
        && target.every((t) => current.some((c) => key(c) === key(t) && c.remaining >= t.shares * 50));
      if (same) continue;
      requoted++;
      await cancelAllOf(house, id);
      for (const t of target) {
        await placeOrder(house, t.kind === "BUY_YES"
          ? { marketId: id, side: "BUY", outcome: "YES", type: "LIMIT", price: t.yesPrice, shares: t.shares }
          : { marketId: id, side: "BUY", outcome: "NO", type: "LIMIT", price: 100 - t.yesPrice, shares: t.shares }).catch(() => undefined);
      }
    }
  }
  return requoted;
}

// ---------- estado y riesgo ----------

export async function riskTotals() {
  const house = await houseAccount();
  const rows = await many(pool, `
    SELECT m.id, m.event_id, e.kind,
           COALESCE(SUM(ps.qty) FILTER (WHERE ps.outcome='YES'),0)::float8 / 100 AS yes,
           COALESCE(SUM(ps.qty) FILTER (WHERE ps.outcome='NO'),0)::float8 / 100 AS no,
           COALESCE(SUM(ps.cost),0)::float8 / ${MICRO} AS cost
    FROM markets m JOIN events e ON e.id = m.event_id
    JOIN positions ps ON ps.market_id = m.id AND ps.player_id = $1
    WHERE m.status IN ('open','closed','resolving') GROUP BY m.id, e.kind`, [house]);
  const byEvent = new Map<string, EventState>();
  for (const r of rows) {
    const multi = r.kind === "multi";
    const k = multi ? `e${r.event_id}` : `m${r.id}`;
    const st = byEvent.get(k) ?? { kind: multi ? "multi" : "binary", tauDays: 0, outcomes: [] };
    st.outcomes.push({ fair: 50, yesShares: Number(r.yes), noShares: Number(r.no), costUsd: Number(r.cost) });
    byEvent.set(k, st);
  }
  // Un evento múltiple del que la casa solo tiene algunas opciones: las demás cuentan como posición cero
  return { worstCaseLossUsd: [...byEvent.values()].reduce((a, st) => a + worstCaseLoss(st), 0) };
}

/** Estado del market maker para el back-office: parámetros, botón de pánico y riesgo por evento. */
export async function mmStatus() {
  const plans = config.mm.strategy === "v2" ? await planQuotes() : [];
  const titles = new Map((await many(pool, "SELECT m.id, e.title FROM markets m JOIN events e ON e.id=m.event_id WHERE m.status='open'"))
    .map((r) => [r.id, r]));
  const events = plans
    .filter((p) => p.diag)
    .map((p) => {
      const t = titles.get(p.marketIds[0]);
      return {
        eventId: p.eventId, marketIds: p.marketIds,
        title: t?.title ?? "",
        kind: p.state.kind, tauDays: Math.round(p.state.tauDays * 10) / 10,
        liquidity: Math.round(p.diag!.liquidity * 100) / 100, b: Math.round(p.diag!.b),
        halfSpreadCents: Math.round(p.diag!.halfSpreadCents * 10) / 10,
        prices: p.diag!.prices,
        worstCaseLossUsd: Math.round(p.diag!.worstCaseLossUsd),
        lmsrMaxLossUsd: Math.round(p.diag!.lmsrMaxLossUsd),
        limited: p.diag!.limited, quotes: p.quotes.length, paused: !!p.paused, shock: p.diag!.shock, backstop: p.state.outcomes.some((o) => o.backstop),
        imbalance: Math.round(Math.max(...p.state.outcomes.map((o) => Math.abs(o.imbalance ?? 0))) * 100) / 100,
      };
    })
    .sort((a, b) => b.worstCaseLossUsd - a.worstCaseLossUsd);
  const worst = events.reduce((a, e) => a + e.worstCaseLossUsd, 0);
  return {
    strategy: config.mm.strategy, enabled: config.mm.enabled, killed: mmControl.killed,
    params: { ...v2Params(), weightPrev: config.mm.weightPrev, weightExternal: config.mm.weightExternal },
    limits: { maxLossUsd: config.mm.maxLossUsd, maxTotalLossUsd: config.mm.maxTotalLossUsd },
    totals: { worstCaseLossUsd: worst, riskOff: worst > config.mm.maxTotalLossUsd, limitedEvents: events.filter((e) => e.limited).length, events: events.length },
    events: events.slice(0, 100),
  };
}

export async function houseStats() {
  const house = await houseAccount();
  return one(pool,
    `SELECT COALESCE(SUM(cost),0)::bigint AS open_cost, COALESCE(SUM(realized),0)::bigint AS realized,
            (SELECT COALESCE(SUM(amount),0)::bigint FROM fees) AS fees
     FROM positions WHERE player_id=$1`, [house]);
}
