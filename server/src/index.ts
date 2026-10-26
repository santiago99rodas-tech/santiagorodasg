import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { seedCategories, seedSources, seedCatalog } from "./db/seed.js";
import { loadBooks } from "./services/trading.js";
import { buildServer } from "./server.js";
import { startJobs } from "./jobs.js";
import { aiEnabled } from "./ai/claude.js";
import { pool } from "./db/pool.js";

await migrate();
await seedCategories();
await seedSources();
const open = await loadBooks();
// Primer arranque en un servidor nuevo: carga el catálogo de mercados (SEED_CATALOG=false lo evita)
if (process.env.SEED_CATALOG !== "false" && (await pool.query("SELECT 1 FROM events LIMIT 1")).rowCount === 0) {
  await seedCatalog();
}
const app = await buildServer();
await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(`libros cargados: ${open} órdenes abiertas · IA ${aiEnabled() ? "activa" : "desactivada (sin ANTHROPIC_API_KEY)"}`);
if (process.env.JOBS_ENABLED !== "false") startJobs();
