import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { normalizeOracleKey, oracleKeyProblem } from "../src/config.js";

const { privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const b64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const pub = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
const same = (p: string) => createPublicKey(createPrivateKey(p)).export({ type: "spki", format: "pem" }) === pub;

test("clave del oráculo: acepta las formas en que suele pegarse", () => {
  for (const raw of [pem, pem.trim().replace(/\n/g, "\\n"), pem.replace(/\n/g, " "), b64, ` "${b64}" `, `-----BEGIN PRIVATE KEY-----${b64}-----END PRIVATE KEY-----`]) {
    const out = normalizeOracleKey(raw);
    assert.equal(oracleKeyProblem(out, raw.length), null, raw);
    assert.ok(same(out), raw);
  }
  assert.equal(b64.length, 64);
  assert.equal(normalizeOracleKey(""), "");
  assert.equal(oracleKeyProblem("", 0), null);
});

test("clave del oráculo cortada: lo dice con palabras simples", () => {
  const cut = pem.trim().replace(/\n/g, "\\n").slice(0, 65);
  const msg = oracleKeyProblem(normalizeOracleKey(cut), cut.length);
  assert.match(msg!, /65 caracteres/);
  assert.match(msg!, /gen:secrets/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.match(oracleKeyProblem(normalizeOracleKey(rsa), rsa.length)!, /no Ed25519/);
});
