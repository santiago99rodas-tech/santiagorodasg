// Generador de preguntas: convierte una tendencia (noticias + señales sociales) en mercados propuestos.
// Todo lo que genera queda como borrador 'pending' para que un moderador lo apruebe.

import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { pool, many, one } from "../db/pool.js";
import { config } from "../config.js";
import { claude, aiEnabled, FALLBACK } from "./claude.js";
import { EventInput } from "../services/events.js";

const Question = z.object({
  title: z.string().describe("Pregunta en español neutro, empieza con ¿ y termina con ?"),
  description: z.string().describe("Contexto breve para el jugador (1-3 frases)"),
  category: z.string(),
  kind: z.enum(["binary", "multi"]),
  outcomes: z.array(z.object({ label: z.string(), probability: z.number() }))
    .describe("binary: un solo elemento {label:'Sí', probability}. multi: opciones excluyentes que cubren todos los casos; probabilidades que suman 1"),
  closeTime: z.string().describe("Fecha y hora ISO 8601 con zona (UTC) en la que se deja de apostar"),
  resolutionCriteria: z.string().describe("Regla exacta de resolución, incluidos empates, aplazamientos y casos borde"),
  resolutionSource: z.string().describe("Fuente oficial y pública que decide el resultado"),
  tags: z.array(z.string()),
  rationale: z.string().describe("Por qué es interesante y cómo estimaste las probabilidades"),
  sourceUrls: z.array(z.string()),
});

const Output = z.object({
  questions: z.array(Question),
  skipped: z.string().describe("Si no propones preguntas, explica por qué; si propones, cadena vacía"),
});

const SYSTEM = `Eres el editor de mercados de una plataforma de mercados de predicción integrada en casinos online de Latinoamérica (Ecuador, Colombia y la región). Conviertes noticias y tendencias en preguntas sobre las que los jugadores apuestan Sí/No o eligen una opción, al estilo de Polymarket.

Una buena pregunta:
- Se puede resolver de forma objetiva con una fuente pública y oficial en la fecha de cierre, sin interpretación. Escribe los criterios pensando en el caso dudoso: empates, aplazamientos, cancelaciones, datos revisados.
- Tiene un horizonte claro: cierra entre 1 día y 18 meses después de hoy, antes de que se conozca el resultado.
- Interesa al público masivo: política, deportes, farándula, música, moda, reinados, entretenimiento, economía, clima, tecnología, redes sociales.
- En eventos múltiples, las opciones son excluyentes y cubren todos los casos (agrega "Otro" u "Otra" si hace falta). Máximo 8 opciones.
- Trae probabilidades iniciales realistas según la información disponible, entre 0,03 y 0,97. En múltiples deben sumar 1.

No propongas preguntas sobre: muertes, salud o accidentes de personas concretas; violencia, crímenes, atentados, guerras con víctimas o desastres con víctimas; menores de edad; personas privadas (no públicas); contenido sexual; autolesiones; nada que un jugador o un grupo pequeño pueda provocar o manipular para ganar; ni resultados que dependan de información privilegiada. Evita duplicar mercados que ya existen.

Si la tendencia no da para una buena pregunta, devuelve una lista vacía y explica por qué en "skipped". Propón como máximo 3 preguntas por tendencia; menos es mejor que preguntas débiles.`;

export async function generateForTrend(trendId: number) {
  if (!aiEnabled()) throw new Error("IA desactivada: configura ANTHROPIC_API_KEY");
  const trend = await one(pool, "SELECT * FROM trends WHERE id=$1", [trendId]);
  if (!trend) throw new Error("Tendencia no encontrada");
  const articles = await many(pool,
    "SELECT a.title, a.summary, a.url, a.published_at, s.name AS source FROM articles a JOIN sources s ON s.id=a.source_id WHERE trend_id=$1 ORDER BY published_at DESC LIMIT 25", [trendId]);
  const signals = await many(pool, "SELECT platform, text, url, metrics FROM social_signals WHERE trend_id=$1 ORDER BY captured_at DESC LIMIT 15", [trendId]);
  const existing = await many(pool, "SELECT title FROM events WHERE status IN ('open','closed') ORDER BY created_at DESC LIMIT 200");
  const pendingDrafts = await many(pool, "SELECT payload->>'title' AS title FROM drafts WHERE status='pending' LIMIT 200");
  const categories = await many(pool, "SELECT slug FROM categories ORDER BY sort");

  const today = new Date().toISOString();
  const material = [
    `Fecha y hora actual (UTC): ${today}`,
    `Categorías válidas: ${categories.map((c) => c.slug).join(", ")}`,
    `Tendencia: "${trend.label}" (palabras clave: ${trend.keywords.join(", ")}; ${trend.article_count} artículos de ${trend.source_count} fuentes; ${trend.social_count} señales sociales)`,
    `Artículos:\n${articles.map((a) => `- [${a.source}, ${new Date(a.published_at).toISOString().slice(0, 16)}] ${a.title}. ${a.summary.slice(0, 300)} (${a.url})`).join("\n") || "(ninguno)"}`,
    `Señales de redes sociales:\n${signals.map((s) => `- [${s.platform}] ${s.text.slice(0, 300)} ${JSON.stringify(s.metrics)} ${s.url ?? ""}`).join("\n") || "(ninguna)"}`,
    `Mercados ya existentes o en revisión (no los repitas):\n${[...existing, ...pendingDrafts].map((e) => `- ${e.title}`).join("\n") || "(ninguno)"}`,
  ].join("\n\n");

  const response = await claude().beta.messages.parse({
    model: config.aiModel,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: "medium", format: betaZodOutputFormat(Output) },
    system: SYSTEM,
    messages: [{ role: "user", content: `${material}\n\nPropón las preguntas para esta tendencia.` }],
  });

  if (response.stop_reason === "refusal") {
    await pool.query("UPDATE trends SET status='ignored' WHERE id=$1", [trendId]);
    return { created: [], skipped: "La IA declinó generar preguntas para esta tendencia" };
  }
  const out = response.parsed_output;
  if (!out) throw new Error(`Respuesta de la IA sin formato válido (stop_reason=${response.stop_reason})`);

  const created: number[] = [];
  const rejected: string[] = [];
  for (const q of out.questions) {
    const check = validateDraft(q);
    if (!check.ok) { rejected.push(`${q.title}: ${check.error}`); continue; }
    const d = await one(pool, "INSERT INTO drafts (trend_id, payload, created_by) VALUES ($1,$2,$3) RETURNING id",
      [trendId, JSON.stringify({ ...q, model: response.model }), `ai:${response.model}`]);
    created.push(d.id);
  }
  await pool.query("UPDATE trends SET status=$2 WHERE id=$1", [trendId, created.length ? "used" : "ignored"]);
  return { created, rejected, skipped: out.skipped };
}

/** Revisa reglas duras antes de mandar el borrador a moderación. */
export function validateDraft(q: z.infer<typeof Question>): { ok: true } | { ok: false; error: string } {
  const parsed = EventInput.safeParse(q);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const close = new Date(q.closeTime).getTime();
  if (close < Date.now() + 864e5) return { ok: false, error: "cierra en menos de 24 horas" };
  if (close > Date.now() + 550 * 864e5) return { ok: false, error: "cierra en más de 18 meses" };
  if (q.kind === "binary" && q.outcomes.length !== 1) return { ok: false, error: "binario con más de un resultado" };
  if (q.kind === "multi") {
    if (q.outcomes.length < 2 || q.outcomes.length > 8) return { ok: false, error: "múltiple debe tener entre 2 y 8 opciones" };
    const sum = q.outcomes.reduce((a, o) => a + o.probability, 0);
    if (Math.abs(sum - 1) > 0.08) return { ok: false, error: `las probabilidades suman ${sum.toFixed(2)}` };
  }
  return { ok: true };
}

/** Genera borradores para las tendencias activas con mejor puntaje que aún no se usaron. */
export async function generateForTopTrends(limit = 5) {
  const trends = await many(pool, "SELECT id FROM trends WHERE status='active' ORDER BY score DESC LIMIT $1", [limit]);
  const results = [];
  for (const t of trends) {
    try {
      results.push({ trendId: t.id, ...(await generateForTrend(t.id)) });
    } catch (e) {
      results.push({ trendId: t.id, error: (e as Error).message });
    }
  }
  return results;
}
