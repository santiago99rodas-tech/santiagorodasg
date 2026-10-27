// Prepara una base de datos de pruebas limpia y una billetera de casino en memoria.
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/predicciones_test";
process.env.MM_ENABLED = "false";
process.env.TAKER_FEE_BPS = "200";
process.env.CHALLENGE_WINDOW_MINUTES = "0";

const { pool } = await import("../src/db/pool.js");
const { migrate } = await import("../src/db/migrate.js");
const { setWalletTransport } = await import("../src/services/wallet.js");
const { loadBooks } = await import("../src/services/trading.js");
const { resetHouseCache } = await import("../src/services/house.js");
const { seedCategories } = await import("../src/db/seed.js");

export { pool };

/** Saldos del casino de prueba en micro-dólares, por playerId externo. */
export const casino = { balances: new Map<string, number>(), calls: [] as { action: string; body: any }[] };

export async function resetDb() {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate();
  await seedCategories();
  resetHouseCache();
  await loadBooks();
  casino.balances.clear();
  casino.calls.length = 0;
  const seen = new Set<string>();
  setWalletTransport(async (url, _headers, raw) => {
    const action = url.split("/").pop()!;
    const body = JSON.parse(raw);
    casino.calls.push({ action, body });
    const bal = casino.balances.get(body.playerId) ?? 0;
    const amt = Math.round(Number(body.amount ?? 0) * 1e6);
    if (action === "balance") return { ok: true, balance: (bal / 1e6).toFixed(2) };
    if (seen.has(body.txId)) return { ok: true, balance: (bal / 1e6).toFixed(2), operatorTxId: body.txId };
    if (action === "debit") {
      if (amt > bal) return { ok: false, error: "insufficient_funds" };
      casino.balances.set(body.playerId, bal - amt);
    } else if (action === "credit") {
      casino.balances.set(body.playerId, bal + amt);
    }
    seen.add(body.txId);
    return { ok: true, balance: ((casino.balances.get(body.playerId) ?? 0) / 1e6).toFixed(2), operatorTxId: `op-${body.txId}` };
  });
  await pool.query("INSERT INTO operators (id, name, api_key, api_secret, wallet_url, wallet_secret) VALUES ('casino1','Casino Test','key1','secret1','http://wallet.test','wsecret')");
}

export async function player(externalId: string, balanceUsd: number) {
  casino.balances.set(externalId, balanceUsd * 1e6);
  const r = await pool.query("INSERT INTO players (operator_id, external_id, display_name) VALUES ('casino1',$1,$1) RETURNING id", [externalId]);
  return r.rows[0].id as number;
}

export const bal = (externalId: string) => (casino.balances.get(externalId) ?? 0) / 1e6;

export function futureIso(days = 10) {
  return new Date(Date.now() + days * 864e5).toISOString();
}
