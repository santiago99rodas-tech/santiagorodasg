// API pública de mercados (sin autenticación) y API del jugador (token de sesión).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, many, one } from "../db/pool.js";
import { parse, requirePlayer } from "./auth.js";
import { listEvents, eventDetail, marketBook, priceHistory, recentTrades, platformStats, maskName, displayPrice } from "../services/marketdata.js";
import { placeOrder, cancelOrder } from "../services/trading.js";
import * as wallet from "../services/wallet.js";
import { bus, type BusEvent } from "../lib/bus.js";

const OrderBody = z.object({
  marketId: z.number().int(),
  side: z.enum(["BUY", "SELL"]),
  outcome: z.enum(["YES", "NO"]),
  type: z.enum(["LIMIT", "MARKET"]),
  price: z.number().int().min(1).max(99).optional(),
  shares: z.number().positive().optional(),
  amount: z.number().positive().optional(),
  tif: z.enum(["GTC", "FOK", "FAK"]).optional(),
  clientRef: z.string().max(64).optional(),
});

export async function v1Routes(app: FastifyInstance) {
  // ---------- Datos de mercado ----------
  app.get("/v1/categories", async () =>
    many(pool, `SELECT c.slug, c.name, (SELECT COUNT(*) FROM events e WHERE e.category=c.slug AND e.status='open')::int AS open_events FROM categories c ORDER BY c.sort`));

  app.get("/v1/events", async (req) => {
    const q = parse(z.object({
      category: z.string().optional(), status: z.string().optional(), sort: z.string().optional(), q: z.string().optional(),
      featured: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
      spark: z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1").optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional(),
    }), req.query);
    return listEvents(q);
  });

  app.get<{ Params: { id: string } }>("/v1/events/:id", async (req) => eventDetail(req.params.id));

  app.get<{ Params: { id: string } }>("/v1/markets/:id", async (req) => {
    const m = await one(pool, "SELECT event_id FROM markets WHERE id=$1", [Number(req.params.id)]);
    if (!m) return { error: "not_found" };
    const e = await eventDetail(String(m.event_id));
    return { ...e.markets.find((x: any) => x.id === Number(req.params.id)), event: { ...e, markets: undefined } };
  });

  app.get<{ Params: { id: string } }>("/v1/markets/:id/book", async (req) => marketBook(Number(req.params.id)));

  app.get<{ Params: { id: string }; Querystring: { interval?: string } }>("/v1/markets/:id/prices-history", async (req) =>
    priceHistory(Number(req.params.id), req.query.interval));

  app.get<{ Params: { id: string } }>("/v1/markets/:id/trades", async (req) => recentTrades({ marketId: Number(req.params.id), limit: 50 }));

  app.get("/v1/activity", async (req) => recentTrades({ limit: Math.min(Number((req.query as any).limit ?? 30), 100) }));

  app.get("/v1/stats", async () => platformStats());

  app.get("/v1/trends", async () =>
    many(pool, "SELECT id, label, keywords, category, score, article_count, source_count, social_count, last_seen FROM trends WHERE status IN ('active','used') ORDER BY score DESC LIMIT 30"));

  // ---------- Tiempo real (Server-Sent Events) ----------
  app.get("/v1/stream", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    reply.raw.write(": conectado\n\n");
    const names = new Map<string, string>();
    const onEvent = async (e: BusEvent) => {
      let data: any = e;
      if (e.type === "trade") {
        if (!names.has(e.player)) {
          const p = await one(pool, "SELECT display_name, is_house FROM players WHERE id=$1", [Number(e.player)]);
          names.set(e.player, p?.is_house ? "" : maskName(p?.display_name ?? null, Number(e.player)));
        }
        if (!names.get(e.player)) return; // no se publican cruces de la casa
        data = { ...e, player: names.get(e.player) };
      }
      reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    bus.on("event", onEvent);
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => { bus.off("event", onEvent); clearInterval(ping); });
  });

  // ---------- Jugador ----------
  app.register(async (p) => {
    p.addHook("preHandler", requirePlayer);

    p.get("/v1/me", async (req) => {
      const op = await one(pool, "SELECT name, currency, theme FROM operators WHERE id=$1", [req.player!.operatorId]);
      return {
        player: { id: req.player!.id, externalId: req.player!.externalId, displayName: req.player!.displayName },
        operator: { name: op?.name, currency: op?.currency, theme: op?.theme ?? {} },
        balance: await wallet.balance(req.player!.id), // micro-dólares según el casino
      };
    });

    p.get("/v1/positions", async (req) => {
      const rows = await many(pool, `
        SELECT ps.*, m.question, m.outcome_label, m.status AS market_status, m.last_price, m.resolved_outcome, m.event_id, e.title, e.kind, e.category
        FROM positions ps JOIN markets m ON m.id=ps.market_id JOIN events e ON e.id=m.event_id
        WHERE ps.player_id=$1 AND (ps.qty > 0 OR ps.realized <> 0) ORDER BY m.status='open' DESC, e.close_time`, [req.player!.id]);
      return rows.map((r) => {
        const yes = displayPrice({ id: r.market_id, last_price: r.last_price, status: r.market_status });
        const price = r.outcome === "YES" ? yes : 100 - yes;
        const value = price * r.qty * 100;
        return {
          marketId: r.market_id, eventId: r.event_id, eventTitle: r.title, outcomeLabel: r.kind === "multi" ? r.outcome_label : null,
          category: r.category, outcome: r.outcome, shares: r.qty / 100, availableShares: (r.qty - r.reserved) / 100,
          avgPrice: r.qty ? Math.round((r.cost / r.qty) / 100 * 100) / 100 : null, currentPrice: price,
          cost: r.cost, value, unrealizedPnl: value - r.cost, realizedPnl: r.realized, marketStatus: r.market_status, resolvedOutcome: r.resolved_outcome,
        };
      });
    });

    p.get("/v1/orders", async (req) => {
      const status = (req.query as any).status ?? "open";
      return many(pool, `
        SELECT o.id, o.market_id, o.side, o.outcome, o.order_type, o.tif, o.price, o.qty/100.0 AS shares, o.filled_qty/100.0 AS filled_shares,
               o.status, o.created_at, m.question, m.outcome_label, e.title AS event_title, e.kind
        FROM orders o JOIN markets m ON m.id=o.market_id JOIN events e ON e.id=m.event_id
        WHERE o.player_id=$1 AND ($2 = 'all' OR o.status=$2) ORDER BY o.id DESC LIMIT 100`, [req.player!.id, status]);
    });

    p.post("/v1/orders", async (req, reply) => {
      const body = parse(OrderBody, req.body);
      const r = await placeOrder(req.player!.id, body);
      reply.code(201);
      return r;
    });

    p.delete<{ Params: { id: string } }>("/v1/orders/:id", async (req) => cancelOrder(req.player!.id, Number(req.params.id)));

    p.get("/v1/me/activity", async (req) =>
      many(pool, `SELECT tx_id, direction, amount, reason, market_id, order_id, status, created_at FROM ledger WHERE player_id=$1 ORDER BY id DESC LIMIT 100`, [req.player!.id]));
  });
}
