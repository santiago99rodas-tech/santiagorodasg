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
    depthNear(exclude, price, cents) {
      const sum = (list, ok) => list.filter((o) => o.ownerId !== exclude && ok(o)).reduce((a, o) => a + o.remaining, 0);
      return { bids: sum(this.bids, (o) => o.yesPrice >= price - cents), asks: sum(this.asks, (o) => o.yesPrice <= price + cents) };
    }
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
  // Protección contra informados (engine/toxicity.ts). En la demo el tiempo va comprimido:
  // el markout "corto" se mide al minuto, el flujo se mira en 10 min y el freno en 2 min.
  const TOX = { minTrades: 10, confidenceZ: 2, startCents: 0.5, fullCents: 3, maxSurchargeBps: 300, imbalanceSpread: 0.12, imbalanceMinUsd: 150,
    breakerCents: 12, shockSpreadMult: 2, shockSizeFactor: 0.5, markoutMs: 60e3, flowWindowMs: 10 * 60e3, breakerWindowMs: 2 * 60e3, pauseMs: 30e3, shockMs: 3 * 60e3 };
  const flow = new Map(); // jugador → estadísticas de markout
  const overrides = new Map();
  const tradeLog = []; // cruces de jugadores pendientes de markout
  const surchargeOf = (pid) => overrides.has(pid) ? overrides.get(pid) : surchargeBps(toxicityScore(flow.get(pid) ?? emptyStats(), TOX), TOX);
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
  S.players.set(USER, { id: USER, name: "Santiago Rodas", balance: 500e6, isHouse: false, lastSeen: now(), country: "EC", since: now() - 400 * 864e5, operator: "demo-casino" });
  // Market maker externo de demostración: da liquidez con su propio saldo y cobra reembolso (server/src/services/marketmakers.ts)
  const MMBOT = 98, REBATE_BPS = 50;
  S.players.set(MMBOT, { id: MMBOT, name: "Liquidez Andina (demo)", balance: 25000e6, isHouse: false, isMM: true, active: true, rebateBps: REBATE_BPS, deposits: 25000e6, operator: "mm" });
  S.rebates = [];
  S.players.set(HOUSE, { id: HOUSE, name: "Casa", balance: Infinity, isHouse: true });
  const BOT_NAMES = ["Carlos Mendoza", "Andrea Paredes", "Luis Guerrero", "María Fernanda", "Jorge Ruiz", "Daniela Vera", "Kevin Andrade", "Sofía León", "Diego Torres", "Valeria Cevallos"];
  const BOT_COUNTRIES = ["CO", "EC", "CO", "VE", "EC", "CO", "EC", "MX", "PE", "EC"];
  BOT_NAMES.forEach((n, i) => S.players.set(10 + i, { id: 10 + i, name: n, balance: 1e12, isHouse: false, lastSeen: now(), country: BOT_COUNTRIES[i], since: now() - (30 + i * 20) * 864e5, operator: i % 2 ? "casino-aliado" : "demo-casino" }));
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
    if (buy && S.operators.find((o) => o.id === player.operator)?.trading_paused) throw conflict("operator_paused", "Las apuestas nuevas están pausadas temporalmente en este casino. Puedes vender tus posiciones y cobrar tus premios.");
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
      qty = Number.MAX_SAFE_INTEGER; budget = Math.floor((Math.round(input.amount * 1e6) * 10000) / (10000 + feeBps + (player.isHouse ? 0 : surchargeOf(pid))));
    } else {
      if (!(input.shares > 0)) throw bad("invalid_shares", "Indica la cantidad de acciones (shares)");
      qty = Math.round(input.shares * 100);
    }
    if (!buy) { const p = pos(pid, m.id, input.outcome); if (p.qty - p.reserved < qty) throw conflict("insufficient_shares", "No tienes suficientes acciones disponibles para vender"); }
    const dry = book.match({ ownerId: pid, kind, yesLimit, qty, budget }, true);
    if (input.postOnly) {
      const opp = isBid(kind) ? book.bestAsk() : book.bestBid();
      if (dry.filled > 0 || (opp !== undefined && (isBid(kind) ? yesLimit >= opp : yesLimit <= opp))) throw conflict("would_cross", "La orden post-only cruzaría con el libro");
    }
    if (tif === "FOK" && dry.filled < qty) throw conflict("fok_not_filled", "La orden no se puede llenar completa al precio indicado");
    if (tif !== "GTC" && dry.filled === 0) throw conflict("no_liquidity", "No hay liquidez al precio indicado");
    const restQty = tif === "GTC" ? qty - dry.filled : 0;
    const sur = player.isHouse ? 0 : surchargeOf(pid);
    const fillFees = dry.fills.map((f) => feeOf(notional(ownPrice(kind, f.yesPrice), f.qty), feeBps + (f.makerOwnerId === HOUSE ? sur : 0)));
    const totalFee = fillFees.reduce((a, b) => a + b, 0);
    const restReserve = buy ? notional(limitOwn, restQty) : restQty;
    if (buy && !player.isHouse && !player.isMM) {
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
        // Como en el servidor: las acciones cuentan solo en lo que se le compra a la casa; lo negociado con otros acerca el precio al del cruce
        const sign = kind === "BUY_YES" || kind === "SELL_NO" ? 1 : -1, other = dry.fills.filter((f) => f.makerOwnerId !== HOUSE);
        const otherQty = other.reduce((a, f) => a + f.qty, 0) / 100;
        learnFlow(m, (sign * dry.fills.filter((f) => f.makerOwnerId === HOUSE).reduce((a, f) => a + f.qty, 0)) / 100,
          otherQty, otherQty ? other.reduce((a, f) => a + f.qty * f.yesPrice, 0) / 100 / otherQty / 100 : NaN);
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
    if (takerId !== HOUSE) tradeLog.push({ pid: takerId, mid: m.id, yesPrice: f.yesPrice, yes: takerKind === "BUY_YES" || takerKind === "SELL_NO", usd: tn / 1e6, at: now(), short: false });
    if (fee > 0) S.fees.push({ amount: fee, at: now(), pid: takerId, mid: m.id });
    const mk = S.players.get(f.makerOwnerId);
    if (mk?.isMM && fee > 0) {
      const rebate = Math.floor(Math.min(fee, Math.floor((tn * mk.rebateBps) / 10000)) / 10000) * 10000;
      if (rebate > 0) { mk.balance += rebate; S.rebates.push({ pid: mk.id, amount: rebate, mid: m.id, at: now() }); }
    }
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
  function learnFlow(m, yesShares, otherShares = 0, otherVwap = NaN) {
    const ms = eventMarkets(m);
    const b = MM.bShares * liquidityFactor(tauOf(m), MM);
    const kind = ms.length > 1 ? "multi" : "binary";
    const prev = ms.map((x) => x.fairExact ?? x.fair / 100);
    const sum = prev.reduce((a, x) => a + x, 0);
    let next = flowUpdate(kind, kind === "multi" ? prev.map((x) => x / sum) : prev, ms.map((x) => (x.id === m.id ? yesShares : 0)), b);
    next = next.map((p, i) => (ms[i].id === m.id ? tradePriceUpdate(p, otherVwap, otherShares, b) : p));
    if (kind === "multi") { const z = next.reduce((a, x) => a + x, 0); next = next.map((x) => x / z); }
    ms.forEach((x, i) => { x.fairExact = clamp(next[i], 0.02, 0.98); x.fair = clamp(Math.round(x.fairExact * 100), 2, 98); trackFair(x); });
  }
  function trackFair(x) {
    const t = now();
    x.trail = (x.trail ?? []).filter((p) => t - p.t <= TOX.breakerWindowMs);
    x.trail.push({ t, fair: x.fairExact * 100 });
    const jump = Math.max(...x.trail.map((p) => Math.abs(p.fair - x.fairExact * 100)));
    if (breakerTripped(x.fairExact * 100 - jump, x.fairExact * 100, TOX)) { setShock([x.id], `Salto de precio de ${Math.round(jump)}¢ en 2 min`, true); x.trail = [{ t, fair: x.fairExact * 100 }]; }
  }
  function setShock(ids, reason, pause) {
    for (const id of ids) { const x = S.markets.get(id); if (!x || x.status !== "open") continue; x.shockUntil = Math.max(x.shockUntil ?? 0, now() + TOX.shockMs); if (pause) x.pausedUntil = now() + TOX.pauseMs; x.shockReason = reason; }
  }
  function imbalanceOf(mid) {
    let y = 0, n = 0; const t = now();
    for (let i = tradeLog.length - 1; i >= 0 && t - tradeLog[i].at <= TOX.flowWindowMs; i--) if (tradeLog[i].mid === mid) { if (tradeLog[i].yes) y += tradeLog[i].usd; else n += tradeLog[i].usd; }
    return flowImbalance(y, n, TOX);
  }
  function scoreMarkouts() {
    const t = now();
    for (const tr of tradeLog) {
      if (tr.short || t - tr.at < TOX.markoutMs) continue;
      const m = S.markets.get(tr.mid);
      tr.short = true;
      if (m.status !== "open") continue;
      flow.set(tr.pid, addMarkout(flow.get(tr.pid) ?? emptyStats(), markoutCents(tr.yesPrice, (m.fairExact ?? m.fair / 100) * 100, tr.yes), tr.usd));
    }
  }
  setInterval(scoreMarkouts, 15e3);
  // La casa queda de respaldo si otros ya dan liquidez cerca del precio a ambos lados (HOUSE_BACKSTOP_*)
  function externalDepth(x) {
    const d = bookOf(x.id).depthNear(HOUSE, Math.round(x.fairExact != null ? x.fairExact * 100 : x.fair), 2);
    return d.bids >= 200 * 100 && d.asks >= 200 * 100;
  }
  function eventState(m) {
    const ms = eventMarkets(m);
    return { ms, state: { kind: ms.length > 1 ? "multi" : "binary", tauDays: tauOf(m),
      outcomes: ms.map((x) => { const y = pos(HOUSE, x.id, "YES"), n = pos(HOUSE, x.id, "NO"); return { fair: x.fairExact != null ? x.fairExact * 100 : x.fair, yesShares: y.qty / 100, noShares: n.qty / 100, costUsd: (y.cost + n.cost) / 1e6,
        imbalance: imbalanceOf(x.id), shock: (x.shockUntil ?? 0) > now(), backstop: externalDepth(x) }; }) } };
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
    if (ms.some((x) => (x.pausedUntil ?? 0) > now())) return; // freno de emergencia
    const { quotes } = quoteV2(state, { ...MM, ...TOX, backstopSpreadMult: 2, riskOff: totalWorstLoss() > MM.maxTotalLossUsd });
    for (const q of quotes) quote(ms[q.outcome].id, q.kind, q.yesPrice, q.shares);
  }
  function mmStatus() {
    const seen = new Set(), events = [];
    for (const m of S.markets.values()) {
      if (m.status !== "open" || seen.has(m.eventId)) continue;
      seen.add(m.eventId);
      const { ms, state } = eventState(m);
      const { quotes, diag } = quoteV2(state, { ...MM, ...TOX });
      const e = S.events.find((x) => x.id === m.eventId);
      events.push({ eventId: e.id, marketIds: ms.map((x) => x.id), title: e.title, kind: state.kind, tauDays: Math.round(state.tauDays * 10) / 10,
        liquidity: Math.round(diag.liquidity * 100) / 100, b: Math.round(diag.b), halfSpreadCents: Math.round(diag.halfSpreadCents * 10) / 10, prices: diag.prices,
        worstCaseLossUsd: Math.round(diag.worstCaseLossUsd), lmsrMaxLossUsd: Math.round(diag.lmsrMaxLossUsd), limited: diag.limited, quotes: quotes.length,
        paused: ms.some((x) => (x.pausedUntil ?? 0) > now()), shock: diag.shock, backstop: state.outcomes.some((o) => o.backstop), imbalance: Math.round(Math.max(...state.outcomes.map((o) => Math.abs(o.imbalance))) * 100) / 100 });
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
  // Fianzas (igual que server/src/services/resolution.ts): jugador $10, casa $100, premio = mitad de la del que perdió
  const BOND = { player: 10e6, house: 100e6, rewardShare: 0.5, playerAfterMs: 60e3 };
  S.bonds = [];
  function settleBonds(rid, winner) {
    const bonds = S.bonds.filter((b) => b.rid === rid && b.status === "held");
    const loser = winner ? bonds.find((b) => b.role !== winner) : null;
    const reward = loser ? Math.floor(loser.amount * BOND.rewardShare) : 0;
    for (const b of bonds) {
      if (winner === null) { b.status = b.playerId ? "forfeited" : "returned"; b.payout = b.playerId ? 0 : b.amount; }
      else if (b.role === winner) { b.status = reward ? "rewarded" : "returned"; b.payout = b.amount + reward; }
      else { b.status = "forfeited"; b.payout = 0; }
      if (b.playerId && b.payout) credit(b.playerId, b.payout, b.status === "rewarded" ? "resolution_bond_reward" : "resolution_bond_refund");
    }
  }
  function disputeByPlayer(pid, rid, b) {
    const r = S.resolutions.find((x) => x.id === rid);
    if (!r) throw notFound("Propuesta no encontrada");
    if (r.status !== "proposed" || new Date(r.challenge_ends_at) <= new Date(now())) throw conflict("not_disputable", "La propuesta ya no está en ventana de disputa");
    if (r.proposer_player_id === pid) throw conflict("own_proposal", "No puedes disputar tu propia propuesta");
    if (!b.reason || b.reason.trim().length < 10) throw bad("invalid_reason", "Explica por qué el resultado propuesto es incorrecto (mínimo 10 caracteres)");
    debit(pid, BOND.player);
    Object.assign(r, { status: "disputed", disputed_by: `jugador:${S.players.get(pid).name}`, dispute_reason: b.reason.trim(), dispute_evidence: b.evidence ?? [], disputer_player_id: pid, disputed_at: iso(now()) });
    S.bonds.push({ id: S.bonds.length + 1, rid, role: "disputer", playerId: pid, amount: BOND.player, status: "held", payout: 0 });
    return r;
  }
  function rejectRes(rid, by) {
    const r = S.resolutions.find((x) => x.id === rid);
    if (!r || !["proposed", "disputed"].includes(r.status)) throw conflict("not_rejectable", "No se puede rechazar");
    if (r.status === "disputed") r.dispute_result = "dispute_upheld";
    r.status = "rejected"; r.decided_by = by;
    settleBonds(rid, r.dispute_result === "dispute_upheld" ? "disputer" : null);
    return r;
  }
  function decide(rid, input, by) {
    const r = S.resolutions.find((x) => x.id === rid);
    if (!r || r.status !== "disputed") throw conflict("not_disputed", "Solo se decide sobre propuestas disputadas");
    const e = S.events.find((x) => x.id === r.event_id);
    const same = e.kind === "multi" && input.outcome !== "VOID" ? r.outcome !== "VOID" && Number(input.winningMarketId) === r.winning_market_id : input.outcome === r.outcome;
    r.decided_by = by;
    if (same) return finalize(rid, true);
    rejectRes(rid, by);
    const fresh = propose(r.event_id, { ...input, proposer: by, explanation: input.note || `Decisión sobre la disputa de la propuesta #${rid}` }, { windowMs: 0 });
    return finalize(fresh.id, true);
  }
  function propose(eid, input, opts = {}) {
    const e = S.events.find((x) => x.id === eid);
    if (!e) throw notFound("Evento no encontrado");
    if (!["open", "closed", "resolving"].includes(e.status)) throw conflict("event_not_resolvable", `El evento está ${e.status}`);
    if (S.resolutions.some((r) => r.event_id === eid && ["proposed", "disputed"].includes(r.status))) throw conflict("resolution_pending", "Ya hay una propuesta en curso");
    if (opts.playerId && (e.status === "open" || now() < new Date(e.closeTime).getTime() + BOND.playerAfterMs)) throw conflict("too_early", "Los jugadores pueden proponer un rato después del cierre si nadie lo hizo antes");
    let outcome = input.outcome;
    if (e.kind === "multi" && outcome !== "VOID") { if (!e.marketIds.includes(Number(input.winningMarketId))) throw bad("invalid_winner", "Indica el mercado ganador"); outcome = "YES"; }
    if (!outcome) throw bad("invalid_outcome", "Indica outcome: YES, NO o VOID");
    if (opts.playerId) debit(opts.playerId, BOND.player);
    e.status = "resolving";
    e.marketIds.forEach((mid) => { const m = S.markets.get(mid); if (["open", "closed"].includes(m.status)) m.status = "resolving"; cancelAllInMarket(mid, "resolution"); publish({ type: "market", marketId: mid, eventId: eid, status: "resolving" }); });
    const r = { id: ++S.seq.res, event_id: eid, title: e.title, winning_market_id: e.kind === "multi" && outcome !== "VOID" ? Number(input.winningMarketId) : null, outcome,
      proposer: input.proposer, proposer_player_id: opts.playerId ?? null, evidence: input.evidence ?? [], explanation: input.explanation ?? "", status: "proposed",
      challenge_ends_at: iso(now() + (opts.windowMs ?? CHALLENGE_MS)), created_at: iso(now()) };
    S.resolutions.unshift(r);
    S.bonds.push({ id: S.bonds.length + 1, rid: r.id, role: "proposer", playerId: opts.playerId ?? null, amount: opts.playerId ? BOND.player : BOND.house, status: "held", payout: 0 });
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
      const value = out === "YES" ? 100 : out === "NO" ? 0 : 50; // markout final contra el resultado
      for (const tr of tradeLog) if (tr.mid === mid) flow.set(tr.pid, addMarkout(flow.get(tr.pid) ?? emptyStats(), markoutCents(tr.yesPrice, value, tr.yes), tr.usd));
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
    if (r.status === "disputed") r.dispute_result = "proposal_upheld";
    r.status = "finalized"; r.finalized_at = iso(now());
    settleBonds(r.id, "proposer");
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
    const pending = r && ["proposed", "disputed"].includes(r.status);
    return { ...serializeEvent(e), resolution: r ? { id: r.id, outcome: r.outcome, winning_market_id: r.winning_market_id, status: r.status, proposer: r.proposer, explanation: r.explanation, evidence: r.evidence,
        challenge_ends_at: r.challenge_ends_at, disputed_at: r.disputed_at ?? null, dispute_reason: r.dispute_reason ?? null, dispute_result: r.dispute_result ?? null } : null,
      resolutionOptions: { bondUsd: BOND.player / 1e6, challengeMinutes: CHALLENGE_MS / 60e3, canDispute: r?.status === "proposed" && new Date(r.challenge_ends_at) > new Date(now()),
        canPropose: ["closed", "resolving"].includes(e.status) && !pending && now() >= new Date(e.closeTime).getTime() + BOND.playerAfterMs } };
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
      open_resolutions: S.resolutions.filter((r) => ["proposed", "disputed"].includes(r.status)).length, closed_unproposed: S.events.filter((e) => e.status === "closed").length, failed_credits: 0, pending_webhooks: 0,
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
  route("GET", "/admin/resolutions", ({ q }) => S.resolutions.filter((r) => (q.status ?? "proposed,disputed").split(",").includes(r.status))
    .map((r) => ({ ...r, kind: S.events.find((e) => e.id === r.event_id)?.kind, bonds: S.bonds.filter((b) => b.rid === r.id).map((b) => ({ role: b.role, playerId: b.playerId, amount: b.amount, status: b.status, payout: b.payout })) })));
  route("POST", "/admin/resolutions/:id/decide", ({ p, b, user }) => decide(Number(p.id), b, user));
  route("POST", "/v1/resolutions/:id/dispute", ({ p, b }) => { const r = disputeByPlayer(USER, Number(p.id), b); return { resolutionId: r.id, status: r.status, bondUsd: BOND.player / 1e6 }; });
  route("POST", "/v1/events/:id/propose", ({ p, b }) => {
    if (!b.explanation || b.explanation.length < 10 || !(b.evidence ?? []).length) throw bad("invalid_request", "Explica el resultado y agrega un enlace a la evidencia");
    const r = propose(Number(p.id), { ...b, proposer: `jugador:${S.players.get(USER).name}` }, { playerId: USER });
    return { resolutionId: r.id, status: r.status, challengeEndsAt: r.challenge_ends_at, bondUsd: BOND.player / 1e6 };
  });
  // Oráculo (en la demo las respuestas no se firman: el servidor real firma con Ed25519)
  const oracleWrap = (data) => ({ oracle: "Predicciones (demo)", keyId: "demo", issuedAt: iso(now()), data });
  const oracleMarket = (m) => {
    const e = S.events.find((x) => x.id === m.eventId), book = bookOf(m.id), bid = book.bestBid(), ask = book.bestAsk(), vol = Math.round(m.volume / 1e6);
    const resolved = ["resolved", "void"].includes(m.status);
    const ref = [...refs].reverse().find((x) => x.marketId === m.id);
    return { marketId: m.id, eventId: e.id, event: e.title, outcome: e.kind === "multi" ? m.label : "Sí", question: m.question, category: e.category, kind: e.kind, status: m.status, closeTime: m.closeTime,
      probability: resolved ? (m.resolved === "YES" ? 1 : m.resolved === "NO" ? 0 : 0.5) : Math.round((m.fairExact ?? m.fair / 100) * 10000) / 10000,
      bid: bid != null ? bid / 100 : null, ask: ask != null ? ask / 100 : null, lastTrade: m.last / 100, volumeUsd: vol,
      confidence: resolved ? "resuelto" : vol >= 1000 && ask - bid <= 6 ? "alta" : vol >= 100 && ask - bid <= 10 ? "media" : "baja",
      external: ref ? { source: ref.source, probability: ref.price / 100, capturedAt: ref.capturedAt } : null, resolution: resolved ? { outcome: m.resolved } : null };
  };
  route("GET", "/v1/oracle", () => oracleWrap({ name: "Predicciones (demo)", endpoints: { markets: "/v1/oracle/markets?status=open|resolved|all&category=&limit=&offset=", market: "/v1/oracle/markets/:id", trackRecord: "/v1/oracle/track-record", keys: "/v1/oracle/keys" } }));
  route("GET", "/v1/oracle/keys", () => ({ keys: [{ kid: "demo", alg: "Ed25519", publicKeyPem: "La demo corre en tu navegador y no firma. El servidor real firma cada respuesta con Ed25519 y publica aquí su clave pública." }] }));
  route("GET", "/v1/oracle/markets", ({ q }) => {
    const st = q.status === "resolved" ? ["resolved", "void"] : q.status === "all" ? null : ["open"];
    const ms = [...S.markets.values()].filter((m) => (!st || st.includes(m.status)) && (!q.category || S.events.find((e) => e.id === m.eventId)?.category === q.category))
      .sort((a, b) => b.volume - a.volume).slice(Number(q.offset ?? 0), Number(q.offset ?? 0) + Math.min(Number(q.limit ?? 100), 500));
    return oracleWrap({ count: ms.length, markets: ms.map(oracleMarket) });
  });
  route("GET", "/v1/oracle/markets/:id", ({ p }) => { const m = S.markets.get(Number(p.id)); if (!m) throw notFound("Mercado no encontrado"); return oracleWrap(oracleMarket(m)); });
  route("GET", "/v1/oracle/track-record", () => {
    const pick = (r) => ({ horizonHours: r.horizonHours, resolvedMarkets: r.overall.n, reliable: r.reliable, brier: r.overall.brierRef, brierAtClose: r.overall.brierClose, brierOpening: r.overall.brierInitial,
      brierBaseRate: r.overall.brierBaseRate, calibration: r.calibration, byCategory: r.byCategory.filter((c) => c.n >= 5).map((c) => ({ category: c.category, name: c.name, n: c.n, brier: c.brierRef })) });
    const rs = S.resolutions, bonds = S.bonds;
    return oracleWrap({ horizons: [pick(integrity(24)), pick(integrity(168))], resolutions: {
      finalized: rs.filter((r) => r.status === "finalized").length + ARCHIVE.length, disputed: rs.filter((r) => r.disputed_at).length,
      disputesUpheld: rs.filter((r) => r.dispute_result === "dispute_upheld").length, proposalsUpheld: rs.filter((r) => r.dispute_result === "proposal_upheld").length,
      proposedByPlayers: rs.filter((r) => r.status === "finalized" && r.proposer_player_id).length, challengeWindowMinutes: CHALLENGE_MS / 60e3,
      bonds: { playerBondUsd: BOND.player / 1e6, houseBondUsd: BOND.house / 1e6, rewardShare: BOND.rewardShare,
        forfeitedUsd: bonds.filter((b) => b.status === "forfeited").reduce((a, b) => a + b.amount, 0) / 1e6,
        paidToDisputersUsd: bonds.filter((b) => b.status === "rewarded" && b.role === "disputer").reduce((a, b) => a + b.payout - b.amount, 0) / 1e6 } } });
  });
  route("POST", "/admin/resolutions/:id/dispute", ({ p, b, user }) => { const r = S.resolutions.find((x) => x.id === Number(p.id) && x.status === "proposed"); if (!r) throw conflict("not_disputable", "La propuesta ya no está en ventana de disputa"); r.status = "disputed"; r.disputed_by = user; r.dispute_reason = b.reason ?? ""; return r; });
  route("POST", "/admin/resolutions/:id/reject", ({ p, user }) => rejectRes(Number(p.id), user));
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
  route("GET", "/admin/toxicity", () => {
    const players = [...flow.entries()].filter(([, st]) => st.trades >= 3).map(([pid, st]) => {
      const p = S.players.get(pid), score = toxicityScore(st, TOX);
      return { playerId: pid, name: p.name, externalId: `jugador-${pid}`, operatorId: "casino-demo", since: iso(p.since ?? now()), trades: st.trades, volumeUsd: Math.round(st.w),
        meanMarkoutCents: Math.round(meanMarkout(st) * 10) / 10, scoreCents: Math.round(score * 10) / 10, surchargeBps: surchargeOf(pid), automaticBps: surchargeBps(score, TOX), override: overrides.get(pid) ?? null };
    }).sort((a, b) => b.surchargeBps - a.surchargeBps || b.scoreCents - a.scoreCents);
    const markets = [...S.markets.values()].filter((m) => m.status === "open" && Math.max(m.shockUntil ?? 0, m.pausedUntil ?? 0) > now())
      .map((m) => ({ marketId: m.id, title: m.question, pausedUntil: m.pausedUntil ? iso(m.pausedUntil) : null, shockUntil: m.shockUntil ? iso(m.shockUntil) : null, reason: m.shockReason }));
    return { enabled: true, params: { ...TOX, breakerWindowMinutes: 2 }, flagged: players.filter((p) => p.surchargeBps > 0).length, tracked: flow.size, players: players.slice(0, 50), markets };
  });
  route("POST", "/admin/players/:id/surcharge", ({ p, b }) => { const id = Number(p.id); if (b.bps == null) overrides.delete(id); else overrides.set(id, b.bps); return { playerId: id, surchargeOverride: b.bps }; });
  route("POST", "/admin/markets/:id/shock", ({ p, b }) => { setShock([Number(p.id)], b.reason ?? "Manual (Demo)", !!b.pause); return { ok: true }; });
  route("POST", "/admin/mm/kill", ({ b }) => {
    mmControl.killed = !!b.on; let n = 0;
    for (const m of S.markets.values()) if (m.status === "open") { if (mmControl.killed) { if (bookOf(m.id).ordersOf(HOUSE).length) { clearHouse(m.id); n++; } } else refreshQuotes(m.id); }
    return { killed: mmControl.killed, marketsCleared: n };
  });
  route("GET", "/admin/operators", () => S.operators);
  route("PATCH", "/admin/operators/:id", ({ p, b }) => { const o = S.operators.find((x) => x.id === p.id); if (!o) throw notFound("Casino no encontrado"); if (b.revenueShareBps != null) o.revenue_share_bps = b.revenueShareBps; return o; });
  // P2P: market makers externos y liquidación (server/src/services/marketmakers.ts y clearing.ts)
  const mmSummary = (pl) => {
    const orders = [...S.orders.values()].filter((o) => o.playerId === pl.id && o.status === "open");
    const ps = [...S.positions.values()].filter((x) => x.playerId === pl.id);
    const makerVolume = S.trades.filter((t) => S.orders.get(t.makerOrderId)?.playerId === pl.id).reduce((a, t) => { const o = S.orders.get(t.makerOrderId); return a + notional(ownPrice(`${o.side}_${o.outcome}`, t.yesPrice), t.qty); }, 0);
    return { playerId: pl.id, name: pl.name, active: pl.active, rebateBps: pl.rebateBps, balance: pl.balance, reservedInOrders: orders.filter((o) => o.side === "BUY").reduce((a, o) => a + o.reserved, 0), openOrders: orders.length,
      positionsCost: ps.reduce((a, x) => a + x.cost, 0), realizedPnl: ps.reduce((a, x) => a + x.realized, 0), rebates: S.rebates.filter((r) => r.pid === pl.id).reduce((a, r) => a + r.amount, 0), makerVolume, deposits: pl.deposits ?? 0, withdrawals: pl.withdrawals ?? 0 };
  };
  route("GET", "/admin/market-makers", () => [...S.players.values()].filter((x) => x.isMM).map(mmSummary));
  route("POST", "/admin/market-makers", ({ b }) => {
    const id = 200 + [...S.players.values()].filter((x) => x.isMM).length, tok = () => Math.random().toString(36).slice(2, 14);
    S.players.set(id, { id, name: b.name, balance: 0, isHouse: false, isMM: true, active: true, rebateBps: b.rebateBps ?? REBATE_BPS, operator: "mm", deposits: 0 });
    return { playerId: id, name: b.name, apiKey: `mk_${tok()}`, apiSecret: `ms_${tok()}${tok()}`, note: "En la demo la API de market makers no está disponible: corre en el servidor." };
  });
  route("POST", "/admin/market-makers/:id/funds", ({ p, b }) => {
    const pl = S.players.get(Number(p.id)), amt = Math.round(b.amountUsd * 1e6);
    if (!pl?.isMM) throw notFound("Market maker no encontrado");
    if (b.direction === "withdraw") { if (amt > pl.balance) throw new ApiError(402, "insufficient_funds", "Saldo insuficiente"); pl.balance -= amt; pl.withdrawals = (pl.withdrawals ?? 0) + amt; }
    else { pl.balance += amt; pl.deposits = (pl.deposits ?? 0) + amt; }
    return { playerId: pl.id, balance: pl.balance };
  });
  route("PATCH", "/admin/market-makers/:id", ({ p, b }) => {
    const pl = S.players.get(Number(p.id)); if (!pl?.isMM) throw notFound("Market maker no encontrado");
    if (b.active != null) { pl.active = b.active; if (!b.active) for (const o of [...S.orders.values()]) if (o.playerId === pl.id && o.status === "open") try { cancelOrder(pl.id, o.id); } catch {} }
    if (b.rebateBps !== undefined) pl.rebateBps = b.rebateBps ?? REBATE_BPS;
    return mmSummary(pl);
  });
  function demoClearing(q) {
    const from = q.from ? new Date(q.from).getTime() : now() - 7 * 864e5;
    const group = (pid) => { const pl = S.players.get(pid); return pl.isHouse ? "casa" : pl.isMM ? "market makers" : S.operators.find((o) => o.id === pl.operator)?.name ?? pl.operator; };
    const resolved = new Set([...S.markets.values()].filter((m) => ["resolved", "void"].includes(m.status)).map((m) => m.id));
    const casinos = S.operators.map((o) => {
      const players = [...S.players.values()].filter((x) => x.operator === o.id).map((x) => x.id);
      let debited = 0, markets = new Set();
      for (const t of S.trades) {
        if (!resolved.has(t.marketId)) continue;
        for (const oid of [t.makerOrderId, t.takerOrderId]) {
          const od = S.orders.get(oid); if (!od || !players.includes(od.playerId) || od.side !== "BUY") continue;
          debited += notional(ownPrice(`${od.side}_${od.outcome}`, t.yesPrice), t.qty) + (oid === t.takerOrderId ? t.fee : 0); markets.add(t.marketId);
        }
      }
      const realized = [...S.positions.values()].filter((x) => players.includes(x.playerId) && resolved.has(x.marketId)).reduce((a, x) => a + x.realized, 0);
      const fees = S.fees.filter((f) => players.includes(f.pid) && resolved.has(f.mid)).reduce((a, f) => a + f.amount, 0);
      const collected = -realized + fees, rs = o.revenue_share_bps ?? 0, revenueShare = Math.floor((fees * rs) / 10000);
      return { operatorId: o.id, name: o.name, markets: markets.size, players: players.length, debited, credited: debited - collected, bondsNet: 0, collected, fees, revenueShareBps: rs, revenueShare, playersResult: -(collected - fees), due: collected - revenueShare };
    });
    const pairs = new Map();
    for (const t of S.trades) {
      if (t.at < from) continue;
      const mo = S.orders.get(t.makerOrderId), to = S.orders.get(t.takerOrderId); if (!mo || !to) continue;
      const k = `${group(to.playerId)}|${group(mo.playerId)}`, v = notional(ownPrice(`${to.side}_${to.outcome}`, t.yesPrice), t.qty);
      const cur = pairs.get(k) ?? { volume: 0, trades: 0 }; cur.volume += v; cur.trades++; pairs.set(k, cur);
    }
    const matrix = [...pairs].map(([k, v]) => { const [taker, maker] = k.split("|"); return { taker, maker, ...v }; }).sort((a, b) => b.volume - a.volume);
    const special = (g) => g === "casa" || g === "market makers";
    const sum = (f) => matrix.filter(f).reduce((a, r) => a + r.volume, 0);
    const houseRes = [...S.positions.values()].filter((x) => x.playerId === HOUSE && resolved.has(x.marketId)).reduce((a, x) => a + x.realized, 0);
    return { from: iso(from), to: iso(now()), casinos, totals: { due: casinos.reduce((a, c) => a + c.due, 0) },
      platform: { houseResult: houseRes, marketMakersResult: 0, rebatesPaid: S.rebates.filter((r) => r.at >= from).reduce((a, r) => a + r.amount, 0) },
      liquidity: { volume: sum(() => true), betweenCasinos: sum((r) => r.taker !== r.maker && !special(r.taker) && !special(r.maker)), fromMarketMakers: sum((r) => r.maker === "market makers"), fromHouse: sum((r) => r.maker === "casa"), matrix } };
  }
  route("GET", "/admin/clearing", ({ q }) => demoClearing(q));

  // ---------- Tesorería (server/src/services/treasury.ts, en memoria) ----------
  // SHA-256 síncrono para el libro contable de la demo (en el servidor se usa node:crypto)
  const sha256hex = (() => {
    const primes = []; for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
    const frac = (x) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
    const K = primes.map((p) => frac(Math.cbrt(p))), H0 = primes.slice(0, 8).map((p) => frac(Math.sqrt(p)));
    const r = (x, n) => (x >>> n) | (x << (32 - n));
    return (str) => {
      const bytes = new TextEncoder().encode(str), l = bytes.length, n = Math.ceil((l + 9) / 64) * 64;
      const m = new Uint8Array(n); m.set(bytes); m[l] = 0x80;
      const dv = new DataView(m.buffer); dv.setUint32(n - 4, (l * 8) >>> 0); dv.setUint32(n - 8, Math.floor((l * 8) / 2 ** 32));
      let H = H0.slice(); const w = new Uint32Array(64);
      for (let i = 0; i < n; i += 64) {
        for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
        for (let t = 16; t < 64; t++) w[t] = (w[t - 16] + (r(w[t - 15], 7) ^ r(w[t - 15], 18) ^ (w[t - 15] >>> 3)) + w[t - 7] + (r(w[t - 2], 17) ^ r(w[t - 2], 19) ^ (w[t - 2] >>> 10))) >>> 0;
        let [a, b, c, d, e, f, g, h] = H;
        for (let t = 0; t < 64; t++) {
          const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
          const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
          h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H = [a, b, c, d, e, f, g, h].map((v, k) => (v + H[k]) >>> 0);
      }
      return H.map((v) => v.toString(16).padStart(8, "0")).join("");
    };
  })();

  const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);
  const T = { journal: [], settlements: [], bank: [], seq: 0, usdcSim: 0, cfg: { settlementEveryHours: 24, paymentTermHours: 48, autoCollectGuarantee: false } };
  // La demo corre la vía USDC en modo simulado (USDC_CHAIN=simulado): sin cadena, sin valor
  const USDC = { enabled: true, chain: "simulado", token: "0x0000000000000000000000000000000000005d0c", vault: "0x00000000000000000000000000000000005afe00", confirmations: 0,
    simulated: true, testnet: false, realMoney: false, label: "USDC simulado (sin cadena, sin valor)" };
  const simVault = (d) => (T.usdcSim += d);
  // Pólizas y cartas de crédito (server: treasury.ts, "pólizas y cartas de crédito")
  const INSTR = [], KIND_LABEL = { poliza: "póliza", carta_credito: "carta de crédito" }, MIN_VALID_DAYS = 7, WARN_DAYS = 30;
  const instrView = (i) => { const o = S.operators.find((x) => x.id === i.operatorId), exp = new Date(i.expiresAt).getTime(), available = i.amount - i.executed;
    return { ...i, name: o?.name ?? i.operatorId, kindLabel: KIND_LABEL[i.kind], available, daysLeft: Math.ceil((exp - now()) / 864e5),
      counts: i.status === "active" && exp > now() + MIN_VALID_DAYS * 864e5 && available > 0, expiringSoon: i.status === "active" && exp <= now() + WARN_DAYS * 864e5 }; };
  const instruments = (op) => INSTR.filter((i) => !op || i.operatorId === op).map(instrView).sort((a, b) => (b.status === "active") - (a.status === "active") || new Date(a.expiresAt) - new Date(b.expiresAt));
  const instrCover = (op) => instruments(op).filter((i) => i.counts).reduce((a, i) => a + i.available, 0);
  function instrClose(i, status, by) {
    const rest = i.amount - i.executed; Object.assign(i, { status, closedAt: iso(now()), closedBy: by });
    if (rest > 0) jpost("garantia_instrumento", `${i.kind.toUpperCase()}-${i.number}`, [{ account: `contingente:${i.operatorId}`, amount: -rest }, { account: "contingente:emisores", amount: rest }], `${status === "expired" ? "Vencimiento" : "Devolución"} de ${KIND_LABEL[i.kind]} ${i.number}`, by);
  }
  function instrAdd(b, by) {
    const amount = Math.round(Number(b.amountUsd) * 1e6), expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt) ? new Date(`${b.expiresAt}T23:59:59-05:00`).toISOString() : b.expiresAt;
    if (!(amount > 0)) throw bad("invalid_amount", "Indica un monto positivo");
    if (!expiresAt || !(new Date(expiresAt).getTime() > now())) throw bad("already_expired", "La fecha de vencimiento ya pasó");
    if (!b.issuer?.trim() || !b.number?.trim()) throw bad("missing_fields", "Indica el emisor y el número");
    if (INSTR.some((i) => i.kind === b.kind && i.issuer === b.issuer.trim() && i.number === b.number.trim())) throw conflict("duplicate_instrument", `Esa ${KIND_LABEL[b.kind]} ya está registrada`);
    const i = { id: INSTR.length + 1, operatorId: b.operatorId, kind: b.kind, issuer: b.issuer.trim(), number: b.number.trim(), amount, executed: 0, issuedAt: null, expiresAt, status: "active", documentUrl: b.documentUrl ?? null, notes: b.notes ?? null, createdBy: by, createdAt: iso(now()), closedAt: null, closedBy: null };
    INSTR.push(i);
    jpost("garantia_instrumento", `${i.kind.toUpperCase()}-${i.number}`, [{ account: `contingente:${i.operatorId}`, amount }, { account: "contingente:emisores", amount: -amount }], `Alta de ${KIND_LABEL[i.kind]} ${i.number} de ${i.issuer} para ${i.operatorId}`, by);
    return instrView(i);
  }
  const acct = (opId) => (S.operators.find((o) => o.id === opId)?.settlement_rail === "usdc" ? "boveda_usdc" : "fideicomiso");
  function jpost(kind, ref, entries, memo, by = "sistema") {
    entries = entries.filter((e) => e.amount !== 0);
    const prev = T.journal.length ? T.journal[T.journal.length - 1].hash : "0".repeat(64);
    const row = { id: T.journal.length + 1, ts: iso(now()), kind, ref: ref ?? null, entries, memo: memo ?? "", createdBy: by };
    T.journal.push({ ...row, created_by: by, prev_hash: prev, hash: sha256hex(prev + "\n" + canon(row)) });
  }
  function jverify() {
    let prev = "0".repeat(64);
    for (const j of T.journal) {
      const row = { id: j.id, ts: j.ts, kind: j.kind, ref: j.ref, entries: j.entries, memo: j.memo, createdBy: j.createdBy };
      if (j.prev_hash !== prev || sha256hex(prev + "\n" + canon(row)) !== j.hash) return { ok: false, entries: T.journal.length, brokenAt: j.id, reason: "el asiento fue modificado" };
      prev = j.hash;
    }
    return { ok: true, entries: T.journal.length, head: prev };
  }
  const jbal = (acc) => T.journal.reduce((a, j) => a + j.entries.filter((e) => e.account === acc).reduce((b, e) => b + e.amount, 0), 0);
  const jsum = (pre, f) => [...new Set(T.journal.flatMap((j) => j.entries.map((e) => e.account)))].filter((a) => a.startsWith(pre)).reduce((x, a) => x + f(jbal(a)), 0);
  function tCasinos() {
    const clr = demoClearing({});
    return S.operators.map((o) => {
      const settled = T.settlements.filter((x) => x.operator_id === o.id).reduce((a, x) => a + x.amount, 0);
      const accrued = (clr.casinos.find((c) => c.operatorId === o.id)?.due ?? 0) - settled;
      const issued = jbal(`casino:${o.id}`), cash = -jbal(`garantia:${o.id}`), inCover = instrCover(o.id), guarantee = cash + inCover, required = o.guarantee_required ?? 0;
      const limit = o.debt_limit != null ? o.debt_limit : guarantee, limited = required > 0 || o.debt_limit != null;
      const debt = Math.max(0, issued) + Math.max(0, accrued);
      const overdue = T.settlements.filter((x) => x.operator_id === o.id && x.status === "overdue" && x.amount > 0);
      const reasons = [];
      if (overdue.length) reasons.push(`${overdue.length} liquidación(es) vencida(s) sin pagar`);
      if (required > 0 && guarantee < required) reasons.push(`garantía incompleta (${guarantee / 1e6} de ${required / 1e6} USD)`);
      if (limited && debt > limit) reasons.push(`deuda de ${(debt / 1e6).toFixed(2)} USD sobre su límite de ${(limit / 1e6).toFixed(2)} USD`);
      if (!o.paused_manual) { o.trading_paused = reasons.length > 0; o.paused_reason = reasons.join("; ") || null; }
      return { operatorId: o.id, name: o.name, rail: o.settlement_rail ?? "bank", usdcAddress: o.usdc_address ?? null, guarantee, guaranteeCash: cash, guaranteeInstruments: inCover,
        instrumentsExpiring: instruments(o.id).filter((i) => i.status === "active" && i.expiringSoon).map((i) => ({ id: i.id, kind: i.kind, number: i.number, expiresAt: i.expiresAt, daysLeft: i.daysLeft, counts: i.counts })), guaranteeRequired: required, debtLimit: o.debt_limit ?? null, issuedBalance: issued, accrued, debt,
        overdueOwed: overdue.reduce((a, x) => a + x.amount - x.covered_from_guarantee, 0), paused: !!o.trading_paused, pausedReason: o.paused_reason ?? null, pausedManual: !!o.paused_manual, reasons };
    });
  }
  function tReserves() {
    const bank = jbal("fideicomiso"), usdcBook = jbal("boveda_usdc"), fiduciary = bank + usdcBook, guarantees = jsum("garantia:", (v) => -v), payable = jsum("casino:", (v) => Math.max(0, -v));
    const houseRisk = Math.round(totalWorstLoss() * 1e6), obligations = guarantees + payable + houseRisk;
    const mmAcc = [...S.players.values()].filter((x) => x.isMM).reduce((a, x) => a + x.balance + [...S.orders.values()].filter((o) => o.playerId === x.id && o.status === "open" && o.side === "BUY").reduce((b, o) => b + o.reserved, 0)
      + [...S.positions.values()].filter((p) => p.playerId === x.id).reduce((b, p) => b + p.cost, 0), 0);
    return { contingent: jsum("contingente:", (v) => Math.max(0, v)), fiduciary, bank, usdc: { ...USDC, book: usdcBook, onChain: T.usdcSim, difference: T.usdcSim - usdcBook, error: null }, guarantees, payableToCasinos: payable, receivableFromCasinos: jsum("casino:", (v) => Math.max(0, v)), houseReserve: -jbal("capital:reserva_casa"), houseRisk,
      obligations, coverage: obligations ? fiduciary / obligations : null, ok: fiduciary >= obligations, marketMakers: { custody: jbal("custodia_mm"), accounts: mmAcc, ok: jbal("custodia_mm") >= mmAcc },
      journal: { id: T.journal.length, hash: T.journal.at(-1)?.hash ?? "0".repeat(64) }, note: "En la demo el libro vive en tu navegador. En el servidor se guarda en la base y se concilia con el extracto del fideicomiso." };
  }
  // Custodia de market makers al día con su resultado (server: treasury.trueUpMmCustody)
  function tTrueUpMm(by = "sistema") {
    const moves = [...S.players.values()].filter((x) => x.isMM).map((x) => {
      const value = x.balance + [...S.orders.values()].filter((o) => o.playerId === x.id && o.status === "open" && o.side === "BUY").reduce((b, o) => b + o.reserved, 0)
        + [...S.positions.values()].filter((p) => p.playerId === x.id).reduce((b, p) => b + p.cost, 0);
      return { playerId: x.id, name: x.name, d: Math.round(value + jbal(`mm:${x.id}`)) };
    }).filter((m) => m.d !== 0);
    if (!moves.length) return { adjusted: 0, total: 0 };
    const total = moves.reduce((a, m) => a + m.d, 0);
    jpost("ajuste_custodia_mm", `MMC-${iso(now()).slice(0, 10)}`, [{ account: "custodia_mm", amount: total }, { account: "fideicomiso", amount: -total }, { account: "compensacion", amount: total }, ...moves.map((m) => ({ account: `mm:${m.playerId}`, amount: -m.d }))],
      `Ajuste de la custodia de market makers por su resultado: ${moves.map((m) => `${m.name} ${(m.d / 1e6).toFixed(2)}`).join(", ")} USD`, by);
    return { adjusted: moves.length, total, moves };
  }
  function tSettle() {
    const created = [], clr = demoClearing({});
    for (const o of S.operators) {
      const settled = T.settlements.filter((x) => x.operator_id === o.id).reduce((a, x) => a + x.amount, 0);
      const row = clr.casinos.find((c) => c.operatorId === o.id), amount = (row?.due ?? 0) - settled;
      const last = T.settlements.filter((x) => x.operator_id === o.id).at(-1), id = ++T.seq;
      const from = last ? last.period_to : iso(now() - 864e5), dueAt = iso(now() + T.cfg.paymentTermHours * 3600e3);
      const statement = JSON.stringify({ oracle: "Predicciones (demo)", keyId: "demo", issuedAt: iso(now()), data: { type: "estado_de_cuenta", settlementId: id, operatorId: o.id, operator: o.name,
        period: { from, to: iso(now()) }, amountUsd: amount / 1e6, paymentReference: `LIQ-${id}`, dueAt, guaranteeUsd: -jbal(`garantia:${o.id}`) / 1e6, journalHead: T.journal.at(-1)?.hash } });
      const x = { id, operator_id: o.id, name: o.name, period_from: from, period_to: iso(now()), amount, status: amount === 0 ? "paid" : "pending", due_at: dueAt, paid_at: amount === 0 ? iso(now()) : null, bank_ref: null, covered_from_guarantee: 0, statement };
      T.settlements.push(x);
      if (amount) jpost("liquidacion", `LIQ-${id}`, [{ account: `casino:${o.id}`, amount }, { account: "compensacion", amount: -amount }], `Liquidación de ${o.id}`);
      created.push({ id, operatorId: o.id, amount, status: x.status });
    }
    if (created.length) tTrueUpMm();
    return created;
  }
  function tPay(id, ref, by) {
    const x = T.settlements.find((y) => y.id === id); if (!x) throw notFound("Liquidación no encontrada");
    if (!["pending", "overdue"].includes(x.status)) throw conflict("not_payable", `La liquidación está ${x.status}`);
    const rem = x.amount - x.covered_from_guarantee;
    Object.assign(x, { status: "paid", paid_at: iso(now()), bank_ref: ref });
    jpost("pago_liquidacion", ref, [{ account: acct(x.operator_id), amount: rem }, { account: `casino:${x.operator_id}`, amount: -rem }], `Pago de LIQ-${id}`, by);
    return x;
  }
  setInterval(() => { for (const x of T.settlements) if (x.status === "pending" && new Date(x.due_at) < new Date(now())) x.status = "overdue"; }, 10000);
  route("GET", "/admin/treasury", () => {
    const casinos = tCasinos(), j = jverify();
    return { casinos, reserves: tReserves(), journal: { ...j, recent: T.journal.slice(-30).reverse() }, settlements: T.settlements.slice().reverse(),
      unmatchedBankLines: T.bank.filter((b) => b.status === "unmatched").map((b) => ({ account: "fideicomiso", ...b })).reverse(), anchors: [], usdc: USDC, instruments: instruments(), config: { ...T.cfg, instrumentMinValidityDays: MIN_VALID_DAYS, instrumentWarnDays: WARN_DAYS, anchorEnabled: true, anchorEveryHours: 24 } };
  });
  route("POST", "/admin/treasury/settle", () => ({ created: tSettle() }));
  route("POST", "/admin/treasury/mm-custody/true-up", ({ user }) => tTrueUpMm(user));
  route("POST", "/admin/treasury/settlements/:id/pay", ({ p, b, user }) => { if (!b.bankRef) throw bad("missing_bank_ref", "Indica la referencia de la transferencia"); return tPay(Number(p.id), b.bankRef, user); });
  route("POST", "/admin/treasury/settlements/:id/collect", ({ p, user }) => {
    const x = T.settlements.find((y) => y.id === Number(p.id)); if (!x || !["pending", "overdue"].includes(x.status) || x.amount <= 0) throw conflict("not_collectable", "Solo se cobra de la garantía una liquidación que el casino debe");
    const take = Math.min(x.amount - x.covered_from_guarantee, -jbal(`garantia:${x.operator_id}`)); if (take <= 0) throw conflict("no_guarantee", "El casino no tiene garantía disponible");
    jpost("garantia_cobro", `LIQ-${x.id}`, [{ account: `garantia:${x.operator_id}`, amount: take }, { account: `casino:${x.operator_id}`, amount: -take }], `Cobro de LIQ-${x.id} con la garantía`, user);
    x.covered_from_guarantee += take; if (x.covered_from_guarantee >= x.amount) x.status = "covered";
    return { settlementId: x.id, collected: take, remaining: x.amount - x.covered_from_guarantee };
  });
  route("GET", "/admin/treasury/settlements/:id/statement", ({ p }) => JSON.parse(T.settlements.find((y) => y.id === Number(p.id))?.statement ?? "{}"));
  route("POST", "/admin/treasury/guarantees/:id", ({ p, b, user }) => {
    const amt = Math.round(b.amountUsd * 1e6), sign = b.direction === "deposit" ? 1 : -1;
    if (sign < 0 && amt > -jbal(`garantia:${p.id}`)) throw conflict("insufficient_guarantee", "El retiro supera la garantía disponible");
    jpost(sign > 0 ? "garantia_deposito" : "garantia_retiro", b.bankRef, [{ account: acct(p.id), amount: sign * amt }, { account: `garantia:${p.id}`, amount: -sign * amt }], `Garantía de ${p.id}`, user);
    return { operatorId: p.id, guarantee: -jbal(`garantia:${p.id}`) };
  });
  route("POST", "/admin/treasury/reserve", ({ b, user }) => {
    const amt = Math.round(b.amountUsd * 1e6), sign = b.direction === "deposit" ? 1 : -1;
    jpost("reserva", b.bankRef, [{ account: b.rail === "usdc" ? "boveda_usdc" : "fideicomiso", amount: sign * amt }, { account: "capital:reserva_casa", amount: -sign * amt }], "Reserva de la casa", user);
    return { reserve: -jbal("capital:reserva_casa") };
  });
  route("PATCH", "/admin/treasury/casinos/:id", ({ p, b }) => {
    const o = S.operators.find((x) => x.id === p.id); if (!o) throw notFound("Casino no encontrado");
    if (b.guaranteeRequiredUsd !== undefined) o.guarantee_required = Math.round(b.guaranteeRequiredUsd * 1e6);
    if (b.debtLimitUsd !== undefined) o.debt_limit = b.debtLimitUsd === null ? null : Math.round(b.debtLimitUsd * 1e6);
    if (b.paused !== undefined) { o.paused_manual = b.paused; o.trading_paused = b.paused; o.paused_reason = b.paused ? b.reason ?? "pausa manual" : null; }
    if (b.usdcAddress !== undefined) { if (b.usdcAddress && !/^0x[0-9a-fA-F]{40}$/.test(b.usdcAddress)) throw bad("invalid_address", "Dirección inválida: debe ser 0x seguido de 40 caracteres hexadecimales"); o.usdc_address = b.usdcAddress ? b.usdcAddress.toLowerCase() : null; }
    if (b.rail !== undefined) {
      if (b.rail === "usdc" && !o.usdc_address) throw bad("missing_address", "Para liquidar en USDC indica la dirección del casino");
      if (-jbal(`garantia:${o.id}`) > 0 || T.settlements.some((x) => x.operator_id === o.id && ["pending", "overdue"].includes(x.status))) throw conflict("rail_change_blocked", "Para cambiar la vía de liquidación el casino no puede tener liquidaciones abiertas ni garantía depositada (devuélvela y vuelve a depositarla por la vía nueva)");
      o.settlement_rail = b.rail;
    }
    return tCasinos().find((c) => c.operatorId === o.id);
  });
  route("POST", "/admin/treasury/bank-statements", ({ b, user }) => {
    const lines = String(b.csv ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean), sep = lines[0]?.includes(";") ? ";" : ",";
    let imported = 0, matched = 0;
    for (const [i, l] of lines.entries()) {
      if (i === 0 && /fecha|date/i.test(l)) continue;
      const [date, reference, amount, ...desc] = l.split(sep).map((x) => x.trim());
      const n = Math.round(Number(sep === ";" ? amount.replace(/\./g, "").replace(",", ".") : amount.replace(/,/g, "")) * 1e6);
      if (!date || !reference || !Number.isFinite(n)) throw bad("invalid_line", `Línea inválida: ${l}`);
      if (T.bank.some((x) => x.date === date && x.reference === reference && x.amount === n)) continue;
      const line = { id: T.bank.length + 1, date, reference, amount: n, description: desc.join(sep), status: "unmatched" }; T.bank.push(line); imported++;
      const tag = `${reference} ${line.description}`.match(/LIQ-(\d+)/i);
      const x = T.settlements.find((y) => (tag ? y.id === Number(tag[1]) : ["pending", "overdue"].includes(y.status)) && y.amount - y.covered_from_guarantee === n);
      if (x) { if (["pending", "overdue"].includes(x.status)) tPay(x.id, reference, user); line.status = "matched"; matched++; }
    }
    return { lines: lines.length, imported, matched, unmatched: imported - matched };
  });
  route("GET", "/admin/treasury/instruments", ({ q }) => instruments(q.operatorId));
  route("POST", "/admin/treasury/instruments", ({ b, user }) => instrAdd(b, user));
  route("POST", "/admin/treasury/instruments/:id/release", ({ p, user }) => {
    const i = INSTR.find((x) => x.id === Number(p.id)); if (!i) throw notFound("Póliza o carta de crédito no encontrada");
    if (i.status !== "active") throw conflict("not_active", `Ya está ${i.status}`);
    instrClose(i, "released", user); return { id: i.id, status: "released" };
  });
  route("POST", "/admin/treasury/instruments/:id/execute", ({ p, b, user }) => {
    const i = INSTR.find((x) => x.id === Number(p.id)); if (!i) throw notFound("Póliza o carta de crédito no encontrada");
    if (!b.bankRef?.trim()) throw bad("missing_bank_ref", "Indica la referencia del pago de la aseguradora o del banco");
    if (i.status !== "active") throw conflict("not_active", `Está ${i.status}: ya no se puede ejecutar`);
    const x = T.settlements.find((y) => y.id === Number(b.settlementId) && y.operator_id === i.operatorId);
    if (!x || !["pending", "overdue"].includes(x.status) || x.amount <= 0) throw conflict("not_collectable", "Solo se ejecuta para una liquidación que el casino debe y no pagó");
    const take = Math.min(x.amount - x.covered_from_guarantee, i.amount - i.executed);
    i.executed += take; if (i.executed >= i.amount) Object.assign(i, { status: "executed", closedAt: iso(now()), closedBy: user });
    jpost("garantia_ejecucion", b.bankRef.trim(), [{ account: acct(i.operatorId), amount: take }, { account: `casino:${i.operatorId}`, amount: -take }, { account: `contingente:${i.operatorId}`, amount: -take }, { account: "contingente:emisores", amount: take }], `Ejecución de ${KIND_LABEL[i.kind]} ${i.number} por LIQ-${x.id}`, user);
    x.covered_from_guarantee += take; if (x.covered_from_guarantee >= x.amount) x.status = "covered";
    return { instrumentId: i.id, settlementId: x.id, collected: take };
  });
  route("POST", "/admin/treasury/usdc/simulate", ({ b, user }) => {
    const amount = Math.round(Number(b.amountUsd) * 1e6), addr = String(b.address ?? "").toLowerCase();
    if (!(amount > 0)) throw bad("invalid_amount", "Indica un monto positivo");
    if (!/^0x[0-9a-f]{40}$/.test(addr)) throw bad("invalid_address", "Dirección inválida: debe ser 0x seguido de 40 caracteres hexadecimales");
    if (b.direction === "out" && amount > T.usdcSim) throw bad("insufficient_vault", "La bóveda simulada no tiene ese saldo");
    const signed = b.direction === "out" ? -amount : amount;
    T.usdcSim += signed;
    const txHash = "0x5151" + Date.now().toString(16).padStart(28, "0") + (T.bank.length + 1).toString(16).padStart(32, "0");
    const line = { id: T.bank.length + 1, account: "usdc", date: iso(now()).slice(0, 10), reference: `${txHash}:0`, amount: signed, description: `${signed > 0 ? "de" : "a"} ${addr} · simulada`, status: "unmatched" };
    T.bank.push(line);
    const o = S.operators.find((k) => k.settlement_rail === "usdc" && k.usdc_address === addr);
    const x = o && T.settlements.find((y) => y.operator_id === o.id && ["pending", "overdue"].includes(y.status) && y.amount - y.covered_from_guarantee === signed);
    if (x) { tPay(x.id, txHash, "cadena"); line.status = "matched"; }
    return { simulated: true, txHash, vaultBalance: T.usdcSim, matched: x ? 1 : 0 };
  });
  route("POST", "/admin/treasury/bank-lines/:id/guarantee", ({ p, b, user }) => {
    const l = T.bank.find((x) => x.id === Number(p.id) && x.status === "unmatched"); if (!l) throw notFound("Línea sin conciliar no encontrada");
    if (l.amount <= 0) throw bad("not_a_deposit", "Solo un ingreso puede ser un depósito de garantía");
    const want = l.account === "usdc" ? "boveda_usdc" : "fideicomiso";
    if (acct(b.operatorId) !== want) throw conflict("rail_mismatch", "La línea es de la otra vía de liquidación del casino");
    jpost("garantia_deposito", l.reference.split(":")[0], [{ account: want, amount: l.amount }, { account: `garantia:${b.operatorId}`, amount: -l.amount }], `Garantía de ${b.operatorId}`, user);
    l.status = "matched";
    return { operatorId: b.operatorId, guarantee: -jbal(`garantia:${b.operatorId}`) };
  });
  route("POST", "/admin/treasury/bank-lines/:id/ignore", ({ p }) => { const l = T.bank.find((x) => x.id === Number(p.id)); if (l) l.status = "ignored"; return { ok: true }; });
  route("GET", "/admin/treasury/journal", () => ({ verify: jverify(), entries: T.journal.slice().reverse() }));
  route("GET", "/admin/treasury/reserves", () => tReserves());
  route("POST", "/admin/treasury/anchor", () => ({ anchored: false, reason: "la demo corre en tu navegador y no se conecta a Bitcoin; en el servidor se sella cada día con OpenTimestamps" }));
  route("GET", "/v1/oracle/anchors", () => ({ oracle: "Predicciones (demo)", keyId: "demo", issuedAt: iso(now()), data: { method: "OpenTimestamps (Bitcoin)", anchors: [] } }));
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
    if (rnd() < 0.4) {
      // A veces dejan una orden límite en un mercado con movimiento: otro jugador (de este u otro casino) la puede tomar.
      // Así hay juego jugador contra jugador.
      const hot = [...S.markets.values()].filter((x) => x.status === "open").sort((a, b) => b.volume - a.volume).slice(0, 12);
      const m = hot[Math.floor(rnd() * hot.length)], mid = m.id;
      const yes = rnd() < 0.5;
      const mine = [...S.orders.values()].filter((o) => o.playerId === pid && o.status === "open");
      if (mine.length >= 3) try { cancelOrder(pid, mine[0].id); } catch {}
      const book = bookOf(mid), fair = Math.round(m.fairExact != null ? m.fairExact * 100 : m.fair);
      const yesP = yes ? Math.min(98, Math.max(2, (book.bestBid() ?? fair - 2) + 1)) : Math.max(2, Math.min(98, (book.bestAsk() ?? fair + 2) - 1));
      try { placeOrder(pid, { marketId: mid, side: "BUY", outcome: yes ? "YES" : "NO", type: "LIMIT", price: yes ? yesP : 100 - yesP, shares: 20 + Math.floor(rnd() * 60), postOnly: true }); } catch {}
      return;
    }
    try { placeOrder(pid, { marketId: mid, side: "BUY", outcome: yes ? "YES" : "NO", type: "MARKET", amount: [1, 2, 5, 5, 10, 10, 20, 25, 50][Math.floor(rnd() * 9)] }); } catch {}
  }
  // Incentivos de liquidez (server: services/rewards.ts con engine/rewards.ts). En la demo se muestrea
  // cada 15 s y "Pagar días cerrados" cierra el día en curso, para verlo funcionar sin esperar.
  const RW = { cfg: { ...DEFAULT_REWARDS, enabled: true, sampleSec: 15, maxDailyUsd: 1000, defaultDailyUsd: 0 }, pools: new Map(), samples: new Map(), shares: new Map(), paid: [] };
  function rwOrders(mid) {
    const book = bookOf(mid);
    return [...book.bids.map((o) => ({ owner: o.ownerId, side: "BUY", outcome: "YES", price: o.yesPrice, shares: o.remaining / 100 })),
            ...book.asks.map((o) => ({ owner: o.ownerId, side: "SELL", outcome: "YES", price: o.yesPrice, shares: o.remaining / 100 }))];
  }
  const rwMid = (mid) => { const m = S.markets.get(mid); return bookMid(rwOrders(mid), m.fairExact != null ? m.fairExact * 100 : m.fair); };
  function rwSample() {
    for (const [mid, pool] of RW.pools) {
      const m = S.markets.get(mid); if (!m || m.status !== "open" || !pool) continue;
      const competing = rwOrders(mid).filter((o) => o.owner === HOUSE || (S.players.get(o.owner)?.isMM && S.players.get(o.owner).active));
      const shares = sampleShares(sampleScores(competing, rwMid(mid), RW.cfg));
      RW.samples.set(mid, (RW.samples.get(mid) ?? 0) + 1);
      for (const [pid, sh] of shares) RW.shares.set(`${mid}|${pid}`, (RW.shares.get(`${mid}|${pid}`) ?? 0) + sh);
    }
  }
  setInterval(rwSample, RW.cfg.sampleSec * 1000);
  function rwPay() {
    const raw = [];
    for (const [k, sum] of RW.shares) {
      const [mid, pid] = k.split("|").map(Number), p = S.players.get(pid), n = RW.samples.get(mid) ?? 0;
      if (!p?.isMM || !n) continue;
      raw.push({ mid, pid, share: sum / n, amount: (RW.pools.get(mid) ?? 0) * sum / n });
    }
    const total = raw.reduce((a, r) => a + r.amount, 0), k = total > RW.cfg.maxDailyUsd * 1e6 ? (RW.cfg.maxDailyUsd * 1e6) / total : 1;
    const pays = raw.map((r) => ({ ...r, amount: Math.floor((r.amount * k) / 1e4) * 1e4 })).filter((r) => r.amount > 0);
    const sum = pays.reduce((a, r) => a + r.amount, 0), day = `${iso(now()).slice(0, 10)} #${RW.paid.length + 1}`;
    for (const r of pays) { S.players.get(r.pid).balance += r.amount; RW.paid.push({ day, ...r }); }
    if (sum) { const by = new Map(); for (const r of pays) by.set(r.pid, (by.get(r.pid) ?? 0) + r.amount);
      jpost("incentivo_liquidez", `LIQRW-${day}`, [{ account: "fideicomiso", amount: -sum }, { account: "custodia_mm", amount: sum }, { account: "gasto:incentivos_liquidez", amount: sum }, ...[...by].map(([id, a]) => ({ account: `mm:${id}`, amount: -a }))], `Incentivos de liquidez (${by.size} market maker(s))`, "sistema"); }
    RW.samples.clear(); RW.shares.clear();
    return { day, paid: sum, rewards: pays.length };
  }
  function rwOverview() {
    const current = [...RW.pools].filter(([mid, pool]) => pool > 0 && S.markets.get(mid)?.status === "open").map(([mid, pool]) => {
      const m = S.markets.get(mid), e = S.events.find((x) => x.id === m.eventId);
      return { marketId: mid, title: e?.title, label: m.label, poolUsd: pool / 1e6, own: true, midCents: Math.round(rwMid(mid) * 10) / 10 };
    }).sort((a, b) => b.poolUsd - a.poolUsd);
    const today = current.map((c) => { const n = RW.samples.get(c.marketId) ?? 0;
      const participants = [...RW.shares].filter(([k]) => Number(k.split("|")[0]) === c.marketId).map(([k, v]) => { const pid = Number(k.split("|")[1]), p = S.players.get(pid);
        return { playerId: pid, name: pid === HOUSE ? "Casa" : p?.name ?? String(pid), house: pid === HOUSE, share: n ? v / n : 0 }; }).sort((a, b) => b.share - a.share);
      return { marketId: c.marketId, title: c.title, label: c.label, poolUsd: c.poolUsd, samples: n, participants }; });
    const days = new Map(); for (const r of RW.paid) { const d = days.get(r.day) ?? { day: r.day, amountUsd: 0, makers: new Set() }; d.amountUsd += r.amount / 1e6; d.makers.add(r.pid); days.set(r.day, d); }
    const mms = new Map(); for (const r of RW.paid) mms.set(r.pid, (mms.get(r.pid) ?? 0) + r.amount);
    return { config: RW.cfg, rewardedMarkets: current.length, dailyBudgetUsd: current.reduce((a, c) => a + c.poolUsd, 0), current, today,
      paidByDay: [...days.values()].reverse().map((d) => ({ day: d.day, amountUsd: d.amountUsd, makers: d.makers.size })),
      byMarketMaker: [...mms].map(([pid, a]) => ({ playerId: pid, name: S.players.get(pid)?.name, last7dUsd: a / 1e6, last30dUsd: a / 1e6 })) };
  }
  route("GET", "/admin/liquidity-rewards", () => rwOverview());
  route("POST", "/admin/liquidity-rewards/pay", () => ({ days: [rwPay()] }));
  route("POST", "/admin/liquidity-rewards/sample", () => { rwSample(); return { markets: RW.pools.size }; });
  route("PATCH", "/admin/markets/:id/reward", ({ p, b }) => {
    const mid = Number(p.id); if (!S.markets.get(mid)) throw notFound("Mercado no encontrado");
    const v = b.dailyUsd == null ? 0 : Math.round(Number(b.dailyUsd) * 1e6); if (!(v >= 0)) throw bad("invalid_amount", "Indica un monto de 0 o más");
    if (v) RW.pools.set(mid, v); else RW.pools.delete(mid);
    return { marketId: mid, rewardDaily: v, effectiveDaily: v };
  });

  // El market maker externo de demostración recotiza los 20 mercados con más volumen, 1¢ por dentro de la casa
  function mmBotQuote() {
    const bot = S.players.get(MMBOT);
    if (!bot.active) return;
    const top = [...S.markets.values()].filter((m) => m.status === "open").sort((a, b) => b.volume - a.volume).slice(0, 20);
    for (const m of top) {
      const book = bookOf(m.id);
      for (const o of book.ordersOf(MMBOT)) try { cancelOrder(MMBOT, o.id); } catch {}
      const fair = m.fairExact != null ? m.fairExact * 100 : m.fair;
      const bid = Math.max(1, Math.floor(fair) - 1), ask = Math.min(99, Math.ceil(fair) + 1);
      try { placeOrder(MMBOT, { marketId: m.id, side: "BUY", outcome: "YES", type: "LIMIT", price: bid, shares: 250, postOnly: true }); } catch {}
      try { placeOrder(MMBOT, { marketId: m.id, side: "BUY", outcome: "NO", type: "LIMIT", price: 100 - ask, shares: 250, postOnly: true }); } catch {}
      refreshQuotes(m.id);
    }
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
    mmBotQuote();
    // Historial de markout de los mercados de demostración ya resueltos: dos jugadores le ganan a la
    // casa de forma sostenida (Kevin Andrade y Diego Torres); el resto apuesta como casual
    BOT_NAMES.forEach((_, i) => {
      const sharp = i === 6 || i === 8; let st = emptyStats();
      for (let k = 0; k < 30 + Math.floor(rnd() * 30); k++) {
        const g = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
        st = addMarkout(st, (sharp ? 7 : -3) + g * 22, sharp ? 40 + rnd() * 80 : 5 + rnd() * 40);
      }
      flow.set(10 + i, st);
    });
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
    S.operators.push({ id: "demo-casino", name: "Casino Demo", api_key: "pk_demo_casino", wallet_url: "https://casino-demo.example/wallet", webhook_url: "https://casino-demo.example/webhooks", currency: "USD", fee_bps: null, revenue_share_bps: 3000, theme: { brandName: "TuCasino", primary: "#ffd400" }, active: true });
    S.operators.push({ id: "casino-aliado", name: "Casino Aliado (demo)", api_key: "pk_demo_aliado", wallet_url: "https://casino-aliado.example/wallet", webhook_url: null, currency: "USD", fee_bps: null, revenue_share_bps: 5000, theme: { brandName: "Aliado", primary: "#22c55e" }, active: true });
    // Tesorería de demostración: garantías en el fideicomiso, reserva de la casa y custodia del market maker externo
    S.operators[0].guarantee_required = 2000e6; S.operators[1].guarantee_required = 1000e6;
    jpost("garantia_deposito", "DEP-1001", [{ account: "fideicomiso", amount: 2000e6 }, { account: "garantia:demo-casino", amount: -2000e6 }], "Depósito de garantía de demo-casino", "Demo");
    // El casino aliado liquida por la vía USDC (simulada): su garantía está en la bóveda
    Object.assign(S.operators[1], { settlement_rail: "usdc", usdc_address: "0x2222222222222222222222222222222222222222" });
    jpost("garantia_deposito", "0x5151…demo", [{ account: "boveda_usdc", amount: 1000e6 }, { account: "garantia:casino-aliado", amount: -1000e6 }], "Depósito de garantía de casino-aliado (USDC simulado)", "Demo");
    simVault(1000e6);
    instrAdd({ operatorId: "demo-casino", kind: "poliza", issuer: "Seguros Equinoccial", number: "PC-2026-118", amountUsd: 3000, expiresAt: new Date(now() + 25 * 864e5).toISOString(), notes: "renovación anual" }, "Demo");
    instrAdd({ operatorId: "casino-aliado", kind: "carta_credito", issuer: "Banco Pichincha", number: "SBLC-0457", amountUsd: 5000, expiresAt: new Date(now() + 180 * 864e5).toISOString() }, "Demo");
    jpost("reserva", "CAP-2001", [{ account: "fideicomiso", amount: 50000e6 }, { account: "capital:reserva_casa", amount: -50000e6 }], "Aporte a la reserva de la casa", "Demo");
    [...S.markets.values()].filter((m) => m.status === "open").sort((a, b) => b.volume - a.volume).slice(0, 3).forEach((m) => RW.pools.set(m.id, 25e6));
    jpost("custodia_mm", "MM-3001", [{ account: "custodia_mm", amount: 25000e6 }, { account: `mm:${MMBOT}`, amount: -25000e6 }], "Depósito del market maker externo", "Demo");
    console.info(`demo lista en ${Math.round(performance.now() - t0)} ms: ${S.events.length} eventos, ${S.markets.size} mercados`);
  }

  let botsOn = true;
  setInterval(() => { if (botsOn) botBet(); }, 2600);
  setInterval(() => { if (botsOn) mmBotQuote(); }, 8000);

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
