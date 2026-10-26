-- Datos para medir sesgo e integridad

-- País del jugador (ISO 3166-1 alfa-2), lo envía el casino al abrir la sesión. Permite medir el sesgo de "hinchada".
ALTER TABLE players ADD COLUMN country TEXT;

-- Referencia externa del mercado, por ejemplo "polymarket:<slug-del-mercado>", para comparar precios.
ALTER TABLE markets ADD COLUMN external_ref TEXT;

-- Precios de referencia (Polymarket, casas de apuestas, encuestas…), en centavos del SÍ.
CREATE TABLE reference_prices (
  id          BIGSERIAL PRIMARY KEY,
  market_id   BIGINT NOT NULL REFERENCES markets(id),
  source      TEXT NOT NULL,
  price       INTEGER NOT NULL CHECK (price BETWEEN 0 AND 100),
  note        TEXT,
  captured_by TEXT NOT NULL DEFAULT 'sistema',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reference_prices_market_idx ON reference_prices (market_id, captured_at DESC);
