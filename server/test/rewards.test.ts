import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, futureIso } from "./helpers.js";
import { buildServer } from "../src/server.js";
import { signRequest } from "../src/lib/crypto.js";
import { config } from "../src/config.js";
import { orderScore, sampleScores, sampleShares, bookMid, asYesQuote, DEFAULT_REWARDS } from "../src/engine/rewards.js";
import { sampleLiquidity, payLiquidityRewards } from "../src/services/rewards.js";
import { verifyJournal, balances } from "../src/services/treasury.js";
import type { FastifyInstance } from "fastify";

// ---------- motor ----------

test("puntaje: cuadrático en la distancia, cero fuera del spread o bajo el tamaño mínimo", () => {
  assert.equal(orderScore(0, 100), 100);
  assert.equal(orderScore(1.5, 100), 25);       // a mitad del spread vale la cuarta parte
  assert.equal(orderScore(3, 100), 0);
  assert.equal(orderScore(3.5, 100), 0);
  assert.equal(orderScore(0, 49), 0);            // bajo LIQ_REWARD_MIN_SHARES
  assert.deepEqual(asYesQuote({ owner: 1, side: "BUY", outcome: "NO", price: 48, shares: 1 }), { kind: "ask", price: 52 });
  assert.deepEqual(asYesQuote({ owner: 1, side: "SELL", outcome: "NO", price: 48, shares: 1 }), { kind: "bid", price: 52 });
});

test("dos lados vale más que uno; fuera de 10–90¢ hay que cotizar los dos", () => {
  const two = [{ owner: "a", side: "BUY" as const, outcome: "YES" as const, price: 49, shares: 100 }, { owner: "a", side: "BUY" as const, outcome: "NO" as const, price: 49, shares: 100 }];
  const one = [{ owner: "b", side: "BUY" as const, outcome: "YES" as const, price: 49, shares: 300 }];
  const s = sampleScores([...two, ...one], 50);
  // a: Q1 = Q2 = (2/3)²·100 = 44,4 → Qmin 44,4. b: Q1 = 133,3, Q2 = 0 → 133,3 / 3 = 44,4
  assert.ok(Math.abs(s.get("a")! - s.get("b")!) < 1e-9, "un lado rinde 1/3: 300 de un lado = 100 de cada lado");
  const sh = sampleShares(s);
  assert.ok(Math.abs(sh.get("a")! - 0.5) < 1e-9);
  assert.equal(sampleScores(one.map((o) => ({ ...o, price: 4 })), 5).size, 0, "a 5¢ un solo lado no puntúa");
  assert.equal(bookMid([...two], 30), 50);
  assert.equal(bookMid([one[0]], 30), 30, "con un solo lado usa el de respaldo");
  assert.equal(DEFAULT_REWARDS.maxSpreadCents, 3);
});

// ---------- servidor ----------

let app: FastifyInstance;
const admin = { "x-admin-key": config.adminApiKey, "x-admin-user": "tesorero" };
const saved = { ...config.rewards };
const mmReq = (m: { apiKey: string; apiSecret: string }, method: string, url: string, body?: object) => {
  const raw = body ? JSON.stringify(body) : "", ts = String(Date.now());
  return { method: method as any, url, payload: raw || undefined, headers: { "content-type": "application/json", "x-mm-key": m.apiKey, "x-timestamp": ts, "x-signature": signRequest(m.apiSecret, ts, method, url, raw) } };
};
async function newMm(name: string) {
  const m = (await app.inject({ method: "POST", url: "/admin/market-makers", headers: admin, payload: { name } })).json();
  await app.inject({ method: "POST", url: `/admin/market-makers/${m.playerId}/funds`, headers: admin, payload: { direction: "deposit", amountUsd: 5000 } });
  return m;
}
const balanceOf = async (m: any) => (await app.inject(mmReq(m, "GET", "/mm/v1/account"))).json().balance;
// Pasa el día de las muestras a ayer, para poder pagarlo
let shift = 0;
const closeDay = async () => {
  shift++;
  const open = await pool.query("SELECT day, market_id FROM liquidity_days WHERE paid_at IS NULL");
  for (const r of open.rows) {
    await pool.query("UPDATE liquidity_scores SET day = day - $3::int WHERE day=$1 AND market_id=$2", [r.day, r.market_id, shift]);
    await pool.query("UPDATE liquidity_days SET day = day - $3::int WHERE day=$1 AND market_id=$2", [r.day, r.market_id, shift]);
  }
};

before(async () => {
  await resetDb();
  config.mm.enabled = false;
  config.integrity.maxStakePerMarketUsd = 1000;
  Object.assign(config.rewards, { enabled: true, defaultDailyUsd: 0, maxDailyUsd: 1000 });
  app = await buildServer();
});
after(async () => { Object.assign(config.rewards, saved); await app.close(); await pool.end(); });

test("incentivos: quien cotiza ajustado y de los dos lados se lleva la mayor parte del pozo", async () => {
  const ev = (await app.inject({ method: "POST", url: "/admin/events", headers: admin, payload: { title: "¿Ganará Ecuador el partido de los incentivos?", category: "deportes", kind: "binary", closeTime: futureIso(10),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Resultado oficial publicado por la federación.", resolutionSource: "Federación" } })).json();
  const marketId = ev.markets[0].id;
  const r = await app.inject({ method: "PATCH", url: `/admin/markets/${marketId}/reward`, headers: admin, payload: { dailyUsd: 100 } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().effectiveDaily, 100e6);

  const tight = await newMm("Ajustado"), wide = await newMm("Ancho");
  // Ajustado: 49 / 51 (compra Sí a 49 y No a 49), 200 de cada lado. Ancho: solo compra Sí a 48, 200.
  for (const [m, ops] of [[tight, [{ side: "BUY", outcome: "YES", price: 49 }, { side: "BUY", outcome: "NO", price: 49 }]], [wide, [{ side: "BUY", outcome: "YES", price: 48 }]]] as const) {
    const b = await app.inject(mmReq(m, "POST", "/mm/v1/orders/batch", { ops: ops.map((o) => ({ action: "place", marketId, shares: 200, postOnly: true, ...o })) }));
    assert.ok(b.json().results.every((x: any) => x.ok), b.body);
  }
  for (let i = 0; i < 3; i++) await sampleLiquidity();

  const est = (await app.inject(mmReq(tight, "GET", "/mm/v1/rewards"))).json();
  const mine = est.markets.find((x: any) => x.marketId === marketId);
  assert.equal(mine.samplesToday, 3);
  assert.ok(mine.myShareToday > 0.8, JSON.stringify(mine));
  const ov = (await app.inject({ method: "GET", url: "/admin/liquidity-rewards", headers: admin })).json();
  assert.equal(ov.rewardedMarkets, 1);
  assert.equal(ov.today[0].participants.length, 2);

  // Hoy todavía no se paga nada
  assert.deepEqual(await payLiquidityRewards(), []);

  const before = [await balanceOf(tight), await balanceOf(wide)];
  await closeDay();
  const paid = await payLiquidityRewards();
  assert.equal(paid.length, 1);
  assert.ok(paid[0].paid > 0 && paid[0].paid <= 100e6);
  const gain = [(await balanceOf(tight)) - before[0], (await balanceOf(wide)) - before[1]];
  assert.ok(gain[0] > 80e6 && gain[1] > 0 && gain[0] + gain[1] <= 100e6, JSON.stringify(gain));
  assert.equal(gain[0] % 1e4, 0, "en centavos");

  // Contabilidad: gasto + traspaso del fideicomiso a la custodia; el libro sigue íntegro
  const b = await balances();
  assert.equal(b.get("gasto:incentivos_liquidez"), gain[0] + gain[1]);
  assert.equal(b.get("custodia_mm"), 10000e6 + gain[0] + gain[1]);
  assert.equal((await verifyJournal()).ok, true);
  const reserves = (await app.inject({ method: "GET", url: "/admin/treasury/reserves", headers: admin })).json();
  assert.equal(reserves.marketMakers.ok, true);

  // Idempotente
  assert.deepEqual(await payLiquidityRewards(), []);
  assert.equal(await balanceOf(tight), before[0] + gain[0]);
  const hist = (await app.inject(mmReq(tight, "GET", "/mm/v1/rewards"))).json().paid;
  assert.equal(hist[0].amountUsd, gain[0] / 1e6);
});

test("tope diario: si los pozos superan LIQ_REWARDS_MAX_DAILY_USD se reduce a todos", async () => {
  config.rewards.maxDailyUsd = 10;
  await sampleLiquidity();
  await closeDay();
  const paid = await payLiquidityRewards();
  assert.equal(paid.length, 1);
  assert.ok(paid[0].paid <= 10e6 && paid[0].paid > 9e6, String(paid[0].paid));
  config.rewards.maxDailyUsd = 1000;
});

test("sin pozo no se muestrea ni se paga", async () => {
  await pool.query("UPDATE markets SET reward_daily = NULL");
  assert.deepEqual(await sampleLiquidity(), { markets: 0 });
});
