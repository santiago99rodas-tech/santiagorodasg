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
| Liquidaciones que entran y salen | **Fideicomiso** (cuenta de liquidación) o **bóveda USDC** si el casino liquida en USDC | `fideicomiso` o `boveda_usdc` / `casino:<casino>` |
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

### Pólizas de caución y cartas de crédito

Un casino no tiene que inmovilizar dinero para dar garantía. Puede entregar:
- una **póliza de caución**: una aseguradora se compromete a pagar si el casino no paga;
- una **carta de crédito stand-by**: lo mismo, pero de un banco.

Al casino le cuesta una prima anual, normalmente del 1% al 3% del monto. Para empezar suele ser más fácil que un fideicomiso.

**Cómo se usa** (Tesorería → **Pólizas y cartas de crédito** → Registrar):
- Se registra el casino, el tipo, la aseguradora o el banco, el número, el monto, el vencimiento y, si quieres, el enlace al documento firmado.
- **Cuenta como garantía** igual que el dinero depositado, para la garantía exigida y para el límite de deuda. En la tabla de casinos se ve separado: efectivo y pólizas.
- **Deja de contar 7 días antes de vencer** (`GUARANTEE_MIN_VALIDITY_DAYS`). Así, si el casino no paga justo antes del vencimiento, todavía hay tiempo de ejecutarla. Si no la renueva antes, la operación del casino se pausa sola.
- **Aviso desde 30 días antes** (`GUARANTEE_WARN_DAYS`), en rojo, en la tabla de casinos y en la de pólizas.
- Al llegar la fecha, **vence sola**.

**Ejecutarla.** Si el casino no paga una liquidación, se reclama a la aseguradora o al banco con la documentación de la póliza. Cuando pagan, el botón **Ejecutar** registra el cobro con la referencia de su transferencia:
- el dinero entra al fideicomiso;
- la liquidación queda cubierta;
- la póliza queda con el saldo que le reste.

**Devolver.** Si el casino la reemplaza o termina la relación, **Devolver** la saca de vigor.

**En el libro contable** las pólizas van en cuentas de orden (`contingente:<casino>` y `contingente:emisores`). No son dinero, así que **no entran en las reservas**: aparecen aparte, como "Pólizas y cartas de crédito vigentes". Su alta, vencimiento, devolución y ejecución quedan encadenadas en el libro como cualquier otro asiento.

El casino ve sus pólizas en `GET /operator/v1/treasury`.

**Antes de aceptar una póliza:**
- Revisa que la aseguradora esté autorizada por la superintendencia de su país.
- La póliza debe ser **a primer requerimiento**: paga cuando la reclamas, sin esperar un juicio.
- El beneficiario debe ser la plataforma o el fideicomiso.

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

### Custodia de market makers

El dinero de los market makers externos va en una cuenta separada (`custodia_mm`). Sus cuentas cambian por más que depósitos y retiros:
- ganan o pierden negociando, contra jugadores de los casinos o contra la casa;
- cobran reembolsos e incentivos;
- pagan comisiones.

Esa plata entra o sale por las liquidaciones con los casinos y por el resultado de la casa, es decir, por el fideicomiso.

**En cada ronda de liquidaciones**, la plataforma pone la custodia al día. Compara lo que se le debe a cada market maker (saldo + dinero en órdenes + costo de sus posiciones abiertas) con lo que dice el libro, y asienta el traspaso:
- **Si ganaron:** del fideicomiso a la custodia.
- **Si perdieron:** de la custodia al fideicomiso.

Tesorería tiene que hacer esa transferencia de verdad entre las dos cuentas. Si en Reservas la custodia no coincide con sus cuentas, el botón **Ajustar ahora** hace el asiento sin esperar a la próxima ronda (`POST /admin/treasury/mm-custody/true-up`).

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

## 6. Modelo mixto: blockchain donde suma

La plata de los jugadores **no** toca blockchain: sigue en cada casino. Blockchain se usa en dos lugares, sin que la plataforma guarde llaves privadas.

### Sellos en Bitcoin (OpenTimestamps)

Una vez al día (`ANCHOR_EVERY_HOURS`), si hubo asientos nuevos, la huella del último asiento del libro se sella en Bitcoin con [OpenTimestamps](https://opentimestamps.org). Es gratis, no necesita billetera ni cripto, y la hacen dos calendarios públicos por redundancia.

- Cada sello prueba que el libro tenía **exactamente** esa huella en esa fecha. Si después alguien reescribiera la historia, la huella ya no coincidiría con la que está en Bitcoin.
- Los sellos son públicos: `GET /v1/oracle/anchors` (firmado) y `GET /v1/oracle/anchors/<id>.ots`. Se puede publicar solo la huella porque no revela nada del contenido.
- **Para verificar:** sube el `.ots` a opentimestamps.org, o usa `ots verify -d <huella> archivo.ots`. Bitcoin lo confirma en unas horas; mientras tanto queda "pendiente" en el calendario.
- En el back-office está en Tesorería → Sellos en Bitcoin, con el botón "Sellar en Bitcoin" para hacerlo a mano.

### Vía de liquidación en USDC (opcional, por casino)

Para los casinos que prefieren no pasar por el banco, sobre todo entre países: sus garantías y liquidaciones van en **USDC** a una **bóveda multifirma**.

**Cómo se monta:**

1. **Bóveda**: crea una billetera multifirma, por ejemplo una [Safe](https://safe.global) en Polygon o Base, con 3 firmantes que necesiten 2 firmas para mover plata (ejemplo: tú, tu socio y la fiduciaria o el contador). La plataforma **nunca** tiene esas llaves.
2. **Nodo**: consigue una URL de JSON-RPC de la red, de un proveedor como Alchemy o Infura, o un nodo propio. La plataforma solo lee.
3. **Variables** del servicio `api`:
   ```
   USDC_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/<clave>
   USDC_CHAIN=polygon
   USDC_VAULT_ADDRESS=0x<dirección de la Safe>
   USDC_START_BLOCK=<bloque en que se creó la Safe>
   ```
   `USDC_TOKEN_ADDRESS` es opcional: por defecto usa el USDC nativo de Circle en Polygon, Base, Arbitrum o Ethereum.
4. **Cada casino**: en Tesorería → Configurar, elige "USDC" y pon la dirección desde la que va a pagar y en la que va a cobrar.

**Cómo funciona:**

- **El casino paga.** Su estado de cuenta trae las instrucciones: red, contrato de USDC, bóveda y monto exacto con 6 decimales. Transfiere desde su dirección a la bóveda. Cada `USDC_SYNC_EVERY_MIN` (5) la plataforma lee la cadena, ve la transferencia y marca la liquidación como pagada, con el hash de la transacción como referencia.
- **La plataforma paga.** Los firmantes envían el USDC desde la Safe a la dirección del casino. La plataforma lo detecta igual y marca pagada la liquidación.
- **Garantías en USDC.** El casino las transfiere a la bóveda. La línea aparece en "Sin conciliar" y el tesorero la marca con "Es garantía".
- **Reservas.** El saldo **real** de la bóveda se lee de la cadena y se compara con el del libro. Si alguien sacara plata por fuera, aparece la diferencia.
- **Margen de confirmaciones.** Solo cuenta transferencias con `USDC_CONFIRMATIONS` (20) bloques encima, para no tomar transacciones que después se revierten.
- **Cambio de vía.** Un casino no puede pasar de una vía a otra con liquidaciones abiertas o garantía depositada: primero se devuelve y se vuelve a depositar por la vía nueva. Así cada cuenta del libro cuadra con su banco o con su bóveda.

**Antes de activarla**, revisa con un abogado de cada país:
- si guardar USDC de los casinos en la bóveda exige registrarse como proveedor de activos virtuales;
- cómo se registra en la contabilidad y en impuestos;
- si los bancos de cada casino aceptan que compre y venda USDC en un exchange.

Para casinos 100% tradicionales, la vía bancaria con fideicomiso o póliza sigue siendo la más simple.

### Probar la vía USDC sin dinero real

Mientras están en pruebas hay dos modos. Ninguno mueve dinero con valor, y el back-office muestra un aviso de "Modo de prueba" en Tesorería.

**a) Simulado: sin cadena, para empezar.** Pon solo `USDC_CHAIN=simulado`. No hace falta nodo, bóveda ni billetera.

- Configura los casinos en USDC con cualquier dirección `0x` de 40 caracteres, por ejemplo `0x1111111111111111111111111111111111111111`.
- En Tesorería aparece **Simular transferencia USDC**. Elige el casino, si entra o sale de la bóveda, y el monto.
- Cada liquidación pendiente de un casino en USDC tiene además **Simular pago USDC**, con el monto exacto.
- La transferencia simulada pasa por la misma conciliación que una real:
  - si coincide con una liquidación, la marca pagada;
  - si no coincide, queda en "Sin conciliar" y puedes marcarla con "Es garantía".
- La bóveda simulada lleva su propio saldo. Así la sección Reservas compara libro contra bóveda igual que en real. Si registras a mano un movimiento que no simulaste, verás la diferencia.
- Por API: `POST /admin/treasury/usdc/simulate { direction: "in" | "out", address, amountUsd }`. Solo responde con `USDC_CHAIN=simulado`.

**b) Red de prueba: la cadena de verdad, con USDC sin valor.** Sirve para ensayar con los casinos el flujo completo: billeteras, firmas de la Safe y confirmaciones. Usa Base Sepolia:

1. Crea una billetera de prueba, por ejemplo MetaMask con la red Base Sepolia, para cada casino de prueba y para los firmantes.
2. Pide USDC de prueba gratis en [faucet.circle.com](https://faucet.circle.com), red Base Sepolia. Para el gas, pide ETH de prueba en un faucet de Base Sepolia.
3. Crea la bóveda en [app.safe.global](https://app.safe.global) eligiendo Base Sepolia.
4. Variables:
   ```
   USDC_CHAIN=base-sepolia
   USDC_RPC_URL=https://sepolia.base.org
   USDC_VAULT_ADDRESS=0x<Safe en Base Sepolia>
   USDC_CONFIRMATIONS=2
   ```
   El contrato del USDC de prueba de Circle se pone solo. También funcionan `sepolia`, `polygon-amoy` y `arbitrum-sepolia`.

**Al pasar a dinero real** cambia a la red real (`USDC_CHAIN=polygon` o `base`), con la URL de un proveedor de nodos y una Safe nueva en esa red. Lo registrado en pruebas no sirve en producción: empieza con una base limpia o anula esas liquidaciones.

## Configuración

| Variable | Por defecto | Qué hace |
|---|---|---|
| `SETTLEMENT_EVERY_HOURS` | 24 | Cada cuánto se emite la liquidación de cada casino |
| `SETTLEMENT_PAYMENT_TERM_HOURS` | 48 | Plazo para pagarla |
| `TREASURY_AUTO_COLLECT_GUARANTEE` | false | Cobrar de la garantía automáticamente al vencer |
| `TREASURY_JOB_EVERY_MIN` | 30 | Cada cuánto revisa liquidaciones, vencimientos y pausas |
| `GUARANTEE_MIN_VALIDITY_DAYS` | 7 | Días antes del vencimiento en que una póliza deja de contar como garantía |
| `GUARANTEE_WARN_DAYS` | 30 | Desde cuántos días antes del vencimiento se avisa |
| `ANCHOR_ENABLED` / `ANCHOR_EVERY_HOURS` | true / 24 | Sello diario del libro en Bitcoin |
| `ANCHOR_CALENDARS` | a.pool y b.pool de opentimestamps.org | Calendarios de OpenTimestamps |
| `USDC_RPC_URL` / `USDC_CHAIN` / `USDC_VAULT_ADDRESS` | — / polygon / — | Vía USDC (se activa con las tres). `USDC_CHAIN=simulado` la activa sin cadena; `base-sepolia`, `sepolia`, `polygon-amoy` y `arbitrum-sepolia` son redes de prueba |
| `USDC_TOKEN_ADDRESS` / `USDC_START_BLOCK` | USDC nativo / últimos 5.000 bloques | Contrato del token y desde qué bloque leer |
| `USDC_CONFIRMATIONS` / `USDC_SYNC_EVERY_MIN` | 20 / 5 | Margen de bloques y cada cuánto leer la cadena |

La garantía exigida y el límite de deuda se fijan por casino en el back-office, o con `PATCH /admin/treasury/casinos/:id`.

## API

| Quién | Llamada |
|---|---|
| Admin | `GET /admin/treasury` (resumen) · `POST /admin/treasury/settle` · `POST /admin/treasury/settlements/:id/pay { bankRef }` · `POST /admin/treasury/settlements/:id/collect` · `GET /admin/treasury/settlements/:id/statement` |
| Admin | `GET /admin/treasury/instruments` · `POST /admin/treasury/instruments { operatorId, kind: poliza\|carta_credito, issuer, number, amountUsd, expiresAt, documentUrl?, notes? }` · `POST /admin/treasury/instruments/:id/execute { settlementId, bankRef }` · `POST /admin/treasury/instruments/:id/release` |
| Admin | `POST /admin/treasury/guarantees/:casino { direction, amountUsd, bankRef? }` · `POST /admin/treasury/reserve { … }` · `PATCH /admin/treasury/casinos/:casino { guaranteeRequiredUsd?, debtLimitUsd?, paused? }` |
| Admin | `POST /admin/treasury/bank-statements { csv }` · `GET /admin/treasury/journal` · `GET /admin/treasury/reserves` |
| Admin | `POST /admin/treasury/anchor` (sellar ya) · `POST /admin/treasury/usdc/sync` (leer la bóveda ya) · `POST /admin/treasury/usdc/simulate { direction, address, amountUsd }` (solo modo simulado) · `POST /admin/treasury/bank-lines/:id/guarantee { operatorId }` |
| Público | `GET /v1/oracle/anchors` · `GET /v1/oracle/anchors/:id.ots` |
| Casino | `GET /operator/v1/treasury` · `GET /operator/v1/treasury/statements/:id` (firmado) |

## Lo que no hace el software

- **No mueve dinero del banco.** Emite, controla y concilia; las transferencias las hace el tesorero o la fiduciaria. Se puede conectar la API del banco más adelante.
- **No reemplaza los contratos.** El de fiducia y el de integración con cada casino deben decir lo mismo que hace el sistema: plazos, garantía, cobro y pausa. Debe redactarlos un abogado de cada país.
- **El libro es tan confiable como su resguardo.** La cadena de hashes detecta cambios y los sellos en Bitcoin prueban cómo estaba el libro en cada fecha, pero igual conviene respaldar la base fuera del servidor.
