import { signRequest } from "../src/lib/crypto.js";

export const PLATFORM = process.env.PLATFORM_URL ?? "http://localhost:8080";
const API_KEY = process.env.OPERATOR_API_KEY ?? "demo-api-key";
const API_SECRET = process.env.OPERATOR_API_SECRET ?? "demo-api-secret";

/** Llama a la API de operador de la plataforma, firmando la petición con HMAC. */
export async function platform(method: string, path: string, body?: object) {
  const raw = body ? JSON.stringify(body) : "";
  const ts = String(Date.now());
  const r = await fetch(PLATFORM + path, {
    method, body: raw || undefined,
    headers: { "content-type": "application/json", "x-operator-key": API_KEY, "x-timestamp": ts, "x-signature": signRequest(API_SECRET, ts, method, path, raw) },
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
