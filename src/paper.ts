/**
 * Model posisi SOL-only di bawah harga untuk paper trading.
 * Likuiditas tersebar dari harga masuk turun `depthPct`. Bin yang sudah dilewati harga
 * berarti SOL sudah jadi token (dibeli di harga bin itu).
 */
const BINS = 120;

export type Shape = "Spot" | "BidAsk" | "Curve";

/** Bobot likuiditas di posisi x (0 = dekat harga masuk, 1 = dasar range). */
function weight(shape: Shape, x: number): number {
  if (shape === "BidAsk") return 0.05 + 0.95 * x; // tebal di bawah
  if (shape === "Curve") return 1 - 0.95 * x; // tebal dekat harga
  return 1; // Spot: rata
}
const MEAN_WEIGHT: Record<Shape, number> = { Spot: 1, BidAsk: 0.525, Curve: 0.525 };

/** Nilai posisi relatif terhadap modal awal (tanpa fee). */
export function valueRatio(priceRatio: number, depthPct: number, shape: Shape = "BidAsk"): number {
  if (!(priceRatio > 0)) return 0;
  if (priceRatio >= 1) return 1; // harga di atas range: masih 100% SOL
  const bottom = 1 - depthPct / 100;
  let total = 0;
  let value = 0;
  for (let i = 0; i < BINS; i++) {
    const x = i / (BINS - 1);
    const p = Math.pow(bottom, x); // geometris 1 -> bottom
    const w = weight(shape, x);
    total += w;
    value += p >= priceRatio ? w * (priceRatio / p) : w;
  }
  return value / total;
}

/** Kompatibilitas: model bid-ask. */
export const bidAskValueRatio = (priceRatio: number, depthPct: number) => valueRatio(priceRatio, depthPct, "BidAsk");

/**
 * Pengali fee per SOL relatif terhadap posisi Spot selebar `refDepthPct`.
 * - Di luar range = 0 (tidak dapat fee).
 * - Range lebih lebar = likuiditas lebih tipis per bin = fee per SOL lebih kecil.
 * - Shape menentukan seberapa tebal likuiditas di bin tempat harga sekarang berada.
 */
export function feeMultiplier(priceRatio: number, depthPct: number, shape: Shape, refDepthPct = 30): number {
  const bottom = 1 - depthPct / 100;
  if (!(priceRatio > 0) || priceRatio > 1 || priceRatio < bottom) return 0;
  const x = Math.log(priceRatio) / Math.log(bottom); // 0..1 posisi harga di dalam range
  const density = weight(shape, Math.min(1, Math.max(0, x))) / MEAN_WEIGHT[shape];
  const widthFactor = Math.log(1 - refDepthPct / 100) / Math.log(bottom);
  return density * widthFactor;
}

/** Fee kasar untuk posisi virtual: laju fee pool × porsi tangkapan × pengali kepadatan. */
export function paperFeeSol(
  amountSol: number,
  fee24hUsd: number,
  tvlUsd: number,
  minutes: number,
  captureFactor: number,
  multiplier = 1,
): number {
  if (!(tvlUsd > 0) || !(minutes > 0) || !(multiplier > 0)) return 0;
  const ratePerMin = fee24hUsd / tvlUsd / 1440;
  return amountSol * ratePerMin * minutes * captureFactor * multiplier;
}
