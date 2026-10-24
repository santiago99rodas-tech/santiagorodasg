// API de administración: fuentes, ingesta, tendencias, moderación de preguntas, resolución, operadores.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, one, many } from "../db/pool.js";
import { parse, requireAdmin, adminUser } from "./auth.js";
import { notFound } from "../lib/errors.js";
import { randomToken } from "../lib/crypto.js";
import { runIngest, addSocialSignal, detectTrends } from "../ingest/pipeline.js";
import { generateForTrend, generateForTopTrends } from "../ai/questions.js";
import { aiResolve } from "../ai/resolver.js";
import { listDrafts, approveDraft, rejectDraft, createManualDraft } from "../services/drafts.js";
import { createEvent } from "../services/events.js";
import { propose, dispute, reject, finalize, closeExpired } from "../services/resolution.js";
import { cancelAllInMarket } from "../services/trading.js";
import { refreshQuotes, houseStats } from "../services/marketmaker.js";
import { houseAccount } from "../services/house.js";

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
    const b = parse(z.object({ trendId: z.number().int().optional(), limit: z.number().int().min(1).max(20).optional() }), req.body ?? {});
    return b.trendId ? generateForTrend(b.trendId) : generateForTopTrends(b.limit ?? 5);
  });
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
    many(pool, "SELECT r.*, e.title FROM resolutions r JOIN events e ON e.id=r.event_id WHERE r.status = ANY($1) ORDER BY r.id DESC LIMIT 200", [((req.query as any).status ?? "proposed,disputed").split(",")]));
  app.post<{ Params: { id: string } }>("/admin/resolutions/:id/dispute", async (req) => dispute(Number(req.params.id), adminUser(req), (req.body as any)?.reason ?? ""));
  app.post<{ Params: { id: string } }>("/admin/resolutions/:id/reject", async (req) => reject(Number(req.params.id)));
  app.post<{ Params: { id: string } }>("/admin/resolutions/:id/finalize", async (req) => finalize(Number(req.params.id), { force: Boolean((req.body as any)?.force) }));
  app.post("/admin/jobs/close-expired", async () => ({ closed: await closeExpired() }));

  // ---------- Operadores (casinos) ----------
  app.get("/admin/operators", async () => many(pool, "SELECT id, name, api_key, wallet_url, webhook_url, currency, fee_bps, theme, active, created_at FROM operators ORDER BY created_at"));
  app.post("/admin/operators", async (req) => {
    const b = parse(z.object({
      id: z.string().regex(/^[a-z0-9-]{3,40}$/), name: z.string().min(2), walletUrl: z.string().url(), webhookUrl: z.string().url().optional(),
      currency: z.string().length(3).optional(), feeBps: z.number().int().min(0).max(2000).optional(), theme: z.record(z.string(), z.any()).optional(),
    }), req.body);
    const creds = { apiKey: `pk_${randomToken(16)}`, apiSecret: `sk_${randomToken(24)}`, walletSecret: `ws_${randomToken(24)}` };
    await pool.query(
      "INSERT INTO operators (id, name, api_key, api_secret, wallet_url, wallet_secret, webhook_url, currency, fee_bps, theme) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'USD'),$9,$10)",
      [b.id, b.name, creds.apiKey, creds.apiSecret, b.walletUrl, creds.walletSecret, b.webhookUrl ?? null, b.currency, b.feeBps ?? null, JSON.stringify(b.theme ?? {})]);
    return { id: b.id, ...creds, note: "Guarda los secretos ahora: no se vuelven a mostrar completos." };
  });

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
}
