import type { Config } from "../config.js";
import type { PoolDetail } from "../api.js";

export interface RugResult {
  hard: string[];
  soft: string[];
  trigger: boolean;
}

/**
 * Deteksi rug dari statistik token LP Agent (jendela 5 menit dan 1 jam).
 * Hard trigger: satu cukup. Soft signal: butuh `soft_required` sekaligus.
 * Catatan: penjualan dev/top holder per wallet belum dipantau (butuh data on-chain).
 */
export function rugCheck(d: PoolDetail, cfg: Config): RugResult {
  const g = cfg.rug_guard;
  const hard: string[] = [];
  const soft: string[] = [];

  const liq5 = d.stats5m?.liquidityChange;
  if (liq5 !== undefined && liq5 <= -g.liquidity_drop_5m_pct) hard.push(`likuiditas ${liq5.toFixed(0)}% dalam 5m`);
  const liq1h = d.stats1h?.liquidityChange;
  if (liq1h !== undefined && liq1h <= -g.liquidity_drop_1h_pct) hard.push(`likuiditas ${liq1h.toFixed(0)}% dalam 1j`);
  if (g.exit_on_authority_change && d.audit && !(d.audit.mintDisabled && d.audit.freezeDisabled))
    hard.push("mint/freeze authority aktif");

  const s1 = d.stats1h;
  if (s1 && s1.buyVolume + s1.sellVolume > 0) {
    const sellShare = (s1.sellVolume / (s1.buyVolume + s1.sellVolume)) * 100;
    if (sellShare >= g.sell_share_1h_pct) soft.push(`jual ${sellShare.toFixed(0)}% volume 1j`);
  }
  const p5 = d.stats5m?.priceChange;
  if (p5 !== undefined && p5 <= -g.price_drop_5m_pct) soft.push(`harga ${p5.toFixed(0)}% dalam 5m`);
  const h1 = s1?.holderChange;
  if (h1 !== undefined && h1 <= -g.holder_drop_1h_pct) soft.push(`holder ${h1.toFixed(1)}% dalam 1j`);

  return { hard, soft, trigger: hard.length > 0 || soft.length >= g.soft_required };
}
