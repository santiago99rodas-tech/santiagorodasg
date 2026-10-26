// API para market makers externos (/mm/v1). Firmada con HMAC: X-MM-Key, X-Timestamp y X-Signature
// (HMAC-SHA256 de "timestamp\nMÉTODO\nruta\ncuerpo", igual que la API de casinos).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, many } from "../db/pool.js";
import { parse, requireMarketMaker } from "./auth.js";
import { placeOrder, cancelOrder, cancelAllOf } from "../services/trading.js";
import { accountSummary, batch } from "../services/marketmakers.js";
import { config } from "../config.js";

const Order = z.object({
  marketId: z.number().int(),
  side: z.enum(["BUY", "SELL"]),
  outcome: z.enum(["YES", "NO"]),
  price: z.number().int().min(1).max(99),
  shares: z.number().positive(),
  tif: z.enum(["GTC", "FOK", "FAK"]).optional(),
  postOnly: z.boolean().optional(),
  clientRef: z.string().max(64).optional(),
});

export async function mmRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook("preHandler", requireMarketMaker);

    r.get("/mm/v1/account", async (req) => ({ ...(await accountSummary(req.mm!.playerId)), takerFeeBps: config.takerFeeBps, maxBatch: config.p2p.maxBatch }));

    r.post("/mm/v1/orders", async (req, reply) => {
      const o = parse(Order, req.body);
      reply.code(201);
      return placeOrder(req.mm!.playerId, { ...o, type: "LIMIT", tif: o.tif ?? "GTC" });
    });

    r.post("/mm/v1/orders/batch", async (req) => {
      const { ops } = parse(z.object({ ops: z.array(z.union([
        Order.extend({ action: z.literal("place") }),
        z.object({ action: z.literal("cancel"), orderId: z.number().int() }),
        z.object({ action: z.literal("cancelAll"), marketId: z.number().int() }),
      ])).min(1) }), req.body);
      return { results: await batch(req.mm!.playerId, ops as any) };
    });

    r.delete<{ Params: { id: string } }>("/mm/v1/orders/:id", async (req) => cancelOrder(req.mm!.playerId, Number(req.params.id)));
    r.delete("/mm/v1/orders", async (req) => {
      const marketId = Number((req.query as any).marketId);
      const ms = marketId ? [{ market_id: marketId }] : await many(pool, "SELECT DISTINCT market_id FROM orders WHERE player_id=$1 AND status='open'", [req.mm!.playerId]);
      for (const m of ms) await cancelAllOf(req.mm!.playerId, m.market_id);
      return { cancelledMarkets: ms.length };
    });

    r.get("/mm/v1/orders", async (req) => many(pool, `
      SELECT id, market_id, side, outcome, price, qty/100.0 AS shares, filled_qty/100.0 AS filled_shares, status, client_ref, created_at
      FROM orders WHERE player_id=$1 AND ($2 = 'all' OR status = $2) ORDER BY id DESC LIMIT 500`, [req.mm!.playerId, (req.query as any).status ?? "open"]));

    r.get("/mm/v1/positions", async (req) => many(pool, `
      SELECT ps.market_id, ps.outcome, ps.qty/100.0 AS shares, ps.cost, ps.realized, m.status, m.last_price, m.fair_price, m.resolved_outcome
      FROM positions ps JOIN markets m ON m.id = ps.market_id WHERE ps.player_id=$1 AND (ps.qty > 0 OR ps.realized <> 0) ORDER BY ps.market_id`, [req.mm!.playerId]));

    r.get("/mm/v1/fills", async (req) => many(pool, `
      SELECT t.id, t.market_id, t.yes_price, t.qty/100.0 AS shares, t.kind, t.created_at,
        CASE WHEN om.player_id = $1 THEN 'maker' ELSE 'taker' END AS role,
        CASE WHEN om.player_id = $1 THEN om.side || '_' || om.outcome ELSE ot.side || '_' || ot.outcome END AS order_kind,
        CASE WHEN ot.player_id = $1 THEN t.taker_fee ELSE 0 END AS fee,
        COALESCE((SELECT amount FROM rebates rb WHERE rb.maker_order_id = om.id AND rb.taker_order_id = ot.id AND rb.player_id = $1), 0) AS rebate
      FROM trades t JOIN orders om ON om.id = t.maker_order_id JOIN orders ot ON ot.id = t.taker_order_id
      WHERE om.player_id = $1 OR ot.player_id = $1 ORDER BY t.id DESC LIMIT $2`, [req.mm!.playerId, Math.min(Number((req.query as any).limit ?? 200), 1000)]));
  });
}
