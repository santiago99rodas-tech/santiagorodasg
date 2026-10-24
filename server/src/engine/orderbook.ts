// Libro de órdenes central (CLOB) al estilo Polymarket.
//
// Cada mercado tiene dos acciones: SÍ y NO. Una acción ganadora paga $1, así que SÍ + NO = $1.
// Por eso un solo libro en "espacio Sí" alcanza para las cuatro intenciones:
//
//   lado comprador (bids):  BUY_YES a p        y  SELL_NO a (100 - p)
//   lado vendedor  (asks):  SELL_YES a p       y  BUY_NO  a (100 - p)
//
// Según qué órdenes se crucen, el emparejamiento produce:
//   transfer_yes  BUY_YES  x SELL_YES -> pasa una acción SÍ de un jugador a otro
//   transfer_no   SELL_NO  x BUY_NO   -> pasa una acción NO de un jugador a otro
//   mint          BUY_YES  x BUY_NO   -> se crea un par SÍ+NO con $1 de colateral (p + (100-p))
//   merge         SELL_YES x SELL_NO  -> se destruye un par SÍ+NO y se libera $1 de colateral
//
// El precio de ejecución es siempre el del maker (la orden que ya estaba en el libro).
// Este módulo es puro (sin base de datos) para poder probarlo y razonarlo de forma aislada.

export type Kind = "BUY_YES" | "SELL_YES" | "BUY_NO" | "SELL_NO";
export type FillKind = "transfer_yes" | "transfer_no" | "mint" | "merge";

export interface BookOrder {
  id: number;
  ownerId: number;
  kind: Kind;
  yesPrice: number; // centavos 1..99 en espacio Sí
  remaining: number; // centésimas de acción
  seq: number; // prioridad temporal
}

export interface Taker {
  id: number;
  ownerId: number;
  kind: Kind;
  yesLimit: number; // bids: precio Sí máximo; asks: precio Sí mínimo
  qty: number; // máximo de centésimas de acción
  budget?: number; // compras de mercado por monto: micro-dólares disponibles (ya sin comisión)
}

export interface Fill {
  makerId: number;
  makerOwnerId: number;
  makerKind: Kind;
  yesPrice: number;
  qty: number;
  kind: FillKind;
}

export const isBid = (k: Kind) => k === "BUY_YES" || k === "SELL_NO";
export const isBuy = (k: Kind) => k === "BUY_YES" || k === "BUY_NO";
export const outcomeOf = (k: Kind): "YES" | "NO" => (k.endsWith("YES") ? "YES" : "NO");
export const kindOf = (side: "BUY" | "SELL", outcome: "YES" | "NO") => `${side}_${outcome}` as Kind;

/** Precio en espacio Sí para una orden expresada en el precio de su propio resultado. */
export const toYesPrice = (outcome: "YES" | "NO", price: number) => (outcome === "YES" ? price : 100 - price);
/** Precio que paga o recibe el dueño de la orden, en su propio resultado. */
export const ownPrice = (k: Kind, yesPrice: number) => (outcomeOf(k) === "YES" ? yesPrice : 100 - yesPrice);
/** Micro-dólares de qty centésimas de acción a un precio en centavos: (p/100)·(q/100)·1e6. */
export const notional = (priceCents: number, qty: number) => priceCents * qty * 100;

export function fillKind(taker: Kind, maker: Kind): FillKind {
  const pair = new Set([taker, maker]);
  if (pair.has("BUY_YES") && pair.has("SELL_YES")) return "transfer_yes";
  if (pair.has("BUY_NO") && pair.has("SELL_NO")) return "transfer_no";
  if (pair.has("BUY_YES") && pair.has("BUY_NO")) return "mint";
  if (pair.has("SELL_YES") && pair.has("SELL_NO")) return "merge";
  throw new Error(`órdenes del mismo lado no se cruzan: ${taker} / ${maker}`);
}

export class OrderBook {
  private bids: BookOrder[] = []; // precio desc, seq asc
  private asks: BookOrder[] = []; // precio asc, seq asc
  private seq = 0;

  add(o: Omit<BookOrder, "seq"> & { seq?: number }): BookOrder {
    const order: BookOrder = { ...o, seq: o.seq ?? ++this.seq };
    this.seq = Math.max(this.seq, order.seq);
    const list = isBid(order.kind) ? this.bids : this.asks;
    const better = isBid(order.kind)
      ? (a: BookOrder) => a.yesPrice > order.yesPrice || (a.yesPrice === order.yesPrice && a.seq < order.seq)
      : (a: BookOrder) => a.yesPrice < order.yesPrice || (a.yesPrice === order.yesPrice && a.seq < order.seq);
    let i = 0;
    while (i < list.length && better(list[i])) i++;
    list.splice(i, 0, order);
    return order;
  }

  remove(id: number): BookOrder | undefined {
    for (const list of [this.bids, this.asks]) {
      const i = list.findIndex((o) => o.id === id);
      if (i >= 0) return list.splice(i, 1)[0];
    }
    return undefined;
  }

  get(id: number) {
    return this.bids.find((o) => o.id === id) ?? this.asks.find((o) => o.id === id);
  }

  ordersOf(ownerId: number) {
    return [...this.bids, ...this.asks].filter((o) => o.ownerId === ownerId);
  }

  bestBid() { return this.bids[0]?.yesPrice; }
  bestAsk() { return this.asks[0]?.yesPrice; }

  /** Punto medio en espacio Sí, o undefined si falta un lado. */
  mid() {
    const b = this.bestBid(), a = this.bestAsk();
    return b !== undefined && a !== undefined ? (a + b) / 2 : undefined;
  }

  /** Niveles agregados en espacio Sí: [precio, qty]. */
  levels(depth = 10) {
    const agg = (list: BookOrder[]) => {
      const out: [number, number][] = [];
      for (const o of list) {
        const last = out[out.length - 1];
        if (last && last[0] === o.yesPrice) last[1] += o.remaining;
        else if (out.length < depth) out.push([o.yesPrice, o.remaining]);
        else break;
      }
      return out;
    };
    return { bids: agg(this.bids), asks: agg(this.asks) };
  }

  /**
   * Cruza una orden entrante contra el libro. No la agrega al libro: eso lo decide el llamador
   * según el tipo (GTC queda en el libro, FOK/FAK no). Con dryRun no modifica nada.
   */
  match(t: Taker, opts: { dryRun?: boolean } = {}): { fills: Fill[]; filled: number; spent: number } {
    const bid = isBid(t.kind);
    const book = bid ? this.asks : this.bids;
    const fills: Fill[] = [];
    let left = t.qty;
    let budget = t.budget ?? Infinity;
    let spent = 0;
    const touched: [BookOrder, number][] = [];

    for (const m of book) {
      if (left <= 0) break;
      if (bid ? m.yesPrice > t.yesLimit : m.yesPrice < t.yesLimit) break;
      if (m.ownerId === t.ownerId) continue; // prevención de auto-cruce
      let q = Math.min(left, m.remaining);
      const unit = notional(ownPrice(t.kind, m.yesPrice), 1);
      if (isBuy(t.kind) && Number.isFinite(budget)) q = Math.min(q, Math.floor(budget / unit));
      if (q <= 0) break;
      fills.push({ makerId: m.id, makerOwnerId: m.ownerId, makerKind: m.kind, yesPrice: m.yesPrice, qty: q, kind: fillKind(t.kind, m.kind) });
      touched.push([m, q]);
      left -= q;
      spent += q * unit;
      if (isBuy(t.kind)) budget -= q * unit;
    }

    if (!opts.dryRun) {
      for (const [m, q] of touched) {
        m.remaining -= q;
        if (m.remaining <= 0) this.remove(m.id);
      }
    }
    return { fills, filled: t.qty - left, spent };
  }
}
