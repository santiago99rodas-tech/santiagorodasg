import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb } from "./helpers.js";
import { runIngest, addSocialSignal } from "../src/ingest/pipeline.js";
import { entities, classify, keywords } from "../src/ingest/text.js";
import { generateForTrend, validateDraft } from "../src/ai/questions.js";
import { setClaudeClient } from "../src/ai/claude.js";
import { config } from "../src/config.js";
import { approveDraft, listDrafts } from "../src/services/drafts.js";
import type { Fetcher } from "../src/ingest/sources/index.js";

const now = new Date().toUTCString();
const rss = (items: string[][]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items.map(([t, l, d]) =>
  `<item><title><![CDATA[${t}]]></title><link>${l}</link><description><![CDATA[${d}]]></description><pubDate>${now}</pubDate></item>`).join("")}</channel></rss>`;

const FEEDS: Record<string, string> = {
  "https://a.test/rss": rss([
    ["Miss Universo 2027 se realizará en Ecuador, confirma la organización", "https://a.test/1", "La Organización Miss Universo anunció la sede del certamen."],
    ["Bitcoin cae 5% tras anuncio de la Reserva Federal", "https://a.test/2", "El mercado cripto reacciona a la Reserva Federal."],
  ]),
  "https://b.test/rss": rss([
    ["Colombia y Venezuela, favoritas para Miss Universo 2027", "https://b.test/1", "Las candidatas de Colombia y Venezuela lideran los pronósticos del certamen."],
    ["Shakira sorprende con nuevo sencillo", "https://b.test/2", "La cantante lanzó una canción."],
  ]),
  "https://trends.google.com/trending/rss?geo=EC": `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel>
    <item><title>Miss Universo</title><ht:approx_traffic>50000+</ht:approx_traffic><pubDate>${now}</pubDate>
    <ht:news_item><ht:news_item_title>Ecuador será sede de Miss Universo 2027</ht:news_item_title></ht:news_item></item></channel></rss>`,
};

const fakeFetch: Fetcher = async (url) => {
  const body = FEEDS[url];
  return { ok: !!body, status: body ? 200 : 404, text: async () => body ?? "" };
};

before(async () => {
  await resetDb();
  await pool.query("INSERT INTO sources (kind, name, url) VALUES ('rss','Diario A','https://a.test/rss'), ('rss','Diario B','https://b.test/rss'), ('google_trends','Trends EC','https://trends.google.com/trending/rss?geo=EC'), ('rss','Caída','https://caida.test/rss')");
});
after(() => pool.end());

test("texto: entidades, palabras clave y categoría", () => {
  assert.deepEqual(entities("Colombia y Venezuela, favoritas para Miss Universo 2027"), ["colombia y venezuela", "miss universo"]);
  assert.ok(keywords("Bitcoin cae 5% tras anuncio de la Reserva Federal").includes("reserva federal"));
  assert.equal(classify("Las candidatas de Miss Universo"), "reinados");
  assert.equal(classify("Bitcoin y ethereum caen"), "cripto");
});

test("ingesta guarda artículos, registra errores por fuente y detecta la tendencia compartida", async () => {
  await addSocialSignal({ platform: "tiktok", text: "Video viral: candidata de Colombia a Miss Universo 2027 ensaya su pasarela", metrics: { views: 2_400_000 }, capturedBy: "agente-chrome" });
  const r = await runIngest({ fetcher: fakeFetch });
  assert.equal(r.sources.find((s) => s.source === "Caída")!.error, "HTTP 404");
  assert.equal((await pool.query("SELECT count(*)::int n FROM articles")).rows[0].n, 5);
  const top = (await pool.query("SELECT * FROM trends ORDER BY score DESC LIMIT 1")).rows[0];
  assert.ok(top.keywords.includes("miss universo"), `tendencia principal: ${top.label}`);
  assert.equal(top.category, "reinados");
  assert.ok(top.source_count >= 3);
  assert.equal(top.social_count, 1);
});

test("generación con IA crea borradores válidos y descarta los inválidos", async () => {
  const trend = (await pool.query("SELECT id FROM trends ORDER BY score DESC LIMIT 1")).rows[0];
  const close = new Date(Date.now() + 200 * 864e5).toISOString();
  const fakeClient: any = {
    beta: { messages: { parse: async (params: any) => {
      assert.match(params.messages[0].content, /Miss Universo/);
      assert.equal(params.fallbacks, "default");
      return {
        stop_reason: "end_turn", model: "claude-opus-5-5",
        parsed_output: {
          skipped: "",
          questions: [
            { title: "¿Qué país ganará Miss Universo 2027?", description: "Ecuador será sede.", category: "reinados", kind: "multi",
              outcomes: [{ label: "Colombia", probability: 0.3 }, { label: "Venezuela", probability: 0.3 }, { label: "Ecuador", probability: 0.15 }, { label: "Otro país", probability: 0.25 }],
              closeTime: close, resolutionCriteria: "Gana el país de la candidata coronada en la gala final oficial.", resolutionSource: "Organización Miss Universo", tags: ["miss universo"], rationale: "Alta atención", sourceUrls: ["https://a.test/1"] },
            { title: "¿Pregunta que cierra mañana mismo?", description: "", category: "reinados", kind: "binary",
              outcomes: [{ label: "Sí", probability: 0.5 }], closeTime: new Date(Date.now() + 3600e3).toISOString(), resolutionCriteria: "Criterio cualquiera de prueba.", resolutionSource: "Fuente oficial", tags: [], rationale: "", sourceUrls: [] },
          ],
        },
      };
    } } },
  };
  config.anthropicApiKey = "test";
  setClaudeClient(fakeClient);
  const r = await generateForTrend(trend.id);
  assert.equal(r.created.length, 1);
  assert.match(r.rejected![0], /menos de 24 horas/);
  const [draft] = await listDrafts();
  const ev = await approveDraft(draft.id, { featured: true }, "admin:test");
  assert.equal(ev!.markets.length, 4);
  assert.equal(ev!.featured, true);
  assert.equal((await pool.query("SELECT status FROM trends WHERE id=$1", [trend.id])).rows[0].status, "used");
});

test("validación de borradores: probabilidades de un múltiple deben sumar ~1", () => {
  const r = validateDraft({ title: "¿Quién gana el certamen de prueba?", description: "", category: "reinados", kind: "multi",
    outcomes: [{ label: "A", probability: 0.6 }, { label: "B", probability: 0.6 }], closeTime: new Date(Date.now() + 10 * 864e5).toISOString(),
    resolutionCriteria: "Criterio de prueba suficiente.", resolutionSource: "Fuente", tags: [], rationale: "", sourceUrls: [] });
  assert.equal(r.ok, false);
});
