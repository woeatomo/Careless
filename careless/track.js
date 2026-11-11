// Pure track-record rules for Careless. No I/O.
//
// Based on the HALO study of 1.7M closed Meteora DLMM positions (Aug–Nov 2026):
// the profitable 10% of wallets kept re-farming pools that already paid them
// (87% re-entries), kept more of their fees after price moves/IL, and win rate
// barely separated them from the rest. So Careless:
//   - remembers net PnL per pool (paper and live closes),
//   - prefers pools with a positive record and skips pools on a losing streak,
//   - lets a token come back sooner after a profitable close than after a loss,
//   - reports fee kept % (net PnL ÷ fees) instead of leaning on win rate.

const num = v => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const HOUR = 3_600_000;

/** Closed trades for one pool inside the lookback window, oldest first. */
export function poolTrades(history, pool, lookbackDays = 14, now = Date.now()) {
  const since = now - lookbackDays * 24 * HOUR;
  return (history ?? [])
    .filter(h => h && h.pool === pool && (h.closedAt ?? 0) >= since && num(h.pnlPct) != null)
    .sort((a, b) => a.closedAt - b.closedAt);
}

/** Net record of one pool: trades, wins, average net PnL % and the current losing streak. */
export function poolRecord(history, pool, lookbackDays = 14, now = Date.now()) {
  const trades = poolTrades(history, pool, lookbackDays, now);
  let lossStreak = 0;
  for (let i = trades.length - 1; i >= 0 && Number(trades[i].pnlPct) <= 0; i--) lossStreak++;
  const sumPct = trades.reduce((a, t) => a + Number(t.pnlPct), 0);
  return {
    n: trades.length,
    wins: trades.filter(t => Number(t.pnlPct) > 0).length,
    avgPct: trades.length ? sumPct / trades.length : null,
    lossStreak,
    lastClosedAt: trades.at(-1)?.closedAt ?? null,
  };
}

/**
 * proven = enough closes with a positive average; bad = losing streak still fresh; else new.
 * @returns {{tier:"proven"|"new"|"bad", reason:string, record:object}}
 */
export function poolVerdict(record, t, now = Date.now()) {
  if (!t?.enabled || !record?.n) return { tier: "new", reason: "no track record", record };
  if (record.lossStreak >= t.blockLossStreak && now - record.lastClosedAt < t.blockHours * HOUR) {
    return { tier: "bad", reason: `pool lost ${record.lossStreak}× in a row (paused ${t.blockHours}h)`, record };
  }
  if (record.n >= t.minTrades && record.avgPct > 0) {
    return { tier: "proven", reason: `proven pool: ${record.wins}/${record.n} wins, avg ${record.avgPct.toFixed(2)}%`, record };
  }
  return { tier: "new", reason: `record ${record.wins}/${record.n}, avg ${record.avgPct.toFixed(2)}%`, record };
}

const TIER_ORDER = { proven: 0, new: 1, bad: 2 };

/**
 * Order eligible pools for one mint: proven pools first, bad pools dropped,
 * otherwise keep the incoming order (rankPools).
 */
export function orderPoolsByRecord(pools, verdictOf) {
  return pools
    .map((p, i) => ({ p, i, v: verdictOf(p.pool_address) }))
    .filter(x => x.v.tier !== "bad")
    .sort((a, b) => TIER_ORDER[a.v.tier] - TIER_ORDER[b.v.tier]
      || (a.v.tier === "proven" ? (b.v.record.avgPct - a.v.record.avgPct) : 0)
      || a.i - b.i)
    .map(x => x.p);
}

/**
 * Order passed candidates for entry: proven pools first (best average first),
 * then by 24h fee/TVL. Candidates whose pool is "bad" are removed.
 * @param candidates  engine candidate records ({poolAddress, feeTvl24hPct, …})
 */
export function rankCandidates(candidates, verdictOf) {
  return candidates
    .map(w => ({ w, v: verdictOf(w.poolAddress) }))
    .filter(x => x.v.tier !== "bad")
    .sort((a, b) => TIER_ORDER[a.v.tier] - TIER_ORDER[b.v.tier]
      || (a.v.tier === "proven" ? (b.v.record.avgPct - a.v.record.avgPct) : 0)
      || (b.w.feeTvl24hPct ?? 0) - (a.w.feeTvl24hPct ?? 0))
    .map(x => ({ ...x.w, track: x.v.tier }));
}

const HARD_LOSS_RULES = new Set(["STOP_LOSS", "RUG_GUARD"]);

/** Re-entry cooldown after a close: short after a profit, long after a stop loss / rug. */
export function cooldownHoursFor(rule, pnlPct, e) {
  if (HARD_LOSS_RULES.has(rule)) return e.reentryCooldownLossHours ?? e.reentryCooldownHours;
  const pnl = num(pnlPct);
  if (pnl != null && pnl > 0) return e.reentryCooldownWinHours ?? e.reentryCooldownHours;
  return e.reentryCooldownHours;
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function group(trades) {
  const pnlSol = trades.reduce((a, t) => a + (num(t.pnlSol) ?? 0), 0);
  const feesSol = trades.reduce((a, t) => a + (num(t.feesSol) ?? 0), 0);
  return {
    n: trades.length,
    winRatePct: trades.length ? Math.round(trades.filter(t => t.pnlSol > 0).length / trades.length * 100) : null,
    pnlSol: +pnlSol.toFixed(4),
    avgPnlPct: trades.length ? +(trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length).toFixed(2) : null,
    feesSol: +feesSol.toFixed(4),
    // Share of earned fees still in the pocket after price moves / IL / costs.
    // HALO: winners kept ~40%, the rest −1% (lost more than they earned).
    feeKeptPct: feesSol > 0 ? Math.round(pnlSol / feesSol * 100) : null,
    medianHeldMin: median(trades.map(t => t.heldMin).filter(Number.isFinite)),
  };
}

/** Closed paper trades → summary focused on net results, not win rate. */
export function summarizeTrades(trades) {
  const all = group(trades);
  const byRule = {};
  for (const t of trades) (byRule[t.rule] ??= []).push(t);
  return {
    ...all,
    byRule: Object.fromEntries(Object.entries(byRule).map(([r, ts]) => [r, { n: ts.length, pnlSol: group(ts).pnlSol }])),
    reentry: group(trades.filter(t => t.reentry === true)),
    firstEntry: group(trades.filter(t => t.reentry !== true)),
  };
}
