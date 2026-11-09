import type { Config, EntryCfg, TrackCfg } from "../config.js";
import type { PoolDetail, PoolSummary } from "../types.js";
import { SOL_MINT } from "../util.js";

export interface Verdict {
  pass: boolean;
  reasons: string[];
}

export const feeTvl24hPct = (fee24h: number, tvl: number) => (tvl > 0 && Number.isFinite(fee24h) ? (fee24h / tvl) * 100 : NaN);
/** Fee 4 jam terakhir disetarakan ke 24 jam (×6), dalam persen TVL. */
export const feeRecentAs24hPct = (fee4h: number, tvl: number) => (tvl > 0 && Number.isFinite(fee4h) ? ((fee4h * 6) / tvl) * 100 : NaN);

/** Ambang fee/TVL 24 jam: pool dalam (TVL besar) boleh memakai ambang lebih rendah. */
export function minFeeTvl(e: EntryCfg, tvl: number): number {
  return e.deep_pool_tvl_min_usd && e.deep_pool_fee_tvl_24h_min_pct && tvl > e.deep_pool_tvl_min_usd
    ? e.deep_pool_fee_tvl_24h_min_pct
    : e.fee_tvl_24h_min_pct;
}

/**
 * Tahap 1: dari baris Meteora Discovery saja (tanpa panggilan tambahan).
 * Syarat token (umur, mcap, ranging, organic) dicek di tahap 2 dengan data Jupiter.
 */
export function screenPool(p: PoolSummary, e: EntryCfg): Verdict {
  const reasons: string[] = [];
  const ft = feeTvl24hPct(p.fee24h, p.tvl);
  const minFt = minFeeTvl(e, p.tvl);
  if (!(ft >= minFt)) reasons.push(`fee/TVL 24j ${Number.isFinite(ft) ? ft.toFixed(1) : "?"}% < ${minFt}%`);
  if (e.volume_24h_min_usd > 0 && !(p.vol24h >= e.volume_24h_min_usd)) reasons.push("volume 24j kurang");
  if (!(p.tvl >= e.tvl_min_usd)) reasons.push("TVL kurang");
  if (!(p.binStep >= e.bin_step_min && p.binStep <= e.bin_step_max)) reasons.push(`bin step ${p.binStep} di luar batas`);
  if (p.poolType !== "dlmm") reasons.push("bukan DLMM");
  if (p.quoteMint !== SOL_MINT) reasons.push("quote bukan SOL");
  if (p.blacklisted !== false) reasons.push("status blacklist pool tidak aman/tidak diketahui");
  if (p.hasWarning !== false) reasons.push("token punya peringatan Meteora / data peringatan kosong");
  if (!(p.price > 0)) reasons.push("harga pool tidak tersedia");
  return { pass: reasons.length === 0, reasons };
}

/**
 * Tahap 2: audit token + syarat jalur dengan data lengkap (Meteora + Jupiter).
 * Data yang tidak ada = tolak (fail-safe). Whitelist narasi melewati umur, mcap, launchpad, dan ranging.
 */
export function auditDetail(d: PoolDetail, cfg: Config, track: TrackCfg, whitelisted = false, now = Date.now()): Verdict {
  const a = cfg.audit;
  const e = track.entry;
  const reasons: string[] = [];
  const au = d.audit;
  if (!au) return { pass: false, reasons: ["data audit tidak tersedia"] };
  if (a.require_mint_freeze_revoked && !(au.mintDisabled && au.freezeDisabled)) reasons.push("mint/freeze belum revoked");
  if (!(au.topHoldersPct <= a.top_holders_max_pct)) reasons.push(`top holder ${Number.isFinite(au.topHoldersPct) ? au.topHoldersPct.toFixed(0) : "?"}%`);
  if (!(au.devBalancePct <= a.dev_holding_max_pct)) reasons.push(`dev pegang ${au.devBalancePct.toFixed(1)}%`);
  if (au.devMints > a.dev_mints_max) reasons.push(`dev serial (${au.devMints} token)`);
  const liq24 = d.stats24h?.liquidityChange;
  if (liq24 !== undefined && liq24 <= -a.liquidity_drop_24h_max_pct) reasons.push(`likuiditas 24j ${liq24.toFixed(0)}%`);
  if (!(d.priceInSol > 0)) reasons.push("harga tidak diketahui");
  if (e.organic_score_min > 0 && !(d.organicScore >= e.organic_score_min)) reasons.push("organic score rendah/tidak diketahui");

  const p1h = d.stats1h?.priceChange;
  if (!(p1h !== undefined && Number.isFinite(p1h))) reasons.push("perubahan harga 1j tidak diketahui");
  else if (p1h > e.skip_if_pump_1h_pct) reasons.push(`pump parabolik (+${p1h.toFixed(0)}% 1j)`);

  if (e.fee_recent_as_24h_min_pct > 0 && !(d.feeRecentAs24hPct >= e.fee_recent_as_24h_min_pct))
    reasons.push(`laju fee 4j ${Number.isFinite(d.feeRecentAs24hPct) ? d.feeRecentAs24hPct.toFixed(1) : "?"}% < ${e.fee_recent_as_24h_min_pct}%`);

  if (!whitelisted) {
    if (!(d.mcap >= e.mcap_min_usd)) reasons.push("mcap kurang/tidak diketahui");
    const ageH = d.createdAt ? (now - Date.parse(d.createdAt)) / 3_600_000 : NaN;
    if (!(ageH >= e.token_age_min_hours)) reasons.push("token terlalu baru/umur tidak diketahui");
    const p24 = d.stats24h?.priceChange;
    if (e.ranging_24h_max_abs_pct > 0 && !(p24 !== undefined && Math.abs(p24) <= e.ranging_24h_max_abs_pct))
      reasons.push(`tidak ranging (24j ${p24 !== undefined && Number.isFinite(p24) ? p24.toFixed(0) : "?"}%)`);
    const pads = e.launchpads;
    if (pads.length > 0 && !(d.launchpad && pads.includes(d.launchpad)))
      reasons.push(`launchpad ${d.launchpad ?? "?"} bukan ${pads.join("/")}`);
  }

  const bins = binsForRange(track.position.range_below_pct, d.binStep);
  if (track.position.max_bins > 0 && bins > track.position.max_bins)
    reasons.push(`butuh ${bins} bin > batas ${track.position.max_bins}`);
  return { pass: reasons.length === 0, reasons };
}

/** Jumlah bin untuk menjangkau harga turun `pct` persen pada bin step tertentu (basis poin). */
export function binsForRange(pct: number, binStep: number): number {
  return Math.ceil(Math.abs(Math.log(1 - pct / 100) / Math.log(1 + binStep / 10_000)));
}
