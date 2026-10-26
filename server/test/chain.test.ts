import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, casino, futureIso } from "./helpers.js";
import { buildServer } from "../src/server.js";
import { signRequest } from "../src/lib/crypto.js";
import { config } from "../src/config.js";
import { otsFile, setAnchorTransport, setRpcTransport, anchorJournal, syncUsdc } from "../src/services/chain.js";
import { ingestChainTransfers, verifyJournal } from "../src/services/treasury.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
const admin = { "x-admin-key": config.adminApiKey, "x-admin-user": "tesorero" };
const VAULT = "0x" + "a".repeat(40), C1 = "0x" + "1".repeat(40), C2 = "0x" + "2".repeat(40), STRANGER = "0x" + "9".repeat(40);
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
const MAGIC = "004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294";
const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: admin, payload });
const opReq = (url: string, key: string, secret: string, body?: object) => {
  const raw = body ? JSON.stringify(body) : "", ts = String(Date.now()), method = body ? "POST" : "GET";
  return { method: method as any, url, payload: raw || undefined, headers: { "content-type": "application/json", "x-operator-key": key, "x-timestamp": ts, "x-signature": signRequest(secret, ts, method, url, raw) } };
};

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
    tok[id] = (await app.inject(opReq("/operator/v1/sessions", key, secret, { playerId: id, displayName: id }))).json().token;
  }
  const ev = (await post("/admin/events", { title: "¿Ganará Ecuador el partido de la bóveda?", category: "deportes", kind: "binary", closeTime: futureIso(5),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Resultado oficial publicado por la federación.", resolutionSource: "Federación" })).json();
  const marketId = ev.markets[0].id;
  await app.inject({ method: "POST", url: "/v1/orders", headers: { authorization: `Bearer ${tok.ana}` }, payload: { marketId, side: "BUY", outcome: "YES", type: "LIMIT", price: 40, shares: 100 } });
  await app.inject({ method: "POST", url: "/v1/orders", headers: { authorization: `Bearer ${tok.beto}` }, payload: { marketId, side: "BUY", outcome: "NO", type: "MARKET", amount: 61.2 } });
  const r = (await post(`/admin/events/${ev.id}/resolve`, { outcome: "YES" })).json();
  await post(`/admin/resolutions/${r.id}/finalize`, { force: true });
});
after(async () => { setAnchorTransport(null); setRpcTransport(null); await app.close(); await pool.end(); });

test("archivo .ots: cabecera estándar de OpenTimestamps, SHA-256 y la huella", () => {
  const f = otsFile("ab".repeat(32), Buffer.from([0xf0, 0x10]));
  assert.equal(f.subarray(0, 31).toString("hex"), MAGIC);
  assert.equal(f[31], 0x01); // versión
  assert.equal(f[32], 0x08); // SHA-256
  assert.equal(f.subarray(33, 65).toString("hex"), "ab".repeat(32));
  assert.deepEqual([...f.subarray(65)], [0xf0, 0x10]);
});

test("vía USDC: los casinos pagan y cobran en la cadena y se concilia solo", async () => {
  for (const [id, addr] of [["casino1", C1], ["casino2", C2]]) {
    const r = await app.inject({ method: "PATCH", url: `/admin/treasury/casinos/${id}`, headers: admin, payload: { rail: "usdc", usdcAddress: addr.toUpperCase().replace("0X", "0x") } });
    assert.equal(r.statusCode, 200, r.body);
  }
  const created = (await post("/admin/treasury/settle")).json().created;
  const liq = Object.fromEntries(created.map((s: any) => [s.operatorId, s]));
  assert.equal(liq.casino2.amount, 60.6e6);
  // El estado de cuenta trae las instrucciones de pago en USDC
  const st = JSON.parse((await app.inject(opReq(`/operator/v1/treasury/statements/${liq.casino2.id}`, "key2", "secret2"))).body).data;
  assert.equal(st.payment.rail, "usdc");
  assert.equal(st.payment.amountUsdc, "60.600000");

  // Nodo simulado: entra 60,6 USDC del casino 2, salen 60 USDC al casino 1, y entran 25 de una dirección desconocida
  Object.assign(config.usdc, { rpcUrl: "http://nodo.test", vault: VAULT, token: "0x" + "c".repeat(40), confirmations: 0, startBlock: 1 });
  const log = (from: string, to: string, value: number, i: number) => ({ transactionHash: "0x" + String(i).repeat(64), logIndex: "0x0", blockNumber: "0x10",
    topics: [TOPIC, pad(from), pad(to)], data: "0x" + value.toString(16) });
  let balance = 25.6e6;
  setRpcTransport(async (method, params: any[]) => {
    if (method === "eth_blockNumber") return "0x20";
    if (method === "eth_getBlockByNumber") return { timestamp: "0x" + Math.floor(Date.UTC(2026, 9, 27) / 1000).toString(16) };
    if (method === "eth_call") return "0x" + balance.toString(16);
    if (method === "eth_getLogs") {
      const [, from, to] = params[0].topics;
      if (to === pad(VAULT)) return [log(C2, VAULT, 60.6e6, 1), log(STRANGER, VAULT, 25e6, 3)];
      if (from === pad(VAULT)) return [log(VAULT, C1, 60e6, 2)];
    }
    throw new Error("rpc inesperado " + method);
  });
  const sync = await post("/admin/treasury/usdc/sync");
  assert.equal(sync.statusCode, 200, sync.body);
  assert.deepEqual({ t: sync.json().transfers, m: sync.json().matched }, { t: 3, m: 2 });
  const ov = (await app.inject({ method: "GET", url: "/admin/treasury", headers: admin })).json();
  for (const id of ["casino1", "casino2"]) {
    const s = ov.settlements.find((x: any) => x.operator_id === id);
    assert.equal(s.status, "paid");
    assert.match(s.bank_ref, /^0x(1|2)+$/);
  }
  // Lo de la dirección desconocida queda sin conciliar; el tesorero lo registra como garantía del casino 2
  const line = ov.unmatchedBankLines.find((l: any) => l.account === "usdc");
  assert.equal(Number(line.amount), 25e6);
  assert.equal((await post(`/admin/treasury/bank-lines/${line.id}/guarantee`, { operatorId: "casino2" })).statusCode, 200);
  // Libro: la bóveda tiene 60,6 − 60 + 25 = 25,6, igual que la cadena
  const r = (await app.inject({ method: "GET", url: "/admin/treasury/reserves", headers: admin })).json();
  assert.equal(r.usdc.book, 25.6e6);
  assert.equal(r.usdc.onChain, 25.6e6);
  assert.equal(r.usdc.difference, 0);
  balance = 20e6; // si alguien saca plata de la bóveda por fuera, aparece la diferencia
  assert.equal((await app.inject({ method: "GET", url: "/admin/treasury/reserves", headers: admin })).json().usdc.difference, -5.6e6);
  // Sincronizar de nuevo no duplica nada
  assert.equal((await syncUsdc(ingestChainTransfers) as any).transfers, 0);
  // Con garantía depositada no se puede cambiar de vía
  const ch = await app.inject({ method: "PATCH", url: "/admin/treasury/casinos/casino2", headers: admin, payload: { rail: "bank" } });
  assert.equal(ch.statusCode, 409);
  assert.ok((await verifyJournal()).ok);
});

test("anclaje en Bitcoin: sella la huella del libro y cualquiera descarga el .ots", async () => {
  const calls: string[] = [];
  setAnchorTransport(async (cal, digest) => {
    calls.push(cal);
    if (cal.includes("b.pool")) throw new Error("calendario caído");
    return Buffer.concat([Buffer.from([0xf1, 0x04]), digest.subarray(0, 4)]);
  });
  const a = await anchorJournal();
  assert.ok(a.anchored);
  assert.equal(calls.length, 2);
  const head = (await pool.query("SELECT id, hash FROM journal ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(a.hash, head.hash);
  // Sin asientos nuevos no vuelve a anclar
  assert.equal((await anchorJournal()).anchored, false);
  // Público y firmado: lista de sellos y el archivo .ots
  const list = JSON.parse((await app.inject({ method: "GET", url: "/v1/oracle/anchors" })).body).data.anchors;
  assert.equal(list.length, 1);
  assert.equal(list[0].hash, head.hash);
  const ots = await app.inject({ method: "GET", url: list[0].ots });
  assert.equal(ots.statusCode, 200);
  const buf = ots.rawPayload;
  assert.equal(buf.subarray(0, 31).toString("hex"), MAGIC);
  assert.equal(buf.subarray(33, 65).toString("hex"), head.hash);
  const errs = (await pool.query("SELECT COUNT(*)::int n FROM anchors WHERE status='error'")).rows[0].n;
  assert.equal(errs, 1); // el calendario caído queda registrado
});
