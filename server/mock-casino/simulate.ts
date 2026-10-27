// Simulador de jugadores para demos: abre sesiones en el casino de prueba y hace apuestas aleatorias,
// para que el panel en vivo, los movimientos y las gráficas tengan actividad.
//
//   npm run simulate   (con la plataforma y el casino de prueba corriendo)

import { platform, PLATFORM } from "./platform.js";

const NAMES = ["Carlos Mendoza", "Andrea Paredes", "Luis Guerrero", "María Fernanda", "Jorge Ruiz", "Daniela Vera", "Kevin Andrade", "Sofía León", "Diego Torres", "Valeria Cevallos"];
const EVERY_MS = Number(process.env.SIM_EVERY_MS ?? 2500);

async function session(i: number) {
  const s = await platform("POST", "/operator/v1/sessions", { playerId: `sim-${i}`, displayName: NAMES[i % NAMES.length] });
  return s.token as string;
}

const tokens = await Promise.all(NAMES.map((_, i) => session(i)));
console.log(`simulando ${tokens.length} jugadores cada ${EVERY_MS} ms`);

setInterval(async () => {
  try {
    const events = await (await fetch(`${PLATFORM}/v1/events?limit=50`)).json();
    if (!events.length) return;
    const e = events[Math.floor(Math.random() * events.length)];
    const m = e.markets[Math.floor(Math.random() * e.markets.length)];
    const token = tokens[Math.floor(Math.random() * tokens.length)];
    // Sesgo leve hacia el lado "caro" para que los precios se muevan
    const yes = Math.random() < m.price / 100 + 0.05;
    const amount = [1, 2, 5, 5, 10, 20, 25][Math.floor(Math.random() * 7)];
    const r = await fetch(`${PLATFORM}/v1/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ marketId: m.id, side: "BUY", outcome: yes ? "YES" : "NO", type: "MARKET", amount }),
    });
    const out = await r.json();
    console.log(r.ok ? `$${amount} al ${yes ? "Sí" : "No"} · ${e.title.slice(0, 50)} → ${out.filledShares} acciones a ${out.avgPrice}¢` : `rechazada: ${out.message}`);
  } catch (err) {
    console.error((err as Error).message);
  }
}, EVERY_MS);
