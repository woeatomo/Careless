import type { Config, EntryCfg, TrackCfg } from "../config.js";
import type { PoolDetail, PoolSummary } from "../api.js";
import { SOL_MINT } from "../util.js";

export interface Verdict {
  pass: boolean;
  reasons: string[];
}

export const feeTvl24hPct = (fee24h: number, tvl: number) => (tvl > 0 ? (fee24h / tvl) * 100 : 0);
export const feeRate6hAs24hPct = (fee6h: number, tvl: number) => (tvl > 0 ? ((fee6h * 4) / tvl) * 100 : 0);

/**
 * Filter tahap 1: data dari discover (murah, tanpa panggilan tambahan).
 * Token di whitelist melewati syarat umur, mcap, dan ranging (narasi kuat).
 */
export function screenSummary(p: PoolSummary, e: EntryCfg, now = Date.now(), whitelisted = false): Verdict {
  const reasons: string[] = [];
  const ft24 = feeTvl24hPct(p.fee24h, p.tvl);
  const deep = e.deep_pool_tvl_min_usd && p.tvl > e.deep_pool_tvl_min_usd && e.deep_pool_fee_tvl_24h_min_pct;
  const minFt = deep ? (e.deep_pool_fee_tvl_24h_min_pct as number) : e.fee_tvl_24h_min_pct;
  if (!(ft24 >= minFt)) reasons.push(`fee/TVL 24j ${ft24.toFixed(1)}% < ${minFt}%`);
  if (e.fee_rate_6h_as_24h_min_pct > 0 && Number.isFinite(p.fee6h)) {
    const rate6 = feeRate6hAs24hPct(p.fee6h, p.tvl);
    if (!(rate6 >= e.fee_rate_6h_as_24h_min_pct)) reasons.push(`laju 6j ${rate6.toFixed(1)}% < ${e.fee_rate_6h_as_24h_min_pct}%`);
  }
  if (e.volume_24h_min_usd > 0 && !(p.vol24h >= e.volume_24h_min_usd)) reasons.push("volume 24j kurang");
  if (!(p.tvl >= e.tvl_min_usd)) reasons.push("TVL kurang");
  if (e.organic_score_min > 0 && !(p.organicScore >= e.organic_score_min)) reasons.push("organic score rendah");
  if (!(p.binStep >= e.bin_step_min && p.binStep <= e.bin_step_max)) reasons.push(`bin step ${p.binStep} di luar batas`);
  if (p.priceChange1h > e.skip_if_pump_1h_pct) reasons.push(`pump parabolik (+${p.priceChange1h.toFixed(0)}% 1j)`);
  if (p.protocol && p.protocol !== "meteora") reasons.push("bukan DLMM");
  if (p.quoteMint && p.quoteMint !== SOL_MINT) reasons.push("quote bukan SOL");

  if (!whitelisted) {
    if (!(p.mcap >= e.mcap_min_usd)) reasons.push("mcap kurang");
    const ageH = p.firstPoolCreatedAt ? (now - Date.parse(p.firstPoolCreatedAt)) / 3_600_000 : NaN;
    if (!(ageH >= e.token_age_min_hours)) reasons.push("token terlalu baru");
    if (e.ranging_24h_max_abs_pct > 0 && !(Math.abs(p.priceChange24h) <= e.ranging_24h_max_abs_pct))
      reasons.push(`tidak ranging (24j ${p.priceChange24h.toFixed(0)}%)`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** Filter tahap 2: audit token dari detail pool. Data audit kosong = tolak (fail-safe). */
export function auditDetail(d: PoolDetail, cfg: Config, track: TrackCfg, whitelisted = false): Verdict {
  const a = cfg.audit;
  const reasons: string[] = [];
  const au = d.audit;
  if (!au) return { pass: false, reasons: ["data audit tidak tersedia"] };
  if (a.require_mint_freeze_revoked && !(au.mintDisabled && au.freezeDisabled)) reasons.push("mint/freeze belum revoked");
  if (!(au.topHoldersPct <= a.top_holders_max_pct)) reasons.push(`top holder ${au.topHoldersPct.toFixed(0)}%`);
  if (!(au.devBalancePct <= a.dev_holding_max_pct)) reasons.push(`dev pegang ${au.devBalancePct.toFixed(1)}%`);
  if (au.devMints > a.dev_mints_max) reasons.push(`dev serial (${au.devMints} token)`);
  const liq24 = d.stats24h?.liquidityChange;
  if (liq24 !== undefined && liq24 <= -a.liquidity_drop_24h_max_pct) reasons.push(`likuiditas 24j ${liq24.toFixed(0)}%`);
  if (!Number.isFinite(d.activeBin)) reasons.push("active bin tidak diketahui");
  const pads = track.entry.launchpads;
  if (!whitelisted && pads.length > 0 && !(d.launchpad && pads.includes(d.launchpad)))
    reasons.push(`launchpad ${d.launchpad ?? "?"} bukan ${pads.join("/")}`);
  const bins = binsForRange(track.position.range_below_pct, d.binStep);
  if (track.position.max_bins > 0 && bins > track.position.max_bins)
    reasons.push(`butuh ${bins} bin > batas ${track.position.max_bins}`);
  return { pass: reasons.length === 0, reasons };
}

/** Jumlah bin untuk menjangkau harga turun `pct` persen pada bin step tertentu (basis poin). */
export function binsForRange(pct: number, binStep: number): number {
  return Math.ceil(Math.abs(Math.log(1 - pct / 100) / Math.log(1 + binStep / 10_000)));
}

/** Kedalaman range (persen) dari lebar bin, untuk menebak jalur posisi yang dibuka di luar bot. */
export function depthFromBins(bins: number, binStep: number): number {
  return (1 - Math.pow(1 + binStep / 10_000, -bins)) * 100;
}
