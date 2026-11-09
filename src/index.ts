import { loadConfig, loadEnv } from "./config.js";
import { LpAgentApi } from "./api.js";
import { Bot } from "./bot.js";
import { Notifier } from "./notify.js";
import { Store } from "./state.js";
import { Signer } from "./wallet.js";
import { log, sleep } from "./util.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* .env opsional jika variabel sudah di-set di environment */
}

async function main() {
  const cfg = loadConfig();
  const env = loadEnv();
  const signer = new Signer(env.privateKey);
  const api = new LpAgentApi(env.apiKey, signer);
  const store = new Store(env.dataDir);
  const notifier = new Notifier(env.telegramToken, env.telegramChatId, env.discordWebhook);
  const bot = new Bot(cfg, api, store, notifier);

  log(`=== LP Agent EvilPanda Bot === wallet ${signer.owner}`);
  log(`Mode ${bot.lab ? `LAB (${cfg.lab!.experiments.map((x) => x.name).join(", ")})` : cfg.mode.dry_run ? "PAPER (tanpa transaksi)" : "LIVE"} | buka posisi: ${cfg.mode.open_mode}`);

  if (process.argv.includes("--once")) {
    await bot.tick();
    if (bot.lab) console.log(bot.lab.compareText());
    return;
  }

  await notifier.send(
    bot.lab
      ? `🧪 Paper test jalan: ${cfg.lab!.experiments.map((x) => x.name).join(", ")}. Ketik /compare kapan saja.`
      : `🤖 Bot jalan — mode ${cfg.mode.dry_run ? "PAPER" : "LIVE"}, buka posisi: ${cfg.mode.open_mode}`,
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
    store.save();
    log("Berhenti, state tersimpan.");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Perintah Telegram berjalan terpisah dari siklus utama.
  if (notifier.hasTelegram)
    (async () => {
      while (!stopping) {
        try {
          store.state.telegramOffset = await notifier.pollCommands(store.state.telegramOffset, (c, a) =>
            bot.handleCommand(c, a),
          );
        } catch (e: any) {
          log(`Telegram: ${e.message}`);
        }
        await sleep(cfg.intervals.telegram_poll_sec * 1000);
      }
    })();

  while (!stopping) {
    try {
      await bot.tick();
    } catch (e: any) {
      log(`ERROR siklus: ${e.message}`);
    }
    await sleep(cfg.intervals.manage_sec * 1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
