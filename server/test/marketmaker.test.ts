import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, player, futureIso } from "./helpers.js";
import { createEvent } from "../src/services/events.js";
import { placeOrder, bookOf } from "../src/services/trading.js";
import { refreshQuotes, updateFairPrices, setKillSwitch, mmStatus } from "../src/services/marketmaker.js";
import { houseAccount } from "../src/services/house.js";
import { config } from "../src/config.js";

let marketId: number;
const fairOf = async (id: number) => Number((await pool.query("SELECT COALESCE(fair_exact, fair_price/100.0) f FROM markets WHERE id=$1", [id])).rows[0].f);

before(async () => {
  await resetDb();
  config.mm.strategy = "v2";
  config.integrity.maxStakePerMarketUsd = 0;
  const ev = await createEvent({
    title: "¿Lloverá en Quito el día de la prueba?", category: "clima", kind: "binary", closeTime: futureIso(20),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Según el INAMHI.", resolutionSource: "INAMHI",
  });
  marketId = ev.markets[0].id;
  config.mm.enabled = true;
});
after(async () => { config.mm.enabled = false; await pool.end(); });

test("v2 cotiza a ambos lados alrededor del precio justo", async () => {
  await refreshQuotes(marketId);
  const b = bookOf(marketId);
  assert.ok(b.bestBid()! < 50 && b.bestAsk()! > 50, `${b.bestBid()} / ${b.bestAsk()}`);
});

test("el precio justo aprende del flujo de los jugadores (no de la casa)", async () => {
  const before = await fairOf(marketId);
  const ana = await player("ana", 500);
  await placeOrder(ana, { marketId, side: "BUY", outcome: "YES", type: "MARKET", amount: 100 });
  await updateFairPrices();
  const after1 = await fairOf(marketId);
  assert.ok(after1 > before, `${after1} > ${before}`);
  // Sin flujo nuevo no se mueve
  await updateFairPrices();
  assert.equal(await fairOf(marketId), after1);
  // Una referencia externa nueva se aplica una sola vez
  await pool.query("INSERT INTO reference_prices (market_id, source, price) VALUES ($1, 'polymarket', 80)", [marketId]);
  await updateFairPrices();
  const withRef = await fairOf(marketId);
  assert.ok(withRef > after1);
  await updateFairPrices();
  assert.equal(await fairOf(marketId), withRef);
  // El salto de más de 12¢ en minutos activó el freno de emergencia: la casa se retira un rato
  const m = (await pool.query("SELECT paused_until > now() AS paused, shock_until > now() AS shock, shock_reason FROM markets WHERE id=$1", [marketId])).rows[0];
  assert.ok(m.paused && m.shock, JSON.stringify(m));
  assert.match(m.shock_reason, /Salto de precio/);
  await refreshQuotes(marketId);
  assert.equal(bookOf(marketId).ordersOf(await houseAccount()).length, 0);
});

test("estado del market maker y botón de pánico", async () => {
  await pool.query("UPDATE markets SET paused_until=NULL, shock_until=NULL WHERE id=$1", [marketId]);
  await refreshQuotes(marketId);
  const st = await mmStatus();
  assert.equal(st.strategy, "v2");
  const e = st.events.find((x) => x.marketIds.includes(marketId))!;
  assert.ok(e && e.b > 0 && e.halfSpreadCents >= 1);
  await setKillSwitch(true, "test");
  const house = await houseAccount();
  assert.equal(bookOf(marketId).ordersOf(house).length, 0);
  assert.equal(await refreshQuotes(marketId), 0);
  await setKillSwitch(false, "test");
  await refreshQuotes(marketId);
  assert.ok(bookOf(marketId).ordersOf(house).length > 0);
});

test("muchos cruces seguidos no disparan la volatilidad ni abren el spread a 1¢/99¢", async () => {
  await pool.query("UPDATE markets SET paused_until=NULL, shock_until=NULL WHERE id=$1", [marketId]);
  const beto = await player("beto", 500);
  for (let i = 0; i < 6; i++) {
    await placeOrder(beto, { marketId, side: "BUY", outcome: i % 2 ? "YES" : "NO", type: "MARKET", amount: 10 });
    await refreshQuotes(marketId);
  }
  const b = bookOf(marketId);
  assert.ok(b.bestAsk()! - b.bestBid()! <= 12, `${b.bestBid()} / ${b.bestAsk()}`);
});
