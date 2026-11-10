// Pure Careless rule tests (no network, no wallet, no SDK).
import test from "node:test";
import assert from "node:assert/strict";
import { buildCarelessConfig } from "../config.js";
import { rejectTokenBasics, rejectRugcheck, rejectPool, rankPools, feeTvlPct } from "../careless/filters.js";
import { oorDirection, updateOor, fastExitDecision, rugDecision, reviewDue, morningReviewDecision, localClock } from "../careless/exits.js";
import { binsForDownsidePct, downsidePctForBins, shrinkToInitialized } from "../careless/range.js";
import { buildBins, valueAt, positionView, liquidityNearPrice } from "../careless/sim.js";
import { scanDiscovery } from "../careless/sources.js";

const SOL = "So11111111111111111111111111111111111111112";
const MINT = "Mint111111111111111111111111111111111111111";
const NOW = Date.parse("2026-11-10T03:00:00Z"); // 10:00 WIB
const C = buildCarelessConfig({});

const token = (o = {}) => ({
  id: MINT, symbol: "TKN", icon: "https://x/icon.png", launchpad: "pump.fun", mcap: 2_500_000, fees: 50,
  createdAt: "2026-10-20T00:00:00Z",
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18, devBalancePercentage: 1 },
  stats5m: { priceChange: 0, liquidityChange: 0, holderChange: 0, buyVolume: 100, sellVolume: 100 },
  stats1h: { priceChange: 2, liquidityChange: 0, holderChange: 0, buyVolume: 1000, sellVolume: 1000 },
  stats24h: { priceChange: 6, liquidityChange: 3 },
  ...o,
});

const pool = (o = {}) => ({
  pool_address: "PoolA", pool_type: "dlmm", is_blacklisted: false,
  token_x: { address: MINT, warnings: [] }, token_y: { address: SOL, warnings: [] },
  tvl: 80_000, fee: 6_000, volume: 400_000, pool_price: 0.0001, dlmm_params: { bin_step: 100 }, volatility: 2,
  ...o,
});

test("defaults match the Careless strategy", () => {
  assert.equal(C.position.strategy, "spot");
  assert.equal(C.position.downsidePct, 80);
  assert.equal(C.filters.minTokenAgeHours, 72);
  assert.equal(C.filters.minMcap, 1_000_000);
  assert.deepEqual(C.filters.launchpads, ["pump.fun"]);
  assert.equal(C.pool.minFeeTvl24hPct, 5);
  assert.equal(C.pool.minTvl, 30_000);
  assert.equal(C.exits.stopLossPct, -15);
  assert.equal(C.exits.takeProfitPct, null);
  assert.equal(C.morningReview.hourLocal, 6);
  assert.equal(C.claim.onlyInMorningReview, true);
  // nested overrides keep the other defaults
  const o = buildCarelessConfig({ position: { downsidePct: 50 } });
  assert.equal(o.position.downsidePct, 50);
  assert.equal(o.position.strategy, "spot");
});

test("token screen: established, ranging pump.fun token passes", () => {
  assert.equal(rejectTokenBasics(token(), MINT, C.filters, { now: NOW }), null);
});

test("token screen: age, mcap, launchpad, ranging and pump are enforced", () => {
  const f = C.filters;
  assert.match(rejectTokenBasics(token({ createdAt: "2026-11-08T12:00:00Z" }), MINT, f, { now: NOW }), /age/);
  assert.match(rejectTokenBasics(token({ mcap: 800_000 }), MINT, f, { now: NOW }), /mcap/);
  assert.match(rejectTokenBasics(token({ launchpad: "raydium-launchlab" }), MINT, f, { now: NOW }), /launchpad/);
  assert.match(rejectTokenBasics(token({ stats24h: { priceChange: -35 } }), MINT, f, { now: NOW }), /not ranging/);
  assert.match(rejectTokenBasics(token({ stats1h: { priceChange: 80 } }), MINT, f, { now: NOW }), /pumping/);
});

test("token screen: missing data never passes", () => {
  const f = C.filters;
  assert.ok(rejectTokenBasics(null, MINT, f, { now: NOW }));
  assert.ok(rejectTokenBasics(token({ audit: undefined }), MINT, f, { now: NOW }));
  assert.ok(rejectTokenBasics(token({ stats24h: {} }), MINT, f, { now: NOW }));
  assert.ok(rejectTokenBasics(token({ stats1h: {} }), MINT, f, { now: NOW }));
  assert.ok(rejectTokenBasics(token({ mcap: null }), MINT, f, { now: NOW }));
  assert.ok(rejectTokenBasics(token({ createdAt: undefined }), MINT, f, { now: NOW }));
  assert.ok(rejectTokenBasics(token({ audit: { ...token().audit, mintAuthorityDisabled: false } }), MINT, f, { now: NOW }));
});

test("whitelist skips age/mcap/launchpad/ranging but not safety checks", () => {
  const young = token({ createdAt: "2026-11-09T20:00:00Z", mcap: 400_000, launchpad: "x", stats24h: { priceChange: 60 } });
  assert.ok(rejectTokenBasics(young, MINT, C.filters, { now: NOW }));
  assert.equal(rejectTokenBasics(young, MINT, C.filters, { whitelisted: true, now: NOW }), null);
  assert.ok(rejectTokenBasics({ ...young, audit: { ...young.audit, topHoldersPercentage: 60 } }, MINT, C.filters, { whitelisted: true, now: NOW }));
});

test("rugcheck gate", () => {
  assert.equal(rejectRugcheck({ score_normalised: 3, risks: [] }, C.rugcheck), null);
  assert.ok(rejectRugcheck({ score_normalised: 40, risks: [] }, C.rugcheck));
  assert.ok(rejectRugcheck(null, C.rugcheck));
  assert.ok(rejectRugcheck({ score_normalised: 1, risks: [{ name: "x", level: "danger" }] }, C.rugcheck));
});

test("pool screen: 24h fee/TVL, TVL, bin step, quote side, warnings", () => {
  assert.equal(rejectPool(pool(), MINT, SOL, C.pool), null);
  assert.ok(Math.abs(feeTvlPct(pool()) - 7.5) < 1e-9);
  assert.match(rejectPool(pool({ fee: 3_000 }), MINT, SOL, C.pool), /fee\/TVL/);
  assert.match(rejectPool(pool({ tvl: 20_000, fee: 2_000 }), MINT, SOL, C.pool), /tvl/);
  assert.match(rejectPool(pool({ dlmm_params: { bin_step: 20 } }), MINT, SOL, C.pool), /bin step/);
  assert.ok(rejectPool(pool({ token_y: { address: "USDC" } }), MINT, SOL, C.pool));
  assert.ok(rejectPool(pool({ token_x: { address: MINT, warnings: [{ severity: "danger" }] } }), MINT, SOL, C.pool));
  assert.ok(rejectPool(pool({ fee: null }), MINT, SOL, C.pool));
  assert.ok(rejectPool(pool({ pool_price: null }), MINT, SOL, C.pool));
});

test("pool ranking prefers high bin step (fewer bins for -80%), then fee/TVL", () => {
  const ranked = rankPools([pool({ pool_address: "A" }), pool({ pool_address: "B", dlmm_params: { bin_step: 200 } }), pool({ pool_address: "C", fee: 9_000 })]);
  assert.deepEqual(ranked.map(p => p.pool_address), ["B", "C", "A"]);
});

test("range math: -80% needs 162 bins at bin step 100, 66 at 250", () => {
  assert.equal(binsForDownsidePct(80, 100), 162);
  assert.equal(binsForDownsidePct(80, 250), 66);
  assert.ok(Math.abs(downsidePctForBins(162, 100) - 80) < 0.2);
  // rent-free shrink stops at the first missing bin array
  const r = shrinkToInitialized(-200, -362, idx => idx >= -4);
  assert.equal(r.minBinId, -280);
  assert.equal(r.shrunk, true);
});

test("Spot -80% loss stays small on a -40% dip and the stop loss fires only on deep dumps", () => {
  const bins = buildBins({ capitalSol: 1, entryPrice: 1, binStep: 100, binsBelow: 162, shape: "spot" });
  const loss = move => (1 - valueAt(bins, 1 - move).value) * 100;
  assert.ok(loss(0.2) < 2, `-20%: ${loss(0.2)}`);
  assert.ok(loss(0.4) < 8, `-40%: ${loss(0.4)}`);
  assert.ok(loss(0.55) > 12 && loss(0.6) > 15, `-55%: ${loss(0.55)}, -60%: ${loss(0.6)}`);
  const view = positionView(bins, 100, 0.7);
  assert.equal(oorDirection(view), null);
  assert.equal(oorDirection(positionView(bins, 100, 1.05)), "above");
  assert.equal(oorDirection(positionView(bins, 100, 0.15)), "below");
  assert.ok(liquidityNearPrice(bins, 100, 0.7, 3) > 0);
});

test("fast exits: stop loss, OOR above only in profit after the wait, OOR below after the wait", () => {
  const x = C.exits;
  const p = o => ({ position: "P", pnl_pct: 0, active_bin: 50, lower_bin: 0, upper_bin: 100, ...o });
  assert.equal(fastExitDecision(p({ pnl_pct: -16 }), {}, x)?.rule, "STOP_LOSS");
  assert.equal(fastExitDecision(p({ pnl_pct: -16, pnl_pct_suspicious: true }), {}, x), null);
  assert.equal(fastExitDecision(p({ pnl_pct: 30 }), {}, x), null, "no TP by default");

  const above = p({ active_bin: 110, pnl_pct: 1 });
  const oorA = updateOor(null, above, NOW);
  assert.equal(fastExitDecision(above, { oor: oorA }, x, NOW + 20 * 60_000), null);
  assert.equal(fastExitDecision(above, { oor: oorA }, x, NOW + 31 * 60_000)?.rule, "OOR_ABOVE");
  assert.equal(fastExitDecision({ ...above, pnl_pct: -2 }, { oor: oorA }, x, NOW + 120 * 60_000), null, "holds OOR above at a loss");

  const below = p({ active_bin: -5, pnl_pct: -12 });
  const oorB = updateOor(null, below, NOW);
  assert.equal(fastExitDecision(below, { oor: oorB }, x, NOW + 59 * 60_000), null);
  assert.equal(fastExitDecision(below, { oor: oorB }, x, NOW + 61 * 60_000)?.rule, "OOR_BELOW");
  assert.equal(updateOor(oorB, p(), NOW).dir, null, "back in range resets the clock");
});

test("rug guard: hard trigger alone, soft signals need two", () => {
  const g = C.rugGuard;
  assert.equal(rugDecision(token(), g), null);
  assert.equal(rugDecision(null, g), null);
  assert.equal(rugDecision(token({ stats5m: { liquidityChange: -25 } }), g)?.rule, "RUG_GUARD");
  assert.equal(rugDecision(token({ audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true } }), g)?.rule, "RUG_GUARD");
  assert.equal(rugDecision(token({ stats5m: { priceChange: -25 } }), g), null);
  assert.equal(rugDecision(token({ stats5m: { priceChange: -25 }, stats1h: { buyVolume: 100, sellVolume: 900 } }), g)?.rule, "RUG_GUARD");
});

test("morning review: due once at 06:00 WIB, closes faded positions, claims healthy ones", () => {
  const r = C.morningReview;
  const six = Date.parse("2026-11-09T23:10:00Z"); // 06:10 WIB on the 10th
  assert.deepEqual(localClock(six, r.timeZone), { hour: 6, date: "2026-11-10" });
  assert.equal(reviewDue(null, r, six), true);
  assert.equal(reviewDue("2026-11-10", r, six), false);
  assert.equal(reviewDue(null, r, NOW), false);
  assert.equal(reviewDue(null, { ...r, enabled: false }, six), false);

  assert.equal(morningReviewDecision(pool(), token(), r).action, "CLAIM");
  assert.equal(morningReviewDecision(pool({ fee: 2_000 }), token(), r).action, "CLOSE");
  assert.equal(morningReviewDecision(pool(), token({ stats24h: { priceChange: -30 } }), r).action, "CLOSE");
  assert.equal(morningReviewDecision(null, token(), r).action, "HOLD", "missing data keeps the position");
});

test("screener scan: one candidate per mint, best 24h fee/TVL first, SOL quote only, optional category", async () => {
  const urls = [];
  const rows = [
    pool({ pool_address: "A", tvl: 100_000, fee: 5_000, name: "AAA-SOL" }),
    pool({ pool_address: "B", tvl: 50_000, fee: 6_000, name: "AAA-SOL" }),
    pool({ pool_address: "C", token_x: { address: "Other1" }, tvl: 40_000, fee: 6_000, name: "BBB-SOL" }),
    pool({ pool_address: "D", token_x: { address: "Other2" }, token_y: { address: "USDC" } }),
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ data: rows }) }; };
  try {
    const out = await scanDiscovery({ ...C.screener }, SOL);
    assert.deepEqual(out.map(c => [c.mint, c.pool]), [["Other1", "C"], [MINT, "B"]]);
    assert.ok(!urls[0].includes("category="), "empty category is omitted");
    await scanDiscovery({ ...C.screener, category: "trending" }, SOL);
    assert.ok(urls[1].includes("category=trending"));
    assert.ok(decodeURIComponent(urls[1]).includes("base_token_market_cap>=1000000"));
  } finally {
    globalThis.fetch = realFetch;
  }
});
