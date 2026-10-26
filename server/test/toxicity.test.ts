import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, resetDb, player, bal, futureIso } from "./helpers.js";
import {
  markoutCents, addMarkout, emptyStats, toxicityScore, surchargeBps, flowImbalance, DEFAULT_TOXICITY as T,
} from "../src/engine/toxicity.js";
import { quoteV2, type EventState, type QuoteParamsV2 } from "../src/engine/quoting.js";
import { runMany, SCENARIOS, type Strategy } from "../src/sim/engine.js";
import { createEvent } from "../src/services/events.js";
import { placeOrder } from "../src/services/trading.js";
import { refreshQuotes, planQuotes } from "../src/services/marketmaker.js";
import { scoreMarkouts, toxicityReport, flowImbalances, flagNewsShocks, setSurchargeOverride, playerSurchargeBps } from "../src/services/toxicity.js";
import { config } from "../src/config.js";

// ---------- matemática ----------

test("markout: positivo si el precio justo se movió a favor de la apuesta", () => {
  assert.equal(markoutCents(50, 58, true), 8);
  assert.equal(markoutCents(50, 58, false), -8);
});

test("puntaje: pocas apuestas o suerte no marcan; ventaja constante sí", () => {
  let lucky = emptyStats();
  for (let i = 0; i < 5; i++) lucky = addMarkout(lucky, 40, 20);
  assert.equal(toxicityScore(lucky, T), 0, "menos de 10 apuestas");
  let casual = emptyStats();
  for (let i = 0; i < 200; i++) casual = addMarkout(casual, i % 2 ? 30 : -30, 15); // gana y pierde
  assert.ok(toxicityScore(casual, T) < 0);
  assert.equal(surchargeBps(toxicityScore(casual, T), T), 0);
  let sharp = emptyStats();
  for (let i = 0; i < 40; i++) sharp = addMarkout(sharp, i % 4 ? 12 : -4, 100); // casi siempre acierta
  assert.ok(toxicityScore(sharp, T) > T.fullCents);
  assert.equal(surchargeBps(toxicityScore(sharp, T), T), T.maxSurchargeBps);
  assert.equal(surchargeBps((T.startCents + T.fullCents) / 2, T), Math.round(T.maxSurchargeBps / 2));
});

test("desequilibrio: con poco volumen no cuenta; con todo a un lado abre ese lado del spread", () => {
  assert.equal(flowImbalance(100, 0, T), 0);
  assert.equal(flowImbalance(300, 100, T), 0.5);
  const P: QuoteParamsV2 = { levels: 1, levelSizeShares: 200, bShares: 1500, minLiquidity: 0.15, tauRefDays: 7, gamma: 0.5, kappa: 12,
    sigmaFloor: 0.25, holdDays: 1, minHalfSpreadCents: 1, maxLossUsd: 2000, imbalanceSpread: 0.25, shockSpreadMult: 2, shockSizeFactor: 0.5 };
  const ev = (o: Partial<EventState["outcomes"][0]>): EventState => ({ kind: "binary", tauDays: 20, outcomes: [{ fair: 50, yesShares: 0, noShares: 0, costUsd: 0, ...o }] });
  const px = (e: EventState) => { const q = quoteV2(e, P).quotes; return { bid: q.find((x) => x.kind === "BUY_YES")!, ask: q.find((x) => x.kind === "BUY_NO")! }; };
  const calm = px(ev({})), hit = px(ev({ imbalance: 1 })), shock = px(ev({ shock: true }));
  assert.ok(hit.ask.yesPrice > calm.ask.yesPrice, "compran Sí: sube la oferta");
  assert.equal(hit.bid.yesPrice, calm.bid.yesPrice, "la puja no cambia");
  assert.ok(shock.ask.yesPrice - shock.bid.yesPrice > calm.ask.yesPrice - calm.bid.yesPrice);
  assert.equal(shock.ask.shares, calm.ask.shares / 2);
});

test("simulador: v2+ marca a los informados, no a los casuales, y la casa gana más", () => {
  const P: QuoteParamsV2 = { levels: 3, levelSizeShares: 200, bShares: 1500, minLiquidity: 0.15, tauRefDays: 7, gamma: 0.5, kappa: 12,
    sigmaFloor: 0.25, holdDays: 1, minHalfSpreadCents: 1, maxLossUsd: 2000 };
  const common = { v1: { spreadCents: 4, levels: 3, levelSizeShares: 200, maxExposureUsd: 5000 }, v2: P, weights: { prev: 0.6, external: 0.5 }, feeBps: 200, tox: T };
  const sc = SCENARIOS.find((s) => s.name === "informados")!;
  const v2 = runMany(sc, { name: "v2", ...common } as Strategy, 30, 3);
  const plus = runMany(sc, { name: "v2+", ...common } as Strategy, 30, 3);
  assert.ok(plus.flagged.informado >= 0.5, `informados marcados ${plus.flagged.informado}`);
  assert.ok(plus.flagged.ruido <= 0.02, `casuales marcados ${plus.flagged.ruido}`);
  assert.ok(plus.pnlMean > v2.pnlMean);
  assert.ok(plus.agents.informado < v2.agents.informado);
});

// ---------- servidor ----------

let marketId: number;
before(async () => {
  await resetDb();
  config.mm.strategy = "v2";
  config.integrity.maxStakePerMarketUsd = 0;
  const ev = await createEvent({
    title: "¿Ganará Ecuador la Copa Mundial de Tenis de Mesa de prueba?", category: "deportes", kind: "binary", closeTime: futureIso(20),
    outcomes: [{ label: "Sí", probability: 0.5 }], resolutionCriteria: "Resultado oficial.", resolutionSource: "ITTF",
  });
  marketId = ev.markets[0].id;
  config.mm.enabled = true;
  await refreshQuotes(marketId);
});
after(async () => { config.mm.enabled = false; await pool.end(); });

test("markouts reales: el que le gana a la casa paga recargo solo en lo que le compra a ella", async () => {
  const sharp = await player("sharp", 2000), casual = await player("casual", 2000);
  for (let i = 0; i < 12; i++) {
    await placeOrder(sharp, { marketId, side: "BUY", outcome: "YES", type: "MARKET", amount: 20 });
    await placeOrder(casual, { marketId, side: "BUY", outcome: i % 2 ? "YES" : "NO", type: "MARKET", amount: 20 });
    await refreshQuotes(marketId);
  }
  // Una hora después el precio justo subió a 80: el que compró Sí le ganó a la casa; el casual, mitad y mitad
  await pool.query("UPDATE trades SET created_at = now() - interval '3 hours'");
  await pool.query("INSERT INTO price_history (market_id, ts, price, fair) VALUES ($1, now() - interval '2 hours', 80, 80)", [marketId]);
  assert.equal(await scoreMarkouts(), 24);
  assert.equal(await scoreMarkouts(), 0, "cada markout se mide una sola vez");
  const rep = await toxicityReport();
  const s = rep.players.find((p) => p.externalId === "sharp")!, c = rep.players.find((p) => p.externalId === "casual")!;
  assert.equal(s.surchargeBps, config.toxicity.maxSurchargeBps);
  assert.equal(c.surchargeBps, 0);
  assert.ok(c.meanMarkoutCents < s.meanMarkoutCents);
  assert.equal(rep.flagged, 1);

  // Próxima compra: comisión 2% + recargo 3% sobre lo que cruza con la casa
  const before = bal("sharp");
  const r = await placeOrder(sharp, { marketId, side: "BUY", outcome: "YES", type: "MARKET", amount: 10 });
  assert.ok(Math.abs(r.fee - r.spent * 0.05 / 1.05) < 0.02, `comisión ${r.fee} sobre ${r.spent}`);
  assert.ok(Math.abs(before - bal("sharp") - 10) < 0.02);

  // Override manual
  await setSurchargeOverride(s.playerId, 0);
  assert.equal(await playerSurchargeBps(s.playerId), 0);
  await setSurchargeOverride(s.playerId, null);
  assert.equal(await playerSurchargeBps(s.playerId), config.toxicity.maxSurchargeBps);
});

test("desequilibrio del flujo y noticias de último momento", async () => {
  await pool.query("UPDATE trades SET created_at = now() - interval '10 minutes'");
  const imb = (await flowImbalances([marketId])).get(marketId)!;
  assert.ok(imb > 0.4, `desequilibrio ${imb}`); // casi todo fue al Sí
  const n = await flagNewsShocks([{ label: "Ecuador en la Copa Mundial de Tenis de Mesa", keywords: ["ecuador", "tenis", "mesa", "copa"], newest: Date.now() }]);
  assert.equal(n, 1);
  const plan = (await planQuotes(marketId))[0];
  assert.ok(plan.state.outcomes[0].shock);
  assert.ok(!plan.paused, "una noticia abre el spread pero no retira a la casa");
});
