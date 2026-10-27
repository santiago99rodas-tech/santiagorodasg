import { test } from "node:test";
import assert from "node:assert/strict";
import { tradePriceUpdate } from "../src/engine/quoting.js";
import { SCENARIOS, runMany, DEFAULT_LIQUIDITY } from "../src/sim/engine.js";
import { strategies } from "../src/sim/run.js";

test("cruces contra otros: el precio se acerca al precio negociado, más cuanto más se negoció", () => {
  assert.equal(tradePriceUpdate(0.6, 0.4, 0, 1500), 0.6);
  const a = tradePriceUpdate(0.6, 0.4, 300, 1500), b = tradePriceUpdate(0.6, 0.4, 1500, 1500), c = tradePriceUpdate(0.6, 0.4, 9000, 1500);
  assert.ok(a < 0.6 && a > 0.55, String(a));
  assert.ok(b < a && Math.abs(b - 0.5) < 0.01, "con b acciones queda a mitad de camino (en log-odds)");
  assert.equal(c, b, "el peso no pasa el del precio anterior");
});

test("simulador con market makers externos: la casa no pierde el precio y los jugadores ven menos spread", () => {
  const v2p = strategies().find((s) => s.name === "v2+")!;
  const sc = SCENARIOS.find((s) => s.name === "normal")!;
  const alone = runMany(sc, v2p, 20, 7);
  const withMm = runMany(sc, { ...v2p, liquidity: DEFAULT_LIQUIDITY }, 20, 7);
  const rewarded = runMany(sc, { ...v2p, liquidity: { ...DEFAULT_LIQUIDITY, rewardDailyUsd: 20 } }, 20, 7);
  assert.ok(withMm.errorCents < alone.errorCents + 2, `error ${withMm.errorCents} vs ${alone.errorCents}`);
  assert.ok(withMm.halfSpread < alone.halfSpread, "spread más chico");
  assert.ok(withMm.mm.volumeShare > 0.2, "los market makers toman parte del flujo");
  assert.ok(withMm.pnlMean > 0, "la casa sigue ganando");
  // Los incentivos pasan plata de la casa a los market makers, peso por peso
  assert.ok(rewarded.mm.rewards > 0);
  assert.ok(Math.abs((alone.pnlMean - rewarded.pnlMean) - (alone.pnlMean - withMm.pnlMean) - rewarded.mm.rewards) < 1, "lo que cobran sale del resultado de la casa");
});
