// Consultas de lectura para el front y para los casinos (equivalente a la Gamma API + Data API de Polymarket).
import { config } from "../config.js";
import { pool, many, one } from "../db/pool.js";
import { bookOf } from "./trading.js";
import { notFound } from "../lib/errors.js";

/** Precio que se muestra: punto medio del libro si el spread es razonable; si no, el último negociado (como Polymarket). */
export function displayPrice(m: { id: number; last_price: number; status: string }) {
  if (m.status !== "open") return m.last_price;
  const b = bookOf(m.id);
  const bid = b.bestBid(), ask = b.bestAsk();
  if (bid !== undefined && ask !== undefined && ask - bid <= 10) return Math.round((bid + ask) / 2);
  return m.last_price;
}

export function maskName(name: string | null, id: number) {
  if (!name) return `Jugador ${String(id).padStart(4, "0").slice(-4)}`;
  const [first, second] = name.trim().split(/\s+/);
  return second ? `${first} ${second[0].toUpperCase()}.` : first;
}

const SORTS: Record<string, string> = {
  volume24h: "volume_24h DESC, e.id DESC",
  volume: "volume DESC, e.id DESC",
  trending: "trend_score DESC, e.id DESC",
  closing: "e.close_time ASC",
  new: "e.created_at DESC",
};

export interface EventFilter { category?: string; status?: string; sort?: string; q?: string; featured?: boolean; limit?: number; offset?: number; ids?: number[]; spark?: boolean }

export async function listEvents(f: EventFilter = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  where.push(`e.status = ANY(${p((f.status ?? "open").split(","))})`);
  if (f.category) where.push(`e.category = ${p(f.category)}`);
  if (f.featured) where.push("e.featured");
  if (f.q) where.push(`(e.title ILIKE ${p(`%${f.q}%`)} OR EXISTS (SELECT 1 FROM markets mm WHERE mm.event_id=e.id AND mm.outcome_label ILIKE $${params.length}))`);
  if (f.ids) where.push(`e.id = ANY(${p(f.ids)})`);
  const limit = Math.min(f.limit ?? 50, 200), offset = f.offset ?? 0;

  const rows = await many(pool, `
    WITH ev AS (
      SELECT e.*,
        COALESCE((SELECT SUM(m.volume) FROM markets m WHERE m.event_id=e.id),0)::bigint AS volume,
        COALESCE((SELECT SUM(t.yes_price * t.qty * 100) FROM trades t JOIN markets m ON m.id=t.market_id WHERE m.event_id=e.id AND t.created_at > now() - interval '24 hours'),0)::bigint AS volume_24h,
        (SELECT COUNT(DISTINCT o.player_id) FROM orders o JOIN markets m ON m.id=o.market_id JOIN players pl ON pl.id=o.player_id WHERE m.event_id=e.id AND NOT pl.is_house)::int AS traders
      FROM events e WHERE ${where.join(" AND ")}
    )
    SELECT e.*, (e.volume_24h::float / 1e6 + 1) * (1 + COALESCE((SELECT MAX(ABS(m.last_price - COALESCE(
        (SELECT price FROM price_history ph WHERE ph.market_id=m.id AND ph.ts <= now() - interval '24 hours' ORDER BY ts DESC LIMIT 1), m.initial_price)))
      FROM markets m WHERE m.event_id=e.id),0)) AS trend_score
    FROM ev e ORDER BY ${SORTS[f.sort ?? "volume24h"] ?? SORTS.volume24h} LIMIT ${limit} OFFSET ${offset}`, params);
  if (!rows.length) return [];

  const markets = await many(pool, `
    SELECT m.*,
      COALESCE((SELECT price FROM price_history ph WHERE ph.market_id=m.id AND ph.ts <= now() - interval '24 hours' ORDER BY ts DESC LIMIT 1), m.initial_price) AS price_24h
    FROM markets m WHERE m.event_id = ANY($1) ORDER BY m.sort, m.id`, [rows.map((r) => r.id)]);
  const sparks = f.spark ? await sparklines(markets.map((m) => m.id)) : undefined;
  return rows.map((e) => {
    const out = serializeEvent(e, markets.filter((m) => m.event_id === e.id));
    if (sparks) out.markets.forEach((m: any) => (m.spark = sparks.get(m.id) ?? []));
    return out;
  });
}

/** Precio del SÍ cada 6 horas durante los últimos 7 días (para las minigráficas de las tarjetas). */
async function sparklines(marketIds: number[]) {
  const rows = await many(pool, `
    SELECT market_id, b, price FROM (
      SELECT DISTINCT ON (market_id, b) market_id, date_bin('6 hours', ts, TIMESTAMPTZ '2000-01-01') AS b, price
      FROM price_history WHERE market_id = ANY($1) AND ts > now() - interval '7 days'
      ORDER BY market_id, b, ts DESC) x ORDER BY market_id, b`, [marketIds]);
  const out = new Map<number, number[]>();
  for (const r of rows) {
    if (!out.has(r.market_id)) out.set(r.market_id, []);
    out.get(r.market_id)!.push(r.price);
  }
  return out;
}

export function serializeEvent(e: any, markets: any[]) {
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    description: e.description,
    category: e.category,
    kind: e.kind,
    negRisk: e.neg_risk,
    status: e.status,
    closeTime: e.close_time,
    imageUrl: e.image_url,
    featured: e.featured,
    tags: e.tags,
    resolutionCriteria: e.resolution_criteria,
    resolutionSource: e.resolution_source,
    volume: e.volume ?? 0,
    volume24h: e.volume_24h ?? 0,
    traders: e.traders ?? 0,
    createdAt: e.created_at,
    markets: markets.map((m) => {
      const price = displayPrice(m);
      const b = bookOf(m.id);
      return {
        id: m.id,
        label: m.outcome_label,
        question: m.question,
        status: m.status,
        price, // centavos del SÍ = probabilidad en %
        change24h: price - (m.price_24h ?? m.initial_price),
        bestBid: b.bestBid() ?? null,
        bestAsk: b.bestAsk() ?? null,
        lastPrice: m.last_price,
        volume: m.volume,
        resolvedOutcome: m.resolved_outcome,
      };
    }),
  };
}

export async function eventDetail(idOrSlug: string) {
  const row = await one(pool, `SELECT id FROM events WHERE ${/^\d+$/.test(idOrSlug) ? "id" : "slug"}=$1`, [idOrSlug]);
  if (!row) throw notFound("Evento no encontrado");
  const [e] = await listEvents({ status: "open,closed,resolving,resolved,void", ids: [row.id], limit: 1 });
  const resolution = await one(pool, `SELECT id, outcome, winning_market_id, status, proposer, explanation, evidence, challenge_ends_at, finalized_at,
      disputed_at, dispute_reason, dispute_result FROM resolutions WHERE event_id=$1 ORDER BY id DESC LIMIT 1`, [e.id]);
  // Resolución con fianzas: si un jugador puede proponer (evento cerrado hace rato y nadie propuso)
  const pending = resolution && ["proposed", "disputed"].includes(resolution.status);
  const proposeFrom = new Date(new Date(e.closeTime).getTime() + config.resolution.playerProposeAfterHours * 3600e3);
  return {
    ...e, resolution: resolution ?? null,
    resolutionOptions: {
      bondUsd: config.resolution.playerBondUsd,
      challengeMinutes: config.challengeWindowMinutes,
      canDispute: resolution?.status === "proposed" && new Date(resolution.challenge_ends_at) > new Date(),
      canPropose: ["closed", "resolving"].includes(e.status) && !pending && proposeFrom <= new Date(),
      proposeFrom,
    },
  };
}

export async function marketBook(marketId: number) {
  const m = await one(pool, "SELECT id, status FROM markets WHERE id=$1", [marketId]);
  if (!m) throw notFound("Mercado no encontrado");
  const { bids, asks } = bookOf(marketId).levels(15);
  const toShares = (l: [number, number][]) => l.map(([price, qty]) => ({ price, shares: qty / 100 }));
  // Vista del NO: es el espejo del libro del SÍ
  return {
    marketId,
    yes: { bids: toShares(bids), asks: toShares(asks) },
    no: { bids: toShares(asks.map(([p, q]) => [100 - p, q])), asks: toShares(bids.map(([p, q]) => [100 - p, q])) },
  };
}

const INTERVALS: Record<string, { span: string; bin: string }> = {
  "1d": { span: "1 day", bin: "10 minutes" },
  "1w": { span: "7 days", bin: "1 hour" },
  "1m": { span: "30 days", bin: "6 hours" },
  all: { span: "10 years", bin: "1 day" },
};

/** Serie de precios del SÍ: último precio de cada intervalo, con el valor previo como punto de partida. */
export async function priceHistory(marketId: number, interval = "1w") {
  const it = INTERVALS[interval] ?? INTERVALS["1w"];
  const start = await one(pool,
    `SELECT price FROM price_history WHERE market_id=$1 AND ts <= now() - $2::interval ORDER BY ts DESC LIMIT 1`, [marketId, it.span]);
  const rows = await many(pool, `
    SELECT DISTINCT ON (b) b AS t, price AS p FROM (
      SELECT date_bin($3::interval, ts, TIMESTAMPTZ '2000-01-01') AS b, price, ts FROM price_history
      WHERE market_id=$1 AND ts > now() - $2::interval
    ) x ORDER BY b, ts DESC`, [marketId, it.span, it.bin]);
  const points = rows.map((r) => ({ t: r.t, p: r.p }));
  if (start) points.unshift({ t: new Date(Date.now() - parseSpan(it.span)), p: start.price });
  const m = await one(pool, "SELECT id, last_price, status FROM markets WHERE id=$1", [marketId]);
  if (m) points.push({ t: new Date(), p: displayPrice(m) });
  return points;
}
const parseSpan = (s: string) => Number(s.split(" ")[0]) * (s.includes("day") ? 864e5 : s.includes("year") ? 365 * 864e5 : 3600e3);

export async function recentTrades(opts: { marketId?: number; limit?: number } = {}) {
  const rows = await many(pool, `
    SELECT t.id, t.market_id, t.yes_price, t.qty, t.created_at, o.side, o.outcome, o.player_id, pl.display_name, pl.is_house,
           m.question, m.outcome_label, m.event_id, e.title AS event_title, e.kind
    FROM trades t JOIN orders o ON o.id=t.taker_order_id JOIN players pl ON pl.id=o.player_id
    JOIN markets m ON m.id=t.market_id JOIN events e ON e.id=m.event_id
    WHERE NOT pl.is_house ${opts.marketId ? "AND t.market_id=$2" : ""}
    ORDER BY t.id DESC LIMIT $1`, opts.marketId ? [opts.limit ?? 30, opts.marketId] : [opts.limit ?? 30]);
  return rows.map((r) => {
    const price = r.outcome === "YES" ? r.yes_price : 100 - r.yes_price;
    return {
      id: r.id, marketId: r.market_id, eventId: r.event_id, eventTitle: r.event_title, outcomeLabel: r.kind === "multi" ? r.outcome_label : null,
      player: maskName(r.display_name, r.player_id), side: r.side, outcome: r.outcome, price, shares: r.qty / 100,
      amount: price * r.qty * 100, at: r.created_at,
    };
  });
}

export async function platformStats() {
  const s = await one(pool, `
    SELECT
      COALESCE((SELECT SUM(yes_price * qty * 100) FROM trades WHERE created_at > now() - interval '24 hours'),0)::bigint AS volume_24h,
      COALESCE((SELECT SUM(yes_price * qty * 100) FROM trades WHERE created_at BETWEEN now() - interval '48 hours' AND now() - interval '24 hours'),0)::bigint AS volume_prev_24h,
      (SELECT COUNT(*) FROM trades WHERE created_at > now() - interval '24 hours')::int AS trades_24h,
      (SELECT COUNT(*) FROM events WHERE status='open')::int AS open_events,
      (SELECT COUNT(*) FROM events WHERE created_at > now() - interval '24 hours')::int AS new_events_24h,
      (SELECT COUNT(*) FROM events WHERE status='open' AND close_time < now() + interval '24 hours')::int AS closing_24h,
      (SELECT COUNT(*) FROM players WHERE NOT is_house AND last_seen_at > now() - interval '5 minutes')::int AS players_online`);
  const byCategory = await many(pool, `
    SELECT e.category, c.name, COALESCE(SUM(t.yes_price * t.qty * 100),0)::bigint AS volume
    FROM categories c LEFT JOIN events e ON e.category=c.slug LEFT JOIN markets m ON m.event_id=e.id
    LEFT JOIN trades t ON t.market_id=m.id AND t.created_at > now() - interval '24 hours'
    GROUP BY e.category, c.name, c.sort HAVING e.category IS NOT NULL ORDER BY volume DESC`);
  // Volumen por hora de las últimas 24 h (24 puntos, con ceros donde no hubo cruces)
  const hourly = await many(pool, `
    SELECT h AS t, COALESCE(SUM(t.yes_price * t.qty * 100),0)::bigint AS volume
    FROM generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') h
    LEFT JOIN trades t ON date_trunc('hour', t.created_at) = h GROUP BY h ORDER BY h`);
  const events = await listEvents({ limit: 200 });
  const movers = events.flatMap((e) => e.markets.map((m) => ({ eventId: e.id, marketId: m.id, title: e.title, label: e.kind === "multi" ? m.label : null, category: e.category, price: m.price, change24h: m.change24h })))
    .filter((m) => m.change24h !== 0).sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
  return { ...s, byCategory, hourlyVolume: hourly, movers: movers.slice(0, 20) };
}
