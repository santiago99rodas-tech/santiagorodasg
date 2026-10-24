// Resolución inspirada en el oráculo optimista (UMA) que usa Polymarket:
//   1. Alguien (la IA o un moderador) PROPONE el resultado con evidencia.
//   2. Corre una ventana de disputa (CHALLENGE_WINDOW_MINUTES). Se detiene el trading.
//   3. Si nadie disputa, se FINALIZA y se paga $1 por acción ganadora.
//      Si alguien disputa, decide un administrador (nueva propuesta o finalización forzada).
// "VOID" (anulado) paga 0,50 por acción a SÍ y a NO, como el 50-50 de Polymarket.

import { pool, tx, one, many } from "../db/pool.js";
import { config } from "../config.js";
import { bad, conflict, notFound } from "../lib/errors.js";
import { bus } from "../lib/bus.js";
import { cancelAllInMarket } from "./trading.js";
import * as wallet from "./wallet.js";

export interface ProposeInput {
  outcome?: "YES" | "NO" | "VOID"; // eventos binarios (o VOID para cualquiera)
  winningMarketId?: number; // eventos múltiples
  proposer: string;
  evidence?: { url: string; title?: string; quote?: string }[];
  explanation?: string;
}

/** Cierra eventos cuya fecha pasó y cancela sus órdenes abiertas. */
export async function closeExpired() {
  const evs = await many(pool, "UPDATE events SET status='closed' WHERE status='open' AND close_time <= now() RETURNING id");
  for (const e of evs) {
    const ms = await many(pool, "UPDATE markets SET status='closed' WHERE event_id=$1 AND status='open' RETURNING id", [e.id]);
    for (const m of ms) {
      await cancelAllInMarket(m.id);
      bus.publish({ type: "market", marketId: m.id, eventId: e.id, status: "closed" });
    }
  }
  return evs.length;
}

export async function propose(eventId: number, input: ProposeInput) {
  const e = await one(pool, "SELECT * FROM events WHERE id=$1", [eventId]);
  if (!e) throw notFound("Evento no encontrado");
  if (!["open", "closed", "resolving"].includes(e.status)) throw conflict("event_not_resolvable", `El evento está ${e.status}`);
  const pending = await one(pool, "SELECT id FROM resolutions WHERE event_id=$1 AND status='proposed'", [eventId]);
  if (pending) throw conflict("resolution_pending", `Ya hay una propuesta en curso (#${pending.id})`);

  let outcome = input.outcome;
  if (e.kind === "multi" && outcome !== "VOID") {
    const m = input.winningMarketId && (await one(pool, "SELECT id FROM markets WHERE id=$1 AND event_id=$2", [input.winningMarketId, eventId]));
    if (!m) throw bad("invalid_winner", "Indica winningMarketId con un mercado de este evento (o outcome VOID)");
    outcome = "YES";
  }
  if (!outcome) throw bad("invalid_outcome", "Indica outcome: YES, NO o VOID");

  // Detener el trading
  const ms = await many(pool, "UPDATE markets SET status='resolving' WHERE event_id=$1 AND status IN ('open','closed') RETURNING id", [eventId]);
  await pool.query("UPDATE events SET status='resolving' WHERE id=$1", [eventId]);
  for (const m of ms) {
    await cancelAllInMarket(m.id, "resolution");
    bus.publish({ type: "market", marketId: m.id, eventId, status: "resolving" });
  }

  return one(pool,
    `INSERT INTO resolutions (event_id, winning_market_id, outcome, proposer, evidence, explanation, status, challenge_ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,'proposed', now() + make_interval(mins => $7)) RETURNING *`,
    [eventId, e.kind === "multi" && outcome !== "VOID" ? input.winningMarketId : null, outcome, input.proposer,
     JSON.stringify(input.evidence ?? []), input.explanation ?? "", config.challengeWindowMinutes]);
}

export async function dispute(resolutionId: number, by: string, reason: string) {
  const r = await one(pool, "UPDATE resolutions SET status='disputed', disputed_by=$2, dispute_reason=$3 WHERE id=$1 AND status='proposed' RETURNING *", [resolutionId, by, reason]);
  if (!r) throw conflict("not_disputable", "La propuesta no existe o ya no está en ventana de disputa");
  return r;
}

/** Rechaza una propuesta disputada: el evento queda listo para una nueva propuesta. */
export async function reject(resolutionId: number) {
  const r = await one(pool, "UPDATE resolutions SET status='rejected' WHERE id=$1 AND status IN ('proposed','disputed') RETURNING *", [resolutionId]);
  if (!r) throw conflict("not_rejectable", "La propuesta no se puede rechazar");
  return r;
}

export async function finalize(resolutionId: number, opts: { force?: boolean } = {}) {
  const r = await one(pool, "SELECT * FROM resolutions WHERE id=$1", [resolutionId]);
  if (!r) throw notFound("Propuesta no encontrada");
  if (r.status === "finalized") return r;
  if (r.status === "disputed" && !opts.force) throw conflict("disputed", "La propuesta está disputada: un administrador debe forzar la decisión");
  if (r.status === "rejected") throw conflict("rejected", "La propuesta fue rechazada");
  if (!opts.force && new Date(r.challenge_ends_at) > new Date()) throw conflict("challenge_window", "La ventana de disputa sigue abierta");

  const e = await one(pool, "SELECT * FROM events WHERE id=$1", [r.event_id]);
  const markets = await many(pool, "SELECT * FROM markets WHERE event_id=$1", [r.event_id]);
  const payouts: { playerId: number; marketId: number; amount: number }[] = [];

  await tx(async (c) => {
    for (const m of markets) {
      const outcome: "YES" | "NO" | "VOID" = r.outcome === "VOID" ? "VOID" : e.kind === "multi" ? (m.id === r.winning_market_id ? "YES" : "NO") : r.outcome;
      await c.query("UPDATE markets SET status=$2, resolved_outcome=$3, resolved_at=now(), last_price=$4 WHERE id=$1",
        [m.id, outcome === "VOID" ? "void" : "resolved", outcome, outcome === "YES" ? 99 : outcome === "NO" ? 1 : 50]);
      const positions = await many(c, "SELECT * FROM positions WHERE market_id=$1 AND qty > 0 FOR UPDATE", [m.id]);
      for (const p of positions) {
        // qty en centésimas de acción; cada acción paga 1.000.000 micro-dólares
        const perShare = outcome === "VOID" ? 500_000 : p.outcome === outcome ? 1_000_000 : 0;
        const amount = (p.qty * perShare) / 100;
        await c.query("UPDATE positions SET qty=0, reserved=0, cost=0, realized = realized + $4 - cost WHERE player_id=$1 AND market_id=$2 AND outcome=$3",
          [p.player_id, m.id, p.outcome, amount]);
        if (amount > 0) payouts.push({ playerId: p.player_id, marketId: m.id, amount });
      }
    }
    await c.query("UPDATE events SET status=$2 WHERE id=$1", [e.id, r.outcome === "VOID" ? "void" : "resolved"]);
    await c.query("UPDATE resolutions SET status='finalized', finalized_at=now() WHERE id=$1", [r.id]);
    // Aviso a cada casino con los premios de sus jugadores
    await c.query(
      `INSERT INTO webhook_outbox (operator_id, type, payload)
       SELECT id, 'event.resolved', $1::jsonb FROM operators WHERE active`,
      [JSON.stringify({ eventId: e.id, title: e.title, outcome: r.outcome, winningMarketId: r.winning_market_id })]);
  });

  for (const p of payouts) {
    await wallet.credit(p.playerId, p.amount, { reason: r.outcome === "VOID" ? "void_refund" : "payout", marketId: p.marketId, txId: `pay_${r.id}_${p.marketId}_${p.playerId}` });
  }
  for (const m of markets) bus.publish({ type: "market", marketId: m.id, eventId: e.id, status: r.outcome === "VOID" ? "void" : "resolved" });
  return { ...r, status: "finalized", payouts: payouts.length };
}

/** Finaliza las propuestas cuya ventana de disputa terminó sin disputas. */
export async function finalizeDue() {
  const due = await many(pool, "SELECT id FROM resolutions WHERE status='proposed' AND challenge_ends_at <= now()");
  for (const d of due) await finalize(d.id).catch((e) => console.error("finalize", d.id, e.message));
  return due.length;
}
