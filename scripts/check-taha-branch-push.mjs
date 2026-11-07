#!/usr/bin/env node
// Pre-push: only Taha pushes to Taha's branches (Mason, 2026-11-06/07; ship.md › Taha's PRs).
// Mason's agents comment on his PRs instead. Reads git's pre-push lines on stdin:
//   <local ref> <local sha> <remote ref> <remote sha>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TAHA_LOGIN = 'tahakhanabdalli';

// The pusher's own git email carries his GitHub login, so his email never needs to live in this public repo.
export function pusherIsTaha(email) {
  return String(email || '').toLowerCase().includes(TAHA_LOGIN);
}

export function blockedTahaRefs(stdinText, tahaPrBranches = []) {
  const prBranches = new Set(tahaPrBranches);
  const blocked = [];
  for (const line of String(stdinText || '').split(/\r?\n/)) {
    const remoteRef = line.trim().split(/\s+/)[2];
    if (!remoteRef?.startsWith('refs/heads/')) continue;
    const branch = remoteRef.slice('refs/heads/'.length);
    if (branch.toLowerCase().startsWith('taha/') || prBranches.has(branch)) blocked.push(branch);
  }
  return blocked;
}

function openTahaPrBranches() {
  try {
    const out = execFileSync('gh', ['pr', 'list', '--repo', 'croprxsolutions/CRX_Manager_V1.0', '--author', 'TahaKhanAbdalli',
      '--state', 'open', '--json', 'headRefName', '--limit', '100'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out).map((pr) => pr.headRefName);
  } catch {
    // shortcut: without gh only the taha/ name check runs; his PRs all use taha/ branches today.
    console.error('Note: could not list Taha\'s open PRs (gh missing or offline); checking taha/ branch names only.');
    return [];
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let email = '';
  try { email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim(); } catch { /* no email set */ }
  if (pusherIsTaha(email)) process.exit(0);
  const stdinText = readFileSync(0, 'utf8');
  const blocked = blockedTahaRefs(stdinText, openTahaPrBranches());
  if (blocked.length > 0) {
    console.error(`❌ TAHA'S BRANCH — push blocked: ${blocked.join(', ')}`);
    console.error('Only Taha pushes to his branches. Post your findings as a comment on his PR instead');
    console.error('(.claude/commands/ship.md › Taha\'s PRs). If it is urgent, ask Taha first and agree who pushes.');
    process.exit(1);
  }
}
