import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { Lab, deepMerge, metrics } from "../src/lab.js";
import { Store } from "../src/state.js";
import { Notifier } from "../src/notify.js";
import { normalizeDiscovery, type Market } from "../src/sources.js";

const SOL = "So11111111111111111111111111111111111111112";

/** Pasar tiruan: pool A/B/C tenang (Careless), H fee tinggi + volatil (EvilPanda). */
function fakeMarket() {
  const price: Record<string, number> = { A: 1e-4, B: 1e-4, C: 1e-4, H: 1e-4 };
  const fee24: Record<string, number> = { A: 6_000, B: 6_000, C: 6_000, H: 16_000 };
  const change24: Record<string, number> = { A: 5, B: 5, C: 5, H: 60 };
  const calls = { row: 0, token: 0, scan: 0 };
  const row = (p: string, tf: string) => ({
    pool_address: p, pool_type: "dlmm", name: `${p}-SOL`, tvl: 80_000, active_tvl: 30_000,
    fee: tf === "5m" ? fee24[p] / 288 : tf === "4h" ? fee24[p] / 6 : fee24[p],
    volume: 400_000, pool_price: price[p], dlmm_params: { bin_step: 100 }, is_blacklisted: false,
    token_x: { address: `${p}M`, warnings: [] }, token_y: { address: SOL, warnings: [] },
  });
  const market: Market = {
    async scan() {
      calls.scan++;
      return Object.keys(price).map((p) => normalizeDiscovery(row(p, "24h")));
    },
    async poolRow(p, tf) {
      calls.row++;
      return row(p, tf);
    },
    async token(mint) {
      calls.token++;
      const p = mint.replace(/M$/, "");
      return {
        id: mint, symbol: p, launchpad: "pump.fun", holderCount: 5000, organicScore: 80, mcap: 3_000_000, createdAt: "2026-10-01T00:00:00Z",
        audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18, devBalancePercentage: 1, devMints: 1 },
        stats5m: { priceChange: 0, liquidityChange: 0, holderChange: 0, buyVolume: 1, sellVolume: 1 },
        stats1h: { priceChange: 1, liquidityChange: 0, holderChange: 0, buyVolume: 1, sellVolume: 1 },
        stats24h: { priceChange: change24[p], liquidityChange: 0, holderChange: 0, buyVolume: 1, sellVolume: 1 },
      };
    },
  };
  return { market, price, calls };
}

function setup() {
  const cfg = loadConfig("config/strategy.yaml");
  cfg.intervals.screen_min = 0;
  cfg.lab.audits_per_screen = 20;
  const f = fakeMarket();
  const store = new Store(mkdtempSync(tmpdir() + "/lab-"));
  const lab = new Lab(cfg, f.market, store, new Notifier());
  return { cfg, lab, store, ...f };
}

test("deepMerge: override eksperimen tidak mengubah config asli", () => {
  const cfg = loadConfig("config/strategy.yaml");
  const merged = deepMerge(cfg.tracks.careless, { position: { strategy: "BidAsk" } });
  assert.equal(merged.position.strategy, "BidAsk");
  assert.equal(merged.position.range_below_pct, 80);
  assert.equal(cfg.tracks.careless.position.strategy, "Spot");
});

test("Lab: tiap strategi dapat token yang sesuai jalurnya, data pasar dipakai bersama", async () => {
  const { lab, store, calls } = setup();
  let t = Date.parse("2026-11-09T06:00:00Z"); // 13:00 WIB
  for (let i = 0; i < 4; i++) await lab.tick((t += 10 * 60_000));
  const st = store.state.lab;
  assert.deepEqual(Object.values(st.careless.positions).map((p) => p.pool).sort(), ["A", "B", "C"]);
  assert.deepEqual(Object.values(st.evilpanda.positions).map((p) => p.pool), ["H"]);
  assert.equal(Object.values(st.careless_bidask.positions)[0].shape, "BidAsk");
  assert.equal(Object.values(st.careless_50.positions)[0].depthPct, 50);
  assert.equal(Object.values(st.careless.positions)[0].binsBelow, 162);
  // 4 siklus, 4 eksperimen, 4 pool: jauh lebih sedikit panggilan dari 4 x 4 x 4 x 3 berkat cache bersama
  assert.ok(calls.token < 40, `panggilan token: ${calls.token}`);
});

test("Lab: harga hilang sesaat tidak menutup posisi (bug -100% lama)", async () => {
  const { lab, store, price } = setup();
  let t = Date.parse("2026-11-09T06:00:00Z");
  await lab.tick((t += 600_000));
  const posA = () => Object.values(store.state.lab.careless.positions).find((p) => p.pool === "A");
  assert.ok(posA(), "posisi A terbuka");
  const pnlBefore = posA()!.lastPnl;
  price.A = NaN;
  await lab.tick((t += 90_000));
  assert.ok(posA(), "posisi A tetap terbuka");
  assert.equal(posA()!.lastPnl, pnlBefore, "PnL tidak diubah oleh data kosong");
  assert.equal(store.state.lab.careless.closed.length, 0);
});

test("Lab: dump -40% → Spot -80% menahan, range -50% rugi lebih dalam; biaya tx tercatat", async () => {
  const { lab, store, price } = setup();
  let t = Date.parse("2026-11-09T06:00:00Z");
  for (let i = 0; i < 4; i++) await lab.tick((t += 600_000));
  price.A *= 0.6;
  for (let i = 0; i < 24; i++) await lab.tick((t += 600_000));
  const m = (k: string) => metrics(k, store.state.lab[k], t);
  assert.ok(m("careless").feesSol > 0, "careless dapat fee");
  assert.ok(m("careless").equity < 1.5, "careless kena IL dari A");
  // PnL posisi A per eksperimen (masih terbuka, atau dari catatan tutup kalau sudah kena SL)
  const pnlA = (k: string) =>
    Object.values(store.state.lab[k].positions).find((p) => p.pool === "A")?.lastPnl ??
    store.state.lab[k].closed.find((c) => c.pool === "A")!.pnlPct;
  assert.ok(pnlA("careless") > -15, `Spot -80% di harga -40%: ${pnlA("careless")}`);
  assert.ok(pnlA("careless_50") < pnlA("careless"), "range -50% rugi lebih dalam");

  // Harga A turun jauh di bawah range Careless → OOR kiri → ditutup dengan biaya
  price.A = 1e-5;
  for (let i = 0; i < 5; i++) await lab.tick((t += 600_000));
  const closedA = store.state.lab.careless.closed.find((c) => c.pool === "A");
  assert.ok(closedA, "posisi A ditutup");
  assert.ok(closedA!.pnlPct < -15);
  assert.match(lab.compareText(t), /PAPER TEST/);
});

test("Lab: bot mati 10 jam tidak menghasilkan fee fiktif", async () => {
  const { lab, store } = setup();
  let t = Date.parse("2026-11-09T06:00:00Z");
  await lab.tick((t += 600_000));
  await lab.tick((t += 90_000));
  const f1 = Object.values(store.state.lab.careless.positions)[0].feeSol;
  await lab.tick((t += 90_000));
  const perTick = Object.values(store.state.lab.careless.positions)[0].feeSol - f1;
  const f2 = Object.values(store.state.lab.careless.positions)[0].feeSol;
  await lab.tick((t += 10 * 3_600_000));
  const afterGap = Object.values(store.state.lab.careless.positions)[0].feeSol - f2;
  assert.ok(afterGap <= perTick * 11, `fee setelah 10 jam mati: ${afterGap} vs per siklus ${perTick}`);
});
