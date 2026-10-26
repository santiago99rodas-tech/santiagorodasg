import { readdirSync, readFileSync } from "node:fs";
import { pool } from "./pool.js";

/**
 * Aplica las migraciones pendientes en orden. Todo corre en una sola conexión, cada archivo en su
 * propia transacción, y con un candado de Postgres para que dos arranques simultáneos (un redeploy
 * que se superpone con el contenedor anterior) no apliquen la misma migración dos veces.
 */
export async function migrate() {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(727272)");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const dir = new URL("./migrations/", import.meta.url);
    const done = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      const sql = readFileSync(new URL(f, dir), "utf8").replace(/CREATE TABLE schema_migrations[^;]*;/, "");
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await c.query("COMMIT");
        console.log(`migración aplicada: ${f}`);
      } catch (e) {
        await c.query("ROLLBACK");
        throw new Error(`migración ${f} falló: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(727272)").catch(() => undefined);
    c.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => pool.end(), (e) => { console.error(e); process.exit(1); });
}
