import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, casino, futureIso } from "./helpers.js";
import { buildServer } from "../src/server.js";
import { signRequest } from "../src/lib/crypto.js";
import { config } from "../src/config.js";
import { verifySignature } from "../src/services/oracle.js";
import { markOverdue, verifyJournal, canonical } from "../src/services/treasury.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
const admin = { "x-admin-key": config.adminApiKey, "x-admin-user": "tesorero" };
const auth: Record<string, { authorization: string }> = {};
let liq: Record<string, any> = {};

function opReq(method: string, url: string, body: object | undefined, key: string, secret: string) {
  const raw = body ? JSON.stringify(body) : "";
  const ts = String(Date.now());
  return { method: method as any, url, payload: raw || undefined,
    headers: { "content-type": "application/json", "x-operator-key": key, "x-timestamp": ts, "x-signature": signRequest(secret, ts, method, url, raw) } };
}
const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: admin, payload });
const status = async (id: string) => (await app.inject({ method: "GET", url: "/admin/treasury", headers: admin })).json().casinos.find((c: any) => c.operatorId === id);

before(async () => {
  await resetDb();
  config.mm.enabled = false;
  config.integrity.maxStakePerMarketUsd = 0;
  app = await buildServer();
  await pool.query("INSERT INTO operators (id, name, api_key, api_secret, wallet_url, wallet_secret, revenue_share_bps) VALUES ('casino2','Casino Dos','key2','secret2','http://wallet2.test','wsecret2',5000)");
  // Las liquidaciones arrancan desde la creación de cada casino
  await pool.query("UPDATE operators SET created_at = now() - interval '1 day'");
  for (const [id, key, secret] of [["ana", "key1", "secret1"], ["beto", "key2", "secret2"]]) {
    casino.balances.set(id, 1000e6);
    auth[id] = { authorization: `Bearer ${(await app.inject(opReq("POST", "/operator/v1/sessions", { playerId: id, displayName: id }, key, secret))).json().token}` };
  }
  // Juego entre casinos: Ana (casino 1) pone Sí a 40, Beto (casino 2) toma No a 60. Gana Sí.
  const ev = (await post("/admin/events", { title: "¿Ganará Ecuador el partido de tesorería?", category: "deportes", kind: "binary", closeTime: futureIso(5),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Resultado oficial publicado por la federación.", resolutionSource: "Federación" })).json();
  const marketId = ev.markets[0].id;
  await app.inject({ method: "POST", url: "/v1/orders", headers: auth.ana, payload: { marketId, side: "BUY", outcome: "YES", type: "LIMIT", price: 40, shares: 100 } });
  await app.inject({ method: "POST", url: "/v1/orders", headers: auth.beto, payload: { marketId, side: "BUY", outcome: "NO", type: "MARKET", amount: 61.2 } });
  const r = (await post(`/admin/events/${ev.id}/resolve`, { outcome: "YES" })).json();
  await post(`/admin/resolutions/${r.id}/finalize`, { force: true });
});
after(async () => { await app.close(); await pool.end(); });

test("liquidación: un estado de cuenta firmado por casino y asientos en el libro", async () => {
  const r = await post("/admin/treasury/settle");
  assert.equal(r.statusCode, 200, r.body);
  liq = Object.fromEntries(r.json().created.map((s: any) => [s.operatorId, s]));
  assert.equal(liq.casino2.amount, 60.6e6); // el casino de Beto le paga a la plataforma
  assert.equal(liq.casino1.amount, -60e6); // la plataforma le paga al casino de Ana
  assert.equal(liq.casino2.status, "pending");
  // Estado de cuenta firmado: el casino lo puede verificar con la clave pública del oráculo
  const st = await app.inject(opReq("GET", `/operator/v1/treasury/statements/${liq.casino2.id}`, undefined, "key2", "secret2"));
  const keys = (await app.inject({ method: "GET", url: "/v1/oracle/keys" })).json();
  assert.ok(verifySignature(st.body, st.headers["x-oracle-signature"] as string, keys.keys[0].publicKeyPem));
  const body = JSON.parse(st.body).data;
  assert.equal(body.amountUsd, 60.6);
  assert.equal(body.paymentReference, `LIQ-${liq.casino2.id}`);
  // Un casino no ve el estado de otro
  assert.equal((await app.inject(opReq("GET", `/operator/v1/treasury/statements/${liq.casino1.id}`, undefined, "key2", "secret2"))).statusCode, 404);
  // Volver a liquidar enseguida no duplica
  assert.equal((await post("/admin/treasury/settle")).json().created.length, 0);
  assert.ok((await verifyJournal()).ok);
});

test("garantía exigida: sin ella el casino queda pausado; sus jugadores no abren apuestas nuevas", async () => {
  await app.inject({ method: "PATCH", url: "/admin/treasury/casinos/casino2", headers: admin, payload: { guaranteeRequiredUsd: 100 } });
  const s = await status("casino2");
  assert.ok(s.paused);
  assert.match(s.pausedReason, /garantía incompleta/);
  const ev = (await post("/admin/events", { title: "¿Habrá goles en el segundo partido de tesorería?", category: "deportes", kind: "binary", closeTime: futureIso(5),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Resultado oficial publicado por la federación.", resolutionSource: "Federación" })).json();
  const marketId = ev.markets[0].id;
  const o = await app.inject({ method: "POST", url: "/v1/orders", headers: auth.beto, payload: { marketId, side: "BUY", outcome: "YES", type: "LIMIT", price: 30, shares: 5 } });
  assert.equal(o.statusCode, 409);
  assert.equal(o.json().error, "operator_paused");
  // Deposita la garantía: se reanuda (debe 60,60 y su límite es su garantía de 100)
  await post("/admin/treasury/guarantees/casino2", { direction: "deposit", amountUsd: 100, bankRef: "DEP-77" });
  const s2 = await status("casino2");
  assert.equal(s2.guarantee, 100e6);
  assert.ok(!s2.paused, s2.pausedReason);
});

test("liquidación vencida: pausa y cobro de la garantía", async () => {
  await pool.query("UPDATE settlements SET due_at = now() - interval '1 hour' WHERE id=$1", [liq.casino2.id]);
  assert.ok((await markOverdue()) >= 1);
  await post("/admin/treasury/settle"); // reevalúa
  let s = await status("casino2");
  assert.ok(s.paused);
  assert.match(s.pausedReason, /vencida/);
  const c = await post(`/admin/treasury/settlements/${liq.casino2.id}/collect`);
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().collected, 60.6e6);
  s = await status("casino2");
  assert.equal(s.guarantee, 39.4e6);
  assert.ok(s.paused, "la garantía quedó por debajo de lo exigido");
  await post("/admin/treasury/guarantees/casino2", { direction: "deposit", amountUsd: 60.6, bankRef: "DEP-78" });
  assert.ok(!(await status("casino2")).paused);
});

test("conciliación: la transferencia del extracto marca pagada la liquidación", async () => {
  const csv = `fecha;referencia;monto;descripcion
2026-10-27;TRX-9001;-60,00;Pago LIQ-${liq.casino1.id} a casino1
2026-10-27;TRX-9002;15,00;Ingreso sin identificar`;
  const r = await post("/admin/treasury/bank-statements", { csv });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { lines: 2, imported: 2, matched: 1, unmatched: 1 });
  const ov = (await app.inject({ method: "GET", url: "/admin/treasury", headers: admin })).json();
  const s1 = ov.settlements.find((s: any) => s.id === liq.casino1.id);
  assert.equal(s1.status, "paid");
  assert.equal(s1.bank_ref, "TRX-9001");
  assert.equal(ov.unmatchedBankLines.length, 1);
  // Cargar el mismo extracto otra vez no duplica nada
  assert.equal((await post("/admin/treasury/bank-statements", { csv })).json().imported, 0);
});

test("reservas: el fideicomiso cubre garantías, pagos pendientes y riesgo de la casa", async () => {
  await post("/admin/treasury/reserve", { direction: "deposit", amountUsd: 500 });
  const r = (await app.inject({ method: "GET", url: "/admin/treasury/reserves", headers: admin })).json();
  // 100 + 60,60 de garantías − 60 pagados a casino1 + 500 de reserva
  assert.equal(r.fiduciary, 600.6e6);
  assert.equal(r.guarantees, 100e6);
  assert.equal(r.payableToCasinos, 0);
  assert.equal(r.houseReserve, 500e6);
  assert.ok(r.ok);
});

test("libro encadenado: si alguien edita un asiento, la verificación dice cuál", async () => {
  const v = await verifyJournal();
  assert.ok(v.ok && v.entries >= 6);
  const row = (await pool.query("SELECT id, memo FROM journal ORDER BY id LIMIT 1 OFFSET 2")).rows[0];
  await pool.query("UPDATE journal SET memo='retocado' WHERE id=$1", [row.id]);
  const bad = await verifyJournal();
  assert.equal(bad.ok, false);
  assert.equal(bad.brokenAt, Number(row.id));
  await pool.query("UPDATE journal SET memo=$2 WHERE id=$1", [row.id, row.memo]);
  assert.ok((await verifyJournal()).ok);
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test("el casino ve su tesorería", async () => {
  const t = (await app.inject(opReq("GET", "/operator/v1/treasury", undefined, "key2", "secret2"))).json();
  assert.equal(t.operatorId, "casino2");
  assert.equal(t.guarantee, 100e6);
  assert.equal(t.settlements[0].status, "covered");
  assert.equal(t.settlements[0].paymentReference, `LIQ-${liq.casino2.id}`);
});
