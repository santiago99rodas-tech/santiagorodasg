// Liquidación entre casinos. El libro es uno solo para todos: el jugador de un casino le puede ganar
// al de otro, a un market maker externo o a la casa. Cada casino cobra y paga a SUS jugadores con su
// billetera, así que al resolverse los mercados uno queda con plata que le corresponde a otro.
// La plataforma hace de cámara de compensación (contraparte central): cada casino le liquida a ella
// el neto de sus jugadores, y ella le paga a quien corresponda.
//
// Por casino, en los mercados resueltos en el período (más las fianzas del período):
//   recaudado  = lo que debitó a sus jugadores − lo que les acreditó (premios, ventas, devoluciones)
//   comisiones = las que pagaron sus jugadores; le vuelve revenue_share_bps de ellas
//   a liquidar = recaudado − su parte de las comisiones  (> 0: el casino paga; < 0: la plataforma le paga)
// Las órdenes de mercados todavía abiertos no se liquidan: esa plata sigue en garantía en cada casino.

import { pool, many, one } from "../db/pool.js";
import { houseAccount } from "./house.js";

export async function clearingReport(q: { from?: string; to?: string; operatorId?: string } = {}) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * 864e5);
  const house = await houseAccount();
  const range = [from.toISOString(), to.toISOString()];

  const ops = await many(pool, "SELECT id, name, revenue_share_bps FROM operators WHERE kind='casino' AND ($1::text IS NULL OR id=$1) ORDER BY name", [q.operatorId ?? null]);
  const flows = new Map((await many(pool, `
    SELECT l.operator_id,
      COALESCE(SUM(l.amount) FILTER (WHERE l.direction='debit' AND l.status='ok'),0)::bigint AS debits,
      COALESCE(SUM(l.amount) FILTER (WHERE l.direction='credit' AND l.status IN ('ok','pending','failed')),0)::bigint AS credits,
      COUNT(DISTINCT l.market_id)::int AS markets, COUNT(DISTINCT l.player_id)::int AS players
    FROM ledger l JOIN markets m ON m.id = l.market_id
    WHERE m.status IN ('resolved','void') AND m.resolved_at >= $1 AND m.resolved_at < $2
    GROUP BY l.operator_id`, range)).map((r) => [r.operator_id, r]));
  const bonds = new Map((await many(pool, `
    SELECT operator_id,
      COALESCE(SUM(amount) FILTER (WHERE direction='debit' AND status='ok'),0)::bigint AS debits,
      COALESCE(SUM(amount) FILTER (WHERE direction='credit' AND status IN ('ok','pending','failed')),0)::bigint AS credits
    FROM ledger WHERE reason LIKE 'resolution_bond%' AND created_at >= $1 AND created_at < $2 GROUP BY operator_id`, range)).map((r) => [r.operator_id, r]));
  const fees = new Map((await many(pool, `
    SELECT f.operator_id, COALESCE(SUM(f.amount),0)::bigint AS fees
    FROM fees f JOIN trades t ON t.id = f.trade_id JOIN markets m ON m.id = t.market_id
    WHERE m.status IN ('resolved','void') AND m.resolved_at >= $1 AND m.resolved_at < $2 GROUP BY f.operator_id`, range)).map((r) => [r.operator_id, Number(r.fees)]));

  const casinos = ops.map((o) => {
    const f = flows.get(o.id), b = bonds.get(o.id);
    const marketNet = Number(f?.debits ?? 0) - Number(f?.credits ?? 0);
    const bondNet = Number(b?.debits ?? 0) - Number(b?.credits ?? 0);
    const collected = marketNet + bondNet;
    const feeTotal = fees.get(o.id) ?? 0;
    const revenueShare = Math.floor((feeTotal * o.revenue_share_bps) / 10_000);
    return {
      operatorId: o.id, name: o.name, markets: f?.markets ?? 0, players: f?.players ?? 0,
      debited: Number(f?.debits ?? 0), credited: Number(f?.credits ?? 0), bondsNet: bondNet, collected,
      fees: feeTotal, revenueShareBps: o.revenue_share_bps, revenueShare,
      playersResult: -(collected - feeTotal), // lo que ganaron (+) o perdieron (−) sus jugadores sin contar comisiones
      due: collected - revenueShare, // > 0: el casino le transfiere a la plataforma; < 0: la plataforma al casino
    };
  });

  // Del lado de la plataforma: resultado de la casa y de los market makers externos en esos mercados
  const platform = await one(pool, `
    SELECT
      COALESCE(SUM(ps.realized) FILTER (WHERE ps.player_id = $3),0)::bigint AS house,
      COALESCE(SUM(ps.realized) FILTER (WHERE p.operator_id = 'mm'),0)::bigint AS mms
    FROM positions ps JOIN players p ON p.id = ps.player_id JOIN markets m ON m.id = ps.market_id
    WHERE m.status IN ('resolved','void') AND m.resolved_at >= $1 AND m.resolved_at < $2`, [...range, house]);
  const rebates = await one(pool, `
    SELECT COALESCE(SUM(r.amount),0)::bigint AS total FROM rebates r JOIN markets m ON m.id = r.market_id
    WHERE m.status IN ('resolved','void') AND m.resolved_at >= $1 AND m.resolved_at < $2`, range);

  // Quién le compró a quién (volumen por par de grupos): cuánto del juego fue entre casinos distintos
  const matrix = await many(pool, `
    WITH g AS (
      SELECT p.id, CASE WHEN p.is_house THEN 'casa' WHEN p.operator_id = 'mm' THEN 'market makers' ELSE COALESCE(o.name, p.operator_id) END AS grp
      FROM players p LEFT JOIN operators o ON o.id = p.operator_id)
    SELECT gt.grp AS taker, gm.grp AS maker,
      SUM(t.qty * (CASE WHEN ot.outcome='YES' THEN t.yes_price ELSE 100 - t.yes_price END) * 100)::bigint AS volume, COUNT(*)::int AS trades
    FROM trades t JOIN orders ot ON ot.id = t.taker_order_id JOIN orders om ON om.id = t.maker_order_id
    JOIN g gt ON gt.id = ot.player_id JOIN g gm ON gm.id = om.player_id
    WHERE t.created_at >= $1 AND t.created_at < $2 GROUP BY gt.grp, gm.grp ORDER BY volume DESC`, range);
  const total = matrix.reduce((a, r) => a + Number(r.volume), 0);
  const crossCasino = matrix.filter((r) => r.taker !== r.maker && !["casa", "market makers"].includes(r.taker) && !["casa", "market makers"].includes(r.maker))
    .reduce((a, r) => a + Number(r.volume), 0);
  const external = matrix.filter((r) => r.maker === "market makers").reduce((a, r) => a + Number(r.volume), 0);
  const houseMaker = matrix.filter((r) => r.maker === "casa").reduce((a, r) => a + Number(r.volume), 0);

  return {
    from: from.toISOString(), to: to.toISOString(), casinos,
    totals: { due: casinos.reduce((a, c) => a + c.due, 0), fees: casinos.reduce((a, c) => a + c.fees, 0), revenueShare: casinos.reduce((a, c) => a + c.revenueShare, 0) },
    platform: { houseResult: Number(platform?.house ?? 0), marketMakersResult: Number(platform?.mms ?? 0), rebatesPaid: Number(rebates?.total ?? 0) },
    liquidity: {
      volume: total, betweenCasinos: crossCasino, fromMarketMakers: external, fromHouse: houseMaker,
      matrix: matrix.map((r) => ({ taker: r.taker, maker: r.maker, volume: Number(r.volume), trades: r.trades })),
    },
  };
}
