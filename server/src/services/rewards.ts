// Incentivos de liquidez para market makers externos: cada LIQ_REWARD_SAMPLE_SEC se puntúan sus órdenes
// abiertas en los mercados con pozo (engine/rewards.ts) y, al terminar el día (hora de Ecuador), el pozo
// de cada mercado se reparte según la parte promedio de cada uno. La casa compite por la parte pero no
// cobra: lo que gana ella no se paga. El pago entra a la cuenta interna del market maker y queda en el
// libro de tesorería como gasto, con el traspaso del fideicomiso a la custodia de market makers.

import { pool, many, one, tx } from "../db/pool.js";
import { config } from "../config.js";
import { notFound, bad } from "../lib/errors.js";
import { bookMid, sampleScores, sampleShares, type RewardOrder, type RewardParams } from "../engine/rewards.js";
import * as wallet from "./wallet.js";
import { post } from "./treasury.js";

const TODAY = "(now() AT TIME ZONE 'America/Guayaquil')::date";
const params = (): RewardParams => ({ maxSpreadCents: config.rewards.maxSpreadCents, minShares: config.rewards.minShares, singleSidedFactor: config.rewards.singleSidedFactor });
const defaultPool = () => Math.round(config.rewards.defaultDailyUsd * 1e6);
const floorCent = (micro: number) => Math.floor(micro / 1e4) * 1e4;

/** Mercados abiertos con pozo, con su precio medio actual y las órdenes que compiten. */
async function rewardBooks() {
  const markets = await many(pool, `SELECT m.id, COALESCE(m.fair_exact * 100, m.fair_price)::float AS fair, COALESCE(m.reward_daily, $1)::bigint AS pool
                                    FROM markets m WHERE m.status='open' AND COALESCE(m.reward_daily, $1) > 0`, [defaultPool()]);
  if (!markets.length) return [];
  const orders = await many(pool, `
    SELECT o.market_id, o.player_id, o.side, o.outcome, o.price, (o.qty - o.filled_qty) / 100.0 AS shares, p.is_house, COALESCE(a.active, false) AS mm
    FROM orders o JOIN players p ON p.id = o.player_id LEFT JOIN mm_accounts a ON a.player_id = o.player_id
    WHERE o.status='open' AND o.market_id = ANY($1)`, [markets.map((m) => m.id)]);
  return markets.map((m) => {
    const all = orders.filter((o) => o.market_id === m.id);
    const toOrder = (o: any): RewardOrder => ({ owner: Number(o.player_id), side: o.side, outcome: o.outcome, price: o.price, shares: Number(o.shares) });
    const mid = bookMid(all.map(toOrder), Number(m.fair));
    return { marketId: Number(m.id), pool: Number(m.pool), mid, competing: all.filter((o) => o.mm || o.is_house).map(toOrder), houseIds: new Set(all.filter((o) => o.is_house).map((o) => Number(o.player_id))) };
  });
}

/** Toma una muestra de todos los mercados con pozo. */
export async function sampleLiquidity() {
  if (!config.rewards.enabled) return { markets: 0 };
  const books = await rewardBooks();
  for (const b of books) {
    const scores = sampleScores(b.competing, b.mid, params()), shares = sampleShares(scores);
    await tx(async (c) => {
      await c.query(`INSERT INTO liquidity_days (day, market_id, samples, pool) VALUES (${TODAY}, $1, 1, $2)
                     ON CONFLICT (day, market_id) DO UPDATE SET samples = liquidity_days.samples + 1, pool = EXCLUDED.pool`, [b.marketId, b.pool]);
      for (const [owner, share] of shares) {
        await c.query(`INSERT INTO liquidity_scores (day, market_id, player_id, share_sum, score_sum) VALUES (${TODAY}, $1, $2, $3, $4)
                       ON CONFLICT (day, market_id, player_id) DO UPDATE SET share_sum = liquidity_scores.share_sum + $3, score_sum = liquidity_scores.score_sum + $4`,
          [b.marketId, owner, share, scores.get(owner)]);
      }
    });
  }
  return { markets: books.length };
}

/**
 * Paga los días ya terminados: a cada market maker, pozo × parte promedio, con el tope diario total
 * (si se pasa, se reduce a todos en la misma proporción). Idempotente.
 */
export async function payLiquidityRewards() {
  const days = await many(pool, `SELECT DISTINCT day FROM liquidity_days WHERE paid_at IS NULL AND day < ${TODAY} ORDER BY day`);
  const out: { day: string; paid: number; rewards: number }[] = [];
  for (const { day } of days) {
    const rows = await many(pool, `
      SELECT d.market_id, d.samples, d.pool, s.player_id, s.share_sum
      FROM liquidity_days d JOIN liquidity_scores s ON s.day = d.day AND s.market_id = d.market_id JOIN mm_accounts a ON a.player_id = s.player_id
      WHERE d.day = $1 AND d.paid_at IS NULL AND d.samples > 0`, [day]);
    const raw = rows.map((r) => ({ marketId: Number(r.market_id), playerId: Number(r.player_id), share: Number(r.share_sum) / r.samples, amount: (Number(r.pool) * Number(r.share_sum)) / r.samples }));
    const total = raw.reduce((a, r) => a + r.amount, 0), cap = config.rewards.maxDailyUsd * 1e6;
    const k = total > cap ? cap / total : 1;
    const pays = raw.map((r) => ({ ...r, amount: floorCent(r.amount * k) })).filter((r) => r.amount > 0);
    const dayStr = new Date(day).toISOString().slice(0, 10);
    const sum = pays.reduce((a, r) => a + r.amount, 0);
    await tx(async (c) => {
      for (const p of pays) await c.query("INSERT INTO liquidity_rewards (day, market_id, player_id, share, amount) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [day, p.marketId, p.playerId, p.share, p.amount]);
      await c.query("UPDATE liquidity_days SET paid_at = now() WHERE day = $1 AND paid_at IS NULL", [day]);
      if (sum > 0) {
        const byMm = new Map<number, number>();
        for (const p of pays) byMm.set(p.playerId, (byMm.get(p.playerId) ?? 0) + p.amount);
        await post({ kind: "incentivo_liquidez", ref: `LIQRW-${dayStr}`, memo: `Incentivos de liquidez del ${dayStr} (${byMm.size} market maker(s))`,
          entries: [{ account: "fideicomiso", amount: -sum }, { account: "custodia_mm", amount: sum }, { account: "gasto:incentivos_liquidez", amount: sum },
                    ...[...byMm].map(([id, a]) => ({ account: `mm:${id}`, amount: -a }))] }, c);
      }
    });
    // La acreditación es idempotente por txId: si algo falla, el reintento de créditos la completa
    for (const p of pays) await wallet.credit(p.playerId, p.amount, { reason: "liquidity_reward", txId: `liqrw_${dayStr}_${p.marketId}_${p.playerId}`, marketId: p.marketId });
    if (sum > 0) console.log(`[incentivos] ${dayStr}: ${pays.length} pagos por ${(sum / 1e6).toFixed(2)} USD${k < 1 ? ` (reducidos al ${Math.round(k * 100)}% por el tope diario)` : ""}`);
    out.push({ day: dayStr, paid: sum, rewards: pays.length });
  }
  return out;
}

export async function setMarketReward(marketId: number, dailyUsd: number | null) {
  if (dailyUsd !== null && !(dailyUsd >= 0)) throw bad("invalid_amount", "Indica un monto de 0 o más");
  const r = await one(pool, "UPDATE markets SET reward_daily=$2 WHERE id=$1 RETURNING id, reward_daily", [marketId, dailyUsd === null ? null : Math.round(dailyUsd * 1e6)]);
  if (!r) throw notFound("Mercado no encontrado");
  return { marketId: Number(r.id), rewardDaily: r.reward_daily === null ? null : Number(r.reward_daily), effectiveDaily: r.reward_daily === null ? defaultPool() : Number(r.reward_daily) };
}

/** Lo que ve un market maker: reglas, mercados con pozo y su parte estimada de hoy, y lo cobrado. */
export async function mmRewards(playerId: number) {
  const books = await rewardBooks();
  const today = await many(pool, `SELECT d.market_id, d.samples, d.pool, COALESCE(s.share_sum, 0) AS share_sum, m.outcome_label AS label, e.title
                                  FROM liquidity_days d JOIN markets m ON m.id = d.market_id JOIN events e ON e.id = m.event_id
                                  LEFT JOIN liquidity_scores s ON s.day = d.day AND s.market_id = d.market_id AND s.player_id = $1
                                  WHERE d.day = ${TODAY}`, [playerId]);
  const paid = await many(pool, `SELECT day, SUM(amount)::bigint AS amount, COUNT(*)::int AS markets FROM liquidity_rewards WHERE player_id=$1 GROUP BY day ORDER BY day DESC LIMIT 30`, [playerId]);
  const live = new Map(books.map((b) => [b.marketId, b]));
  return {
    rules: { ...params(), sampleSec: config.rewards.sampleSec, formula: "((v − s) / v)² × tamaño; Qmin = max(min(Q1,Q2), max(Q1,Q2)/c) entre 10¢ y 90¢, si no min(Q1,Q2)", maxDailyUsd: config.rewards.maxDailyUsd, enabled: config.rewards.enabled },
    markets: books.map((b) => {
      const t = today.find((x) => Number(x.market_id) === b.marketId);
      const share = t && t.samples ? Number(t.share_sum) / t.samples : 0;
      return { marketId: b.marketId, title: t?.title ?? null, label: t?.label ?? null, dailyPoolUsd: b.pool / 1e6, midCents: Math.round(b.mid * 10) / 10,
        myShareToday: share, myEstimatedUsd: Math.floor((share * b.pool) / 1e4) / 100, samplesToday: t?.samples ?? 0 };
    }).sort((a, b) => b.dailyPoolUsd - a.dailyPoolUsd),
    paid: paid.map((p) => ({ day: new Date(p.day).toISOString().slice(0, 10), amountUsd: Number(p.amount) / 1e6, markets: p.markets })),
    live: live.size,
  };
}

/** Resumen para el back-office: pozos, parte de cada uno hoy (incluida la casa) y lo pagado. */
export async function rewardsOverview() {
  const books = await rewardBooks();
  const today = await many(pool, `
    SELECT d.market_id, d.samples, d.pool, e.title, m.outcome_label AS label, s.player_id, s.share_sum, p.display_name, p.is_house
    FROM liquidity_days d JOIN markets m ON m.id=d.market_id JOIN events e ON e.id=m.event_id
    LEFT JOIN liquidity_scores s ON s.day=d.day AND s.market_id=d.market_id LEFT JOIN players p ON p.id=s.player_id
    WHERE d.day = ${TODAY} ORDER BY d.pool DESC`);
  const markets = new Map<number, any>();
  for (const r of today) {
    const m = markets.get(Number(r.market_id)) ?? { marketId: Number(r.market_id), title: r.title, label: r.label, poolUsd: Number(r.pool) / 1e6, samples: r.samples, participants: [] as any[] };
    if (r.player_id) m.participants.push({ playerId: Number(r.player_id), name: r.is_house ? "Casa" : r.display_name, house: r.is_house, share: r.samples ? Number(r.share_sum) / r.samples : 0 });
    markets.set(m.marketId, m);
  }
  for (const m of markets.values()) {
    m.participants.sort((a: any, b: any) => b.share - a.share);
    m.paidShareEstimate = m.participants.filter((p: any) => !p.house).reduce((a: number, p: any) => a + p.share, 0);
  }
  const byDay = await many(pool, `SELECT day, SUM(amount)::bigint AS amount, COUNT(DISTINCT player_id)::int AS makers FROM liquidity_rewards GROUP BY day ORDER BY day DESC LIMIT 30`);
  const byMm = await many(pool, `SELECT r.player_id, a.name, SUM(r.amount)::bigint AS amount_30d, SUM(r.amount) FILTER (WHERE r.day > ${TODAY} - 7)::bigint AS amount_7d
                                 FROM liquidity_rewards r JOIN mm_accounts a ON a.player_id = r.player_id WHERE r.day > ${TODAY} - 30 GROUP BY 1,2 ORDER BY 3 DESC`);
  const titles = new Map((await many(pool, `SELECT m.id, e.title, m.outcome_label, m.reward_daily FROM markets m JOIN events e ON e.id=m.event_id WHERE m.id = ANY($1)`,
    [books.map((b) => b.marketId)])).map((r) => [Number(r.id), r]));
  return {
    config: { ...config.rewards, ...params() },
    rewardedMarkets: books.length,
    current: books.map((b) => ({ marketId: b.marketId, title: titles.get(b.marketId)?.title, label: titles.get(b.marketId)?.outcome_label, poolUsd: b.pool / 1e6, own: titles.get(b.marketId)?.reward_daily != null, midCents: Math.round(b.mid * 10) / 10 })).sort((a, b) => b.poolUsd - a.poolUsd),
    dailyBudgetUsd: books.reduce((a, b) => a + b.pool, 0) / 1e6,
    today: [...markets.values()],
    paidByDay: byDay.map((d) => ({ day: new Date(d.day).toISOString().slice(0, 10), amountUsd: Number(d.amount) / 1e6, makers: d.makers })),
    byMarketMaker: byMm.map((r) => ({ playerId: Number(r.player_id), name: r.name, last7dUsd: Number(r.amount_7d ?? 0) / 1e6, last30dUsd: Number(r.amount_30d) / 1e6 })),
  };
}
