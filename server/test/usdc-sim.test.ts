import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, casino, futureIso } from "./helpers.js";
import { buildServer } from "../src/server.js";
import { signRequest } from "../src/lib/crypto.js";
import { config } from "../src/config.js";
import { usdcInfo, usdcToken } from "../src/services/chain.js";
import { verifyJournal } from "../src/services/treasury.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
const admin = { "x-admin-key": config.adminApiKey, "x-admin-user": "tesorero" };
const C1 = "0x" + "1".repeat(40), C2 = "0x" + "2".repeat(40), STRANGER = "0x" + "9".repeat(40);
const saved = { ...config.usdc };
const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: admin, payload });
const opReq = (url: string, key: string, secret: string, body?: object) => {
  const raw = body ? JSON.stringify(body) : "", ts = String(Date.now()), method = body ? "POST" : "GET";
  return { method: method as any, url, payload: raw || undefined, headers: { "content-type": "application/json", "x-operator-key": key, "x-timestamp": ts, "x-signature": signRequest(secret, ts, method, url, raw) } };
};

before(async () => {
  await resetDb();
  Object.assign(config.usdc, { chain: "simulado", rpcUrl: "", vault: "", token: "" });
  config.mm.enabled = false;
  config.integrity.maxStakePerMarketUsd = 0;
  app = await buildServer();
  await pool.query("INSERT INTO operators (id, name, api_key, api_secret, wallet_url, wallet_secret, revenue_share_bps) VALUES ('casino2','Casino Dos','key2','secret2','http://wallet2.test','wsecret2',5000)");
  await pool.query("UPDATE operators SET created_at = now() - interval '1 day'");
  const tok: Record<string, string> = {};
  for (const [id, key, secret] of [["ana", "key1", "secret1"], ["beto", "key2", "secret2"]]) {
    casino.balances.set(id, 1000e6);
    tok[id] = (await app.inject(opReq("/operator/v1/sessions", key, secret, { playerId: id, displayName: id }))).json().token;
  }
  const ev = (await post("/admin/events", { title: "¿Ganará Ecuador el partido simulado?", category: "deportes", kind: "binary", closeTime: futureIso(5),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Resultado oficial publicado por la federación.", resolutionSource: "Federación" })).json();
  const marketId = ev.markets[0].id;
  await app.inject({ method: "POST", url: "/v1/orders", headers: { authorization: `Bearer ${tok.ana}` }, payload: { marketId, side: "BUY", outcome: "YES", type: "LIMIT", price: 40, shares: 100 } });
  await app.inject({ method: "POST", url: "/v1/orders", headers: { authorization: `Bearer ${tok.beto}` }, payload: { marketId, side: "BUY", outcome: "NO", type: "MARKET", amount: 61.2 } });
  const r = (await post(`/admin/events/${ev.id}/resolve`, { outcome: "YES" })).json();
  await post(`/admin/resolutions/${r.id}/finalize`, { force: true });
});
after(async () => { Object.assign(config.usdc, saved); await app.close(); await pool.end(); });

test("redes de prueba: USDC de Circle por red y etiqueta sin valor", () => {
  Object.assign(config.usdc, { chain: "base-sepolia" });
  assert.equal(usdcToken(), "0x036cbd53842c5426634e7929541ec2318f3dcf7e");
  Object.assign(config.usdc, { rpcUrl: "https://sepolia.base.org", vault: "0x" + "a".repeat(40) });
  const i = usdcInfo();
  assert.equal(i.testnet, true); assert.equal(i.realMoney, false); assert.match(i.label!, /prueba/);
  Object.assign(config.usdc, { chain: "base" });
  assert.equal(usdcInfo().realMoney, true);
  Object.assign(config.usdc, { chain: "simulado", rpcUrl: "", vault: "" });
});

test("modo simulado: pagos, cobros, garantía y reservas sin cadena", async () => {
  const info = (await app.inject({ method: "GET", url: "/admin/treasury", headers: admin })).json().usdc;
  assert.equal(info.enabled, true); assert.equal(info.simulated, true); assert.equal(info.realMoney, false);

  for (const [id, addr] of [["casino1", C1], ["casino2", C2]]) {
    const r = await app.inject({ method: "PATCH", url: `/admin/treasury/casinos/${id}`, headers: admin, payload: { rail: "usdc", usdcAddress: addr } });
    assert.equal(r.statusCode, 200, r.body);
  }
  const created = (await post("/admin/treasury/settle")).json().created;
  assert.ok(created.length >= 1);
  const debtor = created.find((s: any) => s.amount > 0), creditor = created.find((s: any) => s.amount < 0);
  assert.ok(debtor && creditor, JSON.stringify(created));
  const addrOf = (op: string) => (op === "casino1" ? C1 : C2);

  // sin saldo, la bóveda simulada no puede pagar
  assert.equal((await post("/admin/treasury/usdc/simulate", { direction: "out", address: addrOf(creditor.operatorId), amountUsd: 1 })).json().error, "insufficient_vault");

  // el casino deudor paga: entra a la bóveda y se concilia la liquidación
  let r = (await post("/admin/treasury/usdc/simulate", { direction: "in", address: addrOf(debtor.operatorId), amountUsd: debtor.amount / 1e6 })).json();
  assert.equal(r.simulated, true); assert.equal(r.matched, 1); assert.equal(r.vaultBalance, debtor.amount);

  // pagamos al casino acreedor
  r = (await post("/admin/treasury/usdc/simulate", { direction: "out", address: addrOf(creditor.operatorId), amountUsd: -creditor.amount / 1e6 })).json();
  assert.equal(r.matched, 1);

  // un depósito sin liquidación queda sin conciliar y se registra como garantía
  r = (await post("/admin/treasury/usdc/simulate", { direction: "in", address: C1, amountUsd: 500 })).json();
  assert.equal(r.matched, 0);
  const t = (await app.inject({ method: "GET", url: "/admin/treasury", headers: admin })).json();
  const line = t.unmatchedBankLines.find((b: any) => b.account === "usdc" && Number(b.amount) === 500e6);
  assert.ok(line);
  assert.equal((await post(`/admin/treasury/bank-lines/${line.id}/guarantee`, { operatorId: "casino1" })).statusCode, 200);

  // un extraño no concilia nada
  assert.equal((await post("/admin/treasury/usdc/simulate", { direction: "in", address: STRANGER, amountUsd: 3 })).json().matched, 0);

  const t2 = (await app.inject({ method: "GET", url: "/admin/treasury", headers: admin })).json();
  assert.ok(t2.settlements.filter((s: any) => [debtor.id, creditor.id].includes(s.id)).every((s: any) => s.status === "paid"));
  const u = t2.reserves.usdc;
  // libro vs bóveda: solo difiere en los $3 del extraño (no se registró en el libro)
  assert.equal(u.onChain - u.book, 3e6);
  assert.equal((await verifyJournal()).ok, true);
});

test("fuera del modo simulado no se pueden simular transferencias", async () => {
  Object.assign(config.usdc, { chain: "polygon" });
  const r = await post("/admin/treasury/usdc/simulate", { direction: "in", address: C1, amountUsd: 1 });
  Object.assign(config.usdc, { chain: "simulado" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, "not_simulated");
});
