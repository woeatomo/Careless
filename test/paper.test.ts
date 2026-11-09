import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBins, closeProceeds, feeForInterval, liquidityNearPrice, sideOf, valueAt } from "../src/paper.js";
import { binsForRange } from "../src/rules/entry.js";
import { buildDetail, normalizeDiscovery } from "../src/sources.js";

const loss = (shape: "Spot" | "BidAsk", depth: number, move: number, binStep = 100) => {
  const bins = buildBins(1, 1, binStep, binsForRange(depth, binStep), shape);
  return (1 - valueAt(bins, 1 - move).value) * 100;
};

test("IL: Spot -80% menahan dump jauh lebih baik dari range sempit", () => {
  assert.ok(Math.abs(loss("Spot", 80, 0)) < 1e-9);
  const spot80at50 = loss("Spot", 80, 0.5);
  const ba30at30 = loss("BidAsk", 30, 0.3);
  assert.ok(spot80at50 > 9 && spot80at50 < 15, `spot -80% di -50%: ${spot80at50}`);
  assert.ok(ba30at30 > 8 && ba30at30 < 14, `bid-ask -30% di dasar: ${ba30at30}`);
  assert.ok(loss("BidAsk", 80, 0.5) < spot80at50, "bid-ask rugi lebih kecil dari spot di range sama");
});

test("posisi range: di atas / di dalam / di bawah", () => {
  const bins = buildBins(1, 1, 100, 36, "BidAsk");
  assert.equal(sideOf(bins, 100, 1.05), "above");
  assert.equal(sideOf(bins, 100, 0.85), "in");
  assert.equal(sideOf(bins, 100, 0.5), "below");
  assert.equal(sideOf(bins, 100, NaN), "unknown");
});

test("fee: Spot -80% punya likuiditas dekat harga lebih tipis dari Spot -30%", () => {
  const wide = buildBins(1, 1, 100, binsForRange(80, 100), "Spot");
  const tight = buildBins(1, 1, 100, binsForRange(30, 100), "Spot");
  const nw = liquidityNearPrice(wide, 100, 0.9, 3);
  const nt = liquidityNearPrice(tight, 100, 0.9, 3);
  assert.ok(nw < nt * 0.3, `${nw} vs ${nt}`);
  // fee 5m $50, active TVL $40K, likuiditas dekat 0,1 SOL, 5 menit
  assert.ok(Math.abs(feeForInterval(50, 40_000, 0.1, 5) - 0.000125) < 1e-9);
});

test("fee: downtime dibatasi, data kosong = 0", () => {
  assert.equal(feeForInterval(50, 40_000, 0.1, 600, 15), feeForInterval(50, 40_000, 0.1, 15, 15));
  assert.equal(feeForInterval(NaN, 40_000, 0.1, 5), 0);
  assert.equal(feeForInterval(50, 0, 0.1, 5), 0);
});

test("tutup: biaya transaksi dan slippage token dipotong", () => {
  const bins = buildBins(0.2, 1, 100, 162, "Spot");
  assert.ok(Math.abs(closeProceeds(bins, 1.1, 0, 1, 0.003) - 0.197) < 1e-9); // di atas range: 100% SOL, hanya biaya tx
  const v = valueAt(bins, 0.6);
  const got = closeProceeds(bins, 0.6, 0.01, 1, 0.003);
  assert.ok(Math.abs(got - (v.value + 0.01 - v.tokenValue * 0.01 - 0.003)) < 1e-12);
});

test("normalisasi baris Meteora Discovery + token Jupiter", () => {
  const SOL = "So11111111111111111111111111111111111111112";
  const row = {
    pool_address: "POOL", pool_type: "dlmm", name: "STANK-SOL", tvl: "63142.2", active_tvl: "21000", fee: "10019.5", volume: "374495",
    pool_price: "0.0000246", dlmm_params: { bin_step: 100 }, is_blacklisted: false,
    token_x: { address: "MINT", warnings: [] }, token_y: { address: SOL, warnings: [] },
  };
  const s = normalizeDiscovery(row);
  assert.equal(s.symbol, "STANK");
  assert.equal(s.blacklisted, false);
  assert.equal(s.hasWarning, false);
  assert.ok(Math.abs(s.fee24h / s.tvl - 0.1587) < 0.001);
  assert.equal(normalizeDiscovery({ ...row, token_x: { address: "MINT" } }).hasWarning, undefined);

  const token = {
    id: "MINT", symbol: "STANK", launchpad: "pump.fun", holderCount: 2776, organicScore: 74, mcap: 2125697, createdAt: "2026-10-29T13:56:47Z",
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18.4, devBalancePercentage: 1.13, devMints: 1 },
    stats5m: { priceChange: -1.7, liquidityChange: 0.38, holderChange: -0.1, buyVolume: 65, sellVolume: 231 },
    stats1h: { priceChange: 6.7 }, stats24h: { priceChange: 27.7, liquidityChange: 36.3 },
  };
  const d = buildDetail({ ...row, fee: "12" }, row, token, 9);
  assert.equal(d.fee5m, 12);
  assert.ok(Math.abs(d.fee24h - 10019.5) < 1e-9);
  assert.equal(d.priceInSol, 0.0000246);
  assert.equal(d.audit?.topHoldersPct, 18.4);
  assert.equal(d.launchpad, "pump.fun");
  assert.equal(d.stats24h?.priceChange, 27.7);
  assert.equal(d.feeRecentAs24hPct, 9);
});
