// Market makers externos: empresas o traders que dan liquidez en el mismo libro que los jugadores de
// todos los casinos. Operan por API (/mm/v1, firmada con HMAC), con un saldo que custodia la plataforma
// (billetera interna, operador "mm") y cobran un reembolso por cada orden suya que toma un jugador.
// La casa sigue cotizando, pero queda de respaldo: si ellos ya dan buen precio, ella abre su spread.

import { pool, many, one } from "../db/pool.js";
import { config } from "../config.js";
import { bad, conflict, notFound } from "../lib/errors.js";
import { randomToken } from "../lib/crypto.js";
import { placeOrder, cancelOrder, cancelAllOf, type PlaceOrderInput } from "./trading.js";
import * as wallet from "./wallet.js";
import { recordMmCustody } from "./treasury.js";

export async function createMarketMaker(input: { name: string; rebateBps?: number | null }) {
  const slug = input.name.toLowerCase().normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "mm";
  const externalId = `${slug}-${randomToken(4)}`;
  const p = await one(pool, "INSERT INTO players (operator_id, external_id, display_name) VALUES ('mm',$1,$2) RETURNING id", [externalId, input.name]);
  const creds = { apiKey: `mk_${randomToken(16)}`, apiSecret: `ms_${randomToken(24)}` };
  await pool.query("INSERT INTO mm_accounts (player_id, name, api_key, api_secret, rebate_bps) VALUES ($1,$2,$3,$4,$5)",
    [p!.id, input.name, creds.apiKey, creds.apiSecret, input.rebateBps ?? null]);
  await pool.query("INSERT INTO internal_balances (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [p!.id]);
  return { playerId: p!.id, name: input.name, ...creds, note: "Guarda el secreto ahora: no se vuelve a mostrar." };
}

/** Depósito o retiro del saldo custodiado (la transferencia real se hace por fuera: banco, USDC…). */
export async function moveFunds(playerId: number, usd: number, direction: "deposit" | "withdraw", by: string) {
  const mm = await one(pool, "SELECT player_id FROM mm_accounts WHERE player_id=$1", [playerId]);
  if (!mm) throw notFound("Market maker no encontrado");
  if (!(usd > 0)) throw bad("invalid_amount", "Indica un monto positivo");
  const amount = Math.round(usd * 1e6);
  const txId = `mm_${direction}_${playerId}_${Date.now()}`;
  if (direction === "deposit") await wallet.credit(playerId, amount, { reason: `mm_deposit:${by}`, txId });
  else await wallet.debit(playerId, amount, { reason: `mm_withdrawal:${by}`, txId });
  await recordMmCustody(playerId, amount, direction, by); // asiento en el libro de tesorería (cuenta de custodia)
  return { playerId, balance: await wallet.balance(playerId) };
}

export async function setMarketMaker(playerId: number, patch: { active?: boolean; rebateBps?: number | null }) {
  const r = await one(pool, `UPDATE mm_accounts SET active = COALESCE($2, active), rebate_bps = CASE WHEN $4 THEN $3 ELSE rebate_bps END
                             WHERE player_id=$1 RETURNING player_id, active, rebate_bps`, [playerId, patch.active ?? null, patch.rebateBps ?? null, "rebateBps" in patch]);
  if (!r) throw notFound("Market maker no encontrado");
  if (patch.active === false) {
    // Suspender retira sus órdenes del libro
    for (const m of await many(pool, "SELECT DISTINCT market_id FROM orders WHERE player_id=$1 AND status='open'", [playerId])) await cancelAllOf(playerId, m.market_id);
  }
  return r;
}

/** Resumen de una cuenta: saldo, dinero en órdenes, posiciones, volumen como maker y reembolsos. */
export async function accountSummary(playerId: number) {
  const a = await one(pool, `
    SELECT a.player_id, a.name, a.active, COALESCE(a.rebate_bps, $2) AS rebate_bps, b.balance,
      (SELECT COALESCE(SUM(reserved),0) FROM orders WHERE player_id=a.player_id AND status='open' AND side='BUY')::bigint AS reserved,
      (SELECT COUNT(*) FROM orders WHERE player_id=a.player_id AND status='open')::int AS open_orders,
      (SELECT COALESCE(SUM(cost),0) FROM positions WHERE player_id=a.player_id)::bigint AS positions_cost,
      (SELECT COALESCE(SUM(realized),0) FROM positions WHERE player_id=a.player_id)::bigint AS realized,
      (SELECT COALESCE(SUM(amount),0) FROM rebates WHERE player_id=a.player_id)::bigint AS rebates,
      (SELECT COALESCE(SUM(t.qty * (CASE WHEN o.outcome='YES' THEN t.yes_price ELSE 100 - t.yes_price END) * 100),0)
         FROM trades t JOIN orders o ON o.id = t.maker_order_id WHERE o.player_id = a.player_id)::bigint AS maker_volume,
      (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE player_id=a.player_id AND reason LIKE 'mm_deposit%' AND status='ok')::bigint AS deposits,
      (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE player_id=a.player_id AND reason LIKE 'mm_withdrawal%' AND status='ok')::bigint AS withdrawals
    FROM mm_accounts a LEFT JOIN internal_balances b ON b.player_id = a.player_id WHERE a.player_id=$1`, [playerId, config.p2p.makerRebateBps]);
  if (!a) throw notFound("Market maker no encontrado");
  return {
    playerId: a.player_id, name: a.name, active: a.active, rebateBps: a.rebate_bps,
    balance: Number(a.balance ?? 0), reservedInOrders: Number(a.reserved), openOrders: a.open_orders,
    positionsCost: Number(a.positions_cost), realizedPnl: Number(a.realized), rebates: Number(a.rebates), makerVolume: Number(a.maker_volume),
    deposits: Number(a.deposits), withdrawals: Number(a.withdrawals),
  };
}

export async function listMarketMakers() {
  const ids = await many(pool, "SELECT player_id FROM mm_accounts ORDER BY created_at");
  return Promise.all(ids.map((r) => accountSummary(r.player_id)));
}

export type BatchOp =
  | ({ action: "place" } & PlaceOrderInput)
  | { action: "cancel"; orderId: number }
  | { action: "cancelAll"; marketId: number };

/** Varias operaciones en una llamada (cotizar muchos niveles a la vez). No es atómico: cada una devuelve su resultado. */
export async function batch(playerId: number, ops: BatchOp[]) {
  if (ops.length > config.p2p.maxBatch) throw bad("batch_too_large", `Máximo ${config.p2p.maxBatch} operaciones por llamada`);
  const out: unknown[] = [];
  for (const op of ops) {
    try {
      if (op.action === "place") { const { action: _a, ...o } = op; out.push({ ok: true, ...(await placeOrder(playerId, { ...o, type: "LIMIT", tif: o.tif ?? "GTC" })) }); }
      else if (op.action === "cancel") out.push({ ok: true, ...(await cancelOrder(playerId, op.orderId)) });
      else if (op.action === "cancelAll") { await cancelAllOf(playerId, op.marketId); out.push({ ok: true, marketId: op.marketId }); }
      else throw bad("invalid_action", "Acción desconocida");
    } catch (e: any) {
      out.push({ ok: false, error: e.code ?? "error", message: e.message });
    }
  }
  return out;
}

export async function assertActive(playerId: number) {
  const a = await one(pool, "SELECT active FROM mm_accounts WHERE player_id=$1", [playerId]);
  if (!a?.active) throw conflict("mm_suspended", "La cuenta de market maker está suspendida");
}
