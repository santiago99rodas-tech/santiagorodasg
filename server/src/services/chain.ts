// Blockchain en el modelo mixto, sin custodiar llaves:
//
//   1. Anclaje: una vez al día la huella (hash) del último asiento del libro contable se sella en
//      Bitcoin con OpenTimestamps. Es gratis, no necesita billetera y cualquiera puede comprobar
//      después, con el archivo .ots, que el libro existía así en esa fecha y no se reescribió.
//   2. USDC: los casinos que eligen esa vía pagan sus liquidaciones y garantías en USDC a una bóveda
//      multifirma (por ejemplo una Safe). La plataforma solo LEE la cadena por JSON-RPC: detecta las
//      transferencias que entran y salen de la bóveda, marca pagadas las liquidaciones y compara el
//      saldo real de la bóveda con el del libro. Mover plata de la bóveda lo hacen sus firmantes.

import { pool, one } from "../db/pool.js";
import { config } from "../config.js";
import { bad } from "../lib/errors.js";

// ---------- anclaje en Bitcoin (OpenTimestamps) ----------

export type AnchorTransport = (calendar: string, digest: Buffer) => Promise<Buffer>;
const httpAnchor: AnchorTransport = async (calendar, digest) => {
  const r = await fetch(calendar.replace(/\/$/, "") + "/digest", {
    method: "POST", body: new Uint8Array(digest), signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/vnd.opentimestamps.v1" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
let anchorTransport: AnchorTransport = httpAnchor;
/** Para pruebas: reemplaza el calendario real. */
export function setAnchorTransport(t: AnchorTransport | null) { anchorTransport = t ?? httpAnchor; }

// Cabecera estándar de un archivo .ots (DetachedTimestampFile de OpenTimestamps)
const OTS_MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");

/** Archivo .ots: cabecera + versión 1 + operación SHA-256 (0x08) + la huella + la prueba del calendario. */
export function otsFile(digestHex: string, proof: Buffer) {
  return Buffer.concat([OTS_MAGIC, Buffer.from([0x01, 0x08]), Buffer.from(digestHex, "hex"), proof]);
}

/**
 * Sella la huella del último asiento en cada calendario configurado. Si el libro no cambió desde el
 * último anclaje, no hace nada (salvo `force`).
 */
export async function anchorJournal(opts: { force?: boolean } = {}) {
  const head = await one(pool, "SELECT id, hash FROM journal ORDER BY id DESC LIMIT 1");
  if (!head) return { anchored: false, reason: "el libro está vacío" };
  const last = await one(pool, "SELECT journal_id FROM anchors WHERE status='submitted' ORDER BY id DESC LIMIT 1");
  if (!opts.force && last && Number(last.journal_id) === Number(head.id)) return { anchored: false, reason: "el libro no cambió desde el último anclaje" };
  const digest = Buffer.from(head.hash, "hex");
  const results = [];
  for (const cal of config.anchor.calendars) {
    try {
      const proof = await anchorTransport(cal, digest);
      await pool.query("INSERT INTO anchors (journal_id, head_hash, calendar, proof, status) VALUES ($1,$2,$3,$4,'submitted')", [head.id, head.hash, cal, proof]);
      results.push({ calendar: cal, ok: true });
    } catch (e) {
      await pool.query("INSERT INTO anchors (journal_id, head_hash, calendar, status, error) VALUES ($1,$2,$3,'error',$4)", [head.id, head.hash, cal, (e as Error).message.slice(0, 300)]);
      results.push({ calendar: cal, ok: false, error: (e as Error).message });
    }
  }
  const ok = results.some((r) => r.ok);
  if (ok) console.log(`[anclaje] asiento #${head.id} (${head.hash.slice(0, 12)}…) sellado en Bitcoin vía OpenTimestamps`);
  return { anchored: ok, journalId: Number(head.id), hash: head.hash, results };
}

/** Ancla si pasó ANCHOR_EVERY_HOURS desde el último anclaje. */
export async function anchorIfDue() {
  if (!config.anchor.enabled) return { anchored: false, reason: "anclaje desactivado" };
  const last = await one(pool, "SELECT created_at FROM anchors WHERE status='submitted' ORDER BY id DESC LIMIT 1");
  if (last && Date.now() - new Date(last.created_at).getTime() < config.anchor.everyHours * 3600e3) return { anchored: false, reason: "todavía no toca" };
  return anchorJournal();
}

// ---------- USDC: lectura de la cadena (JSON-RPC, sin dependencias) ----------

// Contrato de USDC nativo (Circle) en cada red, si no se indica USDC_TOKEN_ADDRESS
const USDC_BY_CHAIN: Record<string, string> = {
  polygon: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  arbitrum: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
};
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // keccak256("Transfer(address,address,uint256)")

export const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
export const usdcToken = () => (config.usdc.token || USDC_BY_CHAIN[config.usdc.chain] || "").toLowerCase();
export const usdcEnabled = () => !!(config.usdc.rpcUrl && isAddress(config.usdc.vault) && isAddress(usdcToken()));

export type RpcTransport = (method: string, params: unknown[]) => Promise<any>;
let rpcId = 0;
const httpRpc: RpcTransport = async (method, params) => {
  const r = await fetch(config.usdc.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
};
let rpc: RpcTransport = httpRpc;
/** Para pruebas: reemplaza el nodo real. */
export function setRpcTransport(t: RpcTransport | null) { rpc = t ?? httpRpc; }

const pad = (addr: string) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const hex = (n: number) => "0x" + n.toString(16);
const unpad = (topic: string) => "0x" + topic.slice(-40).toLowerCase();

/** Saldo de USDC de la bóveda, en micro-dólares (USDC tiene 6 decimales: 1 unidad = 1 micro-dólar). */
export async function vaultBalance(): Promise<number | null> {
  if (!usdcEnabled()) return null;
  const data = "0x70a08231" + pad(config.usdc.vault).slice(2); // balanceOf(address)
  const res = await rpc("eth_call", [{ to: usdcToken(), data }, "latest"]);
  return Number(BigInt(res));
}

export interface ChainTransfer { txHash: string; logIndex: number; block: number; from: string; to: string; amount: number; date: string }

/** Transferencias de USDC que entraron o salieron de la bóveda entre dos bloques. */
async function vaultTransfers(fromBlock: number, toBlock: number): Promise<ChainTransfer[]> {
  const base = { address: usdcToken(), fromBlock: hex(fromBlock), toBlock: hex(toBlock) };
  const [incoming, outgoing] = await Promise.all([
    rpc("eth_getLogs", [{ ...base, topics: [TRANSFER_TOPIC, null, pad(config.usdc.vault)] }]),
    rpc("eth_getLogs", [{ ...base, topics: [TRANSFER_TOPIC, pad(config.usdc.vault)] }]),
  ]);
  const blocks = new Map<string, string>();
  const out: ChainTransfer[] = [];
  for (const l of [...incoming, ...outgoing]) {
    if (!blocks.has(l.blockNumber)) {
      const b = await rpc("eth_getBlockByNumber", [l.blockNumber, false]);
      blocks.set(l.blockNumber, new Date(Number(BigInt(b.timestamp)) * 1000).toISOString().slice(0, 10));
    }
    const from = unpad(l.topics[1]), to = unpad(l.topics[2]);
    const value = Number(BigInt(l.data));
    out.push({ txHash: l.transactionHash, logIndex: Number(BigInt(l.logIndex)), block: Number(BigInt(l.blockNumber)), from, to,
      amount: to === config.usdc.vault ? value : -value, date: blocks.get(l.blockNumber)! });
  }
  return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

/**
 * Lee las transferencias nuevas de la bóveda (con USDC_CONFIRMATIONS de margen) y las pasa a la
 * conciliación de tesorería (treasury.ingestChainTransfers). Devuelve cuántas leyó y conció.
 */
export async function syncUsdc(ingest: (t: ChainTransfer[]) => Promise<{ matched: number }>) {
  if (!usdcEnabled()) return { enabled: false };
  const latest = Number(BigInt(await rpc("eth_blockNumber", []))) - config.usdc.confirmations;
  const saved = await one(pool, "SELECT value FROM treasury_kv WHERE key='usdc_block'");
  let from = saved ? Number(saved.value) + 1 : config.usdc.startBlock ?? Math.max(0, latest - 5000);
  let read = 0, matched = 0;
  while (from <= latest) {
    const to = Math.min(latest, from + config.usdc.maxRange - 1);
    const transfers = await vaultTransfers(from, to);
    read += transfers.length;
    matched += (await ingest(transfers)).matched;
    await pool.query(`INSERT INTO treasury_kv (key, value) VALUES ('usdc_block', $1)
                      ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [String(to)]);
    from = to + 1;
  }
  return { enabled: true, latestBlock: latest, transfers: read, matched };
}

export function usdcInfo() {
  return { enabled: usdcEnabled(), chain: config.usdc.chain, token: usdcToken() || null, vault: config.usdc.vault || null, confirmations: config.usdc.confirmations };
}

export function assertAddress(a: string) {
  if (!isAddress(a)) throw bad("invalid_address", "Dirección inválida: debe ser 0x seguido de 40 caracteres hexadecimales");
  return a.toLowerCase();
}
