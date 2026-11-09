import type { Config, TrackCfg } from "../config.js";
import type { BotState, ClosedRecord } from "../state.js";

export interface RiskCheck {
  ok: boolean;
  reason?: string;
  /** Jika rem jeda harus dipasang, sampai kapan (ISO). */
  pauseUntil?: string;
}

/** Penutupan yang dihitung sebagai "kena": SL atau rug. Penutupan rutin (OOR, review, TP) tidak. */
export const isStopOut = (c: ClosedRecord) => /^(SL|RUG)/.test(c.reason) || c.pnlPct <= -10;

/** Jumlah stop-out berturut-turut paling akhir (penutupan untung memutus hitungan). */
export function consecutiveStopOuts(closed: ClosedRecord[], paper: boolean): number {
  let n = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    const c = closed[i];
    if (c.paper !== paper) continue;
    if (isStopOut(c)) n++;
    else if (c.pnlPct >= 0) break;
  }
  return n;
}

/** Tanggal WIB (YYYY-MM-DD). */
export const dateWIB = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(d);

/** Rem tingkat akun (berlaku untuk semua jalur). */
export function canOpenNew(
  state: BotState,
  cfg: Config,
  openCount: number,
  freeSol: number,
  paper: boolean,
  nowMs = Date.now(),
): RiskCheck {
  const r = cfg.risk;
  if (state.manualPause) return { ok: false, reason: "dijeda manual (/pause)" };
  if (state.pausedUntil && Date.parse(state.pausedUntil) > nowMs)
    return { ok: false, reason: `jeda risiko sampai ${state.pausedUntil}` };
  if (openCount >= cfg.sizing.max_total_positions) return { ok: false, reason: "slot posisi penuh" };
  if (freeSol - cfg.sizing.min_buffer_sol < 0.05) return { ok: false, reason: "saldo SOL bebas kurang" };

  if (consecutiveStopOuts(state.closed, paper) >= r.pause_after_consecutive_sl) {
    const until = new Date(nowMs + r.pause_hours * 3_600_000).toISOString();
    return { ok: false, reason: `${r.pause_after_consecutive_sl} stop-out berturut-turut`, pauseUntil: until };
  }

  const today = dateWIB(new Date(nowMs));
  if (state.day && state.day.date === today && state.day.startEquitySol > 0) {
    const pnlSol = state.closed
      .filter((c) => c.paper === paper && dateWIB(new Date(c.closedAt)) === today)
      .reduce((s, c) => s + c.pnlSol, 0);
    const pct = (pnlSol / state.day.startEquitySol) * 100;
    if (pct <= -r.daily_loss_stop_pct) {
      const until = new Date(nowMs + r.pause_hours * 3_600_000).toISOString();
      return { ok: false, reason: `rugi hari ini ${pct.toFixed(1)}%`, pauseUntil: until };
    }
  }
  return { ok: true };
}

/** Ukuran posisi jalur: min(per_position_sol, % saldo), tanpa menyentuh buffer. 0 = tidak cukup. */
export function positionSize(cfg: Config, track: TrackCfg, freeSol: number): number {
  const amount = Math.min(
    track.per_position_sol,
    (freeSol * track.per_position_max_pct_balance) / 100,
    freeSol - cfg.sizing.min_buffer_sol,
  );
  return amount >= 0.05 ? Math.floor(amount * 1000) / 1000 : 0;
}
