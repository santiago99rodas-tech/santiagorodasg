import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSource, parseFeed, isFeed, ingestTiming, type Fetcher, type SourceRow } from "../src/ingest/sources/index.js";

const src = (url: string, kind: SourceRow["kind"] = "rss", config: Record<string, any> = {}): SourceRow => ({ id: 1, kind, name: "x", url, category: null, country: null, config });
const reply = (status: number, body: string): ReturnType<Fetcher> => Promise.resolve({ ok: status < 400, status, text: async () => body });

test("fuentes: una página HTML con código 200 es un error, no '0 ítems'", async () => {
  const f: Fetcher = () => reply(200, "<!doctype html><html><body>Checking your browser…</body></html>");
  await assert.rejects(fetchSource(src("https://bloqueado.test/feed/"), f), /página web, no un feed/);
  const empty: Fetcher = () => reply(200, `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>`);
  await assert.rejects(fetchSource(src("https://vacio.test/feed/"), empty), /no trae noticias/);
});

test("fuentes: entiende RSS 1.0 (RDF)", () => {
  const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel rdf:about="https://r.test/"><title>R</title></channel>
    <item rdf:about="https://r.test/1"><title>Primera</title><link>https://r.test/1</link><dc:date>2026-10-27T10:00:00Z</dc:date></item>
    <item rdf:about="https://r.test/2"><title>Segunda</title><link>https://r.test/2</link></item></rdf:RDF>`;
  assert.equal(isFeed(rdf), true);
  const items = parseFeed(rdf);
  assert.deepEqual(items.map((i) => i.title), ["Primera", "Segunda"]);
  assert.equal(items[0].publishedAt.toISOString(), "2026-10-27T10:00:00.000Z");
});

test("fuentes: Google News sin el ' - Medio' del título", async () => {
  const f: Fetcher = () => reply(200, `<?xml version="1.0"?><rss version="2.0"><channel><title>g</title>
    <item><title>Ecuador clasifica al Mundial - CNN en Español</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Mon, 27 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`);
  const items = await fetchSource(src("https://news.google.com/rss/search?q=site:cnnespanol.cnn.com"), f);
  assert.equal(items[0].title, "Ecuador clasifica al Mundial");
});

test("fuentes: GDELT con 429 espera y reintenta una vez", async () => {
  ingestTiming.gdeltGapMs = 5;
  let calls = 0;
  const once: Fetcher = () => (++calls === 1 ? reply(429, "Please limit requests") : reply(200, JSON.stringify({ articles: [{ url: "https://g.test/1", title: "Nota", seendate: "20261027T100000Z" }] })));
  const items = await fetchSource(src("https://api.gdeltproject.org/api/v2/doc/doc", "gdelt", { query: "ecuador" }), once);
  assert.equal(calls, 2);
  assert.equal(items[0].title, "Nota");
  const always: Fetcher = () => reply(429, "Please limit requests");
  await assert.rejects(fetchSource(src("https://api.gdeltproject.org/api/v2/doc/doc", "gdelt", { query: "ecuador" }), always), /GDELT limita las consultas/);
  ingestTiming.gdeltGapMs = 6000;
});

test("fuentes: GDELT no envía la parte '#…' de la URL y avisa claro si no responde a tiempo", async () => {
  ingestTiming.gdeltGapMs = 0;
  let asked = "";
  const f: Fetcher = (url) => { asked = url; return reply(200, JSON.stringify({ articles: [] })); };
  await fetchSource(src("https://api.gdeltproject.org/api/v2/doc/doc#ciencia", "gdelt", { query: "nasa" }), f);
  assert.ok(asked.startsWith("https://api.gdeltproject.org/api/v2/doc/doc?query=nasa"), asked);
  const slow: Fetcher = () => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
  await assert.rejects(fetchSource(src("https://api.gdeltproject.org/api/v2/doc/doc", "gdelt", { query: "x" }), slow), /no respondió en 45 s/);
  ingestTiming.gdeltGapMs = 6000;
});
