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

## Arranque rápido

Requisitos: Node.js 22+ y PostgreSQL 16 (o Docker).

```bash
cd server
cp .env.example .env              # ajusta DATABASE_URL; agrega ANTHROPIC_API_KEY para activar la IA
npm install
npm run seed -- --demo            # crea tablas, categorías, fuentes, 15 mercados de ejemplo y el operador demo
npm run dev                       # API en http://localhost:8080
npm run mock-casino               # en otra terminal: casino de prueba en http://localhost:4000
npm run simulate                  # opcional: jugadores simulados para ver actividad en vivo
```

Abre http://localhost:4000: es un casino de ejemplo con la pestaña Predicciones embebida. El saldo del casino baja al apostar y sube con ventas y premios.

Con Docker: `docker compose up --build`, luego `docker compose exec api npm run seed -- --demo` y `docker compose --profile demo up mock-casino`.

## Pruebas

```bash
cd server
createdb predicciones_test        # una sola vez
npm test                          # 24 pruebas: motor, trading, billetera, resolución, ingesta, IA (con cliente simulado) y API
npm run typecheck
```

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
