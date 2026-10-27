import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, player, bal, casino, futureIso } from "./helpers.js";
import { createEvent } from "../src/services/events.js";
import { placeOrder, cancelOrder, bookOf } from "../src/services/trading.js";
import { propose, finalize, dispute } from "../src/services/resolution.js";
import { refreshQuotes } from "../src/services/marketmaker.js";
import { config } from "../src/config.js";

let marketId: number, eventId: number;

before(async () => {
  await resetDb();
  const ev = await createEvent({
    title: "¿Subirá BTC esta semana de prueba?", category: "cripto", kind: "binary", closeTime: futureIso(),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Precio de cierre del domingo mayor al del lunes.", resolutionSource: "CoinMarketCap",
  });
  eventId = ev.id;
  marketId = ev.markets[0].id;
});
after(() => pool.end());

test("orden límite GTC reserva el dinero en el casino y queda en el libro", async () => {
  const ana = await player("ana", 100);
  const r = await placeOrder(ana, { marketId, side: "BUY", outcome: "YES", type: "LIMIT", price: 40, shares: 10 });
  assert.equal(r.status, "open");
  assert.equal(bal("ana"), 96); // 10 acciones x 0,40
  assert.equal(bookOf(marketId).bestBid(), 40);
});

test("compra de NO cruza con la compra de SÍ (mint) y cobra comisión solo al taker", async () => {
  const beto = await player("beto", 100);
  // Beto compra NO a 60 => equivale a vender Sí a 40, cruza con la orden de Ana
  const r = await placeOrder(beto, { marketId, side: "BUY", outcome: "NO", type: "LIMIT", price: 60, shares: 5, tif: "FAK" });
  assert.equal(r.status, "filled");
  assert.equal(r.filledShares, 5);
  assert.equal(r.avgPrice, 60);
  // 5 x 0,60 = 3,00 + 2% = 3,06
  assert.equal(bal("beto"), 96.94);
  const trades = (await pool.query("SELECT kind, yes_price, qty FROM trades WHERE market_id=$1", [marketId])).rows;
  assert.deepEqual(trades, [{ kind: "mint", yes_price: 40, qty: 500 }]);
  const pos = (await pool.query("SELECT p.external_id, ps.outcome, ps.qty FROM positions ps JOIN players p ON p.id=ps.player_id WHERE market_id=$1 ORDER BY 1", [marketId])).rows;
  assert.deepEqual(pos, [{ external_id: "ana", outcome: "YES", qty: 500 }, { external_id: "beto", outcome: "NO", qty: 500 }]);
});

test("cancelar devuelve lo reservado al casino", async () => {
  const ana = (await pool.query("SELECT id FROM players WHERE external_id='ana'")).rows[0].id;
  const open = (await pool.query("SELECT id FROM orders WHERE player_id=$1 AND status='open'", [ana])).rows[0];
  await cancelOrder(ana, open.id);
  assert.equal(bal("ana"), 98); // quedan pagadas solo las 5 acciones llenadas (2,00)
  assert.equal(bookOf(marketId).bestBid(), undefined);
});

test("vender acciones exige tenerlas y paga al vendedor", async () => {
  const caro = await player("caro", 50);
  await assert.rejects(placeOrder(caro, { marketId, side: "SELL", outcome: "YES", type: "LIMIT", price: 55, shares: 1 }), /suficientes acciones/);
  const ana = (await pool.query("SELECT id FROM players WHERE external_id='ana'")).rows[0].id;
  await placeOrder(ana, { marketId, side: "SELL", outcome: "YES", type: "LIMIT", price: 55, shares: 2 });
  const r = await placeOrder(caro, { marketId, side: "BUY", outcome: "YES", type: "MARKET", amount: 5 });
  assert.equal(r.filledShares, 2); // solo había 2 acciones a la venta
  assert.equal(bal("ana"), 99.1); // recibió 2 x 0,55
});

test("saldo insuficiente rechaza sin tocar el libro", async () => {
  const dani = await player("dani", 1);
  await assert.rejects(placeOrder(dani, { marketId, side: "BUY", outcome: "YES", type: "LIMIT", price: 50, shares: 10 }), /Saldo insuficiente/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM orders WHERE player_id=$1", [dani])).rows[0].n, 0);
});

test("market maker de la casa da liquidez a ambos lados", async () => {
  config.mm.enabled = true;
  await refreshQuotes(marketId);
  config.mm.enabled = false;
  const b = bookOf(marketId);
  assert.ok(b.bestBid()! < b.bestAsk()!);
  const eva = await player("eva", 20);
  const r = await placeOrder(eva, { marketId, side: "BUY", outcome: "YES", type: "MARKET", amount: 10 });
  assert.ok(r.filledShares > 0);
});

test("resolución: propuesta, disputa, finalización y pago de $1 por acción ganadora", async () => {
  const before = { ana: bal("ana"), beto: bal("beto") };
  const res = await propose(eventId, { outcome: "NO", proposer: "admin:test", explanation: "BTC cerró a la baja" });
  assert.equal((await pool.query("SELECT count(*)::int n FROM orders WHERE market_id=$1 AND status='open'", [marketId])).rows[0].n, 0);
  await dispute(res.id, "admin:otro", "revisar fuente");
  await assert.rejects(finalize(res.id), /disputada/);
  const fin = await finalize(res.id, { force: true });
  assert.equal(fin.status, "finalized");
  assert.equal(bal("beto"), before.beto + 5); // 5 acciones NO x $1
  assert.equal(bal("ana"), before.ana); // sus acciones SÍ valen 0
  const credits = casino.calls.filter((c) => c.action === "credit" && c.body.reason === "payout");
  assert.ok(credits.length >= 1);
  assert.equal((await pool.query("SELECT status FROM events WHERE id=$1", [eventId])).rows[0].status, "resolved");
});

test("evento múltiple: gana un mercado y los demás resuelven NO", async () => {
  const ev = await createEvent({
    title: "¿Quién ganará Miss Universo de prueba?", category: "reinados", kind: "multi", closeTime: futureIso(),
    outcomes: [{ label: "Colombia", probability: 0.4 }, { label: "Venezuela", probability: 0.6 }],
    resolutionCriteria: "País de la ganadora coronada en la gala.", resolutionSource: "Miss Universo",
  });
  const [col, ven] = ev.markets;
  const fer = await player("fer", 100);
  const gabi = await player("gabi", 100);
  await placeOrder(fer, { marketId: col.id, side: "BUY", outcome: "YES", type: "LIMIT", price: 40, shares: 10 });
  await placeOrder(gabi, { marketId: col.id, side: "BUY", outcome: "NO", type: "LIMIT", price: 60, shares: 10 });
  const r = await propose(ev.id, { winningMarketId: col.id, proposer: "ai" });
  await finalize(r.id); // ventana de 0 minutos en pruebas
  assert.equal(bal("fer"), 100 - 4 + 10);
  const statuses = (await pool.query("SELECT id, resolved_outcome FROM markets WHERE event_id=$1 ORDER BY id", [ev.id])).rows;
  assert.deepEqual(statuses.map((s) => s.resolved_outcome), ["YES", "NO"]);
  assert.ok(ven);
});
