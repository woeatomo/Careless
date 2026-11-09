import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Track } from "./rules/exit.js";
import type { TrackName } from "./config.js";
import type { Shape } from "./paper.js";

export interface ClosedRecord {
  id: string;
  strat: TrackName;
  pool: string;
  pair: string;
  pnlPct: number;
  pnlSol: number;
  reason: string;
  closedAt: string;
  feeSol: number;
  heldMin: number;
  priceMovePct: number;
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
  binStep: number;
  binsBelow: number;
  depthPct: number;
  amountSol: number;
  feeSol: number;
  lastPrice: number;
  lastPnl: number;
  lastValueSol: number;
}

/** State satu eksperimen (portofolio virtual terpisah). */
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
  lab: Record<string, ExpState>;
  labLastReportDate?: string;
  manualPause?: boolean;
  telegramOffset?: number;
}

const empty = (): BotState => ({ lab: {} });

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
}
