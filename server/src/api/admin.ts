// API de administración: fuentes, ingesta, tendencias, moderación de preguntas, resolución, operadores.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, one, many } from "../db/pool.js";
import { parse, requireAdmin, adminUser } from "./auth.js";
import { notFound, AppError } from "../lib/errors.js";
import { randomToken } from "../lib/crypto.js";
import { runIngest, addSocialSignal, detectTrends } from "../ingest/pipeline.js";
import { generateForTrend, generateForTopTrends, generateForCategory, categoryCoverage, refillCategories } from "../ai/questions.js";
import { aiResolve } from "../ai/resolver.js";
import { listDrafts, approveDraft, rejectDraft, createManualDraft } from "../services/drafts.js";
import { createEvent } from "../services/events.js";
import { propose, dispute, reject, finalize, closeExpired, decide } from "../services/resolution.js";
import { cancelAllInMarket } from "../services/trading.js";
import { refreshQuotes, houseStats, mmStatus, setKillSwitch } from "../services/marketmaker.js";
import { houseAccount } from "../services/house.js";
import { listEvents } from "../services/marketdata.js";
import { listMarketMakers, createMarketMaker, moveFunds, setMarketMaker } from "../services/marketmakers.js";
import { clearingReport } from "../services/clearing.js";
import * as treasury from "../services/treasury.js";
import * as chain from "../services/chain.js";
import { toxicityReport, setSurchargeOverride, setShock } from "../services/toxicity.js";
import { integrityReport, setExternalRef, addReferencePrice, refreshExternalPrices } from "../services/integrity.js";

const SourceBody = z.object({
  kind: z.enum(["rss", "gdelt", "google_trends", "newsapi", "tiktok_cc", "json_feed"]),
  name: z.string().min(2),
  url: z.string().url(),
  category: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  lang: z.string().optional(),
  weight: z.number().optional(),
  config: z.record(z.string(), z.any()).optional(),
  enabled: z.boolean().optional(),
});

const Signal = z.object({
  platform: z.string().min(2),
  url: z.string().url().optional(),
  text: z.string().min(5).max(2000),
  metrics: z.record(z.string(), z.any()).optional(),
  category: z.string().optional(),
  capturedBy: z.string().optional(),
});

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  // ---------- Resumen para el panel ----------
  app.get("/admin/overview", async () => {
    const house = await houseAccount();
    const o = await one(pool, `
      SELECT
        COALESCE((SELECT SUM(yes_price * qty * 100) FROM trades WHERE created_at > now() - interval '24 hours'),0)::bigint AS volume_24h,
        COALESCE((SELECT SUM(volume) FROM markets),0)::bigint AS volume_total,
        COALESCE((SELECT SUM(amount) FROM fees WHERE created_at > now() - interval '24 hours'),0)::bigint AS fees_24h,
        COALESCE((SELECT SUM(amount) FROM fees),0)::bigint AS fees_total,
        (SELECT COUNT(*) FROM trades WHERE created_at > now() - interval '24 hours')::int AS trades_24h,
        (SELECT COUNT(*) FROM events WHERE status='open')::int AS open_events,
        (SELECT COUNT(*) FROM events WHERE status IN ('closed','resolving'))::int AS awaiting_resolution,
        (SELECT COUNT(*) FROM players WHERE NOT is_house)::int AS players_total,
        (SELECT COUNT(*) FROM players WHERE NOT is_house AND last_seen_at > now() - interval '5 minutes')::int AS players_online,
        (SELECT COUNT(*) FROM drafts WHERE status='pending')::int AS pending_drafts,
        (SELECT COUNT(*) FROM resolutions WHERE status IN ('proposed','disputed'))::int AS open_resolutions,
        (SELECT COUNT(*) FROM events WHERE status='closed')::int AS closed_unproposed,
        (SELECT COUNT(*) FROM ledger WHERE direction='credit' AND status='failed')::int AS failed_credits,
        (SELECT COUNT(*) FROM webhook_outbox WHERE delivered_at IS NULL)::int AS pending_webhooks,
        (SELECT COUNT(*) FROM trends WHERE status='active')::int AS active_trends,
        (SELECT COUNT(*) FROM sources WHERE enabled)::int AS sources_enabled,
        (SELECT COUNT(*) FROM sources WHERE enabled AND last_status LIKE 'error%')::int AS sources_failing,
        COALESCE((SELECT SUM(cost) FROM positions WHERE player_id=$1),0)::bigint AS house_open_cost,
        COALESCE((SELECT SUM(realized) FROM positions WHERE player_id=$1),0)::bigint AS house_realized`, [house]);
    const hourly = await many(pool, `
      SELECT h AS t, COALESCE(SUM(t.yes_price * t.qty * 100),0)::bigint AS volume, COUNT(t.id)::int AS trades
      FROM generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') h
      LEFT JOIN trades t ON date_trunc('hour', t.created_at) = h GROUP BY h ORDER BY h`);
    return { ...o, hourly, aiEnabled: (await import("../ai/claude.js")).aiEnabled(), autoApprove: (await import("../config.js")).config.catalog.autoApproveAi };
  });

  /** Eventos en cualquier estado, para administrar. */
  app.get("/admin/events", async (req) => {
    const q = req.query as any;
    return listEvents({
      status: q.status ?? "open,closed,resolving,resolved,void", category: q.category || undefined, q: q.q || undefined,
      sort: q.sort ?? "new", limit: Math.min(Number(q.limit ?? 50), 200), offset: Number(q.offset ?? 0),
    });
  });

  // ---------- Fuentes ----------
  app.get("/admin/sources", async () => many(pool, "SELECT * FROM sources ORDER BY id"));
  app.post("/admin/sources", async (req) => {
    const b = parse(SourceBody, req.body);
    return one(pool, "INSERT INTO sources (kind, name, url, category, country, lang, weight, config, enabled) VALUES ($1,$2,$3,$4,$5,COALESCE($6,'es'),COALESCE($7,1),$8,COALESCE($9,true)) RETURNING *",
      [b.kind, b.name, b.url, b.category ?? null, b.country ?? null, b.lang, b.weight, JSON.stringify(b.config ?? {}), b.enabled]);
  });
  app.patch<{ Params: { id: string } }>("/admin/sources/:id", async (req) => {
    const b = parse(SourceBody.partial(), req.body);
    const cur = await one(pool, "SELECT * FROM sources WHERE id=$1", [Number(req.params.id)]);
    if (!cur) throw notFound();
    const n = { ...cur, ...b };
    return one(pool, "UPDATE sources SET kind=$2, name=$3, url=$4, category=$5, country=$6, lang=$7, weight=$8, config=$9, enabled=$10 WHERE id=$1 RETURNING *",
      [cur.id, n.kind, n.name, n.url, n.category, n.country, n.lang, n.weight, JSON.stringify(n.config), n.enabled]);
  });
  app.delete<{ Params: { id: string } }>("/admin/sources/:id", async (req) => one(pool, "UPDATE sources SET enabled=false WHERE id=$1 RETURNING id, enabled", [Number(req.params.id)]));

  // ---------- Ingesta y tendencias ----------
  app.post("/admin/ingest/run", async (req) => runIngest({ sourceIds: (req.body as any)?.sourceIds }));
  app.post("/admin/trends/detect", async () => ({ trends: (await detectTrends()).length }));
  app.get("/admin/trends", async (req) =>
    many(pool, "SELECT * FROM trends WHERE status = ANY($1) ORDER BY score DESC LIMIT 100", [((req.query as any).status ?? "active,used").split(",")]));
  app.get<{ Params: { id: string } }>("/admin/trends/:id", async (req) => {
    const t = await one(pool, "SELECT * FROM trends WHERE id=$1", [Number(req.params.id)]);
    if (!t) throw notFound();
    t.articles = await many(pool, "SELECT a.id, a.title, a.url, a.published_at, s.name AS source FROM articles a JOIN sources s ON s.id=a.source_id WHERE trend_id=$1 ORDER BY published_at DESC", [t.id]);
    t.signals = await many(pool, "SELECT * FROM social_signals WHERE trend_id=$1", [t.id]);
    return t;
  });
  app.patch<{ Params: { id: string } }>("/admin/trends/:id", async (req) =>
    one(pool, "UPDATE trends SET status=$2 WHERE id=$1 RETURNING id, status", [Number(req.params.id), parse(z.object({ status: z.enum(["active", "ignored", "used"]) }), req.body).status]));
  app.get("/admin/articles", async (req) =>
    many(pool, "SELECT a.*, s.name AS source FROM articles a JOIN sources s ON s.id=a.source_id ORDER BY a.published_at DESC LIMIT $1", [Math.min(Number((req.query as any).limit ?? 100), 500)]));

  /** Señales de redes sociales: las envía el agente que navega Instagram/TikTok o un moderador. Acepta una o un arreglo. */
  app.post("/admin/social-signals", async (req) => {
    const list = Array.isArray(req.body) ? req.body : [req.body];
    const out = [];
    for (const raw of list) out.push(await addSocialSignal(parse(Signal, raw)));
    return { inserted: out.length, signals: out };
  });

  // ---------- Preguntas (borradores) ----------
  app.post("/admin/drafts/generate", async (req) => {
    const b = parse(z.object({
      trendId: z.number().int().optional(), category: z.string().optional(),
      count: z.number().int().min(1).max(30).optional(), limit: z.number().int().min(1).max(20).optional(),
    }), req.body ?? {});
    if (b.category) return generateForCategory(b.category, b.count ?? 10);
    return b.trendId ? generateForTrend(b.trendId) : generateForTopTrends(b.limit ?? 5);
  });
  /** Mercados abiertos y borradores por categoría frente al mínimo configurado. */
  app.get("/admin/categories/coverage", async () => categoryCoverage());
  app.post("/admin/categories/refill", async () => refillCategories());
  app.get("/admin/drafts", async (req) => listDrafts((req.query as any).status ?? "pending"));
  app.post("/admin/drafts", async (req) => createManualDraft(req.body as object, adminUser(req)));
  app.post<{ Params: { id: string } }>("/admin/drafts/:id/approve", async (req) => approveDraft(Number(req.params.id), (req.body as any)?.edits ?? {}, adminUser(req)));
  app.post<{ Params: { id: string } }>("/admin/drafts/:id/reject", async (req) => rejectDraft(Number(req.params.id), (req.body as any)?.note ?? "", adminUser(req)));

  // ---------- Eventos y resolución ----------
  app.post("/admin/events", async (req) => createEvent(req.body));
  app.patch<{ Params: { id: string } }>("/admin/events/:id", async (req) => {
    const b = parse(z.object({ featured: z.boolean().optional(), imageUrl: z.string().url().nullable().optional(), description: z.string().optional() }), req.body);
    return one(pool, "UPDATE events SET featured=COALESCE($2,featured), image_url=CASE WHEN $3::boolean THEN $4 ELSE image_url END, description=COALESCE($5,description) WHERE id=$1 RETURNING *",
      [Number(req.params.id), b.featured ?? null, b.imageUrl !== undefined, b.imageUrl ?? null, b.description ?? null]);
  });
  app.post<{ Params: { id: string } }>("/admin/events/:id/close", async (req) => {
    const id = Number(req.params.id);
    await pool.query("UPDATE events SET status='closed', close_time=LEAST(close_time, now()) WHERE id=$1 AND status='open'", [id]);
    const ms = await many(pool, "UPDATE markets SET status='closed', close_time=LEAST(close_time, now()) WHERE event_id=$1 AND status='open' RETURNING id", [id]);
    for (const m of ms) await cancelAllInMarket(m.id);
    return { closed: ms.length };
  });
  app.post<{ Params: { id: string } }>("/admin/events/:id/resolve", async (req) => {
    const b = parse(z.object({
      outcome: z.enum(["YES", "NO", "VOID"]).optional(), winningMarketId: z.number().int().optional(), explanation: z.string().optional(),
      evidence: z.array(z.object({ url: z.string(), title: z.string().optional(), quote: z.string().optional() })).optional(),
    }), req.body);
    return propose(Number(req.params.id), { ...b, proposer: adminUser(req) });
  });
  app.post<{ Params: { id: string } }>("/admin/events/:id/ai-resolve", async (req) => aiResolve(Number(req.params.id), { autoPropose: (req.body as any)?.autoPropose !== false }));
  app.get("/admin/resolutions", async (req) =>
    many(pool, `SELECT r.*, e.title, e.kind,
        (SELECT json_agg(json_build_object('role', b.role, 'playerId', b.player_id, 'amount', b.amount, 'status', b.status, 'payout', b.payout) ORDER BY b.id)
           FROM resolution_bonds b WHERE b.resolution_id = r.id) AS bonds
      FROM resolutions r JOIN events e ON e.id=r.event_id WHERE r.status = ANY($1) ORDER BY r.id DESC LIMIT 200`, [((req.query as any).status ?? "proposed,disputed").split(",")]));
  app.post<{ Params: { id: string } }>("/admin/resolutions/:id/dispute", async (req) => dispute(Number(req.params.id), adminUser(req), (req.body as any)?.reason ?? ""));
  app.post<{ Params: { id: string } }>("/admin/resolutions/:id/reject", async (req) => reject(Number(req.params.id), adminUser(req)));
  // Decisión sobre una disputa: mismo resultado = gana quien propuso; otro = gana quien disputó
  app.post<{ Params: { id: string } }>("/admin/resolutions/:id/decide", async (req) => {
    const b = z.object({ outcome: z.enum(["YES", "NO", "VOID"]).optional(), winningMarketId: z.number().int().optional(), note: z.string().max(1000).optional() }).parse(req.body ?? {});
    return decide(Number(req.params.id), b, adminUser(req), b.note);
  });
  app.post<{ Params: { id: string } }>("/admin/resolutions/:id/finalize", async (req) => finalize(Number(req.params.id), { force: Boolean((req.body as any)?.force) }));
  app.post("/admin/jobs/close-expired", async () => ({ closed: await closeExpired() }));

  // ---------- Operadores (casinos) ----------
  app.get("/admin/operators", async () => many(pool, "SELECT id, name, api_key, wallet_url, webhook_url, currency, fee_bps, revenue_share_bps, theme, active, created_at FROM operators WHERE kind='casino' ORDER BY created_at"));
  app.post("/admin/operators", async (req) => {
    const b = parse(z.object({
      id: z.string().regex(/^[a-z0-9-]{3,40}$/), name: z.string().min(2), walletUrl: z.string().url(), webhookUrl: z.string().url().optional(),
      currency: z.string().length(3).optional(), feeBps: z.number().int().min(0).max(2000).optional(), theme: z.record(z.string(), z.any()).optional(),
      revenueShareBps: z.number().int().min(0).max(10000).optional(),
    }), req.body);
    if (b.id === "mm") throw new AppError(400, "reserved_id", "El identificador 'mm' está reservado");
    const creds = { apiKey: `pk_${randomToken(16)}`, apiSecret: `sk_${randomToken(24)}`, walletSecret: `ws_${randomToken(24)}` };
    await pool.query(
      "INSERT INTO operators (id, name, api_key, api_secret, wallet_url, wallet_secret, webhook_url, currency, fee_bps, theme, revenue_share_bps) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'USD'),$9,$10,$11)",
      [b.id, b.name, creds.apiKey, creds.apiSecret, b.walletUrl, creds.walletSecret, b.webhookUrl ?? null, b.currency, b.feeBps ?? null, JSON.stringify(b.theme ?? {}), b.revenueShareBps ?? 0]);
    return { id: b.id, ...creds, note: "Guarda los secretos ahora: no se vuelven a mostrar completos." };
  });

  app.patch<{ Params: { id: string } }>("/admin/operators/:id", async (req) => {
    const b = parse(z.object({ revenueShareBps: z.number().int().min(0).max(10000).optional(), feeBps: z.number().int().min(0).max(2000).nullable().optional(), active: z.boolean().optional() }), req.body);
    const r = await one(pool, `UPDATE operators SET revenue_share_bps = COALESCE($2, revenue_share_bps), active = COALESCE($3, active),
        fee_bps = CASE WHEN $5 THEN $4 ELSE fee_bps END WHERE id=$1 AND kind='casino' RETURNING id, revenue_share_bps, fee_bps, active`,
      [req.params.id, b.revenueShareBps ?? null, b.active ?? null, b.feeBps ?? null, "feeBps" in b]);
    if (!r) throw notFound("Casino no encontrado");
    return r;
  });

  // ---------- P2P: market makers externos y liquidación entre casinos ----------
  app.get("/admin/market-makers", async () => listMarketMakers());
  app.post("/admin/market-makers", async (req) => {
    const b = parse(z.object({ name: z.string().min(2).max(80), rebateBps: z.number().int().min(0).max(1000).nullable().optional() }), req.body);
    return createMarketMaker(b);
  });
  app.post<{ Params: { id: string } }>("/admin/market-makers/:id/funds", async (req) => {
    const b = parse(z.object({ direction: z.enum(["deposit", "withdraw"]), amountUsd: z.number().positive() }), req.body);
    return moveFunds(Number(req.params.id), b.amountUsd, b.direction, adminUser(req));
  });
  app.patch<{ Params: { id: string } }>("/admin/market-makers/:id", async (req) => {
    const b = parse(z.object({ active: z.boolean().optional(), rebateBps: z.number().int().min(0).max(1000).nullable().optional() }), req.body);
    return setMarketMaker(Number(req.params.id), b);
  });
  app.get("/admin/clearing", async (req) => clearingReport(req.query as any));

  // ---------- Tesorería ----------
  const Money = z.object({ direction: z.enum(["deposit", "withdraw"]), amountUsd: z.number().positive(), bankRef: z.string().max(120).optional() });
  app.get("/admin/treasury", async () => treasury.treasuryOverview());
  app.post("/admin/treasury/settle", async (req) => ({ created: await treasury.runSettlement({ operatorId: (req.body as any)?.operatorId }) }));
  app.post<{ Params: { id: string } }>("/admin/treasury/settlements/:id/pay", async (req) => {
    const b = parse(z.object({ bankRef: z.string().min(1).max(120), paidAt: z.string().optional() }), req.body);
    return treasury.markPaid(Number(req.params.id), { bankRef: b.bankRef, by: adminUser(req), paidAt: b.paidAt ? new Date(b.paidAt) : undefined });
  });
  app.post<{ Params: { id: string } }>("/admin/treasury/settlements/:id/collect", async (req) => treasury.collectFromGuarantee(Number(req.params.id), adminUser(req)));
  app.get<{ Params: { id: string } }>("/admin/treasury/settlements/:id/statement", async (req, reply) => {
    const s = await treasury.statementOf(Number(req.params.id));
    return reply.header("content-type", "application/json; charset=utf-8").header("x-oracle-key-id", s.key_id).header("x-oracle-signature", s.signature).send(s.statement);
  });
  app.post<{ Params: { id: string } }>("/admin/treasury/guarantees/:id", async (req) => {
    const b = parse(Money, req.body);
    return treasury.moveGuarantee(req.params.id, b.amountUsd, b.direction, adminUser(req), b.bankRef);
  });
  app.post("/admin/treasury/reserve", async (req) => {
    const b = parse(Money.extend({ rail: z.enum(["bank", "usdc"]).optional() }), req.body);
    return treasury.moveReserve(b.amountUsd, b.direction, adminUser(req), b.bankRef, b.rail);
  });
  app.patch<{ Params: { id: string } }>("/admin/treasury/casinos/:id", async (req) => {
    const b = parse(z.object({ guaranteeRequiredUsd: z.number().min(0).optional(), debtLimitUsd: z.number().min(0).nullable().optional(), paused: z.boolean().optional(), reason: z.string().max(200).optional(),
      rail: z.enum(["bank", "usdc"]).optional(), usdcAddress: z.string().max(42).nullable().optional() }), req.body);
    return treasury.setOperatorTreasury(req.params.id, b);
  });
  app.post("/admin/treasury/bank-statements", async (req) => {
    const b = parse(z.object({ csv: z.string().min(5).max(2_000_000), account: z.string().max(40).optional() }), req.body);
    return treasury.importBankStatement(b.csv, adminUser(req), b.account);
  });
  app.post<{ Params: { id: string } }>("/admin/treasury/bank-lines/:id/ignore", async (req) => {
    await pool.query("UPDATE bank_lines SET status='ignored' WHERE id=$1 AND status='unmatched'", [Number(req.params.id)]);
    return { ok: true };
  });
  app.get("/admin/treasury/journal", async (req) => ({
    verify: await treasury.verifyJournal(),
    entries: await many(pool, "SELECT * FROM journal ORDER BY id DESC LIMIT $1", [Math.min(Number((req.query as any).limit ?? 200), 2000)]),
  }));
  app.get("/admin/treasury/reserves", async () => treasury.reservesReport());
  app.post<{ Params: { id: string } }>("/admin/treasury/bank-lines/:id/guarantee", async (req) => {
    const b = parse(z.object({ operatorId: z.string() }), req.body);
    return treasury.guaranteeFromLine(Number(req.params.id), b.operatorId, adminUser(req));
  });
  // Modelo mixto: anclaje en Bitcoin y bóveda USDC
  app.post("/admin/treasury/anchor", async () => chain.anchorJournal({ force: true }));
  app.post("/admin/treasury/usdc/sync", async () => chain.syncUsdc(treasury.ingestChainTransfers));
  app.post("/admin/treasury/usdc/simulate", async (req) => {
    const b = parse(z.object({ direction: z.enum(["in", "out"]), address: z.string(), amountUsd: z.number().positive() }), req.body);
    return chain.simulateTransfer(b, treasury.ingestChainTransfers);
  });

  // ---------- Calibración, sesgo e integridad ----------
  app.get("/admin/integrity", async (req) => {
    const h = Number((req.query as any).horizon ?? 168);
    return integrityReport({ horizonHours: [24, 168, 720].includes(h) ? h : 168 });
  });
  app.patch<{ Params: { id: string } }>("/admin/markets/:id", async (req) =>
    setExternalRef(Number(req.params.id), parse(z.object({ externalRef: z.string().nullable() }), req.body).externalRef || null));
  app.post<{ Params: { id: string } }>("/admin/markets/:id/reference", async (req) =>
    addReferencePrice(Number(req.params.id), parse(z.object({ source: z.string().min(2), price: z.number().min(0).max(100), note: z.string().optional() }), req.body), adminUser(req)));
  app.post("/admin/references/refresh", async () => ({ updated: await refreshExternalPrices() }));

  // ---------- Riesgo y market maker ----------
  app.get("/admin/exposure", async () => {
    const house = await houseAccount();
    const markets = await many(pool, `
      SELECT m.id, m.question, m.status, m.last_price, m.fair_price, m.volume,
        COALESCE(SUM(ps.qty) FILTER (WHERE ps.outcome='YES' AND ps.player_id=$1),0)::bigint AS house_yes,
        COALESCE(SUM(ps.qty) FILTER (WHERE ps.outcome='NO' AND ps.player_id=$1),0)::bigint AS house_no,
        COALESCE(SUM(ps.cost) FILTER (WHERE ps.player_id=$1),0)::bigint AS house_cost,
        COALESCE(SUM(ps.qty) FILTER (WHERE ps.outcome='YES' AND ps.player_id<>$1),0)::bigint AS players_yes,
        COALESCE(SUM(ps.qty) FILTER (WHERE ps.outcome='NO' AND ps.player_id<>$1),0)::bigint AS players_no
      FROM markets m LEFT JOIN positions ps ON ps.market_id=m.id
      WHERE m.status IN ('open','closed','resolving') GROUP BY m.id ORDER BY house_cost DESC`, [house]);
    return { house: await houseStats(), markets };
  });
  app.post("/admin/mm/refresh", async (req) => ({ markets: await refreshQuotes((req.body as any)?.marketId) }));
  app.get("/admin/mm/status", async () => mmStatus());
  // Protección contra apostadores informados
  app.get("/admin/toxicity", async () => toxicityReport());
  app.post<{ Params: { id: string } }>("/admin/players/:id/surcharge", async (req) => {
    const { bps } = z.object({ bps: z.number().int().min(0).max(2000).nullable() }).parse(req.body ?? {});
    return setSurchargeOverride(Number(req.params.id), bps);
  });
  app.post<{ Params: { id: string } }>("/admin/markets/:id/shock", async (req) => {
    const { pause, reason } = z.object({ pause: z.boolean().default(false), reason: z.string().max(200).optional() }).parse(req.body ?? {});
    await setShock([Number(req.params.id)], reason ?? `Manual (${adminUser(req)})`, pause);
    return { ok: true };
  });
  // Botón de pánico: { on: true } retira todas las órdenes de la casa y deja de cotizar
  app.post("/admin/mm/kill", async (req) => {
    const on = z.object({ on: z.boolean() }).parse(req.body ?? {}).on;
    const r = await setKillSwitch(on, adminUser(req));
    if (!on) await refreshQuotes();
    return r;
  });
}
