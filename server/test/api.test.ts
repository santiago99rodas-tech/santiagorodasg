import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, bal, casino, futureIso } from "./helpers.js";
import { buildServer } from "../src/server.js";
import { signRequest } from "../src/lib/crypto.js";
import { config } from "../src/config.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
const admin = { "x-admin-key": config.adminApiKey, "x-admin-user": "tester" };

function signed(method: string, url: string, body?: object) {
  const raw = body ? JSON.stringify(body) : "";
  const ts = String(Date.now());
  return {
    method: method as any, url, payload: raw || undefined,
    headers: { "content-type": "application/json", "x-operator-key": "key1", "x-timestamp": ts, "x-signature": signRequest("secret1", ts, method, url, raw) },
  };
}

before(async () => {
  await resetDb();
  app = await buildServer();
});
after(async () => { await app.close(); await pool.end(); });

test("flujo completo: admin crea evento, casino abre sesión, jugador apuesta, admin resuelve", async () => {
  const ev = await app.inject({ method: "POST", url: "/admin/events", headers: admin, payload: {
    title: "¿Ganará Ecuador el partido de prueba?", category: "deportes", kind: "binary", closeTime: futureIso(),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Victoria en tiempo reglamentario.", resolutionSource: "FIFA",
  } });
  assert.equal(ev.statusCode, 200, ev.body);
  const event = ev.json();
  const marketId = event.markets[0].id;

  // Firma inválida
  const badSig = signed("POST", "/operator/v1/sessions", { playerId: "u-1" });
  badSig.headers["x-signature"] = "00";
  assert.equal((await app.inject(badSig)).statusCode, 401);

  // Sesión válida
  casino.balances.set("u-1", 50e6);
  casino.balances.set("u-2", 50e6);
  const s1 = (await app.inject(signed("POST", "/operator/v1/sessions", { playerId: "u-1", displayName: "Carlos Mendoza" }))).json();
  const s2 = (await app.inject(signed("POST", "/operator/v1/sessions", { playerId: "u-2", displayName: "Andrea" }))).json();
  assert.match(s1.launchUrl, /\/embed\/\?token=/);
  const auth1 = { authorization: `Bearer ${s1.token}` }, auth2 = { authorization: `Bearer ${s2.token}` };

  const me = (await app.inject({ method: "GET", url: "/v1/me", headers: auth1 })).json();
  assert.equal(me.balance, 50e6);

  const o1 = await app.inject({ method: "POST", url: "/v1/orders", headers: auth1, payload: { marketId, side: "BUY", outcome: "YES", type: "LIMIT", price: 45, shares: 20 } });
  assert.equal(o1.statusCode, 201, o1.body);
  const o2 = await app.inject({ method: "POST", url: "/v1/orders", headers: auth2, payload: { marketId, side: "BUY", outcome: "NO", type: "MARKET", amount: 5.61 } });
  assert.equal(o2.statusCode, 201, o2.body);
  assert.equal(o2.json().filledShares, 10); // 5,50 en acciones a 0,55 + 2% de comisión

  const book = (await app.inject({ method: "GET", url: `/v1/markets/${marketId}/book` })).json();
  assert.deepEqual(book.yes.bids, [{ price: 45, shares: 10 }]);
  assert.deepEqual(book.no.asks, [{ price: 55, shares: 10 }]);

  const list = (await app.inject({ method: "GET", url: "/v1/events?category=deportes" })).json();
  assert.equal(list[0].markets[0].lastPrice, 45);
  assert.equal(list[0].traders, 2);

  const hist = (await app.inject({ method: "GET", url: `/v1/markets/${marketId}/prices-history?interval=1d` })).json();
  assert.ok(hist.length >= 2);

  const activity = (await app.inject({ method: "GET", url: "/v1/activity" })).json();
  assert.equal(activity[0].player, "Andrea");

  const pos = (await app.inject({ method: "GET", url: "/v1/positions", headers: auth1 })).json();
  assert.equal(pos[0].shares, 10);

  const stats = (await app.inject({ method: "GET", url: "/v1/stats" })).json();
  assert.equal(stats.open_events, 1);
  assert.equal(stats.players_online, 2);

  // Resolver a favor del SÍ
  const res = (await app.inject({ method: "POST", url: `/admin/events/${event.id}/resolve`, headers: admin, payload: { outcome: "YES", explanation: "Ganó 2-0" } })).json();
  const fin = await app.inject({ method: "POST", url: `/admin/resolutions/${res.id}/finalize`, headers: admin, payload: {} });
  assert.equal(fin.statusCode, 200, fin.body);
  // u-1 pagó 4,50 por 10 acciones llenas + 4,50 reservados que se devolvieron al cancelarse; cobra $10
  assert.equal(bal("u-1"), 50 - 4.5 + 10);

  const report = (await app.inject(signed("GET", "/operator/v1/reports/summary"))).json();
  assert.equal(report.players, 2);
  assert.ok(report.fees > 0);
});

test("admin: crear operador devuelve credenciales y la clave admin es obligatoria", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/admin/sources" })).statusCode, 401);
  const r = (await app.inject({ method: "POST", url: "/admin/operators", headers: admin, payload: { id: "casino-nuevo", name: "Casino Nuevo", walletUrl: "https://casino.test/wallet" } })).json();
  assert.match(r.apiKey, /^pk_/);
  assert.match(r.apiSecret, /^sk_/);
});

test("señales sociales en lote desde el agente de navegador", async () => {
  const r = await app.inject({ method: "POST", url: "/admin/social-signals", headers: admin, payload: [
    { platform: "instagram", text: "Publicación viral de Karol G anunciando concierto en Quito", metrics: { likes: 1200000 }, capturedBy: "agente-chrome" },
    { platform: "tiktok", text: "Tendencia #MissUniverso2027 con 30M de vistas", url: "https://www.tiktok.com/tag/missuniverso2027" },
  ] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().inserted, 2);
});
