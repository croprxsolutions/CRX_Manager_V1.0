#!/usr/bin/env node
/**
 * KI-35: compare the LIVE migration ledger with the migration files on `main`. Read-only.
 *
 * Lists, in plain English:
 *   1. applied live, but no file on main has that name (old accepted drift, KI-62, is allowlisted);
 *   2. a file on main that was never applied live (parked drafts named in the allowlist are shown apart);
 *   3. mismatches: a live row whose name differs from its file, or whose SQL differs from the file.
 *
 * Row-to-file matching reuses the pending-set guard (.claude/hooks/migration-pending-lib.mjs), which already
 * handles renumbered rows (`<apply version>_<authored name>`) and shared names; the live read reuses the
 * sweeps' read-only Management API path (scripts/lib/supabase-credential.mjs). Nothing here writes.
 *
 * Usage:
 *   node scripts/check-migration-drift.mjs --live            read the live ledger read-only (Mason's PC)
 *   node scripts/check-migration-drift.mjs --rows rows.json  judge a saved ledger read (rows: {version, name, sha?})
 *   options: --ref <git ref> (default origin/main), --json
 * Exit: 0 no unexplained drift, 1 drift found, 2 could not run.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkPendingMigrations, fileStamp, migrationSlug, migrationStem, namesOnlyStamps, orderingStamp,
} from '../.claude/hooks/migration-pending-lib.mjs';
import { ledgerRowsToNames } from '../.claude/hooks/migration-ordering-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ID = 'rhyzpcqhnizqbxphqdkr';
export const ALLOWLIST_FILE = 'scripts/migration-drift-allowlist.json';
// The whole migration is stored as ONE statements element by both apply paths. CRLF, whole-line
// `--` comments and surrounding blank space are dropped on both sides, identically, so a header
// comment edited after the apply (e.g. "PARKED" -> "APPLIED LIVE") is not reported as drift.
// `raw_sha` keeps the comment lines, so a comment-only difference is still LISTED (not drift): a
// line starting with `--` inside a quoted string is SQL, and this way it can never pass silently.
export const LEDGER_QUERY = `select version, name, cardinality(statements) as parts,
  encode(sha256(convert_to(btrim(regexp_replace(replace(array_to_string(statements, E'\\n'), E'\\r\\n', E'\\n'),
    E'^[ \\t]*--[^\\n]*(\\n|$)', '', 'gn'), E' \\t\\n'), 'UTF8')), 'hex') as sha,
  encode(sha256(convert_to(btrim(replace(array_to_string(statements, E'\\n'), E'\\r\\n', E'\\n'), E' \\t\\n'), 'UTF8')), 'hex') as raw_sha
from supabase_migrations.schema_migrations order by version;`;

const digest = (body) => createHash('sha256').update(body.replace(/^[ \t\n]+|[ \t\n]+$/g, ''), 'utf8').digest('hex');
export function sqlHash(text) {
  return digest(String(text).replace(/\r\n/g, '\n').replace(/^[ \t]*--[^\n]*(\n|$)/gm, ''));
}
export function rawSqlHash(text) {
  return digest(String(text).replace(/\r\n/g, '\n'));
}

/**
 * @param {{version: string, name: string, sha?: string, parts?: number}[]} rows live ledger rows
 * @param {{name: string, sha: string}[]} files migration files on main (name with .sql)
 * @param {string} baselineHighWater supabase/baselines/manifest.json migrations_high_water
 * @param {{acceptedLedgerRows?: {version: string}[], parkedFiles?: {file: string}[], acceptedMismatches?: {version: string}[]}} allowlist
 */
export function compareLedgerToMain({ rows, files, baselineHighWater, allowlist = {} }) {
  const accepted = new Set((allowlist.acceptedLedgerRows ?? []).map((r) => String(r.version)));
  const acceptedMismatch = new Set((allowlist.acceptedMismatches ?? []).map((r) => String(r.version)));
  const parked = new Set((allowlist.parkedFiles ?? []).map((p) => migrationStem(p.file)));
  const fileSlugs = new Map();
  const fileStamps = new Map();
  for (const f of files) {
    const stem = migrationStem(f.name);
    const slug = migrationSlug(stem);
    if (!fileSlugs.has(slug)) fileSlugs.set(slug, []);
    fileSlugs.get(slug).push({ ...f, stem });
    const stamp = orderingStamp(stem);
    if (stamp) {
      if (!fileStamps.has(stamp)) fileStamps.set(stamp, []);
      fileStamps.get(stamp).push({ ...f, stem });
    }
  }

  const noFile = [];
  const acceptedNoFile = [];
  const nameMismatch = [];
  const contentMismatch = [];
  const commentOnly = [];
  let compared = 0;
  for (const row of rows) {
    const live = migrationStem(ledgerRowsToNames([row])[0] ?? '');
    const slug = migrationSlug(live);
    const stamps = [...live.matchAll(/\d{14}/g)].map((m) => m[0]);
    const byStamp = stamps.flatMap((s) => fileStamps.get(s) ?? []);
    const bySlug = namesOnlyStamps(slug) ? [] : (fileSlugs.get(slug) ?? []);
    const entry = { version: String(row.version), name: String(row.name ?? '') };
    if (bySlug.length === 0 && !(namesOnlyStamps(slug) && byStamp.length)) {
      if (accepted.has(entry.version)) acceptedNoFile.push(entry);
      else if (byStamp.length && !acceptedMismatch.has(entry.version)) nameMismatch.push({ ...entry, file: byStamp[0].name });
      else if (!byStamp.length) noFile.push(entry);
      continue;
    }
    // Content is compared only when the match is unambiguous and the row holds the whole file.
    const candidates = bySlug.length ? bySlug : byStamp;
    const file = candidates.length === 1 ? candidates[0] : candidates.find((f) => stamps.includes(fileStamp(f.stem)));
    if (!file || !row.sha || Number(row.parts ?? 1) !== 1 || acceptedMismatch.has(entry.version)) continue;
    if ((orderingStamp(file.stem) ?? '') <= baselineHighWater) continue; // pre-baseline history is unreconstructable (KI-62)
    compared += 1;
    if (row.sha !== file.sha) contentMismatch.push({ ...entry, file: file.name });
    else if (row.raw_sha && file.rawSha && row.raw_sha !== file.rawSha) commentOnly.push({ ...entry, file: file.name });
  }

  // The pending-set guard's own matcher, asked about a stamp later than every file.
  const verdict = checkPendingMigrations({
    name: '99999999999999_drift_scan', sql: '', appliedNames: ledgerRowsToNames(rows),
    trackedFiles: files.map((f) => f.name), baselineHighWater,
  });
  const neverApplied = [];
  const parkedWaiting = [];
  const renamed = new Set(nameMismatch.map((m) => migrationStem(m.file)));
  for (const stem of verdict.pending ?? []) {
    if (renamed.has(stem)) continue; // already reported once, as a name mismatch
    (parked.has(stem) ? parkedWaiting : neverApplied).push(stem);
  }
  const undecided = verdict.abstained ? { reason: verdict.abstainReason, files: verdict.ambiguous ?? [] } : null;
  return { noFile, acceptedNoFile, nameMismatch, contentMismatch, commentOnly, compared, neverApplied, parkedWaiting, undecided };
}

export function hasDrift(r) {
  return Boolean(r.noFile.length || r.nameMismatch.length || r.contentMismatch.length || r.neverApplied.length || r.undecided);
}

export function plainReport(r, { rowCount, fileCount, ref }) {
  const lines = [`Live migration ledger (${rowCount} rows) vs ${fileCount} migration files on ${ref}:`, ''];
  const section = (title, items, fmt) => {
    lines.push(`${items.length ? '✗' : '✓'} ${title}: ${items.length}`);
    for (const item of items) lines.push(`    ${fmt(item)}`);
  };
  section('Applied live, but no file on main', r.noFile, (x) => `${x.version}  ${x.name}`);
  section('File on main never applied live', r.neverApplied, (x) => x);
  section('Live name differs from the file on main', r.nameMismatch, (x) => `${x.version}  live "${x.name}"  file "${x.file}"`);
  section(`Live SQL differs from the file on main (of ${r.compared} checked; comment lines ignored)`, r.contentMismatch, (x) => `${x.version}  ${x.name}  (file ${x.file})`);
  if (r.undecided) lines.push(`✗ Could not decide some files: ${r.undecided.reason}`);
  if (r.commentOnly.length) {
    lines.push('', `Differ only in lines starting with "--" (${r.commentOnly.length}; usually a header comment edited after the apply, not drift. `
      + 'Open one only if such a line could sit inside a quoted string):');
    for (const x of r.commentOnly) lines.push(`    ${x.version}  ${x.name}  (file ${x.file})`);
  }
  lines.push('', `Known and accepted (not drift): ${r.acceptedNoFile.length} old live rows with no file (KI-62); `
    + `${r.parkedWaiting.length} parked draft(s) waiting on purpose${r.parkedWaiting.length ? ` (${r.parkedWaiting.join(', ')})` : ''}.`);
  lines.push(hasDrift(r) ? 'RESULT: DRIFT FOUND. Each line above needs a merge, an apply, or an allowlist entry with a reason. '
    + '(A migration applied live just before its PR merges shows as "no file on main" until that merge.)'
    : 'RESULT: CLEAN. Every live migration matches a file on main, and every file on main is applied or parked on purpose.');
  return lines.join('\n');
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function filesAtRef(ref) {
  // Every blob under the folder, keeping only .sql files directly in it (the deploy reads no subfolder).
  const listing = git(['ls-tree', '-r', ref, '--', 'supabase/migrations/']).split('\n').filter(Boolean)
    .map((line) => { const [meta, path] = line.split('\t'); return { blob: meta.split(' ')[2], path }; })
    .filter((f) => /^supabase\/migrations\/[^/]+\.sql$/.test(f.path))
    .map(({ blob, path }) => ({ blob, name: path.split('/').pop() }));
  if (listing.length === 0) throw new Error(`no migration files found at ${ref}; refusing to report every live row as drift`);
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: ROOT, input: listing.map((f) => f.blob).join('\n') + '\n', maxBuffer: 512 * 1024 * 1024,
  });
  let at = 0;
  for (const f of listing) {
    const headerEnd = out.indexOf(10, at);
    const size = Number(out.subarray(at, headerEnd).toString().split(' ')[2]);
    const text = out.subarray(headerEnd + 1, headerEnd + 1 + size).toString('utf8');
    f.sha = sqlHash(text);
    f.rawSha = rawSqlHash(text);
    at = headerEnd + 1 + size + 1;
  }
  return listing.map(({ name, sha, rawSha }) => ({ name, sha, rawSha }));
}

async function liveRows() {
  const { readCredentialToken } = await import('./lib/supabase-credential.mjs');
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readCredentialToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: LEDGER_QUERY, read_only: true }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`live ledger read failed: HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function savedRows(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : (parsed.migrations ?? parsed.result ?? parsed.rows);
  if (!Array.isArray(rows)) throw new Error(`${path} holds no ledger rows`);
  return rows;
}

async function main(argv) {
  const opt = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const ref = opt('--ref') ?? 'origin/main';
  const rows = argv.includes('--live') ? await liveRows() : opt('--rows') ? savedRows(opt('--rows')) : null;
  if (!rows) throw new Error('pass --live or --rows <file>');
  if (rows.length === 0) throw new Error('the ledger came back empty');
  const files = filesAtRef(ref);
  const baselineHighWater = JSON.parse(git(['show', `${ref}:supabase/baselines/manifest.json`])).migrations_high_water;
  const allowlist = JSON.parse(readFileSync(join(ROOT, ALLOWLIST_FILE), 'utf8'));
  const result = compareLedgerToMain({ rows, files, baselineHighWater, allowlist });
  console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : plainReport(result, { rowCount: rows.length, fileCount: files.length, ref }));
  process.exitCode = hasDrift(result) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`check-migration-drift: ${error.message}`);
    process.exitCode = 2;
  });
}
