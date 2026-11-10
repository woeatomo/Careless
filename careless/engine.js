// Careless orchestrator (same workflow as the meridianEvPANDA engine, Careless strategy).
//
//   Meteora screener (+ narrative whitelist)
//      → screening (Jupiter basics, Rugcheck, GMGN, token/SOL DLMM pools)
//      → enter right away while slots are free (no chart signal)
//      → Spot, single-side SOL, 0% … -80% → rent-free range → deploy
//
// Exits: fast rules on every PnL poll (stop loss, OOR kanan/kiri, optional TP),
// slow rules on the management cycle (rug guard, 06:00 WIB morning review:
// close when the potential faded, otherwise claim fees and keep).
// Every wallet write goes through tools/executor.js (wallet lock, safety
// checks, shadow mode). Missing data never counts as "safe".

import fs from "node:fs";
import { config, computeDeployAmount } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { getMyPositions } from "../tools/dlmm.js";
import { executeTool } from "../tools/executor.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getTrackedPosition } from "../state.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked } from "../dev-blocklist.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { checkMintOnChain } from "../standalone/screening.js";
import * as src from "./sources.js";
import { rejectTokenBasics, rejectRugcheck, rejectGmgnFetch, rejectPool, rankPools, feeTvlPct } from "./filters.js";
import { fastExitDecision, updateOor, rugDecision, reviewDue, morningReviewDecision, localClock } from "./exits.js";
import { binsForDownsidePct } from "./range.js";
import * as paper from "./paper.js";

const STATE_FILE = repoPath("careless-state.json");
const cl = () => config.careless;
const paperOn = () => config.standalone.shadow && cl().paper.enabled;

// ─── Persistent state ───────────────────────────────────────────────────────

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { candidates: s.candidates ?? {}, positions: s.positions ?? {}, cooldowns: s.cooldowns ?? {} };
  } catch {
    return { candidates: {}, positions: {}, cooldowns: {} };
  }
}
let state = loadState();
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { log("cl_warn", `state save failed: ${e.message}`); }
}

let store = null;          // standalone RuntimeStore (attempt records = duplicate/crash protection)
let notify = async () => {};
const timers = {};
let screenBusy = false;
let entryBusy = false;
const closing = new Set();

// ─── Re-entry cooldown ──────────────────────────────────────────────────────

const onCooldown = (mint, now = Date.now()) => (state.cooldowns[mint] ?? 0) > now;

/** After any close, keep the bot away from that token for a while (no re-entry into a fresh dump). */
function setCooldown(mint, reason) {
  if (!mint) return;
  state.cooldowns[mint] = Date.now() + cl().entry.reentryCooldownHours * 3_600_000;
  const w = state.candidates[mint];
  if (w) Object.assign(w, { pass: false, reason: `cooldown after close (${reason})` });
  saveState();
}

function pruneCooldowns(now = Date.now()) {
  for (const [mint, until] of Object.entries(state.cooldowns)) if (until <= now) delete state.cooldowns[mint];
}

// ─── Screening ──────────────────────────────────────────────────────────────

const isWhitelisted = mint => cl().whitelistMints.includes(mint);

/** Full Careless screen for one mint. Returns { pass, reason, terminal?, token, pool, pools, rugcheck, gmgn }. */
export async function screenCandidate(mint) {
  const c = cl();
  if (isBlacklisted(mint) || isBaseMintOnCooldown(mint)) return { pass: false, terminal: true, reason: "blacklisted or on cooldown" };
  const token = await src.jupiterToken(mint);
  const basics = rejectTokenBasics(token, mint, c.filters, { whitelisted: isWhitelisted(mint) });
  if (basics) return { pass: false, reason: basics };
  if (token.dev && isDevBlocked(token.dev)) return { pass: false, terminal: true, reason: "deployer blocked" };
  await checkMintOnChain(mint);

  let rugcheck = null;
  if (c.rugcheck.enabled) {
    rugcheck = await src.rugcheckSummary(mint, { delayMs: c.rugcheck.requestDelayMs });
    const why = rejectRugcheck(rugcheck, c.rugcheck);
    if (why) return { pass: false, reason: why };
  }

  let gmgn = null;
  if (c.gmgn.enabled) {
    const r = rejectGmgnFetch(await src.gmgnSecurity(mint, c.gmgn), c.gmgn);
    gmgn = r.metrics;
    if (r.reason) return { pass: false, reason: r.reason };
  }

  const addresses = (await src.poolsForMint(mint, config.tokens.SOL)).slice(0, 5);
  const eligible = [];
  const rejected = [];
  for (const address of addresses) {
    if (isPoolOnCooldown(address)) { rejected.push("pool cooldown"); continue; }
    try {
      const p = await src.discoveryPool(address, "24h");
      const why = rejectPool(p, mint, config.tokens.SOL, c.pool);
      if (why) rejected.push(why); else eligible.push(p);
    } catch (err) { rejected.push(err.message); }
  }
  if (!eligible.length) return { pass: false, reason: rejected.slice(0, 2).join("; ") || "no eligible token/SOL DLMM pool" };
  const ranked = rankPools(eligible, c.pool.preferHighBinStep);
  return { pass: true, reason: "ok", token, pool: ranked[0], pools: ranked, rugcheck, gmgn };
}

function recordScreen(mint, r, source) {
  const prev = state.candidates[mint];
  state.candidates[mint] = {
    mint,
    sources: [...new Set([...(prev?.sources ?? []), source])],
    screenedAt: Date.now(),
    pass: r.pass,
    reason: r.reason,
    poolAddress: r.pool?.pool_address ?? null,
    binStep: r.pool?.dlmm_params?.bin_step ?? null,
    volatility: r.pool?.volatility ?? null,
    feeTvl24hPct: r.pool ? feeTvlPct(r.pool) : null,
    symbol: r.token?.symbol ?? prev?.symbol ?? null,
  };
  if (r.terminal) delete state.candidates[mint];
  saveState();
}

function pruneCandidates(now = Date.now()) {
  const ttl = cl().screener.candidateTtlHours * 3_600_000;
  for (const [mint, w] of Object.entries(state.candidates)) if (now - w.screenedAt > ttl) delete state.candidates[mint];
}

// ─── Screener → entries ─────────────────────────────────────────────────────

async function runScreener() {
  if (screenBusy) return;
  screenBusy = true;
  try {
    pruneCandidates();
    pruneCooldowns();
    let found = [];
    try {
      found = await src.scanDiscovery(cl().screener, config.tokens.SOL);
    } catch (e) { log("cl_warn", `screener scan failed: ${e.message}`); }
    const list = [
      ...cl().whitelistMints.map(mint => ({ mint, source: "whitelist" })),
      ...found.map(f => ({ mint: f.mint, source: "screener" })),
    ];
    log("cl_screen", `scan: ${found.length} token/SOL pools from Meteora${cl().whitelistMints.length ? ` + ${cl().whitelistMints.length} whitelisted` : ""}`);
    const held = await heldMints();
    let screened = 0;
    for (const { mint, source } of list) {
      if (screened >= cl().screener.maxScreenPerRun) break;
      if (held?.has(mint) || onCooldown(mint)) continue;
      const prev = state.candidates[mint];
      if (prev && Date.now() - prev.screenedAt < cl().screener.rescreenMin * 60_000) continue;
      const attempt = store?.data.attempts[mint];
      if (attempt && ["entered", "proposed", "submitting"].includes(attempt.status)) continue;
      screened++;
      try {
        const r = await screenCandidate(mint);
        recordScreen(mint, r, source);
        log("cl_screen", `${r.token?.symbol ?? mint.slice(0, 8)} ${r.pass ? "PASS" : "fail"}: ${r.reason}`);
      } catch (err) {
        recordScreen(mint, { pass: false, reason: `screen error: ${err.message}` }, source);
        log("cl_screen", `${mint.slice(0, 8)} error: ${err.message}`);
      }
    }
    await tryEntries();
  } finally {
    screenBusy = false;
  }
}

/** Mints already held (live + paper). null when the position read failed. */
async function heldMints() {
  const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
  if (!live || live.error || !Array.isArray(live.positions)) return null;
  const paperOpen = paperOn() ? paper.openPaperPositions() : [];
  return new Set([...live.positions.map(p => p.base_mint), ...paperOpen.map(p => p.mint)].filter(Boolean));
}

async function tryEntries() {
  if (entryBusy) return;
  entryBusy = true;
  try {
    const live = await getMyPositions({ force: true }).catch(() => null);
    if (!live || live.error || !Array.isArray(live.positions)) { log("cl_entry", "position read unavailable — no entries this cycle"); return; }
    const paperOpen = paperOn() ? paper.openPaperPositions() : [];
    let open = live.positions.length + paperOpen.length;
    const held = new Set([...live.positions.map(p => p.base_mint), ...paperOpen.map(p => p.mint)].filter(Boolean));
    const candidates = Object.values(state.candidates)
      .filter(w => w.pass && w.poolAddress && !held.has(w.mint) && !onCooldown(w.mint))
      .sort((a, b) => (b.feeTvl24hPct ?? 0) - (a.feeTvl24hPct ?? 0));
    for (const w of candidates) {
      if (open >= config.risk.maxPositions) break;
      const attempt = store?.data.attempts[w.mint];
      if (attempt && ["entered", "proposed", "submitting"].includes(attempt.status)) continue;
      if (attempt?.status === "failed" && (attempt.failures ?? 0) >= 2) continue;
      try {
        if (await attemptEntry(w)) open++;
      } catch (err) {
        log("cl_entry", `${w.mint.slice(0, 8)} entry error: ${err.message}`);
      }
    }
  } finally {
    entryBusy = false;
  }
}

async function attemptEntry(w) {
  const c = cl();
  const balances = await getWalletBalances({ force: true, nativeOnly: true });
  if (balances.error || !Number.isFinite(balances.sol)) { log("cl_entry", "balance read unavailable"); return false; }
  if (balances.sol < config.management.minSolToOpen + config.management.gasReserve) { log("cl_entry", `insufficient SOL (${balances.sol})`); return false; }
  const amountY = computeDeployAmount(balances.sol);
  const depthPct = c.position.downsidePct;
  // Fresh DLMM price at decision time; the submit guard compares against this.
  let basePrice;
  try { basePrice = Number((await src.discoveryPool(w.poolAddress, "5m")).pool_price); }
  catch (err) { log("cl_entry", `${w.mint.slice(0, 8)} fresh pool read failed: ${err.message}`); return false; }
  if (!(basePrice > 0)) { log("cl_entry", `${w.mint.slice(0, 8)} price unavailable`); return false; }

  store.data.attempts[w.mint] = { at: Date.now(), mint: w.mint, pool: w.poolAddress, source: w.sources.join(","), status: "submitting", failures: store.data.attempts[w.mint]?.failures ?? 0, position: null, txs: [] };
  store.save();

  let submitted = 0;
  const result = await executeTool("deploy_position", {
    pool_address: w.poolAddress,
    base_mint: w.mint,
    amount_y: amountY,
    strategy: c.position.strategy,
    downside_pct: depthPct,
    upside_pct: 0,
    shrink_to_initialized: c.position.shrinkToInitialized,
    min_downside_pct: Math.min(c.position.minDownsidePct, depthPct),
    volatility: w.volatility,
    bin_step: w.binStep,
    pool_name: w.symbol ? `${w.symbol}-SOL` : undefined,
    before_submit: async () => {
      if (submitted++ > 0) return;
      const fresh = await src.discoveryPool(w.poolAddress, "5m");
      const now = Number(fresh.pool_price);
      if (!(now > 0)) throw new Error("price unavailable for move check");
      const move = Math.abs(now - basePrice) / basePrice * 100;
      if (move > c.entry.maxPriceMovePct) throw new Error(`price moved ${move.toFixed(1)}% since the entry decision`);
    },
    on_prepared: position => { store.data.attempts[w.mint].position = position; store.save(); },
  }).catch(err => ({ error: err.message }));

  const rec = store.data.attempts[w.mint];
  const ok = result && result.success !== false && !result.error && !result.blocked;
  if (!ok) {
    rec.status = "failed";
    rec.failures = (rec.failures ?? 0) + 1;
    rec.error = result?.error || result?.reason || "unknown";
    store.save();
    log("cl_entry", `${w.symbol ?? w.mint.slice(0, 8)} deploy failed: ${rec.error}`);
    return false;
  }
  rec.status = result.dry_run ? "proposed" : "entered";
  rec.position = result.position ?? rec.position;
  rec.amountSol = amountY;
  store.save();
  if (result.dry_run && paperOn()) {
    const pp = paper.openPaper({
      mint: w.mint, pool: w.poolAddress, symbol: w.symbol, entryPrice: basePrice,
      binStep: Number(result.would_deploy?.bin_step ?? w.binStep),
      binsBelow: Number(result.would_deploy?.bins_below ?? binsForDownsidePct(depthPct, w.binStep)),
      shape: c.position.strategy, capitalSol: amountY, sources: w.sources,
    });
    rec.position = pp.id;
    store.save();
    log("cl_paper", `📝 opened ${pp.id}: ${amountY} SOL ${c.position.strategy}, ${pp.binsBelow} bins @ ${basePrice}`);
  }
  if (rec.position && !String(rec.position).startsWith("paper-")) {
    state.positions[rec.position] = { mint: w.mint, pool: w.poolAddress, enteredAt: Date.now(), oor: null, lastReviewDate: null };
    saveState();
  }
  const range = result.would_deploy ? ` bins_below=${result.would_deploy.bins_below}${result.would_deploy.range_shrunk ? " (shrunk, rent-free)" : ""}` : "";
  const label = result.dry_run ? "[SHADOW] would deploy" : "Deployed";
  log("cl_entry", `${label} ${amountY} SOL ${c.position.strategy} → ${w.poolAddress.slice(0, 8)} (${w.symbol ?? w.mint.slice(0, 8)}, 24h fee/TVL ${w.feeTvl24hPct?.toFixed(1) ?? "?"}%)${range}`);
  void notify(`${result.dry_run ? "🕯️ Shadow" : "✅ Entry"} ${w.symbol ?? w.mint.slice(0, 8)}: ${amountY} SOL ${c.position.strategy}, range -${depthPct}% (24h fee/TVL ${w.feeTvl24hPct?.toFixed(1) ?? "?"}%)`);
  return true;
}

// ─── Exits ──────────────────────────────────────────────────────────────────

function clPosition(p) {
  if (!state.positions[p.position]) state.positions[p.position] = { mint: p.base_mint ?? null, pool: p.pool, enteredAt: null, oor: null, lastReviewDate: null };
  return state.positions[p.position];
}

/**
 * Fast rules for one position (PnL poller + management cycle): stop loss,
 * optional TP/trailing, OOR kanan/kiri. No network. Returns {rule, reason} or null.
 */
export async function evaluateFastExit(p) {
  const rec = clPosition(p);
  const nextOor = updateOor(rec.oor, p);
  if (nextOor.dir !== rec.oor?.dir || nextOor.since !== rec.oor?.since) {
    if (nextOor.dir) log("cl_exit", `${p.pair ?? p.position.slice(0, 8)} out of range ${nextOor.dir}`);
    rec.oor = nextOor;
    saveState();
  }
  const peakPnlPct = p.paper ? paper.paperPeak(p.position) : getTrackedPosition(p.position)?.peak_pnl_pct ?? null;
  return fastExitDecision(p, { peakPnlPct, oor: rec.oor }, cl().exits);
}

/**
 * Slow rules (management cycle; uses the network): rug guard, then the morning
 * review. Returns a CLOSE decision, {action:"CLAIM"} after a healthy review, or null.
 */
export async function evaluateSlowExit(p, now = Date.now()) {
  const c = cl();
  const rec = clPosition(p);
  const mint = rec.mint ?? p.base_mint;
  if (!mint) return null;
  let token = null;
  if (c.rugGuard.enabled || reviewDue(rec.lastReviewDate, c.morningReview, now)) {
    try { token = await src.jupiterToken(mint); } catch (err) { log("cl_exit", `${p.pair ?? p.position.slice(0, 8)} token data unavailable: ${err.message}`); }
  }
  if (c.rugGuard.enabled) {
    const rug = rugDecision(token, c.rugGuard);
    if (rug) return rug;
  }
  if (!reviewDue(rec.lastReviewDate, c.morningReview, now)) return null;
  let pool24h = null;
  try { pool24h = await src.discoveryPool(rec.pool ?? p.pool, "24h"); } catch { /* unavailable → hold */ }
  const decision = morningReviewDecision(pool24h, token, c.morningReview);
  rec.lastReviewDate = localClock(now, c.morningReview.timeZone).date;
  saveState();
  log("cl_review", `${p.pair ?? p.position.slice(0, 8)}: ${decision.reason}`);
  return decision.action === "HOLD" ? null : decision;
}

const recentlyClosed = new Map(); // position → { at, dryRun }

function closePaperPosition(p, decision) {
  const t = paper.closePaper(p.position, { rule: decision.rule, reason: decision.reason });
  if (!t) return;
  delete state.positions[p.position];
  setCooldown(t.mint, decision.rule);
  const attempt = store?.data.attempts[t.mint];
  if (attempt?.position === p.position) { attempt.status = "closed"; store.save(); }
  log("cl_paper", `📝 closed ${t.symbol ?? t.mint.slice(0, 8)}: ${decision.rule} → ${t.pnlPct.toFixed(2)}% (${t.pnlSol.toFixed(4)} SOL, fees ${t.feesSol.toFixed(4)}) after ${t.heldMin}m — ${decision.reason}`);
  void notify(`📝 Paper close ${t.symbol ?? t.mint.slice(0, 8)}: ${decision.rule} ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}% (${t.pnlSol.toFixed(4)} SOL) — ${decision.reason}`);
}

export async function closePosition(p, decision) {
  if (p.paper) return closePaperPosition(p, decision);
  if (closing.has(p.position)) return;
  // Poller and management cycle read positions independently; a list read
  // before a close finished must not trigger a second close.
  const last = recentlyClosed.get(p.position);
  if (last && Date.now() - last.at < (last.dryRun ? 30 : 10) * 60_000) return;
  closing.add(p.position);
  try {
    const res = await executeTool("close_position", { position_address: p.position, reason: decision.reason }).catch(err => ({ error: err.message }));
    const ok = res?.success !== false && !res?.error && !res?.blocked;
    log("cl_exit", `${p.pair ?? p.position.slice(0, 8)}: ${decision.rule} → ${ok ? (res?.dry_run ? "[SHADOW] would close" : "closed") : `close FAILED — ${res?.error || res?.reason}`} (${decision.reason})`);
    if (ok) {
      recentlyClosed.set(p.position, { at: Date.now(), dryRun: !!res?.dry_run });
      void notify(`${res?.dry_run ? "🕯️ Shadow close" : "🔚 Closed"} ${p.pair ?? p.position.slice(0, 8)}: ${decision.rule} — ${decision.reason}`);
      if (!res?.dry_run) {
        const mint = state.positions[p.position]?.mint ?? p.base_mint;
        delete state.positions[p.position];
        setCooldown(mint, decision.rule);
      }
    }
  } finally {
    closing.delete(p.position);
  }
}

/** Forget positions that closed elsewhere (manual close, other tools). */
export function syncLivePositions(livePositions) {
  const open = new Set(livePositions.map(p => p.position));
  let changed = false;
  for (const [addr, rec] of Object.entries(state.positions)) {
    if (!open.has(addr) && Date.now() - (rec.enteredAt ?? 0) > 3_600_000) { delete state.positions[addr]; changed = true; }
  }
  if (changed) saveState();
}

// ─── Paper trading ──────────────────────────────────────────────────────────

let paperBusy = false;
const lastSlowCheck = new Map();

async function paperTick() {
  if (paperBusy || !paperOn()) return;
  paperBusy = true;
  try {
    for (const pp of paper.openPaperPositions()) {
      try {
        const pool = await src.discoveryPool(pp.pool, "5m");
        const view = paper.markPaper(pp.id, pool, { nearSpanBins: cl().paper.nearSpanBins });
        if (!view) continue; // price unavailable: skip, never close on missing data
        let d = await evaluateFastExit(view);
        if (!d && Date.now() - (lastSlowCheck.get(pp.id) ?? 0) >= cl().paper.slowCheckMin * 60_000) {
          lastSlowCheck.set(pp.id, Date.now());
          const slow = await evaluateSlowExit(view);
          if (slow?.action === "CLOSE") d = slow;
        }
        if (d) { lastSlowCheck.delete(pp.id); closePaperPosition(view, d); }
      } catch (err) { log("cl_paper", `${pp.symbol ?? pp.mint.slice(0, 8)} mark failed: ${err.message}`); }
    }
  } finally {
    paperBusy = false;
  }
}

export const paperSummary = paper.paperSummary;

// ─── Scheduling ─────────────────────────────────────────────────────────────

export function startEngine({ monitorStore, notifyFn }) {
  store = monitorStore;
  if (notifyFn) notify = notifyFn;
  const c = cl();
  void runScreener();
  timers.screener = setInterval(() => void runScreener(), Math.max(1, c.screener.intervalMin) * 60_000);
  if (paperOn()) {
    void paperTick();
    timers.paper = setInterval(() => void paperTick(), Math.max(15, c.paper.pollSec) * 1000);
  }
  log("cl", `Careless engine started — screener every ${c.screener.intervalMin}m (mcap ≥ ${c.filters.minMcap}, age ≥ ${c.filters.minTokenAgeHours}h, ranging ±${c.filters.maxRange24hPct}%/24h, fee/TVL ≥ ${c.pool.minFeeTvl24hPct}%) | ${c.position.strategy} 0…-${c.position.downsidePct}% (rent-free=${c.position.shrinkToInitialized}) | SL ${c.exits.stopLossPct}% | review ${c.morningReview.enabled ? `${String(c.morningReview.hourLocal).padStart(2, "0")}:00 ${c.morningReview.timeZone}` : "off"} | paper ${paperOn() ? "on" : "off"} | GMGN ${c.gmgn.apiKey ? "on" : "no key → skipped"}`);
}

export function stopEngine() {
  for (const t of Object.values(timers)) { clearInterval(t); clearTimeout(t); }
}

export function candidatesSummary() {
  return Object.values(state.candidates)
    .sort((a, b) => Number(b.pass) - Number(a.pass) || (b.feeTvl24hPct ?? 0) - (a.feeTvl24hPct ?? 0))
    .map(w => ({ mint: w.mint, symbol: w.symbol, sources: w.sources, pass: w.pass, reason: w.reason, feeTvl24hPct: w.feeTvl24hPct, screenedMinAgo: Math.round((Date.now() - w.screenedAt) / 60_000) }));
}
