#!/usr/bin/env node
// Runs the private test copy of the app. Usage and rules: scripts/local-app/README.md
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_PORT, API_URL, APP_PORT, APP_URL, DB_PORT, DB_URL_PREFIX, DB_URL_SUFFIX, ISSUER, PROJECT, Refused, TEST_EMAIL,
  assertCleanEnvironment, assertFrontendIsOurs, assertLocalDockerEndpoint, assertLocalState, assertLoopbackBindings, portIsOpen,
} from './target.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// Tests point this at a throwaway copy. Whatever it holds still has to pass the checks.
const STATE_DIR = process.env.CRX_LOCAL_APP_STATE_DIR || path.join(HERE, '.state');
const STATE_FILE = path.join(STATE_DIR, 'local.env');
const BUILD_FILE = path.join(STATE_DIR, 'build.json');
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const SERVICES = ['auth', 'rest', 'storage', 'gateway'];

// Children get only what they need to run, never the caller's whole environment.
const PASSTHROUGH = /^(path|pathext|systemroot|systemdrive|windir|comspec|temp|tmp|home|homedrive|homepath|userprofile|username|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|supabase_go_binary|ms_playwright_browsers_path)$/i;
function childEnv(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => PASSTHROUGH.test(k))), ...extra };
}

function run(command, args, { input, allowFailure, env, stdio } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT, env: env ?? childEnv(), input, maxBuffer: 256 * 1024 * 1024, stdio,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`${command} ${args[0]} failed\n${result.error?.message ?? ''}${result.stderr ?? ''}${result.stdout ?? ''}`.trim());
  }
  return result;
}
const text = (result) => result.stdout.toString().trim();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  return Object.fromEntries(readFileSync(STATE_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

function signKey(secret, role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: ISSUER, role, exp: 4102444800 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function createState() {
  const secret = randomBytes(32).toString('hex');
  const password = randomBytes(16).toString('hex');
  const state = {
    LOCAL_API_URL: API_URL,
    LOCAL_APP_URL: APP_URL,
    LOCAL_API_PORT: String(API_PORT),
    LOCAL_DB_PORT: String(DB_PORT),
    LOCAL_DB_PASSWORD: password,
    LOCAL_DB_URL: `${DB_URL_PREFIX}${password}${DB_URL_SUFFIX}`,
    LOCAL_JWT_SECRET: secret,
    LOCAL_ANON_KEY: signKey(secret, 'anon'),
    LOCAL_SERVICE_KEY: signKey(secret, 'service_role'),
    LOCAL_TEST_EMAIL: TEST_EMAIL,
    LOCAL_TEST_PASSWORD: randomBytes(12).toString('hex'),
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, Object.entries(state).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return state;
}

function compose(args, options) {
  return run('docker', ['compose', '-p', PROJECT, '-f', path.join(HERE, 'compose.yaml'), '--env-file', STATE_FILE, ...args], options);
}

function assertExistingStackIsOurs() {
  const ids = text(run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`]));
  if (!ids) return;
  const inspected = JSON.parse(text(run('docker', ['inspect', ...ids.split(/\s+/)])));
  for (const container of inspected) {
    if (!/scripts[\\/]local-app[\\/]compose\.yaml$/.test(container.Config.Labels['com.docker.compose.project.config_files'] ?? '')) {
      throw new Refused(`Another stack is using the name ${PROJECT}. Nothing was changed.`);
    }
  }
  assertLoopbackBindings(inspected.flatMap((c) => Object.values(c.HostConfig.PortBindings ?? {}).flat()));
}

/** Runs before anything changes. A missing state file is fine only for a first rebuild. */
async function preflight({ needState = true } = {}) {
  assertCleanEnvironment();
  const state = readState();
  if (!state && needState) throw new Refused('No test app here yet. Run: node scripts/local-app/app.mjs rebuild');
  if (state) assertLocalState(state);
  assertLocalDockerEndpoint(text(run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])));
  await assertFrontendIsOurs(state?.LOCAL_ANON_KEY);
  assertExistingStackIsOurs();
  return state;
}

function psql(sql, { user = 'postgres', args = [] } = {}) {
  return compose(['exec', '-T', 'db', 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], { input: sql });
}
const scalar = (sql) => text(psql(sql, { args: ['-A', '-t'] }));

async function waitFor(label, probe) {
  for (let i = 0; i < 120; i += 1) {
    if (await probe()) return;
    await wait(1000);
  }
  throw new Error(`${label} did not become ready`);
}
// The gateway's first lookup of the database can miss, so wait for a real Postgres answer.
const databaseAnswers = () => new Promise((resolve) => {
  const request = Buffer.alloc(8);
  request.writeInt32BE(8, 0);
  request.writeInt32BE(80877103, 4); // Postgres' "do you speak TLS?" opener
  const socket = connect({ host: '127.0.0.1', port: DB_PORT }, () => socket.write(request));
  socket.setTimeout(3000);
  socket.once('data', (reply) => { socket.destroy(); resolve(reply.length === 1); });
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
  socket.once('close', () => resolve(false));
  socket.once('error', () => resolve(false));
});
const answers = async (url, headers) => {
  try { return (await fetch(url, { headers, signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
};

async function startDatabase(state) {
  compose(['up', '-d', 'db']);
  await waitFor('database', () => compose(['exec', '-T', 'db', 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0);
  await wait(1500);
  const roles = ['authenticator', 'supabase_auth_admin', 'supabase_storage_admin'];
  await waitFor('database roles', () => compose(
    ['exec', '-T', 'db', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-c', 'SELECT 1'],
    { allowFailure: true },
  ).status === 0);
  psql(roles.map((role) => `ALTER ROLE ${role} WITH PASSWORD '${state.LOCAL_DB_PASSWORD}';`).join('\n'), { user: 'supabase_admin' });
}

async function startServices(state) {
  compose(['up', '-d', ...SERVICES]);
  await waitFor('database through the gateway', databaseAnswers);
  await waitFor('login service', () => answers(`${API_URL}/auth/v1/health`));
  await waitFor('storage service', () => answers(`${API_URL}/storage/v1/status`));
  await waitFor('data service', () => answers(`${API_URL}/rest/v1/`, { apikey: state.LOCAL_ANON_KEY, Authorization: `Bearer ${state.LOCAL_ANON_KEY}` }));
  assertExistingStackIsOurs();
}

function restoreBaseline() {
  const { restore_order: order } = JSON.parse(readFileSync(path.join(BASELINE, 'manifest.json'), 'utf8'));
  for (const name of order) {
    // A hosted project already has this ledger table; a local one gets the same shape first.
    if (name.includes('migration_history')) {
      psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
    }
    const sql = name.endsWith('.br')
      ? run(process.execPath, ['scripts/decompress-schema-baseline.mjs']).stdout
      : readFileSync(path.join(BASELINE, name));
    psql(sql, { user: name.includes('platform_overlay') ? 'supabase_admin' : 'postgres' });
  }
}

// Files in the repository's committed form: Windows checkouts add CR, the database's checks do not
// expect it. Live applies run each file in one transaction and the CLI does not, so add that here.
function migrationBytes(file) {
  const sql = withLiveLineEndings(file, readFileSync(path.join(ROOT, file), 'utf8').replaceAll('\r\n', '\n'));
  return /^\s*(BEGIN|START\s+TRANSACTION)\s*;/im.test(sql) ? sql : `BEGIN;\n${sql}\n;COMMIT;\n`;
}

// Live held this one body with CRLF when 20260817120000 pinned it, so install that text
// first, the same way the real-schema proofs under scripts/smoke/ do.
function withLiveLineEndings(file, sql) {
  if (path.basename(file) !== '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') return sql;
  const source = readFileSync(path.join(ROOT, 'supabase/migrations/20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql'), 'utf8').replaceAll('\r\n', '\n');
  const start = source.indexOf('CREATE FUNCTION public._close_undelivered_order_remainder_20260718(');
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  const bodyStart = start + tag.index + tag[0].length;
  const body = source.slice(bodyStart, source.indexOf(tag[0], bodyStart)).replaceAll('\n', '\r\n');
  if (body.length !== 15910) throw new Error('The CRLF function body drifted.');
  return `CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $live_crlf_close$${body}$live_crlf_close$;\n${sql}`;
}

function pushPostBaselineMigrations(state) {
  const files = text(run(process.execPath, ['scripts/list-post-baseline-migrations.mjs'])).split(/\r?\n/).filter(Boolean);
  const workdir = mkdtempSync(path.join(STATE_DIR, 'push-'));
  try {
    mkdirSync(path.join(workdir, 'supabase', 'migrations'), { recursive: true });
    // Not `supabase init`: CLI 2.109.1 writes a [local_smtp] block it then refuses to parse.
    // The [db] port makes the CLI treat this as a local database, the one case where it skips TLS.
    writeFileSync(path.join(workdir, 'supabase', 'config.toml'), `project_id = "${PROJECT}-push"\n\n[db]\nport = ${DB_PORT}\n`);
    // The CLI stops on ledger rows with no file, so each gets an empty stand-in it treats as applied.
    for (const version of scalar('SELECT version FROM supabase_migrations.schema_migrations;').split(/\r?\n/)) {
      if (!/^\d{14}$/.test(version)) throw new Error('The ledger holds a version that is not a timestamp.');
      writeFileSync(path.join(workdir, 'supabase', 'migrations', `${version}_in_baseline_ledger.sql`), '');
    }
    // The CLI stores what follows the version as the name, so this makes it store the whole stem,
    // which is what live's ledger holds and what later migrations look for.
    const ledgerFile = (name) => `${name.slice(0, 14)}_${name}`;
    const push = (names) => {
      for (const name of names) writeFileSync(path.join(workdir, 'supabase', 'migrations', ledgerFile(name)), migrationBytes(`supabase/migrations/${name}`));
      const db = ['--workdir', workdir, 'db', 'push', '--db-url', state.LOCAL_DB_URL, '--include-all'];
      const dry = run('supabase', [...db, '--dry-run']);
      const planned = [...`${dry.stdout}${dry.stderr}`.matchAll(/\d{14}_\S+\.sql/g)].map(([name]) => name);
      if (planned.join() !== names.map(ledgerFile).join()) {
        throw new Error(`The push plan differs from the approved list (${planned.length} vs ${names.length}). Nothing was pushed.`);
      }
      if (names.length) run('supabase', db, { input: 'y\n' });
    };
    // One-shot data fixes target live rows and are withheld from the plan. This database has no
    // business rows to correct, so each is recorded as done at its place in the order: later
    // migrations check that it happened, and earlier ones check that nothing newer has.
    const { one_shot: oneShot } = JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8'));
    const names = files.map((file) => path.basename(file));
    let done = 0;
    for (const stem of Object.keys(oneShot).sort()) {
      const until = names.findIndex((name) => name > stem);
      const next = until < 0 ? names.length : until;
      push(names.slice(done, next));
      done = next;
      writeFileSync(path.join(workdir, 'supabase', 'migrations', ledgerFile(`${stem}.sql`)), '');
      run('supabase', ['--workdir', workdir, 'migration', 'repair', stem.slice(0, 14), '--status', 'applied', '--db-url', state.LOCAL_DB_URL]);
    }
    push(names.slice(done));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  return files;
}

async function seed(state) {
  const headers = { apikey: state.LOCAL_SERVICE_KEY, Authorization: `Bearer ${state.LOCAL_SERVICE_KEY}`, 'Content-Type': 'application/json' };
  const email = state.LOCAL_TEST_EMAIL;
  if (scalar(`SELECT count(*) FROM auth.users WHERE email = '${email}';`) === '0') {
    const created = await fetch(`${API_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password: state.LOCAL_TEST_PASSWORD, email_confirm: true, user_metadata: { full_name: 'Test Admin (invented)' } }),
    });
    if (!created.ok) throw new Error(`Could not create the test user: ${created.status} ${await created.text()}`);
  }
  // New accounts start inactive and banned, and only an admin can approve one. The first admin
  // has nobody to ask, so these writes skip the triggers that enforce that.
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = (SELECT id FROM auth.users WHERE email = '${email}');
    UPDATE auth.users SET banned_until = NULL WHERE email = '${email}';
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  psql(readFileSync(path.join(HERE, 'seed.sql')));
  const users = scalar('SELECT count(*) FROM auth.users;');
  if (users !== '1') throw new Error(`Expected one test user, found ${users}.`);
}

async function rebuild() {
  await preflight({ needState: false });
  stopFrontend();
  const state = readState() ?? createState();
  compose(['down', '-v', '--remove-orphans']);
  await startDatabase(state);
  await startServices(state);
  assertSealed();
  run(process.execPath, ['scripts/verify-schema-baseline.mjs']);
  console.log('Restoring the baseline...');
  restoreBaseline();
  console.log('Pushing the approved migrations...');
  // Some migrations refuse to run beside another open transaction, so the services wait.
  compose(['stop', 'auth', 'rest', 'storage']);
  const migrations = pushPostBaselineMigrations(state);
  // The services can come back on swapped addresses, and the gateway remembers the old ones.
  compose(['stop', 'gateway']);
  await startServices(state);
  await seed(state);
  const ledgerRows = scalar('SELECT count(*) FROM supabase_migrations.schema_migrations;');
  const build = { commit: text(run('git', ['rev-parse', 'HEAD'])), builtAt: new Date().toISOString(), ledgerRows, migrations };
  writeFileSync(BUILD_FILE, JSON.stringify(build, null, 2));
  console.log(`Rebuilt from ${build.commit}: ${migrations.length} migrations pushed, ${ledgerRows} ledger rows.`);
}

// The sealed services, the database among them, must have no way out, or a stray job could reach
// a real service. Runs before anything is restored.
function assertSealed() {
  const probe = "const net=require('net');const s=net.connect({host:'1.1.1.1',port:443,timeout:3000});s.on('connect',()=>{console.log('OPEN');s.destroy()});s.on('error',()=>console.log('SEALED'));s.on('timeout',()=>{console.log('SEALED');s.destroy()});";
  const result = text(compose(['exec', '-T', 'storage', 'node', '-e', probe]));
  if (result !== 'SEALED') throw new Error('The sealed network has a route out. Stopping.');
}

// Only called after preflight has confirmed that whatever is on the port is this test app.
// shortcut: Windows only, like everything else that runs this today; add lsof when another OS does.
function stopFrontend() {
  const listener = new RegExp(`127\\.0\\.0\\.1:${APP_PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`).exec(text(run('netstat', ['-ano', '-p', 'tcp'])));
  if (listener) run('taskkill', ['/pid', listener[1], '/t', '/f'], { allowFailure: true });
}

function frontendEnv(state) {
  return childEnv({
    VITE_SUPABASE_URL: API_URL,
    VITE_SUPABASE_ANON_KEY: state.LOCAL_ANON_KEY,
    // Set empty so a checkout's .env cannot switch on a service outside this computer.
    VITE_MAPBOX_TOKEN: '',
    VITE_SENTRY_DSN: '',
  });
}
const VITE = ['node_modules/vite/bin/vite.js', '--config', 'scripts/local-app/vite.config.mjs', '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort'];

async function start() {
  const state = await preflight();
  await startDatabase(state);
  await startServices(state);
  if (!(await portIsOpen(APP_PORT))) {
    spawn(process.execPath, VITE, { cwd: ROOT, env: frontendEnv(state), detached: true, stdio: 'ignore' }).unref();
    await waitFor('test app', () => portIsOpen(APP_PORT));
  }
  await assertFrontendIsOurs(state.LOCAL_ANON_KEY);
  console.log(`Test app: ${APP_URL}\nSign in with LOCAL_TEST_EMAIL and LOCAL_TEST_PASSWORD from scripts/local-app/.state/local.env`);
}

async function frontend() {
  const state = await preflight();
  run(process.execPath, VITE, { env: frontendEnv(state), stdio: 'inherit' });
}

async function test() {
  await preflight();
  run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'scripts/local-app/playwright.config.ts'], { stdio: 'inherit' });
}

async function status() {
  const state = await preflight();
  console.log(`Test app is ${(await portIsOpen(APP_PORT)) ? 'running' : 'stopped'} at ${state.LOCAL_APP_URL}`);
  console.log(text(compose(['ps', '--format', '{{.Service}} {{.Status}}'])) || 'The back end is stopped.');
  if (existsSync(BUILD_FILE)) {
    const build = JSON.parse(readFileSync(BUILD_FILE, 'utf8'));
    console.log(`Built ${build.builtAt} from ${build.commit}: ${build.migrations.length} migrations, ${build.ledgerRows} ledger rows`);
  }
}

async function stop() {
  await preflight();
  stopFrontend();
  compose(['stop']);
}

const COMMANDS = {
  rebuild,
  start,
  frontend,
  stop,
  status,
  test,
  seed: async () => seed(await preflight()),
};

(COMMANDS[process.argv[2]] ?? (() => { throw new Error(`Use one of: ${Object.keys(COMMANDS).join(', ')}`); }))().catch((error) => {
  console.error(error.message);
  // Not process.exit(): on Windows it can crash Node while a fetch is still closing.
  process.exitCode = error instanceof Refused ? 3 : 1;
});
