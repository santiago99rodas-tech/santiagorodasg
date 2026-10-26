// Calibración, sesgo e integridad: mide si los precios predicen bien y detecta sesgos y comportamientos raros.
// Todo se calcula con datos que ya se guardan (historial de precios, resoluciones, cruces y posiciones).

import { pool, many, one } from "../db/pool.js";
import { config } from "../config.js";
import { displayPrice, maskName } from "./marketdata.js";
import { houseAccount } from "./house.js";
import { bad, notFound } from "../lib/errors.js";

const MIN_RELIABLE = 30; // por debajo de esto, los números son anecdóticos
const brier = (rows: { p: number; o: number }[]) => (rows.length ? rows.reduce((a, r) => a + (r.p - r.o) ** 2, 0) / rows.length : null);
const round = (v: number | null, d = 4) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// Países que pueden aparecer como opción de un mercado, con su código ISO (para el sesgo de hinchada)
export const COUNTRY_LABELS: Record<string, string> = {
  colombia: "CO", ecuador: "EC", venezuela: "VE", "méxico": "MX", mexico: "MX", "perú": "PE", peru: "PE", argentina: "AR", chile: "CL",
  brasil: "BR", uruguay: "UY", paraguay: "PY", bolivia: "BO", "panamá": "PA", panama: "PA", "costa rica": "CR", "puerto rico": "PR",
  "república dominicana": "DO", guatemala: "GT", honduras: "HN", "el salvador": "SV", nicaragua: "NI", cuba: "CU", "españa": "ES", espana: "ES",
  "estados unidos": "US", "ee. uu.": "US",
};

interface Resolved {
  id: number; category: string; kind: string; outcome: "YES" | "NO"; initial: number; volume: number;
  pRef: number; pClose: number; origin: string; question: string;
}

async function resolvedMarkets(horizonHours: number): Promise<Resolved[]> {
  const rows = await many(pool, `
    WITH res AS (
      SELECT m.id, m.question, e.category, e.kind, m.resolved_outcome, m.initial_price, m.volume, e.draft_id,
        LEAST(m.close_time, COALESCE((SELECT MIN(r.created_at) FROM resolutions r WHERE r.event_id = e.id), m.close_time), COALESCE(m.resolved_at, m.close_time)) AS end_t
      FROM markets m JOIN events e ON e.id = m.event_id
      WHERE m.resolved_outcome IN ('YES','NO')
    )
    SELECT res.*,
      COALESCE((SELECT price FROM price_history ph WHERE ph.market_id = res.id AND ph.ts <= res.end_t - make_interval(hours => $1) ORDER BY ts DESC LIMIT 1), res.initial_price) AS p_ref,
      COALESCE((SELECT price FROM price_history ph WHERE ph.market_id = res.id AND ph.ts <= res.end_t ORDER BY ts DESC LIMIT 1), res.initial_price) AS p_close,
      CASE WHEN d.created_by LIKE 'ai:%' THEN 'ia' WHEN d.id IS NOT NULL THEN 'borrador manual' ELSE 'catálogo o diseñador' END AS origin
    FROM res LEFT JOIN drafts d ON d.id = res.draft_id`, [horizonHours]);
  return rows.map((r) => ({ id: r.id, question: r.question, category: r.category, kind: r.kind, outcome: r.resolved_outcome, initial: r.initial_price / 100, volume: r.volume,
    pRef: r.p_ref / 100, pClose: r.p_close / 100, origin: r.origin }));
}

function scoreGroup(rows: Resolved[]) {
  const o = (r: Resolved) => (r.outcome === "YES" ? 1 : 0);
  const n = rows.length;
  const baseRate = n ? rows.reduce((a, r) => a + o(r), 0) / n : null;
  return {
    n,
    brierRef: round(brier(rows.map((r) => ({ p: r.pRef, o: o(r) })))),
    brierClose: round(brier(rows.map((r) => ({ p: r.pClose, o: o(r) })))),
    brierInitial: round(brier(rows.map((r) => ({ p: r.initial, o: o(r) })))),
    // Referencia "sin información": decir siempre la tasa base observada
    brierBaseRate: baseRate == null ? null : round(baseRate * (1 - baseRate)),
    baseRate: round(baseRate, 3),
  };
}

function groupBy<T>(rows: T[], key: (r: T) => string) {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
  return m;
}

const volumeTier = (micros: number) => (micros < 100e6 ? "menos de $100" : micros < 1000e6 ? "$100 a $1.000" : "más de $1.000");

export async function integrityReport(opts: { horizonHours?: number } = {}) {
  const horizon = opts.horizonHours ?? 168;
  const resolved = await resolvedMarkets(horizon);
  const o = (r: Resolved) => (r.outcome === "YES" ? 1 : 0);

  // ---------- Calibración ----------
  const bins = Array.from({ length: 10 }, (_, i) => {
    const lo = i / 10, hi = (i + 1) / 10;
    const rows = resolved.filter((r) => r.pRef >= lo && (i === 9 ? r.pRef <= hi : r.pRef < hi));
    return { from: lo, to: hi, n: rows.length,
      predicted: rows.length ? round(rows.reduce((a, r) => a + r.pRef, 0) / rows.length, 3) : null,
      actual: rows.length ? round(rows.reduce((a, r) => a + o(r), 0) / rows.length, 3) : null };
  });
  const cats = await many(pool, "SELECT slug, name FROM categories ORDER BY sort");
  const byCategory = [...groupBy(resolved, (r) => r.category)].map(([slug, rows]) => ({ category: slug, name: cats.find((c) => c.slug === slug)?.name ?? slug, ...scoreGroup(rows) }))
    .sort((a, b) => b.n - a.n);
  const byVolume = ["menos de $100", "$100 a $1.000", "más de $1.000"].map((tier) => ({ tier, ...scoreGroup(resolved.filter((r) => volumeTier(r.volume) === tier)) }));

  // ---------- Sesgos ----------
  const gap = (rows: Resolved[]) => (rows.length ? round(rows.reduce((a, r) => a + (o(r) - r.pRef), 0) / rows.length, 3) : null);
  const longshot = {
    // Negativo en "batacazos" = se cumplen menos de lo que dice su precio (los jugadores pagan de más por lo improbable)
    longshots: { n: resolved.filter((r) => r.pRef < 0.2).length, gap: gap(resolved.filter((r) => r.pRef < 0.2)) },
    favorites: { n: resolved.filter((r) => r.pRef > 0.8).length, gap: gap(resolved.filter((r) => r.pRef > 0.8)) },
  };
  const yesNo = await many(pool, `
    SELECT e.category, c.name,
      COUNT(*) FILTER (WHERE m.resolved_outcome='YES')::int AS yes,
      COUNT(*) FILTER (WHERE m.resolved_outcome='NO')::int AS no,
      COUNT(*) FILTER (WHERE m.resolved_outcome='VOID')::int AS void
    FROM markets m JOIN events e ON e.id=m.event_id JOIN categories c ON c.slug=e.category
    WHERE e.kind='binary' AND m.resolved_outcome IS NOT NULL GROUP BY e.category, c.name, c.sort ORDER BY c.sort`);
  const openingAccuracy = [...groupBy(resolved, (r) => r.origin)].map(([origin, rows]) => ({ origin, ...scoreGroup(rows) }));

  // ---------- Integridad ----------
  const house = await houseAccount();
  const takerFlows = await many(pool, `
    SELECT t.market_id, o.player_id, o.outcome, m.question, m.outcome_label, m.status, e.id AS event_id, e.title, e.kind,
      SUM((CASE WHEN o.outcome='YES' THEN t.yes_price ELSE 100 - t.yes_price END) * t.qty * 100)::bigint AS amount
    FROM trades t JOIN orders o ON o.id=t.taker_order_id JOIN markets m ON m.id=t.market_id JOIN events e ON e.id=m.event_id
    WHERE o.player_id <> $1 AND o.side='BUY'
    GROUP BY t.market_id, o.player_id, o.outcome, m.question, m.outcome_label, m.status, e.id, e.title, e.kind`, [house]);

  // Concentración en mercados abiertos
  const minVol = config.integrity.minVolumeUsd * 1e6;
  const concentration = [...groupBy(takerFlows.filter((f) => f.status === "open"), (f) => String(f.market_id))].map(([, flows]) => {
    const byPlayer = new Map<number, number>();
    for (const f of flows) byPlayer.set(f.player_id, (byPlayer.get(f.player_id) ?? 0) + f.amount);
    const amounts = [...byPlayer.values()].sort((a, b) => b - a);
    const total = amounts.reduce((a, b) => a + b, 0);
    return { marketId: flows[0].market_id, title: flows[0].kind === "multi" ? `${flows[0].title} · ${flows[0].outcome_label}` : flows[0].title,
      total, players: amounts.length, top1: total ? round(amounts[0] / total, 3) : 0, top5: total ? round(amounts.slice(0, 5).reduce((a, b) => a + b, 0) / total, 3) : 0 };
  }).filter((c) => c.total >= minVol && (c.top1! >= 0.5 || c.top5! >= 0.8)).sort((a, b) => b.top1! - a.top1!).slice(0, 50);

  // Sesgo de hinchada: dinero al Sí de "su" país frente a la proporción de jugadores de ese país en el evento
  const players = new Map((await many(pool, "SELECT id, country FROM players WHERE country IS NOT NULL")).map((p) => [p.id, p.country]));
  const homeBias: any[] = [];
  for (const [, flows] of groupBy(takerFlows, (f) => String(f.event_id))) {
    const bettors = new Set(flows.map((f) => f.player_id));
    const withCountry = [...bettors].filter((id) => players.has(id));
    if (withCountry.length < 3) continue;
    for (const [, mflows] of groupBy(flows.filter((f) => f.outcome === "YES"), (f) => String(f.market_id))) {
      const code = COUNTRY_LABELS[String(mflows[0].outcome_label).toLowerCase().trim()];
      if (!code) continue;
      const total = mflows.reduce((a, f) => a + f.amount, 0);
      if (total < minVol) continue;
      const fromHome = mflows.filter((f) => players.get(f.player_id) === code).reduce((a, f) => a + f.amount, 0);
      const homeShareOfBettors = withCountry.filter((id) => players.get(id) === code).length / withCountry.length;
      homeBias.push({ marketId: mflows[0].market_id, title: `${mflows[0].title} · ${mflows[0].outcome_label}`, country: code, totalYes: total,
        moneyFromHome: round(fromHome / total, 3), bettorsFromHome: round(homeShareOfBettors, 3),
        ratio: homeShareOfBettors > 0 ? round(fromHome / total / homeShareOfBettors, 2) : null });
    }
  }
  homeBias.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));

  // Resultado de la casa en los mercados que se resolvieron, según quién propuso
  const houseByResolver = await many(pool, `
    SELECT CASE WHEN r.proposer LIKE 'ai:%' THEN 'IA' ELSE r.proposer END AS proposer,
      COUNT(DISTINCT r.event_id)::int AS events,
      COUNT(DISTINCT r.event_id) FILTER (WHERE x.pnl > 0)::int AS house_won,
      COALESCE(SUM(x.pnl),0)::bigint AS house_pnl
    FROM resolutions r
    LEFT JOIN LATERAL (SELECT SUM(ps.realized) AS pnl FROM positions ps JOIN markets m ON m.id=ps.market_id WHERE m.event_id=r.event_id AND ps.player_id=$1) x ON true
    WHERE r.status='finalized' GROUP BY 1 ORDER BY events DESC`, [house]);

  // Alertas: compras grandes en el lado ganador justo antes del cierre o de la propuesta, y cuentas nuevas con apuestas grandes
  const lateWinners = await many(pool, `
    WITH m AS (
      SELECT m.id, m.question, m.resolved_outcome, e.kind, e.title, m.outcome_label,
        LEAST(m.close_time, COALESCE((SELECT MIN(r.created_at) FROM resolutions r WHERE r.event_id=e.id), m.close_time)) AS end_t
      FROM markets m JOIN events e ON e.id=m.event_id WHERE m.resolved_outcome IN ('YES','NO')
    )
    SELECT m.id AS market_id, CASE WHEN m.kind='multi' THEN m.title || ' · ' || m.outcome_label ELSE m.title END AS title,
      o.player_id, p.display_name, p.external_id, p.operator_id, p.created_at AS player_since,
      SUM((CASE WHEN o.outcome='YES' THEN t.yes_price ELSE 100 - t.yes_price END) * t.qty * 100)::bigint AS amount,
      ROUND(EXTRACT(EPOCH FROM (m.end_t - MIN(t.created_at))) / 60)::int AS minutes_before
    FROM m JOIN trades t ON t.market_id=m.id JOIN orders o ON o.id=t.taker_order_id JOIN players p ON p.id=o.player_id
    WHERE o.side='BUY' AND o.outcome=m.resolved_outcome AND NOT p.is_house
      AND t.created_at BETWEEN m.end_t - make_interval(mins => $1) AND m.end_t
    GROUP BY m.id, m.kind, m.title, m.outcome_label, m.end_t, o.player_id, p.display_name, p.external_id, p.operator_id, p.created_at
    HAVING SUM((CASE WHEN o.outcome='YES' THEN t.yes_price ELSE 100 - t.yes_price END) * t.qty * 100) >= $2
    ORDER BY amount DESC LIMIT 50`, [config.integrity.lateWindowMinutes, config.integrity.alertMinUsd * 1e6]);
  const newAccounts = await many(pool, `
    SELECT o.player_id, p.display_name, p.external_id, p.operator_id, p.created_at AS player_since,
      SUM((CASE WHEN o.outcome='YES' THEN t.yes_price ELSE 100 - t.yes_price END) * t.qty * 100)::bigint AS amount, COUNT(DISTINCT t.market_id)::int AS markets
    FROM trades t JOIN orders o ON o.id=t.taker_order_id JOIN players p ON p.id=o.player_id
    WHERE NOT p.is_house AND o.side='BUY' AND p.created_at > now() - interval '7 days' AND t.created_at > now() - interval '24 hours'
    GROUP BY o.player_id, p.display_name, p.external_id, p.operator_id, p.created_at
    HAVING SUM((CASE WHEN o.outcome='YES' THEN t.yes_price ELSE 100 - t.yes_price END) * t.qty * 100) >= $1
    ORDER BY amount DESC LIMIT 50`, [config.integrity.alertMinUsd * 2e6]);
  const alerts = [
    ...lateWinners.map((a) => ({ kind: "compra tardía ganadora", marketId: a.market_id, title: a.title, player: `${maskName(a.display_name, a.player_id)} (${a.operator_id ?? "casa"}:${a.external_id})`,
      amount: a.amount, detail: `${a.minutes_before} min antes del cierre o de la propuesta · cuenta desde ${new Date(a.player_since).toISOString().slice(0, 10)}` })),
    ...newAccounts.map((a) => ({ kind: "cuenta nueva con apuestas grandes", marketId: null, title: `${a.markets} mercado(s) en 24 h`, player: `${maskName(a.display_name, a.player_id)} (${a.operator_id ?? "casa"}:${a.external_id})`,
      amount: a.amount, detail: `cuenta creada ${new Date(a.player_since).toISOString().slice(0, 10)}` })),
  ];

  // Referencias externas: último precio externo frente al nuestro
  const refs = await many(pool, `
    SELECT DISTINCT ON (rp.market_id, rp.source) rp.market_id, rp.source, rp.price AS ref_price, rp.captured_at, rp.note,
      m.id, m.last_price, m.status, m.external_ref, CASE WHEN e.kind='multi' THEN e.title || ' · ' || m.outcome_label ELSE e.title END AS title
    FROM reference_prices rp JOIN markets m ON m.id=rp.market_id JOIN events e ON e.id=m.event_id
    ORDER BY rp.market_id, rp.source, rp.captured_at DESC`);
  const external = refs.map((r) => {
    const ours = displayPrice({ id: r.id, last_price: r.last_price, status: r.status });
    return { marketId: r.market_id, title: r.title, source: r.source, refPrice: r.ref_price, ourPrice: ours, diff: ours - r.ref_price, capturedAt: r.captured_at, note: r.note, externalRef: r.external_ref };
  }).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    horizonHours: horizon,
    reliable: resolved.length >= MIN_RELIABLE,
    minReliable: MIN_RELIABLE,
    overall: scoreGroup(resolved),
    calibration: bins,
    byCategory, byVolume,
    bias: { longshot, yesNo, openingAccuracy },
    integrity: { concentration, homeBias: homeBias.slice(0, 50), houseByResolver, alerts, countryCoverage: players.size },
    external,
    thresholds: { minVolumeUsd: config.integrity.minVolumeUsd, alertMinUsd: config.integrity.alertMinUsd, lateWindowMinutes: config.integrity.lateWindowMinutes, maxStakePerMarketUsd: config.integrity.maxStakePerMarketUsd },
  };
}

// ---------- Referencias externas ----------
export async function setExternalRef(marketId: number, ref: string | null) {
  if (ref && !/^polymarket:[\w-]+$/.test(ref)) throw bad("invalid_ref", 'Formato esperado: "polymarket:<slug-del-mercado>"');
  const m = await one(pool, "UPDATE markets SET external_ref=$2 WHERE id=$1 RETURNING id, external_ref", [marketId, ref]);
  if (!m) throw notFound("Mercado no encontrado");
  return m;
}

export async function addReferencePrice(marketId: number, input: { source: string; price: number; note?: string }, by: string) {
  if (!(input.price >= 0 && input.price <= 100)) throw bad("invalid_price", "El precio de referencia va de 0 a 100 (probabilidad del Sí en %)");
  const m = await one(pool, "SELECT id FROM markets WHERE id=$1", [marketId]);
  if (!m) throw notFound("Mercado no encontrado");
  return one(pool, "INSERT INTO reference_prices (market_id, source, price, note, captured_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [marketId, input.source.slice(0, 60), Math.round(input.price), input.note ?? null, by]);
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** Lee el precio del Sí en Polymarket (API pública Gamma) para los mercados que tienen external_ref. */
export async function refreshExternalPrices(fetcher: Fetcher = fetch as unknown as Fetcher) {
  const rows = await many(pool, "SELECT id, external_ref FROM markets WHERE external_ref LIKE 'polymarket:%' AND status='open'");
  let updated = 0;
  for (const r of rows) {
    const slug = r.external_ref.slice("polymarket:".length);
    try {
      const res = await fetcher(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`);
      if (!res.ok) continue;
      const data = await res.json();
      const mk = Array.isArray(data) ? data[0] : data;
      if (!mk) continue;
      const outcomes: string[] = typeof mk.outcomes === "string" ? JSON.parse(mk.outcomes) : mk.outcomes;
      const prices: string[] = typeof mk.outcomePrices === "string" ? JSON.parse(mk.outcomePrices) : mk.outcomePrices;
      const yesIdx = Math.max(0, outcomes.findIndex((x) => /^yes$/i.test(x)));
      const price = Math.round(Number(prices[yesIdx]) * 100);
      if (!Number.isFinite(price)) continue;
      await pool.query("INSERT INTO reference_prices (market_id, source, price, captured_by) VALUES ($1,'Polymarket',$2,'sistema')", [r.id, price]);
      updated++;
    } catch { /* se reintenta en la próxima pasada */ }
  }
  return updated;
}
