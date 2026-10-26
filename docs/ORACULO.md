# Oráculo: probabilidades públicas y resolución con fianzas

Un oráculo es una fuente en la que otros confían para saber **qué tan probable es algo** y **qué pasó al final**. La plataforma cumple los dos papeles:

1. **Oráculo de probabilidades:** publica la probabilidad de cada mercado, firmada, junto con su historial de aciertos.
2. **Oráculo de resolución:** decide qué pasó con un sistema de fianzas que hace caro mentir y rentable corregir.

- Código: `server/src/services/oracle.ts` (publicación y firma) y `server/src/services/resolution.ts` (fianzas)
- Back-office: secciones **Oráculo** y **Resoluciones**
- Módulo del jugador: botones para disputar o proponer un resultado

## 1. Probabilidades públicas

### Endpoints

Son públicos, no piden clave y tienen caché de 30 segundos (`ORACLE_CACHE_SECONDS`).

| Endpoint | Qué devuelve |
|---|---|
| `GET /v1/oracle` | Índice: nombre, endpoints y cómo verificar |
| `GET /v1/oracle/markets?status=open\|resolved\|all&category=&limit=&offset=` | Probabilidad de cada mercado |
| `GET /v1/oracle/markets/:id` | Lo mismo para un mercado, más historia diaria de 90 días y cómo se resolvió (propuestas, disputas, fianzas) |
| `GET /v1/oracle/track-record` | Historial de calibración y estadísticas de resolución |
| `GET /v1/oracle/keys` | Clave pública para verificar las firmas |

### Qué trae cada mercado

```json
{
  "marketId": 1234, "event": "¿Quién ganará Miss Universo 2027?", "outcome": "Colombia",
  "probability": 0.2412, "bid": 0.22, "ask": 0.26, "lastTrade": 0.24,
  "volumeUsd": 3180, "confidence": "alta",
  "external": { "source": "polymarket", "probability": 0.25, "capturedAt": "…" },
  "status": "open", "closeTime": "2027-11-20T…"
}
```

- **`probability`**: el precio justo del market maker ([MARKET-MAKER.md](MARKET-MAKER.md)). Aprende del dinero que apuestan los jugadores y se combina con referencias externas. Va de 0 a 1. En un mercado resuelto vale 1, 0 o 0,5 si se anuló.
- **`confidence`**:
  - alta: más de $1.000 apostados y spread de 6¢ o menos;
  - media: más de $100 y spread de 10¢ o menos;
  - baja: el resto.

  Un dato con poca plata detrás vale menos.
- **`external`**: la última referencia externa, si hay (Polymarket o un precio cargado a mano).

### Historial de calibración

`/v1/oracle/track-record` responde la pregunta "¿por qué confiar en estos números?". Con los mercados ya resueltos, 24 horas y 7 días antes de que se conociera el resultado, publica:

- **Brier**: error cuadrático medio entre la probabilidad publicada y lo que pasó. 0 es perfecto y 0,25 es lo que da decir siempre 50%. Se compara con el Brier de la apertura (la probabilidad inicial de la IA o del moderador): si el mercado no mejora la apertura, no está aportando.
- **Tramos de calibración**: de lo que se publicó al 70%, ¿cuánto pasó de verdad?
- **Por categoría**, con al menos 5 mercados resueltos.
- **Resoluciones**:
  - cuántas se finalizaron, se disputaron y en cuántas tenía razón quien disputó;
  - cuántas propusieron los jugadores;
  - horas promedio desde el cierre hasta el pago;
  - fianzas perdidas y premios pagados.

No incluye nada de jugadores individuales. La concentración, la hinchada y los recargos quedan en el back-office.

### Firma

Cada respuesta del oráculo viene firmada con **Ed25519** sobre los bytes exactos del cuerpo:

```
X-Oracle-Key-Id: 3f9a…
X-Oracle-Signature: <base64>
```

Quien use el dato (un medio, otro casino, un contrato) puede comprobar que salió de aquí y que nadie lo cambió en el camino:

```js
import { verify, createPublicKey } from "node:crypto";
const keys = await (await fetch("https://<servidor>/v1/oracle/keys")).json();
const res = await fetch("https://<servidor>/v1/oracle/markets");
const body = await res.text();                       // el texto exacto, sin volver a serializar
const ok = verify(null, Buffer.from(body), createPublicKey(keys.keys[0].publicKeyPem),
                  Buffer.from(res.headers.get("x-oracle-signature"), "base64"));
```

**La clave:**
- Si no configuras `ORACLE_PRIVATE_KEY`, el servidor genera una al arrancar y la guarda en la tabla `oracle_keys`.
- Para fijarla entre despliegues, genera una con `openssl genpkey -algorithm ed25519` y pon el PEM en `ORACLE_PRIVATE_KEY`, con los saltos de línea como `\n`.
- Cambiar la clave invalida las firmas viejas para quien no guardó la clave pública anterior.

## 2. Resolución con fianzas

Es el mismo principio del oráculo optimista de UMA que usa Polymarket: **se asume que lo propuesto es cierto salvo que alguien ponga plata para decir lo contrario**.

```
evento cierra ──► alguien propone (con fianza) ──► ventana de disputa (2 h)
                                                     │
                     nadie disputa ◄─────────────────┤
                     se paga el resultado            │ un jugador disputa (con fianza y evidencia)
                     se devuelve la fianza           ▼
                                               decide un administrador
                                               quien tenía razón recupera su fianza
                                               y se lleva la mitad de la del otro
```

### Quién propone

- **La casa**, con la IA (`aiResolve`, solo si su confianza es de 90% o más) o con un moderador. Deja una fianza de **$100** (`HOUSE_BOND_USD`). Es dinero de la casa: si propuso mal, pierde la fianza y la mitad va a quien la corrigió.
- **Un jugador**, si el evento cerró hace más de 2 horas (`PLAYER_PROPOSE_AFTER_HOURS`) y nadie propuso. Deja **$10** (`RESOLUTION_BOND_USD`), que se debitan de su saldo en el casino. Necesita explicar el resultado y dar al menos un enlace de evidencia. Si nadie lo disputa, recupera su fianza cuando se paga.

### Quién disputa

Cualquier jugador, durante la ventana de disputa (`CHALLENGE_WINDOW_MINUTES`, 2 horas por defecto):
- deja **$10** de fianza;
- explica por qué está mal, con al menos 10 caracteres;
- puede agregar enlaces de evidencia.

Hay una sola disputa por propuesta. No se puede disputar la propia.

### Quién decide

Un administrador, en **Resoluciones**, ve la propuesta, la disputa y la evidencia de los dos lados, y elige:

| Botón | Qué pasa con el resultado | Qué pasa con las fianzas |
|---|---|---|
| **Tenía razón quien propuso** | Se paga lo propuesto | Quien propuso recupera su fianza más la mitad de la de quien disputó. Quien disputó pierde la suya. |
| **Tenía razón quien disputó** | Se elige el resultado correcto y se paga ese | Quien disputó recupera su fianza más la mitad de la de quien propuso. Si propuso la casa, son $10 + $50 que paga la casa. |

La otra mitad de la fianza perdida queda para la casa. Así nadie gana disputándose a sí mismo con dos cuentas: perdería la mitad de lo que mueve. `BOND_REWARD_SHARE` cambia esa proporción.

Un administrador también puede **rechazar** una propuesta sin disputa, por ejemplo si un jugador propuso algo absurdo. En ese caso quien propuso pierde su fianza.

### Por qué funciona

- Proponer algo falso cuesta la fianza en cuanto alguien lo disputa con evidencia.
- Corregir un error paga: hasta $60 por una disputa de $10 contra una propuesta de la casa.
- La casa también arriesga, así que le conviene que la IA proponga solo cuando está segura.
- Todo queda público en `/v1/oracle/markets/:id`: quién propuso, con qué evidencia, si se disputó, qué se decidió y qué pasó con cada fianza.

### Lo que no hace (todavía)

- **No hay votación descentralizada.** En UMA las disputas las vota un grupo de poseedores del token; aquí decide un administrador. Para un casino con licencia es lo práctico: la responsabilidad legal es del operador. Si algún día se quiere un jurado, el lugar para enchufarlo es `decide()`.
- **No hay segunda instancia.** La decisión del administrador es final.
- **Fianzas fijas.** No crecen con el volumen del mercado. Para mercados muy grandes conviene subirlas.

## Configuración

| Variable | Por defecto | Qué hace |
|---|---|---|
| `ORACLE_NAME` | Predicciones | Nombre en las respuestas del oráculo |
| `ORACLE_PRIVATE_KEY` | (se genera) | Clave Ed25519 en PEM |
| `ORACLE_CACHE_SECONDS` | 30 | Caché pública de las respuestas |
| `RESOLUTION_BOND_USD` | 10 | Fianza del jugador para proponer o disputar |
| `HOUSE_BOND_USD` | 100 | Fianza de la casa al proponer |
| `BOND_REWARD_SHARE` | 0,5 | Parte de la fianza perdida que se lleva quien tenía razón |
| `PLAYER_PROPOSE_AFTER_HOURS` | 2 | Horas después del cierre en que un jugador puede proponer |
| `CHALLENGE_WINDOW_MINUTES` | 120 | Ventana de disputa |

## API

| Quién | Llamada |
|---|---|
| Jugador | `POST /v1/resolutions/:id/dispute` `{ reason, evidence?: [{ url, title? }] }` |
| Jugador | `POST /v1/events/:id/propose` `{ outcome \| winningMarketId, explanation, evidence: [{ url }] }` |
| Admin | `POST /admin/resolutions/:id/decide` `{ outcome \| winningMarketId, note? }` |
| Admin | `POST /admin/resolutions/:id/reject` |
| Público | `GET /v1/oracle/*` (arriba) |

En la billetera del casino, las fianzas llegan como débitos con `reason: "resolution_bond"`. Las devoluciones llegan como créditos con `reason: "resolution_bond_refund"` o `"resolution_bond_reward"`.
