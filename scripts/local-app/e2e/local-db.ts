import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));

// Deletes test products from the local test database only, by id. The app login cannot: every product
// write adds a product_change_history row, which refuses deletes and blocks the product's delete. So this
// runs as the database owner, like `app.mjs seed`, and lifts the triggers only for those history rows.
export function deleteLocalProducts(ids: string[]) {
  if (ids.length === 0) return;
  if (!ids.every((id) => /^[0-9a-f-]{36}$/.test(id))) throw new Error(`Not product ids: ${ids.join(', ')}`);
  const list = ids.map((id) => `'${id}'`).join(',');
  const deleted = execFileSync('docker', [
    'compose', '-p', 'crx-local-app', '-f', resolve(here, 'compose.yaml'), '--env-file', resolve(here, '.state/local.env'),
    'exec', '-T', 'db', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
  ], {
    input: `BEGIN;
      SET LOCAL session_replication_role = replica;
      DELETE FROM public.product_change_history WHERE product_id IN (${list});
      SET LOCAL session_replication_role = origin;
      WITH gone AS (DELETE FROM public.products WHERE id IN (${list}) RETURNING 1) SELECT count(*) FROM gone;
      COMMIT;`,
    encoding: 'utf8',
  }).trim();
  if (deleted !== String(ids.length)) throw new Error(`Deleted ${deleted} of ${ids.length} test products.`);
}
