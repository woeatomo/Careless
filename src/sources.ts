/**
 * Sumber data gratis, tanpa API key (endpoint yang sama dengan bot meridianEvPANDA):
 * - Meteora Pool Discovery: data pool DLMM per jendela waktu (fee, TVL, active TVL, harga)
 * - Jupiter datapi: data token (audit, organic score, holder, launchpad, statistik 5m/1h/24h)
 * Semua fungsi read-only. Data yang hilang dikembalikan sebagai NaN/undefined, tidak pernah
 * dianggap "aman".
 */
import type { PoolDetail, PoolSummary, WindowStats } from "./types.js";
import { SOL_MINT, log, num, sleep } from "./util.js";

const DISCOVERY = "https://pool-discovery-api.datapi.meteora.ag/pools";
const JUPITER = "https://datapi.jup.ag/v1/assets/search";

export type Timeframe = "5m" | "30m" | "1h" | "2h" | "4h" | "12h" | "24h";

/* ---------------- HTTP: timeout, jeda per host, retry 429 ---------------- */

const lastCall = new Map<string, Promise<number>>();

/** Antrekan panggilan per host dengan jarak minimum, supaya API gratis tidak kena limit. */
async function pace(host: string, gapMs: number): Promise<void> {
  const prev = lastCall.get(host) ?? Promise.resolve(0);
  const turn = prev.then(async (last) => {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    return Date.now();
  });
  lastCall.set(host, turn.catch(() => Date.now()));
  await turn;
}

export interface HttpOptions {
  gapMs?: number;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

export async function getJson(url: string, o: HttpOptions = {}): Promise<any> {
  const { gapMs = 300, timeoutMs = 15_000, retries = 3, fetchImpl = fetch } = o;
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    await pace(host, gapMs);
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) {
      if (attempt >= retries) throw new Error(`${host}: ${e?.name === "TimeoutError" ? "timeout" : e?.message}`);
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3000 * 2 ** attempt;
      log(`${host} HTTP ${res.status}, coba lagi dalam ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} dari ${host}`);
    return res.json();
  }
}

/* ---------------- Normalisasi ---------------- */

export function normalizeDiscovery(p: any): PoolSummary {
  const warnings = [...(p?.token_x?.warnings ?? []), ...(p?.token_y?.warnings ?? [])];
  const hasWarningsField = Array.isArray(p?.token_x?.warnings) && Array.isArray(p?.token_y?.warnings);
  return {
    pool: p?.pool_address ?? p?.address,
    symbol: p?.token_x?.symbol ?? String(p?.name ?? "?").split("-")[0],
    tokenMint: p?.token_x?.address,
    quoteMint: p?.token_y?.address,
    poolType: p?.pool_type ?? "dlmm",
    tvl: num(p?.tvl),
    fee24h: num(p?.fee),
    vol24h: num(p?.volume),
    binStep: num(p?.dlmm_params?.bin_step),
    price: num(p?.pool_price),
    blacklisted: typeof p?.is_blacklisted === "boolean" ? p.is_blacklisted : undefined,
    hasWarning: hasWarningsField
      ? warnings.some((w: any) => ["critical", "danger", "warning"].includes(w?.severity))
      : undefined,
  };
}

function normalizeStats(s: any): WindowStats | undefined {
  if (!s || typeof s !== "object") return undefined;
  return {
    priceChange: num(s.priceChange),
    liquidityChange: num(s.liquidityChange),
    holderChange: num(s.holderChange),
    buyVolume: num(s.buyVolume),
    sellVolume: num(s.sellVolume),
  };
}

/** Gabungkan baris Meteora (5m + 24h) dengan data token Jupiter. */
export function buildDetail(row5m: any, row24h: any, token: any, feeRecentAs24hPct = NaN): PoolDetail {
  const r = row5m ?? row24h ?? {};
  const a = token?.audit;
  return {
    pool: r.pool_address ?? r.address,
    symbol: token?.symbol ?? r?.token_x?.symbol ?? String(r?.name ?? "?").split("-")[0],
    tokenMint: r?.token_x?.address ?? token?.id,
    binStep: num(r?.dlmm_params?.bin_step),
    priceInSol: num(r?.pool_price),
    tvl: num(row24h?.tvl ?? r.tvl),
    activeTvl: num(r?.active_tvl),
    fee24h: num(row24h?.fee),
    fee5m: num(row5m?.fee),
    feeRecentAs24hPct,
    mcap: num(token?.mcap),
    createdAt: token?.createdAt,
    organicScore: num(token?.organicScore),
    holders: num(token?.holderCount),
    launchpad: token?.launchpad,
    audit: a
      ? {
          mintDisabled: a.mintAuthorityDisabled === true,
          freezeDisabled: a.freezeAuthorityDisabled === true,
          topHoldersPct: num(a.topHoldersPercentage),
          devBalancePct: num(a.devBalancePercentage ?? 0),
          devMints: num(a.devMints ?? 0),
        }
      : undefined,
    stats5m: normalizeStats(token?.stats5m),
    stats1h: normalizeStats(token?.stats1h),
    stats24h: normalizeStats(token?.stats24h),
  };
}

/* ---------------- Klien pasar ---------------- */

export interface ScanQuery {
  minMcap: number;
  minVolume: number;
  pageSize: number;
  category?: string; // mis. "trending"; kosong = semua
}

export interface Market {
  /** Tahap 1: pool DLMM token/SOL dengan aktivitas nyata (timeframe 24 jam). */
  scan(q: ScanQuery): Promise<PoolSummary[]>;
  /** Satu pool di satu jendela waktu (baris mentah Meteora). */
  poolRow(pool: string, tf: Timeframe): Promise<any>;
  /** Data token Jupiter (audit, statistik). */
  token(mint: string): Promise<any>;
}

export class FreeMarket implements Market {
  constructor(private http: HttpOptions = {}) {}

  async scan(q: ScanQuery): Promise<PoolSummary[]> {
    const filters = ["pool_type=dlmm", `base_token_market_cap>=${q.minMcap}`, `volume>=${q.minVolume}`].join("&&");
    const params = new URLSearchParams({ page_size: String(q.pageSize), filter_by: filters, timeframe: "24h" });
    if (q.category) params.set("category", q.category);
    const data = await getJson(`${DISCOVERY}?${params}`, this.http);
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.map(normalizeDiscovery).filter((p: PoolSummary) => p.pool && p.tokenMint && p.quoteMint === SOL_MINT);
  }

  async poolRow(pool: string, tf: Timeframe): Promise<any> {
    const params = new URLSearchParams({ page_size: "1", filter_by: `pool_address=${pool}`, timeframe: tf });
    const data = await getJson(`${DISCOVERY}?${params}`, this.http);
    const row = (Array.isArray(data?.data) ? data.data : []).find((p: any) => p.pool_address === pool);
    if (!row) throw new Error(`data pool ${pool.slice(0, 6)} (${tf}) tidak tersedia`);
    return row;
  }

  async token(mint: string): Promise<any> {
    const list = await getJson(`${JUPITER}?query=${mint}`, this.http);
    const t = (Array.isArray(list) ? list : []).find((x: any) => x?.id === mint);
    if (!t) throw new Error(`data token ${mint.slice(0, 6)} tidak tersedia`);
    return t;
  }
}
