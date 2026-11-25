// Run: node --test scripts/local-app/target.test.mjs
// The command tests start each real command and need port 5199 free.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  API_PORT, API_URL, APP_PORT, APP_URL, DB_PORT, DB_URL_PREFIX, DB_URL_SUFFIX, ISSUER, Refused,
  IS_SALES_GAUNTLET, IS_SCREEN_WALK, PROJECT,
  sameComposePath, assertAppPortIsLoopback, assertCleanEnvironment, assertExtraAppPort, assertFinishedBuild, assertFrontendIsOurs, assertLocalDockerEndpoint, assertLocalState, assertLoopbackBindings, assertWalkthroughLaneResourcesAreEmpty, assertOwnedApiDbListeners, assertWalkthroughGatewayIdentity,
  denyInsideCheckout,
} from './target.mjs';
import { acquireLaneLock } from './lane-lock.mjs';
import { schemaFingerprint } from './schema-fingerprint.mjs';
import { isFileLoadingAllowed, resolveConfig } from 'vite';
import { tempDir } from "../lib/test-temp-dir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, 'app.mjs');
const PROD_URL = 'https://rhyzpcqhnizqbxphqdkr.supabase.co';
const PROD_DB = 'postgresql://postgres:x@db.rhyzpcqhnizqbxphqdkr.supabase.co:5432/postgres';
// Everything below assumes a shell with nothing live in it, the Docker calls here included.
assertCleanEnvironment();

// A child must pick its own profile, lane and state folder, never the ones this runner was started with.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^CRX_LOCAL_APP_(PROFILE|LANE|STATE_DIR)$/.test(name)));

const COMMANDS = ['rebuild', 'seed', 'start', 'frontend', 'stop', 'status', 'test'];

const PASSWORD = '0123456789abcdef0123456789abcdef';
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
const SECRET = 'ab'.repeat(32);
const signed = (secret, payload) => {
  const body = `${b64({ alg: 'HS256' })}.${b64(payload)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
};
const localKey = (role) => signed(SECRET, { iss: ISSUER, role });
const liveKey = jwt({ iss: 'supabase', ref: 'rhyzpcqhnizqbxphqdkr', role: 'service_role' });

const goodState = () => ({
  LOCAL_API_URL: API_URL,
  LOCAL_APP_URL: APP_URL,
  LOCAL_API_PORT: String(API_PORT),
  LOCAL_DB_PORT: String(DB_PORT),
  LOCAL_DB_PASSWORD: PASSWORD,
  LOCAL_DB_URL: `${DB_URL_PREFIX}${PASSWORD}${DB_URL_SUFFIX}`,
  LOCAL_JWT_SECRET: SECRET,
  LOCAL_ANON_KEY: localKey('anon'),
  LOCAL_SERVICE_KEY: localKey('service_role'),
  LOCAL_TEST_EMAIL: 'admin@crx-local-app.test',
  LOCAL_TEST_PASSWORD: '0123456789abcdef01234567',
  ...(IS_SALES_GAUNTLET ? {
    LOCAL_REP_EMAIL: 'rep@crx-sales-gauntlet.test', LOCAL_REP_PASSWORD: '0123456789abcdef01234567',
    LOCAL_OTHER_REP_EMAIL: 'other-rep@crx-sales-gauntlet.test', LOCAL_OTHER_REP_PASSWORD: 'abcdef0123456789abcdef01',
  } : {}),
});

describe('isolated sales profile', () => {
  it('selects only the fixed task ports, issuer and private state folder', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as target from ${JSON.stringify(new URL('./target.mjs', import.meta.url).href)};
      console.log(JSON.stringify([target.PROJECT, target.APP_PORT, target.API_PORT, target.DB_PORT, target.ISSUER, target.STATE_FOLDER]));
    `], { encoding: 'utf8', env: { ...process.env, CRX_LOCAL_APP_PROFILE: 'sales-gauntlet' } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['crx-sales-gauntlet', 5209, 54821, 54822, 'crx-sales-gauntlet', '.state/sales-gauntlet']);
  });
  it('selects a deterministic, separate walkthrough stack for a feature checkout', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as target from ${JSON.stringify(new URL('./target.mjs', import.meta.url).href)};
      console.log(JSON.stringify([target.PROJECT, target.APP_PORT, target.API_PORT, target.DB_PORT, target.ISSUER, target.STATE_FOLDER]));
    `], { encoding: 'utf8', env: { ...process.env, CRX_LOCAL_APP_PROFILE: 'screen-walk', CRX_LOCAL_APP_LANE: '89abcdef' } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['crx-screen-89abcdef', 17967, 31967, 41967, 'crx-screen-89abcdef', '.state/screen-walk']);
  });
  it('refuses a walkthrough profile with no checkout identity', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import './scripts/local-app/target.mjs'`], {
      cwd: path.resolve(HERE, '..', '..'), encoding: 'utf8', env: { ...process.env, CRX_LOCAL_APP_PROFILE: 'screen-walk', CRX_LOCAL_APP_LANE: '' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid screen-walk lane/);
  });
  it('allows a new walkthrough lane only when its project resources and ports are unused', () => {
    assert.doesNotThrow(() => assertWalkthroughLaneResourcesAreEmpty({ containers: '', volumes: '', networks: '', netstat: '' }));
    assert.throws(() => assertWalkthroughLaneResourcesAreEmpty({ containers: 'container-id', volumes: '', networks: '', netstat: '' }), /container exists/);
    assert.throws(() => assertWalkthroughLaneResourcesAreEmpty({ containers: '', volumes: 'volume-id', networks: '', netstat: '' }), /volume exists/);
    assert.throws(() => assertWalkthroughLaneResourcesAreEmpty({ containers: '', volumes: '', networks: 'network-id', netstat: '' }), /network exists/);
    assert.throws(() => assertWalkthroughLaneResourcesAreEmpty({ containers: '', volumes: '', networks: '', netstat: `TCP 127.0.0.1:${APP_PORT} 0.0.0.0:0 LISTENING 123` }), /new uniquely named checkout/);
  });
  it('refuses API or database listeners not bound by this walkthrough gateway', () => {
    assert.throws(() => assertOwnedApiDbListeners(`TCP 127.0.0.1:${API_PORT} 0.0.0.0:0 LISTENING 123`, []), /not owned by this checkout/);
    assert.doesNotThrow(() => assertOwnedApiDbListeners(`TCP 127.0.0.1:${API_PORT} 0.0.0.0:0 LISTENING 123`, [{ HostIp: '127.0.0.1', HostPort: String(API_PORT) }]));
    for (const address of ['0.0.0.0', '192.168.1.5', '[::]']) {
      assert.throws(() => assertOwnedApiDbListeners(`TCP ${address}:${DB_PORT} 0.0.0.0:0 LISTENING 123`, [{ HostIp: '127.0.0.1', HostPort: String(DB_PORT) }]), /open beyond this computer/);
    }
  });
  it('requires a running gateway from this checkout before trusting its published ports', () => {
    const composeFile = path.join(HERE, 'compose.yaml');
    const container = { State: { Running: true }, Config: { Labels: {
      'com.docker.compose.project': PROJECT,
      'com.docker.compose.service': 'gateway',
      'com.docker.compose.project.config_files': composeFile,
    } }, HostConfig: { PortBindings: { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(API_PORT) }] } } };
    assert.equal(assertWalkthroughGatewayIdentity(container, PROJECT, composeFile).length, 1);
    assert.throws(() => assertWalkthroughGatewayIdentity({ ...container, State: { Running: false } }, PROJECT, composeFile), /gateway identity/);
    assert.throws(() => assertWalkthroughGatewayIdentity({ ...container, Config: { Labels: { ...container.Config.Labels, 'com.docker.compose.project.config_files': 'other-compose.yaml' } } }, PROJECT, composeFile), /gateway identity/);
  });
  it('compares compose paths without regard to capitals on Windows only', () => {
    assert.equal(sameComposePath('C:\\CRX_wt\\a\\compose.yaml', 'c:\\crx_wt\\a\\compose.yaml', 'win32'), true);
    assert.equal(sameComposePath('/srv/A/compose.yaml', '/srv/a/compose.yaml', 'linux'), false);
    assert.equal(sameComposePath('/srv/a/compose.yaml', '/srv/b/compose.yaml', 'linux'), false);
  });
  it('refuses a state file from the other profile', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { assertLocalState, Refused } from ${JSON.stringify(new URL('./target.mjs', import.meta.url).href)};
      assert.throws(() => assertLocalState(JSON.parse(readFileSync(0, 'utf8'))), Refused);
    `], { encoding: 'utf8', input: JSON.stringify(goodState()), env: { ...process.env, CRX_LOCAL_APP_PROFILE: IS_SALES_GAUNTLET ? '' : 'sales-gauntlet' } });
    assert.equal(result.status, 0, result.stderr);
  });
  it('refuses unknown profiles before a command runs', () => {
    const result = spawnSync(process.execPath, [APP, 'rebuild'], { encoding: 'utf8', env: { ...process.env, CRX_LOCAL_APP_PROFILE: 'typo' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown local test profile/);
  });
  it('refuses an unsupported profile flag before a command runs', () => {
    const result = spawnSync(process.execPath, [APP, 'rebuild', '--profile', 'sales-gauntlet'], { encoding: 'utf8' });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /Unsupported test-app arguments/);
  });
  it('reserves every fixed port and the current checkout ports', () => {
    for (const port of [5199, 54721, 54722, 5209, 54821, 54822, 5219, 54831, 54832, APP_PORT, API_PORT, DB_PORT]) assert.throws(() => assertExtraAppPort(String(port)), Refused);
  });
});

describe('walkthrough build manifest', () => {
  it('fingerprints every path from the real approved migration list', () => {
    const root = path.resolve(HERE, '..', '..');
    const listed = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: root, encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    const migrations = listed.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.ok(migrations.length > 0);
    assert.ok(migrations.every((name) => name.startsWith('supabase/migrations/')));
    for (const name of migrations) assert.equal(existsSync(path.join(root, name)), true, name);
    assert.match(schemaFingerprint(root, migrations), /^[a-f0-9]{64}$/);
  });
  it('refuses a missing or incomplete build manifest', () => {
    assert.throws(() => assertFinishedBuild(null, ['one.sql']), /last rebuild did not finish/);
    assert.throws(() => assertFinishedBuild({ migrations: [] }, ['one.sql']), /different migrations/);
  });
  it('refuses same-named migrations with changed contents', () => {
    assert.throws(() => assertFinishedBuild({ migrations: ['one.sql'], schemaFingerprint: 'old' }, ['one.sql'], 'new'), /contents changed/);
    assert.doesNotThrow(() => assertFinishedBuild({ migrations: ['one.sql'], schemaFingerprint: 'new' }, ['one.sql'], 'new'));
  });
  it('uses the recovery command for the active profile', () => {
    assert.throws(() => assertFinishedBuild(null, ['one.sql'], undefined, 'node scripts/local-app/walkthrough.mjs rebuild'), /walkthrough\.mjs rebuild/);
    assert.throws(() => assertFinishedBuild(null, ['one.sql'], undefined, 'node scripts/local-app/sales.mjs rebuild'), /sales\.mjs rebuild/);
  });
  it('rejects a missing spec selection before it asks Docker to start', () => {
    const result = spawnSync(process.execPath, [path.join(HERE, 'walkthrough.mjs'), 'test', 'missing.spec.ts'], { encoding: 'utf8', timeout: 30000, env: cleanEnv() });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /existing, non-sales spec/);
  });
  it('accepts a spec argument only on the walkthrough lane', () => {
    for (const profile of ['', 'sales-gauntlet', 'doc-bytes']) {
      const result = spawnSync(process.execPath, [APP, 'test', 'product-unit.spec.ts'], { encoding: 'utf8', timeout: 30000, env: { ...cleanEnv(), CRX_LOCAL_APP_PROFILE: profile } });
      assert.equal(result.status, 3, profile);
      assert.match(result.stderr, /Unsupported test-app arguments/, profile);
    }
  });
  it('refuses a bad state folder before it writes a lock or folder', () => {
    const bad = path.join(HERE, '.state-private-lock-check');
    const result = spawnSync(process.execPath, [APP, 'start'], { encoding: 'utf8', timeout: 30000, env: { ...cleanEnv(), CRX_LOCAL_APP_PROFILE: 'screen-walk', CRX_LOCAL_APP_LANE: '89abcdef', CRX_LOCAL_APP_STATE_DIR: bad } });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /temp folder/);
    assert.equal(existsSync(bad), false);
  });
  it('the public walkthrough command takes no alternate state folder', () => {
    const result = spawnSync(process.execPath, [path.join(HERE, 'walkthrough.mjs'), 'status'], { encoding: 'utf8', timeout: 30000, env: { ...cleanEnv(), CRX_LOCAL_APP_STATE_DIR: tmpdir() } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not accept CRX_LOCAL_APP_STATE_DIR/);
  });
  it('requires a feature spec on the walkthrough lane', () => {
    const result = spawnSync(process.execPath, [path.join(HERE, 'walkthrough.mjs'), 'test'], { encoding: 'utf8', timeout: 30000, env: cleanEnv() });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /Choose one feature proof/);
  });
});

describe('walkthrough lane lock', () => {
  // A throwaway copy of the scripts: its canonical lock is the fixture's own, so no developer lock is touched.
  const fixture = () => {
    const root = tempDir('crx-lock-fixture-');
    const dir = path.join(root, 'scripts', 'local-app');
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(HERE).filter((name) => /\.mjs$/.test(name) && !/\.test\./.test(name))) copyFileSync(path.join(HERE, file), path.join(dir, file));
    mkdirSync(path.join(dir, 'e2e'), { recursive: true });
    writeFileSync(path.join(dir, 'e2e', 'product-unit.spec.ts'), '');
    return { root, dir, lock: path.join(dir, '.state', 'screen-walk', 'first-start.lock') };
  };
  const hold = (lock) => { mkdirSync(path.dirname(lock), { recursive: true }); writeFileSync(lock, `${process.pid}
`); };
  const screen = (dir, args, stateDir, profile = 'screen-walk') => spawnSync(process.execPath, [path.join(dir, 'app.mjs'), ...args], {
    encoding: 'utf8', timeout: 30000, env: { ...cleanEnv(), CRX_LOCAL_APP_PROFILE: profile, CRX_LOCAL_APP_LANE: '89abcdef', ...(stateDir ? { CRX_LOCAL_APP_STATE_DIR: stateDir } : {}) },
  });
  it('every screen command, including status, contends on the one canonical lock whatever state folder is set', () => {
    const { root, dir, lock } = fixture();
    const alternates = [tempDir('crx-alt-a-'), tempDir('crx-alt-b-')];
    hold(lock);
    try {
      for (const args of [['start'], ['rebuild'], ['stop'], ['seed'], ['status'], ['test', 'product-unit.spec.ts']]) {
        for (const stateDir of [undefined, ...alternates]) {
          const result = screen(dir, args, stateDir);
          assert.equal(result.status, 3, `${args[0]}: ${result.stdout}${result.stderr}`);
          assert.match(result.stderr, /owns this lane/, args[0]);
          assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid));
        }
      }
      for (const alt of alternates) assert.equal(existsSync(path.join(alt, 'first-start.lock')), false);
    } finally {
      for (const folder of [root, ...alternates]) rmSync(folder, { recursive: true, force: true });
    }
  });
  it('the other three profiles take no lane lock', () => {
    const { root, dir, lock } = fixture();
    hold(lock);
    try {
      for (const profile of ['', 'sales-gauntlet', 'doc-bytes']) {
        const result = screen(dir, ['status'], tempDir('crx-alt-'), profile);
        assert.match(result.stderr, /No test app here yet/, profile);
        assert.doesNotMatch(result.stderr, /owns this lane/, profile);
      }
      assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('the walkthrough lane refuses a loose frontend command, which would run unlocked', () => {
    const result = spawnSync(process.execPath, [path.join(HERE, 'walkthrough.mjs'), 'frontend'], { encoding: 'utf8', timeout: 30000, env: cleanEnv() });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /starts its own frontend/);
  });
  it('serializes concurrent first-start and rebuild commands', () => {
    const lockPath = path.join(tempDir('lane-lock-'), 'first-start.lock');
    const release = acquireLaneLock(lockPath);
    assert.throws(() => acquireLaneLock(lockPath), /owns this lane/);
    release();
    assert.equal(existsSync(lockPath), false);
  });
  it('preserves a lock whose recorded process is gone for manual recovery', () => {
    const lockPath = path.join(tempDir('lane-lock-'), 'first-start.lock');
    writeFileSync(lockPath, '987654321\n');
    assert.throws(() => acquireLaneLock(lockPath), /process 987654321.*Nothing was changed/);
    assert.equal(existsSync(lockPath), true);
    assert.equal(readFileSync(lockPath, 'utf8').trim(), '987654321');
  });
});

function viteModule(env) {
  return `import.meta.env = ${JSON.stringify({ BASE_URL: '/', ...env })};import x from "y";\n`;
}
const servedBy = (body, status = 200) => async () => new Response(body, { status });
const portOpen = async () => true;
const ourEnv = { VITE_SUPABASE_URL: API_URL, VITE_SUPABASE_ANON_KEY: localKey('anon'), VITE_MAPBOX_TOKEN: '', VITE_SENTRY_DSN: '' };

describe('inherited environment', () => {
  it('accepts an ordinary shell', () => {
    assert.doesNotThrow(() => assertCleanEnvironment({ PATH: 'C:\\Windows', SUPABASE_GO_BINARY: 'C:\\x\\supabase-go.exe' }));
  });
  for (const [name, env] of [
    ['a production URL', { VITE_SUPABASE_URL: PROD_URL }],
    ['a production database URL', { DATABASE_URL: PROD_DB }],
    ['a live key under any name', { SOME_KEY: liveKey }],
    ['a production address under any name', { MY_NOTE: PROD_URL }],
    ['a management token', { RANDOM: 'sbp_abc123' }],
    ['a secret key', { RANDOM: 'sb_secret_abc' }],
    ['the production site', { RANDOM: 'https://croprxsolutions.app' }],
    ['a Postgres host', { PGHOST: 'db.example.com' }],
    ['a Postgres password', { PGPASSWORD: 'x' }],
    ['any access token, even an unknown one', { SUPABASE_ACCESS_TOKEN: 'abc' }],
    ['a lower-case Windows name', { database_url: PROD_DB }],
    ['a remote Docker', { DOCKER_HOST: 'tcp://10.0.0.5:2375' }],
    ['a Docker context chosen by the shell', { DOCKER_CONTEXT: 'elsewhere' }],
    ['a Docker settings folder chosen by the shell', { DOCKER_CONFIG: 'C:\\elsewhere' }],
  ]) {
    it(`refuses ${name}`, () => assert.throws(() => assertCleanEnvironment(env), Refused));
  }
  it('names the variable and never prints its value', () => {
    assert.throws(() => assertCleanEnvironment({ SOME_KEY: liveKey }), (error) => error.message.includes('SOME_KEY') && !error.message.includes(liveKey));
  });
});

describe('saved settings', () => {
  it('accepts what the test app generates', () => assert.doesNotThrow(() => assertLocalState(goodState())));
  for (const [name, change] of [
    ['a production API address', { LOCAL_API_URL: PROD_URL }],
    ['a production database address', { LOCAL_DB_URL: PROD_DB }],
    ['a database on another port', { LOCAL_DB_URL: `${DB_URL_PREFIX}x@127.0.0.1:5432/postgres?sslmode=disable` }],
    ['a database elsewhere that ends like the real one', { LOCAL_DB_URL: `${DB_URL_PREFIX}${PASSWORD}@db.example.com:5432/x?a=${DB_URL_SUFFIX}` }],
    ['a password carrying a host', { LOCAL_DB_PASSWORD: 'x@db.example.com:5432/x?a=', LOCAL_DB_URL: `${DB_URL_PREFIX}x@db.example.com:5432/x?a=${DB_URL_SUFFIX}` }],
    ['a password that could break out of SQL', { LOCAL_DB_PASSWORD: "x'; DROP ROLE y; --" }],
    ['a LAN gateway', { LOCAL_API_URL: `http://192.168.1.5:${API_PORT}` }],
    ['a production app address', { LOCAL_APP_URL: 'https://croprxsolutions.app' }],
    ['another port', { LOCAL_API_PORT: '54321' }],
    ['a live key', { LOCAL_SERVICE_KEY: liveKey }],
    ['a live anon key', { LOCAL_ANON_KEY: liveKey }],
    ['the service key in the place of the browser key', { LOCAL_ANON_KEY: localKey('service_role') }],
    ['a key that is not a token', { LOCAL_ANON_KEY: 'x' }],
    ['a key claiming to be local that another secret signed', { LOCAL_SERVICE_KEY: signed('cd'.repeat(32), { iss: ISSUER, role: 'service_role' }) }],
    ['a test email carrying SQL', { LOCAL_TEST_EMAIL: "x'; DROP TABLE y; --" }],
    ['a test password carrying anything else', { LOCAL_TEST_PASSWORD: 'x$y' }],
    ['a port written another way', { LOCAL_API_PORT: '5.4721e4' }],
    ['a line Docker would read differently', { 'export LOCAL_API_URL': PROD_URL }],
    ['an extra setting', { COMPOSE_FILE: 'elsewhere.yaml' }],
    ['a secret of the wrong shape', { LOCAL_JWT_SECRET: 'super-secret-production-jwt-secret-with-at-least-32-characters' }],
  ]) {
    it(`refuses ${name}`, () => assert.throws(() => assertLocalState({ ...goodState(), ...change }), Refused));
  }
});

describe('running frontend', () => {
  it('is fine when nothing is running', async () => {
    await assert.doesNotReject(assertFrontendIsOurs(localKey('anon'), { isOpen: async () => false, fetchFn: async () => assert.fail('must not fetch') }));
  });
  it('never follows a redirect away from the app', async () => {
    const fetchFn = async (_, options) => {
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { Location: PROD_URL } });
    };
    await assert.rejects(assertFrontendIsOurs(localKey('anon'), { isOpen: portOpen, fetchFn }), Refused);
  });
  it('accepts the test app', async () => {
    await assert.doesNotReject(assertFrontendIsOurs(localKey('anon'), { isOpen: portOpen, fetchFn: servedBy(viteModule(ourEnv)) }));
  });
  for (const [name, fetchFn] of [
    ['one wired to production', servedBy(viteModule({ ...ourEnv, VITE_SUPABASE_URL: PROD_URL }))],
    ['one using a live key', servedBy(viteModule({ ...ourEnv, VITE_SUPABASE_ANON_KEY: liveKey }))],
    ['a look-alike with a key of its own', servedBy(viteModule({ ...ourEnv, VITE_SUPABASE_ANON_KEY: jwt({ iss: ISSUER, role: 'anon' }) }))],
    ['one with an extra setting from a .env file', servedBy(viteModule({ ...ourEnv, VITE_SERVICE_ROLE_KEY: 'x' }))],
    ['one with map calls switched on', servedBy(viteModule({ ...ourEnv, VITE_MAPBOX_TOKEN: 'pk.x' }))],
    ['one with error reporting switched on', servedBy(viteModule({ ...ourEnv, VITE_SENTRY_DSN: 'https://a@b.ingest.sentry.io/1' }))],
    ['a built site', servedBy('<html></html>')],
    ['something that is not a web app', servedBy('nope', 404)],
    ['something that hangs up', async () => { throw new Error('reset'); }],
    ['garbled settings', servedBy('import.meta.env = {nope};')],
  ]) {
    it(`refuses ${name}`, async () => {
      await assert.rejects(assertFrontendIsOurs(localKey('anon'), { isOpen: portOpen, fetchFn }), Refused);
    });
  }
});

describe('private folders', () => {
  for (const parent of ['/CRX_Manager', '/CRX (old) [1]/a+b'].map((folder) => path.resolve(folder).replaceAll('\\', '/'))) {
    it(`serves a checkout under ${parent}/.claude but not its own .claude`, async () => {
      const root = `${parent}/.claude/worktrees/one`;
      const config = await resolveConfig({
        configFile: false, root, server: { fs: { allow: [root], deny: [denyInsideCheckout(`${root}\\`, '.claude')] } },
      }, 'serve');
      assert.equal(isFileLoadingAllowed(config, `${root}/src/lib/db.ts`), true);
      assert.equal(isFileLoadingAllowed(config, `${root}/.claude/settings.json`), false);
      assert.equal(isFileLoadingAllowed(config, `${root.toLowerCase()}/.CLAUDE/settings.json`), false);
      assert.equal(isFileLoadingAllowed(config, `${root}/sub/.claude/settings.json`), false);
      assert.equal(isFileLoadingAllowed(config, `${parent}/.claude/settings.json`), false);
      assert.equal(isFileLoadingAllowed(config, `${parent}/.claude/worktrees/two/src/lib/db.ts`), false);
    });
  }
});

describe('network exposure', () => {
  it('accepts loopback', () => assert.doesNotThrow(() => assertLoopbackBindings([{ HostIp: '127.0.0.1', HostPort: '54721' }])));
  for (const HostIp of ['0.0.0.0', '', '192.168.1.5', '::']) {
    it(`refuses a binding on "${HostIp}"`, () => assert.throws(() => assertLoopbackBindings([{ HostIp, HostPort: '54721' }]), Refused));
  }
  it('accepts a frontend open only on loopback, or none', () => {
    assert.doesNotThrow(() => assertAppPortIsLoopback(`  TCP    127.0.0.1:${APP_PORT}    0.0.0.0:0    LISTENING    123\n`));
    assert.doesNotThrow(() => assertAppPortIsLoopback('  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    123\n'));
  });
  for (const address of ['0.0.0.0', '192.168.1.5', '[::]']) {
    it(`refuses a frontend open on ${address}`, () => {
      assert.throws(() => assertAppPortIsLoopback(`  TCP    ${address}:${APP_PORT}    0.0.0.0:0    LISTENING    123\n`), Refused);
    });
  }
  it('accepts a second frontend on a free user port', () => assert.equal(assertExtraAppPort('5201'), 5201));
  for (const port of [String(APP_PORT), String(API_PORT), String(DB_PORT), '80', '1023', '65536', '5201abc', '0x1451', '', undefined]) {
    it(`refuses a second frontend on port "${port}"`, () => assert.throws(() => assertExtraAppPort(port), Refused));
  }
  it('frontend --port refuses the shared copy\'s port before anything starts', () => {
    const result = spawnSync(process.execPath, [APP, 'frontend', '--port', String(APP_PORT)], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 3);
    assert.match(result.stderr, IS_SCREEN_WALK ? /starts its own frontend/ : /--port needs a port/);
  });
  it('accepts this computer\'s Docker', () => {
    assert.doesNotThrow(() => assertLocalDockerEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine'));
    assert.doesNotThrow(() => assertLocalDockerEndpoint('unix:///var/run/docker.sock'));
  });
  for (const endpoint of ['npipe:////otherpc/pipe/docker_engine', 'tcp://10.0.0.5:2375', 'ssh://user@host', 'https://docker.example.com', '']) {
    it(`refuses a Docker at "${endpoint}"`, () => assert.throws(() => assertLocalDockerEndpoint(endpoint), Refused));
  }
  it('the compose file publishes only the gateway, only on loopback, and seals the rest', () => {
    const lines = readFileSync(path.join(HERE, 'compose.yaml'), 'utf8').split(/\r?\n/);
    const ports = lines.filter((line) => /^\s+- .*:\d+$/.test(line) && !line.includes(':/'));
    assert.equal(ports.length, 2);
    for (const port of ports) assert.match(port, /- 127\.0\.0\.1:\$\{LOCAL_(API|DB)_PORT\}:/);
    assert.equal(lines.filter((line) => /^\s+ports:/.test(line)).length, 1);
    assert.equal(lines.filter((line) => line.trim() === 'networks: [sealed]').length, 4);
    assert.equal(lines.filter((line) => line.trim() === 'networks: [sealed, published]').length, 1);
    assert.ok(lines.includes('    internal: true'));
    assert.ok(lines.includes('      GOTRUE_DISABLE_SIGNUP: "true"'));
  });
  it('every gateway route answers only to loopback and the test app', () => {
    const kong = readFileSync(path.join(HERE, 'kong.yml'), 'utf8');
    assert.equal(kong.match(/hosts: \[127\.0\.0\.1\]/g).length, 3);
    assert.equal(kong.match(/origins: \["http:\/\/127\.0\.0\.1:5199"\]/g).length, 3);
    assert.equal(kong.match(/- name: cors$/gm).length, 3);
  });
});

// Each real command, against a copy of the settings, must stop before it touches a container.
// These really run the commands, so if a guard ever breaks they must have nowhere real to go:
// the addresses carry the production ref but end in .invalid, which can never resolve.
describe('every command refuses before it changes anything', () => {
  const NO_ROUTE_URL = `${PROD_URL}.invalid`;
  const NO_ROUTE_DB = 'postgresql://postgres:x@db.rhyzpcqhnizqbxphqdkr.supabase.co.invalid:5432/postgres';
  // What identifies a container and its last start, so any restart or replacement shows.
  const containers = () => {
    const docker = (args) => {
      const result = spawnSync('docker', args, { encoding: 'utf8' });
      assert.equal(result.status, 0, 'These tests need Docker running.');
      return result.stdout;
    };
    return [...new Set(['crx-local-app', PROJECT])].map((project) => {
      const filter = `label=com.docker.compose.project=${project}`;
      const ids = docker(['ps', '-aq', '--filter', filter]).trim();
      const label = ['--filter', filter, '--format', '{{.Name}}'];
      const others = ['volume', 'network'].map((kind) => docker([kind, 'ls', ...label])).join();
      return others + (ids ? docker(['inspect', '-f', '{{.Id}} {{.State.Status}} {{.State.StartedAt}}', ...ids.split(/\s+/)]) : '');
    }).join();
  };

  function refused(command, { state = goodState(), env = {}, reason }) {
    const dir = tempDir('crx-local-app-test-');
    try {
      writeFileSync(path.join(dir, 'local.env'), `${Object.entries(state).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
      const before = containers();
      const args = IS_SCREEN_WALK && command === 'test' ? ['product-unit.spec.ts'] : [];
      const result = spawnSync(process.execPath, [APP, command, ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, CRX_LOCAL_APP_STATE_DIR: dir, ...env } });
      assert.equal(result.status, 3, `${command} did not refuse: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, reason);
      assert.equal(containers(), before, `${command} changed a container`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const command of COMMANDS.filter((name) => !IS_SCREEN_WALK || name !== 'frontend')) {
    it(`${command}: a production address`, () => refused(command, { state: { ...goodState(), LOCAL_API_URL: NO_ROUTE_URL }, reason: /LOCAL_APP_REFUSED: LOCAL_API_URL is not this computer's test gateway/ }));
    it(`${command}: a production database`, () => refused(command, { state: { ...goodState(), LOCAL_DB_URL: NO_ROUTE_DB }, reason: /LOCAL_APP_REFUSED: LOCAL_DB_URL is not this computer's test database/ }));
    it(`${command}: an inherited live credential`, () => refused(command, { env: { SUPABASE_SERVICE_ROLE_KEY: liveKey }, reason: /LOCAL_APP_REFUSED: SUPABASE_SERVICE_ROLE_KEY (?:is set in this shell|holds a production address or credential)/ }));
  }

  for (const folder of [path.join(HERE, '..', '..', 'public'), path.join(HERE, '.state-private')]) {
    it(`the settings folder cannot be ${path.basename(folder)}, where the frontend could serve it`, () => {
      const result = spawnSync(process.execPath, [APP, 'status'], {
        encoding: 'utf8', timeout: 30000, env: { ...process.env, CRX_LOCAL_APP_STATE_DIR: folder },
      });
      assert.equal(result.status, 3);
      assert.match(result.stderr, /temp folder/);
    });
  }

  it('every command: an unknown running frontend', async () => {
    const server = createServer((_, response) => response.end('<html>not the test app</html>'));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(APP_PORT, '127.0.0.1', resolve);
    });
    try {
      for (const command of COMMANDS) {
        await new Promise((resolve) => setImmediate(resolve));
        const dir = tempDir('crx-local-app-test-');
        try {
          writeFileSync(path.join(dir, 'local.env'), `${Object.entries(goodState()).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
          const before = containers();
          const child = await runAsync(command, dir, IS_SCREEN_WALK && command === 'test' ? ['product-unit.spec.ts'] : []);
          assert.equal(child.status, 3, `${command} did not refuse: ${child.output}`);
          assert.match(child.output, IS_SCREEN_WALK && command === 'frontend' ? /starts its own frontend/ : /unknown frontend/);
          assert.equal(containers(), before);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// The server above lives in this process, so the child cannot block it.
async function runAsync(command, dir, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [APP, command, ...args], { timeout: 30000, env: { ...process.env, CRX_LOCAL_APP_STATE_DIR: dir } });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('close', (status) => resolve({ status, output }));
  });
}
