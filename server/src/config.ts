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
  },
  jobs: {
    ingestEveryMin: num("INGEST_EVERY_MIN", 30),
    generateEveryMin: num("GENERATE_EVERY_MIN", 120),
    mmRefreshEverySec: num("MM_REFRESH_EVERY_SEC", 30),
  },
};
