import { pool } from "./pool.js";
import { migrate } from "./migrate.js";

export const CATEGORIES: [string, string][] = [
  ["politica", "Política"], ["deportes", "Deportes"], ["cripto", "Cripto"], ["economia", "Economía"],
  ["entretenimiento", "Entretenimiento"], ["tecnologia", "Tecnología"], ["clima", "Clima"],
  ["internacional", "Internacional"], ["finanzas", "Finanzas"], ["sociedad", "Sociedad"],
  ["farandula", "Farándula"], ["musica", "Música"], ["moda", "Moda"], ["reinados", "Reinados"], ["redes", "Redes sociales"],
];

export async function seedCategories() {
  for (const [i, [slug, name]] of CATEGORIES.entries()) {
    await pool.query("INSERT INTO categories (slug, name, sort) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, sort=EXCLUDED.sort", [slug, name, i]);
  }
}

// Fuentes iniciales. Son URLs públicas conocidas; verifica que respondan desde tu servidor
// antes de producción (pueden cambiar sin aviso). Se administran desde la API /admin/sources.
export const SOURCES = [
  { kind: "rss", name: "BBC Mundo", url: "https://feeds.bbci.co.uk/mundo/rss.xml", category: "internacional", country: "INT" },
  { kind: "rss", name: "CNN en Español", url: "https://cnnespanol.cnn.com/feed/", category: "internacional", country: "INT" },
  { kind: "rss", name: "Infobae", url: "https://www.infobae.com/arc/outboundfeeds/rss/", category: null, country: "INT" },
  { kind: "rss", name: "El Universo (Ecuador)", url: "https://www.eluniverso.com/arc/outboundfeeds/rss/?outputType=xml", category: null, country: "EC" },
  { kind: "rss", name: "Primicias (Ecuador)", url: "https://www.primicias.ec/feed/", category: null, country: "EC" },
  { kind: "rss", name: "El Tiempo (Colombia)", url: "https://www.eltiempo.com/rss/colombia.xml", category: null, country: "CO" },
  { kind: "rss", name: "Semana (Colombia)", url: "https://www.semana.com/arc/outboundfeeds/rss/?outputType=xml", category: null, country: "CO" },
  { kind: "rss", name: "ESPN Deportes", url: "https://www.espn.com.co/espn/rss/news", category: "deportes", country: "INT" },
  { kind: "google_trends", name: "Google Trends Ecuador", url: "https://trends.google.com/trending/rss?geo=EC", category: null, country: "EC" },
  { kind: "google_trends", name: "Google Trends Colombia", url: "https://trends.google.com/trending/rss?geo=CO", category: null, country: "CO" },
  { kind: "gdelt", name: "GDELT Latinoamérica", url: "https://api.gdeltproject.org/api/v2/doc/doc", category: null, country: "INT",
    config: { query: "(ecuador OR colombia OR venezuela OR \"miss universo\" OR farándula) sourcelang:spanish", timespan: "24h", maxrecords: 75 } },
];

export async function seedSources() {
  for (const s of SOURCES) {
    await pool.query(
      "INSERT INTO sources (kind, name, url, category, country, config) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (kind, url) DO NOTHING",
      [s.kind, s.name, s.url, s.category, s.country, JSON.stringify((s as any).config ?? {})]);
  }
}

const inDays = (d: number) => new Date(Date.now() + d * 864e5).toISOString();

// Mercados de demostración para probar el módulo sin esperar a la ingesta.
export const DEMO_EVENTS = [
  { title: "¿Quién ganará Miss Universo 2027?", category: "reinados", kind: "multi", closeTime: inDays(390),
    outcomes: [{ label: "Colombia", probability: 0.31 }, { label: "Venezuela", probability: 0.28 }, { label: "Egipto", probability: 0.12 }, { label: "Rusia", probability: 0.09 }, { label: "Otro país", probability: 0.2 }],
    resolutionCriteria: "Gana el país cuya representante sea coronada Miss Universo 2027 en la gala final oficial.", resolutionSource: "Organización Miss Universo (missuniverse.com)", featured: true },
  { title: "¿Subirá Bitcoin por encima de USD 120.000 antes del 31 de diciembre de 2026?", category: "cripto", kind: "binary", closeTime: inDays(68),
    outcomes: [{ label: "Sí", probability: 0.42 }], resolutionCriteria: "Sí, si el precio de BTC/USD en CoinMarketCap alcanza o supera USD 120.000 en cualquier momento antes del cierre.", resolutionSource: "CoinMarketCap" },
  { title: "¿Ganará Ecuador su próximo partido oficial de la selección mayor?", category: "deportes", kind: "binary", closeTime: inDays(21),
    outcomes: [{ label: "Sí", probability: 0.48 }], resolutionCriteria: "Sí, si Ecuador gana en el tiempo reglamentario su siguiente partido oficial FIFA. Empate o derrota resuelven No.", resolutionSource: "FIFA / Federación Ecuatoriana de Fútbol" },
  { title: "¿Bajará la inflación anual de Ecuador en el reporte de noviembre de 2026?", category: "economia", kind: "binary", closeTime: inDays(45),
    outcomes: [{ label: "Sí", probability: 0.61 }], resolutionCriteria: "Sí, si la inflación anual publicada por el INEC para noviembre de 2026 es menor que la de octubre de 2026.", resolutionSource: "INEC Ecuador" },
  { title: "¿Lloverá en Quito el 1 de noviembre de 2026?", category: "clima", kind: "binary", closeTime: inDays(8),
    outcomes: [{ label: "Sí", probability: 0.67 }], resolutionCriteria: "Sí, si la estación INAMHI Iñaquito registra precipitación mayor a 0,5 mm ese día.", resolutionSource: "INAMHI" },
  { title: "¿Recortará la Reserva Federal su tasa en la reunión de diciembre de 2026?", category: "economia", kind: "binary", closeTime: inDays(53),
    outcomes: [{ label: "Sí", probability: 0.58 }], resolutionCriteria: "Sí, si el comunicado del FOMC de diciembre de 2026 anuncia una reducción del rango objetivo.", resolutionSource: "Reserva Federal de EE. UU." },
  { title: "¿Quién ganará el próximo clásico Real Madrid vs. Barcelona en LaLiga?", category: "deportes", kind: "multi", closeTime: inDays(30),
    outcomes: [{ label: "Real Madrid", probability: 0.44 }, { label: "Empate", probability: 0.24 }, { label: "Barcelona", probability: 0.32 }],
    resolutionCriteria: "Resultado al final del tiempo reglamentario del siguiente clásico de LaLiga.", resolutionSource: "LaLiga (laliga.com)" },
  { title: "¿Netflix lanzará un plan más barato en Latinoamérica antes de 2027?", category: "entretenimiento", kind: "binary", closeTime: inDays(68),
    outcomes: [{ label: "Sí", probability: 0.35 }], resolutionCriteria: "Sí, si Netflix anuncia oficialmente un plan con precio menor al plan más barato vigente en algún país de Latinoamérica.", resolutionSource: "Comunicados oficiales de Netflix" },
  { title: "¿Superará el oro los USD 4.000 la onza antes del 31 de diciembre de 2026?", category: "finanzas", kind: "binary", closeTime: inDays(68),
    outcomes: [{ label: "Sí", probability: 0.55 }], resolutionCriteria: "Sí, si el precio spot LBMA del oro supera USD 4.000 por onza en algún cierre antes de la fecha.", resolutionSource: "LBMA" },
  { title: "¿Qué artista latino será el más escuchado de Spotify en 2026?", category: "musica", kind: "multi", closeTime: inDays(45),
    outcomes: [{ label: "Bad Bunny", probability: 0.52 }, { label: "Karol G", probability: 0.18 }, { label: "Peso Pluma", probability: 0.14 }, { label: "Feid", probability: 0.09 }, { label: "Otro", probability: 0.07 }],
    resolutionCriteria: "El artista latino con más reproducciones globales de 2026 según Spotify Wrapped.", resolutionSource: "Spotify Wrapped 2026" },
  { title: "¿Habrá un huracán categoría 5 en el Atlántico antes del 30 de noviembre de 2026?", category: "clima", kind: "binary", closeTime: inDays(37),
    outcomes: [{ label: "Sí", probability: 0.22 }], resolutionCriteria: "Sí, si el NHC clasifica algún huracán del Atlántico como categoría 5 antes del cierre.", resolutionSource: "Centro Nacional de Huracanes (NHC)" },
  { title: "¿Se aprobará la reforma tributaria en la Asamblea de Ecuador antes de febrero de 2027?", category: "politica", kind: "binary", closeTime: inDays(99),
    outcomes: [{ label: "Sí", probability: 0.39 }], resolutionCriteria: "Sí, si la ley se publica en el Registro Oficial antes del cierre.", resolutionSource: "Registro Oficial / Asamblea Nacional" },
  { title: "¿Lanzará Apple un iPhone plegable antes de que termine 2027?", category: "tecnologia", kind: "binary", closeTime: inDays(430),
    outcomes: [{ label: "Sí", probability: 0.47 }], resolutionCriteria: "Sí, si Apple anuncia oficialmente un iPhone con pantalla plegable antes del 31 de diciembre de 2027.", resolutionSource: "Apple Newsroom" },
  { title: "¿Shakira anunciará una nueva gira mundial antes del 31 de diciembre de 2026?", category: "farandula", kind: "binary", closeTime: inDays(68),
    outcomes: [{ label: "Sí", probability: 0.37 }], resolutionCriteria: "Sí, si Shakira o su equipo anuncian oficialmente una gira con fechas en al menos 3 países.", resolutionSource: "Cuentas oficiales verificadas de Shakira" },
  { title: "¿Qué color dominará las pasarelas de la temporada primavera-verano 2027?", category: "moda", kind: "multi", closeTime: inDays(150),
    outcomes: [{ label: "Verde menta", probability: 0.34 }, { label: "Rojo cereza", probability: 0.29 }, { label: "Azul eléctrico", probability: 0.21 }, { label: "Otro", probability: 0.16 }],
    resolutionCriteria: "El color más repetido en el informe oficial de tendencias de Pantone para la temporada.", resolutionSource: "Pantone Fashion Color Trend Report" },
] as const;

export async function seedDemo() {
  const { createEvent } = await import("../services/events.js");
  const exists = (await pool.query("SELECT count(*)::int AS n FROM events")).rows[0].n;
  if (exists > 0) return console.log(`ya hay ${exists} eventos: no se cargan demos`);
  for (const e of DEMO_EVENTS) await createEvent({ ...e, outcomes: [...e.outcomes] });
  await pool.query(
    `INSERT INTO operators (id, name, api_key, api_secret, wallet_url, wallet_secret, webhook_url, theme)
     VALUES ('demo-casino','Casino Demo','demo-api-key','demo-api-secret',$1,'demo-wallet-secret',$2,
             '{"brandName":"TuCasino","primary":"#ffd400"}')
     ON CONFLICT (id) DO NOTHING`,
    [`${process.env.DEMO_CASINO_URL ?? "http://localhost:4000"}/wallet`, `${process.env.DEMO_CASINO_URL ?? "http://localhost:4000"}/webhooks`]);
  console.log(`cargados ${DEMO_EVENTS.length} eventos de demostración y el operador demo-casino`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    await migrate();
    await seedCategories();
    await seedSources();
    if (process.argv.includes("--demo")) {
      const { loadBooks } = await import("../services/trading.js");
      await loadBooks();
      await seedDemo();
    }
    await pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
