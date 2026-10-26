import { readFileSync, existsSync } from "node:fs";

// Carga .env sin dependencias externas (las variables ya definidas en el entorno tienen prioridad).
const envPath = new URL("../.env", import.meta.url);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const str = (k: string, d: string) => process.env[k] || d;
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);

export const config = {
  port: num("PORT", 8080),
  publicUrl: str("PUBLIC_URL", "http://localhost:8080"),
  databaseUrl: str("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/predicciones"),
  adminApiKey: str("ADMIN_API_KEY", "dev-admin-key"),
  sessionSecret: str("SESSION_SECRET", "dev-session-secret"),
  sessionTtlMinutes: num("SESSION_TTL_MIN", 240),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  aiModel: str("AI_MODEL", "claude-opus-5-5"),
  newsApiKey: process.env.NEWSAPI_KEY || "",
  takerFeeBps: num("TAKER_FEE_BPS", 200),
  challengeWindowMinutes: num("CHALLENGE_WINDOW_MINUTES", 120),
  mm: {
    enabled: str("MM_ENABLED", "true") === "true",
    spreadCents: num("MM_SPREAD_CENTS", 4),
    levelSizeShares: num("MM_LEVEL_SIZE_SHARES", 200),
    levels: num("MM_LEVELS", 3),
    maxExposureUsd: num("MM_MAX_EXPOSURE_USD", 5000),
    // v1: spread fijo y media móvil. v2: log-odds + LMSR + spread Avellaneda-Stoikov (ver docs/MARKET-MAKER.md)
    strategy: str("MM_STRATEGY", "v2") as "v1" | "v2",
    bShares: num("MM_B_SHARES", 1500),
    minLiquidity: num("MM_MIN_LIQUIDITY", 0.15),
    tauRefDays: num("MM_TAU_REF_DAYS", 7),
    gamma: num("MM_GAMMA", 0.5),
    kappa: num("MM_KAPPA", 12),
    sigmaFloor: num("MM_SIGMA_FLOOR", 0.25),
    holdDays: num("MM_HOLD_DAYS", 1),
    minHalfSpreadCents: num("MM_MIN_HALF_SPREAD_CENTS", 1),
    maxLossUsd: num("MM_MAX_LOSS_USD", 2000),
    maxTotalLossUsd: num("MM_MAX_TOTAL_LOSS_USD", 50000),
    // Pesos en log-odds del precio justo propio frente a la referencia externa (Polymarket u otra)
    weightPrev: num("MM_W_PREV", 0.6),
    weightExternal: num("MM_W_EXTERNAL", 0.5),
    externalMaxAgeHours: num("MM_EXTERNAL_MAX_AGE_HOURS", 6),
  },
  integrity: {
    // Volumen mínimo de un mercado para entrar en los análisis de concentración y sesgo por país
    minVolumeUsd: num("INTEGRITY_MIN_VOLUME_USD", 200),
    // Monto mínimo de una compra para generar alerta (compras tardías ganadoras; el doble para cuentas nuevas)
    alertMinUsd: num("INTEGRITY_ALERT_MIN_USD", 100),
    lateWindowMinutes: num("INTEGRITY_LATE_WINDOW_MIN", 120),
    // Máximo que un jugador puede tener comprometido en un mismo mercado (0 = sin límite)
    maxStakePerMarketUsd: num("MAX_STAKE_PER_MARKET_USD", 1000),
  },
  catalog: {
    // Mínimo de mercados abiertos (más borradores pendientes) por categoría que la IA intenta mantener
    minOpenPerCategory: num("MIN_OPEN_PER_CATEGORY", 25),
    maxNewPerCategoryRun: num("MAX_NEW_PER_CATEGORY_RUN", 10),
    // true: los borradores de la IA que pasan la validación se publican sin moderación humana
    autoApproveAi: str("AUTO_APPROVE_AI_DRAFTS", "false") === "true",
  },
  jobs: {
    ingestEveryMin: num("INGEST_EVERY_MIN", 30),
    generateEveryMin: num("GENERATE_EVERY_MIN", 120),
    mmRefreshEverySec: num("MM_REFRESH_EVERY_SEC", 30),
    refillEveryMin: num("REFILL_EVERY_MIN", 360),
  },
};
