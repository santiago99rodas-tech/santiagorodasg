// Valida el catálogo: npx tsx src/db/catalog/validate.ts [archivo.ts]
import { loadCatalog, validateCatalog } from "./index.js";
import { CATEGORIES } from "../seed.js";

const only = process.argv[2];
let cats = await loadCatalog();
if (only) cats = ((await import(new URL(only, `file://${process.cwd()}/`).href)).default);
const r = validateCatalog(cats, { knownCategories: CATEGORIES.map(([s]) => s) });
console.log("preguntas por categoría:", r.counts);
console.log("total:", r.total);
if (r.issues.length) {
  console.log(`\n${r.issues.length} problemas:`);
  for (const i of r.issues) console.log(`- [${i.category}] ${i.q} → ${i.problem}`);
  process.exit(1);
}
console.log("catálogo válido");
