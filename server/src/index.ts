import { config, productionProblems, productionWarnings } from "./config.js";
import { migrate } from "./db/migrate.js";
import { seedCategories, seedSources, seedCatalog, seedDemoOperator } from "./db/seed.js";
import { loadBooks } from "./services/trading.js";
import { buildServer } from "./server.js";
import { startJobs, stopJobs } from "./jobs.js";
import { aiEnabled } from "./ai/claude.js";
import { pool } from "./db/pool.js";

// En producción no arranca con las claves de ejemplo ni sin base de datos configurada
const problems = productionProblems();
if (problems.length) {
  console.error("Configuración incompleta para producción:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
for (const w of productionWarnings()) console.warn(`aviso: ${w}`);

await migrate();
await seedCategories();
await seedSources();
const open = await loadBooks();
// Primer arranque en un servidor nuevo: carga el catálogo de mercados (SEED_CATALOG=false lo evita)
if (process.env.SEED_CATALOG !== "false" && (await pool.query("SELECT 1 FROM events LIMIT 1")).rowCount === 0) {
  await seedCatalog();
}
// Casino de prueba (mock-casino) desplegado junto a la plataforma: registra su operador demo-casino
if (process.env.DEMO_CASINO_URL) await seedDemoOperator();
const app = await buildServer();
await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(`libros cargados: ${open} órdenes abiertas · IA ${aiEnabled() ? "activa" : "desactivada (sin ANTHROPIC_API_KEY)"}`);
if (process.env.JOBS_ENABLED !== "false") startJobs();

// Apagado ordenado (Easypanel manda SIGTERM en cada redeploy): deja de aceptar peticiones, frena las
// tareas programadas, espera a que terminen las que están en curso y cierra la base.
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${sig}: apagando`);
    stopJobs();
    const force = setTimeout(() => process.exit(1), 15_000);
    try { await app.close(); await pool.end(); } finally { clearTimeout(force); process.exit(0); }
  });
}
