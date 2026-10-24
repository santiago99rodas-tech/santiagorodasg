import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog, validateCatalog, toEventInput } from "../src/db/catalog/index.js";
import { CATEGORIES } from "../src/db/seed.js";
import { EventInput } from "../src/services/events.js";

test("catálogo: válido y con al menos 25 preguntas en cada una de las categorías", async () => {
  const cats = await loadCatalog();
  const r = validateCatalog(cats, { knownCategories: CATEGORIES.map(([s]) => s) });
  assert.deepEqual(r.issues, []);
  for (const [slug] of CATEGORIES) assert.ok((r.counts[slug] ?? 0) >= 25, `${slug}: ${r.counts[slug] ?? 0} preguntas`);
});

test("catálogo: cada ítem se convierte en un evento válido", async () => {
  for (const cat of await loadCatalog()) {
    for (const item of cat.items) {
      const parsed = EventInput.safeParse(toEventInput(cat, item));
      assert.ok(parsed.success, `${item.q}: ${parsed.success ? "" : parsed.error.message}`);
    }
  }
});
