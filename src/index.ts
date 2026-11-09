import { loadConfig, loadEnv } from "./config.js";
import { FreeMarket } from "./sources.js";
import { Lab } from "./lab.js";
import { Notifier } from "./notify.js";
import { Store } from "./state.js";
import { log, sleep } from "./util.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* .env opsional */
}

async function main() {
  const cfg = loadConfig();
  const env = loadEnv();
  const store = new Store(env.dataDir);
  const notifier = new Notifier(env.telegramToken, env.telegramChatId, env.discordWebhook);
  const market = new FreeMarket({ gapMs: cfg.http.gap_ms, timeoutMs: cfg.http.timeout_ms });
  const lab = new Lab(cfg, market, store, notifier);
  const names = cfg.lab.experiments.map((x) => x.name).join(", ");

  log(`=== Careless LP Bot — PAPER TEST (Meteora + Jupiter, tanpa transaksi) ===`);
  log(`Eksperimen: ${names}`);

  if (process.argv.includes("--once")) {
    await lab.tick();
    store.save();
    console.log(lab.compareText());
    console.log(lab.positionsText());
    return;
  }

  await notifier.send(`🧪 Paper test jalan: ${names}. Ketik /compare kapan saja.`);

  let stopping = false;
  const stop = () => {
    stopping = true;
    store.save();
    log("Berhenti, state tersimpan.");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const handle = async (cmd: string): Promise<string> => {
    switch (cmd) {
      case "compare":
      case "status":
        return lab.compareText();
      case "positions":
        return lab.positionsText();
      case "pause":
        store.state.manualPause = true;
        store.save();
        return "⏸️ Tidak buka posisi paper baru. Posisi yang ada tetap dikelola. /resume untuk lanjut.";
      case "resume":
        store.state.manualPause = false;
        store.save();
        return "▶️ Lanjut buka posisi paper sesuai aturan.";
      default:
        return "Perintah: /compare /positions /pause /resume";
    }
  };

  if (notifier.hasTelegram)
    (async () => {
      while (!stopping) {
        try {
          store.state.telegramOffset = await notifier.pollCommands(store.state.telegramOffset, (c) => handle(c));
        } catch (e: any) {
          log(`Telegram: ${e.message}`);
        }
        await sleep(cfg.intervals.telegram_poll_sec * 1000);
      }
    })();

  while (!stopping) {
    const started = Date.now();
    try {
      await lab.tick();
      store.save();
    } catch (e: any) {
      log(`ERROR siklus: ${e.message}`);
    }
    await sleep(Math.max(5_000, cfg.intervals.manage_sec * 1000 - (Date.now() - started)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
