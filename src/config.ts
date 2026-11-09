import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { MorningReviewCfg } from "./rules/exit.js";

export type TrackName = "careless" | "evilpanda";

export interface EntryCfg {
  fee_tvl_24h_min_pct: number;
  deep_pool_tvl_min_usd?: number;
  deep_pool_fee_tvl_24h_min_pct?: number;
  fee_rate_6h_as_24h_min_pct: number;
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

export interface TrackCfg {
  enabled: boolean;
  max_positions: number;
  per_position_sol: number;
  per_position_max_pct_balance: number;
  position: { strategy: "Spot" | "Curve" | "BidAsk"; range_below_pct: number; max_bins: number };
  entry: EntryCfg;
  exit: ExitCfg;
  claim_hour_wib: number;
  morning_review?: MorningReviewCfg;
}

export interface Config {
  mode: {
    dry_run: boolean;
    open_mode: "auto" | "propose" | "off";
    auto_hours_wib: [number, number];
    proposal_ttl_min: number;
  };
  intervals: { manage_sec: number; screen_min: number; telegram_poll_sec: number };
  sizing: { max_total_positions: number; min_buffer_sol: number };
  whitelist_mints: string[];
  tracks: Record<TrackName, TrackCfg>;
  audit: {
    require_mint_freeze_revoked: boolean;
    top_holders_max_pct: number;
    dev_holding_max_pct: number;
    dev_mints_max: number;
    liquidity_drop_24h_max_pct: number;
    candidates_per_screen: number;
  };
  slippage_bps: number;
  fees: { claim_min_sol: number; claim_interval_min: number; swap_to_sol: boolean };
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
  paper: { fee_capture_factor: number; fee_ref_depth_pct?: number };
  lab?: LabCfg;
}

export interface LabExperiment {
  name: string;
  track: TrackName;
  /** Bagian config jalur yang diganti untuk eksperimen ini (deep merge). */
  overrides?: Record<string, unknown>;
}

export interface LabCfg {
  enabled: boolean;
  capital_sol: number;
  report_hour_wib: number;
  audits_per_screen: number;
  experiments: LabExperiment[];
}

export interface Env {
  apiKey: string;
  privateKey: string;
  telegramToken?: string;
  telegramChatId?: string;
  discordWebhook?: string;
  dataDir: string;
}

/** Urutan jalur sesuai file config = prioritas. */
export const trackOrder = (cfg: Config): TrackName[] =>
  (Object.keys(cfg.tracks) as TrackName[]).filter((t) => cfg.tracks[t].enabled);

export function loadConfig(path = process.env.CONFIG_PATH ?? "config/strategy.yaml"): Config {
  const cfg = YAML.parse(readFileSync(path, "utf8")) as Config;
  cfg.whitelist_mints ??= [];
  for (const [name, t] of Object.entries(cfg.tracks)) {
    if (t.exit.stop_loss_pct > 0) throw new Error(`tracks.${name}.exit.stop_loss_pct harus negatif`);
    if (t.position.range_below_pct <= 0 || t.position.range_below_pct >= 100)
      throw new Error(`tracks.${name}.position.range_below_pct harus di antara 0 dan 100`);
    t.entry.launchpads ??= [];
  }
  return cfg;
}

export function loadEnv(): Env {
  const apiKey = process.env.LP_AGENT_API_KEY ?? "";
  const privateKey = process.env.SOLANA_PRIVATE_KEY ?? "";
  if (!apiKey) throw new Error("LP_AGENT_API_KEY belum diisi di .env");
  if (!privateKey) throw new Error("SOLANA_PRIVATE_KEY belum diisi di .env");
  return {
    apiKey,
    privateKey,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    discordWebhook: process.env.DISCORD_WEBHOOK_URL || undefined,
    dataDir: process.env.DATA_DIR ?? "data",
  };
}
