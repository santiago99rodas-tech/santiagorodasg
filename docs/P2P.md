# P2P: un libro para todos los casinos, market makers externos y liquidación

La plataforma ya funciona como una bolsa. Los jugadores apuestan entre ellos en un libro de órdenes y la casa entra como un participante más que siempre da precio. El paso 5 abre ese libro en dos direcciones:

1. **Entre casinos**: un mismo libro para los jugadores de todos los casinos integrados, con una liquidación que compensa quién le debe a quién.
2. **Hacia afuera**: una API para que empresas o traders profesionales den liquidez con su propio dinero y cobren un reembolso por hacerlo.

Con más gente en el mismo libro hay precios más ajustados, el precio predice mejor (eso alimenta el [oráculo](ORACULO.md)) y la casa arriesga menos.

- Código: `server/src/services/clearing.ts`, `server/src/services/marketmakers.ts`, `server/src/api/mm.ts`
- Back-office: secciones **Market makers** y **Liquidación**; el revenue share se ajusta en **Casinos**

## 1. Un libro compartido entre casinos

Los mercados son globales. Si un jugador de Ecuabet compra Sí a 40¢ y uno de otro casino compra No a 60¢, sus órdenes se cruzan en el mismo libro: se crea el par de acciones y cada uno queda con su posición. Cada casino debita y acredita **solo a sus jugadores**, con su billetera de siempre. No hay blockchain: el dinero nunca sale del casino hasta la liquidación.

### El problema que resuelve la liquidación

Cuando se resuelve el mercado, el ganador cobra $1 por acción **en su casino**:

| | Jugador del casino A (Sí) | Jugador del casino B (No) |
|---|---|---|
| Pagó en su casino | $0,40 | $0,60 + 2% de comisión |
| Si gana Sí, cobra en su casino | $1,00 | — |
| Neto del casino | **−$0,60** (pagó más de lo que cobró) | **+$0,612** (cobró y no pagó) |

El casino B quedó con plata que en realidad le corresponde al casino A.

### Cámara de compensación

La plataforma hace de contraparte central. Para cada casino, en los mercados **resueltos** del período:

```
recaudado  = lo que debitó a sus jugadores − lo que les acreditó (premios, ventas, devoluciones) ± fianzas
a liquidar = recaudado − su revenue share de las comisiones
```

- **A liquidar > 0**: el casino le transfiere ese monto a la plataforma.
- **A liquidar < 0**: la plataforma se lo paga al casino.

En el ejemplo, el casino B liquida $0,612 − su parte de la comisión, y el casino A recibe $0,60.

- **Revenue share**: es la parte de las comisiones de sus jugadores que se le devuelve a cada casino (`revenue_share_bps`, 0 a 100%). Se fija al dar de alta el casino o después, en Casinos.
- **Mercados todavía abiertos**: no se liquidan. Lo apostado sigue en garantía en cada casino hasta que se paga.
- **Créditos pendientes**: un premio que el casino todavía no pudo acreditar (y que se sigue reintentando) cuenta como pagado, porque es una obligación del casino.

**Dónde verla:**
- En el back-office, la sección **Liquidación** muestra cada casino con su período (7, 30 o 90 días). Debajo está "quién le compró a quién": cuánto volumen fue entre casinos distintos, con market makers externos y con la casa.
- Cada casino ve la suya en `GET /operator/v1/clearing?from=&to=`, firmada como el resto de la API de casinos.

### Lo que queda para el modelo comercial

Esta liquidación supone que la plataforma es la contraparte: se queda con las comisiones (menos el revenue share y los reembolsos) y con el resultado de la casa, a favor o en contra. Hay otro modelo común en B2B, donde el casino se queda con lo que pierden sus jugadores y le paga un porcentaje al proveedor. Ese modelo se arma con los mismos números del informe (`playersResult`, `fees`), cambiando la fórmula de "a liquidar".

## 2. Market makers externos

Un market maker es una empresa o un trader que pone órdenes de compra y de venta todo el tiempo y gana con la diferencia. Polymarket depende de ellos. Aquí entran al mismo libro que los jugadores de todos los casinos.

### Cómo funciona

1. **Alta**: en Market makers → "+ Agregar". Se generan su `X-MM-Key` y su secreto, que se muestran una sola vez.
2. **Saldo**: deposita por fuera (banco, USDC) y en el back-office se registra con "Fondos". Ese saldo lo custodia la plataforma, en una billetera interna con la misma idempotencia que la de un casino.
3. **Opera por API**: cada orden queda 100% garantizada con su saldo, igual que la de un jugador. No hay crédito. No tiene el tope de $1.000 por mercado de los jugadores.
4. **Cobra reembolso**: cuando un jugador toma una orden suya, recibe `MAKER_REBATE_BPS` (0,5% por defecto) de lo que pagó el jugador. Sale de la comisión del 2% que paga el jugador, nunca la supera, y se acredita a su saldo al instante.
5. **Suspender**: retira todas sus órdenes del libro.

### API (`/mm/v1`)

Va firmada con HMAC, igual que la de casinos. Cabeceras: `X-MM-Key`, `X-Timestamp` y `X-Signature` = HMAC-SHA256 de `timestamp\nMÉTODO\nruta\ncuerpo` con el secreto.

| Llamada | Qué hace |
|---|---|
| `GET /mm/v1/account` | Saldo, dinero en órdenes, posiciones, volumen como maker, reembolsos, resultado |
| `POST /mm/v1/orders` | Orden límite `{ marketId, side, outcome, price, shares, postOnly?, tif?, clientRef? }` |
| `POST /mm/v1/orders/batch` | Hasta 50 operaciones `{ ops: [{ action: "place", … } \| { action: "cancel", orderId } \| { action: "cancelAll", marketId }] }`. Cada una devuelve su resultado y una que falla no frena a las demás |
| `DELETE /mm/v1/orders/:id` | Cancelar una orden |
| `DELETE /mm/v1/orders?marketId=` | Retirar todo de un mercado, o de todos sin `marketId` |
| `GET /mm/v1/orders?status=open\|all` · `/positions` · `/fills` | Estado. Los cruces traen rol (maker o taker), comisión y reembolso |

- **`postOnly: true`**: la orden solo agrega liquidez. Se rechaza (`409 would_cross`) si tocaría el mejor precio del otro lado, aunque esa orden sea propia. Así un market maker nunca paga comisión por error ni deja el libro cruzado.
- **Precios y libro**: salen de la API pública (`/v1/markets/:id/book`, `/v1/oracle/markets`) y del tiempo real (`/v1/stream`).

```js
// Cotizar Sí a 48/52 en un mercado
import { createHmac } from "node:crypto";
const body = JSON.stringify({ ops: [
  { action: "cancelAll", marketId: 42 },
  { action: "place", marketId: 42, side: "BUY", outcome: "YES", price: 48, shares: 500, postOnly: true },
  { action: "place", marketId: 42, side: "BUY", outcome: "NO",  price: 48, shares: 500, postOnly: true }, // = vender Sí a 52
] });
const ts = String(Date.now()), path = "/mm/v1/orders/batch";
const sig = createHmac("sha256", SECRET).update(`${ts}\nPOST\n${path}\n${body}`).digest("hex");
await fetch(BASE + path, { method: "POST", body, headers: { "content-type": "application/json", "x-mm-key": KEY, "x-timestamp": ts, "x-signature": sig } });
```

### La casa queda de respaldo

El market maker de la casa sigue cotizando siempre, porque es la garantía de que nunca falte liquidez. Pero si ya hay liquidez de otros cerca del precio a **ambos lados**, abre su spread al doble y les deja el flujo:
- "Otros" son market makers externos u órdenes límite de jugadores.
- "Cerca" es `HOUSE_BACKSTOP_CENTS`, 2¢ por defecto.
- Hace falta al menos `HOUSE_BACKSTOP_MIN_SHARES` (200) por lado.
- El multiplicador del spread es `HOUSE_BACKSTOP_SPREAD_MULT` (2).

La casa arriesga menos y sigue ahí si los externos se retiran. En Riesgo de la casa se ve qué mercados están en ese modo.

## Configuración

| Variable | Por defecto | Qué hace |
|---|---|---|
| `MAKER_REBATE_BPS` | 50 | Reembolso al market maker externo (0,5% de lo que pagó el jugador) |
| `MM_API_MAX_BATCH` | 50 | Operaciones por llamada en `/mm/v1/orders/batch` |
| `HOUSE_BACKSTOP_CENTS` | 2 | Qué tan cerca del precio tiene que estar la liquidez externa |
| `HOUSE_BACKSTOP_MIN_SHARES` | 200 | Acciones mínimas por lado para que la casa pase a respaldo |
| `HOUSE_BACKSTOP_SPREAD_MULT` | 2 | Cuánto abre su spread la casa en ese caso |

La parte de cada casino se configura por casino: `revenueShareBps` al crearlo o con `PATCH /admin/operators/:id`.

## Pendiente

- **El simulador todavía no modela market makers externos.** Falta medir cuánto riesgo le quitan a la casa según cuánta liquidez ponen.
- **Los incentivos de liquidez al estilo Polymarket no están**: premios diarios por mantener órdenes cerca del precio aunque nadie las tome. El reembolso actual paga solo lo que se cruza.
- **Las transferencias reales entre casinos y plataforma se hacen por fuera** (banco). El informe dice cuánto y en qué sentido.
