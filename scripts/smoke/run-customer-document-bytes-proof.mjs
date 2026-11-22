#!/usr/bin/env node
// Runs prove-customer-document-bytes-server-only.mjs --phase=after on TODAY's full migration chain and
// TODAY's customer-document-files Edge Function, all on this computer (KI-113).
//
//   node scripts/local-app/doc-bytes.mjs rebuild     once: its own Docker stack (crx-doc-bytes-proof, loopback
//                                                    ports 54831/54832): real Postgres, Auth, PostgREST, Storage,
//                                                    baseline + every ordered migration. Never the shared stacks.
//   node scripts/smoke/run-customer-document-bytes-proof.mjs                    PASS run
//   node scripts/smoke/run-customer-document-bytes-proof.mjs --negative-control also adds a browser read policy on
//                                                    the bucket (scratch DB only) and requires the proof to FAIL
//   node scripts/local-app/doc-bytes.mjs stop        when finished
//
// Needs Docker, Deno, `npm ci`. Serves the function with scripts/smoke/serve-customer-document-files-local.ts.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = path.join(ROOT, 'scripts', 'local-app', '.state', 'doc-bytes', 'local.env');
const PROJECT = 'crx-doc-bytes-proof';
const GATEWAY = 'http://127.0.0.1:54831';
const SERVE_PORT = 54841;
const FRONT = `http://127.0.0.1:${SERVE_PORT}`;
const negativeControl = process.argv.includes('--negative-control');

let state;
try {
  state = Object.fromEntries(readFileSync(STATE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
} catch {
  console.error('No proof stack yet. Run: node scripts/local-app/doc-bytes.mjs rebuild');
  process.exit(2);
}
if (state.LOCAL_API_URL !== GATEWAY) { console.error('Unexpected stack settings.'); process.exit(2); }

const psql = (sql) => spawnSync('docker', ['compose', '-p', PROJECT, '-f', path.join(ROOT, 'scripts', 'local-app', 'compose.yaml'), '--env-file', STATE,
  'exec', '-T', 'db', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
const open = (port) => new Promise((resolve) => {
  const s = connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

// Refuse a port someone else already owns: the proof must reach the server this run starts, not a leftover.
if (await open(SERVE_PORT)) { console.error(`Port ${SERVE_PORT} is already in use; stop whatever is listening there and run again.`); process.exit(2); }

const deno = spawn('deno', ['run', '--node-modules-dir=none', '--allow-net', '--allow-env', '--allow-read', path.join('scripts', 'smoke', 'serve-customer-document-files-local.ts')], {
  cwd: ROOT, stdio: 'inherit',
  env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA, TEMP: process.env.TEMP, DENO_DIR: process.env.DENO_DIR ?? '',
    GATEWAY_URL: GATEWAY, SERVE_PORT: String(SERVE_PORT), SUPABASE_URL: GATEWAY, ALLOWED_ORIGIN: 'http://127.0.0.1:5199',
    SUPABASE_ANON_KEY: state.LOCAL_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: state.LOCAL_SERVICE_KEY,
  },
});
let denoExit = null;
deno.on('exit', (c) => { denoExit = c ?? 'signal'; });
const stopDeno = () => spawnSync('taskkill', ['/pid', String(deno.pid), '/t', '/f'], { stdio: 'ignore' });

function prove(capture = false) {
  const result = spawnSync(process.execPath, ['scripts/smoke/prove-customer-document-bytes-server-only.mjs', '--phase=after'], {
    cwd: ROOT, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LOCAL_SUPABASE_URL: FRONT, LOCAL_SUPABASE_ANON_KEY: state.LOCAL_ANON_KEY, LOCAL_SUPABASE_SERVICE_ROLE_KEY: state.LOCAL_SERVICE_KEY,
      LOCAL_SUPABASE_ADMIN_EMAIL: state.LOCAL_TEST_EMAIL, LOCAL_SUPABASE_ADMIN_PASSWORD: state.LOCAL_TEST_PASSWORD },
  });
  if (capture) process.stdout.write(result.stdout ?? '');
  return capture ? result : result.status;
}

let code = 1;
try {
  for (let i = 0; i < 120 && denoExit === null && !(await open(SERVE_PORT)); i += 1) await new Promise((r) => setTimeout(r, 500));
  if (denoExit !== null) throw new Error(`The Edge Function server exited (${denoExit}) before it was ready.`);
  if (!(await open(SERVE_PORT))) throw new Error('The Edge Function server did not start.');
  code = prove();
  if (negativeControl) {
    console.log('\n--- NEGATIVE CONTROL: re-adding a browser read policy on the bucket (scratch DB only) ---');
    const added = psql(`CREATE POLICY ki113_negative_control ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'customer-documents');`);
    if (added.status !== 0) throw new Error(`Could not add the control policy: ${added.stderr}`);
    const control = prove(true);
    psql('DROP POLICY IF EXISTS ki113_negative_control ON storage.objects;');
    // A crash is not a catch: the proof must finish and report a failed assertion.
    const caught = control.status === 1 && /^FAIL /m.test(control.stdout) && /checks passed/.test(control.stdout) && !/Proof crashed/.test(control.stdout);
    console.log(`negative control: ${caught ? 'CAUGHT (the proof failed on a real assertion)' : 'NOT CAUGHT'}`);
    if (!caught) code = 1;
  }
} finally {
  stopDeno();
}
process.exit(code);
