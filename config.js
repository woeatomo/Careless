import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";

export { REPO_ROOT, repoPath };

const USER_CONFIG_PATH = repoPath("user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // The standalone Careless bot IS the app — there is no mode toggle.
  // Shadow mode never submits transactions.
  standalone: {
    shadow: u.shadowMode !== false,
    monitorRpcUrl: nonEmptyString(process.env.MONITOR_RPC_URL, u.monitorRpcUrl, process.env.RPC_URL),
    balanceRpcUrl: nonEmptyString(process.env.BALANCE_RPC_URL, u.balanceRpcUrl, process.env.RPC_URL),
    fallbackRpcUrl: nonEmptyString(process.env.FALLBACK_RPC_URL, u.fallbackRpcUrl),
    walletAddress: nonEmptyString(process.env.WALLET_ADDRESS, u.walletAddress),
  },
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── PnL fetcher / poller (public infra: Meteora APIs) ──
  pnl: {
    // Position discovery, value, fees, and PnL come from the Meteora portfolio
    // + /pnl APIs — no per-tick on-chain reads, so the poller stays cheap.
    // "rpc" keeps the on-chain engine (DLMM SDK + Jupiter) available as an
    // explicit opt-in.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, process.env.RPC_URL, "https://api.mainnet-beta.solana.com"),
    source: nonEmptyString(u.pnlSource, process.env.PNL_SOURCE, "meteora"), // meteora | rpc
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    // Referral fee is OFF by default in this fork (upstream sent 0.5% of every
    // swap to the original author's referral account). Set both env vars to re-enable.
    referralAccount: process.env.JUPITER_REFERRAL_ACCOUNT ?? "",
    referralFeeBps: Number(process.env.JUPITER_REFERRAL_FEE_BPS ?? 0),
  },

  careless: buildCarelessConfig(u.careless ?? {}),

};

/**
 * Careless strategy settings (`careless` block in user-config.json).
 * Every key is optional; omitted keys use the defaults below. Secrets come
 * from the environment: GMGN_API_KEY.
 */
export function buildCarelessConfig(c = {}) {
  const pick = (obj, defaults) => ({ ...defaults, ...(obj && typeof obj === "object" ? obj : {}) });
  const screener = pick(c.screener, {
    intervalMin: 5,
    minMcap: 1_000_000,         // discovery prefilter
    maxMcap: null,
    minPoolVolume: 10_000,      // pool volume within `timeframe`
    timeframe: "24h",
    category: "",               // "" = all pools; "trending" narrows the scan
    pageSize: 50,
    maxScreenPerRun: 8,         // full screens per scan (each costs Jupiter + Rugcheck + Meteora calls)
    rescreenMin: 30,
    candidateTtlHours: 6,
  });
  const filters = pick(c.filters, {
    requireProfile: true,       // must have an image
    minMcap: 1_000_000,
    maxMcap: null,
    minTokenAgeHours: 72,       // 3 days
    launchpads: ["pump.fun"],   // [] = any launchpad
    maxRange24hPct: 20,         // ranging: |24h price change| <= this
    maxPump1hPct: 50,           // skip parabolic 1h pumps
    maxTop10Pct: 30,
    maxDevBalancePct: 5,
    minTokenFeesSol: 0,         // 0 = off
    maxLiquidityDrop24hPct: 30,
  });
  const pool = pick(c.pool, {
    minTvl: 30_000,
    maxTvl: null,
    minBinStep: 80,
    maxBinStep: 250,
    minFeeTvl24hPct: 5,         // 24h fees / TVL
    preferHighBinStep: true,    // a -80% range needs fewer bins on a high bin step
  });
  const rugcheck = pick(c.rugcheck, {
    enabled: true,
    maxScore: 10,               // score_normalised (1 = best, 100 = worst)
    rejectDanger: true,
    blockRisks: ["Low amount of LP Providers", "Creator history of rugged tokens"],
    requireData: true,
    requestDelayMs: 1000,
  });
  const gmgn = pick(c.gmgn, {
    enabled: true,
    baseUrl: "https://openapi.gmgn.ai",
    requestDelayMs: 2500,
    maxRetries: 2,
    ratesAreFractions: true,
    maxPhishingPct: 30,
    maxBundlerPct: 60,
    maxInsidersPct: 10,
    maxTop10Pct: 30,
    requireData: false,         // false: skip the GMGN filter when no key / data
  });
  gmgn.apiKey = nonEmptyString(process.env.GMGN_API_KEY, typeof c.gmgn?.apiKey === "string" ? c.gmgn.apiKey : "");
  const position = pick(c.position, {
    strategy: "spot",           // spot | curve | bid_ask
    downsidePct: 80,            // single-side SOL range 0% … -80%
    minDownsidePct: 50,         // shallower than this after rent-free shrinking → skip the pool
    shrinkToInitialized: true,  // never pay non-refundable bin-array rent
  });
  const entry = pick(c.entry, {
    maxPriceMovePct: 5,         // abort if price moved more than this between decision and submit
    reentryCooldownHours: 6,    // no re-entry into a token for this long after any close
  });
  const exits = pick(c.exits, {
    stopLossPct: -15,           // hard rug protection (PnL incl. fees)
    takeProfitPct: null,        // null = off: profit is taken in the morning review
    trailingTakeProfit: false,
    trailingTriggerPct: 5,
    trailingDropPct: 3,
    oorAboveWaitMinutes: 30,    // OOR kanan: close after this long when PnL > oorAboveMinPnlPct
    oorAboveMinPnlPct: 0,
    oorBelowWaitMinutes: 60,    // OOR kiri / slow rug: close after this long
  });
  const rugGuard = pick(c.rugGuard, {
    enabled: true,
    liquidityDrop5mPct: 15,     // hard: one is enough
    liquidityDrop1hPct: 30,
    exitOnAuthorityChange: true,
    softRequired: 2,            // soft: this many at once
    sellShare1hPct: 75,
    priceDrop5mPct: 20,
    holderDrop1hPct: 5,
  });
  const morningReview = pick(c.morningReview, {
    enabled: true,
    hourLocal: 6,               // 06:00 local time
    timeZone: "Asia/Jakarta",
    minFeeTvl24hPct: 5,         // below → close (potential faded)
    maxDrop24hPct: 20,          // 24h price below -this → close (no longer ranging)
  });
  const claim = pick(c.claim, {
    onlyInMorningReview: true,  // false: claim every management cycle above minClaimAmount
  });
  const paper = pick(c.paper, {
    enabled: true,              // only active in shadow mode: every "would deploy" becomes a simulated position
    pollSec: 60,
    nearSpanBins: 3,            // our liquidity within ±N bins of the price counts for the fee estimate
    slowCheckMin: 10,           // rug guard + morning review cadence for paper positions
  });
  return {
    enabled: c.enabled !== false,
    whitelistMints: Array.isArray(c.whitelistMints) ? c.whitelistMints.filter(m => typeof m === "string" && m) : [],
    screener, filters, pool, rugcheck, gmgn, position, entry, exits, rugGuard, morningReview, claim, paper,
  };
}

// Shadow applies to every existing transaction path, including CLI commands.
if (config.standalone.shadow) process.env.DRY_RUN = "true";

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}
