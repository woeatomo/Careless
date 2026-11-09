import { trackOrder, type Config, type TrackCfg, type TrackName } from "./config.js";
import type { LpAgentApi, PoolDetail, PoolSummary, Position } from "./api.js";
import type { Notifier } from "./notify.js";
import type { PaperPosition, Store, TrackedPosition } from "./state.js";
import { auditDetail, binsForRange, feeRate6hAs24hPct, feeTvl24hPct, screenSummary } from "./rules/entry.js";
import { decideExit, rangeSide, type RangeSide } from "./rules/exit.js";
import { rugCheck } from "./rules/rug.js";
import { canOpenNew, dateWIB, positionSize } from "./rules/risk.js";
import { paperFeeSol, valueRatio } from "./paper.js";
import { fmt, hourWIB, inHourWindow, log, minutesSince } from "./util.js";

const POOL_LINK = (pool: string) => `https://app.lpagent.io/pools/${pool}`;
const TX_LINK = (sig?: string) => (sig ? `https://solscan.io/tx/${sig}` : "(tanpa signature)");
const LABEL: Record<TrackName, string> = { careless: "CARELESS", evilpanda: "EVILPANDA" };

interface Candidate {
  strat: TrackName;
  summary: PoolSummary;
  detail: PoolDetail;
}

/** Tebak jalur posisi yang dibuka di luar bot dari lebar range-nya (Careless jauh lebih lebar). */
export function inferStrat(lowerBin: number, upperBin: number): TrackName {
  const width = upperBin - lowerBin;
  return Number.isFinite(width) && width >= 55 ? "careless" : "evilpanda";
}

export class Bot {
  private lastScreenAt = 0;

  constructor(
    private cfg: Config,
    private api: LpAgentApi,
    private store: Store,
    private notifier: Notifier,
  ) {}

  private get paper() {
    return this.cfg.mode.dry_run;
  }
  private get s() {
    return this.store.state;
  }
  private tcfg(strat: TrackName): TrackCfg {
    return this.cfg.tracks[strat] ?? this.cfg.tracks.evilpanda;
  }

  /* ======================= SIKLUS UTAMA ======================= */

  async tick(): Promise<void> {
    const positions = await this.api.openPositions();
    await this.manageLive(positions);
    if (this.paper) await this.managePaper();
    if (Date.now() - this.lastScreenAt >= this.cfg.intervals.screen_min * 60_000) {
      this.lastScreenAt = Date.now();
      await this.screen(positions);
    }
    this.expireProposals();
    this.store.save();
  }

  private stratOf(pos: Position): TrackName {
    return this.s.tracks[pos.id]?.strat ?? inferStrat(pos.lowerBin, pos.upperBin);
  }

  /* ======================= POSISI ASLI ======================= */

  private async manageLive(positions: Position[]): Promise<void> {
    const ids = new Set(positions.map((p) => p.id));

    // Posisi yang hilang dari daftar = ditutup di luar bot (SL/TP LP Agent, review pagi, atau manual).
    for (const [id, t] of Object.entries(this.s.tracks)) {
      if (ids.has(id)) continue;
      const pnlSol = this.pnlSolFrom(t.lastPnl, t.lastValueSol);
      this.store.recordClose(
        { id, strat: t.strat, pool: t.pool, pair: t.pair, pnlPct: t.lastPnl, pnlSol, reason: "ditutup di luar bot", closedAt: new Date().toISOString(), paper: false },
        this.cfg.risk.reentry_cooldown_hours,
      );
      delete this.s.tracks[id];
      await this.notifier.send(`ℹ️ ${t.pair} sudah tertutup di luar bot. PnL terakhir ${fmt(t.lastPnl, 1)}%`);
    }

    for (const pos of positions) {
      try {
        await this.manageOne(pos);
      } catch (e: any) {
        log(`Gagal mengelola ${pos.pair}: ${e.message}`);
      }
    }
  }

  private async manageOne(pos: Position): Promise<void> {
    const strat = this.stratOf(pos);
    const tc = this.tcfg(strat);
    const prev: TrackedPosition = this.s.tracks[pos.id] ?? {
      strat,
      pool: pos.pool,
      pair: pos.pair,
      openedAt: pos.createdAt ?? new Date().toISOString(),
      peakPnl: -1e9,
      lastPnl: pos.pnlPctSol,
      lastValueSol: pos.valueSol,
    };
    const detail = await this.api.poolDetail(pos.pool);
    const side = rangeSide(detail.activeBin, pos.lowerBin, pos.upperBin, pos.inRange);
    const { decision, track } = decideExit(
      { pnlPct: pos.pnlPctSol, side, uncollectedFeeSol: pos.uncollectedFeeSol },
      detail,
      prev,
      this.cfg,
      tc.exit,
      { claimHourWib: tc.claim_hour_wib, hourNowWib: hourWIB() },
    );
    const t: TrackedPosition = { ...prev, ...track, strat, lastPnl: pos.pnlPctSol, lastValueSol: pos.valueSol };
    this.s.tracks[pos.id] = t;
    log(`[${LABEL[strat]}] ${pos.pair} | PnL ${fmt(pos.pnlPctSol)}% | ${side} | fee/TVL ${fmt(feeTvl24hPct(detail.fee24h, detail.tvl), 1)}% | ${decision.action}: ${decision.reason}`);

    if (decision.action === "hold") return;

    if (this.paper) {
      // Mode paper: posisi asli tidak disentuh, saran dikirim sekali per alasan.
      const advice = `${decision.action}:${decision.reason}`;
      if (prev.lastAdvice !== advice && decision.action === "close")
        await this.notifier.send(`🧪 [PAPER] Posisi asli ${pos.pair} AKAN ditutup bot live: ${decision.reason}`);
      t.lastAdvice = advice;
      return;
    }

    if (decision.action === "claim") {
      const sig = await this.api.claimFees(pos.id, this.cfg.slippage_bps, this.cfg.fees.swap_to_sol);
      t.lastClaimAt = new Date().toISOString();
      this.store.journal({ type: "claim", strat, id: pos.id, pair: pos.pair, feeSol: pos.uncollectedFeeSol, sig });
      log(`Claim fee ${pos.pair}: ${TX_LINK(sig)}`);
      return;
    }

    const sig = await this.api.close(pos.id, this.cfg.slippage_bps);
    const pnlSol = this.pnlSolFrom(pos.pnlPctSol, pos.valueSol);
    this.store.recordClose(
      { id: pos.id, strat, pool: pos.pool, pair: pos.pair, pnlPct: pos.pnlPctSol, pnlSol, reason: decision.reason, closedAt: new Date().toISOString(), paper: false },
      this.cfg.risk.reentry_cooldown_hours,
    );
    delete this.s.tracks[pos.id];
    await this.notifier.send(
      `${pos.pnlPctSol >= 0 ? "✅" : "🔻"} TUTUP [${LABEL[strat]}] ${pos.pair}\nPnL ${fmt(pos.pnlPctSol, 1)}% (${fmt(pnlSol, 4)} SOL)\nAlasan: ${decision.reason}\n${TX_LINK(sig)}`,
    );
  }

  /** PnL dalam SOL dari persen PnL dan nilai sekarang. */
  private pnlSolFrom(pnlPct: number, valueSol: number): number {
    if (!Number.isFinite(pnlPct) || !Number.isFinite(valueSol)) return 0;
    return valueSol - valueSol / (1 + pnlPct / 100);
  }

  /* ======================= POSISI PAPER ======================= */

  private async managePaper(): Promise<void> {
    for (const pp of Object.values(this.s.paper)) {
      try {
        const tc = this.tcfg(pp.strat);
        const detail = await this.api.poolDetail(pp.pool);
        const now = Date.now();
        const ratio = detail.priceInSol / pp.entryPrice;
        const side: RangeSide = !(ratio > 0) ? "unknown" : ratio > 1 ? "above" : ratio < 1 - pp.depthPct / 100 ? "below" : "in";
        const minutes = minutesSince(pp.lastUpdate, now);
        if (side === "in")
          pp.feeSol += paperFeeSol(pp.amountSol, detail.fee24h, detail.tvl, minutes, this.cfg.paper.fee_capture_factor);
        const valueSol = pp.amountSol * valueRatio(ratio, pp.depthPct, pp.shape);
        const pnlSol = valueSol + pp.feeSol - pp.amountSol;
        const pnlPct = (pnlSol / pp.amountSol) * 100;
        const { decision, track } = decideExit(
          { pnlPct, side, uncollectedFeeSol: 0 },
          detail,
          pp,
          this.cfg,
          tc.exit,
          { claimHourWib: -1, hourNowWib: hourWIB(new Date(now)) },
          now,
        );
        Object.assign(pp, track, { lastUpdate: new Date(now).toISOString(), lastPnl: pnlPct });
        log(`[PAPER ${LABEL[pp.strat]}] ${pp.symbol} | PnL ${fmt(pnlPct)}% (fee ${fmt(pp.feeSol, 4)} SOL) | ${side} | ${decision.action}: ${decision.reason}`);

        if (decision.action === "close") {
          this.store.recordClose(
            { id: pp.id, strat: pp.strat, pool: pp.pool, pair: `${pp.symbol}/SOL`, pnlPct, pnlSol, reason: decision.reason, closedAt: new Date().toISOString(), paper: true },
            this.cfg.risk.reentry_cooldown_hours,
          );
          delete this.s.paper[pp.id];
          await this.notifier.send(`🧪 [PAPER ${LABEL[pp.strat]}] TUTUP ${pp.symbol}/SOL\nPnL ${fmt(pnlPct, 1)}% (${fmt(pnlSol, 4)} SOL, fee ${fmt(pp.feeSol, 4)})\nAlasan: ${decision.reason}`);
        }
      } catch (e: any) {
        log(`[PAPER] gagal update ${pp.symbol}: ${e.message}`);
      }
    }
  }

  /* ======================= SCREENING ======================= */

  /** Jumlah posisi terbuka per jalur (asli atau paper). */
  private countByStrat(positions: Position[]): Record<TrackName, number> {
    const c: Record<TrackName, number> = { careless: 0, evilpanda: 0 };
    if (this.paper) for (const p of Object.values(this.s.paper)) c[p.strat]++;
    else for (const p of positions) c[this.stratOf(p)]++;
    return c;
  }

  private async screen(positions: Position[]): Promise<void> {
    if (this.cfg.mode.open_mode === "off") return;

    const balance = await this.api.solBalance();
    const paperAlloc = Object.values(this.s.paper).reduce((s, p) => s + p.amountSol, 0);
    const freeSol = this.paper ? balance - paperAlloc : balance;
    const counts = this.countByStrat(positions);
    const openCount = counts.careless + counts.evilpanda;

    // Catat modal awal hari (WIB) untuk rem rugi harian.
    const today = dateWIB();
    if (this.s.day?.date !== today) {
      const equity = balance + positions.reduce((s, p) => s + (Number.isFinite(p.valueSol) ? p.valueSol : 0), 0);
      this.s.day = { date: today, startEquitySol: equity };
    }

    const risk = canOpenNew(this.s, this.cfg, openCount, freeSol, this.paper);
    if (!risk.ok) {
      if (risk.pauseUntil && this.s.pausedUntil !== risk.pauseUntil) {
        this.s.pausedUntil = risk.pauseUntil;
        await this.notifier.send(`⏸️ Rem risiko aktif: ${risk.reason}. Tidak buka posisi baru sampai ${risk.pauseUntil}`);
      }
      log(`Screening dilewati: ${risk.reason}`);
      return;
    }

    const openTracks = trackOrder(this.cfg).filter((t) => counts[t] < this.tcfg(t).max_positions);
    if (openTracks.length === 0) return log("Screening dilewati: slot semua jalur penuh");

    const busyPools = new Set([
      ...positions.map((p) => p.pool),
      ...Object.values(this.s.paper).map((p) => p.pool),
      ...Object.values(this.s.proposals).map((p) => p.pool),
    ]);
    const busyMints = new Set([
      ...Object.values(this.s.tracks).map((t) => t.tokenMint),
      ...Object.values(this.s.paper).map((p) => p.tokenMint),
    ]);
    const pools = (await this.api.discover()).filter(
      (p) =>
        !busyPools.has(p.pool) &&
        !busyMints.has(p.tokenMint) &&
        !(this.s.cooldowns[p.pool] && Date.parse(this.s.cooldowns[p.pool]) > Date.now()),
    );

    // Kandidat per jalur sesuai prioritas; total audit dibatasi agar hemat panggilan API.
    let auditsLeft = this.cfg.audit.candidates_per_screen;
    let chosen: Candidate | undefined;
    const audited = new Set<string>();
    for (const strat of openTracks) {
      const tc = this.tcfg(strat);
      const passed = pools
        .filter((p) => !audited.has(p.pool))
        .filter((p) => screenSummary(p, tc.entry, Date.now(), this.cfg.whitelist_mints.includes(p.tokenMint)).pass)
        .sort((a, b) => feeTvl24hPct(b.fee24h, b.tvl) - feeTvl24hPct(a.fee24h, a.tvl));
      log(`Screening ${LABEL[strat]}: ${passed.length} lolos filter awal`);
      for (const summary of passed) {
        if (auditsLeft-- <= 0) break;
        audited.add(summary.pool);
        const wl = this.cfg.whitelist_mints.includes(summary.tokenMint);
        const detail = await this.api.poolDetail(summary.pool);
        const audit = auditDetail(detail, this.cfg, tc, wl);
        const rug = rugCheck(detail, this.cfg);
        const reasons = [...audit.reasons, ...rug.hard, ...rug.soft];
        this.store.journal({ type: "audit", strat, pool: summary.pool, symbol: summary.symbol, pass: audit.pass && !rug.trigger, reasons });
        if (audit.pass && !rug.trigger) {
          chosen = { strat, summary, detail };
          break;
        }
        log(`Kandidat ${summary.symbol} (${LABEL[strat]}) ditolak: ${reasons.join(", ")}`);
      }
      if (chosen || auditsLeft <= 0) break;
    }
    if (!chosen) return;

    const amount = positionSize(this.cfg, this.tcfg(chosen.strat), freeSol);
    if (amount <= 0) return;

    if (this.paper) return this.openPaper(chosen, amount);
    const auto = this.cfg.mode.open_mode === "auto" || inHourWindow(hourWIB(), this.cfg.mode.auto_hours_wib);
    if (auto) await this.openLive(chosen, amount);
    else await this.propose(chosen, amount);
  }

  private describe(c: Candidate, amount: number): string {
    const s = c.summary;
    const p = this.tcfg(c.strat).position;
    return [
      `[${LABEL[c.strat]}] ${s.symbol}/SOL — ${amount} SOL, ${p.strategy} 0% s/d -${p.range_below_pct}%`,
      `fee/TVL 24j ${fmt(feeTvl24hPct(s.fee24h, s.tvl), 1)}% | laju 6j ${fmt(feeRate6hAs24hPct(s.fee6h, s.tvl), 1)}% | TVL $${fmt(s.tvl / 1000, 0)}K`,
      `harga 24j ${fmt(s.priceChange24h, 0)}% | 1j ${fmt(s.priceChange1h, 1)}% | top holder ${fmt(c.detail.audit?.topHoldersPct ?? NaN, 0)}%`,
      POOL_LINK(s.pool),
    ].join("\n");
  }

  private async openLive(c: Candidate, amount: number): Promise<void> {
    const d = c.detail;
    const p = this.tcfg(c.strat).position;
    const bins = binsForRange(p.range_below_pct, d.binStep);
    const res = await this.api.openBelowPrice(d.pool, amount, d.activeBin - bins, d.activeBin, p.strategy, this.cfg.slippage_bps);
    if (res.position)
      this.s.tracks[res.position] = {
        strat: c.strat,
        pool: d.pool,
        pair: `${c.summary.symbol}/SOL`,
        tokenMint: c.summary.tokenMint,
        openedAt: new Date().toISOString(),
        peakPnl: -1e9,
        lastPnl: 0,
        lastValueSol: amount,
      };
    this.store.journal({ type: "open", strat: c.strat, pool: d.pool, symbol: c.summary.symbol, amount, bins, position: res.position, sig: res.signature });
    await this.notifier.send(`🟢 BUKA ${this.describe(c, amount)}\n${TX_LINK(res.signature)}`);
  }

  private async openPaper(c: Candidate, amount: number): Promise<void> {
    if (!(c.detail.priceInSol > 0)) return log(`[PAPER] harga ${c.summary.symbol} tidak diketahui, dilewati`);
    const p = this.tcfg(c.strat).position;
    const id = `paper-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const pp: PaperPosition = {
      id,
      strat: c.strat,
      shape: p.strategy,
      pool: c.detail.pool,
      symbol: c.summary.symbol,
      tokenMint: c.summary.tokenMint,
      openedAt: now,
      lastUpdate: now,
      entryPrice: c.detail.priceInSol,
      depthPct: p.range_below_pct,
      amountSol: amount,
      feeSol: 0,
      lastPnl: 0,
      peakPnl: -1e9,
    };
    this.s.paper[id] = pp;
    this.store.journal({ type: "open", paper: true, ...pp });
    await this.notifier.send(`🧪 [PAPER] BUKA ${this.describe(c, amount)}`);
  }

  /* ======================= USULAN & PERINTAH ======================= */

  private async propose(c: Candidate, amount: number): Promise<void> {
    const id = Math.random().toString(36).slice(2, 7);
    this.s.proposals[id] = {
      id,
      strat: c.strat,
      pool: c.summary.pool,
      symbol: c.summary.symbol,
      tokenMint: c.summary.tokenMint,
      amountSol: amount,
      createdAt: new Date().toISOString(),
      summary: this.describe(c, amount),
    };
    await this.notifier.send(
      `💡 USULAN ${id}\n${this.describe(c, amount)}\n\nBalas /approve ${id} atau /reject ${id} (berlaku ${this.cfg.mode.proposal_ttl_min} menit)`,
    );
  }

  private expireProposals(): void {
    for (const p of Object.values(this.s.proposals))
      if (minutesSince(p.createdAt) > this.cfg.mode.proposal_ttl_min) delete this.s.proposals[p.id];
  }

  async handleCommand(cmd: string, args: string[]): Promise<string> {
    switch (cmd) {
      case "status":
        return this.statusText();
      case "pause":
        this.s.manualPause = true;
        this.store.save();
        return "⏸️ Bot tidak akan buka posisi baru. Posisi yang ada tetap dikelola. /resume untuk lanjut.";
      case "resume":
        this.s.manualPause = false;
        this.s.pausedUntil = undefined;
        this.store.save();
        return "▶️ Bot lanjut membuka posisi sesuai aturan.";
      case "reject": {
        const p = this.s.proposals[args[0]];
        if (!p) return "Usulan tidak ditemukan atau sudah kedaluwarsa.";
        delete this.s.proposals[p.id];
        this.s.cooldowns[p.pool] = new Date(Date.now() + this.cfg.risk.reentry_cooldown_hours * 3_600_000).toISOString();
        this.store.save();
        return `Usulan ${p.symbol} ditolak.`;
      }
      case "approve": {
        const p = this.s.proposals[args[0]];
        if (!p) return "Usulan tidak ditemukan atau sudah kedaluwarsa.";
        delete this.s.proposals[p.id];
        // Cek ulang dengan data segar sebelum membuka.
        const positions = await this.api.openPositions();
        const balance = await this.api.solBalance();
        const counts = this.countByStrat(positions);
        const risk = canOpenNew(this.s, this.cfg, counts.careless + counts.evilpanda, balance, false);
        if (!risk.ok) return `Dibatalkan: ${risk.reason}`;
        const tc = this.tcfg(p.strat);
        if (counts[p.strat] >= tc.max_positions) return `Dibatalkan: slot ${LABEL[p.strat]} penuh`;
        const detail = await this.api.poolDetail(p.pool);
        const audit = auditDetail(detail, this.cfg, tc, this.cfg.whitelist_mints.includes(p.tokenMint));
        const rug = rugCheck(detail, this.cfg);
        if (!audit.pass || rug.trigger) return `Dibatalkan, kondisi berubah: ${[...audit.reasons, ...rug.hard, ...rug.soft].join(", ")}`;
        const summary: PoolSummary = {
          pool: p.pool, symbol: p.symbol, tokenMint: p.tokenMint, protocol: "meteora", tvl: detail.tvl, fee24h: detail.fee24h,
          fee6h: NaN, fee1h: NaN, vol24h: NaN, mcap: NaN, binStep: detail.binStep, organicScore: NaN,
          priceChange1h: detail.stats1h?.priceChange ?? NaN, priceChange6h: NaN, priceChange24h: detail.stats24h?.priceChange ?? NaN,
        };
        await this.openLive({ strat: p.strat, summary, detail }, Math.min(p.amountSol, positionSize(this.cfg, tc, balance)));
        this.store.save();
        return `Usulan ${p.symbol} dieksekusi.`;
      }
      default:
        return "Perintah: /status /approve <id> /reject <id> /pause /resume";
    }
  }

  private statusText(): string {
    const lines = [`Mode: ${this.paper ? "PAPER" : "LIVE"} | buka: ${this.cfg.mode.open_mode} | auto jam ${this.cfg.mode.auto_hours_wib.join("-")} WIB`];
    if (this.s.manualPause) lines.push("⏸️ dijeda manual");
    if (this.s.pausedUntil && Date.parse(this.s.pausedUntil) > Date.now()) lines.push(`⏸️ rem risiko sampai ${this.s.pausedUntil}`);
    for (const t of Object.values(this.s.tracks)) lines.push(`• [${LABEL[t.strat]}] ${t.pair} PnL ${fmt(t.lastPnl, 1)}%`);
    for (const p of Object.values(this.s.paper)) lines.push(`• [PAPER ${LABEL[p.strat]}] ${p.symbol}/SOL PnL ${fmt(p.lastPnl, 1)}% fee ${fmt(p.feeSol, 4)}`);
    const recent = this.s.closed.slice(-5).map((c) => `  ${c.paper ? "[P] " : ""}${c.pair} ${fmt(c.pnlPct, 1)}% — ${c.reason}`);
    if (recent.length) lines.push("Tutup terakhir:", ...recent);
    return lines.join("\n");
  }
}
