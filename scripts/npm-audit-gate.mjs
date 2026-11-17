#!/usr/bin/env node
// CI dependency gate: `npm audit --audit-level=high`, plus dated exceptions
// for advisories that have NO patched version anywhere. Each exception expires;
// after its date the advisory fails the gate again. Mason approved the picomatch
// entry on 2026-11-17 (no fixed release exists; build/test tooling only, the
// production-only audit has no high). Never add an advisory that has a fix:
// bump the dependency instead.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXCEPTIONS = {
  // picomatch ReDoS, all versions <= 4.0.7 (latest); used by vite/vitest/knip only.
  'GHSA-fc5q-39xc-vjpf': '2026-12-31',
};

const BLOCKING = new Set(['high', 'critical']);

// Returns the high/critical advisories that still fail the gate on `today` (YYYY-MM-DD).
export function blockingAdvisories(report, today, exceptions = EXCEPTIONS) {
  const seen = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || !BLOCKING.has(via.severity)) continue;
      const id = String(via.url ?? '').split('/').pop();
      const until = exceptions[id];
      if (until && today <= until) continue;
      seen.set(id || via.title, `${via.severity} ${via.name}: ${via.title} (${via.url})`);
    }
  }
  return [...seen.values()];
}

function main() {
  const run = spawnSync('npm audit --json', { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error(`npm audit gate failed closed: could not read npm audit output.\n${run.stderr}`);
    process.exit(2);
  }
  if (report.error) {
    console.error(`npm audit gate failed closed: ${JSON.stringify(report.error)}`);
    process.exit(2);
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const [id, until] of Object.entries(EXCEPTIONS)) {
    console.log(`Exception ${id} ${today <= until ? `active until ${until}` : `EXPIRED on ${until}`}`);
  }
  const blocking = blockingAdvisories(report, today);
  if (blocking.length) {
    console.error(`High/critical advisories:\n- ${blocking.join('\n- ')}`);
    process.exit(1);
  }
  console.log('npm audit gate passed: no high/critical advisory outside the dated exceptions.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
