// Oráculo de probabilidades: publica, firmado, lo que la plataforma cree que va a pasar y qué tan
// bien le ha ido creyéndolo.
//
//   - Probabilidad de cada mercado: el precio justo del market maker (aprende del dinero de los
//     jugadores y de referencias externas, docs/MARKET-MAKER.md), con compra/venta, volumen y una
//     etiqueta de confianza según liquidez.
//   - Historial de calibración (track record): Brier y tramos de calibración con los mercados ya
//     resueltos, por categoría, y cómo se han resuelto las propuestas (disputas, fianzas).
//   - Firma Ed25519 sobre el cuerpo exacto de cada respuesta (cabecera X-Oracle-Signature), para que
//     un tercero verifique que el dato salió de aquí y no se alteró. La clave pública está en
//     /v1/oracle/keys.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { pool, many, one } from "../db/pool.js";
import { config } from "../config.js";
import { notFound } from "../lib/errors.js";
import { bookOf } from "./trading.js";
import { integrityReport } from "./integrity.js";

// ---------- claves y firma ----------

interface OracleKey { id: string; publicPem: string; privateKey: KeyObject }
let cached: OracleKey | null = null;

const keyIdOf = (publicPem: string) =>
  createHash("sha256").update(createPublicKey(publicPem).export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);

/** Clave del oráculo: ORACLE_PRIVATE_KEY si está configurada; si no, la guardada en la base (o una nueva). */
export async function oracleKey(): Promise<OracleKey> {
  if (cached) return cached;
  let privatePem = config.oracle.privateKeyPem;
  if (!privatePem) {
    const row = await one(pool, "SELECT private_pem FROM oracle_keys ORDER BY created_at DESC LIMIT 1");
    if (row) privatePem = row.private_pem;
    else {
      const kp = generateKeyPairSync("ed25519");
      privatePem = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const publicPem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
      await pool.query("INSERT INTO oracle_keys (id, public_pem, private_pem) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [keyIdOf(publicPem), publicPem, privatePem]);
      console.log(`[oráculo] clave Ed25519 nueva ${keyIdOf(publicPem)}. Para fijarla entre despliegues, configura ORACLE_PRIVATE_KEY.`);
    }
  }
  const privateKey = createPrivateKey(privatePem);
  const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  cached = { id: keyIdOf(publicPem), publicPem, privateKey };
  return cached;
}
export function resetOracleKeyCache() { cached = null; }

/** Arma el cuerpo firmado: { oracle, keyId, issuedAt, data } y su firma Ed25519 (base64) sobre esos bytes exactos. */
export async function signed(data: unknown) {
  const k = await oracleKey();
  const body = JSON.stringify({ oracle: config.oracle.name, keyId: k.id, issuedAt: new Date().toISOString(), data });
  return { body, keyId: k.id, signature: sign(null, Buffer.from(body), k.privateKey).toString("base64") };
}

/** Verificación (la misma que haría un tercero con la clave pública). */
export const verifySignature = (body: string, signatureB64: string, publicPem: string) =>
  verify(null, Buffer.from(body), createPublicKey(publicPem), Buffer.from(signatureB64, "base64"));

export async function oracleKeys() {
  const k = await oracleKey();
  return { keys: [{ kid: k.id, alg: "Ed25519", publicKeyPem: k.publicPem }],
    howToVerify: "Firma Ed25519 (base64, cabecera X-Oracle-Signature) sobre los bytes exactos del cuerpo de la respuesta. X-Oracle-Key-Id indica la clave." };
}

// ---------- probabilidades ----------

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** Confianza según volumen negociado y ancho del spread de la casa. */
function confidence(volumeUsd: number, spread: number | null) {
  if (volumeUsd >= 1000 && spread !== null && spread <= 6) return "alta";
  if (volumeUsd >= 100 && spread !== null && spread <= 10) return "media";
  return "baja";
}

function serialize(m: any) {
  const book = m.status === "open" ? bookOf(m.id) : null;
  const bid = book?.bestBid() ?? null, ask = book?.bestAsk() ?? null;
  const fair = m.fair_exact != null ? Number(m.fair_exact) : m.fair_price / 100;
  const resolved = ["resolved", "void"].includes(m.status);
  const volumeUsd = Math.round(Number(m.volume) / 1e6);
  return {
    marketId: m.id, eventId: m.event_id, event: m.title, outcome: m.kind === "multi" ? m.outcome_label : "Sí",
    question: m.question, category: m.category, kind: m.kind, status: m.status, closeTime: m.close_time,
    probability: resolved ? (m.resolved_outcome === "YES" ? 1 : m.resolved_outcome === "NO" ? 0 : 0.5) : r4(fair),
    bid: bid !== null ? bid / 100 : null, ask: ask !== null ? ask / 100 : null, lastTrade: m.last_price / 100,
    volumeUsd, confidence: resolved ? "resuelto" : confidence(volumeUsd, bid !== null && ask !== null ? ask - bid : null),
    external: m.ext_price != null ? { source: m.ext_source, probability: m.ext_price / 100, capturedAt: m.ext_at } : null,
    resolution: resolved ? { outcome: m.resolved_outcome, resolvedAt: m.resolved_at } : null,
  };
}

const MARKET_SQL = `
  SELECT m.*, e.title, e.kind, e.category, x.price AS ext_price, x.source AS ext_source, x.captured_at AS ext_at
  FROM markets m JOIN events e ON e.id = m.event_id
  LEFT JOIN LATERAL (SELECT price, source, captured_at FROM reference_prices r WHERE r.market_id = m.id ORDER BY r.id DESC LIMIT 1) x ON TRUE`;

export async function oracleMarkets(q: { status?: string; category?: string; limit?: number; offset?: number } = {}) {
  const status = q.status === "resolved" ? ["resolved", "void"] : q.status === "all" ? ["open", "closed", "resolving", "resolved", "void"] : ["open"];
  const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
  const rows = await many(pool, `${MARKET_SQL}
    WHERE m.status = ANY($1) AND ($2::text IS NULL OR e.category = $2)
    ORDER BY m.volume DESC, m.id LIMIT $3 OFFSET $4`, [status, q.category ?? null, limit, Number(q.offset ?? 0)]);
  return { count: rows.length, markets: rows.map(serialize) };
}

export async function oracleMarket(id: number) {
  const m = await one(pool, `${MARKET_SQL} WHERE m.id = $1`, [id]);
  if (!m) throw notFound("Mercado no encontrado");
  // Historia diaria del precio justo (último dato de cada día) de los últimos 90 días
  const history = await many(pool, `
    SELECT DISTINCT ON (date_trunc('day', ts)) date_trunc('day', ts) AS day, COALESCE(fair, price) AS p
    FROM price_history WHERE market_id=$1 AND ts > now() - interval '90 days' ORDER BY date_trunc('day', ts), ts DESC`, [id]);
  const res = await many(pool, `
    SELECT r.id, r.outcome, r.winning_market_id, r.status, r.proposer, r.explanation, r.evidence, r.challenge_ends_at, r.created_at, r.finalized_at,
           r.disputed_at, r.dispute_reason, r.dispute_evidence, r.dispute_result,
           (SELECT json_agg(json_build_object('role', b.role, 'by', CASE WHEN b.player_id IS NULL THEN 'casa' ELSE 'jugador' END,
                    'amountUsd', b.amount / 1e6, 'status', b.status, 'payoutUsd', b.payout / 1e6) ORDER BY b.id)
              FROM resolution_bonds b WHERE b.resolution_id = r.id) AS bonds
    FROM resolutions r WHERE r.event_id = $1 ORDER BY r.id`, [m.event_id]);
  return {
    ...serialize(m),
    history: history.map((h) => ({ date: h.day, probability: r4(Number(h.p) / 100) })),
    resolutionCriteria: (await one(pool, "SELECT resolution_criteria, resolution_source FROM events WHERE id=$1", [m.event_id])),
    resolutions: res.map((r) => ({
      id: r.id, status: r.status, outcome: r.outcome, winningMarketId: r.winning_market_id,
      proposer: r.proposer.startsWith("jugador") ? "jugador" : r.proposer.split(":")[0], explanation: r.explanation, evidence: r.evidence,
      proposedAt: r.created_at, challengeEndsAt: r.challenge_ends_at, finalizedAt: r.finalized_at,
      dispute: r.disputed_at ? { at: r.disputed_at, reason: r.dispute_reason, evidence: r.dispute_evidence, result: r.dispute_result } : null,
      bonds: r.bonds ?? [],
    })),
  };
}

// ---------- historial de calibración ----------

let trackCache: { at: number; data: unknown } | null = null;

export async function trackRecord() {
  if (trackCache && Date.now() - trackCache.at < 5 * 60_000) return trackCache.data;
  const [day, week] = await Promise.all([integrityReport({ horizonHours: 24 }), integrityReport({ horizonHours: 168 })]);
  const pick = (r: Awaited<ReturnType<typeof integrityReport>>) => ({
    horizonHours: r.horizonHours, resolvedMarkets: r.overall.n, reliable: r.reliable,
    brier: r.overall.brierRef, brierAtClose: r.overall.brierClose, brierOpening: r.overall.brierInitial, brierBaseRate: r.overall.brierBaseRate,
    calibration: r.calibration,
    byCategory: r.byCategory.filter((c) => c.n >= 5).map((c) => ({ category: c.category, name: c.name, n: c.n, brier: c.brierRef })),
    longshotBias: r.bias.longshot,
  });
  const res = await one(pool, `
    SELECT COUNT(*) FILTER (WHERE r.status='finalized')::int AS finalized,
           COUNT(*) FILTER (WHERE r.disputed_at IS NOT NULL)::int AS disputed,
           COUNT(*) FILTER (WHERE r.dispute_result='dispute_upheld')::int AS disputes_upheld,
           COUNT(*) FILTER (WHERE r.dispute_result='proposal_upheld')::int AS proposals_upheld,
           COUNT(*) FILTER (WHERE r.status='finalized' AND r.proposer='ai')::int AS by_ai,
           COUNT(*) FILTER (WHERE r.status='finalized' AND r.proposer_player_id IS NOT NULL)::int AS by_players,
           ROUND(AVG(EXTRACT(EPOCH FROM (r.finalized_at - e.close_time)) / 3600) FILTER (WHERE r.status='finalized' AND r.finalized_at > e.close_time)::numeric, 1) AS avg_hours_to_finalize
    FROM resolutions r JOIN events e ON e.id = r.event_id`);
  const bonds = await one(pool, `
    SELECT COALESCE(SUM(amount) FILTER (WHERE status='forfeited'),0)::bigint AS forfeited,
           COALESCE(SUM(payout - amount) FILTER (WHERE status='rewarded'),0)::bigint AS rewards,
           COALESCE(SUM(payout - amount) FILTER (WHERE status='rewarded' AND role='disputer'),0)::bigint AS paid_to_disputers
    FROM resolution_bonds`);
  const data = {
    summary: "Brier: error cuadrático medio entre la probabilidad publicada y el resultado (0 = perfecto; 0,25 = decir siempre 50%). Medido 24 h y 7 días antes de que se conociera el resultado.",
    horizons: [pick(day), pick(week)],
    resolutions: {
      finalized: res?.finalized ?? 0, disputed: res?.disputed ?? 0, disputesUpheld: res?.disputes_upheld ?? 0, proposalsUpheld: res?.proposals_upheld ?? 0,
      proposedByAi: res?.by_ai ?? 0, proposedByPlayers: res?.by_players ?? 0, avgHoursToFinalize: res?.avg_hours_to_finalize == null ? null : Number(res.avg_hours_to_finalize),
      bonds: { playerBondUsd: config.resolution.playerBondUsd, houseBondUsd: config.resolution.houseBondUsd, rewardShare: config.resolution.rewardShare,
        forfeitedUsd: Number(bonds?.forfeited ?? 0) / 1e6, rewardsPaidUsd: Number(bonds?.rewards ?? 0) / 1e6, paidToDisputersUsd: Number(bonds?.paid_to_disputers ?? 0) / 1e6 },
      challengeWindowMinutes: config.challengeWindowMinutes,
    },
  };
  trackCache = { at: Date.now(), data };
  return data;
}
export function resetTrackRecordCache() { trackCache = null; }
