export const SOL_MINT = "So11111111111111111111111111111111111111112";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Angka dari string/number API; NaN jika tidak ada. */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Jam sekarang di Asia/Jakarta (0-23). */
export function hourWIB(date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    hour12: false,
  }).format(date);
  return Number(h) % 24;
}

/** True jika jam berada di jendela [start, end), mendukung jendela melewati tengah malam. */
export function inHourWindow(hour: number, [start, end]: [number, number]): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export const minutesSince = (iso: string | undefined, now = Date.now()) =>
  iso ? (now - Date.parse(iso)) / 60_000 : Infinity;

export const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "?");
