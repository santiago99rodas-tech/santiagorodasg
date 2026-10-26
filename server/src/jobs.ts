// Tareas programadas. En producción con varias instancias, ejecútalas en una sola (JOBS_ENABLED=true).
import { config } from "./config.js";
import { runIngest } from "./ingest/pipeline.js";
import { generateForTopTrends, refillCategories } from "./ai/questions.js";
import { aiResolveClosed } from "./ai/resolver.js";
import { aiEnabled } from "./ai/claude.js";
import { closeExpired, finalizeDue } from "./services/resolution.js";
import { refreshQuotes, updateFairPrices } from "./services/marketmaker.js";
import { scoreMarkouts } from "./services/toxicity.js";
import { runSettlement, markOverdue, evaluatePauses } from "./services/treasury.js";
import { retryCredits } from "./services/wallet.js";
import { deliverWebhooks } from "./services/webhooks.js";
import { pool } from "./db/pool.js";
import { refreshExternalPrices } from "./services/integrity.js";

const timers: NodeJS.Timeout[] = [];

function every(name: string, ms: number, fn: () => Promise<unknown>) {
  if (!ms || ms <= 0) return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (e) { console.error(`[job ${name}]`, (e as Error).message); } finally { running = false; }
  };
  timers.push(setInterval(run, ms));
  setTimeout(run, 2000);
}

export function startJobs() {
  every("cerrar-vencidos", 30_000, closeExpired);
  every("finalizar-resoluciones", 30_000, finalizeDue);
  every("reintentar-creditos", 60_000, retryCredits);
  every("webhooks", 15_000, deliverWebhooks);
  every("market-maker", config.jobs.mmRefreshEverySec * 1000, async () => { await updateFairPrices(); await refreshQuotes(); });
  if (config.toxicity.enabled) every("markouts", 5 * 60_000, () => scoreMarkouts());
  // Tesorería: emite las liquidaciones que tocan, marca vencidas y pausa o reanuda casinos
  every("tesoreria", config.treasury.jobEveryMin * 60_000, async () => { await runSettlement({ onlyDue: true }); await markOverdue(); await evaluatePauses(); });
  every("snapshot-precios", 15 * 60_000, () => pool.query("INSERT INTO price_history (market_id, ts, price, fair) SELECT id, date_trunc('minute', now()), last_price, COALESCE(fair_exact * 100, fair_price) FROM markets WHERE status='open' ON CONFLICT DO NOTHING"));
  every("referencias-externas", 30 * 60_000, () => refreshExternalPrices());
  every("ingesta", config.jobs.ingestEveryMin * 60_000, () => runIngest());
  if (aiEnabled()) {
    every("generar-preguntas", config.jobs.generateEveryMin * 60_000, () => generateForTopTrends(5));
    every("rellenar-categorias", config.jobs.refillEveryMin * 60_000, refillCategories);
    every("resolver-con-ia", 30 * 60_000, () => aiResolveClosed(10));
  }
}

export function stopJobs() {
  timers.splice(0).forEach(clearInterval);
}
