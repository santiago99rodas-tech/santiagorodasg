-- P2P: liquidez de market makers externos y liquidación entre casinos.

-- Tipo de operador: 'casino' (billetera del casino) o 'internal' (saldo que custodia la plataforma)
ALTER TABLE operators ADD COLUMN kind TEXT NOT NULL DEFAULT 'casino' CHECK (kind IN ('casino','internal'));
-- Parte de las comisiones que generan sus jugadores y que se le devuelve al casino en la liquidación
ALTER TABLE operators ADD COLUMN revenue_share_bps INTEGER NOT NULL DEFAULT 0 CHECK (revenue_share_bps BETWEEN 0 AND 10000);

-- Operador interno de los market makers externos: su dinero lo custodia la plataforma (internal_balances)
INSERT INTO operators (id, name, api_key, api_secret, wallet_url, wallet_secret, kind)
VALUES ('mm', 'Market makers externos', 'internal-' || md5(random()::text), md5(random()::text), 'internal:', md5(random()::text), 'internal')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE mm_accounts (
  player_id   BIGINT PRIMARY KEY REFERENCES players(id),
  name        TEXT NOT NULL,
  api_key     TEXT NOT NULL UNIQUE,
  api_secret  TEXT NOT NULL,
  rebate_bps  INTEGER,                      -- NULL = MAKER_REBATE_BPS global
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE internal_balances (
  player_id BIGINT PRIMARY KEY REFERENCES players(id),
  balance   BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0)   -- micro-dólares
);

-- Idempotencia de la billetera interna (como la de un casino: el mismo txId no se aplica dos veces)
CREATE TABLE internal_txs (
  tx_id      TEXT PRIMARY KEY,
  player_id  BIGINT NOT NULL REFERENCES players(id),
  action     TEXT NOT NULL,
  amount     BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reembolso al market maker externo por la liquidez que tomó un jugador (sale de la comisión del taker)
CREATE TABLE rebates (
  id             BIGSERIAL PRIMARY KEY,
  market_id      BIGINT NOT NULL REFERENCES markets(id),
  maker_order_id BIGINT NOT NULL REFERENCES orders(id),
  taker_order_id BIGINT NOT NULL REFERENCES orders(id),
  player_id      BIGINT NOT NULL REFERENCES players(id),
  amount         BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (maker_order_id, taker_order_id)
);

CREATE INDEX ledger_operator_market_idx ON ledger (operator_id, market_id);
