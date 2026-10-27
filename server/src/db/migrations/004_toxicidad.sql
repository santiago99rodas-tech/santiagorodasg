-- Protección contra apostadores informados (services/toxicity.ts)

-- Markouts de cada cruce, medidos después: con el precio justo un rato más tarde y con el resultado.
-- Solo se miden los cruces nuevos (markout_pending); los anteriores a esta migración quedan fuera.
ALTER TABLE trades ADD COLUMN markout_short REAL;
ALTER TABLE trades ADD COLUMN markout_final REAL;
ALTER TABLE trades ADD COLUMN markout_pending BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trades ALTER COLUMN markout_pending SET DEFAULT TRUE;
CREATE INDEX trades_markout_pending_idx ON trades (market_id) WHERE markout_pending;

-- Foto del precio justo junto al último precio
ALTER TABLE price_history ADD COLUMN fair REAL;

-- Historial de markout por jugador (sumas ponderadas por dinero) y recargo resultante
CREATE TABLE player_flow (
  player_id          BIGINT PRIMARY KEY REFERENCES players(id),
  trades             INTEGER NOT NULL DEFAULT 0,
  w                  DOUBLE PRECISION NOT NULL DEFAULT 0,
  w2                 DOUBLE PRECISION NOT NULL DEFAULT 0,
  wm                 DOUBLE PRECISION NOT NULL DEFAULT 0,
  wm2                DOUBLE PRECISION NOT NULL DEFAULT 0,
  score              DOUBLE PRECISION NOT NULL DEFAULT 0,
  surcharge_bps      INTEGER NOT NULL DEFAULT 0,
  surcharge_override INTEGER,                -- fijado a mano desde el back-office (NULL = automático)
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Freno de emergencia y noticias: la casa no cotiza hasta paused_until y cotiza con más spread hasta shock_until
ALTER TABLE markets ADD COLUMN paused_until TIMESTAMPTZ;
ALTER TABLE markets ADD COLUMN shock_until TIMESTAMPTZ;
ALTER TABLE markets ADD COLUMN shock_reason TEXT;
