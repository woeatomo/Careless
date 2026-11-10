// Pure Careless exit rules. No I/O.
//
// Position fields come from tools/dlmm.js getMyPositions() (or the paper view):
//   pnl_pct, pnl_pct_suspicious, active_bin, lower_bin, upper_bin
// Single-side SOL ranges sit BELOW the entry price:
//   OOR above ("kanan") = active_bin > upper_bin → position is all SOL
//   OOR below ("kiri")  = active_bin < lower_bin → position is all token
//
// Fast rules (every PnL poll): stop loss, optional TP/trailing, OOR kanan/kiri
// (same timing logic as meridianEvPANDA). Slow rules (management cycle): rug
// guard on Jupiter token stats, and the 06:00 WIB morning review that closes a
// position whose potential faded and otherwise only claims fees.

const num = v => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function oorDirection(p) {
  if (p.active_bin == null || p.upper_bin == null || p.lower_bin == null) return null;
  if (p.active_bin > p.upper_bin) return "above";
  if (p.active_bin < p.lower_bin) return "below";
  return null;
}

/** Track when the current OOR side started; switching sides restarts the clock. */
export function updateOor(prev, p, now = Date.now()) {
  const dir = oorDirection(p);
  if (!dir) return { dir: null, since: null };
  if (prev?.dir === dir && prev.since) return prev;
  return { dir, since: now };
}

/**
 * Fast rules evaluated on every PnL poll.
 * @returns {{action:"CLOSE", rule:string, reason:string} | null}
 */
export function fastExitDecision(p, ctx, x, now = Date.now()) {
  const pnl = p.pnl_pct;
  const pnlOk = !p.pnl_pct_suspicious && pnl != null && Number.isFinite(pnl);

  if (pnlOk && x.stopLossPct != null && pnl <= x.stopLossPct) {
    return { action: "CLOSE", rule: "STOP_LOSS", reason: `stop loss: PnL ${pnl.toFixed(2)}% <= ${x.stopLossPct}%` };
  }
  if (pnlOk && x.takeProfitPct != null && pnl >= x.takeProfitPct) {
    return { action: "CLOSE", rule: "TAKE_PROFIT", reason: `take profit: PnL ${pnl.toFixed(2)}% >= ${x.takeProfitPct}%` };
  }
  const peak = ctx.peakPnlPct;
  if (pnlOk && x.trailingTakeProfit && peak != null && peak >= x.trailingTriggerPct && peak - pnl >= x.trailingDropPct) {
    return { action: "CLOSE", rule: "TRAILING_TP", reason: `trailing TP: peak ${peak.toFixed(2)}% → ${pnl.toFixed(2)}%` };
  }

  const oor = ctx.oor;
  if (oor?.dir && oor.since != null) {
    const minutes = (now - oor.since) / 60_000;
    if (oor.dir === "above") {
      // Positive PnL: exit once it stayed OOR-above for the wait period.
      // Negative PnL: hold and let price come back; the stop loss is the only exit.
      if (pnlOk && pnl > (x.oorAboveMinPnlPct ?? 0) && minutes >= x.oorAboveWaitMinutes) {
        return { action: "CLOSE", rule: "OOR_ABOVE", reason: `OOR above ${Math.floor(minutes)}m with PnL +${pnl.toFixed(2)}%` };
      }
    } else if (oor.dir === "below" && minutes >= x.oorBelowWaitMinutes) {
      return { action: "CLOSE", rule: "OOR_BELOW", reason: `OOR below for ${Math.floor(minutes)}m (limit ${x.oorBelowWaitMinutes}m)` };
    }
  }
  return null;
}

/**
 * Rug guard on a Jupiter token entry. Hard triggers close on their own; soft
 * signals need `softRequired` at once. Missing stats are not a trigger (the
 * stop loss still protects), but changed authorities always are.
 */
export function rugDecision(token, g) {
  if (!token) return null;
  const hard = [];
  const soft = [];
  const s5 = token.stats5m || {};
  const s1 = token.stats1h || {};
  const liq5 = num(s5.liquidityChange);
  if (liq5 != null && liq5 <= -g.liquidityDrop5mPct) hard.push(`liquidity ${liq5.toFixed(0)}% in 5m`);
  const liq1 = num(s1.liquidityChange);
  if (liq1 != null && liq1 <= -g.liquidityDrop1hPct) hard.push(`liquidity ${liq1.toFixed(0)}% in 1h`);
  if (g.exitOnAuthorityChange && token.audit && (token.audit.mintAuthorityDisabled === false || token.audit.freezeAuthorityDisabled === false)) {
    hard.push("mint/freeze authority re-enabled");
  }
  const buy = num(s1.buyVolume);
  const sell = num(s1.sellVolume);
  if (buy != null && sell != null && buy + sell > 0) {
    const share = (sell / (buy + sell)) * 100;
    if (share >= g.sellShare1hPct) soft.push(`sells ${share.toFixed(0)}% of 1h volume`);
  }
  const p5 = num(s5.priceChange);
  if (p5 != null && p5 <= -g.priceDrop5mPct) soft.push(`price ${p5.toFixed(0)}% in 5m`);
  const h1 = num(s1.holderChange);
  if (h1 != null && h1 <= -g.holderDrop1hPct) soft.push(`holders ${h1.toFixed(1)}% in 1h`);
  if (hard.length || soft.length >= g.softRequired) {
    return { action: "CLOSE", rule: "RUG_GUARD", reason: `rug guard: ${[...hard, ...soft].join(", ")}` };
  }
  return null;
}

/** Hour and date in the configured timezone (default Asia/Jakarta). */
export function localClock(now = Date.now(), timeZone = "Asia/Jakarta") {
  const d = new Date(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(d)) % 24;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone }).format(d);
  return { hour, date };
}

/** True when the morning review is due now and has not run today for this position. */
export function reviewDue(lastReviewDate, r, now = Date.now()) {
  if (!r.enabled) return false;
  const { hour, date } = localClock(now, r.timeZone);
  return hour === r.hourLocal && lastReviewDate !== date;
}

/**
 * Morning review ("ambil profit pagi"): close when the potential faded,
 * otherwise keep the position and only claim fees.
 * @param pool24h  Meteora discovery row, timeframe 24h
 * @param token    Jupiter token entry
 */
export function morningReviewDecision(pool24h, token, r) {
  const tvl = num(pool24h?.tvl);
  const fee = num(pool24h?.fee);
  const ft = tvl > 0 && fee != null ? (fee / tvl) * 100 : null;
  if (ft == null) return { action: "HOLD", reason: "morning review: fee data unavailable — kept" };
  if (ft < r.minFeeTvl24hPct) return { action: "CLOSE", rule: "MORNING_REVIEW", reason: `morning review: 24h fee/TVL ${ft.toFixed(1)}% < ${r.minFeeTvl24hPct}%` };
  const p24 = num(token?.stats24h?.priceChange);
  if (p24 != null && p24 < -r.maxDrop24hPct) return { action: "CLOSE", rule: "MORNING_REVIEW", reason: `morning review: price ${p24.toFixed(0)}% in 24h, no longer ranging` };
  return { action: "CLAIM", reason: `morning review: healthy (24h fee/TVL ${ft.toFixed(1)}%) — claim fees and keep` };
}
