import { readFileSync, existsSync } from "node:fs";
import { createPrivateKey } from "node:crypto";

// Carga .env sin dependencias externas (las variables ya definidas en el entorno tienen prioridad).
const envPath = new URL("../.env", import.meta.url);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const str = (k: string, d: string) => process.env[k] || d;

/**
 * Clave del oráculo en cualquiera de las formas en que suele pegarse: el PEM completo (con saltos reales
 * o con \n literales, o con los saltos perdidos) o solo el contenido base64 (lo que entrega gen:secrets).
 * Devuelve un PEM bien formado; "" si no hay clave.
 */
export function normalizeOracleKey(raw: string) {
  const v = raw.trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n");
  if (!v) return "";
  const body = v.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END PRIVATE KEY-----\n`;
}
/** null si la clave sirve; si no, el motivo en palabras simples. */
export function oracleKeyProblem(pem: string, rawLength: number) {
  if (!pem) return null;
  try {
    const k = createPrivateKey(pem);
    return k.asymmetricKeyType === "ed25519" ? null : `ORACLE_PRIVATE_KEY es una clave ${k.asymmetricKeyType}, no Ed25519: genera otra con npm run gen:secrets`;
  } catch {
    return `ORACLE_PRIVATE_KEY no es una clave válida (llegaron ${rawLength} caracteres; la de npm run gen:secrets mide 64). Probablemente se cortó al copiarla: genera otra con npm run gen:secrets y pega la línea completa`;
  }
}
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
  // Resolución con fianzas (docs/ORACULO.md)
  resolution: {
    playerBondUsd: num("RESOLUTION_BOND_USD", 10), // fianza de un jugador para proponer o disputar
    houseBondUsd: num("HOUSE_BOND_USD", 100), // fianza de la casa cuando propone (IA o moderador)
    rewardShare: num("BOND_REWARD_SHARE", 0.5), // parte de la fianza del que perdió que se lleva el que tenía razón
    playerProposeAfterHours: num("PLAYER_PROPOSE_AFTER_HOURS", 2), // horas después del cierre en que un jugador puede proponer
  },
  // P2P: market makers externos y liquidación entre casinos (docs/P2P.md)
  p2p: {
    makerRebateBps: num("MAKER_REBATE_BPS", 50), // reembolso al market maker externo sobre lo que le toman (sale de la comisión del taker)
    maxBatch: num("MM_API_MAX_BATCH", 50),
    // La casa queda de respaldo: si hay liquidez externa cerca del precio a ambos lados, abre su spread
    backstopCents: num("HOUSE_BACKSTOP_CENTS", 2),
    backstopMinShares: num("HOUSE_BACKSTOP_MIN_SHARES", 200),
    backstopSpreadMult: num("HOUSE_BACKSTOP_SPREAD_MULT", 2),
  },
  // Incentivos de liquidez para market makers externos (docs/P2P.md). Sin pozo configurado no se paga nada.
  rewards: {
    enabled: str("LIQ_REWARDS_ENABLED", "true") === "true",
    defaultDailyUsd: num("LIQ_REWARD_DAILY_USD", 0),      // pozo diario de cada mercado abierto (se puede fijar por mercado)
    maxDailyUsd: num("LIQ_REWARDS_MAX_DAILY_USD", 1000), // tope de lo que se paga en total por día
    maxSpreadCents: num("LIQ_REWARD_MAX_SPREAD", 3),     // solo puntúan órdenes a esta distancia del medio o menos
    minShares: num("LIQ_REWARD_MIN_SHARES", 50),         // y de este tamaño o más
    singleSidedFactor: num("LIQ_REWARD_SINGLE_SIDED_FACTOR", 3), // cotizar de un solo lado vale 1/3
    sampleSec: num("LIQ_REWARD_SAMPLE_SEC", 60),
  },
  // Tesorería (docs/TESORERIA.md)
  treasury: {
    settlementEveryHours: num("SETTLEMENT_EVERY_HOURS", 24), // cada cuánto se emite la liquidación de cada casino
    paymentTermHours: num("SETTLEMENT_PAYMENT_TERM_HOURS", 48), // plazo para pagarla
    autoCollectGuarantee: str("TREASURY_AUTO_COLLECT_GUARANTEE", "false") === "true", // cobrar de la garantía al vencer
    jobEveryMin: num("TREASURY_JOB_EVERY_MIN", 30),
    // Pólizas y cartas de crédito: dejan de contar como garantía estos días antes de vencer (para que
    // haya tiempo de ejecutarlas), y se avisa desde estos otros días antes
    instrumentMinValidityDays: num("GUARANTEE_MIN_VALIDITY_DAYS", 7),
    instrumentWarnDays: num("GUARANTEE_WARN_DAYS", 30),
  },
  // Anclaje del libro contable en Bitcoin con OpenTimestamps (gratis, sin billetera)
  anchor: {
    enabled: str("ANCHOR_ENABLED", "true") === "true",
    everyHours: num("ANCHOR_EVERY_HOURS", 24),
    calendars: str("ANCHOR_CALENDARS", "https://a.pool.opentimestamps.org,https://b.pool.opentimestamps.org").split(",").map((x) => x.trim()).filter(Boolean),
  },
  // Vía de liquidación en USDC (solo lectura de la cadena: no guarda llaves)
  usdc: {
    rpcUrl: process.env.USDC_RPC_URL || "",
    chain: str("USDC_CHAIN", "polygon"),
    token: process.env.USDC_TOKEN_ADDRESS || "",
    vault: (process.env.USDC_VAULT_ADDRESS || "").toLowerCase(),
    confirmations: num("USDC_CONFIRMATIONS", 20),
    startBlock: process.env.USDC_START_BLOCK ? Number(process.env.USDC_START_BLOCK) : null,
    maxRange: num("USDC_MAX_BLOCK_RANGE", 2000),
    syncEveryMin: num("USDC_SYNC_EVERY_MIN", 5),
  },
  oracle: {
    name: str("ORACLE_NAME", "Predicciones"),
    // Si la clave configurada no sirve, se ignora (con advertencia al arrancar) y se usa la guardada en la base
    privateKeyPem: ((pem) => (oracleKeyProblem(pem, 0) ? "" : pem))(normalizeOracleKey(process.env.ORACLE_PRIVATE_KEY || "")),
    cacheSeconds: num("ORACLE_CACHE_SECONDS", 30),
  },
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
  // Protección contra apostadores informados (engine/toxicity.ts, docs/MARKET-MAKER.md)
  toxicity: {
    enabled: str("TOX_ENABLED", "true") === "true",
    markoutMinutes: num("TOX_MARKOUT_MIN", 60),
    flowWindowMinutes: num("TOX_FLOW_WINDOW_MIN", 360),
    minTrades: num("TOX_MIN_TRADES", 10),
    confidenceZ: num("TOX_CONFIDENCE_Z", 2),
    startCents: num("TOX_START_CENTS", 0.5),
    fullCents: num("TOX_FULL_CENTS", 3),
    maxSurchargeBps: num("TOX_MAX_SURCHARGE_BPS", 300),
    imbalanceSpread: num("TOX_IMBALANCE_SPREAD", 0.12),
    imbalanceMinUsd: num("TOX_IMBALANCE_MIN_USD", 150),
    breakerCents: num("TOX_BREAKER_CENTS", 12),
    breakerWindowMinutes: num("TOX_BREAKER_WINDOW_MIN", 10),
    pauseMinutes: num("TOX_PAUSE_MIN", 5),
    shockMinutes: num("TOX_SHOCK_MIN", 30),
    shockSpreadMult: num("TOX_SHOCK_SPREAD_MULT", 2),
    shockSizeFactor: num("TOX_SHOCK_SIZE_FACTOR", 0.5),
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

const DEFAULTS = { adminApiKey: "dev-admin-key", sessionSecret: "dev-session-secret" };

/** Errores que impiden arrancar en producción (NODE_ENV=production). */
export function productionProblems() {
  if (process.env.NODE_ENV !== "production") return [];
  const out: string[] = [];
  if (!process.env.DATABASE_URL) out.push("Falta DATABASE_URL (la Internal Connection URL del Postgres de Easypanel)");
  if (config.adminApiKey === DEFAULTS.adminApiKey || config.adminApiKey.length < 24) out.push("ADMIN_API_KEY falta o es corta: usa una de 24 caracteres o más (npm run gen:secrets)");
  if (config.sessionSecret === DEFAULTS.sessionSecret || config.sessionSecret.length < 24) out.push("SESSION_SECRET falta o es corta: usa una de 24 caracteres o más (npm run gen:secrets)");
  return out;
}

/** Cosas que conviene revisar pero no impiden arrancar. */
export function productionWarnings() {
  if (process.env.NODE_ENV !== "production") return [];
  const out: string[] = [];
  if (!process.env.PUBLIC_URL || /localhost|127\.0\.0\.1/.test(config.publicUrl)) out.push("PUBLIC_URL apunta a localhost: los enlaces del módulo para los casinos no van a funcionar");
  const rawKey = (process.env.ORACLE_PRIVATE_KEY || "").trim();
  const keyProblem = oracleKeyProblem(normalizeOracleKey(rawKey), rawKey.length);
  if (keyProblem) out.push(`${keyProblem}. Mientras tanto se usa la clave guardada en la base`);
  else if (!config.oracle.privateKeyPem) out.push("sin ORACLE_PRIVATE_KEY: se usa una clave generada y guardada en la base (fíjala con npm run gen:secrets)");
  if (!config.anthropicApiKey) out.push("sin ANTHROPIC_API_KEY: la IA (generar y resolver preguntas) queda desactivada");
  if (config.usdc.chain === "simulado") out.push("USDC_CHAIN=simulado: las transferencias USDC son simuladas desde el back-office; no usar con dinero real");
  else if (/sepolia|amoy/.test(config.usdc.chain) && config.usdc.rpcUrl) out.push(`USDC en red de prueba (${config.usdc.chain}): el USDC no tiene valor`);
  return out;
}
