-- Tesorería: garantías de los casinos, liquidaciones con estado, libro contable encadenado con hash,
-- extractos bancarios para conciliar y pausa de la operación de un casino por deuda.

ALTER TABLE operators ADD COLUMN guarantee_required BIGINT NOT NULL DEFAULT 0;   -- micro-dólares que debe tener en garantía
ALTER TABLE operators ADD COLUMN debt_limit BIGINT;                              -- deuda máxima sin pagar (NULL = su garantía)
ALTER TABLE operators ADD COLUMN trading_paused BOOLEAN NOT NULL DEFAULT FALSE;  -- sus jugadores no pueden abrir apuestas
ALTER TABLE operators ADD COLUMN paused_reason TEXT;
ALTER TABLE operators ADD COLUMN paused_manual BOOLEAN NOT NULL DEFAULT FALSE;   -- pausa puesta a mano (no se levanta sola)

-- Libro contable de doble partida. Nunca se edita ni se borra: los errores se corrigen con otro asiento.
-- Cada asiento guarda el hash del anterior; alterar uno rompe la cadena desde ahí.
CREATE TABLE journal (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind       TEXT NOT NULL,          -- liquidacion, pago_liquidacion, garantia_deposito, garantia_retiro, garantia_cobro, reserva, custodia_mm, ajuste
  ref        TEXT,                   -- liquidación, transferencia, etc.
  entries    JSONB NOT NULL,         -- [{ account, amount }] en micro-dólares; suman 0
  memo       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'sistema',
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE
);
CREATE INDEX journal_kind_idx ON journal (kind, ts);

CREATE TABLE settlements (
  id           BIGSERIAL PRIMARY KEY,
  operator_id  TEXT NOT NULL REFERENCES operators(id),
  period_from  TIMESTAMPTZ NOT NULL,
  period_to    TIMESTAMPTZ NOT NULL,
  amount       BIGINT NOT NULL,       -- > 0: el casino le paga a la plataforma; < 0: la plataforma al casino
  details      JSONB NOT NULL,        -- fila del informe de liquidación
  status       TEXT NOT NULL CHECK (status IN ('pending','paid','overdue','covered','cancelled')),
  due_at       TIMESTAMPTZ NOT NULL,
  paid_at      TIMESTAMPTZ,
  bank_ref     TEXT,
  covered_from_guarantee BIGINT NOT NULL DEFAULT 0,
  statement    TEXT NOT NULL,         -- estado de cuenta (JSON exacto que se firmó)
  signature    TEXT NOT NULL,         -- Ed25519 en base64 sobre statement
  key_id       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operator_id, period_from)
);
CREATE INDEX settlements_status_idx ON settlements (status, due_at);

-- Movimientos del extracto bancario cargados para conciliar
CREATE TABLE bank_lines (
  id            BIGSERIAL PRIMARY KEY,
  account       TEXT NOT NULL DEFAULT 'fideicomiso',
  date          DATE NOT NULL,
  reference     TEXT NOT NULL,
  amount        BIGINT NOT NULL,      -- micro-dólares; > 0 entra, < 0 sale
  description   TEXT NOT NULL DEFAULT '',
  settlement_id BIGINT REFERENCES settlements(id),
  status        TEXT NOT NULL CHECK (status IN ('matched','unmatched','ignored')),
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account, date, reference, amount)
);
