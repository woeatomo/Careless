/**
 * Unit tests for the standalone infrastructure (no network, no wallet):
 * runtime store, balances, deploy-gate screening, wallet-write ordering.
 * Run: node test/test-standalone.js
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { RuntimeStore } from "../standalone/store.js";
import { aggregateTokenAccounts } from "../standalone/balances.js";
import { rejectToken, rejectPool } from "../standalone/screening.js";
import { withWalletLock } from "../standalone/transactions.js";

let failed = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const MINT = "Mint111111111111111111111111111111111111111";
const POOL_A = "Po01AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const POOL_B = "Po02BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
// ─── Runtime store ───────────────────────────────────────────────────────────
console.log("\n[1] RuntimeStore — attempt records survive restarts, recovery history is never discarded");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "careless-store-"));
  const file = path.join(dir, "state.json");
  const now = Date.now();
  const store = new RuntimeStore(file);
  store.data.attempts[MINT] = { at: now - 25 * 3600_000, status: "entered" };
  store.data.attempts[POOL_A] = { at: now - 25 * 3600_000, status: "submitting" };
  store.data.attempts[POOL_B] = { at: now, status: "proposed" };
  store.save();
  const reopened = new RuntimeStore(file);
  check("state persists across restart", Object.keys(reopened.data.attempts).length === 3);
  reopened.prune(now);
  check("attempt records pruned after 24h except mid-submit", reopened.data.attempts[MINT] === undefined && reopened.data.attempts[POOL_A] != null && reopened.data.attempts[POOL_B] != null);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ version: 2 }));
  let refused = false;
  try { new RuntimeStore(bad); } catch { refused = true; }
  check("invalid runtime state refused, not discarded", refused);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Balances ────────────────────────────────────────────────────────────────
console.log("\n[2] aggregateTokenAccounts — SPL + Token-2022, no phantom zeros");
{
  const acct = (mint, amount, decimals) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount), decimals } } } } } });
  const tokens = aggregateTokenAccounts([
    { value: [acct(MINT, 1000, 6), acct(config.tokens.USDC, 0, 6)] },
    { value: [acct(MINT, 2500, 6)] },
  ]);
  check("same mint aggregated across programs", tokens.length === 1 && tokens[0].balance === 0.0035 && tokens[0].mint === MINT);
  check("zero-balance accounts dropped", !tokens.some(t => t.mint === config.tokens.USDC));
  let conflicted = false;
  try { aggregateTokenAccounts([{ value: [acct(MINT, 1, 6)] }, { value: [acct(MINT, 1, 9)] }]); } catch { conflicted = true; }
  check("conflicting decimals rejected", conflicted);
}

// ─── Screening gates ─────────────────────────────────────────────────────────
console.log("\n[3] deploy-gate rejectToken / rejectPool — missing data never passes");
{
  const now = Date.now();
  const base = {
    id: MINT, updatedAt: new Date(now - 10_000).toISOString(),
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 30, botHoldersPercentage: 10 },
    fees: 50, launchpad: null, holderCount: 800, mcap: 400_000, organicScore: 75,
    createdAt: new Date(now - 3 * 3600_000).toISOString(),
  };
  check("healthy token passes", rejectToken(base, MINT, config.screening, now) === null);
  check("mint mismatch rejected", rejectToken(base, POOL_A, config.screening, now) !== null);
  check("stale token data rejected", rejectToken({ ...base, updatedAt: new Date(now - 300_000).toISOString() }, MINT, config.screening, now) !== null);
  check("missing audit rejected", rejectToken({ ...base, audit: undefined }, MINT, config.screening, now) !== null);
  check("mint authority still enabled rejected", rejectToken({ ...base, audit: { ...base.audit, mintAuthorityDisabled: false } }, MINT, config.screening, now) !== null);
  check("unknown holder concentration rejected", rejectToken({ ...base, audit: { ...base.audit, topHoldersPercentage: null } }, MINT, config.screening, now) !== null);

  const pool = {
    pool_type: "dlmm", is_blacklisted: false,
    token_x: { address: MINT, warnings: [] },
    token_y: { address: config.tokens.SOL, warnings: [], organic_score: 75 },
    tvl: 50_000, active_tvl: 40_000, volume: 5_000, fee_active_tvl_ratio: 0.1,
    dlmm_params: { bin_step: 100 }, volatility: 3.2, pool_price: 1.5,
  };
  check("healthy pool passes", rejectPool(pool, MINT, config.screening) === null);
  check("wrong pool type rejected", rejectPool({ ...pool, pool_type: "clmm" }, MINT, config.screening) !== null);
  check("wrong quote side rejected", rejectPool({ ...pool, token_y: { ...pool.token_y, address: "USDTMint11111111111111111111111111111111111" } }, MINT, config.screening) !== null);
  check("pool token warning rejected", rejectPool({ ...pool, token_x: { ...pool.token_x, warnings: [{ severity: "danger" }] } }, MINT, config.screening) !== null);
  check("unknown TVL rejected", rejectPool({ ...pool, tvl: null }, MINT, config.screening) !== null);
  check("TVL above cap rejected", rejectPool({ ...pool, tvl: 10_000_000 }, MINT, config.screening) !== null);
}

// ─── Coordination + rules ────────────────────────────────────────────────────
console.log("\n[4] withWalletLock — exits jump the queue, never concurrent");
{
  const order = [];
  const job = (label, ms) => async () => { order.push(`start:${label}`); await new Promise(r => setTimeout(r, ms)); order.push(`end:${label}`); };
  const first = withWalletLock(job("deploy", 40), 0);
  const second = withWalletLock(job("close", 1), 10);
  const third = withWalletLock(job("claim", 1), 5);
  await Promise.all([first, second, third]);
  check("serialized execution", order[0] === "start:deploy" && order[1] === "end:deploy");
  check("exit priority runs before other writes", order[2] === "start:close" && order[4] === "start:claim");
}

console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
