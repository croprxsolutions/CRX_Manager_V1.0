// The safety checks every local-app command runs before it touches anything.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { connect } from 'node:net';

export const PROJECT = 'crx-local-app';
export const API_PORT = 54721;
export const DB_PORT = 54722;
export const APP_PORT = 5199;
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;
export const DB_URL_PREFIX = `postgresql://postgres:`;
export const DB_URL_SUFFIX = `@127.0.0.1:${DB_PORT}/postgres?sslmode=disable`;
export const ISSUER = 'crx-local-app';
export const TEST_EMAIL = 'admin@crx-local-app.test';

const PROD_REF = 'rhyzpcqhnizqbxphqdkr';
// Names that decide where a database or Supabase tool connects, or that hold a live credential.
const CONNECTION_VARS = [
  'DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_URL', 'SUPABASE_DB_URL', 'SUPABASE_DB_PASSWORD',
  'SUPABASE_ACCESS_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY',
  'SUPABASE_PROJECT_ID', 'SUPABASE_PROJECT_REF', 'CRX_LIVE_SCHEMA_SERVICE_ROLE_KEY',
  'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'E2E_SUPABASE_URL', 'E2E_SUPABASE_ANON_KEY',
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
  'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSERVICE', 'PGPASSFILE',
];
const LIVE_VALUE = [
  new RegExp(PROD_REF, 'i'),
  /\.supabase\.(co|com|net|in)\b/i,
  /croprxsolutions\.app/i,
  /\bsbp_[A-Za-z0-9]/,
  /\bsb_(secret|publishable)_/,
];

/**
 * A Vite deny pattern for a folder name anywhere inside this checkout. Vite matches whole paths, so a
 * bare `**\/.claude/**` would also deny every file of a checkout that itself sits under a .claude folder.
 * Escaped, because a bracket or parenthesis left in the path would stop the pattern matching at all.
 */
export function denyInsideCheckout(root, folder) {
  const escaped = root.replaceAll('\\', '/').replace(/\/+$/, '').replace(/[$^*+?()[\]{}!|]/g, '\\$&');
  return `${escaped}/**/${folder}/**`;
}

export class Refused extends Error {
  constructor(message) {
    super(`LOCAL_APP_REFUSED: ${message}`);
    this.name = 'Refused';
  }
}

function jwtPayload(token) {
  const part = String(token ?? '').split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function looksLive(value) {
  if (LIVE_VALUE.some((pattern) => pattern.test(value))) return true;
  const payload = jwtPayload(value);
  return Boolean(payload && (payload.iss !== ISSUER || payload.ref));
}

/** Refuses a shell that already carries a live connection or key. Names only; values never print. */
export function assertCleanEnvironment(env = process.env) {
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (CONNECTION_VARS.includes(name.toUpperCase())) {
      throw new Refused(`${name} is set in this shell. Unset it first: the test app never inherits a connection.`);
    }
    if (looksLive(value)) {
      throw new Refused(`${name} holds a production address or credential. Unset it first.`);
    }
  }
}

/** Refuses a Docker that lives on another machine, wherever its address came from. */
export function assertLocalDockerEndpoint(endpoint) {
  if (!/^(npipe:\/\/\/\/\.\/|unix:\/\/)/.test(endpoint)) throw new Refused('Docker points away from this computer.');
}

/** A key counts only if this state's own secret signed it, so a key from anywhere else fails. */
function signedBy(secret, token) {
  const [header, payload, signature] = String(token ?? '').split('.');
  if (!header || !payload || !signature) return false;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Refuses saved settings that point anywhere but the fixed loopback ports. Nothing goes unchecked,
 * because Docker reads this file too and its parser is looser than the one that loads it here.
 */
export function assertLocalState(state) {
  const known = ['LOCAL_API_URL', 'LOCAL_APP_URL', 'LOCAL_API_PORT', 'LOCAL_DB_PORT', 'LOCAL_DB_PASSWORD', 'LOCAL_DB_URL',
    'LOCAL_JWT_SECRET', 'LOCAL_ANON_KEY', 'LOCAL_SERVICE_KEY', 'LOCAL_TEST_EMAIL', 'LOCAL_TEST_PASSWORD'];
  if (Object.keys(state).sort().join() !== [...known].sort().join()) {
    throw new Refused('The saved settings hold something the test app did not write.');
  }
  if (state.LOCAL_TEST_EMAIL !== TEST_EMAIL || !/^[0-9a-f]{24}$/.test(state.LOCAL_TEST_PASSWORD)) {
    throw new Refused('The saved test user is not the one this test app generated.');
  }
  if (state.LOCAL_API_URL !== API_URL) throw new Refused('LOCAL_API_URL is not this computer\'s test gateway.');
  if (state.LOCAL_APP_URL !== APP_URL) throw new Refused('LOCAL_APP_URL is not this computer\'s test app.');
  if (state.LOCAL_API_PORT !== String(API_PORT) || state.LOCAL_DB_PORT !== String(DB_PORT)) {
    throw new Refused('The saved ports are not the test app\'s ports.');
  }
  // An exact match: a prefix and suffix check would pass user:x@elsewhere/?a=@127.0.0.1:port.
  if (!/^[0-9a-f]{32}$/.test(state.LOCAL_DB_PASSWORD ?? '')
    || state.LOCAL_DB_URL !== `${DB_URL_PREFIX}${state.LOCAL_DB_PASSWORD}${DB_URL_SUFFIX}`) {
    throw new Refused('LOCAL_DB_URL is not this computer\'s test database.');
  }
  if (!/^[0-9a-f]{64}$/.test(state.LOCAL_JWT_SECRET ?? '')) {
    throw new Refused('LOCAL_JWT_SECRET is not a secret this test app generated.');
  }
  for (const [name, role] of [['LOCAL_ANON_KEY', 'anon'], ['LOCAL_SERVICE_KEY', 'service_role']]) {
    const payload = jwtPayload(state[name]);
    if (payload?.iss !== ISSUER || payload.role !== role || looksLive(state[name]) || !signedBy(state.LOCAL_JWT_SECRET, state[name])) {
      throw new Refused(`${name} is not a key this test app generated.`);
    }
  }
}

export function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Refuses when something on the app port is not a test app wired to the test gateway.
 * Vite writes the Supabase address into the module it serves, so this reads what the
 * running frontend will really talk to rather than trusting a pid or a port number.
 */
/** Refuses a frontend open beyond this computer. Takes the output of `netstat -ano -p tcp`. */
export function assertAppPortIsLoopback(netstat) {
  const listeners = netstat.split(/\r?\n/).filter((line) => line.includes(`:${APP_PORT} `) && /LISTENING/.test(line));
  if (listeners.some((line) => !line.trim().split(/\s+/)[1].startsWith('127.0.0.1:'))) {
    throw new Refused(`Port ${APP_PORT} is open beyond this computer.`);
  }
}

export async function assertFrontendIsOurs(anonKey, { isOpen = portIsOpen, fetchFn = fetch } = {}) {
  if (!(await isOpen(APP_PORT))) return;
  let source = '';
  try {
    // A cold Vite can take this long on its first module. Timing out still refuses.
    const response = await fetchFn(`${APP_URL}/src/lib/db.ts`, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
    source = response.ok ? await response.text() : '';
  } catch {
    source = '';
  }
  let served = {};
  try {
    served = JSON.parse(/import\.meta\.env = (\{.*?\});/.exec(source)?.[1] ?? '{}');
  } catch {
    served = {};
  }
  const ours = served.VITE_SUPABASE_URL === API_URL
    && Boolean(anonKey) && served.VITE_SUPABASE_ANON_KEY === anonKey
    && !served.VITE_MAPBOX_TOKEN
    && !served.VITE_SENTRY_DSN
    && Object.keys(served).filter((key) => key.startsWith('VITE_')).length === 4;
  if (!ours) throw new Refused(`An unknown frontend is running on port ${APP_PORT}. Stop it first.`);
}

/** Refuses a running gateway that publishes anywhere but loopback. */
export function assertLoopbackBindings(bindings) {
  for (const binding of bindings) {
    if (binding.HostIp !== '127.0.0.1') {
      throw new Refused(`A test-app port is open beyond this computer (${binding.HostIp}:${binding.HostPort}).`);
    }
  }
}
