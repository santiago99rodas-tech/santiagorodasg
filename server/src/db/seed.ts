import { pool, many } from "./pool.js";
import { migrate } from "./migrate.js";

export const CATEGORIES: [string, string][] = [
  ["politica", "Política"], ["elecciones", "Elecciones"], ["internacional", "Internacional"],
  ["futbol", "Fútbol"], ["deportes", "Deportes"], ["cripto", "Cripto"], ["economia", "Economía"], ["finanzas", "Finanzas"],
  ["tecnologia", "Tecnología"], ["ia", "Inteligencia artificial"], ["cine", "Cine y sagas"], ["television", "Programas de TV"],
  ["entretenimiento", "Streaming"], ["musica", "Música"], ["premios", "Premios"], ["farandula", "Farándula"],
  ["reinados", "Reinados"], ["moda", "Moda"], ["redes", "Redes sociales"], ["videojuegos", "Videojuegos"],
  ["espacio", "Espacio"], ["ovnis", "OVNIs y misterios"], ["naturaleza", "Animales y naturaleza"], ["clima", "Clima"],
  ["ciencia", "Ciencia"], ["sociedad", "Sociedad"],
];

export async function seedCategories() {
  for (const [i, [slug, name]] of CATEGORIES.entries()) {
    await pool.query("INSERT INTO categories (slug, name, sort) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, sort=EXCLUDED.sort", [slug, name, i]);
  }
}

// Fuentes iniciales. Son URLs públicas conocidas; verifica que respondan desde tu servidor
// antes de producción (pueden cambiar sin aviso). Se administran desde la API /admin/sources.
// Google News por medio: para los sitios que quitaron su feed o bloquean lecturas automáticas
const gnews = (q: string, gl = "US") => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=es-419&gl=${gl}&ceid=${gl}:es-419`;
// URLs de fuentes que dejaron de funcionar, con su reemplazo (se corrigen solas al arrancar)
const REPLACED: Record<string, string> = {
  "https://cnnespanol.cnn.com/feed/": gnews("site:cnnespanol.cnn.com"),
  "https://www.primicias.ec/feed/": gnews("site:primicias.ec", "EC"),
  "https://www.espn.com.co/espn/rss/news": gnews("site:espn.com.co OR site:espndeportes.espn.com"),
};
const trends = (geo: string, country: string) => ({ kind: "google_trends", name: `Google Trends ${country}`, url: `https://trends.google.com/trending/rss?geo=${geo}`, category: null, country: geo });
export const SOURCES = [
  // Noticias generales
  { kind: "rss", name: "BBC Mundo", url: "https://feeds.bbci.co.uk/mundo/rss.xml", category: "internacional", country: "INT" },
  { kind: "rss", name: "CNN en Español", url: gnews("site:cnnespanol.cnn.com"), category: null, country: "INT" },
  { kind: "rss", name: "Infobae", url: "https://www.infobae.com/arc/outboundfeeds/rss/", category: null, country: "INT" },
  { kind: "rss", name: "El Universo (Ecuador)", url: "https://www.eluniverso.com/arc/outboundfeeds/rss/?outputType=xml", category: null, country: "EC" },
  { kind: "rss", name: "Primicias (Ecuador)", url: gnews("site:primicias.ec", "EC"), category: null, country: "EC" },
  { kind: "rss", name: "El Tiempo (Colombia)", url: "https://www.eltiempo.com/rss/colombia.xml", category: null, country: "CO" },
  { kind: "rss", name: "Semana (Colombia)", url: "https://www.semana.com/arc/outboundfeeds/rss/?outputType=xml", category: null, country: "CO" },
  // Deportes
  { kind: "rss", name: "ESPN Deportes", url: gnews("site:espn.com.co OR site:espndeportes.espn.com"), category: "deportes", country: "INT" },
  { kind: "rss", name: "Marca", url: "https://e00-marca.uecdn.es/rss/portada.xml", category: "futbol", country: "ES" },
  // Entretenimiento, cine, TV, música
  { kind: "rss", name: "Variety", url: "https://variety.com/feed/", category: "cine", country: "US" },
  { kind: "rss", name: "Deadline", url: "https://deadline.com/feed/", category: "television", country: "US" },
  { kind: "rss", name: "Billboard", url: "https://www.billboard.com/feed/", category: "musica", country: "US" },
  // Videojuegos
  { kind: "rss", name: "IGN", url: "https://feeds.ign.com/ign/all", category: "videojuegos", country: "US" },
  { kind: "rss", name: "Polygon", url: "https://www.polygon.com/rss/index.xml", category: "videojuegos", country: "US" },
  // Espacio, ciencia, naturaleza
  { kind: "rss", name: "NASA", url: "https://www.nasa.gov/feed/", category: "espacio", country: "US" },
  { kind: "rss", name: "Space.com", url: "https://www.space.com/feeds/all", category: "espacio", country: "US" },
  { kind: "rss", name: "Mongabay Latam", url: "https://es.mongabay.com/feed/", category: "naturaleza", country: "LATAM" },
  // Lo que la gente busca en Google, por país
  trends("EC", "Ecuador"), trends("CO", "Colombia"), trends("MX", "México"), trends("AR", "Argentina"),
  trends("PE", "Perú"), trends("CL", "Chile"), trends("VE", "Venezuela"), trends("US", "EE. UU."), trends("ES", "España"),
  { kind: "gdelt", name: "GDELT Latinoamérica", url: "https://api.gdeltproject.org/api/v2/doc/doc", category: null, country: "INT",
    config: { query: "(ecuador OR colombia OR venezuela OR \"miss universo\" OR farándula) sourcelang:spanish", timespan: "24h", maxrecords: 75 } },
  { kind: "gdelt", name: "GDELT Ciencia y espacio", url: "https://api.gdeltproject.org/api/v2/doc/doc#ciencia", category: null, country: "INT",
    config: { query: "(nasa OR spacex OR ovni OR \"vida extraterrestre\" OR extinción) sourcelang:spanish", timespan: "24h", maxrecords: 50 } },
];

export async function seedSources() {
  for (const [old, url] of Object.entries(REPLACED)) {
    const r = await pool.query("UPDATE sources SET url=$2, last_status=NULL WHERE kind='rss' AND url=$1 AND NOT EXISTS (SELECT 1 FROM sources WHERE kind='rss' AND url=$2)", [old, url]);
    if (r.rowCount) console.log(`fuente actualizada: ${old} -> ${url}`);
  }
  for (const s of SOURCES) {
    await pool.query(
      "INSERT INTO sources (kind, name, url, category, country, config) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (kind, url) DO NOTHING",
      [s.kind, s.name, s.url, s.category, s.country, JSON.stringify((s as any).config ?? {})]);
  }
}

/**
 * Carga el catálogo de mercados (src/db/catalog). Salta las preguntas que ya existen (mismo título)
 * y las que ya cerraron. No cotiza aquí: el market maker lo hace al arrancar el servidor.
 */
export async function seedCatalog(opts: { history?: boolean } = {}) {
  const { createEvent } = await import("../services/events.js");
  const { loadCatalog, toEventInput } = await import("./catalog/index.js");
  const existing = new Set((await many(pool, "SELECT lower(title) AS t FROM events")).map((r) => r.t));
  let created = 0, skipped = 0;
  for (const cat of await loadCatalog()) {
    for (const item of cat.items) {
      const input = toEventInput(cat, item);
      if (existing.has(input.title.toLowerCase()) || new Date(input.closeTime) <= new Date()) { skipped++; continue; }
      try {
        await createEvent(input, { quote: false });
        created++;
      } catch (e) {
        console.warn(`no se creó "${input.title}": ${(e as Error).message}`);
        skipped++;
      }
    }
  }
  if (opts.history) await backfillDemoHistory();
  console.log(`catálogo: ${created} eventos creados, ${skipped} omitidos`);
  return created;
}

/** Solo para demos: historial de precios de 14 días (caminata aleatoria que termina en el precio actual). */
export async function backfillDemoHistory() {
  const markets = await many(pool, "SELECT m.id, m.last_price FROM markets m WHERE m.status='open' AND (SELECT count(*) FROM price_history ph WHERE ph.market_id=m.id) <= 1");
  for (const m of markets) {
    let seed = m.id * 7919;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const pts: [Date, number][] = [];
    let p = m.last_price;
    for (let h = 1; h <= 14 * 24; h += 3) {
      p = Math.max(2, Math.min(98, p + Math.round((rnd() - 0.5) * 3)));
      pts.push([new Date(Date.now() - h * 3600e3), p]);
    }
    const values = pts.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(",");
    await pool.query(`INSERT INTO price_history (market_id, ts, price) VALUES ${values} ON CONFLICT DO NOTHING`, [m.id, ...pts.flatMap(([t, v]) => [t, v])]);
  }
  return markets.length;
}

export async function seedDemoOperator() {
  const base = process.env.DEMO_CASINO_URL ?? "http://localhost:4000";
  await pool.query(
    `INSERT INTO operators (id, name, api_key, api_secret, wallet_url, wallet_secret, webhook_url, theme)
     VALUES ('demo-casino','Casino Demo','demo-api-key','demo-api-secret',$1,'demo-wallet-secret',$2, '{"brandName":"TuCasino","primary":"#ffd400"}')
     ON CONFLICT (id) DO UPDATE SET wallet_url=EXCLUDED.wallet_url, webhook_url=EXCLUDED.webhook_url`, [`${base}/wallet`, `${base}/webhooks`]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    await migrate();
    await seedCategories();
    await seedSources();
    if (process.argv.includes("--catalog") || process.argv.includes("--demo")) {
      const { loadBooks } = await import("../services/trading.js");
      await loadBooks();
      await seedCatalog({ history: process.argv.includes("--demo") });
    }
    if (process.argv.includes("--demo")) {
      await seedDemoOperator();
      console.log("operador demo-casino listo");
    }
    await pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
