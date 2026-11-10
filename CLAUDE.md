# Careless engineering guide

The app is the standalone bot from meridianEvPANDA with the Careless strategy layer (`careless/`) in place of the EvilPanda layer. Entries come only from the Careless screener (plus `careless.whitelistMints`); there is no wallet-convergence path, no smart-wallet watchlist, no candles and no LLM.

## Entry points and modules

- `index.js`: daemon startup.
- `cli.js`: read commands (`screen --mint`, `candidates`, `paper`, positions, pool, config…) and manual close/claim/swap; `start` launches the daemon. The CLI never deploys.
- `setup.js`: configuration wizard; enables shadow mode.
- `standalone/runtime.js`: process lock, Careless engine start, deterministic management cycle (fast rules, rug guard, morning review, claims), fast PnL poller, heartbeat.
- `standalone/store.js`: persisted entry-attempt records (mint-level duplicate protection, crash recovery).
- `standalone/screening.js`: deploy-gate helpers (`poolDetail`, `checkMintOnChain`, legacy `rejectToken`/`rejectPool`).
- `standalone/balances.js`, `standalone/rpc.js`: standard RPC balances, cached prices, read fallback.
- `standalone/transactions.js`: in-process priority queue for wallet writes; exits precede queued entries.
- `standalone/telegram-admin.js`: Telegram settings console (`careless.*` settings are written as nested user-config keys), `/status`, `/paper`, `/candidates`.
- `tools/executor.js`: deploy/close/claim/swap dispatch, transaction preflight checks (deploy gates from `config.screening`), notifications, post-close swaps.
- `tools/dlmm.js`: local Meteora SDK transactions and Meteora position/PnL reads. Preserve lazy SDK loading, position cache invalidation, and pool-rent checks.
- `tools/pnl.js`, `tools/wallet.js`: optional on-chain PnL engine; balances and Jupiter swaps.
- `state.js`, `performance.js`, `pool-memory.js`, `token-blacklist.js`, `dev-blocklist.js`: position tracking, history, cooldowns and safety filters.
- `telegram.js`: notifications and the admin polling transport.

## Careless modules

- `careless/filters.js`, `exits.js`, `range.js`, `sim.js`: pure rule code, covered by `test/careless.test.js`.
- `careless/sources.js`: read-only HTTP adapters (Jupiter, Rugcheck, GMGN, Meteora Pool Discovery and DLMM API).
- `careless/engine.js`: screener → screening → entries; fast and slow exits; paper trading; state in `careless-state.json` (candidates, live position records, re-entry cooldowns).
- `careless/paper.js`: shadow-mode simulated positions (`careless-paper.json`).

## Invariants

- Entries require a candidate that passed the full Careless screen, a fresh price read, and the `before_submit` price-move recheck. The CLI never deploys.
- `shadowMode` forces `DRY_RUN=true` across transaction paths; every would-be entry becomes a paper position.
- Missing data must not be interpreted as empty positions, spendable funds, or a safe token. A paper mark without a price is skipped, never closed.
- Keep entry screening independent of exit polling. Serialize wallet mutations through the existing queue.
- Preserve `before_submit` and `on_prepared` hooks and persisted attempt recovery.
- Read fresh positions and funds before deployment. Preserve position limits, duplicate guards, re-entry cooldowns, range floors, and bin-array initialization checks.
- The `minBinsBelow` floor is 35. Only token-X / SOL-token-Y pools are supported for execution.
- Range shrinking (`shrink_to_initialized`) must only ever shorten a range to existing bin arrays; never pay bin-array rent.
- Deploy gates in `config.screening` (minTvl, maxTvl, bin steps, timeframe, minFeeActiveTvlRatio) must stay at least as loose as `careless.pool`, or the executor refuses Careless entries.
- Do not edit user secrets or runtime state as part of routine refactors.

## Configuration and state

`config.js` loads `user-config.json` once; `buildCarelessConfig` documents every `careless.*` default. Restart after changes. Secrets belong in environment variables or `.env`; never commit them. Keep existing ignored JSON state and logs intact.

## Checks

Run `npm test` after changes. `test/careless.test.js` covers the Careless rules; `test/test-standalone.js` covers the runtime store, balances, deploy gates and write ordering; `test/cleanup.test.js` checks module resolution, no-network imports, CLI surface, mocked Meteora position mapping and the Telegram menu schema. Do not start the live daemon or send transactions to validate a refactor.
