# Careless LP Bot

Bot LP Meteora DLMM dengan **strategi Careless**, dibangun di atas arsitektur bot **meridianEvPANDA**: daemon standalone, eksekusi lokal pakai Meteora SDK, shadow mode + paper trading, admin Telegram, dan CLI yang sama. Lapisan strategi EvilPanda diganti `careless/`. Aturannya deterministik, tanpa LLM, tanpa API berbayar.

## Alur Careless

1. **Kandidat** dari screener Meteora Pool Discovery tiap 5 menit (mcap ≥ $1M, volume pool ≥ $10K, timeframe 24 jam), urut fee/TVL 24 jam tertinggi. Ditambah mint di `careless.whitelistMints` (token narasi kuat).
2. **Screening token** (Jupiter): launchpad pump.fun, umur ≥ 3 hari, mcap ≥ $1M, **ranging** (|harga 24 jam| ≤ 20%), tidak pump > 50% dalam 1 jam, top 10 holder < 30%, dev ≤ 5%, mint/freeze revoked, likuiditas 24 jam tidak anjlok > 30%. Lalu Rugcheck (skor, risiko danger) dan GMGN (dilewati kalau `GMGN_API_KEY` kosong). Whitelist melewati syarat umur, mcap, launchpad, dan ranging, tapi tidak melewati cek keamanan.
3. **Pool**: pool DLMM token/SOL dengan TVL ≥ $30K, bin step 80–250, **fee/TVL 24 jam ≥ 5%**, tanpa peringatan Meteora. Bin step tertinggi didahulukan, karena range -80% butuh lebih sedikit bin.
4. **Masuk langsung** selama slot masih kosong (tanpa sinyal chart). Harga dicek ulang sebelum submit (batal kalau bergerak > 5%).
5. **Posisi**: SOL-only, **Spot 0% s/d -80%**, maksimal 5 × 0,2 SOL. Kalau range butuh bin array yang belum ada, range dipendekkan ke bin array yang sudah ada, jadi **rent bin array tidak pernah dibayar**. Pool yang hasilnya lebih dangkal dari -50% dilewati.
6. **Exit** (yang duluan kena):
   - **Stop loss -15%** (proteksi hard rug). Dicek tiap 3 detik, butuh 2 tick konfirmasi.
   - **OOR kanan**: tutup setelah 30 menit, hanya kalau PnL positif. Kalau negatif, ditahan sampai harga balik atau SL.
   - **OOR kiri / slow rug**: tutup setelah 60 menit.
   - **Rug guard** (tiap siklus manajemen): likuiditas turun ≥ 15% dalam 5 menit atau ≥ 30% dalam 1 jam, authority aktif lagi, atau dua sinyal lunak sekaligus (jual ≥ 75% volume 1 jam, harga -20% dalam 5 menit, holder -5% dalam 1 jam).
   - **Review pagi 06.00 WIB**: tutup kalau fee/TVL 24 jam < 5% atau harga 24 jam < -20%. Kalau masih sehat, **claim fee saja** dan posisi tetap jalan. Tanpa take profit dan tanpa rebalance.
7. **Cooldown re-entry tergantung hasil**: 1 jam setelah close profit, 6 jam setelah close flat/rugi, 24 jam setelah stop loss atau rug guard.
8. **Track record per pool** (paper + live, 14 hari terakhir): pool dengan ≥ 2 close dan rata-rata net PnL positif jadi **proven** dan didahulukan saat entry. Pool yang rugi 2× berturut-turut di-skip 48 jam. Dasarnya data HALO (1,7 juta posisi DLMM): LP yang untung terus farming ulang pool yang sudah terbukti, dan win rate hampir tidak membedakan mereka. Cooldown "repeat fee-generating deploys" dimatikan (`repeatDeployCooldownEnabled: false`) karena justru menghukum re-entry yang profit.

Semua ambang ada di blok `careless` di `user-config.json` (lihat `user-config.example.json`; default lengkap di `buildCarelessConfig` di `config.js`).

## Paper trading (shadow mode)

Dengan `shadowMode: true` (default), setiap entry yang *akan* dilakukan dibuka sebagai **posisi paper**. Posisinya dihargai tiap menit dari data Meteora dan ditutup dengan aturan exit yang sama. Wallet tidak disentuh sama sekali.

```sh
node cli.js paper          # hasil paper: total PnL, fee kept %, median hold, re-entry vs entry pertama, per aturan exit
node cli.js track          # track record per pool (⭐ proven / baru / ⛔ losing streak)
node cli.js candidates     # token yang sudah di-screen dan alasan lolos/gagal
node cli.js screen --mint ADDRESS   # screen satu token (read-only, tidak pernah deploy)
```

Di Telegram: `/paper`, `/candidates`, `/status`, `/menu` (ubah setting langsung dari chat).

Model paper (dari simulator meridian): posisi dihitung per bin sesuai bin step pool. Fee = fee pool 5 menit ÷ active TVL × likuiditas kita di ±3 bin dari harga. Saat tutup dipotong slippage 1% atas bagian token dan biaya transaksi 0,003 SOL. Angkanya estimasi, bukan janji hasil.

Angka utama yang dilihat: **fee kept %** = net PnL ÷ fee yang didapat. Positif berarti fee masih tersisa setelah IL dan biaya (pemenang di data HALO ~40%); negatif berarti harga makan lebih dari semua fee. Win rate sendiri bukan penentu.

Strategi lain bisa dites bergantian lewat config (mis. `careless.position.strategy: "bid_ask"` atau `downsidePct: 50`), lalu bandingkan hasil `node cli.js paper`.

## Setup di VPS (berdampingan dengan bot meridian)

Bot ini berdiri sendiri: folder, `.env`, `user-config.json`, file state, lock, dan nama PM2 (`careless`) terpisah dari bot meridian.

```sh
cd ~
git clone https://github.com/woeatomo/Careless.git careless-bot
cd careless-bot
bash scripts/setup-vps.sh      # Node, pm2, npm install, npm test, buat user-config.json + .env
nano .env                      # RPC_URL, WALLET_ADDRESS, TELEGRAM_BOT_TOKEN (bot BARU), TELEGRAM_CHAT_ID
npm run pm2:start              # PM2 name: careless
npm run pm2:logs
```

Jangan isi `WALLET_PRIVATE_KEY` selama paper test. Token Telegram harus dari **bot baru**: dua proses yang membaca token yang sama akan rebutan perintah.

## Ke live

Setelah hasil paper bagus (saran: ≥ 7 hari, ≥ 20 posisi tutup):

1. Isi `WALLET_PRIVATE_KEY` di `.env` (atau `/menu` → 🔑 Bot key di Telegram). Isi wallet hanya dengan modal LP.
2. `shadowMode: false` di `user-config.json` (atau tombol 🌑 Shadow di `/menu`).
3. `npm run pm2:restart`.

## Perintah

```sh
node cli.js help
node cli.js positions | balance | pool --pool ADDRESS | config
node cli.js close --position ADDRESS | claim --position ADDRESS
node cli.js blacklist add --mint ADDRESS
npm test
```

## Catatan

- **Deploy gates** di level atas `user-config.json` (`minTvl`, `maxTvl`, `minBinStep`, `maxBinStep`, `timeframe`, `minFeeActiveTvlRatio`) dicek ulang oleh executor tepat sebelum deploy. Jaga agar tidak lebih ketat dari `careless.pool`.
- Rug guard memakai statistik token Jupiter (5 menit / 1 jam), dicek tiap siklus manajemen (default 10 menit). Stop loss tetap dicek tiap 3 detik.
- Range -80% di bin step 100 butuh 162 bin. Tergantung bin array yang sudah ada, range bisa dipendekkan (posisi tetap dibuka kalau masih ≥ -50%).
- LP tetap berisiko: impermanent loss, rug, dan risiko smart contract.
