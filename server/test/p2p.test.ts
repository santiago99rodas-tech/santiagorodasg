import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, bal, casino, futureIso } from "./helpers.js";
import { buildServer } from "../src/server.js";
import { signRequest } from "../src/lib/crypto.js";
import { config } from "../src/config.js";
import { bookOf } from "../src/services/trading.js";
import { refreshQuotes, planQuotes } from "../src/services/marketmaker.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
const admin = { "x-admin-key": config.adminApiKey, "x-admin-user": "tester" };
let mm: { playerId: number; apiKey: string; apiSecret: string };
const auth: Record<string, { authorization: string }> = {};

function opReq(method: string, url: string, body: object | undefined, key = "key1", secret = "secret1") {
  const raw = body ? JSON.stringify(body) : "";
  const ts = String(Date.now());
  return { method: method as any, url, payload: raw || undefined,
    headers: { "content-type": "application/json", "x-operator-key": key, "x-timestamp": ts, "x-signature": signRequest(secret, ts, method, url, raw) } };
}
function mmReq(method: string, url: string, body?: object) {
  const raw = body ? JSON.stringify(body) : "";
  const ts = String(Date.now());
  return { method: method as any, url, payload: raw || undefined,
    headers: { "content-type": "application/json", "x-mm-key": mm.apiKey, "x-timestamp": ts, "x-signature": signRequest(mm.apiSecret, ts, method, url, raw) } };
}
async function event(title: string) {
  const r = await app.inject({ method: "POST", url: "/admin/events", headers: admin, payload: {
    title, category: "deportes", kind: "binary", closeTime: futureIso(10),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Resultado oficial publicado por la federación.", resolutionSource: "Federación" } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}

before(async () => {
  await resetDb();
  config.integrity.maxStakePerMarketUsd = 1000;
  app = await buildServer();
  // Segundo casino con 50% de revenue share
  await pool.query("INSERT INTO operators (id, name, api_key, api_secret, wallet_url, wallet_secret, revenue_share_bps) VALUES ('casino2','Casino Dos','key2','secret2','http://wallet2.test','wsecret2',5000)");
  for (const [id, key, secret] of [["ana", "key1", "secret1"], ["beto", "key2", "secret2"]]) {
    casino.balances.set(id, 1000e6);
    const s = (await app.inject(opReq("POST", "/operator/v1/sessions", { playerId: id, displayName: id }, key, secret))).json();
    auth[id] = { authorization: `Bearer ${s.token}` };
  }
});
after(async () => { config.mm.enabled = false; await app.close(); await pool.end(); });

test("market maker externo: alta, depósito, órdenes post-only en lote y reembolso cuando un jugador le compra", async () => {
  const ev = await event("¿Ganará Ecuador la Copa de prueba P2P?");
  const marketId = ev.markets[0].id;
  const c = await app.inject({ method: "POST", url: "/admin/market-makers", headers: admin, payload: { name: "Liquidez Andina" } });
  assert.equal(c.statusCode, 200, c.body);
  mm = c.json();
  assert.equal((await app.inject(mmReq("GET", "/mm/v1/account"))).json().balance, 0);
  // Sin saldo no puede cotizar
  const broke = await app.inject(mmReq("POST", "/mm/v1/orders", { marketId, side: "BUY", outcome: "YES", price: 48, shares: 100 }));
  assert.equal(broke.statusCode, 402, broke.body);
  await app.inject({ method: "POST", url: `/admin/market-makers/${mm.playerId}/funds`, headers: admin, payload: { direction: "deposit", amountUsd: 5000 } });

  const b = await app.inject(mmReq("POST", "/mm/v1/orders/batch", { ops: [
    { action: "place", marketId, side: "BUY", outcome: "YES", price: 49, shares: 500, postOnly: true },
    { action: "place", marketId, side: "BUY", outcome: "NO", price: 49, shares: 500, postOnly: true }, // vende Sí a 51
    { action: "place", marketId, side: "BUY", outcome: "NO", price: 52, shares: 10, postOnly: true }, // vende Sí a 48: tocaría su propia compra a 49
  ] }));
  assert.equal(b.statusCode, 200, b.body);
  const res = b.json().results;
  assert.ok(res[0].ok && res[1].ok, JSON.stringify(res));
  assert.equal(res[2].error, "would_cross"); // el lote sigue aunque una falle
  assert.equal(bookOf(marketId).bestBid(), 49);
  assert.equal(bookOf(marketId).bestAsk(), 51);
  // Post-only que cruzaría: se rechaza
  const cross = await app.inject(mmReq("POST", "/mm/v1/orders", { marketId, side: "BUY", outcome: "YES", price: 60, shares: 10, postOnly: true }));
  assert.equal(cross.statusCode, 409);
  assert.equal(cross.json().error, "would_cross");

  // Un jugador del casino 1 compra Sí: le compra al market maker y paga 2% de comisión; el MM cobra 0,5% de reembolso
  const before = (await app.inject(mmReq("GET", "/mm/v1/account"))).json();
  const o = await app.inject({ method: "POST", url: "/v1/orders", headers: auth.ana, payload: { marketId, side: "BUY", outcome: "YES", type: "MARKET", amount: 20 } });
  assert.equal(o.statusCode, 201, o.body);
  const after = (await app.inject(mmReq("GET", "/mm/v1/account"))).json();
  const spentOnShares = o.json().spent - o.json().fee;
  assert.ok(after.rebates > 0);
  assert.ok(Math.abs(after.rebates - spentOnShares * 0.005) <= 2e4, `${after.rebates} vs ${spentOnShares * 0.005}`);
  assert.equal(after.balance - before.balance, after.rebates); // el reembolso se acredita a su saldo
  const fills = (await app.inject(mmReq("GET", "/mm/v1/fills"))).json();
  assert.ok(fills.some((f: any) => f.role === "maker" && Number(f.rebate) > 0));
  // El market maker no tiene el tope de $1.000 por mercado de los jugadores
  const big = await app.inject(mmReq("POST", "/mm/v1/orders", { marketId, side: "BUY", outcome: "YES", price: 40, shares: 4000 }));
  assert.equal(big.statusCode, 201, big.body);
  const cancel = await app.inject(mmReq("DELETE", `/mm/v1/orders?marketId=${marketId}`));
  assert.equal(cancel.json().cancelledMarkets, 1);
  assert.equal(bookOf(marketId).ordersOf(mm.playerId).length, 0);
});

test("la casa queda de respaldo cuando hay liquidez externa cerca del precio", async () => {
  const ev = await event("¿Habrá penales en la final de prueba P2P?");
  const marketId = ev.markets[0].id;
  config.mm.enabled = true;
  await refreshQuotes(marketId);
  const house = (await planQuotes(marketId))[0];
  const spreadAlone = house.diag!.halfSpreadCents;
  assert.ok(!house.state.outcomes[0].backstop);
  await app.inject(mmReq("POST", "/mm/v1/orders/batch", { ops: [
    { action: "place", marketId, side: "BUY", outcome: "YES", price: 49, shares: 300, postOnly: true },
    { action: "place", marketId, side: "BUY", outcome: "NO", price: 49, shares: 300, postOnly: true },
  ] }));
  const backed = (await planQuotes(marketId))[0];
  assert.ok(backed.state.outcomes[0].backstop);
  assert.ok(backed.diag!.halfSpreadCents > spreadAlone, `${backed.diag!.halfSpreadCents} > ${spreadAlone}`);
  config.mm.enabled = false;
  await app.inject(mmReq("DELETE", "/mm/v1/orders"));
});

test("liquidación entre casinos: el casino cuyo jugador perdió le paga a la plataforma y ella al del ganador", async () => {
  const ev = await event("¿Anotará Ecuador primero en la prueba P2P?");
  const marketId = ev.markets[0].id;
  // Ana (casino 1) pone una orden límite y Beto (casino 2) la toma: juego entre casinos, sin la casa
  await app.inject({ method: "POST", url: "/v1/orders", headers: auth.ana, payload: { marketId, side: "BUY", outcome: "YES", type: "LIMIT", price: 40, shares: 100 } });
  const t = await app.inject({ method: "POST", url: "/v1/orders", headers: auth.beto, payload: { marketId, side: "BUY", outcome: "NO", type: "MARKET", amount: 61.2 } });
  assert.equal(t.statusCode, 201, t.body);
  assert.equal(t.json().filledShares, 100); // 100 × 0,60 + 2% = 61,20
  // Gana Sí: Ana cobra $100 en el casino 1
  const p = (await app.inject({ method: "POST", url: `/admin/events/${ev.id}/resolve`, headers: admin, payload: { outcome: "YES" } })).json();
  await app.inject({ method: "POST", url: `/admin/resolutions/${p.id}/finalize`, headers: admin, payload: { force: true } });

  const r = (await app.inject({ method: "GET", url: "/admin/clearing", headers: admin })).json();
  const c1 = r.casinos.find((c: any) => c.operatorId === "casino1"), c2 = r.casinos.find((c: any) => c.operatorId === "casino2");
  // Casino 1 cobró 40 + 20 de la primera prueba y pagó 100: le deben. Casino 2 cobró 61,20 y no pagó nada: debe 61,20 − 50% de la comisión
  assert.equal(c2.collected, 61.2e6);
  assert.equal(c2.fees, 1.2e6);
  assert.equal(c2.revenueShare, 0.6e6);
  assert.equal(c2.due, 60.6e6);
  assert.equal(c2.playersResult, -60e6);
  assert.ok(c1.due < 0, "la plataforma le paga al casino 1");
  assert.ok(r.liquidity.betweenCasinos >= 40e6, "hubo juego entre casinos");
  assert.ok(r.liquidity.fromMarketMakers > 0);
  // El casino ve su propia liquidación
  const own = (await app.inject(opReq("GET", "/operator/v1/clearing", undefined, "key2", "secret2"))).json();
  assert.equal(own.due, 60.6e6);
  assert.equal(own.operatorId, "casino2");
});
