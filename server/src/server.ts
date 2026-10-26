import Fastify from "fastify";
import { readFileSync, existsSync } from "node:fs";
import { ZodError } from "zod";
import { AppError } from "./lib/errors.js";
import { v1Routes } from "./api/v1.js";
import { operatorRoutes } from "./api/operator.js";
import { adminRoutes } from "./api/admin.js";
import { mmRoutes } from "./api/mm.js";

export async function buildServer() {
  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info" } });

  // Guardamos el cuerpo crudo: la firma HMAC del casino se calcula sobre el texto exacto.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { done(new AppError(400, "invalid_json", "JSON inválido"), undefined); }
  });

  // CORS abierto para la API pública y del jugador (el casino puede llamarla desde su propio front).
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", "*");
    // x-admin-key/x-admin-user permiten alojar el panel de administración en otro dominio (por ejemplo el back-office)
    reply.header("access-control-allow-headers", "authorization, content-type, x-admin-key, x-admin-user");
    reply.header("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return reply.code(204).send();
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid_request", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const status = (err as any).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as any).code ?? "bad_request", message: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: "internal_error", message: "Error interno" });
  });

  app.get("/health", async () => ({ ok: true }));

  // Módulo embebible (iframe del casino)
  const embed = new URL("../../web/embed/index.html", import.meta.url);
  app.get("/embed", (_req, reply) => reply.redirect("/embed/"));
  app.get("/embed/", async (_req, reply) => {
    if (!existsSync(embed)) return reply.code(404).send("Frontend no encontrado");
    reply.header("content-type", "text/html; charset=utf-8");
    // Permitir que cualquier casino lo embeba en un iframe; restrínge con frame-ancestors en producción.
    reply.header("content-security-policy", "frame-ancestors *");
    return readFileSync(embed, "utf8");
  });

  // Panel de administración (también se puede alojar aparte, por ejemplo en el dominio del back-office)
  const adminPage = new URL("../../web/admin/index.html", import.meta.url);
  app.get("/admin", (_req, reply) => reply.redirect("/admin/"));
  app.get("/admin/", async (_req, reply) => {
    if (!existsSync(adminPage)) return reply.code(404).send("Panel no encontrado");
    reply.header("content-type", "text/html; charset=utf-8");
    return readFileSync(adminPage, "utf8");
  });

  await app.register(v1Routes);
  await app.register(operatorRoutes);
  await app.register(adminRoutes);
  await app.register(mmRoutes);
  return app;
}
