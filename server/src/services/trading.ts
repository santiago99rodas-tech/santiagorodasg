// Servicio de trading: valida, cobra en la billetera del casino, empareja en el libro y persiste.
// Un solo escritor por mercado (withLock) garantiza que la simulación (dryRun) y el cruce real coincidan.

import type pg from "pg";
import { pool, tx, one, many } from "../db/pool.js";
import { config } from "../config.js";
import { OrderBook, kindOf, toYesPrice, ownPrice, notional, isBuy, isBid, type Fill, type Kind } from "../engine/orderbook.js";
import { withLock } from "../lib/mutex.js";
import { bad, conflict, notFound, AppError } from "../lib/errors.js";
import { feeOf, fromDecimal, floorCent } from "../lib/money.js";
import { bus } from "../lib/bus.js";
import * as wallet from "./wallet.js";
import { houseAccount } from "./house.js";
import { playerSurchargeBps } from "./toxicity.js";

const books = new Map<number, OrderBook>();
export const MARKET_SLIPPAGE_CENTS = 10;

export function bookOf(marketId: number) {
  let b = books.get(marketId);
  if (!b) books.set(marketId, (b = new OrderBook()));
  return b;
}

/** Reconstruye los libros en memoria desde las órdenes abiertas (al arrancar el servidor). */
export async function loadBooks() {
  books.clear();
  const rows = await many(pool, "SELECT * FROM orders WHERE status='open' ORDER BY id");
  for (const o of rows) {
    bookOf(o.market_id).add({ id: o.id, ownerId: o.player_id, kind: kindOf(o.side, o.outcome), yesPrice: toYesPrice(o.outcome, o.price), remaining: o.qty - o.filled_qty, seq: o.id });
  }
  return rows.length;
}

export interface PlaceOrderInput {
  marketId: number;
  side: "BUY" | "SELL";
  outcome: "YES" | "NO";
  type: "LIMIT" | "MARKET";
  price?: number; // centavos del resultado elegido. LIMIT: precio límite. MARKET: peor precio aceptable (opcional)
  shares?: number; // acciones (admite 2 decimales). Requerido en LIMIT y en ventas de mercado
  amount?: number; // USD a gastar en compras de mercado
  tif?: "GTC" | "FOK" | "FAK";
  clientRef?: string;
  postOnly?: boolean; // solo agrega liquidez: se rechaza si cruzaría con el libro (market makers)
}

export interface OrderResult {
  orderId: number;
  status: string;
  filledShares: number;
  avgPrice: number | null; // centavos del resultado elegido
  spent: number; // micro-dólares pagados (compras) o recibidos netos (ventas)
  fee: number;
  restingShares: number;
  fills: { price: number; shares: number }[];
}

async function feeBpsFor(playerId: number) {
  const r = await one(pool, "SELECT p.is_house, o.fee_bps, o.kind FROM players p LEFT JOIN operators o ON o.id=p.operator_id WHERE p.id=$1", [playerId]);
  if (!r) throw notFound("Jugador no encontrado");
  return { feeBps: r.is_house ? 0 : r.fee_bps ?? config.takerFeeBps, internal: r.kind === "internal" };
}

export function placeOrder(playerId: number, input: PlaceOrderInput): Promise<OrderResult> {
  return withLock(`m:${input.marketId}`, () => placeLocked(playerId, input));
}

async function placeLocked(playerId: number, input: PlaceOrderInput): Promise<OrderResult> {
  const market = await one(pool, "SELECT m.*, e.status AS event_status FROM markets m JOIN events e ON e.id=m.event_id WHERE m.id=$1", [input.marketId]);
  if (!market) throw notFound("Mercado no encontrado");
  if (market.status !== "open" || new Date(market.close_time) <= new Date()) throw conflict("market_closed", "El mercado está cerrado");
  if (input.clientRef) {
    const dup = await one(pool, "SELECT id FROM orders WHERE player_id=$1 AND client_ref=$2", [playerId, input.clientRef]);
    if (dup) throw conflict("duplicate_order", `Ya existe la orden ${dup.id} con ese clientRef`);
  }

  const book = bookOf(market.id);
  const kind: Kind = kindOf(input.side, input.outcome);
  const buy = isBuy(kind);
  const { feeBps, internal } = await feeBpsFor(playerId);
  // Recargo por apostar con información (services/toxicity.ts): solo en lo que se le compra a la casa
  const house = await houseAccount();
  const surcharge = feeBps > 0 ? await playerSurchargeBps(playerId) : 0;

  // Precio límite en el resultado elegido
  let limitOwn: number;
  let tif = input.tif ?? (input.type === "LIMIT" ? "GTC" : "FAK");
  if (input.type === "LIMIT") {
    if (!Number.isInteger(input.price) || input.price! < 1 || input.price! > 99) throw bad("invalid_price", "El precio debe ser un entero entre 1 y 99 centavos");
    limitOwn = input.price!;
  } else {
    if (tif === "GTC") tif = "FAK";
    const bestYes = (buy ? input.outcome === "YES" : input.outcome === "NO") ? book.bestAsk() : book.bestBid();
    if (bestYes === undefined) throw conflict("no_liquidity", "No hay liquidez en este momento");
    const bestOwn = toYesPrice(input.outcome, bestYes); // toYesPrice es su propia inversa
    const slip = buy ? Math.min(99, bestOwn + MARKET_SLIPPAGE_CENTS) : Math.max(1, bestOwn - MARKET_SLIPPAGE_CENTS);
    limitOwn = input.price ? (buy ? Math.min(input.price, slip) : Math.max(input.price, slip)) : slip;
  }
  const yesLimit = toYesPrice(input.outcome, limitOwn);

  // Cantidad
  let qty: number;
  let budget: number | undefined;
  if (input.type === "MARKET" && buy) {
    if (!(input.amount && input.amount > 0)) throw bad("invalid_amount", "Indica el monto (amount) en USD");
    qty = Number.MAX_SAFE_INTEGER;
    budget = Math.floor((fromDecimal(input.amount) * 10_000) / (10_000 + feeBps + surcharge));
  } else {
    if (!(input.shares && input.shares > 0)) throw bad("invalid_shares", "Indica la cantidad de acciones (shares)");
    qty = Math.round(input.shares * 100);
    if (qty < 1) throw bad("invalid_shares", "La cantidad mínima es 0,01 acciones");
  }

  if (!buy) {
    const pos = await one(pool, "SELECT qty, reserved FROM positions WHERE player_id=$1 AND market_id=$2 AND outcome=$3", [playerId, market.id, input.outcome]);
    if (!pos || pos.qty - pos.reserved < qty) throw conflict("insufficient_shares", "No tienes suficientes acciones disponibles para vender");
  }

  // Simulación exacta (tenemos el candado del mercado)
  const dry = book.match({ id: -1, ownerId: playerId, kind, yesLimit, qty, budget }, { dryRun: true });
  if (tif === "FOK" && dry.filled < qty) throw conflict("fok_not_filled", "La orden no se puede llenar completa al precio indicado");
  if (tif !== "GTC" && dry.filled === 0) throw conflict("no_liquidity", "No hay liquidez al precio indicado");
  if (input.postOnly) {
    // Post-only: no puede tocar el mejor precio del otro lado, ni siquiera si esa orden es propia
    const opp = isBid(kind) ? book.bestAsk() : book.bestBid();
    if (dry.filled > 0 || (opp !== undefined && (isBid(kind) ? yesLimit >= opp : yesLimit <= opp))) throw conflict("would_cross", "La orden post-only cruzaría con el libro");
  }

  const restQty = tif === "GTC" ? qty - dry.filled : 0;
  const fillFees = dry.fills.map((f) => feeOf(notional(ownPrice(kind, f.yesPrice), f.qty), feeBps + (f.makerOwnerId === house ? surcharge : 0)));
  const totalFee = fillFees.reduce((a, b) => a + b, 0);
  const restReserve = buy ? notional(limitOwn, restQty) : restQty;

  // Límite de exposición por jugador y mercado (mitiga manipulación y ballenas). La casa no tiene límite.
  if (buy && feeBps > 0 && !internal && config.integrity.maxStakePerMarketUsd > 0) {
    const cur = await one(pool,
      `SELECT COALESCE((SELECT SUM(cost) FROM positions WHERE player_id=$1 AND market_id=$2),0)::bigint
            + COALESCE((SELECT SUM(reserved) FROM orders WHERE player_id=$1 AND market_id=$2 AND status='open' AND side='BUY'),0)::bigint AS exposure`,
      [playerId, market.id]);
    const limit = config.integrity.maxStakePerMarketUsd * 1e6;
    if (cur!.exposure + dry.spent + restReserve > limit) {
      throw conflict("stake_limit", `Superas el máximo de $${config.integrity.maxStakePerMarketUsd} comprometidos en este mercado (ya tienes $${(cur!.exposure / 1e6).toFixed(2)})`);
    }
  }

  const orderId: number = (await one(pool, "SELECT nextval('orders_id_seq')::bigint AS id"))!.id;

  // Cobro en el casino antes de tocar el libro
  let debited = 0;
  if (buy) {
    debited = await wallet.debit(playerId, dry.spent + totalFee + restReserve, { reason: "order", marketId: market.id, orderId, txId: `o_${orderId}_debit` });
  }

  const makerCredits = new Map<number, { playerId: number; amount: number }>();
  let takerProceeds = 0;
  try {
    await tx(async (c) => {
      const status = restQty > 0 ? "open" : dry.filled === qty || budget !== undefined ? "filled" : "cancelled";
      const storedQty = budget !== undefined ? dry.filled : qty;
      await c.query(
        `INSERT INTO orders (id, market_id, player_id, side, outcome, order_type, tif, price, qty, filled_qty, reserved, status, client_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [orderId, market.id, playerId, input.side, input.outcome, input.type, tif, limitOwn, storedQty, dry.filled, restReserve, status, input.clientRef ?? null],
      );
      // Redondeo a centavo del débito: lo retiene la casa
      if (debited > dry.spent + totalFee + restReserve) {
        await c.query("INSERT INTO fees (player_id, operator_id, amount) SELECT id, operator_id, $2 FROM players WHERE id=$1", [playerId, debited - (dry.spent + totalFee + restReserve)]);
      }
      if (!buy && restQty > 0) {
        await c.query("UPDATE positions SET reserved = reserved + $4 WHERE player_id=$1 AND market_id=$2 AND outcome=$3", [playerId, market.id, input.outcome, restQty]);
      }
      for (const [i, f] of dry.fills.entries()) {
        takerProceeds += await applyFill(c, market, orderId, playerId, kind, f, fillFees[i], makerCredits);
      }
    });
  } catch (e) {
    if (debited > 0) await wallet.credit(playerId, debited, { reason: "order_error_refund", marketId: market.id, orderId, txId: `o_${orderId}_errrefund` });
    throw e;
  }

  // Aplicar al libro en memoria
  book.match({ id: orderId, ownerId: playerId, kind, yesLimit, qty, budget });
  if (restQty > 0) book.add({ id: orderId, ownerId: playerId, kind, yesPrice: yesLimit, remaining: restQty, seq: orderId });

  // Pagos a vendedores (después del commit)
  if (!buy && takerProceeds > 0) await wallet.credit(playerId, takerProceeds, { reason: "sell_proceeds", marketId: market.id, orderId, txId: `o_${orderId}_proceeds` });
  for (const [makerOrderId, mc] of makerCredits) {
    await wallet.credit(mc.playerId, mc.amount, { reason: "sell_proceeds", marketId: market.id, orderId: makerOrderId, txId: `f_${makerOrderId}_${orderId}` });
  }
  await payRebates(market.id, orderId, kind, dry.fills, fillFees);

  publishAfterTrade(market, orderId, playerId, input, dry.fills, kind);

  const filledShares = dry.filled / 100;
  const ownSpent = dry.fills.reduce((a, f) => a + notional(ownPrice(kind, f.yesPrice), f.qty), 0);
  return {
    orderId,
    status: restQty > 0 ? (dry.filled > 0 ? "partially_filled" : "open") : dry.filled > 0 ? "filled" : "cancelled",
    filledShares,
    avgPrice: dry.filled ? Math.round((ownSpent / (dry.filled * 100)) * 100) / 100 : null,
    spent: buy ? ownSpent + totalFee : takerProceeds,
    fee: totalFee,
    restingShares: restQty / 100,
    fills: dry.fills.map((f) => ({ price: ownPrice(kind, f.yesPrice), shares: f.qty / 100 })),
  };
}

/**
 * Reembolso a los market makers externos por la liquidez que les tomaron: MAKER_REBATE_BPS (o el de
 * su cuenta) sobre lo que pagó el taker, sin pasar de la comisión que pagó. Se acredita a su saldo interno.
 */
async function payRebates(marketId: number, takerOrderId: number, takerKind: Kind, fills: Fill[], fillFees: number[]) {
  const makers = [...new Set(fills.map((f) => f.makerOwnerId))];
  const mms = new Map((await many(pool, "SELECT player_id, rebate_bps FROM mm_accounts WHERE player_id = ANY($1) AND active", [makers]))
    .map((r) => [Number(r.player_id), r.rebate_bps ?? config.p2p.makerRebateBps]));
  if (!mms.size) return;
  for (const [i, f] of fills.entries()) {
    const bps = mms.get(f.makerOwnerId);
    if (bps === undefined || fillFees[i] <= 0) continue;
    // Al centavo hacia abajo, como cualquier crédito
    const amount = floorCent(Math.min(fillFees[i], Math.floor((notional(ownPrice(takerKind, f.yesPrice), f.qty) * bps) / 10_000)));
    if (amount <= 0) continue;
    const ins = await pool.query(
      `INSERT INTO rebates (market_id, maker_order_id, taker_order_id, player_id, amount) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (maker_order_id, taker_order_id) DO UPDATE SET amount = rebates.amount + EXCLUDED.amount RETURNING id`,
      [marketId, f.makerId, takerOrderId, f.makerOwnerId, amount]);
    await wallet.credit(f.makerOwnerId, amount, { reason: "maker_rebate", marketId, orderId: f.makerId, txId: `rb_${ins.rows[0].id}_${i}` });
  }
}

/** Persiste un cruce. Devuelve lo que recibe el taker si vende (neto de comisión). */
async function applyFill(c: pg.PoolClient, market: any, takerOrderId: number, takerId: number, takerKind: Kind, f: Fill, fee: number, makerCredits: Map<number, { playerId: number; amount: number }>) {
  const takerOutcome = takerKind.endsWith("YES") ? "YES" : "NO";
  const makerOutcome = f.makerKind.endsWith("YES") ? "YES" : "NO";
  const takerNotional = notional(ownPrice(takerKind, f.yesPrice), f.qty);
  const makerNotional = notional(ownPrice(f.makerKind, f.yesPrice), f.qty);

  const trade = await one(c,
    "INSERT INTO trades (market_id, maker_order_id, taker_order_id, yes_price, qty, kind, taker_fee) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [market.id, f.makerId, takerOrderId, f.yesPrice, f.qty, f.kind, fee]);
  if (fee > 0) await c.query("INSERT INTO fees (trade_id, player_id, operator_id, amount) SELECT $1, id, operator_id, $3 FROM players WHERE id=$2", [trade.id, takerId, fee]);

  // Maker
  const makerBuy = isBuy(f.makerKind);
  await c.query(
    `UPDATE orders SET filled_qty = filled_qty + $2, reserved = GREATEST(0, reserved - $3),
       status = CASE WHEN filled_qty + $2 >= qty THEN 'filled' ELSE status END, updated_at = now() WHERE id=$1`,
    [f.makerId, f.qty, makerBuy ? makerNotional : f.qty]);
  if (makerBuy) {
    await addShares(c, f.makerOwnerId, market.id, makerOutcome, f.qty, makerNotional);
  } else {
    await removeShares(c, f.makerOwnerId, market.id, makerOutcome, f.qty, makerNotional, true);
    const prev = makerCredits.get(f.makerId);
    makerCredits.set(f.makerId, { playerId: f.makerOwnerId, amount: (prev?.amount ?? 0) + makerNotional });
  }
  // Taker
  let proceeds = 0;
  if (isBuy(takerKind)) {
    await addShares(c, takerId, market.id, takerOutcome, f.qty, takerNotional);
  } else {
    await removeShares(c, takerId, market.id, takerOutcome, f.qty, takerNotional - fee, false);
    proceeds = takerNotional - fee;
  }
  await c.query("UPDATE markets SET last_price=$2, volume = volume + $3 WHERE id=$1", [market.id, f.yesPrice, takerNotional]);
  await c.query("INSERT INTO price_history (market_id, ts, price) VALUES ($1, now(), $2) ON CONFLICT (market_id, ts) DO UPDATE SET price=EXCLUDED.price", [market.id, f.yesPrice]);
  return proceeds;
}

async function addShares(c: pg.PoolClient, playerId: number, marketId: number, outcome: string, qty: number, cost: number) {
  await c.query(
    `INSERT INTO positions (player_id, market_id, outcome, qty, cost) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (player_id, market_id, outcome) DO UPDATE SET qty = positions.qty + $4, cost = positions.cost + $5`,
    [playerId, marketId, outcome, qty, cost]);
}

async function removeShares(c: pg.PoolClient, playerId: number, marketId: number, outcome: string, qty: number, proceeds: number, fromReserved: boolean) {
  const pos = await one(c, "SELECT qty, cost FROM positions WHERE player_id=$1 AND market_id=$2 AND outcome=$3 FOR UPDATE", [playerId, marketId, outcome]);
  if (!pos || pos.qty < qty) throw new AppError(500, "position_mismatch", "Posición inconsistente");
  const costPortion = Math.round((pos.cost * qty) / pos.qty);
  await c.query(
    `UPDATE positions SET qty = qty - $4, cost = cost - $5, realized = realized + $6, reserved = reserved - $7
     WHERE player_id=$1 AND market_id=$2 AND outcome=$3`,
    [playerId, marketId, outcome, qty, costPortion, proceeds - costPortion, fromReserved ? qty : 0]);
}

function publishAfterTrade(market: any, orderId: number, playerId: number, input: PlaceOrderInput, fills: Fill[], kind: Kind) {
  const at = new Date().toISOString();
  for (const f of fills) {
    bus.publish({ type: "trade", marketId: market.id, eventId: market.event_id, yesPrice: f.yesPrice, qty: f.qty, outcome: input.outcome, side: input.side, amount: notional(ownPrice(kind, f.yesPrice), f.qty), player: String(playerId), at });
  }
  if (fills.length) bus.publish({ type: "price", marketId: market.id, eventId: market.event_id, price: fills[fills.length - 1].yesPrice, at });
  bus.publish({ type: "book", marketId: market.id });
}

export function cancelOrder(playerId: number | null, orderId: number, reason = "cancel") {
  return (async () => {
    const o = await one(pool, "SELECT * FROM orders WHERE id=$1", [orderId]);
    if (!o || (playerId !== null && o.player_id !== playerId)) throw notFound("Orden no encontrada");
    return withLock(`m:${o.market_id}`, () => cancelLocked(orderId, reason));
  })();
}

async function cancelLocked(orderId: number, reason: string) {
  const o = await one(pool, "SELECT * FROM orders WHERE id=$1", [orderId]);
  if (!o || o.status !== "open") throw conflict("order_not_open", "La orden ya no está abierta");
  bookOf(o.market_id).remove(o.id);
  await tx(async (c) => {
    await c.query("UPDATE orders SET status='cancelled', reserved=0, updated_at=now() WHERE id=$1", [o.id]);
    if (o.side === "SELL") await c.query("UPDATE positions SET reserved = GREATEST(0, reserved - $4) WHERE player_id=$1 AND market_id=$2 AND outcome=$3", [o.player_id, o.market_id, o.outcome, o.reserved]);
  });
  if (o.side === "BUY" && o.reserved > 0) {
    const dust = await wallet.credit(o.player_id, o.reserved, { reason: `order_${reason}_refund`, marketId: o.market_id, orderId: o.id, txId: `o_${o.id}_cancel` });
    if (dust > 0) await pool.query("INSERT INTO fees (player_id, operator_id, amount) SELECT id, operator_id, $2 FROM players WHERE id=$1", [o.player_id, dust]);
  }
  bus.publish({ type: "book", marketId: o.market_id });
  return { orderId: o.id, status: "cancelled" };
}

/** Cancela todas las órdenes abiertas de un mercado (cierre o resolución). */
export async function cancelAllInMarket(marketId: number, reason = "market_closed") {
  const ids = (await many(pool, "SELECT id FROM orders WHERE market_id=$1 AND status='open'", [marketId])).map((r) => r.id);
  for (const id of ids) await withLock(`m:${marketId}`, () => cancelLocked(id, reason)).catch(() => undefined);
  return ids.length;
}

export async function cancelAllOf(playerId: number, marketId: number) {
  const ids = (await many(pool, "SELECT id FROM orders WHERE market_id=$1 AND player_id=$2 AND status='open'", [marketId, playerId])).map((r) => r.id);
  for (const id of ids) await withLock(`m:${marketId}`, () => cancelLocked(id, "requote")).catch(() => undefined);
}
