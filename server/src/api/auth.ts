import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { pool, one } from "../db/pool.js";
import { config } from "../config.js";
import { AppError, bad } from "../lib/errors.js";
import { signRequest, safeEqual, signToken, verifyToken } from "../lib/crypto.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
    operator?: { id: string; name: string; currency: string; theme: any };
    player?: { id: number; operatorId: string; externalId: string; displayName: string | null };
    mm?: { playerId: number; name: string };
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw bad("invalid_request", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

/** Casino -> plataforma: X-Operator-Key + X-Timestamp + X-Signature (HMAC-SHA256 del método, ruta y cuerpo). */
export async function requireOperator(req: FastifyRequest) {
  const key = req.headers["x-operator-key"] as string | undefined;
  const ts = req.headers["x-timestamp"] as string | undefined;
  const sig = req.headers["x-signature"] as string | undefined;
  if (!key || !ts || !sig) throw new AppError(401, "unauthorized", "Faltan X-Operator-Key, X-Timestamp o X-Signature");
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) throw new AppError(401, "stale_request", "X-Timestamp fuera de la ventana de 5 minutos");
  const op = await one(pool, "SELECT id, name, api_secret, currency, theme, active FROM operators WHERE api_key=$1", [key]);
  if (!op || !op.active) throw new AppError(401, "unauthorized", "Operador desconocido o inactivo");
  const path = req.url;
  const expected = signRequest(op.api_secret, ts, req.method, path, req.rawBody ?? "");
  if (!safeEqual(sig, expected)) throw new AppError(401, "bad_signature", "Firma inválida");
  req.operator = { id: op.id, name: op.name, currency: op.currency, theme: op.theme };
}

/** Market maker externo -> plataforma: X-MM-Key + X-Timestamp + X-Signature (mismo esquema HMAC que los casinos). */
export async function requireMarketMaker(req: FastifyRequest) {
  const key = req.headers["x-mm-key"] as string | undefined;
  const ts = req.headers["x-timestamp"] as string | undefined;
  const sig = req.headers["x-signature"] as string | undefined;
  if (!key || !ts || !sig) throw new AppError(401, "unauthorized", "Faltan X-MM-Key, X-Timestamp o X-Signature");
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) throw new AppError(401, "stale_request", "X-Timestamp fuera de la ventana de 5 minutos");
  const mm = await one(pool, "SELECT player_id, name, api_secret, active FROM mm_accounts WHERE api_key=$1", [key]);
  if (!mm) throw new AppError(401, "unauthorized", "Market maker desconocido");
  if (!safeEqual(sig, signRequest(mm.api_secret, ts, req.method, req.url, req.rawBody ?? ""))) throw new AppError(401, "bad_signature", "Firma inválida");
  if (!mm.active) throw new AppError(403, "mm_suspended", "La cuenta de market maker está suspendida");
  req.mm = { playerId: Number(mm.player_id), name: mm.name };
}

interface SessionClaims { pid: number; op: string; ext: string; name: string | null; exp: number }

export function issueSession(p: { id: number; operator_id: string; external_id: string; display_name: string | null }) {
  const exp = Date.now() + config.sessionTtlMinutes * 60_000;
  return { token: signToken(config.sessionSecret, { pid: p.id, op: p.operator_id, ext: p.external_id, name: p.display_name, exp } satisfies SessionClaims), expiresAt: new Date(exp).toISOString() };
}

/** Jugador -> plataforma: Authorization: Bearer <token de sesión emitido por /operator/v1/sessions>. */
export async function requirePlayer(req: FastifyRequest) {
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : (req.query as any)?.token;
  const claims = token ? verifyToken<SessionClaims>(config.sessionSecret, token) : null;
  if (!claims) throw new AppError(401, "unauthorized", "Sesión inválida");
  if (claims.exp < Date.now()) throw new AppError(401, "session_expired", "La sesión expiró, vuelve a abrir el módulo desde el casino");
  req.player = { id: claims.pid, operatorId: claims.op, externalId: claims.ext, displayName: claims.name };
  pool.query("UPDATE players SET last_seen_at=now() WHERE id=$1", [claims.pid]).catch(() => undefined);
}

export async function requireAdmin(req: FastifyRequest) {
  const key = req.headers["x-admin-key"] as string | undefined;
  if (!key || !safeEqual(key, config.adminApiKey)) throw new AppError(401, "unauthorized", "X-Admin-Key inválida");
}
export const adminUser = (req: FastifyRequest) => `admin:${(req.headers["x-admin-user"] as string) || "sin-nombre"}`;
