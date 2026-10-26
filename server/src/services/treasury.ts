// Tesorería: cómo se mueve y se respalda el dinero real entre casinos y plataforma, sin blockchain.
//
//   - Libro contable de doble partida encadenado con hash (journal): cada asiento guarda el hash del
//     anterior, así que nadie puede cambiar la historia sin que se note (verifyJournal).
//   - Liquidaciones periódicas por casino (sale del informe de clearing.ts), con estado de cuenta
//     firmado con la clave Ed25519 del oráculo, plazo de pago, marca de pagada con la referencia de la
//     transferencia, y cobro de la garantía si vence sin pagar.
//   - Garantías de los casinos y reserva de la casa, depositadas en el fideicomiso.
//   - Pausa automática de la operación de un casino (sus jugadores no abren apuestas nuevas) si tiene
//     liquidaciones vencidas, garantía incompleta o deuda sobre su límite.
//   - Informe de reservas y conciliación con el extracto del banco.
//
// Cuentas del libro (montos en micro-dólares; positivo = a favor de la plataforma / dinero que tiene):
//   fideicomiso            dinero en la cuenta fiduciaria (garantías, reserva, liquidaciones por banco)
//   boveda_usdc            USDC en la bóveda multifirma (casinos que liquidan en USDC; ver chain.ts)
//   custodia_mm            dinero de los market makers externos (cuenta separada)
//   casino:<id>            lo que el casino le debe a la plataforma (> 0) o ella a él (< 0)
//   garantia:<id>          garantía del casino (pasivo: se le debe devolver; saldo negativo)
//   capital:reserva_casa   capital aportado como reserva de la casa (saldo negativo)
//   mm:<playerId>          lo que se le debe a cada market maker externo (saldo negativo)
//   compensacion           contrapartida de las liquidaciones: el resultado neto de la plataforma

import { createHash } from "node:crypto";
import { pool, many, one, tx, type Db } from "../db/pool.js";
import { config } from "../config.js";
import { bad, conflict, notFound } from "../lib/errors.js";
import { clearingReport } from "./clearing.js";
import { signed } from "./oracle.js";
import { riskTotals } from "./marketmaker.js";
import { usdcInfo, vaultBalance, assertAddress, type ChainTransfer } from "./chain.js";

/** Cuenta del libro donde entra y sale el dinero de un casino según cómo liquida. */
async function assetAccount(operatorId: string) {
  const r = await one(pool, "SELECT settlement_rail FROM operators WHERE id=$1", [operatorId]);
  return r?.settlement_rail === "usdc" ? "boveda_usdc" : "fideicomiso";
}

const GENESIS = "0".repeat(64);
const usd = (micro: number) => Math.round(micro) / 1e6;

// ---------- libro contable ----------

export interface Entry { account: string; amount: number }

/** JSON con las claves ordenadas: la misma entrada da siempre el mismo texto (y el mismo hash). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const hashOf = (prev: string, row: { id: number; ts: string; kind: string; ref: string | null; entries: Entry[]; memo: string; createdBy: string }) =>
  createHash("sha256").update(prev + "\n" + canonical(row)).digest("hex");

/** Agrega un asiento. Las partidas deben sumar 0 y ser enteras. Serializado con un candado de Postgres. */
export async function post(e: { kind: string; ref?: string | null; entries: Entry[]; memo?: string; by?: string }, db?: Db) {
  const entries = e.entries.filter((x) => x.amount !== 0).map((x) => ({ account: x.account, amount: Math.round(x.amount) }));
  if (entries.length < 2) throw bad("invalid_entry", "Un asiento necesita al menos dos partidas");
  if (entries.reduce((a, x) => a + x.amount, 0) !== 0) throw bad("unbalanced_entry", "Las partidas del asiento no suman cero");
  const run = async (c: Db) => {
    await c.query("SELECT pg_advisory_xact_lock(424242)");
    const last = await one(c, "SELECT hash FROM journal ORDER BY id DESC LIMIT 1");
    const id = Number((await one(c, "SELECT nextval('journal_id_seq')::bigint AS id"))!.id);
    const row = { id, ts: new Date().toISOString(), kind: e.kind, ref: e.ref ?? null, entries, memo: e.memo ?? "", createdBy: e.by ?? "sistema" };
    const prev = last?.hash ?? GENESIS;
    const hash = hashOf(prev, row);
    await c.query("INSERT INTO journal (id, ts, kind, ref, entries, memo, created_by, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, row.ts, row.kind, row.ref, JSON.stringify(entries), row.memo, row.createdBy, prev, hash]);
    return { id, hash };
  };
  return db ? run(db) : tx(run);
}

/** Recalcula toda la cadena. Si alguien editó o borró un asiento, dice desde cuál se rompe. */
export async function verifyJournal() {
  const rows = await many(pool, "SELECT * FROM journal ORDER BY id");
  let prev = GENESIS;
  for (const r of rows) {
    const row = { id: Number(r.id), ts: new Date(r.ts).toISOString(), kind: r.kind, ref: r.ref, entries: r.entries, memo: r.memo, createdBy: r.created_by };
    const sum = (r.entries as Entry[]).reduce((a, x) => a + Number(x.amount), 0);
    if (r.prev_hash !== prev) return { ok: false, entries: rows.length, brokenAt: row.id, reason: "falta un asiento o se cambió el orden" };
    if (hashOf(prev, row) !== r.hash) return { ok: false, entries: rows.length, brokenAt: row.id, reason: "el contenido del asiento fue modificado" };
    if (sum !== 0) return { ok: false, entries: rows.length, brokenAt: row.id, reason: "las partidas no suman cero" };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length, head: prev };
}

export async function balances(prefix?: string) {
  const rows = await many(pool, `
    SELECT e->>'account' AS account, SUM((e->>'amount')::bigint)::bigint AS balance
    FROM journal, jsonb_array_elements(entries) e
    WHERE $1::text IS NULL OR e->>'account' LIKE $1 || '%' GROUP BY 1 ORDER BY 1`, [prefix ?? null]);
  return new Map(rows.map((r) => [r.account as string, Number(r.balance)]));
}
const balanceOf = async (account: string) => (await balances(account)).get(account) ?? 0;
export const guaranteeOf = async (operatorId: string) => -(await balanceOf(`garantia:${operatorId}`));

export async function journalHead() {
  return (await one(pool, "SELECT id, hash FROM journal ORDER BY id DESC LIMIT 1")) ?? { id: 0, hash: GENESIS };
}

// ---------- garantías, reserva y custodia ----------

export async function moveGuarantee(operatorId: string, amountUsd: number, direction: "deposit" | "withdraw", by: string, bankRef?: string) {
  const op = await one(pool, "SELECT id FROM operators WHERE id=$1 AND kind='casino'", [operatorId]);
  if (!op) throw notFound("Casino no encontrado");
  const amount = Math.round(amountUsd * 1e6);
  if (!(amount > 0)) throw bad("invalid_amount", "Indica un monto positivo");
  if (direction === "withdraw" && amount > (await guaranteeOf(operatorId))) throw conflict("insufficient_guarantee", "El retiro supera la garantía disponible");
  const sign = direction === "deposit" ? 1 : -1;
  await post({ kind: direction === "deposit" ? "garantia_deposito" : "garantia_retiro", ref: bankRef ?? null, by,
    entries: [{ account: await assetAccount(operatorId), amount: sign * amount }, { account: `garantia:${operatorId}`, amount: -sign * amount }],
    memo: `${direction === "deposit" ? "Depósito" : "Retiro"} de garantía de ${operatorId}` });
  await evaluatePauses();
  return { operatorId, guarantee: await guaranteeOf(operatorId) };
}

export async function moveReserve(amountUsd: number, direction: "deposit" | "withdraw", by: string, bankRef?: string, rail: "bank" | "usdc" = "bank") {
  const amount = Math.round(amountUsd * 1e6);
  if (!(amount > 0)) throw bad("invalid_amount", "Indica un monto positivo");
  const sign = direction === "deposit" ? 1 : -1;
  await post({ kind: "reserva", ref: bankRef ?? null, by, memo: `${direction === "deposit" ? "Aporte a" : "Retiro de"} la reserva de la casa${rail === "usdc" ? " (USDC)" : ""}`,
    entries: [{ account: rail === "usdc" ? "boveda_usdc" : "fideicomiso", amount: sign * amount }, { account: "capital:reserva_casa", amount: -sign * amount }] });
  return { reserve: -(await balanceOf("capital:reserva_casa")) };
}

/** Depósito o retiro de un market maker externo en la cuenta de custodia (lo llama marketmakers.moveFunds). */
export async function recordMmCustody(playerId: number, amount: number, direction: "deposit" | "withdraw", by: string) {
  const sign = direction === "deposit" ? 1 : -1;
  await post({ kind: "custodia_mm", by, memo: `${direction === "deposit" ? "Depósito" : "Retiro"} del market maker ${playerId}`,
    entries: [{ account: "custodia_mm", amount: sign * amount }, { account: `mm:${playerId}`, amount: -sign * amount }] });
}

// ---------- liquidaciones ----------

/**
 * Emite la liquidación de cada casino desde la anterior hasta `to`: monto, estado de cuenta firmado,
 * plazo de pago y asiento contable. Si `onlyDue`, solo para los casinos cuya última liquidación tiene
 * más de SETTLEMENT_EVERY_HOURS.
 */
export async function runSettlement(opts: { to?: Date; onlyDue?: boolean; operatorId?: string } = {}) {
  const to = opts.to ?? new Date();
  const ops = await many(pool, `
    SELECT o.id, o.name, o.created_at, o.settlement_rail, o.usdc_address, (SELECT MAX(period_to) FROM settlements s WHERE s.operator_id = o.id) AS last_to
    FROM operators o WHERE o.kind='casino' AND ($1::text IS NULL OR o.id=$1) ORDER BY o.id`, [opts.operatorId ?? null]);
  const created: any[] = [];
  for (const o of ops) {
    const from = new Date(o.last_to ?? o.created_at);
    if (to.getTime() - from.getTime() < 60_000) continue;
    if (opts.onlyDue && to.getTime() - from.getTime() < config.treasury.settlementEveryHours * 3600e3) continue;
    const rep = await clearingReport({ from: from.toISOString(), to: to.toISOString(), operatorId: o.id });
    const row = rep.casinos[0];
    const amount = row?.due ?? 0;
    const id = Number((await one(pool, "SELECT nextval('settlements_id_seq')::bigint AS id"))!.id);
    const dueAt = new Date(to.getTime() + config.treasury.paymentTermHours * 3600e3);
    const s = await signed({
      type: "estado_de_cuenta", settlementId: id, operatorId: o.id, operator: o.name,
      period: { from: from.toISOString(), to: to.toISOString() },
      amountUsd: usd(amount), direction: amount > 0 ? "el casino paga a la plataforma" : amount < 0 ? "la plataforma paga al casino" : "sin saldo",
      paymentReference: `LIQ-${id}`, dueAt: dueAt.toISOString(),
      payment: o.settlement_rail === "usdc"
        ? { rail: "usdc", ...usdcInfo(), casinoAddress: o.usdc_address, amountUsdc: (Math.abs(amount) / 1e6).toFixed(6),
            instructions: amount > 0 ? "Transfiere exactamente este monto de USDC desde la dirección del casino a la bóveda" : amount < 0 ? "La plataforma transfiere este monto de USDC de la bóveda a la dirección del casino" : null }
        : { rail: "bank", instructions: amount !== 0 ? `Transferencia bancaria con la referencia LIQ-${id}` : null },
      detail: row ? { markets: row.markets, players: row.players, debitedUsd: usd(row.debited), creditedUsd: usd(row.credited), bondsNetUsd: usd(row.bondsNet),
        collectedUsd: usd(row.collected), feesUsd: usd(row.fees), revenueShareBps: row.revenueShareBps, revenueShareUsd: usd(row.revenueShare), playersResultUsd: usd(row.playersResult) } : null,
      guaranteeUsd: usd(await guaranteeOf(o.id)),
      journalHead: (await journalHead()).hash,
    });
    await tx(async (c) => {
      await c.query(`INSERT INTO settlements (id, operator_id, period_from, period_to, amount, details, status, due_at, paid_at, statement, signature, key_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, o.id, from, to, amount, JSON.stringify(row ?? {}), amount === 0 ? "paid" : "pending", dueAt, amount === 0 ? to : null, s.body, s.signature, s.keyId]);
      if (amount !== 0) {
        await post({ kind: "liquidacion", ref: `LIQ-${id}`, memo: `Liquidación de ${o.id} del ${from.toISOString().slice(0, 10)} al ${to.toISOString().slice(0, 10)}`,
          entries: [{ account: `casino:${o.id}`, amount }, { account: "compensacion", amount: -amount }] }, c);
      }
    });
    created.push({ id, operatorId: o.id, amount, status: amount === 0 ? "paid" : "pending", dueAt });
  }
  await evaluatePauses();
  return created;
}

/** Marca una liquidación como pagada con la referencia de la transferencia. */
export async function markPaid(id: number, opts: { bankRef: string; by: string; paidAt?: Date }) {
  if (!opts.bankRef?.trim()) throw bad("missing_bank_ref", "Indica la referencia de la transferencia");
  const s = await one(pool, "SELECT * FROM settlements WHERE id=$1", [id]);
  if (!s) throw notFound("Liquidación no encontrada");
  if (!["pending", "overdue"].includes(s.status)) throw conflict("not_payable", `La liquidación está ${s.status}`);
  const remaining = Number(s.amount) - Number(s.covered_from_guarantee);
  await tx(async (c) => {
    await c.query("UPDATE settlements SET status='paid', paid_at=$2, bank_ref=$3 WHERE id=$1", [id, opts.paidAt ?? new Date(), opts.bankRef.trim()]);
    await post({ kind: "pago_liquidacion", ref: opts.bankRef.trim(), by: opts.by, memo: `Pago de LIQ-${id} (${s.operator_id})`,
      entries: [{ account: await assetAccount(s.operator_id), amount: remaining }, { account: `casino:${s.operator_id}`, amount: -remaining }] }, c);
  });
  await evaluatePauses();
  return one(pool, "SELECT id, operator_id, amount, status, paid_at, bank_ref FROM settlements WHERE id=$1", [id]);
}

/** Cobra de la garantía del casino lo que adeuda una liquidación vencida (todo o lo que alcance). */
export async function collectFromGuarantee(id: number, by: string) {
  const s = await one(pool, "SELECT * FROM settlements WHERE id=$1", [id]);
  if (!s) throw notFound("Liquidación no encontrada");
  if (!["pending", "overdue"].includes(s.status) || Number(s.amount) <= 0) throw conflict("not_collectable", "Solo se cobra de la garantía una liquidación que el casino debe y no pagó");
  const remaining = Number(s.amount) - Number(s.covered_from_guarantee);
  const take = Math.min(remaining, await guaranteeOf(s.operator_id));
  if (take <= 0) throw conflict("no_guarantee", "El casino no tiene garantía disponible");
  await tx(async (c) => {
    await post({ kind: "garantia_cobro", ref: `LIQ-${id}`, by, memo: `Cobro de LIQ-${id} con la garantía de ${s.operator_id}`,
      entries: [{ account: `garantia:${s.operator_id}`, amount: take }, { account: `casino:${s.operator_id}`, amount: -take }] }, c);
    await c.query("UPDATE settlements SET covered_from_guarantee = covered_from_guarantee + $2, status = CASE WHEN covered_from_guarantee + $2 >= amount THEN 'covered' ELSE status END WHERE id=$1", [id, take]);
  });
  await evaluatePauses();
  return { settlementId: id, collected: take, remaining: remaining - take };
}

/** Marca vencidas las liquidaciones fuera de plazo y, si está configurado, las cobra de la garantía. */
export async function markOverdue() {
  const rows = await many(pool, "UPDATE settlements SET status='overdue' WHERE status='pending' AND due_at < now() RETURNING id, amount");
  if (config.treasury.autoCollectGuarantee) {
    for (const r of await many(pool, "SELECT id FROM settlements WHERE status='overdue' AND amount > covered_from_guarantee")) {
      await collectFromGuarantee(r.id, "sistema").catch(() => undefined);
    }
  }
  return rows.length;
}

// ---------- estado de cada casino y pausa ----------

export async function casinoStatus(operatorId?: string) {
  const ops = await many(pool, `SELECT id, name, guarantee_required, debt_limit, trading_paused, paused_reason, paused_manual, revenue_share_bps, settlement_rail, usdc_address
                                FROM operators WHERE kind='casino' AND ($1::text IS NULL OR id=$1) ORDER BY name`, [operatorId ?? null]);
  const bal = await balances();
  const out = [];
  for (const o of ops) {
    const last = await one(pool, "SELECT MAX(period_to) AS t FROM settlements WHERE operator_id=$1", [o.id]);
    const accrued = last?.t ? (await clearingReport({ from: new Date(last.t).toISOString(), operatorId: o.id })).casinos[0]?.due ?? 0 : 0;
    const balance = bal.get(`casino:${o.id}`) ?? 0; // > 0: debe liquidaciones emitidas
    const guarantee = -(bal.get(`garantia:${o.id}`) ?? 0);
    const overdue = await one(pool, "SELECT COUNT(*)::int AS n, COALESCE(SUM(amount - covered_from_guarantee),0)::bigint AS owed FROM settlements WHERE operator_id=$1 AND status='overdue' AND amount > 0", [o.id]);
    const required = Number(o.guarantee_required);
    const limited = required > 0 || o.debt_limit !== null;
    const limit = o.debt_limit !== null ? Number(o.debt_limit) : guarantee;
    const debt = Math.max(0, balance) + Math.max(0, accrued);
    const reasons: string[] = [];
    if (Number(overdue?.owed ?? 0) > 0) reasons.push(`${overdue!.n} liquidación(es) vencida(s) sin pagar`);
    if (required > 0 && guarantee < required) reasons.push(`garantía incompleta (${usd(guarantee)} de ${usd(required)} USD)`);
    if (limited && debt > limit) reasons.push(`deuda de ${usd(debt)} USD sobre su límite de ${usd(limit)} USD`);
    out.push({
      operatorId: o.id, name: o.name, rail: o.settlement_rail, usdcAddress: o.usdc_address, guarantee, guaranteeRequired: required, debtLimit: o.debt_limit === null ? null : Number(o.debt_limit),
      issuedBalance: balance, accrued, debt, overdueOwed: Number(overdue?.owed ?? 0),
      paused: o.trading_paused, pausedReason: o.paused_reason, pausedManual: o.paused_manual, shouldPause: reasons.length > 0, reasons,
    });
  }
  return out;
}

/** Pausa (o reanuda) la operación de cada casino según su estado. Una pausa manual no se levanta sola. */
export async function evaluatePauses() {
  const changes: { operatorId: string; paused: boolean; reason: string | null }[] = [];
  for (const c of await casinoStatus()) {
    if (c.pausedManual) continue;
    const reason = c.reasons.join("; ") || null;
    if (c.shouldPause !== c.paused || (c.shouldPause && reason !== c.pausedReason)) {
      await pool.query("UPDATE operators SET trading_paused=$2, paused_reason=$3 WHERE id=$1", [c.operatorId, c.shouldPause, reason]);
      if (c.shouldPause !== c.paused) {
        console.log(`[tesorería] ${c.operatorId}: operación ${c.shouldPause ? `pausada (${reason})` : "reanudada"}`);
        changes.push({ operatorId: c.operatorId, paused: c.shouldPause, reason });
      }
    }
  }
  return changes;
}

export async function setOperatorTreasury(operatorId: string, patch: { guaranteeRequiredUsd?: number; debtLimitUsd?: number | null; paused?: boolean; reason?: string; rail?: "bank" | "usdc"; usdcAddress?: string | null }) {
  const op = await one(pool, "SELECT id, usdc_address FROM operators WHERE id=$1 AND kind='casino'", [operatorId]);
  if (!op) throw notFound("Casino no encontrado");
  if (patch.usdcAddress !== undefined) await pool.query("UPDATE operators SET usdc_address=$2 WHERE id=$1", [operatorId, patch.usdcAddress ? assertAddress(patch.usdcAddress) : null]);
  if (patch.rail !== undefined) {
    const addr = patch.usdcAddress !== undefined ? patch.usdcAddress : op.usdc_address;
    if (patch.rail === "usdc" && !addr) throw bad("missing_address", "Para liquidar en USDC indica la dirección del casino");
    // Cambiar de vía con saldo pendiente descuadraría las cuentas: primero se liquida y se paga
    const open = await one(pool, "SELECT COUNT(*)::int AS n FROM settlements WHERE operator_id=$1 AND status IN ('pending','overdue')", [operatorId]);
    const g = await guaranteeOf(operatorId);
    if (open!.n > 0 || g > 0) throw conflict("rail_change_blocked", "Para cambiar la vía de liquidación el casino no puede tener liquidaciones abiertas ni garantía depositada (devuélvela y vuelve a depositarla por la vía nueva)");
    await pool.query("UPDATE operators SET settlement_rail=$2 WHERE id=$1", [operatorId, patch.rail]);
  }
  if (patch.guaranteeRequiredUsd !== undefined) await pool.query("UPDATE operators SET guarantee_required=$2 WHERE id=$1", [operatorId, Math.round(patch.guaranteeRequiredUsd * 1e6)]);
  if (patch.debtLimitUsd !== undefined) await pool.query("UPDATE operators SET debt_limit=$2 WHERE id=$1", [operatorId, patch.debtLimitUsd === null ? null : Math.round(patch.debtLimitUsd * 1e6)]);
  if (patch.paused !== undefined) {
    await pool.query("UPDATE operators SET paused_manual=$2, trading_paused=$2, paused_reason=$3 WHERE id=$1", [operatorId, patch.paused, patch.paused ? patch.reason ?? "pausa manual" : null]);
  }
  await evaluatePauses();
  return (await casinoStatus(operatorId))[0];
}

// ---------- reservas ----------

/** ¿Alcanza el dinero del fideicomiso para todo lo que se debe y para el riesgo abierto de la casa? */
export async function reservesReport() {
  const bal = await balances();
  const sum = (pre: string, f: (v: number) => number) => [...bal].filter(([k]) => k.startsWith(pre)).reduce((a, [, v]) => a + f(v), 0);
  const bank = bal.get("fideicomiso") ?? 0;
  const usdcBook = bal.get("boveda_usdc") ?? 0;
  const fiduciary = bank + usdcBook;
  let usdcChain: number | null = null, usdcError: string | null = null;
  try { usdcChain = await vaultBalance(); } catch (e) { usdcError = (e as Error).message; }
  const guarantees = sum("garantia:", (v) => -v);
  const payableToCasinos = sum("casino:", (v) => Math.max(0, -v));
  const receivableFromCasinos = sum("casino:", (v) => Math.max(0, v));
  const houseReserve = -(bal.get("capital:reserva_casa") ?? 0);
  const houseRisk = Math.round((await riskTotals()).worstCaseLossUsd * 1e6);
  const custody = bal.get("custodia_mm") ?? 0;
  const mmAccounts = await one(pool, `
    SELECT COALESCE((SELECT SUM(balance) FROM internal_balances),0)::bigint AS balances,
      COALESCE((SELECT SUM(o.reserved) FROM orders o JOIN players p ON p.id=o.player_id WHERE p.operator_id='mm' AND o.status='open' AND o.side='BUY'),0)::bigint AS reserved,
      COALESCE((SELECT SUM(ps.cost) FROM positions ps JOIN players p ON p.id=ps.player_id WHERE p.operator_id='mm'),0)::bigint AS positions`);
  const mmValue = Number(mmAccounts?.balances ?? 0) + Number(mmAccounts?.reserved ?? 0) + Number(mmAccounts?.positions ?? 0);
  const obligations = guarantees + payableToCasinos + houseRisk;
  return {
    fiduciary, bank, usdc: { ...usdcInfo(), book: usdcBook, onChain: usdcChain, difference: usdcChain === null ? null : usdcChain - usdcBook, error: usdcError },
    guarantees, payableToCasinos, receivableFromCasinos, houseReserve, houseRisk,
    obligations, coverage: obligations ? fiduciary / obligations : null, ok: fiduciary >= obligations,
    marketMakers: { custody, accounts: mmValue, ok: custody >= mmValue },
    journal: await journalHead(),
    note: "Dinero: fideicomiso (según el libro; concílialo con el extracto) más la bóveda USDC (el saldo real se lee de la cadena). Obligaciones: garantías que se deben devolver + liquidaciones por pagar a casinos + pérdida de la casa en el peor escenario.",
  };
}

// ---------- conciliación bancaria ----------

/**
 * Carga un extracto (CSV: fecha, referencia, monto, descripción; separador , o ;) y lo cruza con las
 * liquidaciones: por la referencia LIQ-<id> o, si no la tiene, por un único monto igual pendiente.
 * Una liquidación pendiente que aparece en el banco queda pagada.
 */
export async function importBankStatement(csv: string, by: string, account = "fideicomiso") {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw bad("empty_statement", "El extracto está vacío");
  const sep = lines[0].includes(";") ? ";" : ",";
  const rows = lines.filter((l, i) => !(i === 0 && /fecha|date/i.test(l))).map((l) => {
    const [date, reference, amount, ...desc] = l.split(sep).map((x) => x.trim().replace(/^"|"$/g, ""));
    const n = Number(sep === ";" ? amount.replace(/\./g, "").replace(",", ".") : amount.replace(/,/g, ""));
    if (!date || !reference || !Number.isFinite(n)) throw bad("invalid_line", `Línea inválida: ${l}`);
    return { date, reference, amount: Math.round(n * 1e6), description: desc.join(sep) };
  });
  let imported = 0, matched = 0;
  for (const r of rows) {
    const ins = await one(pool, `INSERT INTO bank_lines (account, date, reference, amount, description, status) VALUES ($1,$2,$3,$4,$5,'unmatched')
                                 ON CONFLICT DO NOTHING RETURNING id`, [account, r.date, r.reference, r.amount, r.description]);
    if (!ins) continue;
    imported++;
    const tag = `${r.reference} ${r.description}`.match(/LIQ-(\d+)/i);
    let s = tag ? await one(pool, "SELECT * FROM settlements WHERE id=$1 AND amount - covered_from_guarantee = $2", [Number(tag[1]), r.amount]) : null;
    if (!s) {
      const cands = await many(pool, "SELECT * FROM settlements WHERE status IN ('pending','overdue') AND amount - covered_from_guarantee = $1", [r.amount]);
      if (cands.length === 1) s = cands[0];
    }
    if (!s) continue;
    if (["pending", "overdue"].includes(s.status)) await markPaid(s.id, { bankRef: r.reference, by, paidAt: new Date(r.date) });
    await pool.query("UPDATE bank_lines SET status='matched', settlement_id=$2 WHERE id=$1", [ins.id, s.id]);
    matched++;
  }
  return { lines: rows.length, imported, matched, unmatched: imported - matched };
}

// ---------- USDC: conciliación con la cadena ----------

/**
 * Recibe las transferencias de la bóveda leídas de la cadena (chain.syncUsdc), las guarda como líneas
 * de la cuenta "usdc" y las cruza con las liquidaciones de los casinos que liquidan en USDC:
 * lo que entra desde la dirección del casino por el monto exacto que debe, o lo que sale hacia su
 * dirección por el monto exacto que se le debe, marca pagada la liquidación (referencia = hash de la tx).
 */
export async function ingestChainTransfers(transfers: ChainTransfer[]) {
  const casinos = await many(pool, "SELECT id, usdc_address FROM operators WHERE settlement_rail='usdc' AND usdc_address IS NOT NULL");
  const byAddr = new Map(casinos.map((c) => [String(c.usdc_address).toLowerCase(), c.id as string]));
  let matched = 0;
  for (const t of transfers) {
    const counterparty = t.amount > 0 ? t.from : t.to;
    const ins = await one(pool, `INSERT INTO bank_lines (account, date, reference, amount, description, status) VALUES ('usdc',$1,$2,$3,$4,'unmatched')
                                 ON CONFLICT DO NOTHING RETURNING id`,
      [t.date, `${t.txHash}:${t.logIndex}`, t.amount, `${t.amount > 0 ? "de" : "a"} ${counterparty} · bloque ${t.block}`]);
    if (!ins) continue;
    const op = byAddr.get(counterparty);
    if (!op) continue;
    const s = await one(pool, `SELECT id FROM settlements WHERE operator_id=$1 AND status IN ('pending','overdue') AND amount - covered_from_guarantee = $2
                               ORDER BY id LIMIT 1`, [op, t.amount]);
    if (!s) continue;
    await markPaid(s.id, { bankRef: t.txHash, by: "cadena", paidAt: new Date(t.date) });
    await pool.query("UPDATE bank_lines SET status='matched', settlement_id=$2 WHERE id=$1", [ins.id, s.id]);
    matched++;
  }
  return { matched };
}

/** Una línea sin conciliar (del banco o de la cadena) que en realidad es un depósito de garantía. */
export async function guaranteeFromLine(lineId: number, operatorId: string, by: string) {
  const l = await one(pool, "SELECT * FROM bank_lines WHERE id=$1 AND status='unmatched'", [lineId]);
  if (!l) throw notFound("Línea sin conciliar no encontrada");
  if (Number(l.amount) <= 0) throw bad("not_a_deposit", "Solo un ingreso puede ser un depósito de garantía");
  const expected = l.account === "usdc" ? "boveda_usdc" : "fideicomiso";
  if ((await assetAccount(operatorId)) !== expected) throw conflict("rail_mismatch", `El casino liquida por ${expected === "boveda_usdc" ? "banco" : "USDC"}: esta línea es de la otra vía`);
  const r = await moveGuarantee(operatorId, Number(l.amount) / 1e6, "deposit", by, String(l.reference).split(":")[0]);
  await pool.query("UPDATE bank_lines SET status='matched' WHERE id=$1", [lineId]);
  return r;
}

// ---------- resumen ----------

export async function treasuryOverview() {
  const [casinos, reserves, journal] = await Promise.all([casinoStatus(), reservesReport(), verifyJournal()]);
  const settlements = await many(pool, `SELECT s.id, s.operator_id, o.name, s.period_from, s.period_to, s.amount, s.status, s.due_at, s.paid_at, s.bank_ref, s.covered_from_guarantee
                                        FROM settlements s JOIN operators o ON o.id=s.operator_id ORDER BY s.id DESC LIMIT 100`);
  const unmatched = await many(pool, "SELECT * FROM bank_lines WHERE status='unmatched' ORDER BY date DESC, id DESC LIMIT 50");
  const anchors = await many(pool, "SELECT id, journal_id, head_hash, method, calendar, status, error, created_at FROM anchors ORDER BY id DESC LIMIT 20");
  const recent = await many(pool, "SELECT id, ts, kind, ref, entries, memo, created_by, hash FROM journal ORDER BY id DESC LIMIT 30");
  return { casinos, reserves, journal: { ...journal, recent }, settlements, unmatchedBankLines: unmatched, anchors, usdc: usdcInfo(),
    config: { ...config.treasury, anchorEnabled: config.anchor.enabled, anchorEveryHours: config.anchor.everyHours } };
}

export async function statementOf(id: number, operatorId?: string) {
  const s = await one(pool, "SELECT statement, signature, key_id, operator_id FROM settlements WHERE id=$1", [id]);
  if (!s || (operatorId && s.operator_id !== operatorId)) throw notFound("Estado de cuenta no encontrado");
  return s;
}
