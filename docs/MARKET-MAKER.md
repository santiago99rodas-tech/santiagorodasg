# Market maker v2 y simulador

La casa cotiza siempre a ambos lados del libro para que cualquier jugador pueda apostar al instante. Esta guía explica cómo decide sus precios la versión 2, cómo se prueba con el simulador y qué mostró la simulación.

- Matemática: `server/src/engine/quoting.ts` (pura, sin base de datos)
- Market maker real: `server/src/services/marketmaker.ts`
- Simulador: `server/src/sim/` (`npm run sim`)
- Panel: back-office → **Riesgo de la casa**

El simulador y el servidor usan el mismo código de cotización y el mismo motor de órdenes. Lo que se prueba es lo que corre.

## Las 5 piezas

### 1. El precio aprende del dinero (LMSR)

Cada acción Sí neta que compran los jugadores sube el precio un poco. Cada acción No neta lo baja. La regla exacta es la de LMSR (el mecanismo de Robin Hanson): el log-odds sube `1/b` por acción.

- `b` es la profundidad, `MM_B_SHARES`, por defecto 1.500 acciones. Con más `b` el precio se mueve más despacio.
- Ejemplo: a 50% y con b = 1.500, si los jugadores compran 300 acciones Sí netas, el precio pasa a ~55%.
- Las compras de la casa no cuentan. Solo cuenta lo que hacen los jugadores.

**Por qué importa:** el techo de pérdida. Aunque todos los que compren tengan razón, en un tramo la casa pierde a lo sumo `b · ln(1/π)`, donde π es la probabilidad de la opción que termina ganando.

| Mercado | Techo de pérdida |
|---|---|
| Sí/No a 50%, b = 1.500 | 1.500 × ln 2 ≈ $1.040 |
| 5 opciones iguales, b = 300 | 300 × ln 5 ≈ $483 |

Una prueba lo verifica: un jugador que sabe el resultado y compra todo lo que la casa ofrece no le saca más que ese techo (`test/quoting.test.ts`).

**Eventos múltiples** (Miss Universo, ligas): todas las opciones se mueven juntas. Si compran Colombia, suben Colombia y bajan las demás, y siempre suman 100%.

### 2. Combinar opiniones en log-odds

Cuando llega una referencia externa (precio de Polymarket o uno cargado a mano en Calibración), se combina con el precio propio en log-odds:

```
logit(p) = (w₁·logit(p₁) + w₂·logit(p₂)) / (w₁ + w₂)
```

- Ejemplo: 90% propio y 50% externo con el mismo peso dan **75%**. El promedio simple daría 70%.
- Pesos: `MM_W_PREV` (0,6, el precio propio) y `MM_W_EXTERNAL` (0,5).
- Cada referencia se aplica **una sola vez**, así una foto vieja no arrastra el precio en cada pasada.

### 3. El ancho del spread (Avellaneda-Stoikov)

El medio spread se calcula en log-odds:

```
medio spread = ½·γ·σ²·h + (1/γ)·ln(1 + γ/κ)
```

| Símbolo | Qué es | Variable | Valor |
|---|---|---|---|
| γ | Aversión al riesgo | `MM_GAMMA` | 0,5 |
| κ | Qué tan rápido dejan de llegar apuestas si el precio se aleja | `MM_KAPPA` | 12 |
| σ | Volatilidad del precio en las últimas 24 h | — | con un piso que crece cerca del cierre |
| h | Horizonte en que la casa espera rotar el inventario | `MM_HOLD_DAYS` | 1 día |

- En la práctica son 2 a 4 centavos de cada lado, y nunca menos de `MM_MIN_HALF_SPREAD_CENTS` (1¢).
- Si el precio se mueve mucho, el spread se abre solo.

### 4. Menos liquidez cerca del cierre (√ del tiempo)

Faltando pocas horas, el precio puede saltar a 0 o a 100 y aparecen los que ya saben el resultado. Por eso la profundidad `b` y el tamaño por nivel escalan con `√(días al cierre / MM_TAU_REF_DAYS)`, con un mínimo de `MM_MIN_LIQUIDITY`.

| Días al cierre | Liquidez |
|---|---|
| 7 o más | 100% |
| 1,75 | 50% |
| 0,5 | 27% |
| Último momento | 15% |

### 5. Límites duros

- **Pérdida en el peor escenario por evento** (`MM_MAX_LOSS_USD`, $2.000): la casa calcula cuánto perdería si gana la opción que más le cuesta. Si pasa el límite, solo cotiza lo que reduce ese riesgo.
- **Límite total** (`MM_MAX_TOTAL_LOSS_USD`, $50.000): la misma regla para la suma de todos los eventos.
- **Botón de pánico**: en Riesgo de la casa, o `POST /admin/mm/kill { "on": true }`. Retira todas las órdenes de la casa y deja de cotizar hasta reanudarlo. Las apuestas entre jugadores siguen funcionando.
  - El estado vive en memoria y vuelve a "activo" si el servidor se reinicia. Para apagarlo de forma permanente usa `MM_ENABLED=false`.

### Cómo se arman las cotizaciones

Cada 30 segundos (`MM_REFRESH_EVERY_SEC`):

1. Se actualiza el precio justo con el flujo de los jugadores y las referencias nuevas.
2. Se calculan 3 niveles a cada lado. El nivel 1 es el precio actual más el medio spread. Los niveles 2 y 3 siguen la curva LMSR, como si los jugadores ya hubieran comprado los niveles anteriores.
3. Solo se reemplazan las órdenes de los mercados donde cambió algo.

Ejemplo real de la demo (México, 24%, evento de 6 opciones): compra a 22/20/18 y venta a 26/28/31, con 200 acciones por nivel.

## El simulador

```bash
cd server
npm run sim                                   # 200 mercados por escenario, v1 contra v2
npm run sim -- --runs 50 --scenario multi5    # un escenario
npm run sim -- --set bShares=1000 --set gamma=1   # probar otros parámetros
npm run sim -- --out ../docs/SIMULACION-RESULTADOS.md
```

### Cómo funciona

1. **Ganador sorteado.** Se elige al azar según la probabilidad inicial. La probabilidad verdadera evoluciona con señales ruidosas (actualización bayesiana), cada vez más fuertes cerca del cierre.
2. **Apertura con error.** La probabilidad de apertura tiene error, como la de la IA o un moderador.
3. **Jugadores robot:**
   - **Casuales**: apuestan al azar.
   - **Informados**: conocen la verdad con algo de ruido y apuestan cuando el precio está lejos.
   - **Hinchada**: siempre al Sí de "su" opción.
   - **Ballenas**: apuestas de $800 a $1.500, algunas informadas.
4. **Escenarios:** normal, muchos informados, noticia de último minuto, hinchada, ballenas, múltiple de 5 opciones y con referencia externa.
5. **Métricas:**
   - Resultado de la casa: promedio, peor 5%, peor caso y % de mercados con pérdida.
   - Pérdida máxima en riesgo y caída máxima.
   - Spread que ve el jugador.
   - Error del precio frente a la verdad y Brier.
   - Cuánto gana o pierde cada tipo de jugador.

### Resultados (200 mercados por escenario)

| Escenario | MM | Resultado medio de la casa | Mercados con pérdida | Medio spread | Error del precio | Brier 1 día antes |
|---|---|---:|---:|---:|---:|---:|
| Normal | v1 | $177 | 22% | 2,0¢ | 34,8¢ | 0,507 |
| Normal | **v2** | **$2.156** | **0,5%** | 2,8¢ | **9,4¢** | **0,028** |
| Muchos informados | v1 | $251 | 9,5% | 2,0¢ | 32,4¢ | 0,472 |
| Muchos informados | **v2** | **$1.765** | 2,5% | 2,4¢ | **3,5¢** | **0,011** |
| Noticia de último minuto | v1 | $211 | 20% | 2,0¢ | 36,5¢ | 0,525 |
| Noticia de último minuto | **v2** | **$2.655** | **0%** | 2,6¢ | **8,0¢** | **0,003** |
| Hinchada | v1 | $847 | 4,5% | 2,0¢ | 46,0¢ | 0,619 |
| Hinchada | **v2** | **$8.626** | **0%** | 3,9¢ | **12,9¢** | **0,070** |
| Ballenas | v1 | $296 | 12,5% | 2,0¢ | 35,0¢ | 0,506 |
| Ballenas | **v2** | **$3.054** | **0%** | 3,2¢ | **8,4¢** | **0,022** |
| Múltiple, 5 opciones | v1 | −$82 | 55% | 2,0¢ | 16,9¢ | 0,185 |
| Múltiple, 5 opciones | **v2** | **$5.832** | **0%** | 2,6¢ | **9,1¢** | **0,055** |
| Con referencia externa | v1 | $319 | 12% | 2,0¢ | 39,1¢ | 0,575 |
| Con referencia externa | **v2** | **$1.762** | 10% | 3,3¢ | **2,6¢** | **0,008** |

La tabla completa, con peor 5%, peor caso y el resultado de cada tipo de jugador, está en [SIMULACION-RESULTADOS.md](SIMULACION-RESULTADOS.md).

### Qué se aprendió

- **v2 sigue la verdad y v1 no.**
  - El precio de v2 queda a 2,6–13¢ de la probabilidad real. El de v1, a 17–46¢.
  - El Brier un día antes del cierre baja de ~0,5 a 0,003–0,07. Un Brier de 0,25 es lo que da decir siempre 50%.
  - Esto es lo que hace falta para ser un oráculo.
- **v1 tiene dos fallas que la simulación dejó a la vista** (y que también están en la v1 del servidor):
  1. Su límite de exposición suma lo pagado por Sí **y** por No. Cuando la casa tiene las dos posiciones cubiertas y pasa de $5.000, cotiza un solo lado según el signo de un inventario neto que puede ser mínimo.
  2. Su corrimiento por inventario hace que los cruces ocurran por debajo del precio justo. El precio justo se mueve entonces en contra del flujo y puede terminar en 98% cuando la verdad es 0%.
- **El ajuste de `b` es la decisión más importante:**
  - Con b = 2.500 la casa perdía en 85% de los mercados normales: el precio aprendía tan despacio que los informados se llevaban la diferencia.
  - Con b = 600 la casa gana mucho, pero el spread se abre a 6¢ o más y el precio se aleja de la verdad.
  - 1.500 es el punto medio.
- **Con referencia externa**, v2 queda a 2,6¢ de la verdad, pero 10% de los mercados terminan en pérdida. La referencia mueve el precio a saltos y los informados aprovechan el momento del salto. Bajar `MM_W_EXTERNAL` reduce ese efecto.
- **Los apostadores casuales pierden más con v2** (−$4.300 por mercado, frente a −$1.500 con v1). Hay dos razones: v2 cotiza siempre los dos lados, así que hay más volumen, y el spread es algo más ancho. Eso pesa sobre todo cuando apuestan al lado barato (10¢ con 3¢ de spread). Es una decisión de producto: menos `γ` o más `b` significa spreads más chicos, a cambio de más riesgo para la casa.

### Límites del modelo

- Los jugadores robot son un modelo, no personas. Los parámetros se deben recalibrar con datos reales:
  - El panel de Calibración muestra si el precio predice bien.
  - Riesgo de la casa muestra la pérdida en el peor escenario.
- El simulador no modela jugadores que ponen órdenes límite entre ellos. En la plataforma real esas órdenes existen y mejoran el precio.
- La protección específica contra apostadores informados (medir si el precio les da la razón justo después de apostar y cobrarles más spread) es el paso siguiente.

## Configuración

| Variable | Por defecto | Qué hace |
|---|---|---|
| `MM_STRATEGY` | `v2` | `v1` vuelve a la versión anterior |
| `MM_B_SHARES` | 1500 | Profundidad LMSR con liquidez completa |
| `MM_LEVELS` / `MM_LEVEL_SIZE_SHARES` | 3 / 200 | Niveles por lado y acciones por nivel |
| `MM_GAMMA` / `MM_KAPPA` | 0,5 / 12 | Spread Avellaneda-Stoikov |
| `MM_SIGMA_FLOOR` / `MM_HOLD_DAYS` | 0,25 / 1 | Volatilidad mínima y horizonte de inventario |
| `MM_MIN_HALF_SPREAD_CENTS` | 1 | Medio spread mínimo |
| `MM_TAU_REF_DAYS` / `MM_MIN_LIQUIDITY` | 7 / 0,15 | Desde cuándo baja la liquidez y hasta dónde |
| `MM_MAX_LOSS_USD` | 2000 | Pérdida máxima en el peor escenario por evento |
| `MM_MAX_TOTAL_LOSS_USD` | 50000 | Lo mismo, para todos los eventos |
| `MM_W_PREV` / `MM_W_EXTERNAL` | 0,6 / 0,5 | Pesos del precio propio y de la referencia externa |
| `MM_EXTERNAL_MAX_AGE_HOURS` | 6 | Una referencia más vieja que esto no se usa |

API de admin: `GET /admin/mm/status` (estado, parámetros y riesgo por evento), `POST /admin/mm/kill { on }` y `POST /admin/mm/refresh`.
