import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { Refused } from './target.mjs';

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/** Acquire an exclusive per-lane lock; stale locks are preserved for explicit recovery. */
export function acquireLaneLock(lockPath, pid = process.pid) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, `${pid}\n`, { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (readFileSync(lockPath, 'utf8').trim() === String(pid)) unlinkSync(lockPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (!existsSync(lockPath)) continue;
    const ownerText = readFileSync(lockPath, 'utf8').trim();
    const owner = /^\d+$/.test(ownerText) ? Number(ownerText) : NaN;
    if (!Number.isSafeInteger(owner) || owner < 1) {
      throw new Refused(`The lane lock at ${lockPath} is unreadable. Preserve it, then rename only that lock file to a dated .stale file to recover.`);
    }
    if (processIsRunning(owner)) throw new Refused(`Another local walkthrough command (process ${owner}) owns this lane. Wait for it to finish.`);
    throw new Refused(`The lane lock records process ${owner}, which is no longer running. Nothing was changed. Confirm no walkthrough command is active, then rename only ${lockPath} to a dated .stale file, or use a different uniquely named checkout.`);
  }
  throw new Refused(`Could not acquire the walkthrough lane lock at ${lockPath}; another command may be starting.`);
}
