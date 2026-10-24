import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const randomToken = (bytes = 24) => randomBytes(bytes).toString("base64url");

/** Firma HMAC-SHA256 en hex de: timestamp + "\n" + método + "\n" + ruta + "\n" + cuerpo. */
export function signRequest(secret: string, ts: string, method: string, path: string, body: string) {
  return createHmac("sha256", secret).update(`${ts}\n${method.toUpperCase()}\n${path}\n${body}`).digest("hex");
}

export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Token de sesión de jugador firmado (sin estado): base64url(payload).firma */
export function signToken(secret: string, payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T>(secret: string, token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return null;
  }
}
