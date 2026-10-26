// Protección contra apostadores informados. La matemática está en engine/toxicity.ts y se probó en
// el simulador (`npm run sim`, estrategia v2+). Aquí se mide con los cruces reales:
//
//   - Markout corto: precio justo TOX_MARKOUT_MIN minutos después del cruce frente al precio pagado.
//   - Markout final: el resultado del mercado ($1 o $0 por acción) frente al precio pagado.
//   - Cada jugador acumula sus markouts; el puntaje es el límite inferior estadístico del promedio.
//     Con puntaje alto paga un recargo en lo que le compra a la casa (no en lo que cruza con otros jugadores).
//   - Desequilibrio del flujo por mercado, freno de emergencia por saltos de precio y spread más ancho
//     cuando llega una noticia que toca un mercado abierto.

import { pool, many, one } from "../db/pool.js";
import { config } from "../config.js";
import { houseAccount } from "./house.js";
import { keywords } from "../ingest/text.js";
import {
  markoutCents, addMarkout, toxicityScore, surchargeBps, flowImbalance, meanMarkout, breakerTripped,
  type FlowStats, type ToxicityParams,
} from "../engine/toxicity.js";

export const toxParams = (): ToxicityParams => ({ ...config.toxicity });

// Dirección del taker en espacio Sí: compra Sí o vende No => apostó al Sí
const TAKER_YES = "((o.side='BUY' AND o.outcome='YES') OR (o.side='SELL' AND o.outcome='NO'))";
// Dinero del taker en el cruce (micro-dólares): qty · precio de su propio resultado
const TAKER_USD = "(t.qty * (CASE WHEN o.outcome='YES' THEN t.yes_price ELSE 100 - t.yes_price END) * 100)::float8 / 1e6";

/** Recargo vigente del jugador en puntos básicos (0 si la protección está apagada). */
export async function playerSurchargeBps(playerId: number) {
  if (!config.toxicity.enabled) return 0;
  const r = await one(pool, "SELECT surcharge_bps, surcharge_override FROM player_flow WHERE player_id=$1", [playerId]);
  return r ? (r.surcharge_override ?? r.surcharge_bps) : 0;
}

/**
 * Mide los markouts pendientes y actualiza el puntaje de cada jugador. Corre como tarea programada.
 * Devuelve cuántos markouts midió.
 */
export async function scoreMarkouts() {
  const house = await houseAccount();
  const p = toxParams();
  const measured: { player: number; m: number; usd: number }[] = [];

  // 1) Markout corto: foto del precio justo más cercana después de created_at + horizonte, frente al precio pagado
  const short = await many(pool, `
    SELECT t.id, o.player_id, t.yes_price, ${TAKER_YES} AS yes, ${TAKER_USD} AS usd,
      (SELECT ph.fair FROM price_history ph WHERE ph.market_id = t.market_id AND ph.fair IS NOT NULL
         AND ph.ts >= t.created_at + make_interval(mins => $2) ORDER BY ph.ts LIMIT 1) AS later
    FROM trades t JOIN orders o ON o.id = t.taker_order_id
    WHERE t.markout_pending AND t.markout_short IS NULL AND o.player_id <> $1
      AND t.created_at < now() - make_interval(mins => $2) AND t.created_at > now() - interval '3 days'
    ORDER BY t.id LIMIT 5000`, [house, config.toxicity.markoutMinutes]);
  for (const t of short) {
    if (t.later == null) continue; // todavía no hay foto (o el mercado cerró antes): cuenta solo el final
    const m = markoutCents(t.yes_price, Number(t.later), t.yes);
    await pool.query("UPDATE trades SET markout_short=$2 WHERE id=$1", [t.id, m]);
    measured.push({ player: t.player_id, m, usd: Number(t.usd) });
  }

  // 2) Markout final: mercados ya resueltos, frente al resultado ($1 o $0 por acción; $0,50 si se anuló)
  const final = await many(pool, `
    SELECT t.id, o.player_id, t.yes_price, ${TAKER_YES} AS yes, ${TAKER_USD} AS usd,
           CASE m.resolved_outcome WHEN 'YES' THEN 100 WHEN 'NO' THEN 0 ELSE 50 END AS value
    FROM trades t JOIN orders o ON o.id = t.taker_order_id JOIN markets m ON m.id = t.market_id
    WHERE t.markout_pending AND m.status IN ('resolved','void') AND o.player_id <> $1
    ORDER BY t.id LIMIT 5000`, [house]);
  for (const t of final) {
    const m = markoutCents(t.yes_price, t.value, t.yes);
    await pool.query("UPDATE trades SET markout_final=$2, markout_pending=FALSE WHERE id=$1", [t.id, m]);
    measured.push({ player: t.player_id, m, usd: Number(t.usd) });
  }

  // 3) Acumular por jugador y recalcular puntaje y recargo
  const byPlayer = new Map<number, { m: number; usd: number }[]>();
  for (const x of measured) byPlayer.set(x.player, [...(byPlayer.get(x.player) ?? []), x]);
  for (const [player, xs] of byPlayer) {
    const cur = await one(pool, "SELECT trades, w, w2, wm, wm2 FROM player_flow WHERE player_id=$1", [player]);
    let s: FlowStats = cur ? { trades: cur.trades, w: cur.w, w2: cur.w2, wm: cur.wm, wm2: cur.wm2 } : { trades: 0, w: 0, w2: 0, wm: 0, wm2: 0 };
    for (const x of xs) s = addMarkout(s, x.m, x.usd);
    const score = toxicityScore(s, p);
    await pool.query(`
      INSERT INTO player_flow (player_id, trades, w, w2, wm, wm2, score, surcharge_bps, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
      ON CONFLICT (player_id) DO UPDATE SET trades=$2, w=$3, w2=$4, wm=$5, wm2=$6, score=$7, surcharge_bps=$8, updated_at=now()`,
      [player, s.trades, s.w, s.w2, s.wm, s.wm2, score, surchargeBps(score, p)]);
  }
  return measured.length;
}

/** Desequilibrio del flujo reciente de jugadores por mercado (−1 todo No, 1 todo Sí). */
export async function flowImbalances(marketIds: number[]) {
  const out = new Map<number, number>();
  if (!config.toxicity.enabled || !marketIds.length) return out;
  const house = await houseAccount();
  const rows = await many(pool, `
    SELECT t.market_id,
           COALESCE(SUM(${TAKER_USD}) FILTER (WHERE ${TAKER_YES}), 0) AS yes_usd,
           COALESCE(SUM(${TAKER_USD}) FILTER (WHERE NOT ${TAKER_YES}), 0) AS no_usd
    FROM trades t JOIN orders o ON o.id = t.taker_order_id
    WHERE t.market_id = ANY($1) AND o.player_id <> $2 AND t.created_at > now() - make_interval(mins => $3)
    GROUP BY t.market_id`, [marketIds, house, config.toxicity.flowWindowMinutes]);
  for (const r of rows) out.set(r.market_id, flowImbalance(Number(r.yes_usd), Number(r.no_usd), config.toxicity));
  return out;
}

// ---------- freno de emergencia ----------

const trail = new Map<number, { t: number; fair: number }[]>();

/**
 * Registra el nuevo precio justo de un mercado y activa el freno si saltó TOX_BREAKER_CENTS o más
 * dentro de TOX_BREAKER_WINDOW_MIN: la casa retira sus órdenes TOX_PAUSE_MIN minutos y después
 * cotiza con más spread y menos tamaño hasta completar TOX_SHOCK_MIN.
 */
export async function trackFair(marketId: number, fairCents: number, now = Date.now()) {
  if (!config.toxicity.enabled) return false;
  const win = config.toxicity.breakerWindowMinutes * 60_000;
  const xs = (trail.get(marketId) ?? []).filter((x) => now - x.t <= win);
  xs.push({ t: now, fair: fairCents });
  trail.set(marketId, xs);
  const tripped = xs.some((x) => breakerTripped(x.fair, fairCents, config.toxicity));
  if (tripped) {
    await setShock([marketId], `Salto de precio de ${Math.round(Math.max(...xs.map((x) => Math.abs(x.fair - fairCents))))}¢ en ${config.toxicity.breakerWindowMinutes} min`, true);
    trail.set(marketId, [{ t: now, fair: fairCents }]);
  }
  return tripped;
}

export async function setShock(marketIds: number[], reason: string, pause: boolean) {
  if (!marketIds.length) return;
  await pool.query(`
    UPDATE markets SET shock_until = GREATEST(COALESCE(shock_until, now()), now() + make_interval(mins => $2)),
      paused_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE paused_until END, shock_reason = $5
    WHERE id = ANY($1) AND status = 'open'`,
    [marketIds, config.toxicity.shockMinutes, pause, config.toxicity.pauseMinutes, reason]);
  console.log(`[protección] ${reason}: mercados ${marketIds.join(", ")}`);
}

/**
 * Noticias de último momento: si una tendencia con publicaciones de la última hora comparte 2 o más
 * palabras clave con un evento abierto, sus mercados cotizan con más spread un rato.
 */
export async function flagNewsShocks(trends: { label: string; keywords: string[]; newest: number }[]) {
  if (!config.toxicity.enabled) return 0;
  const fresh = trends.filter((t) => Date.now() - t.newest < 60 * 60_000);
  if (!fresh.length) return 0;
  const events = await many(pool, "SELECT e.id, e.title, array_agg(m.id) AS markets FROM events e JOIN markets m ON m.event_id=e.id WHERE e.status='open' AND m.status='open' GROUP BY e.id");
  let n = 0;
  for (const e of events) {
    const kw = new Set(keywords(e.title));
    const hit = fresh.find((t) => t.keywords.filter((k) => kw.has(k)).length >= 2);
    if (hit) { await setShock(e.markets, `Noticia: ${hit.label}`.slice(0, 200), false); n++; }
  }
  return n;
}

// ---------- back-office ----------

export async function toxicityReport() {
  const p = toxParams();
  const players = await many(pool, `
    SELECT pf.*, p.display_name, p.external_id, p.operator_id, p.created_at AS since
    FROM player_flow pf JOIN players p ON p.id = pf.player_id
    WHERE pf.trades >= 3 ORDER BY COALESCE(pf.surcharge_override, pf.surcharge_bps) DESC, pf.score DESC LIMIT 50`);
  const markets = await many(pool, `
    SELECT m.id, e.title, m.outcome_label, e.kind, m.paused_until, m.shock_until, m.shock_reason
    FROM markets m JOIN events e ON e.id = m.event_id
    WHERE m.status = 'open' AND (m.shock_until > now() OR m.paused_until > now()) ORDER BY m.shock_until DESC NULLS LAST LIMIT 50`);
  const counts = await one(pool, `
    SELECT COUNT(*) FILTER (WHERE COALESCE(surcharge_override, surcharge_bps) > 0)::int AS flagged, COUNT(*)::int AS tracked FROM player_flow`);
  return {
    enabled: config.toxicity.enabled,
    params: p,
    flagged: counts?.flagged ?? 0,
    tracked: counts?.tracked ?? 0,
    players: players.map((r) => ({
      playerId: r.player_id, name: r.display_name, externalId: r.external_id, operatorId: r.operator_id, since: r.since,
      trades: r.trades, volumeUsd: Math.round(r.w), meanMarkoutCents: Math.round(meanMarkout(r) * 10) / 10,
      scoreCents: Math.round(r.score * 10) / 10, surchargeBps: r.surcharge_override ?? r.surcharge_bps, automaticBps: r.surcharge_bps,
      override: r.surcharge_override,
    })),
    markets: markets.map((m) => ({
      marketId: m.id, title: m.kind === "multi" ? `${m.title} · ${m.outcome_label}` : m.title,
      pausedUntil: m.paused_until, shockUntil: m.shock_until, reason: m.shock_reason,
    })),
  };
}

/** Fija (o quita, con null) un recargo manual para un jugador. */
export async function setSurchargeOverride(playerId: number, bps: number | null) {
  await pool.query(`INSERT INTO player_flow (player_id, surcharge_override) VALUES ($1, $2)
                    ON CONFLICT (player_id) DO UPDATE SET surcharge_override = $2, updated_at = now()`, [playerId, bps]);
  return { playerId, surchargeOverride: bps };
}
