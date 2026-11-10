// Pure Careless screening rules. Each reject* returns a reason string or null.
// Unknown data is a rejection unless the caller explicitly allows it: missing
// numbers must never read as "safe". Rugcheck/GMGN gates are the same as in
// meridianEvPANDA.
//
// Careless picks established, ranging tokens (default: pump.fun, age >= 3 days,
// mcap >= $1M, |24h price change| <= 20%) in pools with steady fees
// (24h fee/TVL >= 5%) and sits in a wide single-side SOL Spot range.

const num = v => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Jupiter `assets/search` token entry → Careless token screen. */
export function rejectTokenBasics(token, mint, s, { whitelisted = false, now = Date.now() } = {}) {
  if (!token || token.id !== mint) return "token data unavailable";
  if (s.requireProfile && !token.icon) return "no token image/profile";
  const top10 = num(token.audit?.topHoldersPercentage);
  if (top10 == null || top10 >= s.maxTop10Pct) return `top10 ${top10 ?? "unknown"}% >= ${s.maxTop10Pct}%`;
  if (token.audit?.mintAuthorityDisabled !== true || token.audit?.freezeAuthorityDisabled !== true) return "mint/freeze authority enabled or unknown";
  const dev = num(token.audit?.devBalancePercentage ?? 0);
  if (dev == null || dev > s.maxDevBalancePct) return `dev holds ${dev ?? "unknown"}% > ${s.maxDevBalancePct}%`;
  const fees = num(token.fees);
  if (s.minTokenFeesSol > 0 && (fees == null || fees < s.minTokenFeesSol)) return `fees ${fees ?? "unknown"} SOL < ${s.minTokenFeesSol}`;
  const p1h = num(token.stats1h?.priceChange);
  if (p1h == null) return "1h price change unknown";
  if (p1h > s.maxPump1hPct) return `pumping +${p1h.toFixed(0)}% in 1h`;
  const liq24 = num(token.stats24h?.liquidityChange);
  if (liq24 != null && liq24 <= -s.maxLiquidityDrop24hPct) return `liquidity ${liq24.toFixed(0)}% in 24h`;
  if (whitelisted) return null; // narrative whitelist skips age, mcap, launchpad and ranging

  const mcap = num(token.mcap);
  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} < ${s.minMcap}`;
  if (s.maxMcap != null && mcap > s.maxMcap) return `mcap ${mcap} > ${s.maxMcap}`;
  const ageH = (now - Date.parse(token.createdAt)) / 3_600_000;
  if (!(ageH >= s.minTokenAgeHours)) return `token age ${Number.isFinite(ageH) ? ageH.toFixed(0) : "unknown"}h < ${s.minTokenAgeHours}h`;
  if (s.launchpads?.length && !(token.launchpad && s.launchpads.includes(token.launchpad))) return `launchpad ${token.launchpad ?? "unknown"} not in ${s.launchpads.join("/")}`;
  const p24 = num(token.stats24h?.priceChange);
  if (p24 == null) return "24h price change unknown";
  if (Math.abs(p24) > s.maxRange24hPct) return `not ranging: ${p24.toFixed(0)}% in 24h (limit ±${s.maxRange24hPct}%)`;
  return null;
}

/** Rugcheck `/report/summary`. */
export function rejectRugcheck(report, r) {
  if (!report) return r.requireData ? "rugcheck data unavailable" : null;
  const score = num(report.score_normalised ?? report.scoreNormalised);
  if (score == null) { if (r.requireData) return "rugcheck score unavailable"; }
  else if (score > r.maxScore) return `rugcheck score ${score}/100 > ${r.maxScore}`;
  const risks = Array.isArray(report.risks) ? report.risks : [];
  const blocked = new Set((r.blockRisks || []).map(x => String(x).toLowerCase()));
  for (const risk of risks) {
    const name = String(risk?.name || "");
    if (r.rejectDanger && String(risk?.level).toLowerCase() === "danger") return `rugcheck danger: ${name}`;
    if (blocked.has(name.toLowerCase())) return `rugcheck risk: ${name}`;
  }
  return null;
}

/** Converts a GMGN rate to percent. GMGN returns fractions (0.12 = 12%) unless configured otherwise. */
export function gmgnPct(value, ratesAreFractions = true) {
  const n = num(value);
  if (n == null) return null;
  return ratesAreFractions ? n * 100 : n;
}

/** Normalised GMGN metrics (percent) from `/v1/token/security`. */
export function gmgnMetrics(security, g) {
  if (!security || typeof security !== "object") return null;
  const f = g.ratesAreFractions !== false;
  return {
    phishingPct: gmgnPct(security.rat_trader_amount_rate, f),
    bundlerPct: gmgnPct(security.bundler_trader_amount_rate, f),
    insidersPct: gmgnPct(security.suspected_insider_hold_rate, f),
    top10Pct: gmgnPct(security.top_10_holder_rate, f),
  };
}

/**
 * GMGN gate on a gmgnSecurity() result. null = no API key (skipped unless
 * requireData); {ok:false} = the call failed → reject, an outage is never "safe".
 */
export function rejectGmgnFetch(fetchResult, g) {
  if (fetchResult == null) return { reason: g.requireData ? "gmgn: no API key" : null, metrics: null };
  if (!fetchResult.ok) return { reason: `gmgn unavailable (${fetchResult.reason})`, metrics: null };
  const metrics = gmgnMetrics(fetchResult.data, g);
  return { reason: rejectGmgn(metrics, { ...g, requireData: true }), metrics };
}

export function rejectGmgn(metrics, g) {
  if (!metrics) return g.requireData ? "gmgn data unavailable" : null;
  for (const [label, value, max] of [
    ["phishing", metrics.phishingPct, g.maxPhishingPct],
    ["bundling", metrics.bundlerPct, g.maxBundlerPct],
    ["insiders", metrics.insidersPct, g.maxInsidersPct],
    ["top10", metrics.top10Pct, g.maxTop10Pct],
  ]) {
    if (max == null) continue;
    if (value == null) { if (g.requireData) return `gmgn ${label} unknown`; continue; }
    if (value >= max) return `gmgn ${label} ${value.toFixed(1)}% >= ${max}%`;
  }
  return null;
}

/** 24h fee/TVL in percent from a Meteora discovery row (timeframe 24h). */
export function feeTvlPct(p) {
  const tvl = num(p?.tvl);
  const fee = num(p?.fee);
  return tvl > 0 && fee != null ? (fee / tvl) * 100 : null;
}

/**
 * Pool eligibility for a candidate mint, from a 24h discovery row.
 * Careless needs an exact token/SOL DLMM pool with steady fees.
 */
export function rejectPool(p, mint, solMint, s) {
  if (p?.token_x?.address !== mint || p?.token_y?.address !== solMint || p?.pool_type !== "dlmm") return "needs exact token/SOL DLMM pool";
  if (p.is_blacklisted === true) return "pool blacklisted";
  const warnings = [...(p.token_x?.warnings ?? []), ...(p.token_y?.warnings ?? [])];
  if (warnings.some(w => ["critical", "danger"].includes(String(w?.severity).toLowerCase()))) return "token warning on Meteora";
  const binStep = num(p.dlmm_params?.bin_step);
  if (binStep == null || binStep < s.minBinStep || binStep > s.maxBinStep) return `bin step ${binStep ?? "unknown"} outside ${s.minBinStep}-${s.maxBinStep}`;
  const tvl = num(p.tvl);
  if (tvl == null || tvl < s.minTvl) return `tvl ${tvl ?? "unknown"} < ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `tvl ${tvl} > ${s.maxTvl}`;
  const ft = feeTvlPct(p);
  if (ft == null || ft < s.minFeeTvl24hPct) return `24h fee/TVL ${ft == null ? "unknown" : ft.toFixed(1)}% < ${s.minFeeTvl24hPct}%`;
  if (!(num(p.pool_price) > 0)) return "pool price unavailable";
  return null;
}

/** Highest bin step first (a -80% range needs fewer bins), then 24h fee/TVL, then TVL. */
export function rankPools(pools, preferHighBinStep = true) {
  return [...pools].sort((a, b) => {
    const step = (num(b.dlmm_params?.bin_step) ?? 0) - (num(a.dlmm_params?.bin_step) ?? 0);
    if (preferHighBinStep && step) return step;
    return (feeTvlPct(b) ?? 0) - (feeTvlPct(a) ?? 0)
      || (num(b.tvl) ?? 0) - (num(a.tvl) ?? 0)
      || String(a.pool_address).localeCompare(String(b.pool_address));
  });
}
