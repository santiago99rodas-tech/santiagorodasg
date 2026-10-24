import { readdirSync } from "node:fs";
import type { CatalogCategory, CatalogItem } from "./types.js";
import { isMulti } from "./types.js";
import type { EventInput } from "../../services/events.js";

/** Carga todos los archivos de catálogo de esta carpeta (excepto types/index/validate). */
export async function loadCatalog(): Promise<CatalogCategory[]> {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !/^(types|index|validate)\./.test(f)).sort();
  const out: CatalogCategory[] = [];
  for (const f of files) out.push(...((await import(new URL(f, dir).href)).default as CatalogCategory[]));
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fmt = (d: string) => new Date(`${d}T12:00:00-05:00`).toLocaleDateString("es-EC", { day: "numeric", month: "long", year: "numeric" });

/** Convierte un ítem del catálogo en la entrada de createEvent, con criterios estándar si no trae los suyos. */
export function toEventInput(cat: CatalogCategory, item: CatalogItem): EventInput {
  const src = item.src ?? cat.source;
  const closeTime = new Date(`${item.close}T23:59:00-05:00`).toISOString();
  if (isMulti(item)) {
    const sum = item.options.reduce((a, [, p]) => a + p, 0);
    return {
      title: item.q, description: "", category: cat.category, kind: "multi", closeTime,
      outcomes: item.options.map(([label, p]) => ({ label, probability: Math.min(0.97, Math.max(0.01, p / sum)) })),
      resolutionCriteria: item.rule ?? `Gana la opción que coincida con el resultado oficial publicado por ${src}. Si el resultado no corresponde a ninguna opción con nombre, gana "Otro"/"Otra" (si existe). Si el evento se cancela o no se define antes de 60 días después del cierre (${fmt(item.close)}), el mercado se anula y se devuelve $0,50 por acción.`,
      resolutionSource: src, tags: item.tags ?? [], featured: item.featured ?? false,
    };
  }
  return {
    title: item.q, description: "", category: cat.category, kind: "binary", closeTime,
    outcomes: [{ label: "Sí", probability: item.p }],
    resolutionCriteria: item.rule ?? `Se resuelve "Sí" si ${src} confirma lo que plantea la pregunta dentro del plazo indicado en ella (o, si la pregunta no indica plazo, antes del ${fmt(item.close)}). En cualquier otro caso se resuelve "No".`,
    resolutionSource: src, tags: item.tags ?? [], featured: item.featured ?? false,
  };
}

export interface ValidationIssue { category: string; q: string; problem: string }

export function validateCatalog(cats: CatalogCategory[], opts: { minPerCategory?: number; today?: Date; knownCategories?: string[] } = {}) {
  const issues: ValidationIssue[] = [];
  const min = opts.minPerCategory ?? 25;
  const today = opts.today ?? new Date();
  const earliest = new Date(today.getTime() + 2 * 864e5);
  const latest = new Date(today.getTime() + 600 * 864e5);
  const seen = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const c of cats) {
    if (opts.knownCategories && !opts.knownCategories.includes(c.category)) issues.push({ category: c.category, q: "-", problem: "categoría desconocida" });
    counts.set(c.category, (counts.get(c.category) ?? 0) + c.items.length);
    for (const i of c.items) {
      const bad = (problem: string) => issues.push({ category: c.category, q: i.q, problem });
      if (!/^¿.+\?$/.test(i.q.trim())) bad("debe empezar con ¿ y terminar con ?");
      if (i.q.length > 200) bad("pregunta demasiado larga (>200)");
      const key = i.q.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) bad(`duplicada (también en ${seen.get(key)})`);
      seen.set(key, c.category);
      if (!DATE.test(i.close)) { bad(`fecha inválida: ${i.close}`); continue; }
      const d = new Date(`${i.close}T23:59:00-05:00`);
      if (d < earliest) bad(`cierra demasiado pronto: ${i.close}`);
      if (d > latest) bad(`cierra demasiado lejos: ${i.close}`);
      if (isMulti(i)) {
        if (i.options.length < 2 || i.options.length > 8) bad("múltiple debe tener 2 a 8 opciones");
        const sum = i.options.reduce((a, [, p]) => a + p, 0);
        if (Math.abs(sum - 1) > 0.06) bad(`probabilidades suman ${sum.toFixed(2)}`);
        if (new Set(i.options.map(([l]) => l.toLowerCase())).size !== i.options.length) bad("opciones repetidas");
        if (i.options.some(([, p]) => p < 0.01 || p > 0.97)) bad("probabilidad de opción fuera de 0,01–0,97");
      } else if (!(typeof i.p === "number" && i.p >= 0.03 && i.p <= 0.97)) bad(`p fuera de rango: ${(i as any).p}`);
    }
  }
  for (const [cat, n] of counts) if (n < min) issues.push({ category: cat, q: "-", problem: `solo ${n} preguntas (mínimo ${min})` });
  return { issues, counts: Object.fromEntries(counts), total: [...counts.values()].reduce((a, b) => a + b, 0) };
}
