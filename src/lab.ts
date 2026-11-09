import type { Config, LabExperiment, ScanCfg, TrackCfg } from "./config.js";
import type { Market } from "./sources.js";
import { buildDetail } from "./sources.js";
import type { Notifier } from "./notify.js";
import type { ClosedRecord, ExpState, PaperPosition, Store } from "./state.js";
import type { PoolDetail, PoolSummary } from "./types.js";
import { auditDetail, binsForRange, feeRecentAs24hPct, feeTvl24hPct, screenPool } from "./rules/entry.js";
import { decideExit } from "./rules/exit.js";
import { rugCheck } from "./rules/rug.js";
import { consecutiveStopOuts, dateWIB, isStopOut } from "./rules/risk.js";
import { buildBins, closeProceeds, feeForInterval, liquidityNearPrice, sideOf, valueAt } from "./paper.js";
import { fmt, hourWIB, log, minutesSince } from "./util.js";

/** Gabung objek secara rekursif (untuk override config eksperimen). */
export function deepMerge<T>(base: T, over?: Record<string, unknown>): T {
  const out: any = structuredClone(base);
  if (!over) return out;
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" ? deepMerge(out[k], v as any) : v;
  }
  return out;
}

export interface ExpMetrics {
  name: string;
  equity: number;
  returnPct: number;
  realizedSol: number;
  feesSol: number;
  closed: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  stopOuts: number;
  open: number;
  maxDrawdownPct: number;
  hours: number;
}

/** Metrik pembanding satu eksperimen. Murni. */
export function metrics(name: string, e: ExpState, nowMs = Date.now()): ExpMetrics {
  const open = Object.values(e.positions);
  const equity = e.cash + open.reduce((s, p) => s + p.lastValueSol + p.feeSol, 0);
  const wins = e.closed.filter((c) => c.pnlSol > 0);
  const losses = e.closed.filter((c) => c.pnlSol <= 0);
  const avg = (xs: ClosedRecord[]) => (xs.length ? xs.reduce((s, c) => s + c.pnlPct, 0) / xs.length : 0);
  return {
    name,
    equity,
    returnPct: ((equity - e.capital) / e.capital) * 100,
    realizedSol: e.closed.reduce((s, c) => s + c.pnlSol, 0),
    feesSol: e.closed.reduce((s, c) => s + c.feeSol, 0) + open.reduce((s, p) => s + p.feeSol, 0),
    closed: e.closed.length,
    winRate: e.closed.length ? (wins.length / e.closed.length) * 100 : 0,
    avgWinPct: avg(wins),
    avgLossPct: avg(losses),
    stopOuts: e.closed.filter(isStopOut).length,
    open: open.length,
    maxDrawdownPct: e.maxDrawdownPct,
    hours: (nowMs - Date.parse(e.startedAt)) / 3_600_000,
  };
}

interface Row24 {
  row: any;
  at: number;
}

/**
 * Lab: beberapa strategi dijalankan paralel dalam paper test, masing-masing dengan modal virtual
 * sendiri. Data pasar (Meteora + Jupiter) dan hasil audit dipakai bersama supaya hemat panggilan.
 */
export class Lab {
  private lastScreenAt = 0;
  private cache = new Map<string, PoolDetail>(); // per siklus
  private row24 = new Map<string, Row24>(); // baris 24 jam, disegarkan berkala

  constructor(
    private cfg: Config,
    private market: Market,
    private store: Store,
    private notifier: Notifier,
  ) {
    for (const x of this.cfg.lab.experiments) {
      this.store.state.lab[x.name] ??= {
        cash: this.cfg.lab.capital_sol,
        capital: this.cfg.lab.capital_sol,
        startedAt: new Date().toISOString(),
        positions: {},
        closed: [],
        peakEquity: this.cfg.lab.capital_sol,
        maxDrawdownPct: 0,
      };
    }
  }

  private get exps(): LabExperiment[] {
    return this.cfg.lab.experiments;
  }
  private state(name: string): ExpState {
    return this.store.state.lab[name];
  }
  trackCfg(x: LabExperiment): TrackCfg {
    return deepMerge(this.cfg.tracks[x.track], x.overrides);
  }

  /** Data lengkap pool + token. `withRecent` juga mengambil fee 4 jam (untuk screening). */
  private async detail(pool: string, mint: string, nowMs: number, withRecent = false): Promise<PoolDetail> {
    const key = `${pool}:${withRecent ? 1 : 0}`;
    const hit = this.cache.get(key) ?? (withRecent ? undefined : this.cache.get(`${pool}:1`));
    if (hit) return hit;
    const row5m = await this.market.poolRow(pool, "5m");
    let r24 = this.row24.get(pool);
    if (!r24 || nowMs - r24.at > this.cfg.paper.pool24h_refresh_min * 60_000) {
      r24 = { row: await this.market.poolRow(pool, "24h"), at: nowMs };
      this.row24.set(pool, r24);
    }
    const token = await this.market.token(mint);
    let recent = NaN;
    if (withRecent) {
      const row4h = await this.market.poolRow(pool, "4h").catch(() => null);
      recent = feeRecentAs24hPct(Number(row4h?.fee), Number(row4h?.tvl ?? r24.row?.tvl));
    }
    const d = buildDetail(row5m, r24.row, token, recent);
    this.cache.set(key, d);
    return d;
  }

  async tick(nowMs = Date.now()): Promise<void> {
    this.cache.clear();
    for (const x of this.exps) await this.manage(x, nowMs);
    if (nowMs - this.lastScreenAt >= this.cfg.intervals.screen_min * 60_000) {
      this.lastScreenAt = nowMs;
      if (!this.store.state.manualPause) await this.screen(nowMs);
    }
    for (const x of this.exps) this.updateDrawdown(x.name, nowMs);
    await this.maybeReport(nowMs);
  }

  /* ---------- kelola posisi virtual ---------- */

  private async manage(x: LabExperiment, nowMs: number): Promise<void> {
    const e = this.state(x.name);
    const tc = this.trackCfg(x);
    const pc = this.cfg.paper;
    for (const pp of Object.values(e.positions)) {
      let d: PoolDetail;
      try {
        d = await this.detail(pp.pool, pp.tokenMint, nowMs);
      } catch (err: any) {
        log(`[${x.name}] ${pp.symbol}: data tidak tersedia (${err.message}), dilewati`);
        continue;
      }
      // Harga hilang sesaat: jangan update, jangan tutup (data kosong ≠ harga nol).
      if (!(d.priceInSol > 0)) {
        log(`[${x.name}] ${pp.symbol}: harga tidak tersedia, dilewati`);
        continue;
      }
      const bins = buildBins(pp.amountSol, pp.entryPrice, pp.binStep, pp.binsBelow, pp.shape);
      const price = d.priceInSol;
      const side = sideOf(bins, pp.binStep, price);
      const near = side === "in" ? liquidityNearPrice(bins, pp.binStep, price, pc.near_span_bins) : 0;
      pp.feeSol += feeForInterval(d.fee5m, d.activeTvl, near, minutesSince(pp.lastUpdate, nowMs), pc.max_fee_minutes);
      const valueSol = valueAt(bins, price).value;
      const pnlPct = ((valueSol + pp.feeSol) / pp.amountSol - 1) * 100;
      const { decision, track } = decideExit(
        { pnlPct, side, uncollectedFeeSol: 0 },
        d,
        pp,
        this.cfg,
        tc.exit,
        { claimHourWib: -1, hourNowWib: hourWIB(new Date(nowMs)), dateWib: dateWIB(new Date(nowMs)), review: tc.morning_review },
        nowMs,
      );
      Object.assign(pp, track, { lastUpdate: new Date(nowMs).toISOString(), lastPrice: price, lastPnl: pnlPct, lastValueSol: valueSol });
      if (decision.action !== "close") continue;

      // Tutup: nilai + fee − slippage jual token − biaya transaksi kembali ke kas virtual.
      const proceeds = closeProceeds(bins, price, pp.feeSol, pc.close_slippage_pct, pc.tx_cost_sol);
      e.cash += proceeds;
      const pnlSol = proceeds - pp.amountSol;
      const rec: ClosedRecord = {
        id: pp.id,
        strat: pp.strat,
        pool: pp.pool,
        pair: `${pp.symbol}/SOL`,
        pnlPct: (pnlSol / pp.amountSol) * 100,
        pnlSol,
        reason: decision.reason,
        closedAt: new Date(nowMs).toISOString(),
        feeSol: pp.feeSol,
        heldMin: Math.round(minutesSince(pp.openedAt, nowMs)),
        priceMovePct: (price / pp.entryPrice - 1) * 100,
      };
      e.closed.push(rec);
      delete e.positions[pp.id];
      this.store.journal({ type: "lab_close", exp: x.name, ...rec });
      log(`[${x.name}] TUTUP ${pp.symbol} ${fmt(rec.pnlPct, 1)}% — ${decision.reason}`);
      if (isStopOut(rec) && consecutiveStopOuts(e.closed) >= this.cfg.risk.pause_after_consecutive_sl)
        e.pausedUntil = new Date(nowMs + this.cfg.risk.pause_hours * 3_600_000).toISOString();
    }
  }

  /* ---------- screening bersama ---------- */

  private async screen(nowMs: number): Promise<void> {
    const ready = this.exps.filter((x) => this.canOpen(x, nowMs));
    if (ready.length === 0) return;

    // Satu scan per konfigurasi scan yang berbeda (eksperimen sejalur memakai hasil yang sama).
    const scans = new Map<string, PoolSummary[]>();
    const scanFor = async (sc: ScanCfg, minMcap: number): Promise<PoolSummary[]> => {
      const key = JSON.stringify([sc, minMcap]);
      let rows = scans.get(key);
      if (!rows) {
        rows = await this.market
          .scan({ minMcap, minVolume: sc.min_volume_usd, pageSize: sc.page_size, category: sc.category || undefined })
          .catch((err) => {
            log(`Scan gagal: ${err.message}`);
            return [] as PoolSummary[];
          });
        log(`Scan (${sc.category || "semua"}, mcap>=${minMcap}): ${rows.length} pool token/SOL`);
        scans.set(key, rows);
      }
      return rows;
    };

    const audited = new Map<string, PoolDetail>();
    let auditsLeft = this.cfg.lab.audits_per_screen;

    for (const x of ready) {
      const e = this.state(x.name);
      const tc = this.trackCfg(x);
      const busyPools = new Set(Object.values(e.positions).map((p) => p.pool));
      const busyMints = new Set(Object.values(e.positions).map((p) => p.tokenMint));
      const cooldown = new Set(
        e.closed.filter((c) => minutesSince(c.closedAt, nowMs) < this.cfg.risk.reentry_cooldown_hours * 60).map((c) => c.pool),
      );
      const rows = await scanFor(tc.scan, this.cfg.whitelist_mints.length ? 0 : tc.entry.mcap_min_usd);
      const candidates = rows
        .filter((p) => !busyPools.has(p.pool) && !busyMints.has(p.tokenMint) && !cooldown.has(p.pool))
        .filter((p) => screenPool(p, tc.entry).pass)
        .sort((a, b) => feeTvl24hPct(b.fee24h, b.tvl) - feeTvl24hPct(a.fee24h, a.tvl));

      for (const s of candidates) {
        let d = audited.get(s.pool);
        if (!d) {
          if (auditsLeft <= 0) break;
          auditsLeft--;
          try {
            d = await this.detail(s.pool, s.tokenMint, nowMs, true);
          } catch (err: any) {
            log(`Audit ${s.symbol} gagal: ${err.message}`);
            continue;
          }
          audited.set(s.pool, d);
        }
        const wl = this.cfg.whitelist_mints.includes(s.tokenMint);
        const audit = auditDetail(d, this.cfg, tc, wl, nowMs);
        const rug = rugCheck(d, this.cfg);
        const reasons = [...audit.reasons, ...rug.hard, ...rug.soft];
        this.store.journal({ type: "lab_audit", exp: x.name, pool: s.pool, symbol: d.symbol, pass: audit.pass && !rug.trigger, reasons });
        if (audit.pass && !rug.trigger) {
          this.open(x, tc, s, d, nowMs);
          break;
        }
      }
    }
  }

  private canOpen(x: LabExperiment, nowMs: number): boolean {
    const e = this.state(x.name);
    const tc = this.trackCfg(x);
    if (e.pausedUntil && Date.parse(e.pausedUntil) > nowMs) return false;
    if (Object.keys(e.positions).length >= tc.max_positions) return false;
    const today = dateWIB(new Date(nowMs));
    if (e.day?.date !== today) e.day = { date: today, startEquitySol: metrics(x.name, e, nowMs).equity };
    const dayPnl = e.closed.filter((c) => dateWIB(new Date(c.closedAt)) === today).reduce((s, c) => s + c.pnlSol, 0);
    if ((dayPnl / e.day.startEquitySol) * 100 <= -this.cfg.risk.daily_loss_stop_pct) return false;
    return this.sizeFor(tc, e) > 0;
  }

  private sizeFor(tc: TrackCfg, e: ExpState): number {
    const amount = Math.min(tc.per_position_sol, (e.cash * tc.per_position_max_pct_balance) / 100, e.cash - this.cfg.sizing.min_buffer_sol);
    return amount >= 0.05 ? Math.floor(amount * 1000) / 1000 : 0;
  }

  private open(x: LabExperiment, tc: TrackCfg, s: PoolSummary, d: PoolDetail, nowMs: number): void {
    const e = this.state(x.name);
    const amount = this.sizeFor(tc, e);
    if (!(amount > 0) || !(d.priceInSol > 0) || !(d.binStep > 0)) return;
    const now = new Date(nowMs).toISOString();
    const pp: PaperPosition = {
      id: `${x.name}-${nowMs.toString(36)}-${s.pool.slice(0, 4)}`,
      strat: x.track,
      shape: tc.position.strategy,
      pool: s.pool,
      symbol: d.symbol,
      tokenMint: s.tokenMint,
      openedAt: now,
      lastUpdate: now,
      entryPrice: d.priceInSol,
      binStep: d.binStep,
      binsBelow: binsForRange(tc.position.range_below_pct, d.binStep),
      depthPct: tc.position.range_below_pct,
      amountSol: amount,
      feeSol: 0,
      lastPrice: d.priceInSol,
      lastPnl: 0,
      lastValueSol: amount,
      peakPnl: -1e9,
    };
    e.cash -= amount;
    e.positions[pp.id] = pp;
    this.store.journal({
      type: "lab_open",
      exp: x.name,
      pool: s.pool,
      symbol: d.symbol,
      amount,
      shape: pp.shape,
      depth: pp.depthPct,
      bins: pp.binsBelow,
      feeTvl24h: feeTvl24hPct(d.fee24h, d.tvl),
      feeRecent: d.feeRecentAs24hPct,
    });
    log(`[${x.name}] BUKA ${d.symbol} ${amount} SOL ${pp.shape} -${pp.depthPct}% (${pp.binsBelow} bin)`);
  }

  /* ---------- metrik & laporan ---------- */

  private updateDrawdown(name: string, nowMs: number): void {
    const e = this.state(name);
    const eq = metrics(name, e, nowMs).equity;
    e.peakEquity = Math.max(e.peakEquity, eq);
    e.maxDrawdownPct = Math.max(e.maxDrawdownPct, ((e.peakEquity - eq) / e.peakEquity) * 100);
  }

  compareText(nowMs = Date.now()): string {
    const rows = this.exps.map((x) => metrics(x.name, this.state(x.name), nowMs)).sort((a, b) => b.returnPct - a.returnPct);
    const lines = [`🧪 PAPER TEST — ${fmt(rows[0]?.hours ?? 0, 0)} jam, modal ${this.cfg.lab.capital_sol} SOL/strategi`];
    if (this.store.state.manualPause) lines.push("⏸️ dijeda: tidak buka posisi baru");
    rows.forEach((m, i) => {
      lines.push(
        `${i + 1}. ${m.name}: ${m.returnPct >= 0 ? "+" : ""}${fmt(m.returnPct, 2)}% (${fmt(m.equity, 3)} SOL)`,
        `   fee ${fmt(m.feesSol, 4)} | tutup ${m.closed} (win ${fmt(m.winRate, 0)}%, SL/rug ${m.stopOuts}) | buka ${m.open} | DD ${fmt(m.maxDrawdownPct, 1)}%`,
      );
    });
    lines.push("Angka = model paper (estimasi), bukan hasil on-chain.");
    return lines.join("\n");
  }

  positionsText(): string {
    const lines: string[] = [];
    for (const x of this.exps)
      for (const p of Object.values(this.state(x.name).positions))
        lines.push(`[${x.name}] ${p.symbol} ${fmt(p.lastPnl, 1)}% | fee ${fmt(p.feeSol, 4)} | harga ${fmt((p.lastPrice / p.entryPrice - 1) * 100, 1)}%`);
    return lines.length ? lines.join("\n") : "Belum ada posisi paper terbuka.";
  }

  private async maybeReport(nowMs: number): Promise<void> {
    const today = dateWIB(new Date(nowMs));
    if (hourWIB(new Date(nowMs)) !== this.cfg.lab.report_hour_wib || this.store.state.labLastReportDate === today) return;
    this.store.state.labLastReportDate = today;
    const text = this.compareText(nowMs);
    this.store.journal({ type: "lab_report", text });
    await this.notifier.send(text);
  }
}
