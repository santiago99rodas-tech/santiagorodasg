// API servidor-a-servidor para el casino (firmada con HMAC).
import { clearingReport } from "../services/clearing.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, one, many } from "../db/pool.js";
import { config } from "../config.js";
import { parse, requireOperator, issueSession } from "./auth.js";
import { notFound } from "../lib/errors.js";
import { listEvents } from "../services/marketdata.js";

export async function operatorRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOperator);

  /** Abre una sesión para un jugador del casino y devuelve la URL para embeber el módulo. */
  app.post("/operator/v1/sessions", async (req) => {
    const b = parse(z.object({
      playerId: z.string().min(1).max(100), displayName: z.string().max(80).optional(), lang: z.string().optional(),
      country: z.string().regex(/^[A-Za-z]{2}$/, "country: código ISO de 2 letras (EC, CO…)").optional(),
    }), req.body);
    const p = await one(pool,
      `INSERT INTO players (operator_id, external_id, display_name, country, last_seen_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (operator_id, external_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, players.display_name),
         country = COALESCE(EXCLUDED.country, players.country), last_seen_at = now()
       RETURNING id, operator_id, external_id, display_name`, [req.operator!.id, b.playerId, b.displayName ?? null, b.country?.toUpperCase() ?? null]);
    const s = issueSession(p);
    return { ...s, launchUrl: `${config.publicUrl}/embed/?token=${encodeURIComponent(s.token)}` };
  });

  app.get("/operator/v1/events", async (req) => listEvents(req.query as any));

  const player = async (operatorId: string, externalId: string) => {
    const p = await one(pool, "SELECT id FROM players WHERE operator_id=$1 AND external_id=$2", [operatorId, externalId]);
    if (!p) throw notFound("Jugador no encontrado");
    return p.id as number;
  };

  app.get<{ Params: { playerId: string } }>("/operator/v1/players/:playerId/positions", async (req) => {
    const id = await player(req.operator!.id, req.params.playerId);
    return many(pool, `
      SELECT ps.market_id, m.question, ps.outcome, ps.qty/100.0 AS shares, ps.cost, ps.realized, m.status AS market_status, m.resolved_outcome
      FROM positions ps JOIN markets m ON m.id=ps.market_id WHERE ps.player_id=$1 AND (ps.qty > 0 OR ps.realized <> 0)`, [id]);
  });

  app.get<{ Params: { playerId: string } }>("/operator/v1/players/:playerId/ledger", async (req) => {
    const id = await player(req.operator!.id, req.params.playerId);
    return many(pool, "SELECT tx_id, direction, amount, reason, market_id, order_id, status, operator_tx, created_at FROM ledger WHERE player_id=$1 ORDER BY id DESC LIMIT 500", [id]);
  });

  /** Resumen financiero del casino en un rango de fechas (montos en micro-dólares). */
  // Liquidación del casino con la plataforma (cámara de compensación del libro compartido)
  app.get("/operator/v1/clearing", async (req) => {
    const q = req.query as any;
    const r = await clearingReport({ from: q.from, to: q.to, operatorId: req.operator!.id });
    return { from: r.from, to: r.to, ...(r.casinos[0] ?? {}), liquidity: { volume: r.liquidity.volume, betweenCasinos: r.liquidity.betweenCasinos } };
  });

  app.get("/operator/v1/reports/summary", async (req) => {
    const q = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), req.query);
    const from = q.from ?? new Date(Date.now() - 30 * 864e5).toISOString();
    const to = q.to ?? new Date().toISOString();
    const r = await one(pool, `
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE direction='debit' AND status='ok'),0)::bigint AS debits,
        COALESCE(SUM(amount) FILTER (WHERE direction='credit' AND status='ok' AND reason='payout'),0)::bigint AS payouts,
        COALESCE(SUM(amount) FILTER (WHERE direction='credit' AND status='ok' AND reason='sell_proceeds'),0)::bigint AS sell_proceeds,
        COALESCE(SUM(amount) FILTER (WHERE direction='credit' AND status='ok' AND reason NOT IN ('payout','sell_proceeds')),0)::bigint AS refunds,
        COALESCE(SUM(amount) FILTER (WHERE direction='credit' AND status<>'ok'),0)::bigint AS pending_credits,
        COUNT(DISTINCT player_id)::int AS players
      FROM ledger WHERE operator_id=$1 AND created_at BETWEEN $2 AND $3`, [req.operator!.id, from, to]);
    const fees = await one(pool, "SELECT COALESCE(SUM(amount),0)::bigint AS fees FROM fees WHERE operator_id=$1 AND created_at BETWEEN $2 AND $3", [req.operator!.id, from, to]);
    const credits = r.payouts + r.sell_proceeds + r.refunds;
    return { from, to, currency: req.operator!.currency, ...r, fees: fees.fees, netPlayerSpend: r.debits - credits };
  });
}
