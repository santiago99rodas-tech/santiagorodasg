import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, bal, casino, futureIso } from "./helpers.js";
import { buildServer } from "../src/server.js";
import { signRequest } from "../src/lib/crypto.js";
import { config } from "../src/config.js";
import { verifySignature, resetOracleKeyCache, resetTrackRecordCache } from "../src/services/oracle.js";
import { finalizeDue } from "../src/services/resolution.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
const admin = { "x-admin-key": config.adminApiKey, "x-admin-user": "tester" };
const auth: Record<string, { authorization: string }> = {};

function op(method: string, url: string, body?: object) {
  const raw = body ? JSON.stringify(body) : "";
  const ts = String(Date.now());
  return { method: method as any, url, payload: raw || undefined,
    headers: { "content-type": "application/json", "x-operator-key": "key1", "x-timestamp": ts, "x-signature": signRequest("secret1", ts, method, url, raw) } };
}
async function event(title: string) {
  const r = await app.inject({ method: "POST", url: "/admin/events", headers: admin, payload: {
    title, category: "deportes", kind: "binary", closeTime: futureIso(5),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Resultado oficial publicado por la federación.", resolutionSource: "Federación" } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const bondsOf = async (rid: number) => (await pool.query("SELECT role, player_id, amount, status, payout FROM resolution_bonds WHERE resolution_id=$1 ORDER BY id", [rid])).rows;

before(async () => {
  await resetDb();
  resetOracleKeyCache();
  resetTrackRecordCache();
  config.challengeWindowMinutes = 60;
  app = await buildServer();
  for (const id of ["ana", "beto"]) {
    casino.balances.set(id, 100e6);
    const s = (await app.inject(op("POST", "/operator/v1/sessions", { playerId: id, displayName: id }))).json();
    auth[id] = { authorization: `Bearer ${s.token}` };
  }
});
after(async () => { config.challengeWindowMinutes = 0; await app.close(); await pool.end(); });

test("oráculo: probabilidades firmadas con Ed25519 que un tercero puede verificar", async () => {
  await event("¿Ganará Ecuador el amistoso del oráculo?");
  const r = await app.inject({ method: "GET", url: "/v1/oracle/markets" });
  assert.equal(r.statusCode, 200);
  const keys = (await app.inject({ method: "GET", url: "/v1/oracle/keys" })).json();
  const sig = r.headers["x-oracle-signature"] as string;
  assert.equal(r.headers["x-oracle-key-id"], keys.keys[0].kid);
  assert.ok(verifySignature(r.body, sig, keys.keys[0].publicKeyPem), "firma válida");
  assert.ok(!verifySignature(r.body.replace('"probability":0.5', '"probability":0.9'), sig, keys.keys[0].publicKeyPem), "un dato alterado no verifica");
  const body = JSON.parse(r.body);
  assert.equal(body.keyId, keys.keys[0].kid);
  assert.equal(body.data.markets[0].probability, 0.5);
  assert.equal(body.data.markets[0].confidence, "baja");
  // La misma clave en la siguiente respuesta (persistida en la base)
  resetOracleKeyCache();
  const again = await app.inject({ method: "GET", url: "/v1/oracle" });
  assert.equal(again.headers["x-oracle-key-id"], keys.keys[0].kid);
});

test("disputa con razón: el jugador recupera su fianza y cobra parte de la fianza de la casa", async () => {
  const ev = await event("¿Clasificará Ecuador a la final de prueba?");
  const p = await app.inject({ method: "POST", url: `/admin/events/${ev.id}/resolve`, headers: admin, payload: { outcome: "YES", explanation: "Según la prensa." } });
  assert.equal(p.statusCode, 200, p.body);
  const rid = p.json().id;
  assert.deepEqual((await bondsOf(rid)).map((b) => [b.role, b.player_id, Number(b.amount), b.status]), [["proposer", null, 100e6, "held"]]);

  const short = await app.inject({ method: "POST", url: `/v1/resolutions/${rid}/dispute`, headers: auth.ana, payload: { reason: "no" } });
  assert.equal(short.statusCode, 400);
  const d = await app.inject({ method: "POST", url: `/v1/resolutions/${rid}/dispute`, headers: auth.ana, payload: {
    reason: "El partido terminó 0-1, Ecuador quedó eliminado.", evidence: [{ url: "https://example.com/acta", title: "Acta oficial" }] } });
  assert.equal(d.statusCode, 201, d.body);
  assert.equal(bal("ana"), 90);
  const again = await app.inject({ method: "POST", url: `/v1/resolutions/${rid}/dispute`, headers: auth.beto, payload: { reason: "Yo también creo que está mal." } });
  assert.equal(again.statusCode, 409, "una sola disputa por propuesta");

  const dec = await app.inject({ method: "POST", url: `/admin/resolutions/${rid}/decide`, headers: admin, payload: { outcome: "NO", note: "Acta oficial: 0-1." } });
  assert.equal(dec.statusCode, 200, dec.body);
  assert.equal(bal("ana"), 150); // 90 + 10 de fianza + 50 (la mitad de la fianza de $100 de la casa)
  const bonds = await bondsOf(rid);
  assert.deepEqual(bonds.map((b) => [b.role, b.status, Number(b.payout)]), [["proposer", "forfeited", 0], ["disputer", "rewarded", 60e6]]);
  const st = (await pool.query("SELECT status, dispute_result FROM resolutions WHERE id=$1", [rid])).rows[0];
  assert.deepEqual(st, { status: "rejected", dispute_result: "dispute_upheld" });
  const m = (await pool.query("SELECT resolved_outcome FROM markets WHERE event_id=$1", [ev.id])).rows[0];
  assert.equal(m.resolved_outcome, "NO");
});

test("disputa sin razón: el jugador pierde su fianza y la casa recupera la suya", async () => {
  const ev = await event("¿Anotará Ecuador en el partido de prueba?");
  const rid = (await app.inject({ method: "POST", url: `/admin/events/${ev.id}/resolve`, headers: admin, payload: { outcome: "YES" } })).json().id;
  await app.inject({ method: "POST", url: `/v1/resolutions/${rid}/dispute`, headers: auth.beto, payload: { reason: "Creo que el gol fue anulado por fuera de juego." } });
  assert.equal(bal("beto"), 90);
  const dec = await app.inject({ method: "POST", url: `/admin/resolutions/${rid}/decide`, headers: admin, payload: { outcome: "YES" } });
  assert.equal(dec.statusCode, 200, dec.body);
  assert.equal(bal("beto"), 90);
  assert.deepEqual((await bondsOf(rid)).map((b) => [b.role, b.status, Number(b.payout)]), [["proposer", "rewarded", 105e6], ["disputer", "forfeited", 0]]);
});

test("un jugador propone el resultado de un evento cerrado que nadie resolvió", async () => {
  const ev = await event("¿Habrá tiempo extra en la final de prueba?");
  // El evento cerró hace una hora
  await pool.query("UPDATE events SET close_time = now() - interval '1 hour', status='closed' WHERE id=$1", [ev.id]);
  await pool.query("UPDATE markets SET close_time = now() - interval '1 hour', status='closed' WHERE event_id=$1", [ev.id]);
  const payload = { outcome: "NO", explanation: "Terminó 2-0 en los 90 minutos.", evidence: [{ url: "https://example.com/final" }] };
  const early = await app.inject({ method: "POST", url: `/v1/events/${ev.id}/propose`, headers: auth.ana, payload });
  assert.equal(early.statusCode, 409, "antes de 2 h no");
  await pool.query("UPDATE events SET close_time = now() - interval '3 hours' WHERE id=$1", [ev.id]);
  const ok = await app.inject({ method: "POST", url: `/v1/events/${ev.id}/propose`, headers: auth.ana, payload });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(bal("ana"), 140);
  // Nadie disputa: termina la ventana, se finaliza y se le devuelve la fianza
  await pool.query("UPDATE resolutions SET challenge_ends_at = now() - interval '1 minute' WHERE id=$1", [ok.json().resolutionId]);
  await finalizeDue();
  assert.equal(bal("ana"), 150);
  assert.equal((await bondsOf(ok.json().resolutionId))[0].status, "returned");
});

test("historial público: disputas, fianzas y detalle de la resolución", async () => {
  resetTrackRecordCache();
  const tr = JSON.parse((await app.inject({ method: "GET", url: "/v1/oracle/track-record" })).body).data;
  assert.equal(tr.resolutions.disputed, 2);
  assert.equal(tr.resolutions.disputesUpheld, 1);
  assert.equal(tr.resolutions.proposalsUpheld, 1);
  assert.equal(tr.resolutions.proposedByPlayers, 1);
  assert.equal(tr.resolutions.bonds.paidToDisputersUsd, 50);
  assert.equal(tr.horizons.length, 2);
  const mid = (await pool.query("SELECT m.id FROM markets m JOIN events e ON e.id=m.event_id WHERE e.title LIKE '%final de prueba?%' AND e.title LIKE '%Clasificará%'")).rows[0].id;
  const md = JSON.parse((await app.inject({ method: "GET", url: `/v1/oracle/markets/${mid}` })).body).data;
  assert.equal(md.probability, 0);
  assert.equal(md.resolutions.length, 2);
  assert.equal(md.resolutions[0].dispute.result, "dispute_upheld");
  assert.equal(md.resolutions[0].bonds[1].payoutUsd, 60);
});
