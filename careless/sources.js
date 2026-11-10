// Network adapters for the Careless engine (taken from the meridianEvPANDA
// adapters, without the Discord relay and candle sources). Every function is
// read-only. Failures throw (or return null where documented) — callers must
// treat missing data as "unknown", never as "safe".

import { randomUUID } from "node:crypto";

const JUP = "https://datapi.jup.ag/v1";
const DISCOVERY = "https://pool-discovery-api.datapi.meteora.ag/pools";
const DLMM_API = "https://dlmm.datapi.meteora.ag/pools";

const lastCall = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Serialises calls per key so free APIs aren't rate-limited. */
async function pace(key, delayMs) {
  const prev = lastCall.get(key) ?? Promise.resolve(0);
  const turn = prev.then(async last => {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    return Date.now();
  });
  lastCall.set(key, turn.catch(() => Date.now()));
  await turn;
}

/** GET JSON with a timeout; retries 429/5xx with backoff (honours Retry-After). */
export async function getJson(url, { headers = {}, timeoutMs = 12_000, retries = 2, fetchImpl = fetch } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers?.get?.("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res.json();
  }
}

// ─── Token data ──────────────────────────────────────────────────────────────

export async function jupiterToken(mint) {
  await pace("jupiter", 250);
  const list = await getJson(`${JUP}/assets/search?query=${mint}`);
  return (Array.isArray(list) ? list : []).find(t => t.id === mint) ?? null;
}

/** Rugcheck summary or null when unreachable. */
export async function rugcheckSummary(mint, { delayMs = 1000 } = {}) {
  await pace("rugcheck", delayMs);
  try {
    return await getJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
  } catch {
    return null;
  }
}

/**
 * GMGN token security (rates for phishing/bundler/insiders/top10).
 * Returns { ok: true, data } on success, { ok: false, reason } when the call
 * failed, or null when no API key is configured (filter intentionally skipped).
 */
export async function gmgnSecurity(mint, g) {
  if (!g.apiKey) return null;
  const url = new URL(`${String(g.baseUrl).replace(/\/+$/, "")}/v1/token/security`);
  url.searchParams.set("chain", "sol");
  url.searchParams.set("address", mint);
  url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("client_id", randomUUID());
  let reason = "unknown error";
  for (let attempt = 0; attempt <= (g.maxRetries ?? 2); attempt++) {
    await pace("gmgn", g.requestDelayMs ?? 2500);
    try {
      const res = await fetch(url, { headers: { "X-APIKEY": g.apiKey }, signal: AbortSignal.timeout(12_000) });
      if (res.status === 429) { reason = "rate limited"; await sleep(Math.min(30_000, 3000 * 2 ** attempt)); continue; }
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      const payload = await res.json();
      const data = payload?.data?.data || payload?.data || null;
      return data && typeof data === "object" ? { ok: true, data } : { ok: false, reason: "empty response" };
    } catch (e) {
      reason = e?.name === "TimeoutError" ? "timeout" : e?.message || "network error";
    }
  }
  return { ok: false, reason };
}

// ─── Pools ───────────────────────────────────────────────────────────────────

export async function discoveryPool(address, timeframe = "24h") {
  await pace("discovery", 150);
  const params = new URLSearchParams({ page_size: "1", filter_by: `pool_address=${address}`, timeframe });
  const data = await getJson(`${DISCOVERY}?${params}`);
  const pool = data?.data?.find(p => p.pool_address === address);
  if (!pool) throw new Error("pool data unavailable");
  return pool;
}

/** Token/SOL DLMM pool addresses for a mint. */
export async function poolsForMint(mint, solMint) {
  await pace("dlmm-api", 150);
  const params = new URLSearchParams({ query: mint, page_size: "50", sort_by: "tvl:desc" });
  const data = await getJson(`${DLMM_API}?${params}`);
  if (!Array.isArray(data?.data)) throw new Error("invalid pool search response");
  return data.data.filter(p => p.token_x?.address === mint && p.token_y?.address === solMint).map(p => p.address).slice(0, 10);
}

/**
 * Screener scan: DLMM token/SOL pools with real activity over the timeframe.
 * Returns one candidate per base mint, best fee/TVL first (Careless looks for
 * steady fee earners, not the newest tokens).
 */
export async function scanDiscovery(sc, solMint) {
  const filters = [
    "pool_type=dlmm",
    `base_token_market_cap>=${sc.minMcap}`,
    sc.maxMcap != null ? `base_token_market_cap<=${sc.maxMcap}` : null,
    `volume>=${sc.minPoolVolume}`,
  ].filter(Boolean).join("&&");
  const params = new URLSearchParams({ page_size: String(sc.pageSize), filter_by: filters, timeframe: sc.timeframe });
  if (sc.category) params.set("category", sc.category);
  await pace("discovery", 150);
  const data = await getJson(`${DISCOVERY}?${params}`);
  const pools = Array.isArray(data?.data) ? data.data : [];
  const byMint = new Map();
  for (const p of pools) {
    if (p.token_y?.address !== solMint || !p.token_x?.address) continue;
    const tvl = Number(p.tvl);
    const feeTvl = tvl > 0 ? (Number(p.fee) / tvl) * 100 : null;
    const prev = byMint.get(p.token_x.address);
    if (!prev || (feeTvl ?? -1) > (prev.feeTvlPct ?? -1)) {
      byMint.set(p.token_x.address, { mint: p.token_x.address, name: p.name, pool: p.pool_address, feeTvlPct: feeTvl });
    }
  }
  return [...byMint.values()].sort((a, b) => (b.feeTvlPct ?? -1) - (a.feeTvlPct ?? -1));
}
