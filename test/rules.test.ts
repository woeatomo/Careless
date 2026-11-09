import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import type { PoolDetail, PoolSummary } from "../src/api.js";
import { auditDetail, binsForRange, screenSummary } from "../src/rules/entry.js";
import { decideExit, rangeSide, type ClaimPolicy } from "../src/rules/exit.js";
import { rugCheck } from "../src/rules/rug.js";
import { canOpenNew, consecutiveStopOuts, positionSize } from "../src/rules/risk.js";
import { valueRatio } from "../src/paper.js";
import { inHourWindow } from "../src/util.js";
import { inferStrat } from "../src/bot.js";

const cfg = loadConfig("config/strategy.yaml");
const CL = cfg.tracks.careless;
const EP = cfg.tracks.evilpanda;
const NOW = Date.parse("2026-11-09T03:00:00Z");
const NO_CLAIM_HOUR: ClaimPolicy = { claimHourWib: -1, hourNowWib: 10 };

const pool = (o: Partial<PoolDetail> = {}): PoolDetail => ({
  pool: "P",
  symbol: "TKN",
  activeBin: -200,
  binStep: 100,
  tvl: 100_000,
  fee24h: 15_000, // 15%
  priceInSol: 0.0001,
  launchpad: "pump.fun",
  audit: { mintDisabled: true, freezeDisabled: true, topHoldersPct: 20, devBalancePct: 1, devMints: 1 },
  stats5m: { priceChange: 0, liquidityChange: 0, holderChange: 0, buyVolume: 100, sellVolume: 100 },
  stats1h: { priceChange: 0, liquidityChange: 0, holderChange: 0, buyVolume: 1000, sellVolume: 1000 },
  stats24h: { priceChange: 0, liquidityChange: 0, holderChange: 0, buyVolume: 1, sellVolume: 1 },
  ...o,
});

const summary = (o: Partial<PoolSummary> = {}): PoolSummary => ({
  pool: "P",
  symbol: "TKN",
  tokenMint: "M",
  protocol: "meteora",
  tvl: 100_000,
  fee24h: 15_000,
  fee6h: 3_000, // 12% setara 24j
  fee1h: 500,
  vol24h: 1_000_000,
  mcap: 2_000_000,
  binStep: 100,
  organicScore: 80,
  firstPoolCreatedAt: "2026-11-01T00:00:00Z",
  priceChange1h: 2,
  priceChange6h: 3,
  priceChange24h: 8,
  ...o,
});

test("binsForRange: -30% di bin step 100 = 36 bin, -80% = 162 bin", () => {
  assert.equal(binsForRange(30, 100), 36);
  assert.equal(binsForRange(80, 100), 162);
});

test("EvilPanda: fee/TVL rendah ditolak, pool dalam cukup 6%", () => {
  assert.equal(screenSummary(summary(), EP.entry, NOW).pass, true);
  assert.equal(screenSummary(summary({ fee24h: 4_000 }), EP.entry, NOW).pass, false);
  assert.equal(screenSummary(summary({ tvl: 400_000, fee24h: 28_000, fee6h: 9_000 }), EP.entry, NOW).pass, true);
});

test("EvilPanda: laju 6 jam lemah ditolak walau 24 jam tinggi (kasus STANK)", () => {
  const r = screenSummary(summary({ fee24h: 13_000, fee6h: 1_000 }), EP.entry, NOW);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(), /laju 6j/);
});

test("Careless: fee/TVL 5% cukup, tapi wajib ranging, umur 3 hari, mcap $1M", () => {
  const ok = summary({ fee24h: 6_000, fee6h: 500, vol24h: 20_000, organicScore: 40 });
  assert.equal(screenSummary(ok, CL.entry, NOW).pass, true);
  assert.equal(screenSummary({ ...ok, priceChange24h: 45 }, CL.entry, NOW).pass, false); // tidak ranging
  assert.equal(screenSummary({ ...ok, firstPoolCreatedAt: "2026-11-07T00:00:00Z" }, CL.entry, NOW).pass, false); // < 3 hari
  assert.equal(screenSummary({ ...ok, mcap: 800_000 }, CL.entry, NOW).pass, false);
  assert.equal(screenSummary({ ...ok, tvl: 25_000, fee24h: 1_500 }, CL.entry, NOW).pass, false); // TVL < 30K
});

test("Whitelist narasi melewati umur/mcap/ranging, audit tetap jalan", () => {
  const young = summary({ fee24h: 6_000, firstPoolCreatedAt: "2026-11-08T00:00:00Z", mcap: 600_000, priceChange24h: 40 });
  assert.equal(screenSummary(young, CL.entry, NOW, false).pass, false);
  assert.equal(screenSummary(young, CL.entry, NOW, true).pass, true);
  const badAudit = pool({ audit: { mintDisabled: false, freezeDisabled: true, topHoldersPct: 10, devBalancePct: 0, devMints: 1 } });
  assert.equal(auditDetail(badAudit, cfg, CL, true).pass, false);
});

test("Careless: hanya launchpad pump.fun", () => {
  assert.equal(auditDetail(pool(), cfg, CL).pass, true);
  assert.equal(auditDetail(pool({ launchpad: "raydium-launchlab" }), cfg, CL).pass, false);
  assert.equal(auditDetail(pool({ launchpad: "raydium-launchlab" }), cfg, EP).pass, true);
});

test("audit: dev serial dan data audit kosong ditolak", () => {
  assert.equal(auditDetail(pool({ audit: { mintDisabled: true, freezeDisabled: true, topHoldersPct: 16, devBalancePct: 0, devMints: 885 } }), cfg, EP).pass, false);
  assert.equal(auditDetail(pool({ audit: undefined }), cfg, EP).pass, false);
});

test("rug: likuiditas ditarik = hard trigger, satu soft signal tidak cukup", () => {
  assert.equal(rugCheck(pool({ stats5m: { priceChange: 0, liquidityChange: -20, holderChange: 0, buyVolume: 1, sellVolume: 1 } }), cfg).trigger, true);
  const oneSoft = pool({ stats5m: { priceChange: -25, liquidityChange: 0, holderChange: 0, buyVolume: 1, sellVolume: 1 } });
  assert.equal(rugCheck(oneSoft, cfg).trigger, false);
  const twoSoft = pool({
    stats5m: { priceChange: -25, liquidityChange: 0, holderChange: 0, buyVolume: 1, sellVolume: 1 },
    stats1h: { priceChange: -30, liquidityChange: -5, holderChange: 0, buyVolume: 100, sellVolume: 900 },
  });
  assert.equal(rugCheck(twoSoft, cfg).trigger, true);
});

test("EvilPanda exit: SL dan trailing TP", () => {
  const base = { peakPnl: -1e9 };
  assert.equal(decideExit({ pnlPct: -16, side: "in", uncollectedFeeSol: 0 }, pool(), base, cfg, EP.exit, NO_CLAIM_HOUR, NOW).decision.action, "close");
  const t1 = decideExit({ pnlPct: 6, side: "in", uncollectedFeeSol: 0 }, pool(), base, cfg, EP.exit, NO_CLAIM_HOUR, NOW).track;
  assert.equal(decideExit({ pnlPct: 4, side: "in", uncollectedFeeSol: 0 }, pool(), t1, cfg, EP.exit, NO_CLAIM_HOUR, NOW).decision.action, "hold");
  assert.equal(decideExit({ pnlPct: 2.5, side: "in", uncollectedFeeSol: 0 }, pool(), t1, cfg, EP.exit, NO_CLAIM_HOUR, NOW).decision.action, "close");
});

test("Careless exit: tanpa trailing TP dan tanpa fee floor 10%", () => {
  const weak = pool({ fee24h: 5_000 }); // 5% < 10%
  const t1 = decideExit({ pnlPct: 8, side: "in", uncollectedFeeSol: 0 }, weak, { peakPnl: -1e9 }, cfg, CL.exit, NO_CLAIM_HOUR, NOW).track;
  const later = decideExit({ pnlPct: 2, side: "in", uncollectedFeeSol: 0 }, weak, t1, cfg, CL.exit, NO_CLAIM_HOUR, NOW + 120 * 60_000);
  assert.equal(later.decision.action, "hold");
  // SL tetap berlaku
  assert.equal(decideExit({ pnlPct: -15.5, side: "in", uncollectedFeeSol: 0 }, pool(), t1, cfg, CL.exit, NO_CLAIM_HOUR, NOW).decision.action, "close");
});

test("EvilPanda exit: fee/TVL < 10% harus bertahan 60 menit", () => {
  const weak = pool({ fee24h: 5_000 });
  const first = decideExit({ pnlPct: 0, side: "in", uncollectedFeeSol: 0 }, weak, { peakPnl: 0 }, cfg, EP.exit, NO_CLAIM_HOUR, NOW);
  assert.equal(first.decision.action, "hold");
  const later = decideExit({ pnlPct: 0, side: "in", uncollectedFeeSol: 0 }, weak, first.track, cfg, EP.exit, NO_CLAIM_HOUR, NOW + 61 * 60_000);
  assert.equal(later.decision.action, "close");
});

test("OOR kanan ditutup setelah 15 menit (kedua jalur)", () => {
  assert.equal(rangeSide(-195, -235, -199, false), "above");
  assert.equal(rangeSide(-240, -235, -199, false), "below");
  for (const x of [CL.exit, EP.exit]) {
    const first = decideExit({ pnlPct: 0, side: "above", uncollectedFeeSol: 0 }, pool(), { peakPnl: 0 }, cfg, x, NO_CLAIM_HOUR, NOW);
    assert.equal(first.decision.action, "hold");
    const later = decideExit({ pnlPct: 0, side: "above", uncollectedFeeSol: 0 }, pool(), first.track, cfg, x, NO_CLAIM_HOUR, NOW + 16 * 60_000);
    assert.equal(later.decision.action, "close");
  }
});

test("Careless claim: hanya di jam 06.00 WIB", () => {
  const at6: ClaimPolicy = { claimHourWib: 6, hourNowWib: 6 };
  const at10: ClaimPolicy = { claimHourWib: 6, hourNowWib: 10 };
  const input = { pnlPct: 1, side: "in" as const, uncollectedFeeSol: 0.02 };
  assert.equal(decideExit(input, pool(), { peakPnl: 0 }, cfg, CL.exit, at10, NOW).decision.action, "hold");
  const claimed = decideExit(input, pool(), { peakPnl: 0 }, cfg, CL.exit, at6, NOW);
  assert.equal(claimed.decision.action, "claim");
  // tidak claim dua kali di jam yang sama
  const again = decideExit(input, pool(), { ...claimed.track, lastClaimAt: new Date(NOW).toISOString() }, cfg, CL.exit, at6, NOW + 10 * 60_000);
  assert.equal(again.decision.action, "hold");
});

test("risk: rem setelah 3 stop-out, penutupan rutin tidak dihitung", () => {
  const mk = (pnlPct: number, reason: string) => ({ id: reason + pnlPct, pool: "x", pair: "A", pnlPct, pnlSol: pnlPct / 100, reason, closedAt: "2026-11-09T02:00:00Z", paper: false });
  const closed = [mk(3, "TP"), mk(-15, "SL: PnL -15"), mk(-1, "OOR kanan"), mk(-16, "SL: PnL -16"), mk(-20, "RUG: likuiditas")];
  assert.equal(consecutiveStopOuts(closed, false), 3);
  const state = { tracks: {}, closed, proposals: {}, paper: {}, cooldowns: {} };
  assert.equal(canOpenNew(state, cfg, 0, 1.5, false, NOW).ok, false);
  assert.equal(consecutiveStopOuts(closed.slice(0, 4), false), 2);
});

test("ukuran posisi: 0,2 SOL per posisi, mengecil saat saldo menipis, hormati buffer", () => {
  assert.equal(positionSize(cfg, CL, 1.5), 0.2);
  assert.equal(positionSize(cfg, CL, 0.6), 0.12);
  assert.equal(positionSize(cfg, CL, 0.18), 0);
});

test("model paper: Spot -80% vs Bid-Ask -30%", () => {
  assert.equal(valueRatio(1.2, 80, "Spot"), 1);
  const spot50 = 1 - valueRatio(0.5, 80, "Spot");
  assert.ok(spot50 > 0.1 && spot50 < 0.14, `spot -80% di harga -50%: ${spot50}`);
  const ba30 = 1 - valueRatio(0.7, 30, "BidAsk");
  assert.ok(ba30 > 0.09 && ba30 < 0.13, `bid-ask -30% di dasar: ${ba30}`);
});

test("tebak jalur posisi luar dari lebar range", () => {
  assert.equal(inferStrat(-361, -199), "careless");
  assert.equal(inferStrat(-235, -199), "evilpanda");
});

test("jam auto 22-6 WIB melewati tengah malam", () => {
  assert.equal(inHourWindow(23, [22, 6]), true);
  assert.equal(inHourWindow(3, [22, 6]), true);
  assert.equal(inHourWindow(10, [22, 6]), false);
});
