// Backend de demostración que corre en el navegador.
// Reproduce la API real (/v1/* y /admin/*) sobre estado en memoria: el mismo libro de órdenes CLOB,
// el market maker de la casa, la billetera del jugador, comisiones, resoluciones con ventana de disputa,
// moderación de borradores y jugadores simulados. Así el módulo del jugador y el back-office reales
// funcionan sin servidor. Unidades iguales al servidor: precio en centavos, cantidades en centésimas
// de acción, dinero en micro-dólares.
/* global CATALOG, CATEGORIES, SOURCES */
(function () {
  "use strict";

  // ---------- Reloj (permite simular el pasado al sembrar actividad) ----------
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const iso = (t) => new Date(t).toISOString();

  // ---------- Motor de órdenes (port de server/src/engine/orderbook.ts) ----------
  const isBid = (k) => k === "BUY_YES" || k === "SELL_NO";
  const isBuy = (k) => k === "BUY_YES" || k === "BUY_NO";
  const outcomeOf = (k) => (k.endsWith("YES") ? "YES" : "NO");
  const kindOf = (side, outcome) => `${side}_${outcome}`;
  const toYesPrice = (outcome, price) => (outcome === "YES" ? price : 100 - price);
  const ownPrice = (k, yes) => (outcomeOf(k) === "YES" ? yes : 100 - yes);
  const notional = (p, q) => p * q * 100;
  function fillKind(t, m) {
    const s = new Set([t, m]);
    if (s.has("BUY_YES") && s.has("SELL_YES")) return "transfer_yes";
    if (s.has("BUY_NO") && s.has("SELL_NO")) return "transfer_no";
    if (s.has("BUY_YES") && s.has("BUY_NO")) return "mint";
    return "merge";
  }
  class OrderBook {
    constructor() { this.bids = []; this.asks = []; }
    add(o) {
      const list = isBid(o.kind) ? this.bids : this.asks;
      const better = isBid(o.kind)
        ? (a) => a.yesPrice > o.yesPrice || (a.yesPrice === o.yesPrice && a.seq < o.seq)
        : (a) => a.yesPrice < o.yesPrice || (a.yesPrice === o.yesPrice && a.seq < o.seq);
      let i = 0;
      while (i < list.length && better(list[i])) i++;
      list.splice(i, 0, o);
    }
    remove(id) {
      for (const list of [this.bids, this.asks]) { const i = list.findIndex((o) => o.id === id); if (i >= 0) return list.splice(i, 1)[0]; }
    }
    ordersOf(owner) { return [...this.bids, ...this.asks].filter((o) => o.ownerId === owner); }
    bestBid() { return this.bids[0]?.yesPrice; }
    bestAsk() { return this.asks[0]?.yesPrice; }
    levels(depth = 10) {
      const agg = (list) => { const out = []; for (const o of list) { const l = out[out.length - 1]; if (l && l[0] === o.yesPrice) l[1] += o.remaining; else if (out.length < depth) out.push([o.yesPrice, o.remaining]); else break; } return out; };
      return { bids: agg(this.bids), asks: agg(this.asks) };
    }
    match(t, dry) {
      const bid = isBid(t.kind), book = bid ? this.asks : this.bids;
      const fills = []; let left = t.qty, budget = t.budget ?? Infinity, spent = 0; const touched = [];
      for (const m of book) {
        if (left <= 0) break;
        if (bid ? m.yesPrice > t.yesLimit : m.yesPrice < t.yesLimit) break;
        if (m.ownerId === t.ownerId) continue;
        let q = Math.min(left, m.remaining);
        const unit = notional(ownPrice(t.kind, m.yesPrice), 1);
        if (isBuy(t.kind) && Number.isFinite(budget)) q = Math.min(q, Math.floor(budget / unit));
        if (q <= 0) break;
        fills.push({ makerId: m.id, makerOwnerId: m.ownerId, makerKind: m.kind, yesPrice: m.yesPrice, qty: q, kind: fillKind(t.kind, m.kind) });
        touched.push([m, q]); left -= q; spent += q * unit; if (isBuy(t.kind)) budget -= q * unit;
      }
      if (!dry) for (const [m, q] of touched) { m.remaining -= q; if (m.remaining <= 0) this.remove(m.id); }
      return { fills, filled: t.qty - left, spent };
    }
  }

  // ---------- Errores con el mismo formato que la API ----------
  class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  const bad = (c, m) => new ApiError(400, c, m), conflict = (c, m) => new ApiError(409, c, m), notFound = (m = "No encontrado") => new ApiError(404, "not_found", m);

  // ---------- Estado ----------
  const FEE_BPS = 200, CHALLENGE_MS = 90 * 1000;
  // Mismos parámetros por defecto que el servidor (config.mm) para el market maker v2
  const MM = { levels: 3, levelSizeShares: 200, bShares: 1500, minLiquidity: 0.15, tauRefDays: 7, gamma: 0.5, kappa: 12,
    sigmaFloor: 0.25, holdDays: 1, minHalfSpreadCents: 1, maxLossUsd: 2000, maxTotalLossUsd: 50000 };
  const mmControl = { killed: false };
  const S = {
    events: [], markets: new Map(), books: new Map(), players: new Map(), orders: new Map(), trades: [], positions: new Map(),
    ledger: [], fees: [], history: new Map(), drafts: [], resolutions: [], trends: [], sources: [], signals: [], operators: [],
    seq: { event: 0, market: 0, order: 0, trade: 0, draft: 0, res: 0, trend: 0, source: 0, ledger: 0 },
  };
  const bookOf = (mid) => { let b = S.books.get(mid); if (!b) S.books.set(mid, (b = new OrderBook())); return b; };
  const posKey = (pid, mid, o) => `${pid}:${mid}:${o}`;
  const pos = (pid, mid, o) => { const k = posKey(pid, mid, o); let p = S.positions.get(k); if (!p) S.positions.set(k, (p = { playerId: pid, marketId: mid, outcome: o, qty: 0, reserved: 0, cost: 0, realized: 0 })); return p; };

  const listeners = new Set();
  const publish = (e) => listeners.forEach((fn) => { try { fn(e); } catch {} });

  // Jugadores: el usuario de la demo, bots y la casa
  const USER = 1, HOUSE = 99;
  S.players.set(USER, { id: USER, name: "Santiago Rodas", balance: 500e6, isHouse: false, lastSeen: now(), country: "EC", since: now() - 400 * 864e5 });
  S.players.set(HOUSE, { id: HOUSE, name: "Casa", balance: Infinity, isHouse: true });
  const BOT_NAMES = ["Carlos Mendoza", "Andrea Paredes", "Luis Guerrero", "María Fernanda", "Jorge Ruiz", "Daniela Vera", "Kevin Andrade", "Sofía León", "Diego Torres", "Valeria Cevallos"];
  const BOT_COUNTRIES = ["CO", "EC", "CO", "VE", "EC", "CO", "EC", "MX", "PE", "EC"];
  BOT_NAMES.forEach((n, i) => S.players.set(10 + i, { id: 10 + i, name: n, balance: 1e12, isHouse: false, lastSeen: now(), country: BOT_COUNTRIES[i], since: now() - (30 + i * 20) * 864e5 }));
  const mask = (pid) => { const p = S.players.get(pid); if (!p) return "Jugador"; const [a, b] = p.name.split(" "); return b ? `${a} ${b[0]}.` : a; };

  // Generador pseudoaleatorio estable
  let seed = 20261024;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

  // ---------- Eventos y mercados ----------
  const cents = (p) => Math.max(1, Math.min(99, Math.round(p * 100)));
  function slugify(s) { return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70); }
  function validateEvent(e) {
    if (!e.title || e.title.length < 8 || e.title.length > 200) throw bad("invalid_request", "title: entre 8 y 200 caracteres");
    if (!CATEGORIES.some(([s]) => s === e.category)) throw bad("invalid_category", `Categoría desconocida: ${e.category}`);
    if (!["binary", "multi"].includes(e.kind)) throw bad("invalid_request", "kind: binary o multi");
    if (!Array.isArray(e.outcomes) || !e.outcomes.length) throw bad("invalid_outcomes", "Faltan resultados");
    if (e.kind === "binary" && e.outcomes.length !== 1) throw bad("invalid_outcomes", "Un evento binario lleva un solo resultado (la probabilidad del Sí)");
    if (e.kind === "multi" && e.outcomes.length < 2) throw bad("invalid_outcomes", "Un evento múltiple necesita al menos 2 opciones");
    if (!(new Date(e.closeTime) > new Date(now()))) throw bad("invalid_close_time", "La fecha de cierre debe estar en el futuro");
    if (!e.resolutionCriteria || e.resolutionCriteria.length < 10) throw bad("invalid_request", "resolutionCriteria: mínimo 10 caracteres");
    if (!e.resolutionSource || e.resolutionSource.length < 3) throw bad("invalid_request", "resolutionSource: mínimo 3 caracteres");
  }
  function createEvent(input, opts = {}) {
    validateEvent(input);
    const id = ++S.seq.event;
    const ev = { id, slug: `${slugify(input.title)}-${id}`, title: input.title, description: input.description ?? "", category: input.category, imageUrl: input.imageUrl ?? null,
      kind: input.kind, negRisk: input.kind === "multi", status: "open", closeTime: input.closeTime, resolutionCriteria: input.resolutionCriteria, resolutionSource: input.resolutionSource,
      tags: input.tags ?? [], featured: !!input.featured, createdAt: opts.createdAt ?? iso(now()), marketIds: [], traders: new Set() };
    input.outcomes.forEach((o, i) => {
      const mid = ++S.seq.market, p = cents(o.probability);
      S.markets.set(mid, { id: mid, eventId: id, question: input.kind === "binary" ? input.title : `${input.title} · ${o.label}`, label: input.kind === "binary" ? "Sí" : o.label,
        status: "open", closeTime: input.closeTime, initial: p, last: p, fair: p, volume: 0, resolved: null, sort: i });
      S.history.set(mid, [{ t: opts.createdAt ? Date.parse(opts.createdAt) : now(), p }]);
      ev.marketIds.push(mid);
    });
    S.events.push(ev);
    if (opts.quote !== false) ev.marketIds.forEach((m) => refreshQuotes(m));
    return ev;
  }

  // ---------- Trading (port de server/src/services/trading.ts, sin base de datos) ----------
  function debit(pid, amount) {
    const p = S.players.get(pid);
    if (p.isHouse) return;
    if (amount > p.balance) throw new ApiError(402, "insufficient_funds", "Saldo insuficiente en el casino");
    p.balance -= amount;
    if (pid === USER) S.ledger.unshift({ tx_id: `d_${++S.seq.ledger}`, direction: "debit", amount, reason: "order", status: "ok", created_at: iso(now()) });
  }
  function credit(pid, amount, reason) {
    const p = S.players.get(pid);
    if (p.isHouse || amount <= 0) return;
    p.balance += amount;
    if (pid === USER) S.ledger.unshift({ tx_id: `c_${++S.seq.ledger}`, direction: "credit", amount, reason, status: "ok", created_at: iso(now()) });
  }
  const feeOf = (n, bps) => Math.ceil((n * bps) / 10000);

  function placeOrder(pid, input) {
    const m = S.markets.get(Number(input.marketId));
    if (!m) throw notFound("Mercado no encontrado");
    if (m.status !== "open" || new Date(m.closeTime) <= new Date(now())) throw conflict("market_closed", "El mercado está cerrado");
    const book = bookOf(m.id), kind = kindOf(input.side, input.outcome), buy = isBuy(kind);
    const player = S.players.get(pid), feeBps = player.isHouse ? 0 : FEE_BPS;
    let limitOwn, tif = input.tif ?? (input.type === "LIMIT" ? "GTC" : "FAK");
    if (input.type === "LIMIT") {
      if (!Number.isInteger(input.price) || input.price < 1 || input.price > 99) throw bad("invalid_price", "El precio debe ser un entero entre 1 y 99 centavos");
      limitOwn = input.price;
    } else {
      if (tif === "GTC") tif = "FAK";
      const bestYes = (buy ? input.outcome === "YES" : input.outcome === "NO") ? book.bestAsk() : book.bestBid();
      if (bestYes === undefined) throw conflict("no_liquidity", "No hay liquidez en este momento");
      const bestOwn = toYesPrice(input.outcome, bestYes);
      const slip = buy ? Math.min(99, bestOwn + 10) : Math.max(1, bestOwn - 10);
      limitOwn = input.price ? (buy ? Math.min(input.price, slip) : Math.max(input.price, slip)) : slip;
    }
    const yesLimit = toYesPrice(input.outcome, limitOwn);
    let qty, budget;
    if (input.type === "MARKET" && buy) {
      if (!(input.amount > 0)) throw bad("invalid_amount", "Indica el monto (amount) en USD");
      qty = Number.MAX_SAFE_INTEGER; budget = Math.floor((Math.round(input.amount * 1e6) * 10000) / (10000 + feeBps));
    } else {
      if (!(input.shares > 0)) throw bad("invalid_shares", "Indica la cantidad de acciones (shares)");
      qty = Math.round(input.shares * 100);
    }
    if (!buy) { const p = pos(pid, m.id, input.outcome); if (p.qty - p.reserved < qty) throw conflict("insufficient_shares", "No tienes suficientes acciones disponibles para vender"); }
    const dry = book.match({ ownerId: pid, kind, yesLimit, qty, budget }, true);
    if (tif === "FOK" && dry.filled < qty) throw conflict("fok_not_filled", "La orden no se puede llenar completa al precio indicado");
    if (tif !== "GTC" && dry.filled === 0) throw conflict("no_liquidity", "No hay liquidez al precio indicado");
    const restQty = tif === "GTC" ? qty - dry.filled : 0;
    const fillFees = dry.fills.map((f) => feeOf(notional(ownPrice(kind, f.yesPrice), f.qty), feeBps));
    const totalFee = fillFees.reduce((a, b) => a + b, 0);
    const restReserve = buy ? notional(limitOwn, restQty) : restQty;
    if (buy && !player.isHouse) {
      // Límite por jugador y mercado, igual que el servidor (MAX_STAKE_PER_MARKET_USD = 1000)
      let exposure = pos(pid, m.id, "YES").cost + pos(pid, m.id, "NO").cost;
      for (const o of S.orders.values()) if (o.playerId === pid && o.marketId === m.id && o.status === "open" && o.side === "BUY") exposure += o.reserved;
      if (exposure + dry.spent + restReserve > 1000e6) throw conflict("stake_limit", `Superas el máximo de $1000 comprometidos en este mercado (ya tienes $${(exposure / 1e6).toFixed(2)})`);
    }
    if (buy) debit(pid, dry.spent + totalFee + restReserve);

    const id = ++S.seq.order;
    const order = { id, marketId: m.id, playerId: pid, side: input.side, outcome: input.outcome, type: input.type, tif, price: limitOwn,
      qty: budget !== undefined ? dry.filled : qty, filled: dry.filled, reserved: restReserve, status: restQty > 0 ? "open" : "filled", createdAt: iso(now()) };
    if (restQty === 0 && dry.filled < qty && budget === undefined) order.status = "cancelled";
    S.orders.set(id, order);
    if (!player.isHouse) S.events.find((x) => x.id === m.eventId).traders.add(pid);
    if (!buy && restQty > 0) pos(pid, m.id, input.outcome).reserved += restQty;

    let takerProceeds = 0;
    dry.fills.forEach((f, i) => { takerProceeds += applyFill(m, id, pid, kind, f, fillFees[i]); });
    book.match({ ownerId: pid, kind, yesLimit, qty, budget }, false);
    if (restQty > 0) book.add({ id, ownerId: pid, kind, yesPrice: yesLimit, remaining: restQty, seq: id });
    if (!buy && takerProceeds > 0) credit(pid, takerProceeds, "sell_proceeds");

    if (dry.fills.length) {
      const last = dry.fills[dry.fills.length - 1].yesPrice;
      publish({ type: "price", marketId: m.id, eventId: m.eventId, price: last, at: iso(now()) });
      if (!player.isHouse) {
        const amount = dry.fills.reduce((a, f) => a + notional(ownPrice(kind, f.yesPrice), f.qty), 0);
        publish({ type: "trade", marketId: m.id, eventId: m.eventId, yesPrice: last, qty: dry.filled, outcome: input.outcome, side: input.side, amount, player: mask(pid), at: iso(now()) });
        player.lastSeen = now();
        const yesFlow = dry.fills.reduce((a, f) => a + f.qty, 0) / 100;
        learnFlow(m, kind === "BUY_YES" || kind === "SELL_NO" ? yesFlow : -yesFlow);
        refreshQuotes(m.id);
      }
    }
    const ownSpent = dry.fills.reduce((a, f) => a + notional(ownPrice(kind, f.yesPrice), f.qty), 0);
    return { orderId: id, status: restQty > 0 ? (dry.filled ? "partially_filled" : "open") : dry.filled ? "filled" : "cancelled", filledShares: dry.filled / 100,
      avgPrice: dry.filled ? Math.round((ownSpent / (dry.filled * 100)) * 100) / 100 : null, spent: buy ? ownSpent + totalFee : takerProceeds, fee: totalFee,
      restingShares: restQty / 100, fills: dry.fills.map((f) => ({ price: ownPrice(kind, f.yesPrice), shares: f.qty / 100 })) };
  }

  function applyFill(m, takerOrderId, takerId, takerKind, f, fee) {
    const tn = notional(ownPrice(takerKind, f.yesPrice), f.qty), mn = notional(ownPrice(f.makerKind, f.yesPrice), f.qty);
    S.trades.push({ id: ++S.seq.trade, marketId: m.id, makerOrderId: f.makerId, takerOrderId, takerId, yesPrice: f.yesPrice, qty: f.qty, kind: f.kind, fee, at: now() });
    if (fee > 0) S.fees.push({ amount: fee, at: now() });
    const mo = S.orders.get(f.makerId);
    const makerBuy = isBuy(f.makerKind);
    if (mo) { mo.filled += f.qty; mo.reserved = Math.max(0, mo.reserved - (makerBuy ? mn : f.qty)); if (mo.filled >= mo.qty) mo.status = "filled"; }
    if (makerBuy) addShares(f.makerOwnerId, m.id, outcomeOf(f.makerKind), f.qty, mn);
    else { removeShares(f.makerOwnerId, m.id, outcomeOf(f.makerKind), f.qty, mn, true); credit(f.makerOwnerId, mn, "sell_proceeds"); }
    let proceeds = 0;
    if (isBuy(takerKind)) addShares(takerId, m.id, outcomeOf(takerKind), f.qty, tn);
    else { removeShares(takerId, m.id, outcomeOf(takerKind), f.qty, tn - fee, false); proceeds = tn - fee; }
    m.last = f.yesPrice; m.volume += tn;
    S.history.get(m.id).push({ t: now(), p: f.yesPrice });
    return proceeds;
  }
  function addShares(pid, mid, o, q, cost) { const p = pos(pid, mid, o); p.qty += q; p.cost += cost; }
  function removeShares(pid, mid, o, q, proceeds, fromReserved) {
    const p = pos(pid, mid, o); const part = Math.round((p.cost * q) / p.qty);
    p.qty -= q; p.cost -= part; p.realized += proceeds - part; if (fromReserved) p.reserved -= q;
  }
  function cancelOrder(pid, oid, reason = "cancel") {
    const o = S.orders.get(oid);
    if (!o || (pid !== null && o.playerId !== pid)) throw notFound("Orden no encontrada");
    if (o.status !== "open") throw conflict("order_not_open", "La orden ya no está abierta");
    bookOf(o.marketId).remove(o.id); o.status = "cancelled";
    if (o.side === "SELL") pos(o.playerId, o.marketId, o.outcome).reserved = Math.max(0, pos(o.playerId, o.marketId, o.outcome).reserved - o.reserved);
    else credit(o.playerId, o.reserved, `order_${reason}_refund`);
    o.reserved = 0;
    return { orderId: o.id, status: "cancelled" };
  }
  const cancelAllInMarket = (mid, reason) => [...S.orders.values()].filter((o) => o.marketId === mid && o.status === "open").forEach((o) => cancelOrder(null, o.id, reason));

  // ---------- Market maker de la casa ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  /*__QUOTING__*/
  // Matemática de engine/quoting.ts (la inyecta build.mts): precio justo que aprende del flujo (LMSR),
  // spread Avellaneda-Stoikov, liquidez que baja con √(tiempo al cierre) y límites de pérdida.
  const eventMarkets = (m) => { const e = S.events.find((x) => x.id === m.eventId); return e.kind === "multi" ? e.marketIds.map((id) => S.markets.get(id)).filter((x) => x.status === "open") : [m]; };
  const tauOf = (m) => Math.max(0, (new Date(m.closeTime) - now()) / 864e5);
  function learnFlow(m, yesShares) {
    const ms = eventMarkets(m);
    const b = MM.bShares * liquidityFactor(tauOf(m), MM);
    const kind = ms.length > 1 ? "multi" : "binary";
    const prev = ms.map((x) => x.fairExact ?? x.fair / 100);
    const sum = prev.reduce((a, x) => a + x, 0);
    const next = flowUpdate(kind, kind === "multi" ? prev.map((x) => x / sum) : prev, ms.map((x) => (x.id === m.id ? yesShares : 0)), b);
    ms.forEach((x, i) => { x.fairExact = clamp(next[i], 0.02, 0.98); x.fair = clamp(Math.round(x.fairExact * 100), 2, 98); });
  }
  function eventState(m) {
    const ms = eventMarkets(m);
    return { ms, state: { kind: ms.length > 1 ? "multi" : "binary", tauDays: tauOf(m),
      outcomes: ms.map((x) => { const y = pos(HOUSE, x.id, "YES"), n = pos(HOUSE, x.id, "NO"); return { fair: x.fairExact != null ? x.fairExact * 100 : x.fair, yesShares: y.qty / 100, noShares: n.qty / 100, costUsd: (y.cost + n.cost) / 1e6 }; }) } };
  }
  function totalWorstLoss() {
    const seen = new Set(); let t = 0;
    for (const m of S.markets.values()) {
      if (!["open", "closed", "resolving"].includes(m.status) || seen.has(m.eventId)) continue;
      seen.add(m.eventId);
      const e = S.events.find((x) => x.id === m.eventId);
      const ms = e.marketIds.map((id) => S.markets.get(id));
      for (const g of e.kind === "multi" ? [ms] : ms.map((x) => [x])) t += worstCaseLoss({ kind: g.length > 1 ? "multi" : "binary", tauDays: 0,
        outcomes: g.map((x) => { const y = pos(HOUSE, x.id, "YES"), n = pos(HOUSE, x.id, "NO"); return { fair: 50, yesShares: y.qty / 100, noShares: n.qty / 100, costUsd: (y.cost + n.cost) / 1e6 }; }) });
    }
    return t;
  }
  function clearHouse(mid) {
    const book = bookOf(mid);
    for (const o of book.ordersOf(HOUSE)) { book.remove(o.id); const ord = S.orders.get(o.id); if (ord) ord.status = "cancelled"; }
  }
  function refreshQuotes(mid) {
    const m = S.markets.get(mid);
    if (!m || m.status !== "open") return;
    const { ms, state } = eventState(m);
    ms.forEach((x) => clearHouse(x.id));
    if (mmControl.killed) return;
    const { quotes } = quoteV2(state, { ...MM, riskOff: totalWorstLoss() > MM.maxTotalLossUsd });
    for (const q of quotes) quote(ms[q.outcome].id, q.kind, q.yesPrice, q.shares);
  }
  function mmStatus() {
    const seen = new Set(), events = [];
    for (const m of S.markets.values()) {
      if (m.status !== "open" || seen.has(m.eventId)) continue;
      seen.add(m.eventId);
      const { ms, state } = eventState(m);
      const { quotes, diag } = quoteV2(state, MM);
      const e = S.events.find((x) => x.id === m.eventId);
      events.push({ eventId: e.id, marketIds: ms.map((x) => x.id), title: e.title, kind: state.kind, tauDays: Math.round(state.tauDays * 10) / 10,
        liquidity: Math.round(diag.liquidity * 100) / 100, b: Math.round(diag.b), halfSpreadCents: Math.round(diag.halfSpreadCents * 10) / 10, prices: diag.prices,
        worstCaseLossUsd: Math.round(diag.worstCaseLossUsd), lmsrMaxLossUsd: Math.round(diag.lmsrMaxLossUsd), limited: diag.limited, quotes: quotes.length });
    }
    events.sort((a, b) => b.worstCaseLossUsd - a.worstCaseLossUsd);
    const worst = events.reduce((a, e) => a + e.worstCaseLossUsd, 0);
    return { strategy: "v2", enabled: true, killed: mmControl.killed, params: { ...MM, weightPrev: 0.6, weightExternal: 0.5 },
      limits: { maxLossUsd: MM.maxLossUsd, maxTotalLossUsd: MM.maxTotalLossUsd },
      totals: { worstCaseLossUsd: worst, riskOff: worst > MM.maxTotalLossUsd, limitedEvents: events.filter((e) => e.limited).length, events: events.length },
      events: events.slice(0, 100) };
  }
  function quote(mid, kind, yesPrice, shares) {
    // Cotización directa al libro (la casa no tiene billetera externa): no cruza, solo agrega liquidez
    const book = bookOf(mid);
    if (kind === "BUY_YES" && book.bestAsk() !== undefined && book.bestAsk() <= yesPrice) return;
    if (kind === "BUY_NO" && book.bestBid() !== undefined && book.bestBid() >= yesPrice) return;
    const id = ++S.seq.order, q = shares * 100;
    S.orders.set(id, { id, marketId: mid, playerId: HOUSE, side: "BUY", outcome: outcomeOf(kind), type: "LIMIT", tif: "GTC", price: ownPrice(kind, yesPrice), qty: q, filled: 0, reserved: notional(ownPrice(kind, yesPrice), q), status: "open", createdAt: iso(now()) });
    book.add({ id, ownerId: HOUSE, kind, yesPrice, remaining: q, seq: id });
  }

  // ---------- Resolución ----------
  function propose(eid, input) {
    const e = S.events.find((x) => x.id === eid);
    if (!e) throw notFound("Evento no encontrado");
    if (!["open", "closed", "resolving"].includes(e.status)) throw conflict("event_not_resolvable", `El evento está ${e.status}`);
    if (S.resolutions.some((r) => r.event_id === eid && r.status === "proposed")) throw conflict("resolution_pending", "Ya hay una propuesta en curso");
    let outcome = input.outcome;
    if (e.kind === "multi" && outcome !== "VOID") { if (!e.marketIds.includes(Number(input.winningMarketId))) throw bad("invalid_winner", "Indica el mercado ganador"); outcome = "YES"; }
    if (!outcome) throw bad("invalid_outcome", "Indica outcome: YES, NO o VOID");
    e.status = "resolving";
    e.marketIds.forEach((mid) => { const m = S.markets.get(mid); if (["open", "closed"].includes(m.status)) m.status = "resolving"; cancelAllInMarket(mid, "resolution"); publish({ type: "market", marketId: mid, eventId: eid, status: "resolving" }); });
    const r = { id: ++S.seq.res, event_id: eid, title: e.title, winning_market_id: e.kind === "multi" && outcome !== "VOID" ? Number(input.winningMarketId) : null, outcome,
      proposer: input.proposer, evidence: input.evidence ?? [], explanation: input.explanation ?? "", status: "proposed", challenge_ends_at: iso(now() + CHALLENGE_MS), created_at: iso(now()) };
    S.resolutions.unshift(r);
    return r;
  }
  function finalize(rid, force) {
    const r = S.resolutions.find((x) => x.id === rid);
    if (!r) throw notFound("Propuesta no encontrada");
    if (r.status === "finalized") return r;
    if (r.status === "disputed" && !force) throw conflict("disputed", "La propuesta está disputada: un administrador debe forzar la decisión");
    if (r.status === "rejected") throw conflict("rejected", "La propuesta fue rechazada");
    if (!force && new Date(r.challenge_ends_at) > new Date(now())) throw conflict("challenge_window", "La ventana de disputa sigue abierta");
    const e = S.events.find((x) => x.id === r.event_id);
    let payouts = 0;
    for (const mid of e.marketIds) {
      const m = S.markets.get(mid);
      const out = r.outcome === "VOID" ? "VOID" : e.kind === "multi" ? (mid === r.winning_market_id ? "YES" : "NO") : r.outcome;
      m.status = out === "VOID" ? "void" : "resolved"; m.resolved = out; m.last = out === "YES" ? 99 : out === "NO" ? 1 : 50;
      for (const p of S.positions.values()) {
        if (p.marketId !== mid || p.qty <= 0) continue;
        const per = out === "VOID" ? 500000 : p.outcome === out ? 1000000 : 0;
        const amount = (p.qty * per) / 100;
        p.realized += amount - p.cost; p.qty = 0; p.cost = 0; p.reserved = 0;
        if (amount > 0) { credit(p.playerId, amount, out === "VOID" ? "void_refund" : "payout"); payouts++; }
      }
      publish({ type: "market", marketId: mid, eventId: e.id, status: m.status });
    }
    e.status = r.outcome === "VOID" ? "void" : "resolved";
    r.status = "finalized"; r.finalized_at = iso(now());
    return { ...r, payouts };
  }
  setInterval(() => { S.resolutions.filter((r) => r.status === "proposed" && new Date(r.challenge_ends_at) <= new Date(now())).forEach((r) => { try { finalize(r.id); } catch {} }); }, 5000);

  // ---------- Lecturas (port de server/src/services/marketdata.ts) ----------
  function displayPrice(m) {
    if (m.status !== "open") return m.last;
    const b = bookOf(m.id), bid = b.bestBid(), ask = b.bestAsk();
    if (bid !== undefined && ask !== undefined && ask - bid <= 10) return Math.round((bid + ask) / 2);
    return m.last;
  }
  function priceAt(mid, t) { const h = S.history.get(mid); let p = h[0].p; for (const x of h) { if (x.t <= t) p = x.p; else break; } return p; }
  const H24 = 864e5;
  function serializeEvent(e) {
    const t24 = now() - H24;
    const trades = S.trades.filter((t) => e.marketIds.includes(t.marketId));
    const traders = e.traders;
    return {
      id: e.id, slug: e.slug, title: e.title, description: e.description, category: e.category, kind: e.kind, negRisk: e.negRisk, status: e.status, closeTime: e.closeTime,
      imageUrl: e.imageUrl, featured: e.featured, tags: e.tags, resolutionCriteria: e.resolutionCriteria, resolutionSource: e.resolutionSource,
      volume: e.marketIds.reduce((a, mid) => a + S.markets.get(mid).volume, 0),
      volume24h: trades.filter((t) => t.at > t24).reduce((a, t) => a + t.yesPrice * t.qty * 100, 0),
      traders: traders.size, createdAt: e.createdAt,
      markets: e.marketIds.map((mid) => {
        const m = S.markets.get(mid), price = displayPrice(m), b = bookOf(mid);
        return { id: mid, label: m.label, question: m.question, status: m.status, price, change24h: price - priceAt(mid, t24), bestBid: b.bestBid() ?? null, bestAsk: b.bestAsk() ?? null,
          lastPrice: m.last, volume: m.volume, resolvedOutcome: m.resolved };
      }),
    };
  }
  function spark(mid) {
    const h = S.history.get(mid), out = [], start = now() - 7 * H24;
    for (let t = start; t <= now(); t += 6 * 3600e3) out.push(priceAt(mid, t));
    return out;
  }
  function listEvents(f = {}) {
    const statuses = (f.status ?? "open").split(",");
    let list = S.events.filter((e) => statuses.includes(e.status) && (!f.category || e.category === f.category) && (!f.featured || e.featured));
    if (f.q) { const q = f.q.toLowerCase(); list = list.filter((e) => e.title.toLowerCase().includes(q) || e.marketIds.some((mid) => S.markets.get(mid).label.toLowerCase().includes(q))); }
    let out = list.map(serializeEvent);
    const sorts = {
      volume24h: (a, b) => b.volume24h - a.volume24h || b.volume - a.volume || b.id - a.id,
      volume: (a, b) => b.volume - a.volume || b.id - a.id,
      trending: (a, b) => (b.volume24h / 1e6 + 1) * (1 + Math.max(...b.markets.map((m) => Math.abs(m.change24h)))) - (a.volume24h / 1e6 + 1) * (1 + Math.max(...a.markets.map((m) => Math.abs(m.change24h)))),
      closing: (a, b) => a.closeTime.localeCompare(b.closeTime),
      new: (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
    };
    out.sort(sorts[f.sort] ?? sorts.volume24h);
    out = out.slice(f.offset ?? 0, (f.offset ?? 0) + Math.min(f.limit ?? 50, 200));
    if (f.spark) out.forEach((e) => e.markets.forEach((m) => (m.spark = spark(m.id))));
    return out;
  }
  function eventDetail(id) {
    const e = S.events.find((x) => x.id === Number(id) || x.slug === id);
    if (!e) throw notFound("Evento no encontrado");
    const r = S.resolutions.find((x) => x.event_id === e.id);
    return { ...serializeEvent(e), resolution: r ? { id: r.id, outcome: r.outcome, winning_market_id: r.winning_market_id, status: r.status, proposer: r.proposer, explanation: r.explanation, evidence: r.evidence, challenge_ends_at: r.challenge_ends_at } : null };
  }
  function priceHistory(mid, interval) {
    const span = { "1d": H24, "1w": 7 * H24, "1m": 30 * H24, all: 3650 * H24 }[interval] ?? 7 * H24;
    const bin = { "1d": 600e3, "1w": 3600e3, "1m": 6 * 3600e3, all: H24 }[interval] ?? 3600e3;
    const from = now() - span, h = S.history.get(mid), out = [{ t: iso(from), p: priceAt(mid, from) }];
    let lastBin = null;
    for (const x of h) { if (x.t <= from) continue; const b = Math.floor(x.t / bin); if (b === lastBin) out[out.length - 1] = { t: iso(x.t), p: x.p }; else out.push({ t: iso(x.t), p: x.p }); lastBin = b; }
    out.push({ t: iso(now()), p: displayPrice(S.markets.get(mid)) });
    return out;
  }
  function marketBook(mid) {
    const { bids, asks } = bookOf(mid).levels(15);
    const sh = (l) => l.map(([price, q]) => ({ price, shares: q / 100 }));
    return { marketId: mid, yes: { bids: sh(bids), asks: sh(asks) }, no: { bids: sh(asks.map(([p, q]) => [100 - p, q])), asks: sh(bids.map(([p, q]) => [100 - p, q])) } };
  }
  function recentTrades(limit = 30, mid) {
    return S.trades.filter((t) => t.takerId !== HOUSE && (!mid || t.marketId === mid)).slice(-limit).reverse().map((t) => {
      const o = S.orders.get(t.takerOrderId), m = S.markets.get(t.marketId), e = S.events.find((x) => x.id === m.eventId);
      const price = o.outcome === "YES" ? t.yesPrice : 100 - t.yesPrice;
      return { id: t.id, marketId: t.marketId, eventId: e.id, eventTitle: e.title, outcomeLabel: e.kind === "multi" ? m.label : null, player: mask(t.takerId), side: o.side, outcome: o.outcome, price, shares: t.qty / 100, amount: price * t.qty * 100, at: iso(t.at) };
    });
  }
  function stats() {
    const t24 = now() - H24, t48 = now() - 2 * H24;
    const vol = (from, to) => S.trades.filter((t) => t.at > from && t.at <= to).reduce((a, t) => a + t.yesPrice * t.qty * 100, 0);
    const open = S.events.filter((e) => e.status === "open");
    const byCat = new Map();
    for (const t of S.trades) if (t.at > t24) { const e = S.events.find((x) => x.id === S.markets.get(t.marketId).eventId); byCat.set(e.category, (byCat.get(e.category) ?? 0) + t.yesPrice * t.qty * 100); }
    const hourly = [];
    for (let i = 23; i >= 0; i--) { const h0 = Math.floor(now() / 3600e3) * 3600e3 - i * 3600e3; hourly.push({ t: iso(h0), volume: vol(h0, h0 + 3600e3) }); }
    const movers = open.map(serializeEvent).flatMap((e) => e.markets.map((m) => ({ eventId: e.id, marketId: m.id, title: e.title, label: e.kind === "multi" ? m.label : null, category: e.category, price: m.price, change24h: m.change24h })))
      .filter((m) => m.change24h).sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 20);
    return {
      volume_24h: vol(t24, now()), volume_prev_24h: vol(t48, t24), trades_24h: S.trades.filter((t) => t.at > t24 && t.takerId !== HOUSE).length,
      open_events: open.length, new_events_24h: S.events.filter((e) => Date.parse(e.createdAt) > t24).length,
      closing_24h: open.filter((e) => Date.parse(e.closeTime) < now() + H24).length,
      players_online: [...S.players.values()].filter((p) => !p.isHouse && p.lastSeen > now() - 300e3).length,
      byCategory: [...byCat.entries()].map(([c, v]) => ({ category: c, name: CATEGORIES.find(([s]) => s === c)?.[1] ?? c, volume: v })).sort((a, b) => b.volume - a.volume),
      hourlyVolume: hourly, movers,
    };
  }
  function positionsOf(pid) {
    return [...S.positions.values()].filter((p) => p.playerId === pid && (p.qty > 0 || p.realized !== 0)).map((p) => {
      const m = S.markets.get(p.marketId), e = S.events.find((x) => x.id === m.eventId);
      const yes = displayPrice(m), price = p.outcome === "YES" ? yes : 100 - yes, value = price * p.qty * 100;
      return { marketId: m.id, eventId: e.id, eventTitle: e.title, outcomeLabel: e.kind === "multi" ? m.label : null, category: e.category, outcome: p.outcome, shares: p.qty / 100,
        availableShares: (p.qty - p.reserved) / 100, avgPrice: p.qty ? Math.round((p.cost / p.qty / 100) * 100) / 100 : null, currentPrice: price, cost: p.cost, value,
        unrealizedPnl: value - p.cost, realizedPnl: p.realized, marketStatus: m.status, resolvedOutcome: m.resolved };
    });
  }
  function ordersOf(pid, status) {
    return [...S.orders.values()].filter((o) => o.playerId === pid && (status === "all" || o.status === status)).reverse().slice(0, 100).map((o) => {
      const m = S.markets.get(o.marketId), e = S.events.find((x) => x.id === m.eventId);
      return { id: o.id, market_id: o.marketId, side: o.side, outcome: o.outcome, order_type: o.type, tif: o.tif, price: o.price, shares: o.qty / 100, filled_shares: o.filled / 100, status: o.status, created_at: o.createdAt, question: m.question, outcome_label: m.label, event_title: e.title, kind: e.kind };
    });
  }
  function coverage() {
    return CATEGORIES.map(([slug, name]) => ({ slug, name, open_events: S.events.filter((e) => e.category === slug && e.status === "open").length,
      pending_drafts: S.drafts.filter((d) => d.status === "pending" && d.payload.category === slug).length, minimum: 25 }));
  }
  function overview() {
    const t24 = now() - H24;
    const house = [...S.positions.values()].filter((p) => p.playerId === HOUSE);
    const hourly = stats().hourlyVolume.map((h) => ({ ...h, trades: 0 }));
    return {
      volume_24h: stats().volume_24h, volume_total: [...S.markets.values()].reduce((a, m) => a + m.volume, 0),
      fees_24h: S.fees.filter((f) => f.at > t24).reduce((a, f) => a + f.amount, 0), fees_total: S.fees.reduce((a, f) => a + f.amount, 0),
      trades_24h: S.trades.filter((t) => t.at > t24).length, open_events: S.events.filter((e) => e.status === "open").length,
      awaiting_resolution: S.events.filter((e) => ["closed", "resolving"].includes(e.status)).length, players_total: S.players.size - 1,
      players_online: stats().players_online, pending_drafts: S.drafts.filter((d) => d.status === "pending").length,
      open_resolutions: S.resolutions.filter((r) => ["proposed", "disputed"].includes(r.status)).length, failed_credits: 0, pending_webhooks: 0,
      active_trends: S.trends.filter((t) => t.status === "active").length, sources_enabled: S.sources.filter((s) => s.enabled).length, sources_failing: 0,
      house_open_cost: house.reduce((a, p) => a + p.cost, 0), house_realized: house.reduce((a, p) => a + p.realized, 0), hourly, aiEnabled: false, autoApprove: false,
    };
  }
  function exposure() {
    const rows = [...S.markets.values()].filter((m) => ["open", "closed", "resolving"].includes(m.status)).map((m) => {
      const hy = pos(HOUSE, m.id, "YES"), hn = pos(HOUSE, m.id, "NO");
      let py = 0, pn = 0; for (const p of S.positions.values()) if (p.marketId === m.id && p.playerId !== HOUSE) { if (p.outcome === "YES") py += p.qty; else pn += p.qty; }
      return { id: m.id, question: m.question, status: m.status, last_price: m.last, fair_price: m.fair, volume: m.volume, house_yes: hy.qty, house_no: hn.qty, house_cost: hy.cost + hn.cost, players_yes: py, players_no: pn };
    }).sort((a, b) => b.house_cost - a.house_cost);
    const house = [...S.positions.values()].filter((p) => p.playerId === HOUSE);
    return { house: { open_cost: house.reduce((a, p) => a + p.cost, 0), realized: house.reduce((a, p) => a + p.realized, 0), fees: S.fees.reduce((a, f) => a + f.amount, 0) }, markets: rows };
  }


  // ---------- Calibración y sesgo (port de server/src/services/integrity.ts) ----------
  const COUNTRY = { colombia: "CO", ecuador: "EC", venezuela: "VE", "méxico": "MX", mexico: "MX", "perú": "PE", peru: "PE", argentina: "AR", chile: "CL", brasil: "BR", "puerto rico": "PR", "españa": "ES" };
  const ARCHIVE = []; // mercados históricos de demostración, ya resueltos
  const refs = [];
  function seedArchive() {
    const cats = CATEGORIES.map(([s]) => s), origins = ["ia", "catálogo o diseñador", "catálogo o diseñador", "borrador manual"];
    for (let i = 1; i <= 160; i++) {
      const q = 0.03 + rnd() * 0.94;                        // probabilidad "real"
      const yes = rnd() < q;
      const bias = q < 0.2 ? 0.06 : q > 0.8 ? -0.03 : 0;     // sesgo favorito-batacazo leve
      const noise = (s) => (rnd() - 0.5) * s;
      const pRef = { 24: clamp(q + bias + noise(0.08) + (yes ? 0.08 : -0.08), 0.02, 0.98), 168: clamp(q + bias + noise(0.1) + (yes ? 0.03 : -0.03), 0.02, 0.98), 720: clamp(q + bias + noise(0.2), 0.02, 0.98) };
      const cat = cats[Math.floor(rnd() * cats.length)];
      ARCHIVE.push({ id: -i, question: `[Demo] Mercado resuelto ${i} · ${CATEGORIES.find(([s]) => s === cat)[1]}`, category: cat, kind: "binary", outcome: yes ? "YES" : "NO",
        initial: clamp(q + noise(0.5), 0.03, 0.97), pRef, pClose: clamp(yes ? 0.9 + noise(0.1) : 0.1 + noise(0.1), 0.01, 0.99),
        volume: Math.round(Math.pow(10, 1 + rnd() * 2.6)) * 1e6, origin: origins[Math.floor(rnd() * origins.length)],
        proposer: rnd() < 0.55 ? "IA" : rnd() < 0.5 ? "admin:Laura" : "admin:Andrés", housePnl: Math.round((rnd() - 0.42) * 60e6) });
    }
  }
  function sessionResolved(h) {
    const out = [];
    for (const m of S.markets.values()) {
      if (m.resolved !== "YES" && m.resolved !== "NO") continue;
      const e = S.events.find((x) => x.id === m.eventId);
      const r = S.resolutions.find((x) => x.event_id === e.id);
      const end = Math.min(Date.parse(m.closeTime), r ? Date.parse(r.created_at) : Infinity);
      out.push({ id: m.id, question: m.question, category: e.category, kind: e.kind, outcome: m.resolved, initial: m.initial / 100,
        pRef: { [h]: priceAt(m.id, end - h * 3600e3) / 100 }, pClose: priceAt(m.id, end) / 100, volume: m.volume, origin: e.origin ?? "catálogo o diseñador",
        proposer: r ? (r.proposer.startsWith("ai:") ? "IA" : r.proposer) : "—", housePnl: pos(HOUSE, m.id, "YES").realized + pos(HOUSE, m.id, "NO").realized, end });
    }
    return out;
  }
  const brierOf = (rows, f) => (rows.length ? Math.round((rows.reduce((a, r) => a + (f(r) - (r.outcome === "YES" ? 1 : 0)) ** 2, 0) / rows.length) * 1e4) / 1e4 : null);
  function score(rows, h) {
    const n = rows.length, base = n ? rows.filter((r) => r.outcome === "YES").length / n : null;
    return { n, brierRef: brierOf(rows, (r) => r.pRef[h]), brierClose: brierOf(rows, (r) => r.pClose), brierInitial: brierOf(rows, (r) => r.initial),
      brierBaseRate: base == null ? null : Math.round(base * (1 - base) * 1e4) / 1e4, baseRate: base == null ? null : Math.round(base * 1000) / 1000 };
  }
  function integrity(h) {
    const rows = [...ARCHIVE, ...sessionResolved(h)];
    const o = (r) => (r.outcome === "YES" ? 1 : 0), r3 = (v) => Math.round(v * 1000) / 1000;
    const bins = Array.from({ length: 10 }, (_, i) => { const lo = i / 10, hi = (i + 1) / 10, b = rows.filter((r) => r.pRef[h] >= lo && (i === 9 ? r.pRef[h] <= hi : r.pRef[h] < hi));
      return { from: lo, to: hi, n: b.length, predicted: b.length ? r3(b.reduce((a, r) => a + r.pRef[h], 0) / b.length) : null, actual: b.length ? r3(b.reduce((a, r) => a + o(r), 0) / b.length) : null }; });
    const group = (f) => { const m = new Map(); for (const r of rows) { const k = f(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
    const tier = (v) => (v < 100e6 ? "menos de $100" : v < 1000e6 ? "$100 a $1.000" : "más de $1.000");
    const gap = (b) => (b.length ? r3(b.reduce((a, r) => a + (o(r) - r.pRef[h]), 0) / b.length) : null);
    const yesNo = [...group((r) => r.category)].map(([c, b]) => ({ category: c, name: CATEGORIES.find(([s]) => s === c)[1], yes: b.filter((r) => r.outcome === "YES").length, no: b.filter((r) => r.outcome === "NO").length, void: 0 }));
    // Integridad con datos de la sesión
    const flows = new Map();
    for (const t of S.trades) {
      const ord = S.orders.get(t.takerOrderId); if (!ord || ord.playerId === HOUSE || ord.side !== "BUY") continue;
      const amt = (ord.outcome === "YES" ? t.yesPrice : 100 - t.yesPrice) * t.qty * 100, k = `${t.marketId}`;
      if (!flows.has(k)) flows.set(k, []); flows.get(k).push({ pid: ord.playerId, outcome: ord.outcome, amt, at: t.at });
    }
    const title = (mid) => { const m = S.markets.get(mid), e = S.events.find((x) => x.id === m.eventId); return e.kind === "multi" ? `${e.title} · ${m.label}` : e.title; };
    const concentration = [], homeBias = [], alerts = [];
    for (const [k, fl] of flows) {
      const mid = Number(k), m = S.markets.get(mid);
      const byP = new Map(); fl.forEach((f) => byP.set(f.pid, (byP.get(f.pid) ?? 0) + f.amt));
      const amounts = [...byP.values()].sort((a, b) => b - a), total = amounts.reduce((a, b) => a + b, 0);
      if (m.status === "open" && total >= 200e6) { const top1 = amounts[0] / total, top5 = amounts.slice(0, 5).reduce((a, b) => a + b, 0) / total; if (top1 >= 0.5 || top5 >= 0.8) concentration.push({ marketId: mid, title: title(mid), total, players: amounts.length, top1: r3(top1), top5: r3(top5) }); }
      const code = COUNTRY[m.label.toLowerCase()];
      if (code) {
        const yesF = fl.filter((f) => f.outcome === "YES"), tot = yesF.reduce((a, f) => a + f.amt, 0);
        const e = S.events.find((x) => x.id === m.eventId), bettors = new Set();
        e.marketIds.forEach((x) => (flows.get(String(x)) ?? []).forEach((f) => bettors.add(f.pid)));
        if (tot >= 50e6 && bettors.size >= 3) {
          const home = yesF.filter((f) => S.players.get(f.pid).country === code).reduce((a, f) => a + f.amt, 0);
          const share = [...bettors].filter((p) => S.players.get(p).country === code).length / bettors.size;
          homeBias.push({ marketId: mid, title: title(mid), country: code, totalYes: tot, moneyFromHome: r3(home / tot), bettorsFromHome: r3(share), ratio: share ? Math.round((home / tot / share) * 100) / 100 : null });
        }
      }
      if (m.resolved === "YES" || m.resolved === "NO") {
        const r = S.resolutions.find((x) => x.event_id === m.eventId), end = Math.min(Date.parse(m.closeTime), r ? Date.parse(r.created_at) : Infinity);
        const late = new Map(); fl.filter((f) => f.outcome === m.resolved && f.at >= end - 120 * 60e3 && f.at <= end).forEach((f) => late.set(f.pid, (late.get(f.pid) ?? 0) + f.amt));
        for (const [pid, amt] of late) if (amt >= 100e6) alerts.push({ kind: "compra tardía ganadora", marketId: mid, title: title(mid), player: mask(pid), amount: amt, detail: `en los 120 min previos al cierre o a la propuesta` });
      }
    }
    alerts.push({ kind: "compra tardía ganadora", marketId: null, title: "[Demo] Mercado resuelto 42", player: "Kevin A. (demo-casino:kevin-a)", amount: 640e6, detail: "18 min antes de la propuesta · ejemplo de demostración" });
    const resolvers = [...group((r) => r.proposer)].filter(([p]) => p !== "—").map(([proposer, b]) => ({ proposer, events: b.length, house_won: b.filter((r) => r.housePnl > 0).length, house_pnl: b.reduce((a, r) => a + r.housePnl, 0) }));
    const external = refs.map((x) => { const m = S.markets.get(x.marketId), ours = displayPrice(m); return { marketId: x.marketId, title: title(x.marketId), source: x.source, refPrice: x.price, ourPrice: ours, diff: ours - x.price, capturedAt: x.capturedAt }; })
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    return { horizonHours: h, reliable: rows.length >= 30, minReliable: 30, overall: score(rows, h), calibration: bins,
      byCategory: [...group((r) => r.category)].map(([c, b]) => ({ category: c, name: CATEGORIES.find(([s]) => s === c)[1], ...score(b, h) })).sort((a, b) => b.n - a.n),
      byVolume: ["menos de $100", "$100 a $1.000", "más de $1.000"].map((t) => ({ tier: t, ...score(rows.filter((r) => tier(r.volume) === t), h) })),
      bias: { longshot: { longshots: { n: rows.filter((r) => r.pRef[h] < 0.2).length, gap: gap(rows.filter((r) => r.pRef[h] < 0.2)) }, favorites: { n: rows.filter((r) => r.pRef[h] > 0.8).length, gap: gap(rows.filter((r) => r.pRef[h] > 0.8)) } },
        yesNo, openingAccuracy: [...group((r) => r.origin)].map(([origin, b]) => ({ origin, ...score(b, h) })) },
      integrity: { concentration: concentration.sort((a, b) => b.top1 - a.top1), homeBias: homeBias.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0)), houseByResolver: resolvers, alerts, countryCoverage: S.players.size },
      external, thresholds: { minVolumeUsd: 200, alertMinUsd: 100, lateWindowMinutes: 120, maxStakePerMarketUsd: 1000 } };
  }

  // ---------- Enrutador: mismas rutas y formatos que la API real ----------
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn });
  const AI_OFF = () => { throw new ApiError(503, "ai_disabled", "En la demo la IA está desactivada. En producción, con ANTHROPIC_API_KEY, esta acción genera o resuelve preguntas investigando en la web."); };

  route("GET", "/v1/categories", () => CATEGORIES.map(([slug, name]) => ({ slug, name, open_events: S.events.filter((e) => e.category === slug && e.status === "open").length })));
  route("GET", "/v1/events", ({ q }) => listEvents({ category: q.category, status: q.status, sort: q.sort, q: q.q, featured: q.featured === "true", limit: Number(q.limit ?? 50), offset: Number(q.offset ?? 0), spark: q.spark === "1" || q.spark === "true" }));
  route("GET", "/v1/events/:id", ({ p }) => eventDetail(p.id));
  route("GET", "/v1/markets/:id/book", ({ p }) => marketBook(Number(p.id)));
  route("GET", "/v1/markets/:id/prices-history", ({ p, q }) => priceHistory(Number(p.id), q.interval));
  route("GET", "/v1/markets/:id/trades", ({ p }) => recentTrades(50, Number(p.id)));
  route("GET", "/v1/activity", ({ q }) => recentTrades(Math.min(Number(q.limit ?? 30), 100)));
  route("GET", "/v1/stats", () => stats());
  route("GET", "/v1/trends", () => S.trends);
  route("GET", "/v1/me", () => { const u = S.players.get(USER); u.lastSeen = now(); return { player: { id: USER, externalId: "jugador-demo", displayName: u.name }, operator: { name: "Casino Demo", currency: "USD", theme: { brandName: "TuCasino", primary: "#ffd400" } }, balance: u.balance }; });
  route("GET", "/v1/positions", () => positionsOf(USER));
  route("GET", "/v1/orders", ({ q }) => ordersOf(USER, q.status ?? "open"));
  route("POST", "/v1/orders", ({ b }) => ({ __status: 201, ...placeOrder(USER, b) }));
  route("DELETE", "/v1/orders/:id", ({ p }) => cancelOrder(USER, Number(p.id)));
  route("GET", "/v1/me/activity", () => S.ledger.slice(0, 100));

  route("GET", "/admin/overview", () => overview());
  route("GET", "/admin/events", ({ q }) => listEvents({ status: q.status ?? "open,closed,resolving,resolved,void", category: q.category || undefined, q: q.q || undefined, sort: q.sort ?? "new", limit: Number(q.limit ?? 50), offset: Number(q.offset ?? 0) }));
  route("POST", "/admin/events", ({ b }) => eventDetail(createEvent(b).id));
  route("PATCH", "/admin/events/:id", ({ p, b }) => { const e = S.events.find((x) => x.id === Number(p.id)); if (!e) throw notFound(); if (b.featured !== undefined) e.featured = b.featured; if (b.imageUrl !== undefined) e.imageUrl = b.imageUrl; if (b.description !== undefined) e.description = b.description; return e; });
  route("POST", "/admin/events/:id/close", ({ p }) => { const e = S.events.find((x) => x.id === Number(p.id)); if (!e) throw notFound(); let n = 0; if (e.status === "open") { e.status = "closed"; e.marketIds.forEach((mid) => { const m = S.markets.get(mid); if (m.status === "open") { m.status = "closed"; n++; cancelAllInMarket(mid, "market_closed"); } }); } return { closed: n }; });
  route("POST", "/admin/events/:id/resolve", ({ p, b, user }) => propose(Number(p.id), { ...b, proposer: user }));
  route("POST", "/admin/events/:id/ai-resolve", AI_OFF);
  route("GET", "/admin/resolutions", ({ q }) => S.resolutions.filter((r) => (q.status ?? "proposed,disputed").split(",").includes(r.status)));
  route("POST", "/admin/resolutions/:id/dispute", ({ p, b, user }) => { const r = S.resolutions.find((x) => x.id === Number(p.id) && x.status === "proposed"); if (!r) throw conflict("not_disputable", "La propuesta ya no está en ventana de disputa"); r.status = "disputed"; r.disputed_by = user; r.dispute_reason = b.reason ?? ""; return r; });
  route("POST", "/admin/resolutions/:id/reject", ({ p }) => { const r = S.resolutions.find((x) => x.id === Number(p.id)); if (!r || !["proposed", "disputed"].includes(r.status)) throw conflict("not_rejectable", "No se puede rechazar"); r.status = "rejected"; return r; });
  route("POST", "/admin/resolutions/:id/finalize", ({ p, b }) => finalize(Number(p.id), !!b.force));
  route("GET", "/admin/categories/coverage", () => coverage());
  route("POST", "/admin/categories/refill", AI_OFF);
  route("GET", "/admin/drafts", ({ q }) => S.drafts.filter((d) => d.status === (q.status ?? "pending")));
  route("POST", "/admin/drafts", ({ b, user }) => { const d = { id: ++S.seq.draft, payload: b, status: "pending", created_by: user, created_at: iso(now()) }; S.drafts.unshift(d); return d; });
  route("POST", "/admin/drafts/generate", AI_OFF);
  route("POST", "/admin/drafts/:id/approve", ({ p, b, user }) => {
    const d = S.drafts.find((x) => x.id === Number(p.id)); if (!d) throw notFound("Borrador no encontrado");
    if (d.status !== "pending") throw conflict("draft_reviewed", "El borrador ya fue revisado");
    const payload = { ...d.payload, ...(b.edits ?? {}) }; const ev = createEvent(payload);
    Object.assign(d, { status: "approved", reviewed_by: user, event_id: ev.id, payload }); return eventDetail(ev.id);
  });
  route("POST", "/admin/drafts/:id/reject", ({ p, b, user }) => { const d = S.drafts.find((x) => x.id === Number(p.id) && x.status === "pending"); if (!d) throw conflict("draft_reviewed", "Ya fue revisado"); Object.assign(d, { status: "rejected", review_note: b.note ?? "", reviewed_by: user }); return d; });
  route("GET", "/admin/trends", ({ q }) => S.trends.filter((t) => (q.status ?? "active,used").split(",").includes(t.status)));
  route("POST", "/admin/trends/detect", () => ({ trends: S.trends.length }));
  route("PATCH", "/admin/trends/:id", ({ p, b }) => { const t = S.trends.find((x) => x.id === Number(p.id)); if (t) t.status = b.status; return t; });
  route("POST", "/admin/social-signals", ({ b }) => { const list = Array.isArray(b) ? b : [b]; list.forEach((s) => S.signals.push({ ...s, captured_at: iso(now()) })); return { inserted: list.length }; });
  route("GET", "/admin/sources", () => S.sources);
  route("POST", "/admin/sources", ({ b }) => { const s = { id: ++S.seq.source, enabled: true, last_status: "nueva: se leerá en la próxima ingesta", last_fetched_at: null, ...b }; S.sources.push(s); return s; });
  route("PATCH", "/admin/sources/:id", ({ p, b }) => { const s = S.sources.find((x) => x.id === Number(p.id)); Object.assign(s, b); return s; });
  route("POST", "/admin/ingest/run", () => { throw new ApiError(503, "offline", "La demo corre sin conexión a internet. En el servidor real, la ingesta lee estas fuentes cada 30 minutos."); });
  route("GET", "/admin/exposure", () => exposure());
  route("GET", "/admin/integrity", ({ q }) => integrity([24, 168, 720].includes(Number(q.horizon)) ? Number(q.horizon) : 168));
  route("PATCH", "/admin/markets/:id", ({ p, b }) => { const m = S.markets.get(Number(p.id)); if (!m) throw notFound("Mercado no encontrado"); m.externalRef = b.externalRef; return { id: m.id, external_ref: m.externalRef }; });
  route("POST", "/admin/markets/:id/reference", ({ p, b }) => { const m = S.markets.get(Number(p.id)); if (!m) throw notFound("Mercado no encontrado"); const x = { marketId: m.id, source: b.source, price: Math.round(b.price), capturedAt: iso(now()) }; refs.push(x); return x; });
  route("POST", "/admin/references/refresh", () => { throw new ApiError(503, "offline", "La demo no tiene conexión a internet para leer Polymarket. En el servidor real se actualiza cada 30 minutos."); });
  route("POST", "/admin/mm/refresh", () => { let n = 0; for (const m of S.markets.values()) if (m.status === "open") { refreshQuotes(m.id); n++; } return { markets: n }; });
  route("GET", "/admin/mm/status", () => mmStatus());
  route("POST", "/admin/mm/kill", ({ b }) => {
    mmControl.killed = !!b.on; let n = 0;
    for (const m of S.markets.values()) if (m.status === "open") { if (mmControl.killed) { if (bookOf(m.id).ordersOf(HOUSE).length) { clearHouse(m.id); n++; } } else refreshQuotes(m.id); }
    return { killed: mmControl.killed, marketsCleared: n };
  });
  route("GET", "/admin/operators", () => S.operators);
  route("POST", "/admin/operators", ({ b }) => { const tok = () => Math.random().toString(36).slice(2, 14); const creds = { apiKey: `pk_${tok()}`, apiSecret: `sk_${tok()}${tok()}`, walletSecret: `ws_${tok()}${tok()}` };
    S.operators.push({ id: b.id, name: b.name, api_key: creds.apiKey, wallet_url: b.walletUrl, webhook_url: b.webhookUrl ?? null, currency: "USD", fee_bps: b.feeBps ?? null, theme: b.theme ?? {}, active: true }); return { id: b.id, ...creds }; });

  async function handle(url, opts = {}) {
    const u = new URL(url, "http://demo.local");
    const method = (opts.method ?? "GET").toUpperCase();
    const headers = opts.headers ?? {};
    const user = `admin:${headers["x-admin-user"] || "demo"}`;
    if (u.pathname.startsWith("/admin/") && !headers["x-admin-key"]) return json(401, { error: "unauthorized", message: "X-Admin-Key inválida" });
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = u.pathname.match(r.re);
      if (!m) continue;
      try {
        const out = r.fn({ p: m.groups ?? {}, q: Object.fromEntries(u.searchParams), b: opts.body ? JSON.parse(opts.body) : {}, user });
        const status = out && out.__status ? out.__status : 200;
        if (out && out.__status) delete out.__status;
        return json(status, out ?? {});
      } catch (e) {
        if (e instanceof ApiError) return json(e.status, { error: e.code, message: e.message });
        console.error(e);
        return json(500, { error: "internal_error", message: "Error interno de la demo" });
      }
    }
    return json(404, { error: "not_found", message: `Ruta no disponible en la demo: ${method} ${u.pathname}` });
  }
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // EventSource falso para /v1/stream
  function stream() {
    const handlers = {};
    const fn = (e) => (handlers[e.type] ?? []).forEach((h) => h({ data: JSON.stringify(e) }));
    listeners.add(fn);
    return { addEventListener: (type, h) => (handlers[type] ??= []).push(h), close: () => listeners.delete(fn), set onmessage(h) {}, set onerror(h) {} };
  }

  // ---------- Siembra: catálogo, historial, actividad, moderación ----------
  function backfill(mid, endPrice) {
    let s = mid * 7919, p = endPrice; const pts = [];
    const r = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    // Termina justo antes de la ventana de 24 h de actividad simulada, en el precio inicial
    for (let h = 49; h <= 14 * 24; h += 3) { p = clamp(p + Math.round((r() - 0.5) * 3), 2, 98); pts.push({ t: now() - h * 3600e3, p }); }
    S.history.set(mid, [...pts.reverse(), { t: now() - 2 * H24 - 60e3, p: endPrice }]);
  }
  function botBet() {
    const open = S.events.filter((e) => e.status === "open");
    // Más actividad en los mercados destacados y en los que ya se mueven
    const e = rnd() < 0.5 ? open[Math.floor(rnd() * Math.min(open.length, 60))] : open[Math.floor(rnd() * open.length)];
    const mid = e.marketIds[Math.floor(rnd() * e.marketIds.length)];
    const m = S.markets.get(mid);
    const yes = rnd() < displayPrice(m) / 100 + (rnd() - 0.5) * 0.2;
    const pid = 10 + Math.floor(rnd() * BOT_NAMES.length);
    try { placeOrder(pid, { marketId: mid, side: "BUY", outcome: yes ? "YES" : "NO", type: "MARKET", amount: [1, 2, 5, 5, 10, 10, 20, 25, 50][Math.floor(rnd() * 9)] }); } catch {}
  }

  function seedAll() {
    const t0 = performance.now();
    // Orden aleatorio estable para que no todos los mercados nuevos sean de la misma categoría
    const items = CATALOG.map((x, i) => [x, rnd() + i * 0]).sort((a, b) => a[1] - b[1]).map(([x]) => x);
    const held = [];
    for (const [i, it] of items.entries()) {
      if (new Date(it.closeTime) <= new Date(now())) continue;
      // Unos cuantos quedan como borradores "propuestos por la IA" para mostrar la moderación
      if (i % 90 === 7 && held.length < 8) { held.push(it); continue; }
      const createdAt = iso(now() - (2 + Math.floor(rnd() * 28)) * H24 - Math.floor(rnd() * H24));
      const ev = createEvent(it, { createdAt, quote: false });
      ev.marketIds.forEach((mid) => backfill(mid, S.markets.get(mid).initial));
    }
    for (const m of S.markets.values()) refreshQuotes(m.id);
    held.forEach((it) => S.drafts.push({ id: ++S.seq.draft, status: "pending", created_by: "ai:claude-opus-5-5", created_at: iso(now() - Math.floor(rnd() * 6 * 3600e3)),
      trend_label: it.tags?.[0] ?? null, payload: { ...it, rationale: "Tema con alta cobertura en varias fuentes y búsquedas en alza en Ecuador y Colombia; resolución clara con fuente oficial.", sourceUrls: [] } }));
    // 48 h de actividad simulada (con el reloj en el pasado), algo más intensa hoy que ayer
    const N = 560;
    for (let i = 0; i < N; i++) { const x = i / N; clockOffset = -2 * H24 + Math.pow(x, 0.85) * 2 * H24; botBet(); }
    clockOffset = 0;
    for (const p of S.players.values()) if (!p.isHouse) p.lastSeen = now() - Math.floor(rnd() * 120e3);
    // Escenarios para el panel de sesgo: hinchada colombiana en un mercado con opción "Colombia" y una ballena
    const colMk = [...S.markets.values()].find((m) => m.label === "Colombia" && m.status === "open");
    if (colMk) for (const [pid, amt] of [[10, 120], [12, 90], [15, 140], [11, 15], [18, 10]]) { clockOffset = -3 * 3600e3; try { placeOrder(pid, { marketId: colMk.id, side: "BUY", outcome: "YES", type: "MARKET", amount: amt }); } catch {} }
    const whaleEv = S.events.filter((e) => e.status === "open" && e.kind === "binary")[5];
    if (whaleEv) { clockOffset = -2 * 3600e3; try { placeOrder(16, { marketId: whaleEv.marketIds[0], side: "BUY", outcome: "YES", type: "MARKET", amount: 380 }); } catch {} }
    clockOffset = 0;
    for (const h of S.history.values()) h.sort((a, b) => a.t - b.t);
    seedArchive();
    S.events.filter((e) => e.status === "open").slice(0, 4).forEach((e, i) => { const m = S.markets.get(e.marketIds[0]); refs.push({ marketId: m.id, source: "Referencia demo", price: clamp(displayPrice(m) + [-3, 6, -12, 2][i], 1, 99), capturedAt: iso(now() - (i + 1) * 900e3) }); });
    // Tendencias y fuentes de ejemplo
    const T = [["Miss Universo 2026", ["miss universo", "colombia", "venezuela", "corona"], "reinados", 18.4, 14, 6, 3], ["GTA VI", ["gta vi", "rockstar", "lanzamiento", "precio"], "videojuegos", 16.9, 21, 7, 4],
      ["Avengers: Doomsday", ["avengers", "doomsday", "taquilla", "marvel"], "cine", 13.2, 12, 5, 2], ["Elecciones EE. UU. 2026", ["midterms", "cámara", "senado", "trump"], "elecciones", 12.7, 25, 8, 0],
      ["Bitcoin", ["bitcoin", "btc", "etf", "precio"], "cripto", 10.1, 16, 6, 1], ["Starship a Marte", ["spacex", "starship", "marte", "musk"], "espacio", 8.6, 9, 4, 1],
      ["Spotify Wrapped 2026", ["spotify", "wrapped", "bad bunny", "taylor swift"], "musica", 7.9, 8, 4, 2], ["Informe OVNI del Pentágono", ["ovni", "uap", "aaro", "congreso"], "ovnis", 6.2, 6, 3, 2]];
    T.forEach(([label, keywords, category, score, a, s, so], i) => S.trends.push({ id: ++S.seq.trend, label, keywords, category, score, article_count: a, source_count: s, social_count: so, last_seen: iso(now() - i * 1800e3), status: i < 2 ? "used" : "active" }));
    SOURCES.forEach((s, i) => S.sources.push({ id: ++S.seq.source, enabled: true, last_fetched_at: iso(now() - (5 + i) * 60e3), last_status: `ok: ${20 + ((i * 7) % 30)} ítems (datos de la demo)`, ...s }));
    S.operators.push({ id: "demo-casino", name: "Casino Demo", api_key: "pk_demo_casino", wallet_url: "https://casino-demo.example/wallet", webhook_url: "https://casino-demo.example/webhooks", currency: "USD", fee_bps: null, theme: { brandName: "TuCasino", primary: "#ffd400" }, active: true });
    console.info(`demo lista en ${Math.round(performance.now() - t0)} ms: ${S.events.length} eventos, ${S.markets.size} mercados`);
  }

  let botsOn = true;
  setInterval(() => { if (botsOn) botBet(); }, 2600);

  seedAll();
  window.DEMO = {
    fetch: (url, opts) => handle(url, opts),
    stream,
    balance: () => S.players.get(USER).balance,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    setBots: (on) => { botsOn = on; },
    botsOn: () => botsOn,
  };
})();
