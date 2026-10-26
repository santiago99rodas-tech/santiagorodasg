// npm run smoke -- https://predicciones.tu-dominio.com [ADMIN_API_KEY]
// Revisa un despliegue de punta a punta: salud, base, catálogo, módulo, back-office, oráculo (con su
// firma), market maker, protección y liquidación. Sale con código 1 si algo falla.
import { verify, createPublicKey } from "node:crypto";

const [base0, adminKey] = process.argv.slice(2);
if (!base0) { console.error("Uso: npm run smoke -- <url-de-la-api> [ADMIN_API_KEY]"); process.exit(2); }
const base = base0.replace(/\/$/, "");
let failed = 0;

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    console.log(`✓ ${name}${detail ? ` · ${detail}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name} · ${(e as Error).message}`);
  }
}
async function get(path: string, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { headers, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  return { status: r.status, text, headers: r.headers, json: () => JSON.parse(text) };
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

await check("salud y base de datos", async () => {
  const r = await get("/health");
  must(r.status === 200, `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  const h = r.json();
  must(h.db === "ok", "la base no responde");
  must(h.migrations >= 6, `solo ${h.migrations} migraciones aplicadas (se esperan 6 o más)`);
  return `${h.migrations} migraciones, ${h.openMarkets} mercados abiertos${h.version ? `, versión ${h.version}` : ""}`;
});
await check("catálogo", async () => {
  const cats = (await get("/v1/categories")).json();
  must(cats.length >= 26, `${cats.length} categorías`);
  const open = cats.reduce((a: number, c: any) => a + Number(c.open_events ?? 0), 0);
  must(open > 0, "no hay eventos abiertos (¿SEED_CATALOG=false en una base vacía?)");
  return `${cats.length} categorías, ${open} eventos abiertos`;
});
await check("módulo del jugador (/embed/)", async () => {
  const r = await get("/embed/");
  must(r.status === 200 && r.text.includes("<html"), `HTTP ${r.status}`);
});
await check("back-office (/admin/)", async () => {
  const r = await get("/admin/");
  must(r.status === 200 && r.text.includes("<html"), `HTTP ${r.status}`);
});
await check("oráculo firmado", async () => {
  const keys = (await get("/v1/oracle/keys")).json();
  const r = await get("/v1/oracle/markets?limit=5");
  must(r.status === 200, `HTTP ${r.status}`);
  const sig = r.headers.get("x-oracle-signature");
  must(sig, "falta la cabecera X-Oracle-Signature");
  const ok = verify(null, Buffer.from(r.text), createPublicKey(keys.keys[0].publicKeyPem), Buffer.from(sig!, "base64"));
  must(ok, "la firma no verifica con la clave pública publicada");
  return `clave ${keys.keys[0].kid}, ${r.json().data.count} mercados`;
});
await check("historial del oráculo", async () => {
  const t = (await get("/v1/oracle/track-record")).json().data;
  return `${t.horizons[1].resolvedMarkets} mercados resueltos medidos`;
});

if (!adminKey) {
  await check("el back-office pide clave", async () => {
    const r = await get("/admin/overview");
    must(r.status === 401, `respondió ${r.status} sin clave`);
  });
  console.log("(pasa ADMIN_API_KEY como segundo argumento para revisar también el market maker, la protección y la liquidación)");
} else {
  const h = { "x-admin-key": adminKey, "x-admin-user": "smoke" };
  await check("clave de admin", async () => { const r = await get("/admin/overview", h); must(r.status === 200, `HTTP ${r.status}`); });
  await check("market maker de la casa", async () => {
    const s = (await get("/admin/mm/status", h)).json();
    must(!s.killed, "el botón de pánico está activado");
    return `estrategia ${s.strategy}, ${s.totals?.events ?? 0} eventos cotizados, pérdida en el peor escenario $${Math.round(s.totals?.worstCaseLossUsd ?? 0)}`;
  });
  await check("protección contra informados", async () => {
    const t = (await get("/admin/toxicity", h)).json();
    return `${t.enabled ? "activa" : "APAGADA"}, ${t.tracked} jugadores medidos`;
  });
  await check("liquidación entre casinos", async () => {
    const c = (await get("/admin/clearing", h)).json();
    return `${c.casinos.length} casinos`;
  });
  await check("market makers externos", async () => {
    const m = (await get("/admin/market-makers", h)).json();
    return `${m.length} registrados`;
  });
}

console.log(failed ? `\n${failed} revisión(es) fallaron` : "\nTodo en orden");
process.exit(failed ? 1 : 0);
