import { readdirSync, readFileSync } from "node:fs";
import { pool } from "./pool.js";

export async function migrate() {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const dir = new URL("./migrations/", import.meta.url);
  const done = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const sql = readFileSync(new URL(f, dir), "utf8").replace(/CREATE TABLE schema_migrations[^;]*;/, "");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await pool.query("COMMIT");
      console.log(`migración aplicada: ${f}`);
    } catch (e) {
      await pool.query("ROLLBACK");
      throw e;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => pool.end(), (e) => { console.error(e); process.exit(1); });
}
