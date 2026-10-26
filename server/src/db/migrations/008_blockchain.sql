-- Modelo mixto: anclaje del libro contable en Bitcoin (OpenTimestamps) y vía de liquidación en USDC.

-- Cómo liquida cada casino: por banco/fideicomiso o en USDC desde su dirección
ALTER TABLE operators ADD COLUMN settlement_rail TEXT NOT NULL DEFAULT 'bank' CHECK (settlement_rail IN ('bank','usdc'));
ALTER TABLE operators ADD COLUMN usdc_address TEXT;

-- Anclajes: la huella del último asiento del libro sellada en Bitcoin. proof es la respuesta del
-- calendario de OpenTimestamps; con ella se arma el archivo .ots que verifica cualquiera.
CREATE TABLE anchors (
  id         BIGSERIAL PRIMARY KEY,
  journal_id BIGINT NOT NULL,
  head_hash  TEXT NOT NULL,
  method     TEXT NOT NULL DEFAULT 'opentimestamps',
  calendar   TEXT NOT NULL,
  proof      BYTEA,
  status     TEXT NOT NULL CHECK (status IN ('submitted','error')),
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX anchors_journal_idx ON anchors (journal_id DESC);

-- Estado de tareas de tesorería (último bloque leído de la cadena, etc.)
CREATE TABLE treasury_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
