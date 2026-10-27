// Ingesta: trae noticias de todas las fuentes activas, las guarda sin duplicados y detecta tendencias.
import { flagNewsShocks } from "../services/toxicity.js";
import { pool, many, one } from "../db/pool.js";
import { fetchSource, type Fetcher, type SourceRow } from "./sources/index.js";
import { keywords, classify, normalize } from "./text.js";

export async function runIngest(opts: { fetcher?: Fetcher; sourceIds?: number[] } = {}) {
  const sources = await many<SourceRow>(pool,
    `SELECT * FROM sources WHERE enabled ${opts.sourceIds ? "AND id = ANY($1)" : ""} ORDER BY id`, opts.sourceIds ? [opts.sourceIds] : []);
  const report: { source: string; fetched: number; inserted: number; error?: string }[] = [];
  for (const s of sources) {
    try {
      const items = await fetchSource(s, opts.fetcher);
      let inserted = 0;
      for (const it of items.slice(0, 200)) {
        if (!it.url || !it.title) continue;
        const cat = s.category ?? it.category ?? classify(`${it.title} ${it.summary}`);
        const r = await pool.query(
          `INSERT INTO articles (source_id, url, title, summary, category, published_at, keywords) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (url) DO NOTHING`,
          [s.id, it.url, it.title.slice(0, 400), it.summary, cat, it.publishedAt > new Date() ? new Date() : it.publishedAt, keywords(it.title, it.summary)]);
        inserted += r.rowCount ?? 0;
      }
      await pool.query("UPDATE sources SET last_fetched_at=now(), last_status=$2 WHERE id=$1", [s.id, `ok: ${items.length} ítems, ${inserted} nuevos`]);
      report.push({ source: s.name, fetched: items.length, inserted });
    } catch (e) {
      const msg = (e as Error).message;
      await pool.query("UPDATE sources SET last_fetched_at=now(), last_status=$2 WHERE id=$1", [s.id, `error: ${msg}`]);
      report.push({ source: s.name, fetched: 0, inserted: 0, error: msg });
    }
  }
  const trends = await detectTrends();
  return { sources: report, trends: trends.length };
}

export async function addSocialSignal(input: { platform: string; url?: string; text: string; metrics?: Record<string, unknown>; category?: string; capturedBy?: string }) {
  return one(pool,
    `INSERT INTO social_signals (platform, url, text, metrics, category, captured_by, keywords) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.platform, input.url ?? null, input.text, JSON.stringify(input.metrics ?? {}), input.category ?? classify(input.text), input.capturedBy ?? "manual", keywords(input.text)]);
}

interface Doc { id: number; table: "articles" | "social_signals"; title: string; source: string; category: string; at: Date; kw: string[] }

/**
 * Agrupa artículos y señales de las últimas 48 h por palabras clave compartidas.
 * Una tendencia necesita cobertura de al menos 2 fuentes distintas, o ser una búsqueda
 * en alza / señal social. El puntaje premia volumen, diversidad de fuentes y frescura.
 */
export async function detectTrends(windowHours = 48) {
  const docs: Doc[] = [
    ...(await many(pool,
      `SELECT a.id, a.title, s.name AS source, s.kind, COALESCE(a.category,'sociedad') AS category, a.published_at AS at, a.keywords AS kw
       FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.published_at > now() - make_interval(hours => $1)`, [windowHours])
    ).map((r) => ({ ...r, table: "articles" as const, source: r.kind === "google_trends" ? `trends:${r.source}` : r.source })),
    ...(await many(pool,
      `SELECT id, text AS title, platform AS source, COALESCE(category,'redes') AS category, captured_at AS at, keywords AS kw
       FROM social_signals WHERE captured_at > now() - make_interval(hours => $1)`, [windowHours])
    ).map((r) => ({ ...r, table: "social_signals" as const, source: `social:${r.source}` })),
  ];
  if (!docs.length) return [];

  // Frecuencia de cada palabra clave (contando fuentes distintas)
  const kwSources = new Map<string, Set<string>>();
  const kwDocs = new Map<string, Doc[]>();
  for (const d of docs) for (const k of d.kw) {
    if (!kwDocs.has(k)) { kwDocs.set(k, []); kwSources.set(k, new Set()); }
    kwDocs.get(k)!.push(d);
    kwSources.get(k)!.add(d.source);
  }
  const ranked = [...kwDocs.keys()]
    .filter((k) => kwSources.get(k)!.size >= 2 || kwDocs.get(k)!.some((d) => d.source.startsWith("trends:") || d.source.startsWith("social:")))
    .sort((a, b) => kwSources.get(b)!.size - kwSources.get(a)!.size || (b.includes(" ") ? 1 : 0) - (a.includes(" ") ? 1 : 0) || kwDocs.get(b)!.length - kwDocs.get(a)!.length);

  const used = new Set<Doc>();
  const clusters: { label: string; keywords: string[]; docs: Doc[] }[] = [];
  for (const k of ranked) {
    const seed = kwDocs.get(k)!.filter((d) => !used.has(d));
    if (seed.length === 0) continue;
    const srcs = new Set(seed.map((d) => d.source));
    const special = seed.some((d) => d.source.startsWith("trends:") || d.source.startsWith("social:"));
    if (srcs.size < 2 && !special) continue;
    // Palabras que acompañan a k en el grupo
    const co = new Map<string, number>();
    for (const d of seed) for (const w of d.kw) if (w !== k) co.set(w, (co.get(w) ?? 0) + 1);
    const related = [...co.entries()].filter(([, n]) => n >= Math.max(2, Math.ceil(seed.length / 2))).sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 6);
    // Sumar documentos que comparten al menos 2 de las palabras del grupo
    const core = new Set([k, ...related]);
    const extra = docs.filter((d) => !used.has(d) && !seed.includes(d) && d.kw.filter((w) => core.has(w)).length >= 2);
    const all = [...seed, ...extra];
    all.forEach((d) => used.add(d));
    clusters.push({ label: k, keywords: [k, ...related], docs: all });
    if (clusters.length >= 60) break;
  }

  const now = Date.now();
  const scored = clusters.map((c) => {
    const sources = new Set(c.docs.map((d) => d.source));
    const social = c.docs.filter((d) => d.table === "social_signals").length;
    const searches = c.docs.filter((d) => d.source.startsWith("trends:")).length;
    const newest = Math.max(...c.docs.map((d) => +new Date(d.at)));
    const freshness = Math.exp(-(now - newest) / (12 * 3600e3)); // vida media ~8 h
    const score = Math.log2(1 + c.docs.length) * sources.size * (0.4 + freshness) + social * 1.5 + searches * 2;
    const cats = new Map<string, number>();
    for (const d of c.docs) cats.set(d.category, (cats.get(d.category) ?? 0) + 1);
    const category = [...cats.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // Etiqueta legible: el título más corto que contiene la palabra principal
    const titled = c.docs.map((d) => d.title).filter((t) => normalize(t).includes(c.label)).sort((a, b) => a.length - b.length)[0];
    return { ...c, label: titled && titled.length <= 90 ? titled : c.label, score, category, sources: sources.size, social, first: Math.min(...c.docs.map((d) => +new Date(d.at))), newest };
  }).sort((a, b) => b.score - a.score);

  // Guardar: actualizar tendencias activas que compartan 2+ palabras clave, crear el resto
  const active = await many(pool, "SELECT id, keywords FROM trends WHERE status IN ('active','used')");
  const touched: number[] = [];
  for (const c of scored) {
    const match = active.find((t) => !touched.includes(t.id) && t.keywords.filter((k: string) => c.keywords.includes(k)).length >= 2);
    const articleIds = c.docs.filter((d) => d.table === "articles").map((d) => d.id);
    const socialIds = c.docs.filter((d) => d.table === "social_signals").map((d) => d.id);
    const row = match
      ? await one(pool, `UPDATE trends SET label=$2, keywords=$3, category=$4, score=$5, article_count=$6, source_count=$7, social_count=$8, last_seen=to_timestamp($9/1000.0) WHERE id=$1 RETURNING id`,
          [match.id, c.label, c.keywords, c.category, c.score, articleIds.length, c.sources, socialIds.length, c.newest])
      : await one(pool, `INSERT INTO trends (label, keywords, category, score, article_count, source_count, social_count, first_seen, last_seen)
          VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),to_timestamp($9/1000.0)) RETURNING id`,
          [c.label, c.keywords, c.category, c.score, articleIds.length, c.sources, socialIds.length, c.first, c.newest]);
    touched.push(row.id);
    if (articleIds.length) await pool.query("UPDATE articles SET trend_id=$1 WHERE id = ANY($2)", [row.id, articleIds]);
    if (socialIds.length) await pool.query("UPDATE social_signals SET trend_id=$1 WHERE id = ANY($2)", [row.id, socialIds]);
  }
  await pool.query("UPDATE trends SET status='expired' WHERE status='active' AND NOT (id = ANY($1)) AND last_seen < now() - interval '48 hours'", [touched]);
  // Noticia de último momento sobre un mercado abierto: la casa abre el spread un rato
  await flagNewsShocks(scored).catch((e) => console.error("[protección] noticias:", e.message));
  return scored;
}
