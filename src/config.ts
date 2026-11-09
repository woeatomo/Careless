import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { MorningReviewCfg } from "./rules/exit.js";

export type TrackName = "careless" | "evilpanda";

export interface EntryCfg {
  fee_tvl_24h_min_pct: number;
  deep_pool_tvl_min_usd?: number;
  deep_pool_fee_tvl_24h_min_pct?: number;
  /** Laju fee 4 jam terakhir × 6 ÷ TVL (persen). 0 = tidak dicek. */
  fee_recent_as_24h_min_pct: number;
  volume_24h_min_usd: number;
  mcap_min_usd: number;
  tvl_min_usd: number;
  token_age_min_hours: number;
  organic_score_min: number;
  bin_step_min: number;
  bin_step_max: number;
  launchpads: string[];
  ranging_24h_max_abs_pct: number;
  skip_if_pump_1h_pct: number;
}

export interface ExitCfg {
  stop_loss_pct: number;
  take_profit_trigger_pct: number;
  trailing_pct: number;
  fee_floor_enabled: boolean;
  fee_tvl_24h_floor_pct: number;
  fee_floor_duration_min: number;
  out_of_range_above_close_min: number;
  out_of_range_below_close_min: number;
}

export interface ScanCfg {
  min_volume_usd: number;
  page_size: number;
  category: string; // "" = semua kategori
}

export interface TrackCfg {
  enabled: boolean;
  max_positions: number;
  per_position_sol: number;
  per_position_max_pct_balance: number;
  position: { strategy: "Spot" | "Curve" | "BidAsk"; range_below_pct: number; max_bins: number };
  scan: ScanCfg;
  entry: EntryCfg;
  exit: ExitCfg;
  morning_review?: MorningReviewCfg;
}

export interface Config {
  mode: { dry_run: boolean };
  intervals: { manage_sec: number; screen_min: number; telegram_poll_sec: number };
  sizing: { min_buffer_sol: number };
  whitelist_mints: string[];
  tracks: Record<TrackName, TrackCfg>;
  audit: {
    require_mint_freeze_revoked: boolean;
    top_holders_max_pct: number;
    dev_holding_max_pct: number;
    dev_mints_max: number;
    liquidity_drop_24h_max_pct: number;
  };
  fees: { claim_min_sol: number; claim_interval_min: number };
  rug_guard: {
    liquidity_drop_5m_pct: number;
    liquidity_drop_1h_pct: number;
    exit_on_authority_change: boolean;
    soft_required: number;
    sell_share_1h_pct: number;
    price_drop_5m_pct: number;
    holder_drop_1h_pct: number;
  };
  risk: {
    pause_after_consecutive_sl: number;
    pause_hours: number;
    daily_loss_stop_pct: number;
    reentry_cooldown_hours: number;
  };
  paper: {
    near_span_bins: number;
    max_fee_minutes: number;
    close_slippage_pct: number;
    tx_cost_sol: number;
    pool24h_refresh_min: number;
  };
  http: { gap_ms: number; timeout_ms: number };
  lab: LabCfg;
}

export interface LabExperiment {
  name: string;
  track: TrackName;
  /** Bagian config jalur yang diganti untuk eksperimen ini (deep merge). */
  overrides?: Record<string, unknown>;
}

export interface LabCfg {
  capital_sol: number;
  report_hour_wib: number;
  audits_per_screen: number;
  experiments: LabExperiment[];
}

export interface Env {
  telegramToken?: string;
  telegramChatId?: string;
  discordWebhook?: string;
  dataDir: string;
}

export function loadConfig(path = process.env.CONFIG_PATH ?? "config/strategy.yaml"): Config {
  const cfg = YAML.parse(readFileSync(path, "utf8")) as Config;
  if (cfg.mode?.dry_run === false)
    throw new Error(
      "Mode live belum tersedia: eksekusi langsung ke Meteora belum dipasang. Biarkan mode.dry_run: true (paper test).",
    );
  cfg.whitelist_mints ??= [];
  for (const [name, t] of Object.entries(cfg.tracks)) {
    if (t.exit.stop_loss_pct > 0) throw new Error(`tracks.${name}.exit.stop_loss_pct harus negatif`);
    if (t.position.range_below_pct <= 0 || t.position.range_below_pct >= 100)
      throw new Error(`tracks.${name}.position.range_below_pct harus di antara 0 dan 100`);
    t.entry.launchpads ??= [];
  }
  if (!cfg.lab?.experiments?.length) throw new Error("lab.experiments kosong");
  return cfg;
}

export function loadEnv(): Env {
  return {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    discordWebhook: process.env.DISCORD_WEBHOOK_URL || undefined,
    dataDir: process.env.DATA_DIR ?? "data",
  };
}
