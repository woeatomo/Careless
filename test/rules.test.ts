import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import type { PoolDetail, PoolSummary } from "../src/types.js";
import { auditDetail, binsForRange, screenPool } from "../src/rules/entry.js";
import { decideExit, morningReview, type ClaimPolicy } from "../src/rules/exit.js";
import { rugCheck } from "../src/rules/rug.js";
import { consecutiveStopOuts } from "../src/rules/risk.js";
import { inHourWindow } from "../src/util.js";

const SOL = "So11111111111111111111111111111111111111112";
const cfg = loadConfig("config/strategy.yaml");
const CL = cfg.tracks.careless;
const EP = cfg.tracks.evilpanda;
const NOW = Date.parse("2026-11-09T03:00:00Z");
const NO_REVIEW: ClaimPolicy = { claimHourWib: -1, hourNowWib: 10 };

const summary = (o: Partial<PoolSummary> = {}): PoolSummary => ({
  pool: "P", symbol: "TKN", tokenMint: "M", quoteMint: SOL, poolType: "dlmm",
  tvl: 100_000, fee24h: 15_000, vol24h: 1_000_000, binStep: 100, price: 1e-4,
  blacklisted: false, hasWarning: false, ...o,
});

const stats = (priceChange = 0, liquidityChange = 0, holderChange = 0, buy = 100, sell = 100) =>
  ({ priceChange, liquidityChange, holderChange, buyVolume: buy, sellVolume: sell });

const detail = (o: Partial<PoolDetail> = {}): PoolDetail => ({
  pool: "P", symbol: "TKN", tokenMint: "M", binStep: 100, priceInSol: 1e-4,
  tvl: 100_000, activeTvl: 40_000, fee24h: 15_000, fee5m: 50, feeRecentAs24hPct: 12,
  mcap: 3_000_000, createdAt: "2026-10-20T00:00:00Z", organicScore: 80, holders: 5000, launchpad: "pump.fun",
  audit: { mintDisabled: true, freezeDisabled: true, topHoldersPct: 20, devBalancePct: 1, devMints: 1 },
  stats5m: stats(), stats1h: stats(1), stats24h: stats(5), ...o,
});

test("binsForRange: -30% di bin step 100 = 36 bin, -80% = 162 bin", () => {
  assert.equal(binsForRange(30, 100), 36);
  assert.equal(binsForRange(80, 100), 162);
});

test("tahap 1: fee/TVL per jalur, pool dalam EvilPanda cukup 6%", () => {
  assert.equal(screenPool(summary({ fee24h: 6_000 }), CL.entry).pass, true);
  assert.equal(screenPool(summary({ fee24h: 4_000 }), CL.entry).pass, false);
  assert.equal(screenPool(summary({ fee24h: 6_000 }), EP.entry).pass, false);
  assert.equal(screenPool(summary({ tvl: 400_000, fee24h: 28_000 }), EP.entry).pass, true);
});

test("tahap 1: data peringatan/blacklist/harga kosong = tolak (fail-safe)", () => {
  assert.equal(screenPool(summary({ blacklisted: undefined }), CL.entry).pass, false);
  assert.equal(screenPool(summary({ hasWarning: true }), CL.entry).pass, false);
  assert.equal(screenPool(summary({ price: NaN }), CL.entry).pass, false);
  assert.equal(screenPool(summary({ quoteMint: "USDC" }), CL.entry).pass, false);
});

test("Careless tahap 2: ranging, umur 3 hari, mcap $1M, pump.fun", () => {
  assert.equal(auditDetail(detail(), cfg, CL, false, NOW).pass, true);
  assert.equal(auditDetail(detail({ stats24h: stats(45) }), cfg, CL, false, NOW).pass, false);
  assert.equal(auditDetail(detail({ createdAt: "2026-11-07T00:00:00Z" }), cfg, CL, false, NOW).pass, false);
  assert.equal(auditDetail(detail({ mcap: 800_000 }), cfg, CL, false, NOW).pass, false);
  assert.equal(auditDetail(detail({ launchpad: "raydium-launchlab" }), cfg, CL, false, NOW).pass, false);
  assert.equal(auditDetail(detail({ stats1h: stats(80) }), cfg, CL, false, NOW).pass, false);
});

test("EvilPanda tahap 2: laju fee 4 jam wajib >= 8%, kosong = tolak", () => {
  assert.equal(auditDetail(detail({ launchpad: "raydium-launchlab" }), cfg, EP, false, NOW).pass, true);
  assert.equal(auditDetail(detail({ feeRecentAs24hPct: 5 }), cfg, EP, false, NOW).pass, false);
  assert.equal(auditDetail(detail({ feeRecentAs24hPct: NaN }), cfg, EP, false, NOW).pass, false);
});

test("whitelist melewati umur/mcap/ranging/launchpad, audit tetap jalan", () => {
  const young = detail({ createdAt: "2026-11-08T20:00:00Z", mcap: 600_000, stats24h: stats(40), launchpad: "x" });
  assert.equal(auditDetail(young, cfg, CL, false, NOW).pass, false);
  assert.equal(auditDetail(young, cfg, CL, true, NOW).pass, true);
  const bad = detail({ audit: { mintDisabled: false, freezeDisabled: true, topHoldersPct: 10, devBalancePct: 0, devMints: 1 } });
  assert.equal(auditDetail(bad, cfg, CL, true, NOW).pass, false);
  assert.equal(auditDetail(detail({ audit: undefined }), cfg, CL, true, NOW).pass, false);
  assert.equal(auditDetail(detail({ audit: { mintDisabled: true, freezeDisabled: true, topHoldersPct: 16, devBalancePct: 0, devMints: 885 } }), cfg, CL, false, NOW).pass, false);
});

test("rug: likuiditas ditarik = hard trigger, satu soft signal tidak cukup", () => {
  assert.equal(rugCheck(detail({ stats5m: stats(0, -20) }), cfg).trigger, true);
  assert.equal(rugCheck(detail({ stats5m: stats(-25) }), cfg).trigger, false);
  assert.equal(rugCheck(detail({ stats5m: stats(-25), stats1h: stats(-30, -5, 0, 100, 900) }), cfg).trigger, true);
});

test("EvilPanda exit: SL dan trailing TP", () => {
  const base = { peakPnl: -1e9 };
  assert.equal(decideExit({ pnlPct: -16, side: "in", uncollectedFeeSol: 0 }, detail(), base, cfg, EP.exit, NO_REVIEW, NOW).decision.action, "close");
  const t1 = decideExit({ pnlPct: 6, side: "in", uncollectedFeeSol: 0 }, detail(), base, cfg, EP.exit, NO_REVIEW, NOW).track;
  assert.equal(decideExit({ pnlPct: 4, side: "in", uncollectedFeeSol: 0 }, detail(), t1, cfg, EP.exit, NO_REVIEW, NOW).decision.action, "hold");
  assert.equal(decideExit({ pnlPct: 2.5, side: "in", uncollectedFeeSol: 0 }, detail(), t1, cfg, EP.exit, NO_REVIEW, NOW).decision.action, "close");
});

test("EvilPanda exit: fee/TVL < 10% harus bertahan 60 menit; Careless tidak terpengaruh", () => {
  const weak = detail({ fee24h: 5_000 });
  const first = decideExit({ pnlPct: 0, side: "in", uncollectedFeeSol: 0 }, weak, { peakPnl: 0 }, cfg, EP.exit, NO_REVIEW, NOW);
  assert.equal(first.decision.action, "hold");
  assert.equal(decideExit({ pnlPct: 0, side: "in", uncollectedFeeSol: 0 }, weak, first.track, cfg, EP.exit, NO_REVIEW, NOW + 61 * 60_000).decision.action, "close");
  const cl = decideExit({ pnlPct: 0, side: "in", uncollectedFeeSol: 0 }, weak, first.track, cfg, CL.exit, NO_REVIEW, NOW + 121 * 60_000);
  assert.equal(cl.decision.action, "hold");
});

test("OOR kanan ditutup setelah 15 menit (kedua jalur)", () => {
  for (const x of [CL.exit, EP.exit]) {
    const first = decideExit({ pnlPct: 0, side: "above", uncollectedFeeSol: 0 }, detail(), { peakPnl: 0 }, cfg, x, NO_REVIEW, NOW);
    assert.equal(first.decision.action, "hold");
    assert.equal(decideExit({ pnlPct: 0, side: "above", uncollectedFeeSol: 0 }, detail(), first.track, cfg, x, NO_REVIEW, NOW + 16 * 60_000).decision.action, "close");
  }
});

test("review pagi Careless: tutup kalau melemah, sekali sehari", () => {
  const r = CL.morning_review!;
  assert.equal(morningReview(detail(), r).close, false);
  assert.equal(morningReview(detail({ fee24h: 2_000 }), r).close, true);
  assert.equal(morningReview(detail({ stats24h: stats(-30) }), r).close, true);
  const policy: ClaimPolicy = { claimHourWib: -1, hourNowWib: 6, dateWib: "2026-11-10", review: r };
  const weak = detail({ fee24h: 2_000 });
  const first = decideExit({ pnlPct: 1, side: "in", uncollectedFeeSol: 0 }, weak, { peakPnl: 0 }, cfg, CL.exit, policy, NOW);
  assert.equal(first.decision.action, "close");
  const healthy = decideExit({ pnlPct: 1, side: "in", uncollectedFeeSol: 0 }, detail(), { peakPnl: 0 }, cfg, CL.exit, policy, NOW);
  assert.notEqual(healthy.decision.action, "close");
  assert.equal(healthy.track.lastReviewDate, "2026-11-10");
});

test("rem: 3 stop-out berturut-turut, penutupan rutin tidak dihitung", () => {
  const mk = (pnlPct: number, reason: string) => ({ id: reason, strat: "careless" as const, pool: "x", pair: "A", pnlPct, pnlSol: 0, reason, closedAt: "", feeSol: 0, heldMin: 0, priceMovePct: 0 });
  const closed = [mk(3, "TP"), mk(-15, "SL"), mk(-1, "OOR kanan"), mk(-16, "SL"), mk(-20, "RUG: x")];
  assert.equal(consecutiveStopOuts(closed), 3);
  assert.equal(consecutiveStopOuts(closed.slice(0, 4)), 2);
});

test("jam laporan/jendela WIB melewati tengah malam", () => {
  assert.equal(inHourWindow(23, [22, 6]), true);
  assert.equal(inHourWindow(10, [22, 6]), false);
});
