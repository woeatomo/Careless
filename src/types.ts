/** Statistik token per jendela waktu (dari Jupiter). */
export interface WindowStats {
  priceChange: number;
  liquidityChange: number;
  holderChange: number;
  buyVolume: number;
  sellVolume: number;
}

/** Tahap 1 screening: satu baris pool dari Meteora Pool Discovery (timeframe 24 jam). */
export interface PoolSummary {
  pool: string;
  symbol: string;
  tokenMint: string;
  quoteMint: string;
  poolType: string;
  tvl: number; // USD
  fee24h: number; // USD, fee 24 jam
  vol24h: number; // USD
  binStep: number;
  price: number; // harga token dalam SOL
  blacklisted: boolean | undefined;
  hasWarning: boolean | undefined;
}

/** Data lengkap satu pool + tokennya (Meteora + Jupiter), dipakai audit, rug guard, dan exit. */
export interface PoolDetail {
  pool: string;
  symbol: string;
  tokenMint: string;
  binStep: number;
  priceInSol: number;
  tvl: number;
  activeTvl: number;
  fee24h: number;
  fee5m: number;
  /** Laju fee terkini disetarakan ke 24 jam (fee 4 jam x 6 / TVL), dalam persen. NaN = belum diambil. */
  feeRecentAs24hPct: number;
  mcap: number;
  createdAt?: string;
  organicScore: number;
  holders: number;
  launchpad?: string;
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
