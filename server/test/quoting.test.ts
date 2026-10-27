import { test } from "node:test";
import assert from "node:assert/strict";
import {
  poolLogOdds, lmsrPrices, lmsrMaxLoss, lmsrAvgPrice, flowUpdate, liquidityFactor, quoteV2, worstCaseLoss, scenarioPnl,
  type EventState, type QuoteParamsV2,
} from "../src/engine/quoting.js";
import { runMany, SCENARIOS, type Strategy } from "../src/sim/engine.js";

const P: QuoteParamsV2 = {
  levels: 3, levelSizeShares: 200, bShares: 1500, minLiquidity: 0.15, tauRefDays: 7, gamma: 0.5, kappa: 12,
  sigmaFloor: 0.25, holdDays: 1, minHalfSpreadCents: 1, maxLossUsd: 2000,
};
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("log-odds: 90% y 50% con el mismo peso dan 75%", () => {
  near(poolLogOdds([{ p: 0.9, w: 1 }, { p: 0.5, w: 1 }]), 0.75, 1e-9);
  near(poolLogOdds([{ p: 0.3, w: 2 }]), 0.3, 1e-9);
});

test("LMSR: precios suman 100%, comprar sube el precio y la pérdida máxima es b·ln n", () => {
  const lp = new Array(5).fill(Math.log(0.2));
  const p0 = lmsrPrices([0, 0, 0, 0, 0], lp, 300);
  near(p0.reduce((a, x) => a + x, 0), 1);
  const p1 = lmsrPrices([100, 0, 0, 0, 0], lp, 300);
  assert.ok(p1[0] > p0[0] && p1[1] < p0[1]);
  near(lmsrMaxLoss([0.2, 0.2, 0.2, 0.2, 0.2], 300), 300 * Math.log(5)); // ≈ $483
  // El precio promedio de un tramo queda entre el precio antes y después
  const avg = lmsrAvgPrice([0, 0, 0, 0, 0], lp, 300, 0, 100);
  assert.ok(avg > p0[0] && avg < p1[0]);
});

test("flujo: b acciones Sí netas suben el log-odds en 1", () => {
  near(flowUpdate("binary", [0.5], [1500], 1500)[0], 1 / (1 + Math.exp(-1)));
  const m = flowUpdate("multi", [0.5, 0.3, 0.2], [300, 0, 0], 300);
  near(m.reduce((a, x) => a + x, 0), 1);
  assert.ok(m[0] > 0.5 && m[1] < 0.3);
});

test("liquidez baja con la raíz del tiempo al cierre", () => {
  near(liquidityFactor(30, P), 1);
  near(liquidityFactor(7 / 4, P), 0.5);
  near(liquidityFactor(0, P), 0.15);
});

test("v2: bids por debajo de asks, menos tamaño cerca del cierre", () => {
  const ev: EventState = { kind: "binary", tauDays: 20, outcomes: [{ fair: 50, yesShares: 0, noShares: 0, costUsd: 0 }] };
  const { quotes } = quoteV2(ev, P);
  const bids = quotes.filter((q) => q.kind === "BUY_YES").map((q) => q.yesPrice);
  const asks = quotes.filter((q) => q.kind === "BUY_NO").map((q) => q.yesPrice);
  assert.equal(bids.length, 3);
  assert.ok(Math.max(...bids) < Math.min(...asks));
  assert.ok(Math.min(...asks) - Math.max(...bids) <= 6, "spread razonable");
  const late = quoteV2({ ...ev, tauDays: 0.2 }, P).quotes;
  assert.ok(late[0].shares < quotes[0].shares);
});

test("v2: con la pérdida en el peor escenario sobre el límite solo cotiza lo que reduce riesgo", () => {
  // La casa tiene 6.000 No: si gana Sí pierde lo pagado
  const ev: EventState = { kind: "binary", tauDays: 10, outcomes: [{ fair: 50, yesShares: 0, noShares: 6000, costUsd: 3000 }] };
  assert.deepEqual(scenarioPnl(ev), [-3000, 3000]);
  assert.equal(worstCaseLoss(ev), 3000);
  const { quotes, diag } = quoteV2(ev, P);
  assert.ok(diag.limited);
  assert.ok(quotes.length > 0 && quotes.every((q) => q.kind === "BUY_YES")); // comprar Sí la cubre
});

test("v2: en un evento múltiple las cotizaciones son coherentes entre opciones", () => {
  const ev: EventState = {
    kind: "multi", tauDays: 30,
    outcomes: [40, 30, 15, 10, 5].map((f) => ({ fair: f, yesShares: 0, noShares: 0, costUsd: 0 })),
  };
  const { quotes, diag } = quoteV2(ev, P);
  near(diag.prices.reduce((a, x) => a + x, 0), 100, 0.5);
  for (let i = 0; i < 5; i++) {
    const b = Math.max(...quotes.filter((q) => q.outcome === i && q.kind === "BUY_YES").map((q) => q.yesPrice), 0);
    const a = Math.min(...quotes.filter((q) => q.outcome === i && q.kind === "BUY_NO").map((q) => q.yesPrice));
    assert.ok(b < [40, 30, 15, 10, 5][i] + 1 && a > [40, 30, 15, 10, 5][i] - 1, `opción ${i}: ${b}/${a}`);
  }
});

test("v2: un jugador que sabe el resultado no le saca más que b·ln(1/π) a la casa", () => {
  // Sabe que gana Sí y compra todo lo que la casa ofrece hasta que el precio llega a 98
  let fair = [0.5];
  const yes = { house: 0, no: 0, cost: 0 };
  for (let round = 0; round < 500 && fair[0] < 0.98; round++) {
    const ev: EventState = { kind: "binary", tauDays: 30, outcomes: [{ fair: fair[0] * 100, yesShares: yes.house, noShares: yes.no, costUsd: yes.cost }] };
    const { quotes } = quoteV2(ev, { ...P, maxLossUsd: Infinity });
    let bought = 0;
    for (const q of quotes.filter((q) => q.kind === "BUY_NO")) {
      yes.no += q.shares; // la casa queda con No
      yes.cost += (q.shares * (100 - q.yesPrice)) / 100;
      bought += q.shares;
    }
    fair = flowUpdate("binary", fair, [bought], P.bShares);
  }
  const loss = worstCaseLoss({ kind: "binary", tauDays: 0, outcomes: [{ fair: 50, yesShares: yes.house, noShares: yes.no, costUsd: yes.cost }] });
  assert.ok(loss <= P.bShares * Math.log(2), `pérdida ${loss.toFixed(0)} ≤ ${(P.bShares * Math.log(2)).toFixed(0)}`);
  assert.ok(loss > 0);
});

test("simulador: v2 sigue la verdad mejor que v1 y la casa no pierde en promedio", () => {
  const common = {
    v1: { spreadCents: 4, levels: 3, levelSizeShares: 200, maxExposureUsd: 5000 },
    v2: P, weights: { prev: 0.6, external: 0.5 }, feeBps: 200,
  };
  const sc = SCENARIOS.find((s) => s.name === "normal")!;
  const v1 = runMany(sc, { name: "v1", ...common } as Strategy, 12, 5);
  const v2 = runMany(sc, { name: "v2", ...common } as Strategy, 12, 5);
  assert.ok(v2.errorCents < v1.errorCents, `error v2 ${v2.errorCents} < v1 ${v1.errorCents}`);
  assert.ok(v2.brier1d < 0.1);
  assert.ok(v2.pnlMean > 0);
});
