// Resolvedor con IA: investiga en la web el resultado de un evento cerrado y, si está muy seguro,
// lo propone. La propuesta igual pasa por la ventana de disputa, así que un humano puede corregirla.

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { pool, many } from "../db/pool.js";
import { config } from "../config.js";
import { claude, aiEnabled, FALLBACK } from "./claude.js";
import { getEvent } from "../services/events.js";
import { propose } from "../services/resolution.js";

const Decision = z.object({
  decision: z.enum(["YES", "NO", "VOID", "UNKNOWN"]).describe("binario: YES/NO. múltiple: YES si hay ganador (indica winningOutcome). VOID si el evento se canceló según los criterios. UNKNOWN si no hay evidencia suficiente"),
  winningOutcome: z.string().describe("En múltiples, la etiqueta exacta de la opción ganadora; si no aplica, cadena vacía"),
  confidence: z.number().describe("0 a 1"),
  explanation: z.string(),
  evidence: z.array(z.object({ url: z.string(), title: z.string(), quote: z.string() })),
});

const MIN_CONFIDENCE = 0.9;

export async function aiResolve(eventId: number, opts: { autoPropose?: boolean } = {}) {
  if (!aiEnabled()) throw new Error("IA desactivada: configura ANTHROPIC_API_KEY");
  const e = await getEvent(eventId);
  if (!e) throw new Error("Evento no encontrado");
  const options = e.kind === "multi" ? e.markets.map((m: any) => m.outcome_label).join(" | ") : "Sí / No";
  const brief = `Evento: ${e.title}
Opciones: ${options}
Cierre de apuestas: ${new Date(e.close_time).toISOString()}
Criterios de resolución: ${e.resolution_criteria}
Fuente oficial: ${e.resolution_source}
Fecha actual (UTC): ${new Date().toISOString()}`;

  // Paso 1: investigación con búsqueda web
  const messages: Anthropic.Beta.BetaMessageParam[] = [{
    role: "user",
    content: `${brief}\n\nInvestiga en la web si este evento ya tiene resultado según los criterios y la fuente oficial. Prioriza la fuente oficial y medios reconocidos. Resume lo que encontraste, cita las URLs y di claramente si el resultado ya es definitivo.`,
  }];
  let research: Anthropic.Beta.BetaMessage | undefined;
  for (let i = 0; i < 4; i++) {
    research = await claude().beta.messages.create({
      model: config.aiModel,
      max_tokens: 16000,
      ...FALLBACK,
      output_config: { effort: "high" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
      messages,
    });
    if (research.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: research.content });
  }
  if (!research || research.stop_reason === "refusal") return { decision: "UNKNOWN" as const, explanation: "La IA no pudo investigar este evento", proposed: false };
  const findings = research.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");

  // Paso 2: decisión estructurada a partir de la investigación
  const decided = await claude().beta.messages.parse({
    model: config.aiModel,
    max_tokens: 4000,
    ...FALLBACK,
    output_config: { effort: "medium", format: betaZodOutputFormat(Decision) },
    messages: [{ role: "user", content: `${brief}\n\nInvestigación:\n${findings}\n\nDecide el resultado aplicando los criterios al pie de la letra. Si la evidencia no es definitiva, responde UNKNOWN.` }],
  });
  const d = decided.parsed_output;
  if (!d || decided.stop_reason === "refusal") return { decision: "UNKNOWN" as const, explanation: "Sin decisión válida", proposed: false };

  let winningMarketId: number | undefined;
  if (e.kind === "multi" && d.decision === "YES") {
    winningMarketId = e.markets.find((m: any) => m.outcome_label.toLowerCase() === d.winningOutcome.toLowerCase())?.id;
  }
  const confident = d.decision !== "UNKNOWN" && d.confidence >= MIN_CONFIDENCE && (e.kind !== "multi" || d.decision === "VOID" || winningMarketId);
  let proposed = false;
  if (confident && opts.autoPropose !== false) {
    await propose(e.id, {
      outcome: d.decision as "YES" | "NO" | "VOID",
      winningMarketId,
      proposer: `ai:${decided.model}`,
      evidence: d.evidence,
      explanation: `${d.explanation} (confianza ${Math.round(d.confidence * 100)}%)`,
    });
    proposed = true;
  }
  return { ...d, winningMarketId, proposed };
}

/** Intenta resolver con IA los eventos cerrados que aún no tienen propuesta. */
export async function aiResolveClosed(limit = 10) {
  const evs = await many(pool,
    `SELECT e.id FROM events e WHERE e.status='closed'
     AND NOT EXISTS (SELECT 1 FROM resolutions r WHERE r.event_id=e.id AND r.status IN ('proposed','disputed','finalized'))
     ORDER BY e.close_time LIMIT $1`, [limit]);
  const out = [];
  for (const e of evs) {
    try { out.push({ eventId: e.id, ...(await aiResolve(e.id)) }); }
    catch (err) { out.push({ eventId: e.id, error: (err as Error).message }); }
  }
  return out;
}
