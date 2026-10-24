import { EventEmitter } from "node:events";

// Bus interno de eventos en tiempo real (trades, precios, libro, mercados). Lo consume el stream SSE.
export type BusEvent =
  | { type: "trade"; marketId: number; eventId: number; yesPrice: number; qty: number; outcome: "YES" | "NO"; side: "BUY" | "SELL"; amount: number; player: string; at: string }
  | { type: "price"; marketId: number; eventId: number; price: number; at: string }
  | { type: "book"; marketId: number }
  | { type: "market"; marketId: number; eventId: number; status: string };

class Bus extends EventEmitter {
  publish(e: BusEvent) { this.emit("event", e); }
}
export const bus = new Bus();
bus.setMaxListeners(10_000);
