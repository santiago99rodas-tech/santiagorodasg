// npm run sim -- [--runs 200] [--seed 1] [--scenario normal,multi5] [--set gamma=0.8] [--json] [--out ../docs/SIMULACION.md]
// npm run sim -- --liquidez [--runs 200] [--pozo 20] [--out ../docs/SIMULACION-LIQUIDEZ.md]
//
// Compara el market maker v1 con el v2 en cada escenario, con los parámetros de config (.env).
// Con --liquidez compara, con el v2+: solo la casa, la casa con market makers externos, y con incentivos.

import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { DEFAULT_TOXICITY } from "../engine/toxicity.js";
import { SCENARIOS, runMany, DEFAULT_LIQUIDITY, type Strategy, type Summary, type Liquidity } from "./engine.js";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const runs = Number(arg("runs") ?? 200);
const seed = Number(arg("seed") ?? 1);
const only = arg("scenario")?.split(",");

export function strategies(): Strategy[] {
  const mm = config.mm;
  const common = {
    v1: { spreadCents: mm.spreadCents, levels: mm.levels, levelSizeShares: mm.levelSizeShares, maxExposureUsd: mm.maxExposureUsd },
    v2: {
      levels: mm.levels, levelSizeShares: mm.levelSizeShares, bShares: mm.bShares, minLiquidity: mm.minLiquidity,
      tauRefDays: mm.tauRefDays, gamma: mm.gamma, kappa: mm.kappa, sigmaFloor: mm.sigmaFloor, holdDays: mm.holdDays,
      minHalfSpreadCents: mm.minHalfSpreadCents, maxLossUsd: mm.maxLossUsd,
    },
    weights: { prev: mm.weightPrev, external: mm.weightExternal },
    feeBps: config.takerFeeBps,
    tox: { ...DEFAULT_TOXICITY, ...config.toxicity },
  };
  // --set clave=valor cambia un parámetro de v2 para probar ajustes
  for (let i = 0; i < args.length; i++) if (args[i] === "--set") {
    const [k, v] = args[i + 1].split("=");
    if (k in common.v2) (common.v2 as any)[k] = Number(v);
    else if (k in common.tox) (common.tox as any)[k] = Number(v);
    else if (k in common.weights) (common.weights as any)[k] = Number(v);
    else throw new Error(`parámetro desconocido: ${k}`);
  }
  const only = arg("mm")?.split(",");
  return ([{ name: "v1", ...common }, { name: "v2", ...common }, { name: "v2+", ...common }] as Strategy[]).filter((st) => !only || only.includes(st.name));
}

const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("es", { maximumFractionDigits: 0 })}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function table(rows: { sc: string; v: string; s: Summary }[]) {
  const head = "| Escenario | MM | Resultado medio | Peor 5% | Peor caso | Mercados con pérdida | Margen sobre volumen | Pérdida máx. en riesgo | Caída máx. media | Medio spread | Error del precio | Brier apertura → 1 día antes |";
  const sep = "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|";
  const body = rows.map(({ sc, v, s }) =>
    `| ${sc} | ${v} | ${usd(s.pnlMean)} | ${usd(s.pnlP5)} | ${usd(s.pnlWorst)} | ${pct(s.lossShare)} | ${pct(s.margin)} | ${usd(s.peakWorstMax)} | ${usd(s.drawdownMean)} | ${s.halfSpread.toFixed(1)}¢ | ${s.errorCents.toFixed(1)}¢ | ${s.brierOpen.toFixed(3)} → ${s.brier1d.toFixed(3)} |`);
  return [head, sep, ...body].join("\n");
}

function agentsTable(rows: { sc: string; v: string; s: Summary }[]) {
  const head = "| Escenario | MM | Casuales | Informados | Hinchada | Ballenas | Con recargo: informados / casuales / hinchas / ballenas |";
  const sep = "|---|---|---:|---:|---:|---:|---|";
  return [head, sep, ...rows.map(({ sc, v, s }) =>
    `| ${sc} | ${v} | ${usd(s.agents.ruido)} | ${usd(s.agents.informado)} | ${usd(s.agents.hinchada)} | ${usd(s.agents.ballena)} | ${v === "v2+" ? `${pct(s.flagged.informado)} / ${pct(s.flagged.ruido)} / ${pct(s.flagged.hinchada)} / ${pct(s.flagged.ballena)}` : "—"} |`)].join("\n");
}

// ---------- liquidez externa ----------

export function liquiditySetups(pool: number): { label: string; liquidity?: Liquidity }[] {
  const base = { ...DEFAULT_LIQUIDITY, rebateBps: config.p2p.makerRebateBps, reward: { maxSpreadCents: config.rewards.maxSpreadCents, minShares: config.rewards.minShares, singleSidedFactor: config.rewards.singleSidedFactor },
    backstop: { cents: config.p2p.backstopCents, minShares: config.p2p.backstopMinShares, spreadMult: config.p2p.backstopSpreadMult } };
  return [
    { label: "Solo la casa" },
    { label: "Casa + 2 MM", liquidity: base },
    { label: `Casa + 2 MM + incentivos $${pool}/día`, liquidity: { ...base, rewardDailyUsd: pool } },
    { label: "Casa + 2 MM poco informados", liquidity: { ...base, noise: 0.7 } },
  ];
}

function liquidityTable(rows: { sc: string; v: string; s: Summary }[]) {
  const head = "| Escenario | Configuración | Casa | Mercados con pérdida (casa) | Market makers | Peor 5% (MM) | Parte del volumen de los MM | Reembolsos + incentivos | Medio spread | Casuales |";
  const sep = "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|";
  return [head, sep, ...rows.map(({ sc, v, s }) => v === "Solo la casa"
    ? `| ${sc} | ${v} | ${usd(s.pnlMean)} | ${pct(s.lossShare)} | — | — | — | — | ${s.halfSpread.toFixed(1)}¢ | ${usd(s.agents.ruido)} |`
    : `| ${sc} | ${v} | ${usd(s.pnlMean)} | ${pct(s.lossShare)} | ${usd(s.mm.pnl)} | ${usd(s.mm.pnlP5)} | ${pct(s.mm.volumeShare)} | ${usd(s.mm.rebates + s.mm.rewards)} | ${s.halfSpread.toFixed(1)}¢ | ${usd(s.agents.ruido)} |`)].join("\n");
}

function liquidityMain() {
  const t0 = Date.now(), pool = Number(arg("pozo") ?? 20);
  const v2p = strategies().find((x) => x.name === "v2+") ?? strategies().at(-1)!;
  const names = only ?? ["normal", "informados", "referencia", "multi5"];
  const rows: { sc: string; v: string; s: Summary }[] = [];
  for (const sc of SCENARIOS.filter((x) => names.includes(x.name))) {
    for (const setup of liquiditySetups(pool)) {
      rows.push({ sc: sc.label, v: setup.label, s: runMany(sc, { ...v2p, liquidity: setup.liquidity }, runs, seed) });
      process.stderr.write(".");
    }
  }
  process.stderr.write(` ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  if (args.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); return; }
  const md = [`${runs} mercados por escenario y configuración, semilla ${seed}, market maker de la casa v2+. Montos en dólares por mercado (promedio).`, "", liquidityTable(rows)].join("\n");
  console.log(md);
  const out = arg("out");
  if (out) writeFileSync(out, md + "\n");
}

if (process.argv[1]?.endsWith("run.ts")) (args.includes("--liquidez") ? liquidityMain : main)();

function main() {
const t0 = Date.now();
const rows: { sc: string; name: string; v: string; s: Summary }[] = [];
for (const sc of SCENARIOS.filter((s) => !only || only.includes(s.name))) {
  for (const st of strategies()) {
    rows.push({ sc: sc.label, name: sc.name, v: st.name, s: runMany(sc, st, runs, seed) });
    process.stderr.write(".");
  }
}
process.stderr.write(` ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else {
  const md = [
    `${runs} mercados por escenario, semilla ${seed}. Montos en dólares por mercado (promedio).`,
    "",
    "### Casa",
    "",
    table(rows),
    "",
    "### Resultado de cada tipo de jugador (promedio por mercado)",
    "",
    agentsTable(rows),
  ].join("\n");
  console.log(md);
  const out = arg("out");
  if (out) writeFileSync(out, md + "\n");
}
}
