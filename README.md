# Predicciones: mercados de predicción para casinos online

Plataforma de mercados de predicción al estilo Polymarket, pensada para integrarse por API como una pestaña nueva ("Predicciones") dentro de un casino online existente.

- **Mercados Sí/No y de opción múltiple** con libro de órdenes central (CLOB), acciones que pagan $1 y precios que reflejan probabilidades.
- **Billetera seamless**: el dinero sigue en el casino; la plataforma pide débitos y créditos firmados con HMAC.
- **Información → preguntas**: ingesta de periódicos, revistas, Google Trends, GDELT y señales de redes sociales; detección de tendencias y preguntas generadas con IA (Claude) que pasan por moderación.
- **Resolución** con propuesta, ventana de disputa y pago automático; la IA puede proponer resultados investigando en la web.
- **Market maker de la casa** para que siempre haya liquidez.
- **Módulo embebible** (iframe) con dashboards, gráficas, libro de órdenes, apuestas en vivo y "Mis predicciones".

## Estructura

```
server/            API, motor, servicios, ingesta, IA (TypeScript + Fastify + PostgreSQL)
  src/engine/      Libro de órdenes (puro, con pruebas)
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
npm test                          # 24 pruebas: motor, trading, billetera, resolución, ingesta, IA (con cliente simulado) y API
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
| Resoluciones | Ver propuestas y evidencias, disputar, rechazar, finalizar y pagar; resolver con IA los eventos cerrados |
| Tendencias y señales | Tendencias detectadas, generar preguntas desde una tendencia, cargar señales de Instagram/TikTok |
| Fuentes | Estado de cada fuente, activar o desactivar, agregar nuevas y leer ahora |
| Riesgo de la casa | Inventario y dinero comprometido del market maker por mercado; recotizar |
| Casinos | Alta de operadores con sus credenciales (se muestran una sola vez) |

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
| Riesgo de la casa | `GET /admin/exposure` |

Las tareas programadas (ingesta, generación, cierre, resolución, market maker, reintentos, webhooks) corren solas. Sus intervalos se configuran en `.env`.

## Documentación

- [Guía de integración para casinos](docs/INTEGRACION-CASINO.md)
- [Arquitectura y comparación con Polymarket](docs/ARQUITECTURA.md)
- [Despliegue en Easypanel](docs/DESPLIEGUE-EASYPANEL.md)
