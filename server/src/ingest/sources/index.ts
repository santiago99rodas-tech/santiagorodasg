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

export function parseFeed(body: string): Item[] {
  const doc = xml.parse(body);
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

export async function fetchSource(s: SourceRow, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<Item[]> {
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const r = await fetcher(url, { headers: { "user-agent": "PrediccionesBot/0.1 (+agregador de noticias)", ...headers }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  };
  switch (s.kind) {
    case "rss":
      return parseFeed(await get(s.url)).filter((i) => i.url && i.title);
    case "google_trends": {
      const geo = new URL(s.url).searchParams.get("geo") ?? s.country ?? "";
      return parseGoogleTrends(await get(s.url), geo).map((i) => ({ ...i, category: undefined }));
    }
    case "gdelt": {
      const q = new URLSearchParams({ query: s.config.query ?? "", mode: "artlist", format: "json", maxrecords: String(s.config.maxrecords ?? 50), timespan: s.config.timespan ?? "24h", sort: "datedesc" });
      const json = JSON.parse(await get(`${s.url}?${q}`));
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
