// Market maker de la casa. Polymarket depende de market makers externos (con incentivos de liquidez);
// en un casino casi nunca los hay, así que la casa cotiza siempre a ambos lados del libro para que
// cualquier jugador pueda comprar o vender al instante.
//
// Cotiza solo con órdenes de COMPRA (BUY_YES y BUY_NO): así no necesita inventario previo; cuando
// un jugador le compra, el cruce "mint" crea el par de acciones.

import { pool, many, one } from "../db/pool.js";
import { config } from "../config.js";
import { placeOrder, cancelAllOf } from "./trading.js";
import { houseAccount } from "./house.js";
import { MICRO } from "../lib/money.js";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Ajusta el precio justo hacia el último precio negociado y normaliza eventos múltiples a ~100%. */
export async function updateFairPrices() {
  await pool.query("UPDATE markets SET fair_price = GREATEST(2, LEAST(98, ROUND(0.6 * fair_price + 0.4 * last_price))) WHERE status='open'");
  const events = await many(pool, "SELECT e.id FROM events e WHERE e.kind='multi' AND e.status='open'");
  for (const e of events) {
    const ms = await many(pool, "SELECT id, fair_price FROM markets WHERE event_id=$1 AND status='open'", [e.id]);
    const sum = ms.reduce((a, m) => a + m.fair_price, 0);
    if (!sum) continue;
    for (const m of ms) await pool.query("UPDATE markets SET fair_price=$2 WHERE id=$1", [m.id, clamp(Math.round((m.fair_price * 100) / sum), 2, 98)]);
  }
}

export async function refreshQuotes(marketId?: number) {
  if (!config.mm.enabled) return 0;
  const house = await houseAccount();
  const markets = await many(pool,
    `SELECT id, fair_price FROM markets WHERE status='open' AND close_time > now() + interval '1 minute' ${marketId ? "AND id=$1" : ""}`,
    marketId ? [marketId] : []);
  const half = Math.ceil(config.mm.spreadCents / 2);
  const size = config.mm.levelSizeShares;
  for (const m of markets) {
    await cancelAllOf(house, m.id);
    const pos = await many(pool, "SELECT outcome, qty, cost FROM positions WHERE player_id=$1 AND market_id=$2", [house, m.id]);
    const yes = pos.find((p) => p.outcome === "YES"), no = pos.find((p) => p.outcome === "NO");
    const net = ((yes?.qty ?? 0) - (no?.qty ?? 0)) / 100; // acciones netas en Sí
    const exposure = ((yes?.cost ?? 0) + (no?.cost ?? 0)) / MICRO;
    const skew = clamp(Math.round(net / (size * 2)), -5, 5); // largo en Sí => baja precios
    const fair = clamp(m.fair_price - skew, 2, 98);
    const overLimit = exposure > config.mm.maxExposureUsd;
    for (let i = 0; i < config.mm.levels; i++) {
      const bidYes = fair - half - i;
      const askYes = fair + half + i;
      // Si superó la exposición, solo cotiza el lado que reduce inventario
      if (bidYes >= 1 && !(overLimit && net > 0)) {
        await placeOrder(house, { marketId: m.id, side: "BUY", outcome: "YES", type: "LIMIT", price: bidYes, shares: size }).catch(() => undefined);
      }
      if (askYes <= 99 && !(overLimit && net < 0)) {
        await placeOrder(house, { marketId: m.id, side: "BUY", outcome: "NO", type: "LIMIT", price: 100 - askYes, shares: size }).catch(() => undefined);
      }
    }
  }
  return markets.length;
}

export async function houseStats() {
  const house = await houseAccount();
  return one(pool,
    `SELECT COALESCE(SUM(cost),0)::bigint AS open_cost, COALESCE(SUM(realized),0)::bigint AS realized,
            (SELECT COALESCE(SUM(amount),0)::bigint FROM fees) AS fees
     FROM positions WHERE player_id=$1`, [house]);
}
