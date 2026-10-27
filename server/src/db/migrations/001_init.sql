-- Unidades (igual que Polymarket, que usa USDC con 6 decimales):
--   precio  -> entero en centavos de dólar, 1..99 (= probabilidad en %), siempre en "espacio Sí"
--   qty     -> entero en centésimas de acción (100 = 1 acción, que paga $1 si gana)
--   dinero  -> entero en micro-dólares (1 USD = 1.000.000)

CREATE TABLE operators (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  api_key       TEXT NOT NULL UNIQUE,
  api_secret    TEXT NOT NULL,
  wallet_url    TEXT NOT NULL,
  wallet_secret TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  fee_bps       INTEGER,                         -- NULL = usa TAKER_FEE_BPS global
  webhook_url   TEXT,
  theme         JSONB NOT NULL DEFAULT '{}',     -- marca: nombre, logo, colores para el módulo embebido
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE players (
  id           BIGSERIAL PRIMARY KEY,
  operator_id  TEXT REFERENCES operators(id),    -- NULL = cuenta interna de la casa (market maker)
  external_id  TEXT NOT NULL,
  display_name TEXT,
  is_house     BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operator_id, external_id)
);

CREATE TABLE categories (
  slug  TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  sort  INTEGER NOT NULL DEFAULT 0
);

-- Un evento agrupa uno o varios mercados binarios (como en Polymarket):
--   binario: "¿Subirá BTC esta semana?" -> 1 mercado Sí/No
--   múltiple: "¿Quién ganará Miss Universo 2027?" -> 1 mercado Sí/No por país (neg_risk)
CREATE TABLE events (
  id                  BIGSERIAL PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  category            TEXT NOT NULL REFERENCES categories(slug),
  image_url           TEXT,
  kind                TEXT NOT NULL CHECK (kind IN ('binary','multi')),
  neg_risk            BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','resolving','resolved','void')),
  close_time          TIMESTAMPTZ NOT NULL,
  resolution_criteria TEXT NOT NULL,
  resolution_source   TEXT NOT NULL,
  tags                TEXT[] NOT NULL DEFAULT '{}',
  featured            BOOLEAN NOT NULL DEFAULT FALSE,
  draft_id            BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_status_idx ON events (status, close_time);

CREATE TABLE markets (
  id               BIGSERIAL PRIMARY KEY,
  event_id         BIGINT NOT NULL REFERENCES events(id),
  question         TEXT NOT NULL,
  outcome_label    TEXT NOT NULL,                 -- "Sí" en binarios, "Colombia" en múltiples
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','resolving','resolved','void')),
  close_time       TIMESTAMPTZ NOT NULL,
  initial_price    INTEGER NOT NULL CHECK (initial_price BETWEEN 1 AND 99),
  last_price       INTEGER NOT NULL CHECK (last_price BETWEEN 1 AND 99),
  fair_price       INTEGER NOT NULL CHECK (fair_price BETWEEN 1 AND 99), -- referencia del market maker
  volume           BIGINT NOT NULL DEFAULT 0,      -- micro-dólares negociados
  resolved_outcome TEXT CHECK (resolved_outcome IN ('YES','NO','VOID')),
  resolved_at      TIMESTAMPTZ,
  sort             INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX markets_event_idx ON markets (event_id);

CREATE TABLE orders (
  id            BIGSERIAL PRIMARY KEY,
  market_id     BIGINT NOT NULL REFERENCES markets(id),
  player_id     BIGINT NOT NULL REFERENCES players(id),
  side          TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  outcome       TEXT NOT NULL CHECK (outcome IN ('YES','NO')),
  order_type    TEXT NOT NULL CHECK (order_type IN ('LIMIT','MARKET')),
  tif           TEXT NOT NULL CHECK (tif IN ('GTC','FOK','FAK')),
  price         INTEGER NOT NULL CHECK (price BETWEEN 1 AND 99), -- precio del resultado elegido (no del Sí)
  qty           BIGINT NOT NULL,
  filled_qty    BIGINT NOT NULL DEFAULT 0,
  reserved      BIGINT NOT NULL DEFAULT 0,       -- dinero (compras) o acciones (ventas) aún bloqueados
  status        TEXT NOT NULL CHECK (status IN ('open','filled','cancelled','rejected')),
  client_ref    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_open_idx ON orders (market_id) WHERE status = 'open';
CREATE INDEX orders_player_idx ON orders (player_id, created_at DESC);
CREATE UNIQUE INDEX orders_client_ref_idx ON orders (player_id, client_ref) WHERE client_ref IS NOT NULL;

CREATE TABLE trades (
  id             BIGSERIAL PRIMARY KEY,
  market_id      BIGINT NOT NULL REFERENCES markets(id),
  maker_order_id BIGINT NOT NULL REFERENCES orders(id),
  taker_order_id BIGINT NOT NULL REFERENCES orders(id),
  yes_price      INTEGER NOT NULL,
  qty            BIGINT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('transfer_yes','transfer_no','mint','merge')),
  taker_fee      BIGINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trades_market_idx ON trades (market_id, created_at DESC);

CREATE TABLE positions (
  player_id  BIGINT NOT NULL REFERENCES players(id),
  market_id  BIGINT NOT NULL REFERENCES markets(id),
  outcome    TEXT NOT NULL CHECK (outcome IN ('YES','NO')),
  qty        BIGINT NOT NULL DEFAULT 0,
  reserved   BIGINT NOT NULL DEFAULT 0,          -- acciones bloqueadas por órdenes de venta abiertas
  cost       BIGINT NOT NULL DEFAULT 0,          -- costo acumulado (micro-dólares) de las acciones que quedan
  realized   BIGINT NOT NULL DEFAULT 0,          -- ganancia realizada
  PRIMARY KEY (player_id, market_id, outcome)
);

-- Cada movimiento de dinero con el casino (débito/crédito) queda aquí, idempotente por tx_id.
CREATE TABLE ledger (
  id           BIGSERIAL PRIMARY KEY,
  tx_id        TEXT NOT NULL UNIQUE,
  player_id    BIGINT NOT NULL REFERENCES players(id),
  operator_id  TEXT REFERENCES operators(id),
  direction    TEXT NOT NULL CHECK (direction IN ('debit','credit','rollback')),
  amount       BIGINT NOT NULL,                  -- micro-dólares
  reason       TEXT NOT NULL,                    -- order_reserve, order_refund, sell_proceeds, payout, void_refund
  market_id    BIGINT,
  order_id     BIGINT,
  status       TEXT NOT NULL CHECK (status IN ('pending','ok','failed')),
  operator_tx  TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_player_idx ON ledger (player_id, created_at DESC);

CREATE TABLE fees (
  id         BIGSERIAL PRIMARY KEY,
  trade_id   BIGINT REFERENCES trades(id),
  player_id  BIGINT NOT NULL REFERENCES players(id),
  operator_id TEXT REFERENCES operators(id),
  amount     BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE price_history (
  market_id BIGINT NOT NULL REFERENCES markets(id),
  ts        TIMESTAMPTZ NOT NULL,
  price     INTEGER NOT NULL,
  PRIMARY KEY (market_id, ts)
);

-- Ciclo de resolución inspirado en el oráculo optimista de UMA que usa Polymarket:
-- alguien propone el resultado con evidencia, corre una ventana de disputa y, si nadie disputa, se liquida.
CREATE TABLE resolutions (
  id                BIGSERIAL PRIMARY KEY,
  event_id          BIGINT NOT NULL REFERENCES events(id),
  winning_market_id BIGINT REFERENCES markets(id), -- en múltiples: el mercado ganador
  outcome           TEXT NOT NULL CHECK (outcome IN ('YES','NO','VOID')), -- en binarios
  proposer          TEXT NOT NULL,                  -- 'ai' o 'admin:<nombre>'
  evidence          JSONB NOT NULL DEFAULT '[]',
  explanation       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL CHECK (status IN ('proposed','disputed','finalized','rejected')),
  challenge_ends_at TIMESTAMPTZ NOT NULL,
  disputed_by       TEXT,
  dispute_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at      TIMESTAMPTZ
);

-- ---------- Información: fuentes, artículos, tendencias, borradores ----------
CREATE TABLE sources (
  id              BIGSERIAL PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('rss','gdelt','google_trends','newsapi','tiktok_cc','json_feed')),
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  category        TEXT REFERENCES categories(slug),
  country         TEXT,
  lang            TEXT NOT NULL DEFAULT 'es',
  weight          REAL NOT NULL DEFAULT 1,
  config          JSONB NOT NULL DEFAULT '{}',
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  last_fetched_at TIMESTAMPTZ,
  last_status     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, url)
);

CREATE TABLE articles (
  id           BIGSERIAL PRIMARY KEY,
  source_id    BIGINT NOT NULL REFERENCES sources(id),
  url          TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  category     TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  keywords     TEXT[] NOT NULL DEFAULT '{}',
  trend_id     BIGINT
);
CREATE INDEX articles_published_idx ON articles (published_at DESC);

-- Señales de redes sociales (Instagram, TikTok, X...). Las carga el agente de navegador o un moderador.
CREATE TABLE social_signals (
  id          BIGSERIAL PRIMARY KEY,
  platform    TEXT NOT NULL,
  url         TEXT,
  text        TEXT NOT NULL,
  metrics     JSONB NOT NULL DEFAULT '{}',
  category    TEXT,
  captured_by TEXT NOT NULL DEFAULT 'manual',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  keywords    TEXT[] NOT NULL DEFAULT '{}',
  trend_id    BIGINT
);

CREATE TABLE trends (
  id            BIGSERIAL PRIMARY KEY,
  label         TEXT NOT NULL,
  keywords      TEXT[] NOT NULL,
  category      TEXT,
  score         REAL NOT NULL,
  article_count INTEGER NOT NULL,
  source_count  INTEGER NOT NULL,
  social_count  INTEGER NOT NULL DEFAULT 0,
  first_seen    TIMESTAMPTZ NOT NULL,
  last_seen     TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','ignored','expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Preguntas propuestas (por la IA o por un moderador) que esperan aprobación.
CREATE TABLE drafts (
  id          BIGSERIAL PRIMARY KEY,
  trend_id    BIGINT REFERENCES trends(id),
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_by  TEXT NOT NULL,
  reviewed_by TEXT,
  review_note TEXT,
  event_id    BIGINT REFERENCES events(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

-- Notificaciones salientes hacia el casino (webhooks), con reintentos.
CREATE TABLE webhook_outbox (
  id           BIGSERIAL PRIMARY KEY,
  operator_id  TEXT NOT NULL REFERENCES operators(id),
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_try_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
