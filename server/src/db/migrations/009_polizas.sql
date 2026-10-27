-- Garantías que no son dinero depositado: pólizas de caución y cartas de crédito (stand-by).
-- El dinero no entra al fideicomiso; la aseguradora o el banco se comprometen a pagar si el casino no
-- paga. Cuentan como garantía mientras estén vigentes, y se registran en cuentas de orden del libro
-- (contingente:<casino>) para que su alta, vencimiento y ejecución también queden encadenados.
CREATE TABLE guarantee_instruments (
  id           BIGSERIAL PRIMARY KEY,
  operator_id  TEXT NOT NULL REFERENCES operators(id),
  kind         TEXT NOT NULL CHECK (kind IN ('poliza','carta_credito')),
  issuer       TEXT NOT NULL,                  -- aseguradora o banco emisor
  number       TEXT NOT NULL,                  -- número de póliza o de carta de crédito
  amount       BIGINT NOT NULL CHECK (amount > 0),   -- micro-dólares asegurados
  executed     BIGINT NOT NULL DEFAULT 0,      -- lo que ya se cobró ejecutándola
  issued_at    DATE,
  expires_at   TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','released','executed')),
  document_url TEXT,
  notes        TEXT,
  created_by   TEXT NOT NULL DEFAULT 'sistema',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ,
  closed_by    TEXT,
  UNIQUE (kind, issuer, number)
);
CREATE INDEX guarantee_instruments_op_idx ON guarantee_instruments (operator_id, status, expires_at);
