import { log } from "./util.js";

export type CommandHandler = (cmd: string, args: string[]) => Promise<string>;

/** Notifikasi ke Telegram/Discord + perintah Telegram (hanya dari chat id yang diizinkan). */
export class Notifier {
  constructor(
    private telegramToken?: string,
    private telegramChatId?: string,
    private discordWebhook?: string,
  ) {}

  get hasTelegram() {
    return Boolean(this.telegramToken && this.telegramChatId);
  }

  async send(text: string): Promise<void> {
    log(`NOTIF: ${text.replace(/\n/g, " | ")}`);
    const jobs: Promise<unknown>[] = [];
    if (this.hasTelegram)
      jobs.push(
        fetch(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.telegramChatId, text, disable_web_page_preview: true }),
        }),
      );
    if (this.discordWebhook)
      jobs.push(
        fetch(this.discordWebhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text.slice(0, 1900) }),
        }),
      );
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === "rejected") log(`Notifikasi gagal: ${r.reason}`);
  }

  /** Ambil perintah baru dari Telegram. Mengembalikan offset terbaru. */
  async pollCommands(offset: number | undefined, handle: CommandHandler): Promise<number | undefined> {
    if (!this.hasTelegram) return offset;
    const url = `https://api.telegram.org/bot${this.telegramToken}/getUpdates?timeout=0${
      offset !== undefined ? `&offset=${offset}` : ""
    }`;
    const res = await fetch(url);
    if (!res.ok) return offset;
    const body: any = await res.json();
    let next = offset;
    for (const u of body.result ?? []) {
      next = u.update_id + 1;
      const msg = u.message;
      if (!msg?.text || String(msg.chat?.id) !== String(this.telegramChatId)) continue;
      const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
      const cmd = rawCmd.replace(/^\//, "").replace(/@.*$/, "").toLowerCase();
      try {
        await this.send(await handle(cmd, args));
      } catch (e: any) {
        await this.send(`Perintah /${cmd} gagal: ${e.message}`);
      }
    }
    return next;
  }
}
