import type { ClosedRecord } from "../state.js";

/** Penutupan yang dihitung sebagai "kena": SL atau rug. Penutupan rutin (OOR, review, TP) tidak. */
export const isStopOut = (c: ClosedRecord) => /^(SL|RUG)/.test(c.reason) || c.pnlPct <= -10;

/** Jumlah stop-out berturut-turut paling akhir (penutupan untung memutus hitungan). */
export function consecutiveStopOuts(closed: ClosedRecord[]): number {
  let n = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    const c = closed[i];
    if (isStopOut(c)) n++;
    else if (c.pnlPct >= 0) break;
  }
  return n;
}

/** Tanggal WIB (YYYY-MM-DD). */
export const dateWIB = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(d);
