/**
 * Model nilai posisi SOL-only di bawah harga, untuk paper trading.
 * Likuiditas tersebar di bin dari harga masuk turun `depthPct`.
 * Bin yang sudah dilewati harga = SOL sudah jadi token (dibeli di harga bin itu).
 */
const BINS = 120;

export type Shape = "Spot" | "BidAsk" | "Curve";

function weight(shape: Shape, i: number): number {
  const x = i / (BINS - 1); // 0 = dekat harga, 1 = dasar range
  if (shape === "BidAsk") return 0.05 + 0.95 * x; // tebal di bawah
  if (shape === "Curve") return 1 - 0.95 * x; // tebal dekat harga
  return 1; // Spot: rata
}

export function valueRatio(priceRatio: number, depthPct: number, shape: Shape = "BidAsk"): number {
  if (!(priceRatio > 0)) return 0;
  if (priceRatio >= 1) return 1; // harga di atas range: masih 100% SOL
  const bottom = 1 - depthPct / 100;
  let total = 0;
  let value = 0;
  for (let i = 0; i < BINS; i++) {
    const p = Math.pow(bottom, i / (BINS - 1)); // geometris 1 -> bottom
    const w = weight(shape, i);
    total += w;
    value += p >= priceRatio ? w * (priceRatio / p) : w;
  }
  return value / total;
}

/** Kompatibilitas: model bid-ask. */
export const bidAskValueRatio = (priceRatio: number, depthPct: number) => valueRatio(priceRatio, depthPct, "BidAsk");

/** Fee kasar untuk posisi virtual: porsi dari laju fee pool, hanya saat harga di dalam range. */
export function paperFeeSol(
  amountSol: number,
  fee24hUsd: number,
  tvlUsd: number,
  minutes: number,
  captureFactor: number,
): number {
  if (!(tvlUsd > 0) || !(minutes > 0)) return 0;
  const ratePerMin = fee24hUsd / tvlUsd / 1440;
  return amountSol * ratePerMin * minutes * captureFactor;
}
