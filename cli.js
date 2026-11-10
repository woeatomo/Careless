#!/usr/bin/env node
import './envcrypt.js';
import { parseArgs } from 'node:util';

const HELP = `Careless — standalone Meteora DLMM bot (Careless strategy)

Commands:
  start                           Start the screener, entries and deterministic exits
  status                          Show persisted entry attempts (no network)
  balance                         Read native SOL and token balances
  positions [--wallet ADDRESS]    Read open positions
  pnl --pool ADDRESS --position ADDRESS
  screen --mint ADDRESS           Careless screen for one mint, read-only; never deploys
  candidates                      Screened candidates and why they pass/fail
  paper                           Paper-trading results (shadow mode simulated positions)
  pool --pool ADDRESS             Read focused pool metrics
  active-bin --pool ADDRESS       Read the current on-chain bin
  manage                          Run one deterministic management pass
  close --position ADDRESS [--reason TEXT] [--skip-swap]
  claim --position ADDRESS
  swap --from MINT --to MINT --amount NUMBER
  blacklist                       List blocked token mints
  blacklist add --mint ADDRESS [--reason TEXT]
  blacklist remove --mint ADDRESS
  performance [--hours NUMBER]     Read local closed-position history
  config                          Show non-secret strategy and threshold settings
  help

Flags: --dry-run forces all transaction operations to simulate only.
Configuration: user-config.json (restart the daemon after editing).
Entries come from the Meteora screener (plus careless.whitelistMints): established,
ranging tokens with steady fees, deployed as single-side SOL Spot 0% … -80%.
`;
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries([
    ...['wallet','name','pool','position','mint','reason','from','to','amount','hours'].map(k => [k, { type: 'string' }]),
    ...['help','dry-run','skip-swap'].map(k => [k, { type: 'boolean' }]),
  ]),
});
if (flags['dry-run']) process.env.DRY_RUN = 'true';
const out = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
function requireFlag(key) { if (!flags[key]) throw new Error(`--${key} is required`); return flags[key]; }
async function main() {
  const [cmd = 'help', action] = positionals;
  if (flags.help || cmd === 'help') { process.stdout.write(HELP); return; }
  // Load config before tools so shadow mode is applied to every write.
  const { config } = await import('./config.js');
  switch (cmd) {
    case 'start': return (await import('./standalone/runtime.js')).startStandalone();
    case 'status': {
      const fs = await import('node:fs');
      const { repoPath } = await import('./repo-root.js');
      const file = repoPath('careless-runtime-state.json');
      if (!fs.existsSync(file)) return out({ started: false, shadow: config.standalone.shadow });
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return out({ shadow: config.standalone.shadow, attempts: data.attempts });
    }
    case 'balance': return out(await (await import('./tools/wallet.js')).getWalletBalances({ force: true }));
    case 'positions': return out(await (await import('./tools/dlmm.js')).getMyPositions({ force: true, wallet_address: flags.wallet }));
    case 'pnl': return out(await (await import('./tools/dlmm.js')).getPositionPnl({ pool_address: requireFlag('pool'), position_address: requireFlag('position') }));
    case 'screen': {
      const r = await (await import('./careless/engine.js')).screenCandidate(requireFlag('mint'));
      return out({ pass: r.pass, reason: r.reason, terminal: r.terminal ?? false, symbol: r.token?.symbol ?? null, pool: r.pool?.pool_address ?? null, binStep: r.pool?.dlmm_params?.bin_step ?? null, pools: (r.pools ?? []).map(p => p.pool_address), rugcheckScore: r.rugcheck?.score_normalised ?? null, gmgn: r.gmgn ?? null });
    }
    case 'candidates': return out((await import('./careless/engine.js')).candidatesSummary());
    case 'pool': return out(await (await import('./standalone/screening.js')).poolDetail(requireFlag('pool')));
    case 'active-bin': return out(await (await import('./tools/dlmm.js')).getActiveBin({ pool_address: requireFlag('pool') }));
    case 'manage': return out(await (await import('./standalone/runtime.js')).manageOnce());
    case 'paper': return out((await import('./careless/paper.js')).paperSummary());
    case 'close': case 'claim': case 'swap': {
      const { executeTool } = await import('./tools/executor.js');
      if (cmd === 'close') return out(await executeTool('close_position', { position_address: requireFlag('position'), reason: flags.reason || 'manual close', skip_swap: !!flags['skip-swap'] }));
      if (cmd === 'claim') return out(await executeTool('claim_fees', { position_address: requireFlag('position') }));
      const amount = Number(requireFlag('amount'));
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('--amount must be positive');
      return out(await executeTool('swap_token', { input_mint: requireFlag('from'), output_mint: requireFlag('to'), amount }));
    }
    case 'blacklist': {
      const blocked = await import('./token-blacklist.js');
      if (!action) return out(blocked.listBlacklist());
      if (action === 'add') return out(blocked.addToBlacklist({ mint: requireFlag('mint'), reason: flags.reason || 'manual block' }));
      if (action === 'remove') return out(blocked.removeFromBlacklist({ mint: requireFlag('mint') }));
      throw new Error('Use blacklist, blacklist add, or blacklist remove');
    }
    case 'performance': {
      const { getPerformanceHistory, getPerformanceSummary } = await import('./performance.js');
      const hours = Number(flags.hours || 24);
      if (!Number.isFinite(hours) || hours <= 0) throw new Error('--hours must be positive');
      return out({ summary: getPerformanceSummary(), recent: getPerformanceHistory({ hours }) });
    }
    case 'config': {
      const careless = JSON.parse(JSON.stringify(config.careless));
      careless.gmgn.apiKey = careless.gmgn.apiKey ? '(set)' : '(missing)';
      return out({ shadowMode: config.standalone.shadow, risk: config.risk, deployGates: config.screening, management: config.management, schedule: config.schedule, careless });
    }
    default: throw new Error(`Unknown command "${cmd}". Run node cli.js help.`);
  }
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; });
