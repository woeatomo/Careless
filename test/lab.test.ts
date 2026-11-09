import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { Lab, deepMerge, metrics } from "../src/lab.js";
import { Store } from "../src/state.js";
import { Notifier } from "../src/notify.js";
import { feeMultiplier } from "../src/paper.js";
import { decideExit, morningReview } from "../src/rules/exit.js";
import type { PoolDetail } from "../src/api.js";

const SOL = "So11111111111111111111111111111111111111112";
const cfg = loadConfig("config/strategy.yaml");

test("pengali fee: range lebar dan Bid-Ask dekat harga dapat fee lebih kecil", () => {
  assert.equal(feeMultiplier(0.9, 30, "Spot"), 1);
  assert.ok(Math.abs(feeMultiplier(0.9, 80, "Spot") - 0.22) < 0.01);
  assert.ok(feeMultiplier(0.98, 30, "BidAsk") < feeMultiplier(0.72, 30, "BidAsk"));
  assert.equal(feeMultiplier(1.1, 80, "Spot"), 0); // OOR kanan
  assert.equal(feeMultiplier(0.15, 80, "Spot"), 0); // OOR kiri
});

test("deepMerge: override eksperimen tidak mengubah config asli", () => {
  const merged = deepMerge(cfg.tracks.careless, { position: { strategy: "BidAsk" } });
  assert.equal(merged.position.strategy, "BidAsk");
  assert.equal(merged.position.range_below_pct, 80);
  assert.equal(cfg.tracks.careless.position.strategy, "Spot");
});

const pool = (o: Partial<PoolDetail> = {}): PoolDetail => ({
  pool: "P", symbol: "T", activeBin: -300, binStep: 100, tvl: 80_000, fee24h: 6_000, priceInSol: 1e-4, launchpad: "pump.fun",
  audit: { mintDisabled: true, freezeDisabled: true, topHoldersPct: 18, devBalancePct: 1, devMints: 1 },
  stats5m: { priceChange: 0, liquidityChange: 0, holderChange: 0, buyVolume: 1, sellVolume: 1 },
  stats1h: { priceChange: 0, liquidityChange: 0, holderChange: 0, buyVolume: 10, sellVolume: 10 },
  stats24h: { priceChange: 3, liquidityChange: 0, holderChange: 0, buyVolume: 1, sellVolume: 1 },
  ...o,
});

test("review pagi Careless: tutup kalau melemah, claim kalau sehat, sekali sehari", () => {
  const r = cfg.tracks.careless.morning_review!;
  assert.equal(morningReview(pool(), r).close, false);
  assert.equal(morningReview(pool({ fee24h: 2_000 }), r).close, true);
  assert.equal(morningReview(pool({ stats24h: { priceChange: -30, liquidityChange: 0, holderChange: 0, buyVolume: 1, sellVolume: 1 } }), r).close, true);

  const policy = { claimHourWib: 6, hourNowWib: 6, dateWib: "2026-11-10", review: r };
  const x = cfg.tracks.careless.exit;
  const first = decideExit({ pnlPct: 2, side: "in", uncollectedFeeSol: 0.02 }, pool(), { peakPnl: 0 }, cfg, x, policy);
  assert.equal(first.decision.action, "claim");
  const again = decideExit({ pnlPct: 2, side: "in", uncollectedFeeSol: 0.02 }, pool(), first.track, cfg, x, policy);
  assert.notEqual(again.decision.reason.startsWith("review"), true);
});

test("Lab: tiap strategi punya portofolio sendiri dan dibandingkan dengan data pasar yang sama", async () => {
  const c = loadConfig("config/strategy.yaml");
  c.intervals.screen_min = 0;
  c.lab!.audits_per_screen = 20;
  const prices: Record<string, number> = { A: 1e-4, B: 1e-4, C: 1e-4, H: 1e-4 };
  const sum = (p: string, o: any = {}) => ({
    pool: p, symbol: p, tokenMint: p + "M", quoteMint: SOL, protocol: "meteora", tvl: 80_000, fee24h: 6_000, fee6h: 1_500, fee1h: 250,
    vol24h: 400_000, mcap: 3_000_000, binStep: 100, organicScore: 80, firstPoolCreatedAt: "2026-10-01T00:00:00Z",
    priceChange1h: 1, priceChange6h: 2, priceChange24h: 5, ...o,
  });
  const api: any = {
    discover: async () => [sum("H", { fee24h: 16_000, fee6h: 4_500, priceChange24h: 60 }), sum("A"), sum("B"), sum("C")],
    poolDetail: async (p: string) => pool({ pool: p, symbol: p, priceInSol: prices[p], fee24h: p === "H" ? 16_000 : 6_000 }),
  };
  const store = new Store(mkdtempSync(tmpdir() + "/lab-"));
  const lab = new Lab(c, api, store, new Notifier());
  let t = Date.parse("2026-11-09T06:00:00Z"); // 13:00 WIB
  for (let i = 0; i < 4; i++) await lab.tick((t += 10 * 60_000));

  const st = store.state.lab!;
  // Careless hanya ambil token ranging (A, B, C), EvilPanda ambil token fee tinggi (H)
  assert.deepEqual(Object.values(st.careless.positions).map((p) => p.pool).sort(), ["A", "B", "C"]);
  assert.deepEqual(Object.values(st.evilpanda.positions).map((p) => p.pool), ["H"]);
  assert.equal(Object.values(st.careless_bidask.positions)[0].shape, "BidAsk");
  assert.equal(Object.values(st.careless_50.positions)[0].depthPct, 50);

  // Harga A turun 40%, semua jalan 6 jam: Spot -80% menahan, Bid-Ask -30% tidak ikut (bukan pool H)
  prices.A *= 0.6;
  for (let i = 0; i < 36; i++) await lab.tick((t += 10 * 60_000));
  const m = Object.fromEntries(Object.keys(st).map((k) => [k, metrics(k, st[k], t)]));
  for (const k of Object.keys(m)) assert.ok(Number.isFinite(m[k].equity), k);
  assert.ok(m.careless.feesSol > 0, "careless dapat fee");
  assert.ok(m.careless.equity < 1.5, "careless kena IL dari A");
  assert.ok(m.careless_50.equity < m.careless.equity, "range -50% rugi lebih dalam saat turun 40%");

  const text = lab.compareText(t);
  assert.match(text, /PAPER TEST/);
  assert.match(text, /careless_bidask/);
});
