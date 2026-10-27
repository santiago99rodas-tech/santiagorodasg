# Market maker v2, protección contra informados y simulador

La casa cotiza siempre a ambos lados del libro para que cualquier jugador pueda apostar al instante. Esta guía explica cómo decide sus precios la versión 2, cómo se protege de los apostadores que saben más que el mercado, cómo se prueba con el simulador y qué mostró la simulación.

- Matemática: `server/src/engine/quoting.ts` y `server/src/engine/toxicity.ts` (puras, sin base de datos)
- Market maker real: `server/src/services/marketmaker.ts`; protección: `server/src/services/toxicity.ts`
- Simulador: `server/src/sim/` (`npm run sim`)
- Panel: back-office → **Riesgo de la casa**

El simulador y el servidor usan el mismo código de cotización y el mismo motor de órdenes. Lo que se prueba es lo que corre.

## Las 5 piezas

### 1. El precio aprende del dinero (LMSR)

Cada acción Sí neta que compran los jugadores sube el precio un poco. Cada acción No neta lo baja. La regla exacta es la de LMSR (el mecanismo de Robin Hanson): el log-odds sube `1/b` por acción.

- `b` es la profundidad, `MM_B_SHARES`, por defecto 1.500 acciones. Con más `b` el precio se mueve más despacio.
- Ejemplo: a 50% y con b = 1.500, si los jugadores compran 300 acciones Sí netas, el precio pasa a ~55%.
- Las compras de la casa no cuentan. Solo cuenta lo que hacen los jugadores.
- Solo cuenta lo que le compran **a la casa**. Si un jugador negocia con un market maker externo o con otro jugador, el precio de la casa se acerca al precio de ese cruce, en vez de contar sus acciones ([P2P.md](P2P.md#la-casa-queda-de-respaldo)).

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

## Protección contra el apostador informado

Un apostador casual le deja plata a la casa. Uno informado, el que leyó la noticia antes o conoce el tema mejor que nadie, se la quita. La teoría (Glosten-Milgrom) dice que quien da liquidez tiene que cobrar ese riesgo. La pregunta es a quién y cómo, sin castigar al casual.

Hay tres herramientas. Se prenden con `TOX_ENABLED=true` (el valor por defecto).

### 1. Markout por jugador y recargo

**Markout:** cuánto le ganó cada apuesta a la casa frente al precio que pagó. Se mide dos veces:
- con el precio justo **una hora después** (`TOX_MARKOUT_MIN`);
- con el **resultado final**: $1 o $0 por acción, $0,50 si se anula.

Ejemplo: alguien compra Sí a 53¢ y una hora después el precio justo está en 80¢. Su markout es +27¢. Si el mercado se resuelve No, su markout final es −53¢.

| Jugador | Markout medio | Por qué |
|---|---|---|
| Casual | Negativo | Paga el spread y no sabe más que el mercado |
| Informado | Positivo | Le gana a la casa de forma sostenida |

**Puntaje:** no se usa el promedio sin más, porque tres aciertos de suerte no deben marcar a nadie. Se usa su **límite inferior estadístico**: promedio − 2 errores estándar, y se exigen al menos 10 apuestas medidas. Solo se marca a quien tiene evidencia de que gana de verdad.

**Recargo:**
- 0 con puntaje hasta `TOX_START_CENTS` (0,5¢).
- Sube en línea recta hasta `TOX_MAX_SURCHARGE_BPS` (3%) con `TOX_FULL_CENTS` (3¢).
- Se cobra **solo en lo que le compra a la casa**. Si cruza con otro jugador, paga la comisión normal.

En el back-office (Riesgo de la casa → Apostadores con ventaja) se ve a cada jugador con su markout, puntaje y recargo, y se puede fijar un recargo a mano o volver al automático.

> **Ojo legal:** cobrarle más a quien gana se parece a lo que hacen las casas de apuestas al limitar a los apostadores profesionales. Hay que avisarlo en los términos del casino. La respuesta de cada orden ya trae la comisión cobrada (`fee`).

**Qué se descartó y por qué:**
- **Medir desde el precio justo del momento** en vez del precio pagado. La propia compra mueve el precio justo (LMSR), así que una apuesta grande "acertaba" solo por haber movido el precio ella misma.
- **El "closing line value"** (precio al cierre) que usan las casas de apuestas. En el simulador, una hinchada que compra siempre lo mismo empuja el precio de cierre a su favor. Salía marcada como informada aunque perdía $11.000 por mercado. Contra el resultado final eso no pasa.

### 2. Spread asimétrico por desequilibrio del flujo

Si en las últimas 6 horas (`TOX_FLOW_WINDOW_MIN`) casi todo el dinero de los jugadores fue al mismo lado, ese lado probablemente trae información. La casa abre **solo el lado que están golpeando**:

```
medio spread extra = TOX_IMBALANCE_SPREAD × desequilibrio   (en log-odds; 0,12 por defecto)
desequilibrio = (compras Sí − compras No) / total
```

- Si compran Sí, sube la oferta de Sí y la puja queda igual.
- Con menos de $150 de volumen reciente no cuenta (`TOX_IMBALANCE_MIN_USD`).
- Sirve contra informados que abren **cuentas nuevas**, donde el markout por jugador no alcanza a juntar historial.

### 3. Freno de emergencia y noticias

- **Freno:** si el precio justo salta `TOX_BREAKER_CENTS` (12¢) o más en `TOX_BREAKER_WINDOW_MIN` (10 min), la casa retira sus órdenes de ese mercado `TOX_PAUSE_MIN` (5 min). Después vuelve con el doble de spread y la mitad del tamaño hasta completar `TOX_SHOCK_MIN` (30 min).
- **Noticias:** cuando la ingesta detecta una tendencia con publicaciones de la última hora que comparte 2 o más palabras clave con un evento abierto, ese evento cotiza con más spread un rato. No se retira la casa.
- Se puede activar a mano: `POST /admin/markets/:id/shock { pause, reason }`.

### Resultados de la protección (v2+ = v2 con las tres herramientas)

| Escenario | Casa v2 | Casa v2+ | Informados v2 → v2+ | Casuales v2 → v2+ | Medio spread v2 → v2+ |
|---|---:|---:|---:|---:|---:|
| Normal | $2.165 | **$3.135** | $2.300 → $1.408 | −$4.320 → −$4.405 | 2,8¢ → 3,2¢ |
| Muchos informados | $1.780 | **$2.174** | $389 → $59 | −$1.998 → −$2.077 | 2,4¢ → 2,7¢ |
| Noticia de último minuto | $2.639 | **$3.894** | $2.370 → $1.217 | −$4.857 → −$4.975 | 2,6¢ → 3,0¢ |
| Ballenas | $3.043 | **$3.966** | $1.632 → $1.008 | −$4.406 → −$4.492 | 3,2¢ → 3,6¢ |
| Múltiple, 5 opciones | $5.830 | **$7.594** | $7.775 → $6.230 | −$4.962 → −$5.059 | 2,6¢ → 2,8¢ |
| Informados con cuentas nuevas | $3.233 | **$3.548** | $1.203 → $1.083 | −$4.293 → −$4.452 | 2,8¢ → 3,2¢ |

**A quién marcó el recargo** al final de 200 mercados:

| Grupo | Marcados |
|---|---|
| Informados | 83–100% |
| Casuales | **0%** |
| Hinchada | **0%** |
| Ballenas | 0% |

Con cuentas nuevas solo se marca al 14% de los informados, porque ninguna cuenta junta historial. Ahí trabaja el spread asimétrico. Con referencia externa los informados pierden plata y no se marca a nadie.

**El costo:** el spread asimétrico y el freno también los paga el casual, unos $80–160 más por mercado, un 2–4%. El recargo por markout, en cambio, no le cuesta nada al casual: se probó solo y su resultado quedó igual. `TOX_IMBALANCE_SPREAD=0` deja solo el recargo.

El freno no se activó en el simulador: avanza de a una hora y el precio no salta 12¢ en una vuelta. Está pensado para noticias de verdad, que mueven el precio en minutos.

### Cómo se arman las cotizaciones

Cada 30 segundos (`MM_REFRESH_EVERY_SEC`):

1. Se actualiza el precio justo con el flujo de los jugadores y las referencias nuevas.
2. Se calculan 3 niveles a cada lado. El nivel 1 es el precio actual más el medio spread. Los niveles 2 y 3 siguen la curva LMSR, como si los jugadores ya hubieran comprado los niveles anteriores.
3. Solo se reemplazan las órdenes de los mercados donde cambió algo.

Ejemplo real de la demo (México, 24%, evento de 6 opciones): compra a 22/20/18 y venta a 26/28/31, con 200 acciones por nivel.

## El simulador

```bash
cd server
npm run sim                                   # 200 mercados por escenario: v1, v2 y v2+ (con protección)
npm run sim -- --mm v2,v2+                    # solo algunas estrategias
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
4. **Escenarios:** normal, muchos informados, noticia de último minuto, hinchada, ballenas, múltiple de 5 opciones, informados con cuentas nuevas y con referencia externa.
   - Los jugadores tienen identidad y se repiten entre mercados (300 casuales, 6 informados, 50 hinchas, 5 ballenas), así la casa puede aprender quién es quién. En "cuentas nuevas" cada apuesta informada viene de una cuenta distinta.
5. **Métricas:**
   - Resultado de la casa: promedio, peor 5%, peor caso y % de mercados con pérdida.
   - Pérdida máxima en riesgo y caída máxima.
   - Spread que ve el jugador.
   - Error del precio frente a la verdad y Brier.
   - Cuánto gana o pierde cada tipo de jugador y a qué porcentaje de cada tipo le llegó el recargo.

### Resultados (200 mercados por escenario)

| Escenario | MM | Resultado medio de la casa | Mercados con pérdida | Medio spread | Error del precio | Brier 1 día antes |
|---|---|---:|---:|---:|---:|---:|
| Normal | v1 | $130 | 26,5% | 2,0¢ | 34,6¢ | 0,498 |
| Normal | **v2** | **$2.165** | **1%** | 2,8¢ | **9,4¢** | **0,028** |
| Muchos informados | v1 | $225 | 9,5% | 2,0¢ | 31,4¢ | 0,472 |
| Muchos informados | **v2** | **$1.780** | 2% | 2,4¢ | **3,5¢** | **0,011** |
| Noticia de último minuto | v1 | $209 | 22% | 2,0¢ | 39,1¢ | 0,558 |
| Noticia de último minuto | **v2** | **$2.639** | **0%** | 2,6¢ | **8,0¢** | **0,003** |
| Hinchada | v1 | $849 | 8% | 2,0¢ | 45,3¢ | 0,605 |
| Hinchada | **v2** | **$8.577** | **0%** | 3,9¢ | **12,7¢** | **0,064** |
| Ballenas | v1 | $345 | 11,5% | 2,0¢ | 35,6¢ | 0,522 |
| Ballenas | **v2** | **$3.043** | **0%** | 3,2¢ | **8,5¢** | **0,027** |
| Múltiple, 5 opciones | v1 | −$92 | 56% | 2,0¢ | 16,7¢ | 0,184 |
| Múltiple, 5 opciones | **v2** | **$5.830** | **0%** | 2,6¢ | **9,1¢** | **0,053** |
| Con referencia externa | v1 | $332 | 8% | 2,0¢ | 39,1¢ | 0,588 |
| Con referencia externa | **v2** | **$1.749** | 9,5% | 3,3¢ | **2,6¢** | **0,008** |

Los resultados de v2+ (con protección) están en la sección anterior.

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
- **Con referencia externa**, v2 queda a 2,6¢ de la verdad, pero 9,5% de los mercados terminan en pérdida. La referencia mueve el precio a saltos y los informados aprovechan el momento del salto. Bajar `MM_W_EXTERNAL` reduce ese efecto.
- **Los apostadores casuales pierden más con v2** (−$4.300 por mercado, frente a −$1.400 con v1). Hay dos razones: v2 cotiza siempre los dos lados, así que hay más volumen, y el spread es algo más ancho. Eso pesa sobre todo cuando apuestan al lado barato (10¢ con 3¢ de spread). Es una decisión de producto: menos `γ` o más `b` significa spreads más chicos, a cambio de más riesgo para la casa.

### Límites del modelo

- Los jugadores robot son un modelo, no personas. Los parámetros se deben recalibrar con datos reales:
  - El panel de Calibración muestra si el precio predice bien.
  - Riesgo de la casa muestra la pérdida en el peor escenario.
- El simulador no modela jugadores que ponen órdenes límite entre ellos. En la plataforma real esas órdenes existen y mejoran el precio.
- Los informados del simulador no cambian de comportamiento cuando se les cobra recargo. Uno real podría repartir sus apuestas entre cuentas: para eso está el spread asimétrico, y los casinos suelen tener controles de cuentas duplicadas (KYC).
- La volatilidad se mide con las fotos del precio justo cada 15 minutos. Antes se medía con el precio de cada cruce, que rebota entre compra y venta y llega a segundos de distancia: eso disparaba la volatilidad y abría el spread hasta 1¢/99¢. Se corrigió con este paso y lo cubre una prueba.

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

| `TOX_ENABLED` | true | Protección contra informados |
| `TOX_MARKOUT_MIN` | 60 | Minutos hasta medir el markout corto |
| `TOX_MIN_TRADES` / `TOX_CONFIDENCE_Z` | 10 / 2 | Apuestas mínimas y confianza para marcar a alguien |
| `TOX_START_CENTS` / `TOX_FULL_CENTS` / `TOX_MAX_SURCHARGE_BPS` | 0,5 / 3 / 300 | Desde qué puntaje empieza el recargo, dónde llega al máximo y cuál es el máximo |
| `TOX_FLOW_WINDOW_MIN` / `TOX_IMBALANCE_SPREAD` / `TOX_IMBALANCE_MIN_USD` | 360 / 0,12 / 150 | Spread asimétrico por desequilibrio del flujo |
| `TOX_BREAKER_CENTS` / `TOX_BREAKER_WINDOW_MIN` | 12 / 10 | Salto que activa el freno |
| `TOX_PAUSE_MIN` / `TOX_SHOCK_MIN` | 5 / 30 | Minutos sin cotizar y minutos con spread ancho |
| `TOX_SHOCK_SPREAD_MULT` / `TOX_SHOCK_SIZE_FACTOR` | 2 / 0,5 | Spread y tamaño durante el freno o una noticia |

API de admin:
- Market maker: `GET /admin/mm/status` (estado, parámetros y riesgo por evento), `POST /admin/mm/kill { on }` y `POST /admin/mm/refresh`.
- Protección: `GET /admin/toxicity`, `POST /admin/players/:id/surcharge { bps | null }` y `POST /admin/markets/:id/shock { pause, reason }`.
