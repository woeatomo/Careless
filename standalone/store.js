import fs from 'node:fs';
import { repoPath } from '../repo-root.js';

/**
 * Persisted entry-attempt records: mint-level duplicate protection and crash
 * recovery ("submitting" checkpoints are never pruned).
 */
export class RuntimeStore {
  constructor(file = repoPath('careless-runtime-state.json')) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, attempts: {} };
    if (this.data.version !== 1 || !this.data.attempts || typeof this.data.attempts !== 'object') throw new Error('Invalid runtime state; refusing to discard recovery history');
  }
  save() {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  prune(now = Date.now()) {
    // A day matches the pool-memory cooldown horizon. Never prune mid-submit checkpoints.
    for (const [mint, a] of Object.entries(this.data.attempts)) if (a.status !== 'submitting' && now - a.at > 24 * 3600_000) delete this.data.attempts[mint];
  }
}
