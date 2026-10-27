import { test } from "node:test";
import assert from "node:assert/strict";
import { OrderBook, toYesPrice, notional } from "../src/engine/orderbook.js";

const S = 100; // 1 acción

test("BUY_YES cruza contra BUY_NO y crea un par (mint) al precio del maker", () => {
  const b = new OrderBook();
  // Alguien compra NO a 40 => ofrece Sí a 60
  b.add({ id: 1, ownerId: 10, kind: "BUY_NO", yesPrice: toYesPrice("NO", 40), remaining: 5 * S });
  const r = b.match({ id: 2, ownerId: 20, kind: "BUY_YES", yesLimit: 65, qty: 3 * S });
  assert.equal(r.filled, 3 * S);
  assert.deepEqual(r.fills.map((f) => [f.kind, f.yesPrice, f.qty]), [["mint", 60, 3 * S]]);
  assert.equal(r.spent, notional(60, 3 * S)); // el comprador de Sí paga 60 por acción
  assert.equal(b.get(1)!.remaining, 2 * S);
});

test("SELL_YES cruza contra SELL_NO y destruye el par (merge)", () => {
  const b = new OrderBook();
  b.add({ id: 1, ownerId: 10, kind: "SELL_NO", yesPrice: toYesPrice("NO", 45), remaining: 2 * S }); // bid Sí 55
  const r = b.match({ id: 2, ownerId: 20, kind: "SELL_YES", yesLimit: 50, qty: 2 * S });
  assert.equal(r.fills[0].kind, "merge");
  assert.equal(r.fills[0].yesPrice, 55);
  assert.equal(b.bestBid(), undefined);
});

test("transfer: BUY_YES contra SELL_YES y BUY_NO contra SELL_NO", () => {
  const b = new OrderBook();
  b.add({ id: 1, ownerId: 10, kind: "SELL_YES", yesPrice: 70, remaining: S });
  assert.equal(b.match({ id: 2, ownerId: 20, kind: "BUY_YES", yesLimit: 70, qty: S }).fills[0].kind, "transfer_yes");
  b.add({ id: 3, ownerId: 10, kind: "SELL_NO", yesPrice: toYesPrice("NO", 30), remaining: S });
  assert.equal(b.match({ id: 4, ownerId: 20, kind: "BUY_NO", yesLimit: toYesPrice("NO", 30), qty: S }).fills[0].kind, "transfer_no");
});

test("prioridad precio-tiempo y límite de precio", () => {
  const b = new OrderBook();
  b.add({ id: 1, ownerId: 1, kind: "SELL_YES", yesPrice: 62, remaining: S });
  b.add({ id: 2, ownerId: 2, kind: "SELL_YES", yesPrice: 60, remaining: S });
  b.add({ id: 3, ownerId: 3, kind: "SELL_YES", yesPrice: 60, remaining: S });
  const r = b.match({ id: 9, ownerId: 9, kind: "BUY_YES", yesLimit: 61, qty: 5 * S });
  assert.deepEqual(r.fills.map((f) => f.makerId), [2, 3]); // el de 62 queda fuera del límite
  assert.equal(r.filled, 2 * S);
  assert.equal(b.bestAsk(), 62);
});

test("no se cruza consigo mismo", () => {
  const b = new OrderBook();
  b.add({ id: 1, ownerId: 7, kind: "SELL_YES", yesPrice: 50, remaining: S });
  assert.equal(b.match({ id: 2, ownerId: 7, kind: "BUY_YES", yesLimit: 99, qty: S }).filled, 0);
});

test("compra de mercado por monto respeta el presupuesto", () => {
  const b = new OrderBook();
  b.add({ id: 1, ownerId: 1, kind: "SELL_YES", yesPrice: 50, remaining: 10 * S });
  // $3 a 50 centavos = 6 acciones
  const r = b.match({ id: 2, ownerId: 2, kind: "BUY_YES", yesLimit: 99, qty: Number.MAX_SAFE_INTEGER, budget: 3_000_000 });
  assert.equal(r.filled, 6 * S);
  assert.equal(r.spent, 3_000_000);
});

test("compra de NO paga el complemento del precio Sí", () => {
  const b = new OrderBook();
  b.add({ id: 1, ownerId: 1, kind: "BUY_YES", yesPrice: 70, remaining: 4 * S });
  const r = b.match({ id: 2, ownerId: 2, kind: "BUY_NO", yesLimit: toYesPrice("NO", 35), qty: 2 * S });
  assert.equal(r.fills[0].kind, "mint");
  assert.equal(r.spent, notional(30, 2 * S)); // NO a 30
});

test("dryRun no modifica el libro", () => {
  const b = new OrderBook();
  b.add({ id: 1, ownerId: 1, kind: "SELL_YES", yesPrice: 50, remaining: S });
  b.match({ id: 2, ownerId: 2, kind: "BUY_YES", yesLimit: 50, qty: S }, { dryRun: true });
  assert.equal(b.get(1)!.remaining, S);
});

test("niveles agregados", () => {
  const b = new OrderBook();
  b.add({ id: 1, ownerId: 1, kind: "BUY_YES", yesPrice: 48, remaining: S });
  b.add({ id: 2, ownerId: 2, kind: "SELL_NO", yesPrice: 48, remaining: 2 * S });
  b.add({ id: 3, ownerId: 3, kind: "BUY_NO", yesPrice: 52, remaining: S });
  assert.deepEqual(b.levels(), { bids: [[48, 3 * S]], asks: [[52, S]] });
  assert.equal(b.mid(), 50);
});
