#!/usr/bin/env node
/**
 * Run every db-invariant sweep against LIVE, exactly and read-only, then adjudicate.
 *
 * Replaces hand-copying ~330KB of SQL and the returned packets through MCP helpers: the wrapped
 * queries come straight from `run-sweeps.mjs` output, each must pass the live-data guard's
 * `isKnownSweepQuery` byte-for-byte, and each returned `sweep_result` is saved untouched.
 *
 * The Management API token is read in memory from Windows Credential Manager (target
 * `Supabase CLI:supabase`). It is never printed, logged or written to disk. Mason approved this
 * read-only use on 2026-11-02 (docs/manual/SERVICES_AND_ACCOUNTS.md).
 *
 * Usage: node scripts/db-invariant-sweeps/run-live.mjs [--out <capture.json>]
 * The capture holds business data (see README "Output containment"), so the default lives in the
 * git-ignored .claude/session-state/ folder. Exit: the adjudicator's code (0 pass, 1 violation,
 * 2 invalid), or 3 when a query is refused or the live run fails before adjudication.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isKnownSweepQuery } from '../../.claude/hooks/live-testdata-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RUNNER = join(HERE, 'run-sweeps.mjs');
const PROJECT_ID = 'rhyzpcqhnizqbxphqdkr';
const QUERY_URL = `https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query`;
const CREDENTIAL_TARGET = 'Supabase CLI:supabase';
const TOKEN_RE = /^sbp_[A-Za-z0-9_]{20,}$/;
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

/** Credential Manager blob (base64) → token. Errors never include the value. */
export function decodeTokenBlob(base64) {
  const bytes = Buffer.from(base64.trim(), 'base64');
  for (const encoding of ['utf8', 'utf16le']) {
    let value = bytes.toString(encoding).replace(/\0+$/, '').trim();
    if (value.startsWith('go-keyring-base64:')) {
      value = Buffer.from(value.slice('go-keyring-base64:'.length), 'base64').toString('utf8').trim();
    }
    if (TOKEN_RE.test(value)) return value;
  }
  throw new Error(`The ${CREDENTIAL_TARGET} credential is not a Supabase access token.`);
}

function readToken() {
  if (process.platform !== 'win32') throw new Error('The token lives in Windows Credential Manager; run this on Mason\'s PC.');
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    'using System; using System.Runtime.InteropServices;',
    'public static class CrxCred {',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
    '}',
    "'@",
    '$p = [IntPtr]::Zero',
    `if (-not [CrxCred]::CredReadW('${CREDENTIAL_TARGET}', 1, 0, [ref]$p)) { exit 3 }`,
    'try {',
    // 64-bit CREDENTIALW: CredentialBlobSize at offset 32, CredentialBlob pointer at 40.
    '  $n = [Runtime.InteropServices.Marshal]::ReadInt32($p, 32)',
    '  $b = [Runtime.InteropServices.Marshal]::ReadIntPtr($p, 40)',
    '  $bytes = New-Object byte[] $n',
    '  [Runtime.InteropServices.Marshal]::Copy($b, $bytes, 0, $n)',
    '  [Console]::Out.Write([Convert]::ToBase64String($bytes))',
    '} finally { [CrxCred]::CredFree($p) }',
  ].join('\n');
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // -EncodedCommand: piping a script to `-Command -` returned zero bytes (2026-11-01).
  const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || !res.stdout) throw new Error(`Could not read the ${CREDENTIAL_TARGET} credential (exit ${res.status}).`);
  return decodeTokenBlob(res.stdout);
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const out = resolve(outIndex === -1 ? join(ROOT, '.claude', 'session-state', 'db-sweeps-live-capture.json') : process.argv[outIndex + 1] ?? '');
  // An empty SUPABASE_DB_URL keeps run-sweeps in print mode, so we always get the queries to send.
  const printed = spawnSync(process.execPath, [RUNNER], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SUPABASE_DB_URL: '' } });
  if (printed.status !== 0) throw new Error(`run-sweeps failed (exit ${printed.status}): ${printed.stderr}`);
  const queries = extractQueries(printed.stdout);
  const token = readToken();
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
  const verdict = spawnSync(process.execPath, [RUNNER, '--adjudicate', out], { stdio: 'inherit' });
  process.exitCode = verdict.status ?? 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`run-live: ${error.message}`);
    process.exitCode = 3;
  });
}
