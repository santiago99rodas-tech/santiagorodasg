// Resolución inspirada en el oráculo optimista (UMA) que usa Polymarket:
//   1. Alguien PROPONE el resultado con evidencia y deja una FIANZA: la casa (IA o moderador,
//      HOUSE_BOND_USD) o un jugador (RESOLUTION_BOND_USD, debitada de su casino, solo si el evento
//      ya cerró hace PLAYER_PROPOSE_AFTER_HOURS y nadie propuso).
//   2. Corre una ventana de disputa (CHALLENGE_WINDOW_MINUTES). Se detiene el trading. Un jugador
//      puede DISPUTAR dejando su propia fianza y evidencia.
//   3. Sin disputa: se FINALIZA, se paga $1 por acción ganadora y se devuelve la fianza.
//      Con disputa decide un administrador. Quien tenía razón recupera su fianza más BOND_REWARD_SHARE
//      de la del otro; quien no, la pierde. Si la casa propuso mal, paga ella.
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

export async function propose(eventId: number, input: ProposeInput, opts: { playerId?: number; windowMinutes?: number } = {}) {
  const e = await one(pool, "SELECT * FROM events WHERE id=$1", [eventId]);
  if (!e) throw notFound("Evento no encontrado");
  if (!["open", "closed", "resolving"].includes(e.status)) throw conflict("event_not_resolvable", `El evento está ${e.status}`);
  const pending = await one(pool, "SELECT id FROM resolutions WHERE event_id=$1 AND status IN ('proposed','disputed')", [eventId]);
  if (pending) throw conflict("resolution_pending", `Ya hay una propuesta en curso (#${pending.id})`);
  if (opts.playerId) {
    const after = new Date(e.close_time).getTime() + config.resolution.playerProposeAfterHours * 3600e3;
    if (e.status === "open" || Date.now() < after) {
      throw conflict("too_early", `Los jugadores pueden proponer ${config.resolution.playerProposeAfterHours} h después del cierre si nadie lo hizo antes`);
    }
  }

  let outcome = input.outcome;
  if (e.kind === "multi" && outcome !== "VOID") {
    const m = input.winningMarketId && (await one(pool, "SELECT id FROM markets WHERE id=$1 AND event_id=$2", [input.winningMarketId, eventId]));
    if (!m) throw bad("invalid_winner", "Indica winningMarketId con un mercado de este evento (o outcome VOID)");
    outcome = "YES";
  }
  if (!outcome) throw bad("invalid_outcome", "Indica outcome: YES, NO o VOID");

  // Fianza del jugador antes de tocar nada (si el casino la rechaza, no pasa nada más)
  const bond = opts.playerId ? config.resolution.playerBondUsd * 1e6 : config.resolution.houseBondUsd * 1e6;
  const bondTx = opts.playerId ? `bond_p_${eventId}_${opts.playerId}_${Date.now()}` : null;
  if (opts.playerId && bond > 0) await wallet.debit(opts.playerId, bond, { reason: "resolution_bond", txId: bondTx! });

  // Detener el trading
  const ms = await many(pool, "UPDATE markets SET status='resolving' WHERE event_id=$1 AND status IN ('open','closed') RETURNING id", [eventId]);
  await pool.query("UPDATE events SET status='resolving' WHERE id=$1", [eventId]);
  for (const m of ms) {
    await cancelAllInMarket(m.id, "resolution");
    bus.publish({ type: "market", marketId: m.id, eventId, status: "resolving" });
  }

  const r = await one(pool,
    `INSERT INTO resolutions (event_id, winning_market_id, outcome, proposer, proposer_player_id, evidence, explanation, status, challenge_ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed', now() + make_interval(mins => $8)) RETURNING *`,
    [eventId, e.kind === "multi" && outcome !== "VOID" ? input.winningMarketId : null, outcome, input.proposer, opts.playerId ?? null,
     JSON.stringify(input.evidence ?? []), input.explanation ?? "", opts.windowMinutes ?? config.challengeWindowMinutes]);
  if (bond > 0) await pool.query("INSERT INTO resolution_bonds (resolution_id, role, player_id, amount, status) VALUES ($1,'proposer',$2,$3,'held')", [r.id, opts.playerId ?? null, bond]);
  return r;
}

/**
 * Un jugador disputa una propuesta dentro de la ventana, con su fianza y evidencia. El evento queda
 * esperando la decisión de un administrador.
 */
export async function disputeByPlayer(playerId: number, resolutionId: number, input: { reason: string; evidence?: { url: string; title?: string }[] }) {
  const r = await one(pool, "SELECT * FROM resolutions WHERE id=$1", [resolutionId]);
  if (!r) throw notFound("Propuesta no encontrada");
  if (r.status !== "proposed" || new Date(r.challenge_ends_at) <= new Date()) throw conflict("not_disputable", "La propuesta ya no está en ventana de disputa");
  if (r.proposer_player_id === playerId) throw conflict("own_proposal", "No puedes disputar tu propia propuesta");
  if (!input.reason || input.reason.trim().length < 10) throw bad("invalid_reason", "Explica por qué el resultado propuesto es incorrecto (mínimo 10 caracteres)");
  const bond = config.resolution.playerBondUsd * 1e6;
  if (bond > 0) await wallet.debit(playerId, bond, { reason: "resolution_bond", txId: `bond_d_${resolutionId}_${playerId}` });
  const p = await one(pool, "SELECT display_name FROM players WHERE id=$1", [playerId]);
  const upd = await one(pool,
    `UPDATE resolutions SET status='disputed', disputed_by=$2, dispute_reason=$3, disputer_player_id=$4, dispute_evidence=$5, disputed_at=now()
     WHERE id=$1 AND status='proposed' RETURNING *`,
    [resolutionId, `jugador:${p?.display_name ?? playerId}`, input.reason.trim(), playerId, JSON.stringify(input.evidence ?? [])]);
  if (!upd) {
    // Otro la disputó en el mismo instante: se devuelve la fianza
    if (bond > 0) await wallet.credit(playerId, bond, { reason: "resolution_bond_refund", txId: `bond_d_${resolutionId}_${playerId}_refund` });
    throw conflict("not_disputable", "La propuesta ya fue disputada");
  }
  if (bond > 0) await pool.query("INSERT INTO resolution_bonds (resolution_id, role, player_id, amount, status) VALUES ($1,'disputer',$2,$3,'held')", [resolutionId, playerId, bond]);
  return upd;
}

/**
 * Liquida las fianzas de una propuesta. winner = quién tenía razón (null si no hubo disputa y la
 * propuesta se rechazó: el que propuso pierde la suya). El ganador recupera su fianza más
 * BOND_REWARD_SHARE de la del perdedor; el resto de la fianza perdida queda para la casa.
 */
async function settleBonds(resolutionId: number, winner: "proposer" | "disputer" | null) {
  const bonds = await many(pool, "SELECT * FROM resolution_bonds WHERE resolution_id=$1 AND status='held'", [resolutionId]);
  const loser = winner ? bonds.find((b) => b.role !== winner) : undefined;
  const reward = loser ? Math.floor(Number(loser.amount) * config.resolution.rewardShare) : 0;
  for (const b of bonds) {
    let status: string, payout: number;
    if (winner === null) { status = b.player_id ? "forfeited" : "returned"; payout = b.player_id ? 0 : Number(b.amount); }
    else if (b.role === winner) { status = reward > 0 ? "rewarded" : "returned"; payout = Number(b.amount) + reward; }
    else { status = "forfeited"; payout = 0; }
    await pool.query("UPDATE resolution_bonds SET status=$2, payout=$3, settled_at=now() WHERE id=$1", [b.id, status, payout]);
    if (b.player_id && payout > 0) {
      await wallet.credit(b.player_id, payout, { reason: status === "rewarded" ? "resolution_bond_reward" : "resolution_bond_refund", txId: `bond_${b.id}` });
    }
  }
}

/**
 * Decisión de un administrador sobre una propuesta disputada: si el resultado es el propuesto, se
 * finaliza tal cual; si no, se rechaza (gana quien disputó) y se finaliza con el resultado correcto.
 */
export async function decide(resolutionId: number, input: { outcome?: "YES" | "NO" | "VOID"; winningMarketId?: number }, by: string, note = "") {
  const r = await one(pool, "SELECT r.*, e.kind FROM resolutions r JOIN events e ON e.id=r.event_id WHERE r.id=$1", [resolutionId]);
  if (!r) throw notFound("Propuesta no encontrada");
  if (r.status !== "disputed") throw conflict("not_disputed", "Solo se decide sobre propuestas disputadas");
  const same = r.kind === "multi" && input.outcome !== "VOID"
    ? r.outcome !== "VOID" && Number(input.winningMarketId) === Number(r.winning_market_id)
    : input.outcome === r.outcome;
  await pool.query("UPDATE resolutions SET decided_by=$2 WHERE id=$1", [resolutionId, by]);
  if (same) return finalize(resolutionId, { force: true });
  await reject(resolutionId, by);
  const fresh = await propose(r.event_id, { ...input, proposer: `admin:${by}`, explanation: note || `Decisión sobre la disputa de la propuesta #${resolutionId}` }, { windowMinutes: 0 });
  return finalize(fresh.id, { force: true });
}

export async function dispute(resolutionId: number, by: string, reason: string) {
  const r = await one(pool, "UPDATE resolutions SET status='disputed', disputed_by=$2, dispute_reason=$3 WHERE id=$1 AND status='proposed' RETURNING *", [resolutionId, by, reason]);
  if (!r) throw conflict("not_disputable", "La propuesta no existe o ya no está en ventana de disputa");
  return r;
}

/**
 * Rechaza una propuesta: el evento queda listo para una nueva. Si estaba disputada, tenía razón quien
 * disputó; si no, quien propuso pierde su fianza.
 */
export async function reject(resolutionId: number, by?: string) {
  const r = await one(pool,
    `UPDATE resolutions SET status='rejected', decided_by=COALESCE($2, decided_by),
       dispute_result = CASE WHEN status='disputed' THEN 'dispute_upheld' ELSE dispute_result END
     WHERE id=$1 AND status IN ('proposed','disputed') RETURNING *`, [resolutionId, by ?? null]);
  if (!r) throw conflict("not_rejectable", "La propuesta no se puede rechazar");
  await settleBonds(r.id, r.dispute_result === "dispute_upheld" ? "disputer" : null);
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
    await c.query(`UPDATE resolutions SET status='finalized', finalized_at=now(),
                     dispute_result = CASE WHEN status='disputed' THEN 'proposal_upheld' ELSE dispute_result END WHERE id=$1`, [r.id]);
    // Aviso a cada casino con los premios de sus jugadores
    await c.query(
      `INSERT INTO webhook_outbox (operator_id, type, payload)
       SELECT id, 'event.resolved', $1::jsonb FROM operators WHERE active`,
      [JSON.stringify({ eventId: e.id, title: e.title, outcome: r.outcome, winningMarketId: r.winning_market_id })]);
  });

  for (const p of payouts) {
    await wallet.credit(p.playerId, p.amount, { reason: r.outcome === "VOID" ? "void_refund" : "payout", marketId: p.marketId, txId: `pay_${r.id}_${p.marketId}_${p.playerId}` });
  }
  await settleBonds(r.id, "proposer"); // con o sin disputa, quien propuso tenía razón
  for (const m of markets) bus.publish({ type: "market", marketId: m.id, eventId: e.id, status: r.outcome === "VOID" ? "void" : "resolved" });
  return { ...r, status: "finalized", payouts: payouts.length };
}

/** Finaliza las propuestas cuya ventana de disputa terminó sin disputas. */
export async function finalizeDue() {
  const due = await many(pool, "SELECT id FROM resolutions WHERE status='proposed' AND challenge_ends_at <= now()");
  for (const d of due) await finalize(d.id).catch((e) => console.error("finalize", d.id, e.message));
  return due.length;
}
