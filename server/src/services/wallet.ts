// Billetera "seamless": el dinero del jugador vive en el casino. Este módulo le pide al casino
// debitar (al apostar) y acreditar (devoluciones, ventas y premios). Cada movimiento queda en el
// ledger con un tx_id único para que los reintentos sean idempotentes.
//
// Endpoints que implementa el casino (todos POST, JSON, firmados con HMAC):
//   {wallet_url}/balance   { playerId, currency }
//   {wallet_url}/debit     { txId, playerId, amount, currency, reason, marketId?, orderId? }
//   {wallet_url}/credit    { txId, playerId, amount, currency, reason, marketId?, orderId? }
//   {wallet_url}/rollback  { txId, originalTxId, playerId, amount, currency }
// Respuesta esperada: { ok: true, balance: "123.45", operatorTxId: "..." } o { ok: false, error: "insufficient_funds" }

import { pool, one, tx, type Db } from "../db/pool.js";
import { signRequest, randomToken } from "../lib/crypto.js";
import { ceilCent, floorCent, toDecimal, fromDecimal } from "../lib/money.js";
import { AppError } from "../lib/errors.js";

export interface WalletResponse { ok: boolean; balance?: string; operatorTxId?: string; error?: string }
export type WalletTransport = (url: string, headers: Record<string, string>, body: string) => Promise<WalletResponse>;

const httpTransport: WalletTransport = async (url, headers, body) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(8000) });
  const json = (await res.json().catch(() => ({}))) as WalletResponse;
  if (!res.ok && json.ok === undefined) return { ok: false, error: `http_${res.status}` };
  return json;
};

let transport: WalletTransport = httpTransport;
/** Para pruebas: reemplaza el transporte HTTP por uno en memoria. */
export function setWalletTransport(t: WalletTransport | null) { transport = t ?? httpTransport; }

interface PlayerRow { id: number; external_id: string; is_house: boolean; operator_id: string | null }
interface OperatorRow { id: string; wallet_url: string; wallet_secret: string; currency: string }

async function ctx(playerId: number) {
  const p = await one<PlayerRow>(pool, "SELECT id, external_id, is_house, operator_id FROM players WHERE id=$1", [playerId]);
  if (!p) throw new AppError(404, "player_not_found", "Jugador no encontrado");
  const op = p.operator_id ? await one<OperatorRow>(pool, "SELECT id, wallet_url, wallet_secret, currency FROM operators WHERE id=$1", [p.operator_id]) : undefined;
  return { p, op };
}

/**
 * Billetera interna (operador con wallet_url "internal:"): el saldo de los market makers externos lo
 * custodia la plataforma. Responde igual que un casino, con la misma idempotencia por txId.
 */
async function internalCall(op: OperatorRow, action: string, payload: any): Promise<WalletResponse> {
  const p = await one(pool, "SELECT id FROM players WHERE operator_id=$1 AND external_id=$2", [op.id, payload.playerId]);
  if (!p) return { ok: false, error: "unknown_player" };
  const bal = async (c: Db) => toDecimal(Number((await one(c, "SELECT balance FROM internal_balances WHERE player_id=$1", [p.id]))?.balance ?? 0));
  if (action === "balance") return { ok: true, balance: await bal(pool) };
  const amount = fromDecimal(payload.amount);
  return tx(async (c) => {
    const fresh = await c.query("INSERT INTO internal_txs (tx_id, player_id, action, amount) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [payload.txId, p.id, action, amount]);
    if (fresh.rowCount === 0) return { ok: true, balance: await bal(c), operatorTxId: payload.txId }; // ya aplicado
    await c.query("INSERT INTO internal_balances (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [p.id]);
    if (action === "debit") {
      const r = await c.query("UPDATE internal_balances SET balance = balance - $2 WHERE player_id=$1 AND balance >= $2", [p.id, amount]);
      if (r.rowCount === 0) { await c.query("DELETE FROM internal_txs WHERE tx_id=$1", [payload.txId]); return { ok: false, error: "insufficient_funds" }; }
    } else if (action === "credit") {
      await c.query("UPDATE internal_balances SET balance = balance + $2 WHERE player_id=$1", [p.id, amount]);
    } else if (action === "rollback") {
      // Devuelve un débito solo si de verdad se aplicó
      const orig = await one(c, "SELECT amount FROM internal_txs WHERE tx_id=$1 AND action='debit'", [payload.originalTxId]);
      if (orig) await c.query("UPDATE internal_balances SET balance = balance + $2 WHERE player_id=$1", [p.id, orig.amount]);
    }
    return { ok: true, balance: await bal(c), operatorTxId: payload.txId };
  });
}

async function call(op: OperatorRow, action: string, payload: object) {
  if (op.wallet_url === "internal:") return internalCall(op, action, payload);
  const path = `/${action}`;
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const headers = { "x-operator-id": op.id, "x-timestamp": ts, "x-signature": signRequest(op.wallet_secret, ts, "POST", path, body) };
  try {
    return await transport(op.wallet_url.replace(/\/$/, "") + path, headers, body);
  } catch (e) {
    return { ok: false, error: "network_error: " + (e as Error).message } as WalletResponse;
  }
}

export async function balance(playerId: number): Promise<number | null> {
  const { p, op } = await ctx(playerId);
  if (p.is_house || !op) return null;
  const r = await call(op, "balance", { playerId: p.external_id, currency: op.currency });
  return r.ok && r.balance !== undefined ? fromDecimal(r.balance) : null;
}

interface Refs { reason: string; marketId?: number; orderId?: number; txId?: string }

/**
 * Debita al jugador. El monto se redondea hacia arriba al centavo y se devuelve el monto real debitado.
 * Lanza AppError 402 si el casino lo rechaza. Ante error de red envía rollback (el estado es incierto).
 */
export async function debit(playerId: number, amount: number, refs: Refs): Promise<number> {
  const { p, op } = await ctx(playerId);
  const amt = ceilCent(amount);
  if (p.is_house || !op || amt === 0) return amt;
  const txId = refs.txId ?? `d_${randomToken(12)}`;
  await pool.query(
    "INSERT INTO ledger (tx_id, player_id, operator_id, direction, amount, reason, market_id, order_id, status) VALUES ($1,$2,$3,'debit',$4,$5,$6,$7,'pending')",
    [txId, p.id, op.id, amt, refs.reason, refs.marketId ?? null, refs.orderId ?? null],
  );
  const r = await call(op, "debit", { txId, playerId: p.external_id, amount: toDecimal(amt), currency: op.currency, reason: refs.reason, marketId: refs.marketId, orderId: refs.orderId });
  if (r.ok) {
    await pool.query("UPDATE ledger SET status='ok', operator_tx=$2 WHERE tx_id=$1", [txId, r.operatorTxId ?? null]);
    return amt;
  }
  await pool.query("UPDATE ledger SET status='failed', error=$2 WHERE tx_id=$1", [txId, r.error ?? "rechazado"]);
  if (r.error?.startsWith("network_error")) {
    await call(op, "rollback", { txId: `r_${txId}`, originalTxId: txId, playerId: p.external_id, amount: toDecimal(amt), currency: op.currency });
  }
  if (r.error === "insufficient_funds") throw new AppError(402, "insufficient_funds", "Saldo insuficiente en el casino");
  throw new AppError(502, "wallet_error", `El casino rechazó el débito: ${r.error ?? "sin detalle"}`);
}

/**
 * Acredita al jugador (redondeo hacia abajo al centavo). Nunca lanza: si el casino falla, el
 * movimiento queda 'failed' y la tarea de reintentos lo reenvía con el mismo tx_id.
 * Devuelve el sobrante sub-centavo que no se pudo acreditar.
 */
export async function credit(playerId: number, amount: number, refs: Refs, db: Db = pool): Promise<number> {
  const { p, op } = await ctx(playerId);
  const amt = floorCent(amount);
  const dust = amount - amt;
  if (p.is_house || !op || amt <= 0) return dust;
  const txId = refs.txId ?? `c_${randomToken(12)}`;
  const inserted = await db.query(
    "INSERT INTO ledger (tx_id, player_id, operator_id, direction, amount, reason, market_id, order_id, status) VALUES ($1,$2,$3,'credit',$4,$5,$6,$7,'pending') ON CONFLICT (tx_id) DO NOTHING",
    [txId, p.id, op.id, amt, refs.reason, refs.marketId ?? null, refs.orderId ?? null],
  );
  if (inserted.rowCount === 0) return dust; // ya se procesó antes
  await sendCredit(txId);
  return dust;
}

async function sendCredit(txId: string) {
  const row = await one(pool, "SELECT l.*, p.external_id FROM ledger l JOIN players p ON p.id=l.player_id WHERE tx_id=$1", [txId]);
  const op = await one<OperatorRow>(pool, "SELECT id, wallet_url, wallet_secret, currency FROM operators WHERE id=$1", [row.operator_id]);
  if (!op) return;
  const r = await call(op, "credit", { txId, playerId: row.external_id, amount: toDecimal(row.amount), currency: op.currency, reason: row.reason, marketId: row.market_id ?? undefined, orderId: row.order_id ?? undefined });
  await pool.query("UPDATE ledger SET status=$2, operator_tx=$3, error=$4 WHERE tx_id=$1", [txId, r.ok ? "ok" : "failed", r.operatorTxId ?? null, r.ok ? null : r.error ?? "rechazado"]);
}

/** Reintenta créditos fallidos o pendientes viejos (premios y devoluciones deben llegar sí o sí). */
export async function retryCredits() {
  const rows = (await pool.query("SELECT tx_id FROM ledger WHERE direction='credit' AND (status='failed' OR (status='pending' AND created_at < now() - interval '2 minutes')) ORDER BY id LIMIT 200")).rows;
  for (const r of rows) await sendCredit(r.tx_id);
  return rows.length;
}
