import type { Config, ExitCfg } from "../config.js";
import type { PoolDetail } from "../types.js";
import { feeTvl24hPct } from "./entry.js";
import { rugCheck } from "./rug.js";
import { minutesSince } from "../util.js";

export type RangeSide = "in" | "above" | "below" | "unknown";

/** Status yang diingat bot per posisi antar-siklus. */
export interface Track {
  peakPnl: number;
  belowFloorSince?: string;
  outAboveSince?: string;
  outBelowSince?: string;
  lastClaimAt?: string;
  lastReviewDate?: string;
}

export interface ExitInput {
  pnlPct: number; // PnL dalam SOL, termasuk fee
  side: RangeSide;
  uncollectedFeeSol: number;
}

export type Decision =
  | { action: "close"; reason: string }
  | { action: "claim"; reason: string }
  | { action: "hold"; reason: string };

export interface ClaimPolicy {
  /** Jam WIB untuk claim harian; -1 = pakai interval biasa. */
  claimHourWib: number;
  hourNowWib: number;
  /** Tanggal WIB hari ini (untuk review pagi sekali sehari). */
  dateWib?: string;
  /** Review pagi Careless: tutup kalau melemah, kalau masih oke claim fee saja. */
  review?: MorningReviewCfg;
}

export interface MorningReviewCfg {
  enabled: boolean;
  hour_wib: number;
  min_fee_tvl_24h_pct: number;
  max_drop_24h_pct: number;
}

/** Versi mekanis review pagi Careless. */
export function morningReview(pool: PoolDetail, r: MorningReviewCfg): { close: boolean; reason: string } {
  const ft = feeTvl24hPct(pool.fee24h, pool.tvl);
  if (Number.isFinite(ft) && ft < r.min_fee_tvl_24h_pct)
    return { close: true, reason: `review pagi: fee/TVL 24j ${ft.toFixed(1)}% < ${r.min_fee_tvl_24h_pct}%` };
  const p24 = pool.stats24h?.priceChange;
  if (p24 !== undefined && Number.isFinite(p24) && p24 < -r.max_drop_24h_pct)
    return { close: true, reason: `review pagi: harga 24j ${p24.toFixed(0)}%, keluar dari ranging` };
  return { close: false, reason: "review pagi: masih sehat" };
}

export function rangeSide(activeBin: number, lowerBin: number, upperBin: number, inRange: boolean): RangeSide {
  if (inRange) return "in";
  if (![activeBin, lowerBin, upperBin].every(Number.isFinite)) return "unknown";
  if (activeBin > upperBin) return "above";
  if (activeBin < lowerBin) return "below";
  return "in";
}

/**
 * Keputusan untuk satu posisi. Murni: mengembalikan keputusan + track baru, tanpa efek samping.
 * Urutan prioritas: rug > SL > trailing TP > fee/TVL floor > out-of-range > claim fee.
 */
export function decideExit(
  input: ExitInput,
  pool: PoolDetail,
  prev: Track,
  cfg: Config,
  x: ExitCfg,
  claim: ClaimPolicy,
  nowMs = Date.now(),
): { decision: Decision; track: Track } {
  const nowIso = new Date(nowMs).toISOString();
  const t: Track = { ...prev, peakPnl: Math.max(prev.peakPnl ?? -1e9, Number.isFinite(input.pnlPct) ? input.pnlPct : -1e9) };
  const done = (decision: Decision) => ({ decision, track: t });

  const rug = rugCheck(pool, cfg);
  if (rug.trigger) return done({ action: "close", reason: `RUG: ${[...rug.hard, ...rug.soft].join(", ")}` });

  if (input.pnlPct <= x.stop_loss_pct) return done({ action: "close", reason: `SL: PnL ${input.pnlPct.toFixed(1)}%` });

  if (x.take_profit_trigger_pct > 0 && t.peakPnl >= x.take_profit_trigger_pct && input.pnlPct <= t.peakPnl - x.trailing_pct)
    return done({
      action: "close",
      reason: `TP trailing: puncak ${t.peakPnl.toFixed(1)}%, sekarang ${input.pnlPct.toFixed(1)}%`,
    });

  const ft = feeTvl24hPct(pool.fee24h, pool.tvl);
  if (x.fee_floor_enabled && Number.isFinite(ft) && pool.tvl > 0 && ft < x.fee_tvl_24h_floor_pct) {
    t.belowFloorSince ??= nowIso;
    if (minutesSince(t.belowFloorSince, nowMs) >= x.fee_floor_duration_min)
      return done({ action: "close", reason: `fee/TVL 24j ${ft.toFixed(1)}% < ${x.fee_tvl_24h_floor_pct}% selama ${x.fee_floor_duration_min}m` });
  } else t.belowFloorSince = undefined;

  if (input.side === "above") {
    t.outAboveSince ??= nowIso;
    if (minutesSince(t.outAboveSince, nowMs) >= x.out_of_range_above_close_min)
      return done({ action: "close", reason: "OOR kanan (posisi 100% SOL, tanpa fee)" });
  } else t.outAboveSince = undefined;

  if (input.side === "below") {
    t.outBelowSince ??= nowIso;
    if (minutesSince(t.outBelowSince, nowMs) >= x.out_of_range_below_close_min)
      return done({ action: "close", reason: "OOR kiri / slow rug, tidak menunggu harga balik" });
  } else t.outBelowSince = undefined;

  const r = claim.review;
  if (r?.enabled && claim.hourNowWib === r.hour_wib && claim.dateWib && t.lastReviewDate !== claim.dateWib) {
    t.lastReviewDate = claim.dateWib;
    const rev = morningReview(pool, r);
    if (rev.close) return done({ action: "close", reason: rev.reason });
    if (input.uncollectedFeeSol >= cfg.fees.claim_min_sol) return done({ action: "claim", reason: `${rev.reason}, claim fee` });
    return done({ action: "hold", reason: rev.reason });
  }

  if (input.uncollectedFeeSol >= cfg.fees.claim_min_sol) {
    const due =
      claim.claimHourWib >= 0
        ? claim.hourNowWib === claim.claimHourWib && minutesSince(t.lastClaimAt, nowMs) >= 120
        : minutesSince(t.lastClaimAt, nowMs) >= cfg.fees.claim_interval_min;
    if (due) return done({ action: "claim", reason: `fee ${input.uncollectedFeeSol.toFixed(4)} SOL` });
  }

  return done({ action: "hold", reason: "aman" });
}
