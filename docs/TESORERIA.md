# Tesorería: el dinero real, sin blockchain

La plataforma no guarda la plata de los jugadores: sigue en cada casino, que es quien tiene la licencia para custodiarla. El módulo de tesorería controla todo lo demás:

- quién le debe a quién después de cada período;
- las garantías de los casinos y la reserva de la casa;
- la conciliación con el banco;
- un registro que nadie puede alterar sin que se note.

- Código: `server/src/services/treasury.ts`
- Back-office: sección **Tesorería**
- Casinos: `GET /operator/v1/treasury`

## Dónde está cada peso

| Dinero | Dónde vive | En el libro |
|---|---|---|
| Saldos y apuestas de los jugadores | Cuenta de cada casino | No (lo lleva cada casino; la plataforma registra cada débito y crédito en el ledger) |
| Garantías de los casinos | **Fideicomiso** | `fideicomiso` / `garantia:<casino>` |
| Reserva de la casa (capital para cubrir sus pérdidas) | **Fideicomiso** | `fideicomiso` / `capital:reserva_casa` |
| Liquidaciones que entran y salen | **Fideicomiso** (cuenta de liquidación) | `fideicomiso` / `casino:<casino>` |
| Saldo de los market makers externos | **Cuenta de custodia separada** | `custodia_mm` / `mm:<id>` |

El fideicomiso es una cuenta a nombre de una fiduciaria regulada (fiducia en Colombia, fideicomiso en Ecuador). Ni la plataforma ni los casinos la pueden usar para otra cosa que lo que dice el contrato, y no entra en una eventual quiebra. Es lo que reemplaza a "la plata bloqueada en un contrato inteligente".

## 1. Liquidaciones

Cada `SETTLEMENT_EVERY_HOURS` (24 por defecto), o con **Liquidar ahora**, la plataforma emite una liquidación por casino, desde la anterior hasta ese momento:

- **Monto**: lo de [P2P.md](P2P.md). Es lo que el casino cobró a sus jugadores menos lo que les pagó en los mercados resueltos, menos su parte de las comisiones.
  - **Positivo**: el casino transfiere al fideicomiso.
  - **Negativo**: la plataforma le transfiere al casino.
- **Referencia de pago**: `LIQ-<número>`. Hay que ponerla en la transferencia para que se concilie sola.
- **Plazo**: `SETTLEMENT_PAYMENT_TERM_HOURS` (48 por defecto).
- **Estado de cuenta firmado**: un JSON con el período, el detalle y la garantía del casino, firmado con la clave Ed25519 del oráculo. Incluye también el hash del último asiento del libro, que fija en qué punto de la historia se emitió.
  - El casino lo descarga en `GET /operator/v1/treasury/statements/:id` y lo verifica con la clave pública de `/v1/oracle/keys`.
  - Si sus números no coinciden, tiene la prueba de lo que le dijo la plataforma, y la plataforma no puede cambiarlo después.

**Estados:**

| Estado | Qué significa |
|---|---|
| Pendiente | Emitida, dentro del plazo |
| Pagada | Llegó o salió la transferencia (con su referencia) |
| Vencida | Pasó el plazo sin pago |
| Cobrada de garantía | Se descontó de la garantía del casino |

## 2. Garantías y pausa automática

En **Tesorería → Configurar** se fija para cada casino:

- **Garantía exigida**: lo que debe tener depositado en el fideicomiso. Por ejemplo, una semana de su volumen esperado.
- **Límite de deuda**: lo máximo que puede deber sin pagar. Si se deja vacío, es su garantía.

La operación del casino se **pausa sola** si pasa cualquiera de estas cosas:
- tiene una liquidación **vencida** sin pagar;
- su garantía está por debajo de la exigida;
- su deuda supera el límite. La deuda cuenta lo emitido sin pagar más lo que va acumulando en el período en curso.

**Pausado** significa que sus jugadores no pueden abrir apuestas nuevas (error `operator_paused`). Sí pueden vender lo que tienen y cobrar sus premios: nadie queda atrapado.

La operación se **reanuda sola** cuando se regulariza. Una pausa manual (casilla en Configurar) solo se quita a mano.

Si no se configura ni garantía ni límite, no hay pausa por deuda, solo por liquidaciones vencidas.

**Cobro de la garantía:** con una liquidación vencida, el botón **Cobrar de garantía** descuenta lo adeudado, o lo que alcance. Con `TREASURY_AUTO_COLLECT_GUARANTEE=true` se hace solo al vencer. Después el casino tiene que reponer la garantía o queda pausado.

## 3. Libro contable encadenado

Cada movimiento de tesorería es un asiento de doble partida (las partidas suman cero) en la tabla `journal`:

- **No se edita ni se borra.** Un error se corrige con otro asiento.
- **Cada asiento guarda el hash SHA-256 del anterior.** Si alguien cambia un monto, borra un asiento o cambia el orden, la cadena se rompe desde ahí.
- **Verificación:** el back-office muestra "Íntegro" o "ROTO desde el asiento #N". También está en `GET /admin/treasury/journal` y en `npm run smoke`.
- El hash del último asiento va dentro de cada estado de cuenta firmado. Cada casino se queda con una copia de ese punto de la historia, así que la plataforma no puede reescribirla sin que lo noten.

| Asiento | Partidas |
|---|---|
| Depósito de garantía | `fideicomiso +X` / `garantia:<casino> −X` |
| Liquidación emitida | `casino:<casino> +monto` / `compensacion −monto` |
| Pago de una liquidación | `fideicomiso +monto` / `casino:<casino> −monto` (con monto negativo si la plataforma paga) |
| Cobro con la garantía | `garantia:<casino> +X` / `casino:<casino> −X` |
| Aporte a la reserva | `fideicomiso +X` / `capital:reserva_casa −X` |
| Depósito de un market maker | `custodia_mm +X` / `mm:<id> −X` |

## 4. Reservas

**Tesorería → Reservas** (o `GET /admin/treasury/reserves`) responde: ¿alcanza el dinero del fideicomiso?

```
obligaciones = garantías que se deben devolver
             + liquidaciones por pagar a casinos
             + pérdida de la casa en el peor escenario (límites del market maker)
cobertura    = fideicomiso ÷ obligaciones
```

Si la cobertura baja de 100% se marca en rojo: hay que aportar a la reserva. Aparte, compara la cuenta de custodia de los market makers con el valor de sus cuentas: saldo, más lo que tienen en órdenes, más sus posiciones.

El informe sale **del libro**. Se compara con el saldo real del banco con la conciliación.

## 5. Conciliación con el banco

**Tesorería → Cargar extracto**: se pega el extracto del fideicomiso en CSV.

```
fecha;referencia;monto;descripcion
2026-10-27;TRX-9001;60,60;Pago LIQ-12 Casino Dos
2026-10-27;TRX-9002;-59,44;Transferencia LIQ-11 a Casino Uno
```

- Separador `;` (con coma decimal) o `,` (con punto decimal). Montos positivos entran y negativos salen.
- Cada línea se cruza con las liquidaciones:
  - primero por la referencia `LIQ-<número>` y el monto exacto;
  - si no la tiene, por un único monto igual pendiente.
- Una liquidación pendiente que aparece en el banco queda **pagada** sola, con la referencia de la transferencia.
- Lo que no cruza queda en "Extracto sin conciliar" para revisarlo o ignorarlo.
- Cargar el mismo extracto dos veces no duplica nada.

## Un ciclo completo

1. **Día 0**: el Casino B deposita su garantía de $1.000 en el fideicomiso. Se registra en Tesorería → Garantía.
2. **Días 1–7**: se apuesta. La plata de los jugadores entra y sale de cada casino como siempre.
3. **Día 8, 00:00**: se emite LIQ-12. El Casino B debe $60,60 y recibe su estado de cuenta firmado con plazo de 48 horas.
4. **Día 9**: el Casino B transfiere $60,60 al fideicomiso con la referencia "LIQ-12". El tesorero carga el extracto y LIQ-12 queda pagada sola.
5. **Si no hubiera pagado**: el día 10 queda vencida, el Casino B se pausa y se cobra de su garantía. Cuando la repone, se reanuda.

## Configuración

| Variable | Por defecto | Qué hace |
|---|---|---|
| `SETTLEMENT_EVERY_HOURS` | 24 | Cada cuánto se emite la liquidación de cada casino |
| `SETTLEMENT_PAYMENT_TERM_HOURS` | 48 | Plazo para pagarla |
| `TREASURY_AUTO_COLLECT_GUARANTEE` | false | Cobrar de la garantía automáticamente al vencer |
| `TREASURY_JOB_EVERY_MIN` | 30 | Cada cuánto revisa liquidaciones, vencimientos y pausas |

La garantía exigida y el límite de deuda se fijan por casino en el back-office, o con `PATCH /admin/treasury/casinos/:id`.

## API

| Quién | Llamada |
|---|---|
| Admin | `GET /admin/treasury` (resumen) · `POST /admin/treasury/settle` · `POST /admin/treasury/settlements/:id/pay { bankRef }` · `POST /admin/treasury/settlements/:id/collect` · `GET /admin/treasury/settlements/:id/statement` |
| Admin | `POST /admin/treasury/guarantees/:casino { direction, amountUsd, bankRef? }` · `POST /admin/treasury/reserve { … }` · `PATCH /admin/treasury/casinos/:casino { guaranteeRequiredUsd?, debtLimitUsd?, paused? }` |
| Admin | `POST /admin/treasury/bank-statements { csv }` · `GET /admin/treasury/journal` · `GET /admin/treasury/reserves` |
| Casino | `GET /operator/v1/treasury` · `GET /operator/v1/treasury/statements/:id` (firmado) |

## Lo que no hace el software

- **No mueve dinero del banco.** Emite, controla y concilia; las transferencias las hace el tesorero o la fiduciaria. Se puede conectar la API del banco más adelante.
- **No reemplaza los contratos.** El de fiducia y el de integración con cada casino deben decir lo mismo que hace el sistema: plazos, garantía, cobro y pausa. Debe redactarlos un abogado de cada país.
- **El libro es tan confiable como su resguardo.** La cadena de hashes detecta cambios, pero conviene respaldar la base fuera del servidor y entregar a un auditor, de vez en cuando, el hash del último asiento.
