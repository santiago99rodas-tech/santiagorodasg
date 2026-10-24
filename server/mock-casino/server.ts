// Casino de prueba: implementa la billetera que la plataforma llama (balance/debit/credit/rollback)
// y una página que embebe el módulo de Predicciones como una pestaña más del casino.
//
//   npm run mock-casino      -> http://localhost:4000
//
// Es la referencia de lo que un casino real debe implementar del lado de su backend.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { signRequest, safeEqual } from "../src/lib/crypto.js";
import { platform, PLATFORM } from "./platform.js";

const PORT = Number(process.env.MOCK_CASINO_PORT ?? 4000);
const WALLET_SECRET = process.env.OPERATOR_WALLET_SECRET ?? "demo-wallet-secret";
const START_BALANCE = 500;

// Saldos en centavos y transacciones ya procesadas (idempotencia por txId)
const balances = new Map<string, number>();
const processed = new Map<string, { balance: number; operatorTxId: string }>();
const bal = (p: string) => (balances.has(p) ? balances.get(p)! : (balances.set(p, START_BALANCE * 100), START_BALANCE * 100));

const readBody = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
const json = (res: ServerResponse, code: number, data: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };

async function wallet(req: IncomingMessage, res: ServerResponse, action: string) {
  const raw = await readBody(req);
  const ts = String(req.headers["x-timestamp"] ?? "");
  const sig = String(req.headers["x-signature"] ?? "");
  if (!safeEqual(sig, signRequest(WALLET_SECRET, ts, "POST", `/${action}`, raw))) return json(res, 401, { ok: false, error: "bad_signature" });
  const b = JSON.parse(raw);
  const cents = Math.round(Number(b.amount ?? 0) * 100);
  if (action === "balance") return json(res, 200, { ok: true, balance: (bal(b.playerId) / 100).toFixed(2) });
  if (processed.has(b.txId)) { const p = processed.get(b.txId)!; return json(res, 200, { ok: true, balance: (p.balance / 100).toFixed(2), operatorTxId: p.operatorTxId }); }
  let next = bal(b.playerId);
  if (action === "debit") {
    if (cents > next) return json(res, 200, { ok: false, error: "insufficient_funds" });
    next -= cents;
  } else if (action === "credit") {
    next += cents;
  } else if (action === "rollback") {
    const orig = processed.get(b.originalTxId);
    if (orig) next += cents; // devolver el débito original si se llegó a aplicar
  } else return json(res, 404, { ok: false, error: "unknown_action" });
  balances.set(b.playerId, next);
  const out = { balance: next, operatorTxId: `cas-${processed.size + 1}` };
  processed.set(b.txId, out);
  console.log(`[billetera] ${action.padEnd(8)} ${b.playerId.padEnd(16)} ${(cents / 100).toFixed(2).padStart(8)}  saldo ${(next / 100).toFixed(2)}  (${b.reason ?? ""})`);
  return json(res, 200, { ok: true, balance: (next / 100).toFixed(2), operatorTxId: out.operatorTxId });
}

const page = (launchUrl: string, player: string, name: string) => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Casino Demo</title>
<style>
  :root { color-scheme: dark; } * { box-sizing: border-box; }
  body { margin: 0; background: #0b0b0c; color: #f4f4f5; font-family: system-ui, sans-serif; display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid #2c2c31; flex-wrap: wrap; }
  .logo { font-weight: 900; font-style: italic; font-size: 22px; color: #ffd400; }
  nav { display: flex; gap: 4px; flex: 1; overflow-x: auto; }
  nav a { padding: 8px 12px; border-radius: 8px; color: #a1a1aa; text-decoration: none; font-weight: 600; white-space: nowrap; }
  nav a.on { background: #ffd400; color: #111; }
  .bal { font-family: ui-monospace, monospace; background: #17171a; border: 1px solid #2c2c31; padding: 7px 10px; border-radius: 8px; }
  .note { font-size: 12px; color: #a1a1aa; padding: 6px 16px; border-bottom: 1px solid #2c2c31; }
  iframe { flex: 1; border: 0; width: 100%; }
</style></head><body>
<header><span class="logo">Casino Demo</span>
<nav><a href="#">Casino</a><a href="#">En vivo</a><a href="#">Deportes</a><a href="#" class="on">Predicciones</a><a href="#">Promociones</a></nav>
<span>${name}</span><span class="bal">Saldo casino: $<span id="b">…</span></span></header>
<div class="note">Esta barra es del casino. Debajo, el módulo de Predicciones embebido por iframe. El saldo de arriba sale de la billetera del casino: baja al apostar y sube con ventas y premios.</div>
<iframe src="${launchUrl}" title="Predicciones" allow="clipboard-write"></iframe>
<script>
  async function refresh() { const r = await fetch('/api/balance?player=${encodeURIComponent(player)}'); document.getElementById('b').textContent = (await r.json()).balance; }
  refresh(); setInterval(refresh, 3000);
</script></body></html>`;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (req.method === "POST" && url.pathname.startsWith("/wallet/")) return wallet(req, res, url.pathname.split("/")[2]);
    if (req.method === "POST" && url.pathname === "/webhooks") {
      console.log("[webhook]", await readBody(req));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/balance") return json(res, 200, { balance: (bal(url.searchParams.get("player") ?? "") / 100).toFixed(2) });
    if (url.pathname === "/") {
      const player = url.searchParams.get("player") ?? "jugador-demo";
      const name = url.searchParams.get("name") ?? "Jugador Demo";
      const s = await platform("POST", "/operator/v1/sessions", { playerId: player, displayName: name });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page(s.launchUrl, player, name));
    }
    json(res, 404, { error: "not_found" });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
}).listen(PORT, () => console.log(`Casino de prueba en http://localhost:${PORT} (plataforma: ${PLATFORM})`));
