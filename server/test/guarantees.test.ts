import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, casino, futureIso } from "./helpers.js";
import { buildServer } from "../src/server.js";
import { signRequest } from "../src/lib/crypto.js";
import { config } from "../src/config.js";
import { markOverdue, verifyJournal, expireInstruments, balances } from "../src/services/treasury.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
const admin = { "x-admin-key": config.adminApiKey, "x-admin-user": "tesorero" };
const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: admin, payload });
const status = async (id: string) => (await app.inject({ method: "GET", url: "/admin/treasury", headers: admin })).json().casinos.find((c: any) => c.operatorId === id);
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString();
function opReq(method: string, url: string, body: object | undefined, key: string, secret: string) {
  const raw = body ? JSON.stringify(body) : "", ts = String(Date.now());
  return { method: method as any, url, payload: raw || undefined, headers: { "content-type": "application/json", "x-operator-key": key, "x-timestamp": ts, "x-signature": signRequest(secret, ts, method, url, raw) } };
}

before(async () => {
  await resetDb();
  config.mm.enabled = false;
  config.integrity.maxStakePerMarketUsd = 0;
  app = await buildServer();
  await pool.query("INSERT INTO operators (id, name, api_key, api_secret, wallet_url, wallet_secret, revenue_share_bps) VALUES ('casino2','Casino Dos','key2','secret2','http://wallet2.test','wsecret2',5000)");
  await pool.query("UPDATE operators SET created_at = now() - interval '1 day'");
  const tok: Record<string, string> = {};
  for (const [id, key, secret] of [["ana", "key1", "secret1"], ["beto", "key2", "secret2"]]) {
    casino.balances.set(id, 1000e6);
    tok[id] = (await app.inject(opReq("POST", "/operator/v1/sessions", { playerId: id, displayName: id }, key, secret))).json().token;
  }
  // Ana (casino 1) gana a Beto (casino 2): el casino 2 queda debiendo
  const ev = (await post("/admin/events", { title: "¿Ganará Ecuador el partido de las pólizas?", category: "deportes", kind: "binary", closeTime: futureIso(5),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Resultado oficial publicado por la federación.", resolutionSource: "Federación" })).json();
  const marketId = ev.markets[0].id;
  await app.inject({ method: "POST", url: "/v1/orders", headers: { authorization: `Bearer ${tok.ana}` }, payload: { marketId, side: "BUY", outcome: "YES", type: "LIMIT", price: 40, shares: 100 } });
  await app.inject({ method: "POST", url: "/v1/orders", headers: { authorization: `Bearer ${tok.beto}` }, payload: { marketId, side: "BUY", outcome: "NO", type: "MARKET", amount: 61.2 } });
  const r = (await post(`/admin/events/${ev.id}/resolve`, { outcome: "YES" })).json();
  await post(`/admin/resolutions/${r.id}/finalize`, { force: true });
});
after(async () => { await app.close(); await pool.end(); });

let poliza: any, carta: any;

test("póliza: cuenta como garantía y levanta la pausa por garantía incompleta", async () => {
  await app.inject({ method: "PATCH", url: "/admin/treasury/casinos/casino2", headers: admin, payload: { guaranteeRequiredUsd: 20 } });
  assert.equal((await status("casino2")).paused, true);

  const r = await post("/admin/treasury/instruments", { operatorId: "casino2", kind: "poliza", issuer: "Seguros Equinoccial", number: "PC-2026-118", amountUsd: 100, expiresAt: day(90).slice(0, 10) });
  assert.equal(r.statusCode, 200, r.body);
  poliza = r.json();
  assert.equal(poliza.counts, true); assert.equal(poliza.available, 100e6);
  const s = await status("casino2");
  assert.equal(s.guaranteeCash, 0); assert.equal(s.guaranteeInstruments, 100e6); assert.equal(s.guarantee, 100e6);
  assert.equal(s.paused, false);

  // la misma póliza dos veces no
  assert.equal((await post("/admin/treasury/instruments", { operatorId: "casino2", kind: "poliza", issuer: "Seguros Equinoccial", number: "PC-2026-118", amountUsd: 5, expiresAt: day(30) })).statusCode, 409);
  // vencida no se acepta
  assert.equal((await post("/admin/treasury/instruments", { operatorId: "casino2", kind: "poliza", issuer: "X", number: "1", amountUsd: 5, expiresAt: day(-1) })).statusCode, 400);
});

test("carta de crédito por vencer: avisa y deja de contar antes del vencimiento", async () => {
  carta = (await post("/admin/treasury/instruments", { operatorId: "casino2", kind: "carta_credito", issuer: "Banco Pichincha", number: "SBLC-77", amountUsd: 500, expiresAt: day(3) })).json();
  assert.equal(carta.counts, false, "vence en menos de GUARANTEE_MIN_VALIDITY_DAYS");
  assert.equal(carta.expiringSoon, true);
  const s = await status("casino2");
  assert.equal(s.guaranteeInstruments, 100e6);
  assert.ok(s.instrumentsExpiring.some((x: any) => x.id === carta.id && x.counts === false));
});

test("ejecutar la póliza cobra la liquidación vencida", async () => {
  const created = (await post("/admin/treasury/settle")).json().created;
  const liq = created.find((x: any) => x.operatorId === "casino2");
  assert.ok(liq.amount > 0, JSON.stringify(created));
  await pool.query("UPDATE settlements SET due_at = now() - interval '1 hour' WHERE id=$1", [liq.id]);
  await markOverdue();
  await post("/admin/treasury/settle"); // re-evalúa
  assert.equal((await status("casino2")).paused, true);

  assert.equal((await post(`/admin/treasury/instruments/${poliza.id}/execute`, { settlementId: liq.id })).statusCode, 400, "sin referencia del pago");
  const r = await post(`/admin/treasury/instruments/${poliza.id}/execute`, { settlementId: liq.id, bankRef: "EQX-PAGO-1" });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().collected, liq.amount);
  const s = await status("casino2");
  assert.equal(s.overdueOwed, 0);
  assert.equal(s.guaranteeInstruments, 100e6 - liq.amount);
  assert.equal(s.paused, false);
  const st = (await app.inject({ method: "GET", url: "/admin/treasury", headers: admin })).json();
  assert.equal(st.settlements.find((x: any) => x.id === liq.id).status, "covered");
  // el dinero de la aseguradora entró al fideicomiso
  assert.equal((await balances("fideicomiso")).get("fideicomiso"), liq.amount);
});

test("devolver y vencer: sale de las cuentas de orden; el libro sigue íntegro", async () => {
  assert.equal((await post(`/admin/treasury/instruments/${carta.id}/release`)).statusCode, 200);
  assert.equal((await post(`/admin/treasury/instruments/${carta.id}/release`)).statusCode, 409);
  await pool.query("UPDATE guarantee_instruments SET expires_at = now() - interval '1 minute' WHERE id=$1", [poliza.id]);
  assert.equal(await expireInstruments(), 1);
  const list = (await app.inject({ method: "GET", url: "/admin/treasury/instruments", headers: admin })).json();
  assert.equal(list.find((x: any) => x.id === poliza.id).status, "expired");
  assert.equal(list.find((x: any) => x.id === carta.id).status, "released");
  const b = await balances("contingente:");
  assert.equal(b.get("contingente:casino2") ?? 0, 0);
  assert.equal(b.get("contingente:emisores") ?? 0, 0);
  assert.equal((await verifyJournal()).ok, true);
  // sin póliza vigente vuelve la pausa por garantía incompleta
  assert.equal((await status("casino2")).paused, true);
});

test("el casino ve sus pólizas en /operator/v1/treasury", async () => {
  const r = await app.inject(opReq("GET", "/operator/v1/treasury", undefined, "key2", "secret2"));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().instruments.length, 2);
  assert.equal(r.json().instruments[0].createdBy, undefined);
});
