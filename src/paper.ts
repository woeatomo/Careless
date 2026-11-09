/**
 * Simulator posisi DLMM SOL-only untuk paper test (port dari meridianEvPANDA evilpanda/sim.js).
 *
 * Posisi memakai `binsBelow` bin di bawah harga masuk. Bin i (0 = paling atas, di harga masuk)
 * berharga entry × (1+s)^-i dan berisi y_i SOL. Kalau harga turun melewati sebuah bin, SOL di bin
 * itu sudah berubah jadi token di harga bin tersebut; kalau harga naik lagi, token dibeli balik di
 * harga yang sama. Tanpa fee, nilai posisi hanya bergantung pada harga sekarang.
 */

import type { RangeSide } from "./rules/exit.js";

export type Shape = "Spot" | "BidAsk" | "Curve";

export interface Bin {
  price: number; // harga token dalam SOL
  y: number; // SOL awal di bin ini
}

export function buildBins(capitalSol: number, entryPrice: number, binStep: number, binsBelow: number, shape: Shape): Bin[] {
  const s = binStep / 10_000;
  const n = Math.max(1, Math.round(binsBelow));
  // Spot: SOL rata per bin. BidAsk: makin ke bawah makin tebal. Curve: makin dekat harga makin tebal.
  const weights = Array.from({ length: n }, (_, i) => (shape === "Spot" ? 1 : shape === "BidAsk" ? i + 1 : n - i));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w, i) => ({ price: entryPrice * Math.pow(1 + s, -i), y: (capitalSol * w) / total }));
}

/** Nilai posisi dalam SOL di harga `price`, belum termasuk fee. */
export function valueAt(bins: Bin[], price: number): { value: number; sol: number; tokenValue: number } {
  let sol = 0;
  let tokenValue = 0;
  for (const b of bins) {
    if (price >= b.price) sol += b.y;
    else tokenValue += (b.y / b.price) * price;
  }
  return { value: sol + tokenValue, sol, tokenValue };
}

/** Indeks bin tempat harga berada (<0 = di atas range, >= n = di bawah range). */
export function activeIndex(bins: Bin[], binStep: number, price: number): number {
  return Math.floor(Math.log(bins[0].price / price) / Math.log(1 + binStep / 10_000));
}

export function sideOf(bins: Bin[], binStep: number, price: number): RangeSide {
  if (!(price > 0) || bins.length === 0) return "unknown";
  const idx = activeIndex(bins, binStep, price);
  if (idx < 0) return "above";
  if (idx >= bins.length) return "below";
  return "in";
}

/** Nilai SOL likuiditas kita di sekitar harga sekarang (± spanBins), bagian yang menghasilkan fee. */
export function liquidityNearPrice(bins: Bin[], binStep: number, price: number, spanBins = 3): number {
  const idx = activeIndex(bins, binStep, price);
  let v = 0;
  for (let i = Math.max(0, idx - spanBins); i <= Math.min(bins.length - 1, idx + spanBins); i++) {
    const b = bins[i];
    v += price >= b.price ? b.y : (b.y / b.price) * price;
  }
  return v;
}

/**
 * Fee satu interval: fee pool 5 menit ÷ active TVL × likuiditas kita di dekat harga × (menit/5).
 * Menit dibatasi `maxMinutes` supaya bot yang mati lama tidak mendapat fee fiktif saat hidup lagi.
 */
export function feeForInterval(
  fee5mUsd: number,
  activeTvlUsd: number,
  ourNearSol: number,
  minutes: number,
  maxMinutes = 15,
): number {
  if (!(fee5mUsd > 0) || !(activeTvlUsd > 0) || !(ourNearSol > 0) || !(minutes > 0)) return 0;
  return (fee5mUsd / activeTvlUsd) * ourNearSol * (Math.min(minutes, maxMinutes) / 5);
}

/** Hasil akhir saat ditutup: nilai + fee − slippage jual token − biaya transaksi. */
export function closeProceeds(bins: Bin[], price: number, feesSol: number, slippagePct: number, txSol: number): number {
  const v = valueAt(bins, price);
  return v.value + feesSol - (v.tokenValue * slippagePct) / 100 - txSol;
}
