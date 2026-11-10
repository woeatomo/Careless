// Standalone orchestrator: Careless engine (screener → screening → entry) plus
// deterministic exits. No server, no LLM.
//
// Entry and exit paths are independent: exits keep running while candidates are
// being screened, and wallet mutations are serialized by the wallet lock
// (close_position > other writes > deploy_position) in standalone/transactions.js.

import fs from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { sendMessage as tgSend, isEnabled as tgEnabled } from "../telegram.js";
import { RuntimeStore } from "./store.js";
import { getMyPositions } from "../tools/dlmm.js";
import { executeTool } from "../tools/executor.js";
import { getTrackedPositions, confirmPeak, registerExitSignal, syncOpenPositions } from "../state.js";
import { recordPositionSnapshot } from "../pool-memory.js";
import { startAdmin } from "./telegram-admin.js";
import {
  startEngine, stopEngine, evaluateFastExit, evaluateSlowExit, closePosition, syncLivePositions,
} from "../careless/engine.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let store = null;
let lockPath = null;
let stopAdmin = null;
let shuttingDown = false;
let manageBusy = false;
let pollBusy = false;
const timers = {};

async function notify(text) {
  try { if (tgEnabled()) await tgSend(text); } catch { /* notifications are best-effort */ }
}

async function claimFees(p, why) {
  if ((p.unclaimed_fees_usd ?? 0) < config.management.minClaimAmount) return;
  const res = await executeTool("claim_fees", { position_address: p.position }).catch(e => ({ error: e.message }));
  log("manage", `${p.pair ?? p.position.slice(0, 8)}: claim fees (${why}) ${res?.error ? `FAILED — ${res.error}` : "done"}`);
}

// ─── Exits (deterministic, no LLM) ──────────────────────────────────────────

// One management pass: fast rules, rug guard, morning review and fee claims.
// Never triggers entries — the screener owns those.
export async function manageOnce() {
  if (manageBusy || shuttingDown) return null;
  manageBusy = true;
  try {
    const live = await getMyPositions({ force: true }).catch(() => null);
    if (!live || live.error || !Array.isArray(live.positions)) {
      log("manage_warn", "Position read unavailable — holding this cycle");
      return null;
    }
    syncOpenPositions(live.positions.map(p => p.position));
    syncLivePositions(live.positions);
    if (live.positions.length === 0) return "No open positions";
    for (const p of live.positions) {
      recordPositionSnapshot(p.pool, p);
      confirmPeak(p.position, p.pnl_pct, 1);
      try {
        const fast = await evaluateFastExit(p);
        if (fast) { await closePosition(p, fast); continue; }
        const slow = await evaluateSlowExit(p);
        if (slow?.action === "CLOSE") { await closePosition(p, slow); continue; }
        if (slow?.action === "CLAIM") { await claimFees(p, "morning review"); continue; }
        if (!config.careless.claim.onlyInMorningReview) await claimFees(p, "threshold");
      } catch (e) {
        log("manage_warn", `${p.pair ?? p.position.slice(0, 8)}: exit check failed: ${e.message}`);
      }
    }
    return null;
  } finally {
    manageBusy = false;
  }
}

// Fast exit poller (Meteora PnL, no network beyond the position read). An exit
// fires only after `confirmTicks` consecutive confirming polls.
function startPnlPoller() {
  const pollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 3)) * 1000;
  const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
  timers.pnl = setInterval(async () => {
    if (manageBusy || pollBusy || shuttingDown) return;
    if (getTrackedPositions(true).length === 0) return;
    pollBusy = true;
    try {
      const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!live?.positions?.length) return;
      for (const p of live.positions) {
        confirmPeak(p.position, p.pnl_pct, confirmTicks);
        const decision = await evaluateFastExit(p).catch(() => null);
        const { fire } = registerExitSignal(p.position, decision?.rule ?? null, confirmTicks);
        if (!decision || !fire) continue;
        log("poll", `Exit confirmed (${confirmTicks} ticks): ${p.pair ?? p.position.slice(0, 8)} — ${decision.reason}`);
        manageBusy = true; // hold the slow cycle off this position
        try { await closePosition(p, decision); } finally { manageBusy = false; }
        break; // one action per tick
      }
    } finally {
      pollBusy = false;
    }
  }, pollMs);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function startHeartbeat() {
  timers.heartbeat = setInterval(() => {
    const attempts = Object.values(store.data.attempts);
    const open = attempts.filter(a => ["entered", "proposed", "submitting"].includes(a.status)).length;
    log("heartbeat", `mode=${config.standalone.shadow ? "shadow" : "live"} | tracked positions=${getTrackedPositions(true).length} | entry attempts open=${open}`);
    store.prune();
    store.save();
  }, 60_000);
}

function acquireLock() {
  lockPath = repoPath("standalone.lock");
  if (fs.existsSync(lockPath)) {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* not running or invalid pid */ }
    if (alive && pid !== process.pid) throw new Error(`Another standalone instance is running (pid ${pid}) — refusing to start`);
    log("runtime", `Removing stale standalone lock (pid ${pid || "unknown"} is not running)`);
    fs.rmSync(lockPath);
  }
  fs.writeFileSync(lockPath, String(process.pid));
}

async function shutdown(signalName) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("runtime", `${signalName} received — shutting down`);
  for (const timer of Object.values(timers)) clearInterval(timer);
  try { stopEngine(); } catch { /* best-effort */ }
  try { stopAdmin?.(); } catch { /* best-effort */ }
  // Best-effort stop notice; never let a slow Telegram call hold shutdown.
  await Promise.race([notify(`🛑 Careless bot stopped (${signalName})`), sleep(3000)]).catch(() => {});
  try { if (lockPath) fs.rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
  process.exit(0);
}

export async function startStandalone() {
  if (!config.standalone.monitorRpcUrl) throw new Error("Standalone requires RPC_URL or MONITOR_RPC_URL");
  if (!config.careless.enabled) throw new Error("careless.enabled is false — nothing to run");
  acquireLock();

  store = new RuntimeStore();
  for (const [mint, attempt] of Object.entries(store.data.attempts)) {
    if (attempt.status === "submitting") {
      log("runtime_warn", `Mint ${mint.slice(0, 8)} was mid-submit at shutdown (position ${attempt.position ?? "unknown"}, txs ${attempt.txs?.length ?? 0}) — reconcile on-chain before re-enabling entries`);
    }
  }

  log("runtime", `Standalone starting — ${config.standalone.shadow ? "SHADOW MODE (paper positions, nothing submitted)" : "LIVE MODE"} | max ${config.risk.maxPositions} positions`);
  startEngine({ monitorStore: store, notifyFn: notify });

  // Entries come only from the screener; exits run on their own cadences.
  timers.manage = setInterval(() => { void manageOnce(); }, Math.max(1, config.schedule.managementIntervalMin) * 60_000);
  startPnlPoller();
  startHeartbeat();
  void manageOnce();
  stopAdmin = startAdmin();

  const c = config.careless;
  void notify(`🌿 Careless bot started — ${config.standalone.shadow ? "SHADOW + paper (nothing submitted)" : "LIVE"}\n${c.position.strategy} 0…-${c.position.downsidePct}% | max ${config.risk.maxPositions} positions | SL ${c.exits.stopLossPct}% | exits: ${config.pnl.pollIntervalSec}s poller`);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  log("runtime", `Running — screener every ${c.screener.intervalMin}m, exits every ${config.schedule.managementIntervalMin}m + ${config.pnl.pollIntervalSec}s poller`);
}
