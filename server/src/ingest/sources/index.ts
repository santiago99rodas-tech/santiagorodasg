// Adaptadores de fuentes. Cada uno convierte una fuente externa en ítems normalizados.
import { XMLParser } from "fast-xml-parser";
import { stripHtml } from "../text.js";
import { config } from "../../config.js";

export interface SourceRow {
  id: number;
  kind: "rss" | "gdelt" | "google_trends" | "newsapi" | "tiktok_cc" | "json_feed";
  name: string;
  url: string;
  category: string | null;
  country: string | null;
  config: Record<string, any>;
}

export interface Item {
  url: string;
  title: string;
  summary: string;
  publishedAt: Date;
  category?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v));
const date = (v: any) => {
  const d = new Date(txt(v));
  return isNaN(+d) ? new Date() : d;
};

/** ¿La respuesta es un feed (RSS 2.0, RSS 1.0/RDF o Atom)? Muchos sitios devuelven una página HTML de bloqueo con código 200. */
export function isFeed(body: string) {
  const doc = xml.parse(body);
  return !!(doc.rss?.channel || doc.feed || doc["rdf:RDF"]);
}

export function parseFeed(body: string): Item[] {
  const doc = xml.parse(body);
  if (doc["rdf:RDF"]) {
    // RSS 1.0: los ítems van al mismo nivel que el canal
    return arr(doc["rdf:RDF"].item).map((it: any) => ({
      url: txt(it.link) || txt(it["@_rdf:about"]),
      title: stripHtml(txt(it.title)),
      summary: stripHtml(txt(it.description)).slice(0, 600),
      publishedAt: date(it["dc:date"] ?? it.pubDate),
    }));
  }
  if (doc.rss?.channel) {
    return arr(doc.rss.channel.item).map((it: any) => ({
      url: txt(it.link) || txt(it.guid),
      title: stripHtml(txt(it.title)),
      summary: stripHtml(txt(it.description)).slice(0, 600),
      publishedAt: date(it.pubDate ?? it["dc:date"]),
    }));
  }
  if (doc.feed) {
    return arr(doc.feed.entry).map((it: any) => {
      const link = arr(it.link).find((l: any) => !l["@_rel"] || l["@_rel"] === "alternate") ?? arr(it.link)[0];
      return {
        url: link?.["@_href"] ?? txt(it.id),
        title: stripHtml(txt(it.title)),
        summary: stripHtml(txt(it.summary ?? it.content)).slice(0, 600),
        publishedAt: date(it.published ?? it.updated),
      };
    });
  }
  return [];
}

/** Google Trends "trending now" RSS: cada ítem es una búsqueda en alza con noticias asociadas. */
export function parseGoogleTrends(body: string, geo: string): Item[] {
  const doc = xml.parse(body);
  return arr(doc.rss?.channel?.item).map((it: any) => {
    const term = stripHtml(txt(it.title));
    const news = arr(it["ht:news_item"]).map((n: any) => stripHtml(txt(n["ht:news_item_title"]))).filter(Boolean);
    const traffic = txt(it["ht:approx_traffic"]);
    return {
      url: `https://trends.google.com/trends/explore?geo=${geo}&q=${encodeURIComponent(term)}#${date(it.pubDate).toISOString().slice(0, 10)}`,
      title: term,
      summary: `Búsqueda en alza (${traffic || "tráfico sin dato"}). ${news.join(" · ")}`.slice(0, 600),
      publishedAt: date(it.pubDate),
    };
  });
}

// GDELT acepta una consulta cada 5 segundos por IP: entre consultas seguidas se espera y, si igual
// responde 429 (demasiadas consultas), se reintenta una vez
let lastGdelt = 0;
export const ingestTiming = { gdeltGapMs: 6000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Google News pone " - Medio" al final de cada título. */
const stripPublisher = (title: string) => title.replace(/\s+-\s+[^-]{2,60}$/, "");

export async function fetchSource(s: SourceRow, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<Item[]> {
  const get = async (url: string, headers: Record<string, string> = {}, timeoutMs = 15000) => {
    let r: Awaited<ReturnType<Fetcher>>;
    try {
      r = await fetcher(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; PrediccionesBot/1.0; agregador de noticias)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if ((e as Error).name === "TimeoutError" || /aborted due to timeout/i.test((e as Error).message)) throw new Error(`no respondió en ${timeoutMs / 1000} s; se reintenta en la próxima lectura`);
      throw e;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  };
  switch (s.kind) {
    case "rss": {
      const body = await get(s.url);
      if (!isFeed(body)) throw new Error(/<html/i.test(body) ? "la respuesta es una página web, no un feed (el sitio puede estar bloqueando lecturas automáticas o la URL cambió)" : "la respuesta no es un feed RSS ni Atom");
      const items = parseFeed(body).filter((i) => i.url && i.title);
      if (!items.length) throw new Error("el feed no trae noticias: revisa la URL");
      return new URL(s.url).hostname === "news.google.com" ? items.map((i) => ({ ...i, title: stripPublisher(i.title) })) : items;
    }
    case "google_trends": {
      const geo = new URL(s.url).searchParams.get("geo") ?? s.country ?? "";
      return parseGoogleTrends(await get(s.url), geo).map((i) => ({ ...i, category: undefined }));
    }
    case "gdelt": {
      const q = new URLSearchParams({ query: s.config.query ?? "", mode: "artlist", format: "json", maxrecords: String(s.config.maxrecords ?? 50), timespan: s.config.timespan ?? "24h", sort: "datedesc" });
      // La parte "#…" de la URL solo distingue varias consultas a la misma API (la base no admite dos fuentes con la misma URL); no se envía
      const base = s.url.split("#")[0];
      const wait = lastGdelt + ingestTiming.gdeltGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      let body: string;
      // GDELT suele tardar más que un feed: 45 s
      try { body = await get(`${base}?${q}`, {}, 45000); }
      catch (e) {
        if ((e as Error).message !== "HTTP 429") throw e;
        await sleep(ingestTiming.gdeltGapMs * 2);
        body = await get(`${base}?${q}`, {}, 45000).catch((e2) => { throw new Error(e2.message === "HTTP 429" ? "HTTP 429: GDELT limita las consultas; se reintenta en la próxima lectura" : e2.message); });
      } finally { lastGdelt = Date.now(); }
      // Con la consulta mal formada GDELT responde texto, no JSON
      let json: any;
      try { json = JSON.parse(body); } catch { throw new Error(`GDELT respondió: ${body.slice(0, 120)}`); }
      return arr(json.articles).map((a: any) => ({
        url: a.url,
        title: a.title,
        summary: `${a.domain ?? ""} ${a.sourcecountry ?? ""}`.trim(),
        publishedAt: a.seendate ? new Date(a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z")) : new Date(),
      }));
    }
    case "newsapi": {
      if (!config.newsApiKey) throw new Error("NEWSAPI_KEY no configurada");
      const q = new URLSearchParams({ pageSize: "50", ...(s.config.params ?? {}) });
      const json = JSON.parse(await get(`${s.url}?${q}`, { "x-api-key": config.newsApiKey }));
      return arr(json.articles).map((a: any) => ({ url: a.url, title: a.title, summary: a.description ?? "", publishedAt: new Date(a.publishedAt) }));
    }
    case "tiktok_cc":
    case "json_feed": {
      // Formato genérico: [{ title, url, summary?, publishedAt?, metrics? }].
      // Para TikTok Creative Center se usa un proveedor de datos o un servicio propio que exponga este formato.
      const json = JSON.parse(await get(s.url, s.config.headers ?? {}));
      return arr<any>(Array.isArray(json) ? json : json.items).map((a) => ({
        url: a.url,
        title: a.title,
        summary: [a.summary, a.metrics ? `Métricas: ${JSON.stringify(a.metrics)}` : ""].filter(Boolean).join(" "),
        publishedAt: a.publishedAt ? new Date(a.publishedAt) : new Date(),
      }));
    }
  }
}
