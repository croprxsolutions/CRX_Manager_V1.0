#!/usr/bin/env node
// CI dependency gate: `npm audit --audit-level=high`, plus dated exceptions
// for advisories that have NO patched version anywhere. Each exception expires;
// after its date the advisory fails the gate again. Never add an advisory that
// has a fix: bump the dependency instead. (The 2026-11-17 picomatch entry was
// removed after GitHub withdrew GHSA-fc5q-39xc-vjpf on 2026-11-18, #1943.)

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An exception holds only while its package's newest published version (any dist-tag) is still
// `latestSeen`, npm offers no direct fix, and the advisory is absent from the
// production-only audit: a new release, or the package reaching what customers run,
// ends it early, so CI makes someone act instead of hiding it until the date.
export const EXCEPTIONS = {};

const BLOCKING = new Set(['high', 'critical']);

// npm's own fix for this package: `true`, or an upgrade of the same package.
const directFix = (vuln) => vuln.fixAvailable === true
  || (typeof vuln.fixAvailable === 'object' && vuln.fixAvailable !== null && vuln.fixAvailable.name === vuln.name);

// Returns the high/critical advisories that still fail the gate on `today` (YYYY-MM-DD).
// `latestOf(name)` returns the package's newest published version, or null when unknown;
// `prodIds` is the Set of advisory ids in `npm audit --omit=dev`, or null when unknown.
// Anything unknown fails closed: the exception lapses.
export function blockingAdvisories(report, today, exceptions = EXCEPTIONS, latestOf = () => null, prodIds = null) {
  const seen = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || !BLOCKING.has(via.severity)) continue;
      const id = String(via.url ?? '').split('/').pop();
      const ex = exceptions[id];
      if (ex && today <= ex.until && !directFix(vuln) && latestOf(ex.package) === ex.latestSeen
        && prodIds instanceof Set && !prodIds.has(id)) continue;
      seen.set(id || via.title, `${via.severity} ${via.name}: ${via.title} (${via.url})`);
    }
  }
  return [...seen.values()];
}

function audit(args) {
  const run = spawnSync(`npm audit --json${args}`, { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error(`npm audit gate failed closed: could not read npm audit${args} output.\n${run.stderr}`);
    process.exit(2);
  }
  if (report.error) {
    console.error(`npm audit gate failed closed: ${JSON.stringify(report.error)}`);
    process.exit(2);
  }
  return report;
}

// Advisory ids (the GHSA-… tail of each url) anywhere in an audit report.
export function advisoryIds(report) {
  const ids = new Set();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === 'object') ids.add(String(via.url ?? '').split('/').pop());
    }
  }
  return ids;
}

function main() {
  const report = audit('');
  const prodIds = advisoryIds(audit(' --omit=dev'));
  const today = new Date().toISOString().slice(0, 10);
  const latest = new Map();
  const latestOf = (name) => {
    if (!latest.has(name)) {
      // Every published version (semver-sorted), not the `latest` dist-tag: a fix shipped
      // under another tag still counts as a newer release.
      const r = spawnSync(`npm view ${name} versions --json`, { encoding: 'utf8', shell: true });
      let newest = null;
      try { newest = r.status === 0 ? [].concat(JSON.parse(r.stdout)).at(-1) ?? null : null; } catch { /* unknown */ }
      latest.set(name, newest); // unknown: the exception lapses
    }
    return latest.get(name);
  };
  for (const [id, ex] of Object.entries(EXCEPTIONS)) {
    const now = latestOf(ex.package);
    const state = today > ex.until ? `EXPIRED on ${ex.until}`
      : now !== ex.latestSeen ? `ENDED: ${ex.package} latest is ${now ?? 'unknown'}, not ${ex.latestSeen}; bump it`
      : prodIds.has(id) ? 'ENDED: it is now in production dependencies'
      : `active until ${ex.until} (a direct npm fix still ends it)`;
    console.log(`Exception ${id} ${state}`);
  }
  const blocking = blockingAdvisories(report, today, EXCEPTIONS, latestOf, prodIds);
  if (blocking.length) {
    console.error(`High/critical advisories:\n- ${blocking.join('\n- ')}`);
    process.exit(1);
  }
  console.log('npm audit gate passed: no high/critical advisory outside the dated exceptions.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
