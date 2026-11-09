import type { Config, LabExperiment, TrackCfg } from "./config.js";
import type { LpAgentApi, PoolDetail, PoolSummary } from "./api.js";
import type { Notifier } from "./notify.js";
import type { ClosedRecord, ExpState, PaperPosition, Store } from "./state.js";
import { auditDetail, feeTvl24hPct, screenSummary, type Verdict } from "./rules/entry.js";
import { decideExit, type RangeSide } from "./rules/exit.js";
import { rugCheck } from "./rules/rug.js";
import { dateWIB, isStopOut } from "./rules/risk.js";
import { feeMultiplier, paperFeeSol, valueRatio } from "./paper.js";
import { fmt, hourWIB, log, minutesSince } from "./util.js";

/** Gabung objek secara rekursif (untuk override config eksperimen). */
export function deepMerge<T>(base: T, over?: Record<string, unknown>): T {
  if (!over) return structuredClone(base);
  const out: any = structuredClone(base);
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
  unrealizedSol: number;
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

/** Hitung metrik pembanding satu eksperimen. Murni. */
export function metrics(name: string, e: ExpState, nowMs = Date.now()): ExpMetrics {
  const open = Object.values(e.positions);
  const openValue = open.reduce((s, p) => s + (p.lastValueSol ?? p.amountSol) + p.feeSol, 0);
  const equity = e.cash + openValue;
  const unrealizedSol = open.reduce((s, p) => s + (p.lastValueSol ?? p.amountSol) + p.feeSol - p.amountSol, 0);
  const wins = e.closed.filter((c) => c.pnlSol > 0);
  const losses = e.closed.filter((c) => c.pnlSol <= 0);
  const avg = (xs: ClosedRecord[]) => (xs.length ? xs.reduce((s, c) => s + c.pnlPct, 0) / xs.length : 0);
  return {
    name,
    equity,
    returnPct: ((equity - e.capital) / e.capital) * 100,
    realizedSol: e.closed.reduce((s, c) => s + c.pnlSol, 0),
    unrealizedSol,
    feesSol: e.closed.reduce((s, c) => s + (c.feeSol ?? 0), 0) + open.reduce((s, p) => s + p.feeSol, 0),
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

/**
 * Lab: beberapa strategi dijalankan paralel dalam mode paper, tiap strategi dengan
 * modal virtual sendiri. Data pasar dan hasil audit dipakai bersama supaya hemat API.
 */
export class Lab {
  private lastScreenAt = 0;
  private details = new Map<string, PoolDetail>();

  constructor(
    private cfg: Config,
    private api: LpAgentApi,
    private store: Store,
    private notifier: Notifier,
  ) {
    const lab = this.cfg.lab!;
    this.store.state.lab ??= {};
    for (const x of lab.experiments) {
      this.store.state.lab[x.name] ??= {
        cash: lab.capital_sol,
        capital: lab.capital_sol,
        startedAt: new Date().toISOString(),
        positions: {},
        closed: [],
        peakEquity: lab.capital_sol,
        maxDrawdownPct: 0,
      };
    }
  }

  private get exps(): LabExperiment[] {
    return this.cfg.lab!.experiments;
  }
  private state(name: string): ExpState {
    return this.store.state.lab![name];
  }
  trackCfg(x: LabExperiment): TrackCfg {
    return deepMerge(this.cfg.tracks[x.track], x.overrides);
  }

  /** Detail pool dengan cache per siklus. */
  private async detail(pool: string): Promise<PoolDetail> {
    let d = this.details.get(pool);
    if (!d) {
      d = await this.api.poolDetail(pool);
      this.details.set(pool, d);
    }
    return d;
  }

  async tick(nowMs = Date.now()): Promise<void> {
    this.details.clear();
    for (const x of this.exps) await this.manage(x, nowMs);
    if (nowMs - this.lastScreenAt >= this.cfg.intervals.screen_min * 60_000) {
      this.lastScreenAt = nowMs;
      await this.screen(nowMs);
    }
    for (const x of this.exps) this.updateDrawdown(x.name);
    await this.maybeReport(nowMs);
  }

  /* ---------- kelola posisi virtual ---------- */

  private async manage(x: LabExperiment, nowMs: number): Promise<void> {
    const e = this.state(x.name);
    const tc = this.trackCfg(x);
    for (const pp of Object.values(e.positions)) {
      try {
        const d = await this.detail(pp.pool);
        const ratio = d.priceInSol / pp.entryPrice;
        const side: RangeSide = !(ratio > 0) ? "unknown" : ratio > 1 ? "above" : ratio < 1 - pp.depthPct / 100 ? "below" : "in";
        const minutes = minutesSince(pp.lastUpdate, nowMs);
        const mult = feeMultiplier(ratio, pp.depthPct, pp.shape, this.cfg.paper.fee_ref_depth_pct ?? 30);
        pp.feeSol += paperFeeSol(pp.amountSol, d.fee24h, d.tvl, minutes, this.cfg.paper.fee_capture_factor, mult);
        const valueSol = pp.amountSol * valueRatio(ratio, pp.depthPct, pp.shape);
        const pnlSol = valueSol + pp.feeSol - pp.amountSol;
        const pnlPct = (pnlSol / pp.amountSol) * 100;
        const { decision, track } = decideExit(
          { pnlPct, side, uncollectedFeeSol: 0 },
          d,
          pp,
          this.cfg,
          tc.exit,
          {
            claimHourWib: -1,
            hourNowWib: hourWIB(new Date(nowMs)),
            dateWib: dateWIB(new Date(nowMs)),
            review: tc.morning_review,
          },
          nowMs,
        );
        Object.assign(pp, track, { lastUpdate: new Date(nowMs).toISOString(), lastPnl: pnlPct, lastValueSol: valueSol });
        if (decision.action !== "close") continue;

        // Tutup: nilai + fee kembali ke kas virtual.
        e.cash += valueSol + pp.feeSol;
        const rec: ClosedRecord = {
          id: pp.id,
          strat: pp.strat,
          pool: pp.pool,
          pair: `${pp.symbol}/SOL`,
          pnlPct,
          pnlSol,
          reason: decision.reason,
          closedAt: new Date(nowMs).toISOString(),
          paper: true,
          feeSol: pp.feeSol,
          heldMin: minutesSince(pp.openedAt, nowMs),
        };
        e.closed.push(rec);
        delete e.positions[pp.id];
        this.store.journal({ type: "lab_close", exp: x.name, ...rec });
        log(`[LAB ${x.name}] TUTUP ${pp.symbol} ${fmt(pnlPct, 1)}% — ${decision.reason}`);
        if (isStopOut(rec) && this.countRecentStopOuts(e) >= this.cfg.risk.pause_after_consecutive_sl)
          e.pausedUntil = new Date(nowMs + this.cfg.risk.pause_hours * 3_600_000).toISOString();
      } catch (err: any) {
        log(`[LAB ${x.name}] gagal update ${pp.symbol}: ${err.message}`);
      }
    }
  }

  private countRecentStopOuts(e: ExpState): number {
    let n = 0;
    for (let i = e.closed.length - 1; i >= 0; i--) {
      if (isStopOut(e.closed[i])) n++;
      else if (e.closed[i].pnlPct >= 0) break;
    }
    return n;
  }

  /* ---------- screening bersama ---------- */

  private async screen(nowMs: number): Promise<void> {
    const ready = this.exps.filter((x) => this.canOpen(x, nowMs));
    if (ready.length === 0) return;

    const pools = await this.api.discover();
    const audits = new Map<string, { v: Verdict; d: PoolDetail; rug: boolean }>();
    let auditsLeft = this.cfg.lab!.audits_per_screen;

    for (const x of ready) {
      const e = this.state(x.name);
      const tc = this.trackCfg(x);
      const busy = new Set(Object.values(e.positions).map((p) => p.pool));
      const recentlyClosed = new Set(
        e.closed
          .filter((c) => minutesSince(c.closedAt, nowMs) < this.cfg.risk.reentry_cooldown_hours * 60)
          .map((c) => c.pool),
      );
      const candidates = pools
        .filter((p) => !busy.has(p.pool) && !recentlyClosed.has(p.pool))
        .filter((p) => screenSummary(p, tc.entry, nowMs, this.cfg.whitelist_mints.includes(p.tokenMint)).pass)
        .sort((a, b) => feeTvl24hPct(b.fee24h, b.tvl) - feeTvl24hPct(a.fee24h, a.tvl));

      for (const s of candidates) {
        let a = audits.get(s.pool);
        if (!a) {
          if (auditsLeft <= 0) break;
          auditsLeft--;
          const d = await this.detail(s.pool);
          a = { v: auditDetail(d, this.cfg, tc, this.cfg.whitelist_mints.includes(s.tokenMint)), d, rug: rugCheck(d, this.cfg).trigger };
          audits.set(s.pool, a);
        } else {
          // Audit dipakai bersama, tapi syarat jalur (launchpad, max_bins) dicek ulang per eksperimen.
          a = { ...a, v: auditDetail(a.d, this.cfg, tc, this.cfg.whitelist_mints.includes(s.tokenMint)) };
        }
        if (a.v.pass && !a.rug) {
          this.open(x, tc, s, a.d, nowMs);
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
    const equity = metrics(x.name, e, nowMs).equity;
    if (e.day?.date !== today) e.day = { date: today, startEquitySol: equity };
    const dayPnl = e.closed
      .filter((c) => dateWIB(new Date(c.closedAt)) === today)
      .reduce((s, c) => s + c.pnlSol, 0);
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
    if (!(amount > 0) || !(d.priceInSol > 0)) return;
    const now = new Date(nowMs).toISOString();
    const pp: PaperPosition = {
      id: `${x.name}-${nowMs.toString(36)}-${s.pool.slice(0, 4)}`,
      strat: x.track,
      shape: tc.position.strategy,
      pool: s.pool,
      symbol: s.symbol,
      tokenMint: s.tokenMint,
      openedAt: now,
      lastUpdate: now,
      entryPrice: d.priceInSol,
      depthPct: tc.position.range_below_pct,
      amountSol: amount,
      feeSol: 0,
      lastPnl: 0,
      lastValueSol: amount,
      peakPnl: -1e9,
    };
    e.cash -= amount;
    e.positions[pp.id] = pp;
    this.store.journal({ type: "lab_open", exp: x.name, pool: s.pool, symbol: s.symbol, amount, shape: pp.shape, depth: pp.depthPct, feeTvl24h: feeTvl24hPct(s.fee24h, s.tvl) });
    log(`[LAB ${x.name}] BUKA ${s.symbol} ${amount} SOL ${pp.shape} -${pp.depthPct}%`);
  }

  /* ---------- metrik & laporan ---------- */

  private updateDrawdown(name: string): void {
    const e = this.state(name);
    const eq = metrics(name, e).equity;
    e.peakEquity = Math.max(e.peakEquity, eq);
    const dd = ((e.peakEquity - eq) / e.peakEquity) * 100;
    e.maxDrawdownPct = Math.max(e.maxDrawdownPct, dd);
  }

  compareText(nowMs = Date.now()): string {
    const rows = this.exps.map((x) => metrics(x.name, this.state(x.name), nowMs)).sort((a, b) => b.returnPct - a.returnPct);
    const hours = rows[0]?.hours ?? 0;
    const lines = [`🧪 PAPER TEST — ${fmt(hours, 0)} jam berjalan, modal ${this.cfg.lab!.capital_sol} SOL/strategi`];
    rows.forEach((m, i) => {
      lines.push(
        `${i + 1}. ${m.name}: ${m.returnPct >= 0 ? "+" : ""}${fmt(m.returnPct, 2)}% (${fmt(m.equity, 3)} SOL)`,
        `   fee ${fmt(m.feesSol, 4)} | tutup ${m.closed} (win ${fmt(m.winRate, 0)}%, SL/rug ${m.stopOuts}) | buka ${m.open} | DD ${fmt(m.maxDrawdownPct, 1)}%`,
      );
    });
    lines.push("Fee = estimasi model paper, bukan angka on-chain.");
    return lines.join("\n");
  }

  private async maybeReport(nowMs: number): Promise<void> {
    const today = dateWIB(new Date(nowMs));
    if (hourWIB(new Date(nowMs)) !== this.cfg.lab!.report_hour_wib || this.store.state.labLastReportDate === today) return;
    this.store.state.labLastReportDate = today;
    const text = this.compareText(nowMs);
    this.store.journal({ type: "lab_report", text });
    await this.notifier.send(text);
  }
}
