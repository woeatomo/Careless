# Careless LP Bot — Paper Test

Bot untuk **menguji strategi LP Meteora DLMM secara paper** sebelum dipakai dengan uang sungguhan. Data diambil langsung dari **Meteora Pool Discovery** dan **Jupiter** (endpoint yang sama dengan bot meridianEvPANDA): gratis, tanpa API key, tanpa private key, dan tidak pernah mengirim transaksi.

Tujuannya: memilih versi Careless terbaik untuk dipakai live. EvilPanda ikut berjalan sebagai pembanding saja.

## Strategi yang dibandingkan

Setiap eksperimen punya modal virtual sendiri (default 1,5 SOL) dan memakai data pasar yang sama.

| Eksperimen | Posisi | Token |
| --- | --- | --- |
| `careless` | Spot, SOL-only 0% s/d -80%, 5 × 0,2 SOL | pump.fun, umur ≥ 3 hari, mcap ≥ $1M, TVL ≥ $30K, ranging 24 jam (±20%), fee/TVL 24j ≥ 5% |
| `careless_bidask` | sama, shape Bid-Ask | sama |
| `careless_50` | sama, range 0% s/d -50% | sama |
| `evilpanda` | Bid-Ask, 0% s/d -30%, 3 × 0,4 SOL | fee/TVL 24j ≥ 10%, fee 4 jam terakhir (setara 24j) ≥ 8%, organic ≥ 70 |

Aturan keluar:

| | Careless | EvilPanda |
| --- | --- | --- |
| Stop loss | -15% (termasuk fee) | -15% |
| Ambil profit | review pagi 06.00 WIB: tutup kalau fee/TVL 24j < 5% atau harga 24j < -20% | trailing: aktif +5%, tutup kalau turun 3 poin |
| Fee/TVL < 10% selama 60 menit | tidak berlaku | tutup |
| Keluar range ke atas / bawah | tutup setelah 15 / 30 menit | tutup setelah 15 / 30 menit |
| Rug guard | likuiditas ditarik, authority aktif, atau 2 sinyal lunak | sama |

Rem: eksperimen berhenti buka posisi 24 jam setelah 3 stop-out (SL/rug) berturut-turut, atau rugi harian ≥ 10%.

**Whitelist narasi** (`whitelist_mints`): token pilihan boleh melewati syarat umur, mcap, launchpad, dan ranging. Audit token dan rug guard tetap berlaku.

Ubah atau tambah eksperimen di `lab.experiments` di `config/strategy.yaml`. Bagian config jalur mana pun bisa di-override.

## Cara kerja

| Siklus | Default | Isi |
| --- | --- | --- |
| Kelola posisi | 90 detik | harga + fee 5 menit dari Meteora, statistik token dari Jupiter → rug guard, SL, TP, OOR, review pagi |
| Screening | 10 menit | **tahap 1** scan Meteora (fee/TVL, TVL, bin step, blacklist, peringatan) → **tahap 2** audit token Jupiter + syarat jalur, maks 8 audit per screening |
| Laporan | 07.00 WIB | tabel perbandingan ke Telegram/Discord |

Data yang hilang tidak pernah dianggap aman: pool atau token tanpa data audit ditolak, dan posisi yang harganya sesaat tidak tersedia dilewati (tidak ditutup).

### Model paper

Port dari simulator meridianEvPANDA (`evilpanda/sim.js`):

- Posisi = bin nyata sesuai bin step pool. Spot rata per bin, Bid-Ask makin tebal ke bawah.
- **Nilai (IL):** bin yang sudah dilewati harga dianggap sudah berubah jadi token di harga bin itu.
- **Fee:** fee pool 5 menit ÷ active TVL × likuiditas kita di ±3 bin dari harga. Range lebih lebar berarti likuiditas per bin lebih tipis, jadi fee per SOL lebih kecil. Posisi di luar range tidak dapat fee. Maksimal 15 menit dihitung per update, supaya bot yang mati lama tidak mendapat fee fiktif.
- **Saat tutup:** dipotong slippage 1% atas bagian token dan biaya transaksi 0,003 SOL.

Angka absolutnya tetap estimasi. Yang paling berguna adalah **perbandingan antar strategi**.

## Instal di VPS (berdampingan dengan bot lain)

Butuh Node.js 20+. Kalau bot lain (mis. meridianEvPANDA) memakai Node lama, cek dulu `node -v` sebelum mengganti versi global.

```bash
cd ~
git clone https://github.com/woeatomo/Careless.git careless-bot
cd careless-bot
npm install
cp .env.example .env && chmod 600 .env
nano .env        # opsional: token bot Telegram BARU + chat id
npm test         # 24 test
npm run once     # satu siklus + tabel perbandingan
```

Jalankan terus dengan PM2 (batasi memori untuk VPS kecil):

```bash
pm2 start npm --name careless-bot --max-memory-restart 300M -- start
pm2 save
pm2 ls           # kedua bot harus online
```

Bot ini berdiri sendiri: folder, `.env`, `data/`, dan nama proses PM2 terpisah dari bot lain.

Telegram: buat bot di @BotFather → isi `TELEGRAM_BOT_TOKEN` → kirim pesan ke bot → ambil `chat.id` dari `https://api.telegram.org/bot<TOKEN>/getUpdates` → isi `TELEGRAM_CHAT_ID`. Perintah: `/compare`, `/positions`, `/pause`, `/resume`.

## Membaca hasil

- `/compare` kapan saja, atau `npm run once`.
- `data/journal.jsonl`: setiap audit (`lab_audit`, lengkap dengan alasan tolak), buka (`lab_open`), dan tutup (`lab_close`).
- Kalau log terus menulis `Scan (semua, ...): 0 pool`, isi `tracks.careless.scan.category: trending`.

Saran: jalankan minimal 7 hari, sampai tiap strategi punya ≥ 20 posisi tutup. Lihat return, win rate, jumlah SL/rug, dan drawdown, bukan cuma return.

## Ke live (berikutnya)

Mode live belum tersedia (`mode.dry_run: false` sengaja ditolak). Setelah ada pemenang, eksekusi Careless akan di-port dari `tools/dlmm.js` meridianEvPANDA: Meteora SDK, posisi lebar > 69 bin, dan pemendekan range supaya tidak membayar rent bin array. EvilPanda tetap paper.

## Struktur

```
config/strategy.yaml    semua ambang, per jalur + daftar eksperimen
src/index.ts            loop utama + perintah Telegram
src/lab.ts              paper test banyak strategi + metrik + laporan
src/sources.ts          Meteora Discovery + Jupiter (timeout, jeda per host, retry 429)
src/paper.ts            simulator posisi DLMM berbasis bin
src/rules/entry.ts      screening tahap 1 + audit tahap 2
src/rules/exit.ts       keputusan tutup (fungsi murni) + review pagi
src/rules/rug.ts        deteksi rug
src/rules/risk.ts       hitungan stop-out
src/state.ts            state.json + journal.jsonl
test/                   test aturan, simulator, normalisasi data, Lab
```
