import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Track } from "./rules/exit.js";
import type { TrackName } from "./config.js";
import type { Shape } from "./paper.js";

export interface TrackedPosition extends Track {
  strat: TrackName;
  pool: string;
  pair: string;
  tokenMint?: string;
  openedAt: string;
  lastPnl: number;
  lastValueSol: number;
  lastAdvice?: string;
}

export interface ClosedRecord {
  id: string;
  strat?: TrackName;
  pool: string;
  pair: string;
  pnlPct: number;
  pnlSol: number;
  reason: string;
  closedAt: string;
  paper: boolean;
  feeSol?: number;
  heldMin?: number;
}

export interface Proposal {
  id: string;
  strat: TrackName;
  pool: string;
  symbol: string;
  tokenMint: string;
  amountSol: number;
  createdAt: string;
  summary: string;
}

export interface PaperPosition extends Track {
  id: string;
  strat: TrackName;
  shape: Shape;
  pool: string;
  symbol: string;
  tokenMint: string;
  openedAt: string;
  lastUpdate: string;
  entryPrice: number; // harga token dalam SOL saat buka
  depthPct: number;
  amountSol: number;
  feeSol: number;
  lastPnl: number;
  lastValueSol?: number;
}

/** State satu eksperimen Lab (portofolio virtual terpisah). */
export interface ExpState {
  cash: number;
  capital: number;
  startedAt: string;
  positions: Record<string, PaperPosition>;
  closed: ClosedRecord[];
  peakEquity: number;
  maxDrawdownPct: number;
  pausedUntil?: string;
  day?: { date: string; startEquitySol: number };
}

export interface BotState {
  tracks: Record<string, TrackedPosition>;
  closed: ClosedRecord[];
  proposals: Record<string, Proposal>;
  paper: Record<string, PaperPosition>;
  cooldowns: Record<string, string>; // pool -> boleh masuk lagi setelah waktu ini
  pausedUntil?: string;
  manualPause?: boolean;
  day?: { date: string; startEquitySol: number };
  telegramOffset?: number;
  lab?: Record<string, ExpState>;
  labLastReportDate?: string;
}

const empty = (): BotState => ({ tracks: {}, closed: [], proposals: {}, paper: {}, cooldowns: {} });

export class Store {
  state: BotState;
  private file: string;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "state.json");
    this.state = existsSync(this.file) ? { ...empty(), ...JSON.parse(readFileSync(this.file, "utf8")) } : empty();
  }

  save(): void {
    // simpan atomik supaya tidak korup kalau proses mati di tengah jalan
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  /** Jurnal append-only untuk evaluasi dan tuning. */
  journal(event: Record<string, unknown>): void {
    appendFileSync(join(this.dir, "journal.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  }

  recordClose(rec: ClosedRecord, cooldownHours: number): void {
    this.state.closed.push(rec);
    if (this.state.closed.length > 500) this.state.closed = this.state.closed.slice(-500);
    this.state.cooldowns[rec.pool] = new Date(Date.now() + cooldownHours * 3_600_000).toISOString();
    this.journal({ type: "close", ...rec });
  }
}
