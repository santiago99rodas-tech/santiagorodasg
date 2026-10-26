# Imagen de la plataforma (API, módulo del jugador y back-office). La usa Easypanel: Build Path "/",
# Dockerfile "server/Dockerfile". El mismo archivo sirve para el casino de prueba cambiando el comando.
FROM node:22-alpine

WORKDIR /app/server
COPY server/package*.json ./
# Solo dependencias de producción (tsx incluido: ejecuta el TypeScript directamente).
# Sin --omit=optional: esbuild, que usa tsx, trae su binario como dependencia opcional.
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./
COPY web/ /app/web/

ARG APP_VERSION=dev
ENV NODE_ENV=production PORT=8080 APP_VERSION=$APP_VERSION
RUN chown -R node:node /app
USER node
EXPOSE 8080

# HEALTH_PORT: para el casino de prueba (escucha en 4000) se pone HEALTH_PORT=4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${HEALTH_PORT:-$PORT}/health" >/dev/null || exit 1

# Node corre directo (sin npx) para recibir SIGTERM: src/index.ts hace el apagado ordenado
CMD ["node", "--import", "tsx", "src/index.ts"]
