import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT, Refused, assertLocalDockerEndpoint } from '../target.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));

// The same checks app.mjs runs before it touches the database, on every call: Docker on this computer,
// and the crx-local-app stack started from a local-app compose file. Returns that Docker address, which the
// SQL call then uses, so a context switch in between cannot send it elsewhere.
function localDockerHost(): string {
  const host = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
  assertLocalDockerEndpoint(host);
  const docker = (args: string[]) => execFileSync('docker', ['-H', host, ...args], { encoding: 'utf8' }).trim();
  const ids = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`]);
  if (!ids) throw new Refused('The local test copy is not running.');
  for (const container of JSON.parse(docker(['inspect', ...ids.split(/\s+/)]))) {
    if (!/scripts[\\/]local-app[\\/]compose\.yaml$/.test(container.Config.Labels['com.docker.compose.project.config_files'] ?? '')) {
      throw new Refused(`Another stack is using the name ${PROJECT}. Nothing was changed.`);
    }
  }
  return host;
}

/** Runs SQL in the local test database as its owner, after the target checks, and returns the output. */
export function localSql(input: string): string {
  return execFileSync('docker', [
    '-H', localDockerHost(), 'compose', '-p', PROJECT, '-f', resolve(here, 'compose.yaml'), '--env-file', resolve(here, '.state/local.env'),
    'exec', '-T', 'db', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
  ], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

// Deletes test products from the local test database only, by id. The app login cannot: every product
// write adds a product_change_history row, which refuses deletes and blocks the product's delete. So this
// runs as the database owner, like `app.mjs seed`, and lifts the triggers only for those history rows.
export function deleteLocalProducts(ids: string[]) {
  if (ids.length === 0) return;
  if (!ids.every((id) => /^[0-9a-f-]{36}$/.test(id))) throw new Error(`Not product ids: ${ids.join(', ')}`);
  const list = ids.map((id) => `'${id}'`).join(',');
  const deleted = localSql(`BEGIN;
      SET LOCAL session_replication_role = replica;
      DELETE FROM public.product_change_history WHERE product_id IN (${list});
      SET LOCAL session_replication_role = origin;
      WITH gone AS (DELETE FROM public.products WHERE id IN (${list}) RETURNING 1) SELECT count(*) FROM gone;
      COMMIT;`);
  if (deleted !== String(ids.length)) throw new Error(`Deleted ${deleted} of ${ids.length} test products.`);
}
