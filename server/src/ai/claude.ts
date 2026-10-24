import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

let client: Anthropic | null = null;

export function aiEnabled() {
  return Boolean(config.anthropicApiKey);
}

export function claude(): Anthropic {
  if (!aiEnabled()) throw new Error("IA desactivada: configura ANTHROPIC_API_KEY");
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

/** Para pruebas: inyecta un cliente falso. */
export function setClaudeClient(c: Anthropic | null) {
  client = c;
}

// Si los filtros de seguridad rechazan una solicitud, la API la reintenta en el modelo de respaldo recomendado.
export const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
