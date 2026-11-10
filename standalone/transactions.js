// Serialize wallet mutations while allowing monitoring and screening to continue.
// Exit work jumps ahead of queued entries; an in-flight submission is never interrupted.
let active = false;
const queue = [];
export function withWalletLock(fn, priority = 0) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, priority, resolve, reject });
    queue.sort((a, b) => b.priority - a.priority);
    drain();
  });
}
async function drain() {
  if (active || !queue.length) return;
  active = true;
  const item = queue.shift();
  try { item.resolve(await item.fn()); } catch (e) { item.reject(e); }
  finally { active = false; void drain(); }
}
