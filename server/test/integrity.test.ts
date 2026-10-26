import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, player, futureIso } from "./helpers.js";
import { createEvent } from "../src/services/events.js";
import { placeOrder } from "../src/services/trading.js";
import { propose, finalize } from "../src/services/resolution.js";
import { integrityReport, addReferencePrice, setExternalRef, refreshExternalPrices } from "../src/services/integrity.js";
import { config } from "../src/config.js";

const binary = (title: string, p: number, category = "cripto") => createEvent({
  title, category, kind: "binary", closeTime: futureIso(), outcomes: [{ label: "Sí", probability: p }],
  resolutionCriteria: "Criterio de prueba suficientemente claro.", resolutionSource: "Fuente oficial",
}, { quote: false });

/** Fija el precio que tenía el mercado 8 días antes (lo que mide la calibración a 7 días). */
async function setPastPrice(marketId: number, price: number) {
  await pool.query("INSERT INTO price_history (market_id, ts, price) VALUES ($1, now() - interval '8 days', $2)", [marketId, price]);
}
async function resolve(eventId: number, outcome: "YES" | "NO") {
  const r = await propose(eventId, { outcome, proposer: "admin:test" });
  await finalize(r.id, { force: true });
}

before(async () => {
  await resetDb();
  config.integrity.maxStakePerMarketUsd = 0; // las contrapartes de prueba ponen órdenes grandes
});
after(() => pool.end());

test("calibración: tramos, Brier y sesgo favorito-batacazo con resultados conocidos", async () => {
  // 10 mercados a 80% (8 se cumplen) y 10 a 10% (ninguno se cumple)
  for (let i = 0; i < 10; i++) {
    const e = await binary(`¿Mercado de prueba favorito número ${i}?`, 0.8);
    await setPastPrice(e!.markets[0].id, 80);
    await resolve(e!.id, i < 8 ? "YES" : "NO");
  }
  for (let i = 0; i < 10; i++) {
    const e = await binary(`¿Mercado de prueba improbable número ${i}?`, 0.1);
    await setPastPrice(e!.markets[0].id, 10);
    await resolve(e!.id, "NO");
  }
  const r = await integrityReport({ horizonHours: 168 });
  assert.equal(r.overall.n, 20);
  assert.equal(r.reliable, false); // menos de 30 resueltos
  const b8 = r.calibration[8], b1 = r.calibration[1];
  assert.deepEqual([b8.n, b8.predicted, b8.actual], [10, 0.8, 0.8]);
  assert.deepEqual([b1.n, b1.predicted, b1.actual], [10, 0.1, 0]);
  // Brier = (8·0,04 + 2·0,64 + 10·0,01) / 20 = 0,085
  assert.equal(r.overall.brierRef, 0.085);
  assert.equal(r.bias.longshot.longshots.gap, -0.1); // se cumplen 10 puntos menos de lo que decía el precio
  assert.deepEqual(r.bias.yesNo.find((y: any) => y.category === "cripto"), { category: "cripto", name: "Cripto", yes: 8, no: 12, void: 0 });
  assert.equal(r.bias.openingAccuracy[0].origin, "catálogo o diseñador");
});

test("límite de apuesta por jugador y mercado", async () => {
  config.mm.enabled = false;
  const e = await binary("¿Mercado para probar el límite de apuesta?", 0.5);
  const m = e!.markets[0].id;
  const maker = await player("maker", 100000);
  await placeOrder(maker, { marketId: m, side: "BUY", outcome: "NO", type: "LIMIT", price: 50, shares: 5000 });
  const whale = await player("ballena", 100000);
  config.integrity.maxStakePerMarketUsd = 100;
  await placeOrder(whale, { marketId: m, side: "BUY", outcome: "YES", type: "MARKET", amount: 60 });
  await assert.rejects(placeOrder(whale, { marketId: m, side: "BUY", outcome: "YES", type: "MARKET", amount: 60 }), /máximo de \$100/);
  config.integrity.maxStakePerMarketUsd = 0;
});

test("concentración, sesgo de hinchada y alertas de compras tardías", async () => {
  const ev = await createEvent({
    title: "¿Qué país ganará el certamen de prueba?", category: "reinados", kind: "multi", closeTime: futureIso(),
    outcomes: [{ label: "Colombia", probability: 0.4 }, { label: "Venezuela", probability: 0.6 }],
    resolutionCriteria: "País de la ganadora en la gala final.", resolutionSource: "Organización del certamen",
  }, { quote: false });
  const col = ev!.markets[0].id;
  const house = await player("contraparte", 1e6);
  await placeOrder(house, { marketId: col, side: "BUY", outcome: "NO", type: "LIMIT", price: 60, shares: 2000 });
  // Cuatro colombianos y un ecuatoriano; casi todo el dinero al Sí de Colombia viene de Colombia y de un solo jugador
  const ids: number[] = [];
  for (const [ext, c] of [["co1", "CO"], ["co2", "CO"], ["co3", "CO"], ["co4", "CO"], ["ec1", "EC"]] as const) {
    const id = await player(ext, 1000); ids.push(id);
    await pool.query("UPDATE players SET country=$2 WHERE id=$1", [id, c]);
  }
  await placeOrder(ids[0], { marketId: col, side: "BUY", outcome: "YES", type: "MARKET", amount: 400 });
  for (const id of ids.slice(1, 4)) await placeOrder(id, { marketId: col, side: "BUY", outcome: "YES", type: "MARKET", amount: 10 });
  await placeOrder(ids[4], { marketId: col, side: "BUY", outcome: "YES", type: "MARKET", amount: 5 });

  let r = await integrityReport();
  const conc = r.integrity.concentration.find((c: any) => c.marketId === col);
  assert.ok(conc && conc.top1! > 0.9, "un jugador concentra más del 90%");
  const hb = r.integrity.homeBias.find((h: any) => h.marketId === col);
  assert.equal(hb.country, "CO");
  assert.ok(hb.moneyFromHome > 0.98 && hb.bettorsFromHome === 0.8);

  // La compra grande fue minutos antes de la propuesta y ganó: alerta
  const res = await propose(ev!.id, { winningMarketId: col, proposer: "admin:test" });
  await finalize(res.id, { force: true });
  r = await integrityReport();
  const alert = r.integrity.alerts.find((a: any) => a.kind === "compra tardía ganadora");
  assert.ok(alert && alert.amount >= 390e6, "alerta por compra tardía ganadora");
  assert.ok(r.integrity.houseByResolver.some((h: any) => h.proposer === "admin:test"));
});

test("referencias externas: manual y Polymarket", async () => {
  const e = await binary("¿Mercado con referencia externa de prueba?", 0.5, "finanzas");
  const m = e!.markets[0].id;
  await addReferencePrice(m, { source: "Casa de apuestas X", price: 62 }, "admin:test");
  await assert.rejects(setExternalRef(m, "otra-cosa"), /polymarket:/);
  await setExternalRef(m, "polymarket:mercado-de-prueba");
  const n = await refreshExternalPrices(async (url) => {
    assert.match(url, /slug=mercado-de-prueba/);
    return { ok: true, status: 200, json: async () => [{ outcomes: '["Yes","No"]', outcomePrices: '["0.47","0.53"]' }] };
  });
  assert.equal(n, 1);
  const r = await integrityReport();
  const ext = r.external.filter((x: any) => x.marketId === m);
  assert.deepEqual(ext.map((x: any) => [x.source, x.refPrice]).sort(), [["Casa de apuestas X", 62], ["Polymarket", 47]]);
  assert.equal(ext.find((x: any) => x.source === "Polymarket")!.diff, 50 - 47);
});
