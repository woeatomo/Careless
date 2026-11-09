import { Signer } from "./wallet.js";
import { SOL_MINT, log, num, sleep } from "./util.js";

const API_BASE = "https://api.lpagent.io/open-api/v1";

/* ---------- Bentuk data yang dinormalisasi ---------- */

export interface PoolSummary {
  pool: string;
  symbol: string;
  tokenMint: string;
  quoteMint?: string;
  protocol: string;
  tvl: number;
  fee24h: number;
  fee6h: number;
  fee1h: number;
  vol24h: number;
  mcap: number;
  binStep: number;
  organicScore: number;
  firstPoolCreatedAt?: string;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
}

export interface WindowStats {
  priceChange: number;
  liquidityChange: number;
  holderChange: number;
  buyVolume: number;
  sellVolume: number;
}

export interface PoolDetail {
  pool: string;
  symbol: string;
  activeBin: number;
  binStep: number;
  tvl: number;
  fee24h: number;
  priceInSol: number;
  launchpad?: string;
  firstPoolCreatedAt?: string;
  audit?: {
    mintDisabled: boolean;
    freezeDisabled: boolean;
    topHoldersPct: number;
    devBalancePct: number;
    devMints: number;
  };
  stats5m?: WindowStats;
  stats1h?: WindowStats;
  stats24h?: WindowStats;
}

export interface Position {
  id: string;
  pool: string;
  pair: string;
  protocol: string;
  inRange: boolean;
  lowerBin: number;
  upperBin: number;
  pnlPctSol: number;
  valueSol: number;
  uncollectedFeeSol: number;
  createdAt?: string;
}

/* ---------- Client ---------- */

export class LpAgentApi {
  /** `signer` boleh kosong di mode Lab (paper test): hanya baca data pasar, tanpa transaksi. */
  constructor(private apiKey: string, private signer?: Signer) {}

  get owner(): string {
    if (!this.signer) throw new Error("SOLANA_PRIVATE_KEY dibutuhkan untuk membaca/mengelola posisi wallet");
    return this.signer.owner;
  }

  private sign = (tx: string): string => {
    if (!this.signer) throw new Error("SOLANA_PRIVATE_KEY dibutuhkan untuk mengirim transaksi");
    return this.signer.sign(tx);
  };

  private async call(method: "GET" | "POST", path: string, body?: object, attempt = 0): Promise<any> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = 2000 * 2 ** attempt;
      log(`API ${res.status} di ${path}, coba lagi dalam ${wait / 1000}s`);
      await sleep(wait);
      return this.call(method, path, body, attempt + 1);
    }
    if (!res.ok) throw new Error(`API ${method} ${path} gagal (${res.status}): ${await res.text()}`);
    return res.json();
  }

  async solBalance(): Promise<number> {
    const res = await this.call("GET", `/token/balance?owner=${this.owner}`);
    const sol = (res.data ?? []).find((t: any) => t.tokenAddress === SOL_MINT);
    return sol ? num(sol.balance) : 0;
  }

  async openPositions(): Promise<Position[]> {
    const res = await this.call("GET", `/lp-positions/open?owner=${this.owner}&platform=meteora`);
    return (res.data ?? []).map(normalizePosition);
  }

  /** Pool DLMM diurutkan fee/TVL. Filter detail dilakukan lokal (lihat rules/entry.ts). */
  async discover(pages = 3, pageSize = 10): Promise<PoolSummary[]> {
    const out: PoolSummary[] = [];
    for (let page = 1; page <= pages; page++) {
      const q = new URLSearchParams({
        chain: "SOL",
        platform: "meteora",
        sortBy: "fee_tvl_ratio",
        sortOrder: "desc",
        page: String(page),
        pageSize: String(pageSize),
        min_market_cap: "500000",
        min_liquidity: "20000",
      });
      const res = await this.call("GET", `/pools/discover?${q}`);
      const rows = (res.data ?? []).map(normalizeSummary).filter((p: PoolSummary) => p.pool);
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }

  async poolDetail(poolId: string): Promise<PoolDetail> {
    const res = await this.call("GET", `/pools/${poolId}/info`);
    return normalizeDetail(poolId, res.data ?? res);
  }

  /** Buka posisi SOL-only di bawah harga. Mengembalikan alamat posisi baru. */
  async openBelowPrice(
    pool: string,
    amountSol: number,
    fromBinId: number,
    toBinId: number,
    strategy: string,
    slippageBps: number,
  ): Promise<{ position?: string; signature?: string }> {
    const addTx = await this.call("POST", `/pools/${pool}/add-tx`, {
      stratergy: strategy, // ejaan sesuai API LP Agent
      inputSOL: amountSol,
      percentX: 0,
      fromBinId,
      toBinId,
      owner: this.owner,
      slippage_bps: slippageBps,
      mode: "zap-in",
    });
    const land = await this.call("POST", "/pools/landing-add-tx", {
      lastValidBlockHeight: addTx.data.lastValidBlockHeight,
      swapTxsWithJito: (addTx.data.swapTxsWithJito ?? []).map(this.sign),
      addLiquidityTxsWithJito: (addTx.data.addLiquidityTxsWithJito ?? []).map(this.sign),
      meta: addTx.data.meta,
    });
    return { position: addTx.data.meta?.positionPubKey, signature: land.data?.signature };
  }

  /** Tutup posisi 100% ke SOL (fee ikut ter-claim). */
  async close(positionId: string, slippageBps: number): Promise<string | undefined> {
    const tx = await this.call("POST", "/position/decrease-tx", {
      position_id: positionId,
      bps: 10_000,
      owner: this.owner,
      slippage_bps: slippageBps,
      output: "allBaseToken",
    });
    const land = await this.call("POST", "/position/landing-decrease-tx", {
      lastValidBlockHeight: tx.data.lastValidBlockHeight,
      closeTxs: [],
      swapTxs: [],
      closeTxsWithJito: (tx.data.closeTxsWithJito ?? []).map(this.sign),
      swapTxsWithJito: (tx.data.swapTxsWithJito ?? []).map(this.sign),
    });
    return land.data?.signature;
  }

  async claimFees(positionId: string, slippageBps: number, swapToSol: boolean): Promise<string | undefined> {
    const tx = await this.call("POST", "/position/claim-fee-tx", {
      position_id: positionId,
      owner: this.owner,
      slippage_bps: slippageBps,
      swapToNative: swapToSol,
      type: "meteora",
    });
    const land = await this.call("POST", "/position/landing-claim-fee-tx", {
      lastValidBlockHeight: tx.data.lastValidBlockHeight,
      claimTxsWithJito: (tx.data.claimTxsWithJito ?? []).map(this.sign),
      swapTxsWithJito: (tx.data.swapTxsWithJito ?? []).map(this.sign),
    });
    return land.data?.signature;
  }
}

/* ---------- Normalisasi (API bisa mengirim angka sebagai string) ---------- */

function normalizePosition(p: any): Position {
  const range = Array.isArray(p.range) ? p.range : [];
  return {
    id: p.id ?? p.position ?? p.tokenId,
    pool: p.pool,
    pair: p.pairName ?? `${p.token0Info?.token_symbol}/${p.token1Info?.token_symbol}`,
    protocol: p.protocol ?? "meteora",
    inRange: Boolean(p.inRange ?? p.isInRange),
    lowerBin: num(p.tickLower ?? range[0]),
    upperBin: num(p.tickUpper ?? range[1]),
    pnlPctSol: num(p.pnl?.percentNative ?? p.pnl?.percent),
    valueSol: num(p.valueNative ?? p.current?.amount1Adjusted),
    uncollectedFeeSol: num(p.unCollectedFeeNative ?? 0),
    createdAt: p.createdAt,
  };
}

function normalizeSummary(p: any): PoolSummary {
  return {
    pool: p.pool,
    symbol: p.token0_symbol ?? "?",
    tokenMint: p.token0,
    quoteMint: p.token1,
    protocol: p.protocol,
    tvl: num(p.tvl),
    fee24h: num(p.fee_24h),
    fee6h: num(p.fee_6h),
    fee1h: num(p.fee_1h),
    vol24h: num(p.vol_24h),
    mcap: num(p.mcap),
    binStep: num(p.bin_step),
    organicScore: num(p.organic_score),
    firstPoolCreatedAt: p.first_pool_created_at ?? p.created_at,
    priceChange1h: num(p.price_1h_change),
    priceChange6h: num(p.price_6h_change),
    priceChange24h: num(p.price_24h_change),
  };
}

function normalizeStats(s: any): WindowStats | undefined {
  if (!s) return undefined;
  return {
    priceChange: num(s.priceChange),
    liquidityChange: num(s.liquidityChange),
    holderChange: num(s.holderChange),
    buyVolume: num(s.buyVolume),
    sellVolume: num(s.sellVolume),
  };
}

function normalizeDetail(poolId: string, d: any): PoolDetail {
  const stats = d.poolStats ?? d.poolDb ?? d;
  const token = d.tokenInfo?.[0]?.data?.[0];
  const audit = token?.audit;
  return {
    pool: poolId,
    symbol: token?.symbol ?? stats.token0_symbol ?? "?",
    activeBin: num(d.liquidityViz?.activeBin ?? d.activeBinId),
    binStep: num(d.binStep ?? stats.bin_step),
    tvl: num(stats.tvl),
    fee24h: num(stats.fee_24h),
    priceInSol: num(stats.base_price),
    launchpad: token?.launchpad,
    firstPoolCreatedAt: token?.firstPool?.createdAt ?? stats.first_pool_created_at,
    audit: audit
      ? {
          mintDisabled: audit.mintAuthorityDisabled === true,
          freezeDisabled: audit.freezeAuthorityDisabled === true,
          topHoldersPct: num(audit.topHoldersPercentage),
          devBalancePct: num(audit.devBalancePercentage ?? 0),
          devMints: num(audit.devMints ?? 0),
        }
      : undefined,
    stats5m: normalizeStats(token?.stats5m),
    stats1h: normalizeStats(token?.stats1h),
    stats24h: normalizeStats(token?.stats24h),
  };
}
