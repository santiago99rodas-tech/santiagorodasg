import { z } from "zod";
import { pool, tx, one, many } from "../db/pool.js";
import { bad } from "../lib/errors.js";
import { randomToken } from "../lib/crypto.js";
import { refreshQuotes } from "./marketmaker.js";

export const EventInput = z.object({
  title: z.string().min(8).max(200),
  description: z.string().max(2000).default(""),
  category: z.string(),
  kind: z.enum(["binary", "multi"]),
  outcomes: z.array(z.object({ label: z.string().min(1).max(80), probability: z.number().min(0.01).max(0.99) })).min(1).max(20),
  closeTime: z.string().datetime({ offset: true }),
  resolutionCriteria: z.string().min(10),
  resolutionSource: z.string().min(3),
  imageUrl: z.string().url().optional(),
  tags: z.array(z.string()).default([]),
  featured: z.boolean().default(false),
});
export type EventInput = z.infer<typeof EventInput>;

export const slugify = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);

const cents = (p: number) => Math.max(1, Math.min(99, Math.round(p * 100)));

export async function createEvent(raw: unknown, opts: { draftId?: number; quote?: boolean } = {}) {
  const input = EventInput.parse(raw);
  if (new Date(input.closeTime) <= new Date()) throw bad("invalid_close_time", "La fecha de cierre debe estar en el futuro");
  if (input.kind === "binary" && input.outcomes.length !== 1) throw bad("invalid_outcomes", "Un evento binario lleva un solo resultado (la probabilidad del Sí)");
  if (input.kind === "multi" && input.outcomes.length < 2) throw bad("invalid_outcomes", "Un evento múltiple necesita al menos 2 opciones");
  const cat = await one(pool, "SELECT slug FROM categories WHERE slug=$1", [input.category]);
  if (!cat) throw bad("invalid_category", `Categoría desconocida: ${input.category}`);

  const ev = await tx(async (c) => {
    const e = await one(c,
      `INSERT INTO events (slug, title, description, category, image_url, kind, neg_risk, close_time, resolution_criteria, resolution_source, tags, featured, draft_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [`${slugify(input.title)}-${randomToken(3).toLowerCase()}`, input.title, input.description, input.category, input.imageUrl ?? null,
       input.kind, input.kind === "multi", input.closeTime, input.resolutionCriteria, input.resolutionSource, input.tags, input.featured, opts.draftId ?? null]);
    for (const [i, o] of input.outcomes.entries()) {
      const p = cents(o.probability);
      const m = await one(c,
        `INSERT INTO markets (event_id, question, outcome_label, close_time, initial_price, last_price, fair_price, sort)
         VALUES ($1,$2,$3,$4,$5,$5,$5,$6) RETURNING id`,
        [e.id, input.kind === "binary" ? input.title : `${input.title} · ${o.label}`, input.kind === "binary" ? "Sí" : o.label, input.closeTime, p, i]);
      await c.query("INSERT INTO price_history (market_id, ts, price) VALUES ($1, now(), $2)", [m.id, p]);
    }
    return e;
  });
  if (opts.quote !== false) {
    for (const m of await many(pool, "SELECT id FROM markets WHERE event_id=$1", [ev.id])) await refreshQuotes(m.id);
  }
  return getEvent(ev.id);
}

export async function getEvent(id: number | string) {
  const e = await one(pool, `SELECT * FROM events WHERE ${typeof id === "number" || /^\d+$/.test(String(id)) ? "id" : "slug"}=$1`, [id]);
  if (!e) return undefined;
  e.markets = await many(pool, "SELECT * FROM markets WHERE event_id=$1 ORDER BY sort, id", [e.id]);
  return e;
}
