#!/usr/bin/env node
/**
 * Run every db-invariant sweep against LIVE, exactly and read-only, then adjudicate.
 *
 * Replaces hand-copying ~330KB of SQL and the returned packets through MCP helpers: the wrapped
 * queries come straight from `run-sweeps.mjs` output, each must pass the live-data guard's
 * `isKnownSweepQuery` byte-for-byte, and each returned `sweep_result` is saved untouched.
 *
 * The Management API token is read in memory from Windows Credential Manager (target
 * `Supabase CLI:supabase`, via scripts/lib/supabase-credential.mjs). It is never printed, logged or written to disk. Mason approved this
 * read-only use on 2026-11-02 (docs/manual/SERVICES_AND_ACCOUNTS.md).
 *
 * Usage: node scripts/db-invariant-sweeps/run-live.mjs
 * The capture holds business data (see README "Output containment"), so it is always written to
 * the git-ignored .claude/session-state/ folder, never a caller-chosen path. Exit: the adjudicator's code (0 pass, 1 violation,
 * 2 invalid), or 3 when a query is refused or the live run fails before adjudication.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isKnownSweepQuery } from '../../.claude/hooks/live-testdata-lib.mjs';
import { readCredentialToken } from '../lib/supabase-credential.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RUNNER = join(HERE, 'run-sweeps.mjs');
const PROJECT_ID = 'rhyzpcqhnizqbxphqdkr';
const QUERY_URL = `https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query`;
const HEAD = "SELECT json_build_object(\n  'predicate', '";
const TAIL = '\n) AS sweep_result;';

/** Every wrapped query in run-sweeps print output, refused unless the guard recognises it exactly. */
export function extractQueries(printed) {
  const text = printed.replace(/\r\n/g, '\n');
  const queries = [];
  for (let start = text.indexOf(HEAD); start !== -1; start = text.indexOf(HEAD, start + 1)) {
    const end = text.indexOf(TAIL, start);
    if (end === -1) throw new Error('A wrapped sweep query has no closing `AS sweep_result;`.');
    const query = text.slice(start, end + TAIL.length);
    const name = query.slice(HEAD.length, query.indexOf("',\n", HEAD.length));
    if (!isKnownSweepQuery(query)) throw new Error(`Refusing ${name || 'a query'}: it is not a known sweep query.`);
    queries.push({ name, query });
  }
  if (queries.length === 0) throw new Error('run-sweeps printed no wrapped queries.');
  // A query whose opening was altered would not be found at all; one banner per predicate catches it.
  const banners = (text.match(/^┌─ PREDICATE: /gm) || []).length;
  if (banners !== queries.length) throw new Error(`run-sweeps printed ${banners} predicates but ${queries.length} queries were found.`);
  if (new Set(queries.map((q) => q.name)).size !== queries.length) throw new Error('run-sweeps printed a predicate twice.');
  return queries;
}

/** The one sweep_result packet in a Management API response body, exactly as returned. */
export function packetFrom(name, status, bodyText) {
  if (status < 200 || status >= 300) throw new Error(`${name}: HTTP ${status}: ${bodyText.slice(0, 500)}`);
  let rows;
  try { rows = JSON.parse(bodyText); } catch { throw new Error(`${name}: response is not JSON.`); }
  const packet = Array.isArray(rows) && rows.length === 1 ? rows[0]?.sweep_result : undefined;
  if (!packet || typeof packet !== 'object' || packet.predicate !== name) {
    throw new Error(`${name}: response did not hold exactly one sweep_result packet for this predicate.`);
  }
  return packet;
}

/** A short closing list of the predicates that did not pass, so the long JSON never needs a re-run to read (2026-11-07 retro). */
export function failingSummary(adjudicated) {
  let verdict;
  try { verdict = JSON.parse(adjudicated); } catch { return 'Could not read the adjudicator output; see above.'; }
  const failing = (verdict.summary ?? []).filter((item) => item.status !== 'PASS');
  if (failing.length === 0) return `All ${verdict.summary?.length ?? 0} predicates passed.`;
  return [`${failing.length} of ${verdict.summary.length} predicates did not pass:`,
    ...failing.map((item) => `  ${item.status}  ${item.predicate}  ${item.violations?.length ?? item.error ?? '?'} unallowlisted`)].join('\n');
}

async function main() {
  const out = join(ROOT, '.claude', 'session-state', 'db-sweeps-live-capture.json');
  // This script is the live execution, so the helpers run in print/adjudicate mode: an empty
  // SUPABASE_DB_URL and no DB_SWEEPS_REQUIRE_LIVE (which would refuse both modes).
  const env = { ...process.env, SUPABASE_DB_URL: '' };
  delete env.DB_SWEEPS_REQUIRE_LIVE;
  const printed = spawnSync(process.execPath, [RUNNER], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  if (printed.status !== 0) throw new Error(`run-sweeps failed (exit ${printed.status}): ${printed.stderr}`);
  const queries = extractQueries(printed.stdout);
  const token = readCredentialToken();
  const capture = [];
  for (const { name, query } of queries) {
    const res = await fetch(QUERY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, read_only: true }),
      signal: AbortSignal.timeout(180_000),
    });
    capture.push(packetFrom(name, res.status, await res.text()));
    console.log(`captured ${String(capture.length).padStart(2)}/${queries.length}  ${name}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(capture, null, 2)}\n`);
  console.log(`\nSaved ${capture.length} packets to ${out} (private: may hold business data).\n`);
  const verdict = spawnSync(process.execPath, [RUNNER, '--adjudicate', out],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  process.stdout.write(verdict.stdout ?? '');
  console.log(`\n${failingSummary(verdict.stdout ?? '')}`);
  process.exitCode = verdict.status ?? 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`run-live: ${error.message}`);
    process.exitCode = 3;
  });
}
