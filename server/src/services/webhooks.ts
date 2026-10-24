import { pool, many } from "../db/pool.js";
import { signRequest } from "../lib/crypto.js";

/** Entrega webhooks pendientes al casino con reintentos exponenciales (máx. 10 intentos). */
export async function deliverWebhooks() {
  const rows = await many(pool,
    `SELECT w.*, o.webhook_url, o.api_secret FROM webhook_outbox w JOIN operators o ON o.id=w.operator_id
     WHERE w.delivered_at IS NULL AND w.attempts < 10 AND w.next_try_at <= now() ORDER BY w.id LIMIT 100`);
  for (const w of rows) {
    if (!w.webhook_url) {
      await pool.query("UPDATE webhook_outbox SET delivered_at=now(), last_error='sin webhook_url' WHERE id=$1", [w.id]);
      continue;
    }
    const body = JSON.stringify({ id: w.id, type: w.type, createdAt: w.created_at, data: w.payload });
    const ts = String(Date.now());
    const path = new URL(w.webhook_url).pathname;
    try {
      const res = await fetch(w.webhook_url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": signRequest(w.api_secret, ts, "POST", path, body) },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      await pool.query("UPDATE webhook_outbox SET delivered_at=now(), attempts=attempts+1 WHERE id=$1", [w.id]);
    } catch (e) {
      await pool.query(
        "UPDATE webhook_outbox SET attempts=attempts+1, last_error=$2, next_try_at = now() + make_interval(secs => 30 * power(2, attempts)) WHERE id=$1",
        [w.id, (e as Error).message]);
    }
  }
  return rows.length;
}
