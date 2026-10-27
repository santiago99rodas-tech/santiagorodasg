-- Incentivos de liquidez: los market makers externos que cotizan ajustado y grande cerca del precio
-- medio se reparten un pozo diario por mercado (ver src/engine/rewards.ts).
ALTER TABLE markets ADD COLUMN reward_daily BIGINT CHECK (reward_daily IS NULL OR reward_daily >= 0); -- micro-dólares por día; NULL = LIQ_REWARD_DAILY_USD

-- Un registro por mercado y día (en hora de Ecuador): cuántas muestras se tomaron y con qué pozo
CREATE TABLE liquidity_days (
  day        DATE NOT NULL,
  market_id  BIGINT NOT NULL REFERENCES markets(id),
  samples    INTEGER NOT NULL DEFAULT 0,
  pool       BIGINT NOT NULL DEFAULT 0,
  paid_at    TIMESTAMPTZ,
  PRIMARY KEY (day, market_id)
);

-- Suma de las partes de cada participante en las muestras del día (la casa también aparece: compite
-- por la parte, pero no cobra; lo suyo no se paga)
CREATE TABLE liquidity_scores (
  day        DATE NOT NULL,
  market_id  BIGINT NOT NULL REFERENCES markets(id),
  player_id  BIGINT NOT NULL REFERENCES players(id),
  share_sum  DOUBLE PRECISION NOT NULL DEFAULT 0,
  score_sum  DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (day, market_id, player_id)
);

CREATE TABLE liquidity_rewards (
  id         BIGSERIAL PRIMARY KEY,
  day        DATE NOT NULL,
  market_id  BIGINT NOT NULL REFERENCES markets(id),
  player_id  BIGINT NOT NULL REFERENCES players(id),
  share      DOUBLE PRECISION NOT NULL,   -- parte promedio del día (0 a 1)
  amount     BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (day, market_id, player_id)
);
CREATE INDEX liquidity_rewards_player_idx ON liquidity_rewards (player_id, day DESC);
