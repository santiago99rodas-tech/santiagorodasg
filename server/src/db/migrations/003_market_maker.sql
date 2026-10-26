-- Market maker v2: precio justo con decimales (el entero fair_price queda para mostrar) y el último
-- cruce y la última referencia externa ya contados (cada uno se aplica una sola vez).
ALTER TABLE markets ADD COLUMN fair_exact DOUBLE PRECISION;
ALTER TABLE markets ADD COLUMN flow_cursor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN ref_cursor BIGINT NOT NULL DEFAULT 0;
UPDATE markets SET flow_cursor = COALESCE((SELECT max(id) FROM trades), 0);
CREATE INDEX trades_market_id_idx ON trades (market_id, id);
