import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, casino, futureIso } from "./helpers.js";
import { buildServer } from "../src/server.js";
import { signRequest } from "../src/lib/crypto.js";
import { config } from "../src/config.js";
import { verifyJournal, balances, trueUpMmCustody } from "../src/services/treasury.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance, mm: any, ana: { authorization: string };
const admin = { "x-admin-key": config.adminApiKey, "x-admin-user": "tesorero" };
const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: admin, payload });
const mmReq = (method: string, url: string, body?: object) => {
  const raw = body ? JSON.stringify(body) : "", ts = String(Date.now());
  return { method: method as any, url, payload: raw || undefined, headers: { "content-type": "application/json", "x-mm-key": mm.apiKey, "x-timestamp": ts, "x-signature": signRequest(mm.apiSecret, ts, method, url, raw) } };
};
const reserves = async () => (await app.inject({ method: "GET", url: "/admin/treasury/reserves", headers: admin })).json().marketMakers;

/** Mercado donde el market maker vende Sí a 60 (compra No a 40) y Ana le compra 100 acciones Sí. */
async function tradeAndResolve(title: string, outcome: "YES" | "NO") {
  const ev = (await post("/admin/events", { title, category: "deportes", kind: "binary", closeTime: futureIso(5),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Resultado oficial publicado por la federación.", resolutionSource: "Federación" })).json();
  const marketId = ev.markets[0].id;
  const o = await app.inject(mmReq("POST", "/mm/v1/orders", { marketId, side: "BUY", outcome: "NO", price: 40, shares: 100, postOnly: true }));
  assert.equal(o.statusCode, 201, o.body);
  const b = await app.inject({ method: "POST", url: "/v1/orders", headers: ana, payload: { marketId, side: "BUY", outcome: "YES", type: "LIMIT", price: 60, shares: 100 } });
  assert.ok(b.statusCode < 300, b.body);
  const r = (await post(`/admin/events/${ev.id}/resolve`, { outcome })).json();
  await post(`/admin/resolutions/${r.id}/finalize`, { force: true });
}

before(async () => {
  await resetDb();
  config.mm.enabled = false;
  config.integrity.maxStakePerMarketUsd = 0;
  app = await buildServer();
  await pool.query("UPDATE operators SET created_at = now() - interval '1 day'");
  casino.balances.set("ana", 1000e6);
  const raw = JSON.stringify({ playerId: "ana", displayName: "Ana" }), ts = String(Date.now());
  const s = await app.inject({ method: "POST", url: "/operator/v1/sessions", payload: raw, headers: { "content-type": "application/json", "x-operator-key": "key1", "x-timestamp": ts, "x-signature": signRequest("secret1", ts, "POST", "/operator/v1/sessions", raw) } });
  ana = { authorization: `Bearer ${s.json().token}` };
  mm = (await post("/admin/market-makers", { name: "Liquidez Andina" })).json();
  await post(`/admin/market-makers/${mm.playerId}/funds`, { direction: "deposit", amountUsd: 1000 });
});
after(async () => { await app.close(); await pool.end(); });

test("custodia de market makers: si gana, la liquidación traspasa su ganancia a la custodia", async () => {
  assert.equal((await reserves()).ok, true);
  await tradeAndResolve("¿Ganará Ecuador el partido de la custodia?", "NO"); // el market maker gana $60 (+ reembolso)
  const before = await reserves();
  assert.equal(before.ok, false, "su cuenta ya vale más que lo depositado");
  assert.ok(before.accounts - before.custody >= 60e6);

  const created = (await post("/admin/treasury/settle")).json().created;
  assert.ok(created.some((x: any) => x.operatorId === "casino1" && x.amount > 0), "el casino de Ana le debe a la plataforma");
  const after = await reserves();
  assert.equal(after.ok, true);
  assert.equal(after.custody, after.accounts);
  const b = await balances();
  assert.equal(-(b.get(`mm:${mm.playerId}`) ?? 0), after.accounts, "lo que se le debe al market maker = su cuenta");
  assert.equal((await verifyJournal()).ok, true);
  assert.deepEqual(await trueUpMmCustody(), { adjusted: 0, total: 0 }, "sin cambios no hay asiento");
});

test("custodia de market makers: si pierde, la diferencia vuelve al fideicomiso", async () => {
  const fid0 = (await balances("fideicomiso")).get("fideicomiso") ?? 0;
  const custody0 = (await reserves()).custody;
  await tradeAndResolve("¿Ganará Ecuador el segundo partido de la custodia?", "YES"); // pierde sus $40
  const r = await post("/admin/treasury/mm-custody/true-up");
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().total < 0);
  const after = await reserves();
  assert.equal(after.ok, true);
  assert.ok(after.custody < custody0);
  assert.equal((await balances("fideicomiso")).get("fideicomiso"), fid0 - r.json().total, "lo que perdió vuelve al fideicomiso");
  assert.equal((await verifyJournal()).ok, true);
});
