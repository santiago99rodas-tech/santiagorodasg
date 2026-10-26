-- Oráculo: resolución con fianzas (al estilo del oráculo optimista de UMA) y claves para firmar
-- lo que publica /v1/oracle.

-- Quién propuso o disputó (jugador, si lo hizo un jugador) y con qué evidencia se disputó
ALTER TABLE resolutions ADD COLUMN proposer_player_id BIGINT REFERENCES players(id);
ALTER TABLE resolutions ADD COLUMN disputer_player_id BIGINT REFERENCES players(id);
ALTER TABLE resolutions ADD COLUMN dispute_evidence JSONB NOT NULL DEFAULT '[]';
ALTER TABLE resolutions ADD COLUMN disputed_at TIMESTAMPTZ;
-- Cómo terminó la disputa: 'proposal_upheld' (tenía razón quien propuso) o 'dispute_upheld' (tenía razón quien disputó)
ALTER TABLE resolutions ADD COLUMN dispute_result TEXT CHECK (dispute_result IN ('proposal_upheld','dispute_upheld'));
ALTER TABLE resolutions ADD COLUMN decided_by TEXT;

-- Fianzas: la de quien propone y la de quien disputa. La casa también pone la suya cuando propone
-- (con la IA o un moderador): si se equivoca, la pierde a favor de quien la corrigió.
CREATE TABLE resolution_bonds (
  id            BIGSERIAL PRIMARY KEY,
  resolution_id BIGINT NOT NULL REFERENCES resolutions(id),
  role          TEXT NOT NULL CHECK (role IN ('proposer','disputer')),
  player_id     BIGINT REFERENCES players(id),         -- NULL = la casa
  amount        BIGINT NOT NULL,                       -- micro-dólares
  status        TEXT NOT NULL CHECK (status IN ('held','returned','rewarded','forfeited')),
  payout        BIGINT NOT NULL DEFAULT 0,             -- lo que se le devolvió (fianza + premio)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ,
  UNIQUE (resolution_id, role)
);

-- Clave Ed25519 del oráculo (si no se configura ORACLE_PRIVATE_KEY se genera una y se guarda aquí)
CREATE TABLE oracle_keys (
  id          TEXT PRIMARY KEY,
  public_pem  TEXT NOT NULL,
  private_pem TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
