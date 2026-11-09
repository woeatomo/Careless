# Careless × EvilPanda LP Bot

Bot LP Meteora DLMM yang jalan di VPS lewat **LP Agent Open API**. Dua jalur strategi berjalan bersama:

| | **Careless (utama)** | **EvilPanda (sampingan)** |
| --- | --- | --- |
| Slot | 5 × 0,2 SOL | 1 × 0,2 SOL |
| Token | pump.fun, umur ≥ 3 hari, mcap ≥ $1M, TVL ≥ $30K | umur ≥ 6 jam, mcap ≥ $500K, organic ≥ 70 |
| Syarat harga | ranging 24 jam (±20%) | tidak pump > 50% dalam 1 jam |
| Fee/TVL 24j | ≥ 5% | ≥ 10% + laju 6 jam ≥ 8% |
| Posisi | Spot, 0% s/d -80% (SOL-only) | Bid-Ask, 0% s/d -30% (SOL-only) |
| Ambil profit | review pagi (manual/Claude) + claim fee jam 06.00 WIB | trailing TP: aktif +5%, tutup jika turun 3 poin |
| Fee/TVL < 10% selama 60m | tidak berlaku | tutup |
| OOR kanan / kiri | tutup (15m / 30m) | tutup (15m / 30m) |
| Hard rug | SL -15% + rug guard | SL -15% + rug guard |

Careless paling bagus dengan banyak posisi kecil, karena IL satu posisi tertutup fee dari posisi lain. Tiap screening, slot Careless diisi duluan.

**Whitelist narasi** (`whitelist_mints`): token pilihan boleh melewati syarat umur, mcap, launchpad, dan ranging. Audit dan rug guard tetap berlaku.

Default-nya **paper trading** (`mode.dry_run: true`): bot memantau dan mensimulasikan posisi tanpa transaksi.

## Siklus

| Siklus | Default | Isi |
| --- | --- | --- |
| Kelola posisi | 90 detik | rug guard → SL → trailing TP → fee/TVL floor → OOR → claim fee |
| Screening | 10 menit | discover → filter per jalur → audit maks 3 kandidat → buka / usulkan |
| Telegram | 5 detik | `/status` `/approve <id>` `/reject <id>` `/pause` `/resume` |

Mode buka posisi (`mode.open_mode`): `propose` (usulan ke Telegram, otomatis di jam 22.00–06.00 WIB), `auto`, atau `off`.

Rem risiko: jeda 24 jam setelah 3 stop-out (SL/rug) berturut-turut, atau rugi harian ≥ 10%. Penutupan rutin (OOR, TP) tidak dihitung.

## Setup di VPS

Butuh Node.js 20+ (disarankan 22).

```bash
git clone https://github.com/woeatomo/Careless.git && cd Careless
npm install
cp .env.example .env && chmod 600 .env
nano .env   # LP_AGENT_API_KEY, SOLANA_PRIVATE_KEY, Telegram (opsional)
npm test    # 18 test aturan strategi
npm run once   # satu siklus, tetap paper — cek log
```

Jalankan terus dengan PM2:

```bash
npm install -g pm2
pm2 start npm --name careless-bot -- start
pm2 save && pm2 startup
pm2 logs careless-bot
```

Telegram: buat bot di @BotFather → isi `TELEGRAM_BOT_TOKEN` → kirim pesan ke bot → ambil `chat.id` dari `https://api.telegram.org/bot<TOKEN>/getUpdates` → isi `TELEGRAM_CHAT_ID`. Bot hanya menerima perintah dari chat id itu.

## Dari paper ke live

1. Paper minimal 3–5 hari. Semua keputusan ada di `data/journal.jsonl`.
2. Evaluasi per jalur: win rate, fee vs kerugian stop-out, alasan exit terbanyak.
3. Ubah `mode.dry_run: false`, `pm2 restart careless-bot`. Mulai dengan `open_mode: propose`.

## Keamanan

- `SOLANA_PRIVATE_KEY` mengendalikan wallet. Isi wallet hanya dengan modal LP, `chmod 600 .env`, jangan commit `.env`.
- Pakai SSH key dan firewall di VPS.
- Posisi tetap tampil di app LP Agent. Untuk posisi Careless, matikan TP server LP Agent (default akun +5%) supaya tidak menutup posisi lebih awal.

## Batasan

- **Belum diuji ke API sungguhan.** Kode mengikuti contoh resmi LP Agent (add-tx, decrease-tx, claim-fee-tx, landing Jito), tapi beberapa nama field diambil dari dokumentasi dan output MCP. Jalankan `npm run once` dalam mode paper dulu.
- **Range -80% butuh banyak bin** (162 bin di bin step 100, 65 bin di bin step 250). Kalau API menolak posisi selebar itu, isi `tracks.careless.position.max_bins` (mis. 69) supaya bot hanya memilih pool dengan bin step besar. Pembuatan bin array baru bisa memakan rent yang tidak kembali.
- **"Ranging" memakai perubahan harga 24 jam** dari data LP Agent; screener eksternal (mis. sorcxsolana.xyz) belum disambungkan.
- **Rug guard memakai statistik token LP Agent** (likuiditas, harga, holder, volume beli/jual per 5 menit dan 1 jam). Penjualan dev per wallet belum dipantau.
- **Model paper itu estimasi kasar** (nilai posisi dari model shape, fee dari laju fee pool × `paper.fee_capture_factor`).
- LP tetap berisiko: impermanent loss, rug, dan risiko smart contract.

## Struktur

```
config/strategy.yaml    semua ambang, per jalur
src/index.ts            loop utama + perintah Telegram
src/bot.ts              kelola posisi, paper, screening per jalur, usulan
src/api.ts              client LP Agent Open API + normalisasi data
src/rules/entry.ts      filter pool + audit token
src/rules/exit.ts       keputusan tutup/claim (fungsi murni)
src/rules/rug.ts        deteksi rug
src/rules/risk.ts       rem risiko + ukuran posisi
src/paper.ts            model nilai Spot/Bid-Ask untuk paper trading
src/state.ts            state.json + journal.jsonl
test/rules.test.ts      test aturan
```
