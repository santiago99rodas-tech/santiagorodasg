# Predicciones: mercados de predicción para casinos online

Plataforma de mercados de predicción al estilo Polymarket, pensada para integrarse por API como una pestaña nueva ("Predicciones") dentro de un casino online existente.

- **Mercados Sí/No y de opción múltiple** con libro de órdenes central (CLOB), acciones que pagan $1 y precios que reflejan probabilidades.
- **Billetera seamless**: el dinero sigue en el casino; la plataforma pide débitos y créditos firmados con HMAC.
- **Información → preguntas**: ingesta de periódicos, revistas, Google Trends, GDELT y señales de redes sociales; detección de tendencias y preguntas generadas con IA (Claude) que pasan por moderación.
- **Resolución con fianzas** al estilo del oráculo de UMA: la casa (IA o moderador) o un jugador propone el resultado con una fianza, cualquier jugador puede disputarlo con la suya, y quien tenía razón se queda con parte de la fianza del otro. La IA puede proponer resultados investigando en la web.
- **P2P**: un solo libro para los jugadores de todos los casinos, con liquidación entre casinos (la plataforma compensa quién le debe a quién), API para market makers externos con saldo propio, reembolso e incentivos de liquidez diarios al estilo Polymarket, y la casa como respaldo; el simulador mide cuánto ganan casa, market makers y jugadores ([detalle](docs/P2P.md)).
- **Tesorería sin blockchain**: liquidación periódica por casino con estado de cuenta firmado, garantías en un fideicomiso o como póliza de caución o carta de crédito con vencimiento, pausa automática del casino que no paga, libro contable encadenado con hash y sellado cada día en Bitcoin, informe de reservas y conciliación con el extracto del banco; vía opcional de liquidación en USDC con bóveda multifirma ([detalle](docs/TESORERIA.md)).
- **Oráculo público**: `/v1/oracle` publica la probabilidad de cada mercado firmada con Ed25519, junto con su historial de calibración ([detalle](docs/ORACULO.md)).
- **Market maker de la casa** para que siempre haya liquidez: precio que aprende del flujo (LMSR), spread Avellaneda-Stoikov, liquidez que baja cerca del cierre, límites de pérdida y botón de pánico. Protección contra apostadores informados: recargo según su markout, spread asimétrico y freno de emergencia. Probado con un simulador de jugadores ([detalle](docs/MARKET-MAKER.md)).
- **Módulo embebible** (iframe) con dashboards, gráficas, libro de órdenes, apuestas en vivo y "Mis predicciones".

## Estructura

```
server/            API, motor, servicios, ingesta, IA (TypeScript + Fastify + PostgreSQL)
  src/engine/      Libro de órdenes y matemática del market maker (puros, con pruebas)
  src/sim/         Simulador de jugadores contra el market maker (npm run sim)
  src/services/    Trading, billetera, market maker, resolución, eventos, datos de mercado
  src/ingest/      Fuentes, palabras clave y detección de tendencias
  src/ai/          Generador de preguntas y resolvedor (Claude)
  src/api/         Rutas: pública, jugador, operador (casino) y admin
  mock-casino/     Casino de prueba (billetera de referencia) y simulador de jugadores
  test/            Pruebas unitarias y de integración
web/embed/         Módulo que el casino muestra en su iframe
prototipo/         Prototipo visual inicial
docs/              Arquitectura y guía de integración para casinos
```

## Catálogo de mercados

`server/src/db/catalog/` trae más de 650 preguntas listas para publicar en 26 categorías, con al menos 25 por categoría: política, elecciones, internacional, fútbol, deportes, cripto, economía, finanzas, tecnología, inteligencia artificial, cine y sagas, programas de TV, streaming, música, premios, farándula, reinados, moda, redes sociales, videojuegos, espacio, OVNIs y misterios, animales y naturaleza, clima, ciencia y sociedad.

- `npm run seed -- --catalog` las carga (omite las que ya existen o ya cerraron).
- `npx tsx src/db/catalog/validate.ts` revisa formato, fechas, probabilidades, duplicados y el mínimo por categoría.
- Para mantener el mínimo, la tarea `rellenar-categorias` revisa cada categoría. Si tiene menos de `MIN_OPEN_PER_CATEGORY` (25) mercados abiertos más borradores pendientes, la IA investiga en la web lo que está pasando y lo que la gente busca, y propone preguntas nuevas. Por defecto pasan por moderación; con `AUTO_APPROVE_AI_DRAFTS=true` se publican solas si cumplen las reglas.
- Cobertura actual: `GET /admin/categories/coverage`. Relleno manual: `POST /admin/categories/refill` o `POST /admin/drafts/generate { "category": "videojuegos", "count": 10 }`.

## Arranque rápido

Requisitos: Node.js 22+ y PostgreSQL 16 (o Docker).

```bash
cd server
cp .env.example .env              # ajusta DATABASE_URL; agrega ANTHROPIC_API_KEY para activar la IA
npm install
npm run seed -- --demo            # crea tablas, categorías, fuentes, el catálogo completo (con historial de demostración) y el operador demo
npm run dev                       # API en http://localhost:8080
npm run mock-casino               # en otra terminal: casino de prueba en http://localhost:4000
npm run simulate                  # opcional: jugadores simulados para ver actividad en vivo
```

Abre http://localhost:4000: es un casino de ejemplo con la pestaña Predicciones embebida. El saldo del casino baja al apostar y sube con ventas y premios.

Con Docker: `docker compose up --build`, luego `docker compose exec api npm run seed -- --demo` y `docker compose --profile demo up mock-casino`.

## Demo autónoma (sin servidor)

`demo/` arma un solo HTML que corre todo en el navegador: el motor de órdenes, el market maker de la casa, la billetera, las resoluciones, el catálogo de 702 mercados y jugadores simulados (`demo/backend.js`). El módulo del jugador y el back-office reales se cargan dentro de un casino de demostración, y sus llamadas a la API las atiende ese backend en memoria.

```bash
cd server && npm run demo:build     # genera demo/dist/predicciones-demo.html
```

Sirve para mostrar el producto a casinos sin desplegar nada. Se reinicia al recargar, y la IA y la ingesta de noticias quedan desactivadas porque necesitan el servidor.

## Pruebas

```bash
cd server
createdb predicciones_test        # una sola vez
npm test                          # 68 pruebas: motor, market maker, protección contra informados, trading, billetera, resolución, ingesta, IA (con cliente simulado), integridad y API
npm run sim                       # simulador: market maker v1, v2 y v2 con protección en 8 escenarios
npm run typecheck
```

## Panel de administración (back-office)

`web/admin/index.html` es el back-office de Predicciones, servido en `/admin/`. Se entra con `ADMIN_API_KEY` y el nombre de quien opera, que queda registrado en aprobaciones y resoluciones.

| Sección | Qué permite |
|---|---|
| Resumen | Volumen, comisiones, jugadores en línea, alertas (créditos fallidos, fuentes caídas, eventos sin resolver) y cobertura de las 26 categorías frente al mínimo de 25, con botón "Rellenar con IA" |
| Diseñar mercado | Crear preguntas Sí/No o de opción múltiple con probabilidades iniciales, criterio de resolución (con plantilla), fuente, imagen y portada; vista previa en vivo de la tarjeta del jugador y validación antes de publicar |
| Moderación | Aprobar (una a una o en lote), editar en el diseñador o rechazar con motivo las preguntas que propone la IA |
| Mercados | Buscar y filtrar, destacar, cerrar, proponer resolución y duplicar |
| Resoluciones | Ver propuestas, disputas y evidencias de los dos lados con sus fianzas; decidir quién tenía razón (liquida las fianzas y paga), rechazar, finalizar; resolver con IA los eventos cerrados |
| Tendencias y señales | Tendencias detectadas, generar preguntas desde una tendencia, cargar señales de Instagram/TikTok |
| Fuentes | Estado de cada fuente, activar o desactivar, agregar nuevas y leer ahora |
| Oráculo | Lo que se publica: Brier 24 h y 7 días antes, calibración, disputas y fianzas, endpoints públicos, clave pública y cómo verificar las firmas, y las probabilidades que se están publicando |
| Calibración y sesgo | Si los precios predicen bien (gráfico de calibración y puntaje de Brier por categoría y volumen), sesgo favorito-batacazo, proporción Sí/No, precisión de la apertura (IA vs. catálogo), concentración del dinero, sesgo de hinchada por país, resultado de la casa según quién resolvió, alertas de compras tardías y comparación con referencias externas (Polymarket o precios manuales) |
| Riesgo de la casa | Estado del market maker (v2), pérdida en el peor escenario por evento y total frente a sus límites, liquidez y spread por evento, inventario por mercado, recotizar y botón de pánico; apostadores con ventaja (markout, puntaje y recargo, ajustable a mano) y mercados en freno |
| Casinos | Alta de operadores con sus credenciales (se muestran una sola vez) y su revenue share |
| Market makers | Market makers externos: alta con credenciales, depósitos y retiros de su saldo, suspender, volumen como maker y reembolsos; incentivos de liquidez (pozo por mercado, parte de cada uno hoy, pagos) |
| Tesorería | Liquidaciones con estado y estado de cuenta firmado, garantías y límites por casino (con pausa automática), pólizas y cartas de crédito con vencimiento y ejecución, reserva de la casa, conciliación con el extracto del banco y libro contable encadenado |
| Liquidación | Cuánto le debe cada casino a la plataforma o ella a él por los mercados resueltos, y quién le compró a quién (entre casinos, con market makers, con la casa) |

**Montarlo en bo-sio.com** (o en cualquier back-office existente), de tres maneras:
1. **Proxy inverso**: publicar el servidor bajo `https://bo-sio.com/predicciones/` (Nginx o similar apuntando a la API). El panel queda en `https://bo-sio.com/predicciones/admin/`.
2. **Archivo estático**: copiar `web/admin/index.html` al hosting de bo-sio.com y abrirlo con `?api=https://<url-de-la-api>`. La API ya permite llamadas de otro dominio con `X-Admin-Key`.
3. **Dentro del back-office actual**: agregar un menú "Predicciones" que lo abra en un iframe.

En todos los casos, restringe `/admin` por IP o VPN y cambia `ADMIN_API_KEY` en producción.

## Operación diaria (API de admin, cabecera `X-Admin-Key`)

| Tarea | Llamada |
|---|---|
| Agregar una fuente | `POST /admin/sources` `{ kind: "rss", name, url, category? }` |
| Traer noticias ya | `POST /admin/ingest/run` |
| Ver tendencias | `GET /admin/trends` |
| Cargar señales de Instagram/TikTok | `POST /admin/social-signals` (una o un arreglo) |
| Generar preguntas con IA | `POST /admin/drafts/generate` `{ trendId? , limit? }` |
| Moderar | `GET /admin/drafts` → `POST /admin/drafts/:id/approve` `{ edits? }` o `/reject` |
| Crear un mercado a mano | `POST /admin/events` |
| Resolver | `POST /admin/events/:id/resolve` `{ outcome \| winningMarketId }` o `/ai-resolve` |
| Disputar / finalizar | `POST /admin/resolutions/:id/dispute` · `/finalize` `{ force? }` |
| Dar de alta un casino | `POST /admin/operators` `{ id, name, walletUrl, webhookUrl?, theme? }` |
| Riesgo de la casa | `GET /admin/exposure` · `GET /admin/mm/status` |
| Botón de pánico del market maker | `POST /admin/mm/kill` `{ on: true }` |
| Apostadores con ventaja y mercados en freno | `GET /admin/toxicity` · `POST /admin/players/:id/surcharge` `{ bps }` |

Las tareas programadas (ingesta, generación, cierre, resolución, market maker, reintentos, webhooks) corren solas. Sus intervalos se configuran en `.env`.

## Documentación

- [Guía de integración para casinos](docs/INTEGRACION-CASINO.md)
- [Arquitectura y comparación con Polymarket](docs/ARQUITECTURA.md)
- [Market maker v2, protección contra informados y simulador](docs/MARKET-MAKER.md)
- [Oráculo: probabilidades públicas y resolución con fianzas](docs/ORACULO.md)
- [P2P: libro compartido, market makers externos y liquidación](docs/P2P.md)
- [Tesorería: dónde vive el dinero, liquidaciones, garantías y libro contable](docs/TESORERIA.md)
- [Despliegue en Easypanel](docs/DESPLIEGUE-EASYPANEL.md): claves con `npm run gen:secrets`, variables en `deploy/easypanel.env.example` y revisión del despliegue con `npm run smoke`
