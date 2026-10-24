import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { seedCategories } from "./db/seed.js";
import { loadBooks } from "./services/trading.js";
import { buildServer } from "./server.js";
import { startJobs } from "./jobs.js";
import { aiEnabled } from "./ai/claude.js";

await migrate();
await seedCategories();
const open = await loadBooks();
const app = await buildServer();
await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(`libros cargados: ${open} órdenes abiertas · IA ${aiEnabled() ? "activa" : "desactivada (sin ANTHROPIC_API_KEY)"}`);
if (process.env.JOBS_ENABLED !== "false") startJobs();
