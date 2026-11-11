#!/usr/bin/env node
/**
 * Proof for 20270102100000_ki108_stock_matches_history.sql (data-only).
 *
 * Builds the checked-in production schema baseline in a network-disabled PostgreSQL 17 container,
 * seeds the five inventory rows as bound in the migration plus synthetic ledger rows reproducing its bound
 * totals, row counts and newest times (the repo is public: no live movement history), Black Strap Bulk and an
 * unrelated product, and proves the contract cases in
 * docs/plans/2026-11-10-ki108-stock-matches-history-CONTRACT.md:
 *   3. none of the five products present -> no-op, no error;
 *   2. any drift (an extra ledger row, a changed stored value, a missing row) -> KI108_PREIMAGE_DRIFTED,
 *      nothing changed;
 *   1. exact preimage -> four stored values set to history, one +95 'adjusted' row, the
 *      /integrity-report ledger check (same rules as src/lib/reconciliation.ts) passes for every row;
 *   4. every other inventory row is unchanged; a second run is refused.
 * Only the tables this migration touches matter here, so no post-baseline replay: FIDELITY asserts
 * those tables' columns equal live's (2026-11-10).
 * Never touches live: the container has no network and is removed at the end.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki108-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20270102100000_ki108_stock_matches_history.sql');
const MASON = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f';

const BS_TOTE = 'b6e75c1b-f12b-48dd-b946-1fc0298c2ae6';
const SR_TOTE = 'bab9e77a-26a2-4465-b454-f01c19dc847b';
const AM_25 = 'edae4256-b9b1-48d0-80e0-16aa67362a4a';
const AM_BULK = '9cb10775-b789-4f5b-82ef-62fe827446d5';
const SR_25 = 'ddf27cdc-3296-4e74-9805-21b301033d8f';
const BS_BULK = '6f108000-0000-4000-8000-000000000001'; // live id not needed; only its own ledger matters
const OTHER = '6f108000-0000-4000-8000-000000000002';

// [inventory id, product id, stored]
const INVENTORY = [
  ['b9ec0d1b-89cb-4595-9ab9-4b46d58d30d2', BS_TOTE, '2000'],
  ['4f3d6b53-e213-4b2f-9310-ab6080adf81b', SR_TOTE, '670.19'],
  ['ee742c21-b168-42b1-bdf4-95f179c62bd8', AM_BULK, '55'],
  ['3d13a723-444b-4412-9d1e-c416fdd959d8', SR_25, '290'],
  ['ac6b4862-40de-475c-8d46-1fbe306b47f0', AM_25, '25'],
  ['6f108000-0000-4000-8000-0000000000b1', BS_BULK, '-1325'],
  ['6f108000-0000-4000-8000-0000000000b2', OTHER, '40'],
];
const EXPECTED_AFTER = { [BS_TOTE]: '675', [SR_TOTE]: '140.19', [AM_BULK]: '0', [SR_25]: '280', [AM_25]: '25', [BS_BULK]: '-1325', [OTHER]: '40' };

// Synthetic ledger rows (the repo is public, so no live movement history is copied). Per product they
// reproduce exactly what the migration binds: the ledger total, the row count and the newest time, using
// counted (received/delivered/job_applied/adjusted, delivered stored negative to exercise abs) and
// ignored (booked/released) types.
// [product, the one large movement (decimal text, so no float), row count, newest created_at]:
// received X then delivered 10 gives X - 10; received 10 then job_applied X gives 10 - X.
const BOUND = [
  [BS_TOTE, ['received', '685'], 4, '2026-03-23 20:20:06.997524+00'], // 675
  [SR_TOTE, ['received', '150.19'], 23, '2026-04-28 14:42:30.410206+00'], // 140.19
  [AM_BULK, ['received', '10'], 4, '2026-03-18 14:57:18.204829+00'], // 0
  [SR_25, ['received', '290'], 4, '2026-04-16 18:24:30.82271+00'], // 280
  [AM_25, ['job_applied', '80'], 11, '2026-07-17 20:10:34.295591+00'], // -70
];
const synthRows = BOUND.flatMap(([p, big, n, last], pi) => {
  const r = big[0] === 'received' ? [big, ['delivered', '-10']] : [['received', '10'], big];
  r.push(['adjusted', 3], ['adjusted', -3]);
  while (r.length < n) r.push([r.length % 2 ? 'booked' : 'released', 1]);
  return r.map(([type, q], i) => {
    const id = `6f108000-0000-4000-8000-${pi.toString(16).padStart(2, '0')}${i.toString(16).padStart(10, '0')}`;
    const at = i === n - 1 ? last : `2026-03-01 00:${String(i).padStart(2, '0')}:00+00`;
    return `('${id}','${p}','${type}',${q},'${at}','Main Warehouse')`;
  });
});
const LEDGER = `
${synthRows.join(',\n')},
('6f108000-0000-4000-8000-0000000000c1','${BS_BULK}','booked',1325,'2026-03-19 10:00:00+00','Main Warehouse'),
('6f108000-0000-4000-8000-0000000000c2','${BS_BULK}','delivered',1325,'2026-03-21 10:00:00+00',NULL),
('6f108000-0000-4000-8000-0000000000c3','${OTHER}','received',40,'2026-03-21 10:00:00+00','Main Warehouse')`;

// Live column lists, 2026-11-10.
const LIVE_COLUMNS = {
  inventory: 'id:uuid:NO,last_counted_at:timestamp with time zone:YES,location:text:NO,manufactured_at_delivery:boolean:NO,min_stock_level:numeric:NO,product_id:uuid:NO,quantity_available:numeric:NO,quantity_on_order:numeric:NO,quantity_prebooked:numeric:NO,reorder_point:numeric:NO,unit_size:text:YES,updated_at:timestamp with time zone:NO',
  inventory_transactions: 'created_at:timestamp with time zone:NO,delivery_id:uuid:YES,from_location:text:YES,id:uuid:NO,job_id:uuid:YES,notes:text:YES,order_id:uuid:YES,performed_by:uuid:NO,product_id:uuid:NO,purchase_order_id:uuid:YES,quantity:numeric:NO,requires_review:boolean:NO,to_location:text:YES,transaction_type:text:NO',
};

// Same rules as checkInventoryLedger (src/lib/reconciliation.ts), over every inventory row with history.
const LEDGER_MISMATCHES = `
  SELECT count(*) FROM public.inventory i
  JOIN (SELECT product_id, sum(CASE
      WHEN transaction_type IN ('received','returned','cancelled_delivery_reversal','void_delivery_reversal') THEN abs(quantity)
      WHEN transaction_type IN ('delivered','job_applied') THEN -abs(quantity)
      WHEN transaction_type IN ('adjusted','transferred','tote_fill_out','tote_fill_in') THEN quantity
      ELSE 0 END) ledger
    FROM public.inventory_transactions
    WHERE id NOT IN ('14880dd6-9324-4a6e-a1fb-f951b87ad090','23a36a20-db16-42a1-8346-ba9bd97894eb','d6b92523-5bc2-43d5-a566-2b8399596a9b','86fc5133-776e-463c-ac6b-f67bbf1f76ae','386a1ce0-1cf7-422e-86f9-55cd105cc93f')
    GROUP BY product_id) l USING (product_id)
  WHERE abs(i.quantity_available - l.ledger) > 0.01;`;

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') {
  return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
}
function psql(sql, options = {}) { return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure }); }
function scalar(sql) {
  return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}
function stageText(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  try {
    writeFileSync(staged, text, 'utf8');
    docker(['cp', staged, `${NAME}:/tmp/${name}`]);
  } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove staged file ${staged}: ${e.message}`); }
  }
}
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function run(name) {
  const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ready() {
  for (let i = 0; i < 120; i += 1) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
    wait(500);
  }
  throw new Error('disposable PostgreSQL did not become ready');
}
function snapshot() {
  return scalar("SELECT string_agg(product_id || '=' || quantity_available || '/' || quantity_prebooked, ',' ORDER BY product_id) FROM public.inventory;");
}
function txCount() { return scalar('SELECT count(*) FROM public.inventory_transactions;'); }

function boot() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs', '--with-live-rows'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
}

function seed() {
  const products = [[BS_TOTE, 'Black Strap Tote'], [SR_TOTE, 'Start Right Tote'], [AM_25, '2,4D 2.5 Gal'], [AM_BULK, '2,4D Bulk'], [SR_25, 'Start Right 2.5G'], [BS_BULK, 'Black Strap Bulk'], [OTHER, 'Other']];
  psql(`
    INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
      ('${MASON}','ki108-prover-admin@example.invalid','{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb) ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
      ('${MASON}','ki108-prover-admin@example.invalid','[PROVER] Admin','admin',true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
    SET session_replication_role = replica; -- seed only: skip product pricing/insert guards
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, is_active) VALUES
      ${products.map(([id, n]) => `('${id}', '[PROVER] ${n}', 'GL', 6.00, 10.00, true)`).join(',\n      ')};
    INSERT INTO public.inventory (id, product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES
      ${INVENTORY.map(([id, p, q]) => `('${id}', '${p}', 'Main Warehouse', ${q}, 0, 'GL')`).join(',\n      ')};
    INSERT INTO public.inventory_transactions (id, product_id, transaction_type, quantity, created_at, to_location, performed_by) SELECT v.id::uuid, v.p::uuid, v.t, v.q, v.c::timestamptz, v.l, '${MASON}' FROM (VALUES ${LEDGER}) v(id, p, t, q, c, l);
    SET session_replication_role = origin;`);
}

function expectDrift(label, setup, pattern = /KI108_PREIMAGE_DRIFTED/) {
  stageText('drift.sql', `${setup}\n${lf(CANDIDATE)}`);
  const before = snapshot(); const beforeTx = txCount();
  const r = run('drift.sql');
  assert.notEqual(r.status, 0, `${label}: the migration must refuse`);
  assert.match(r.output, pattern, `${label}: wrong refusal:\n${r.output}`);
  assert.equal(snapshot(), before, `${label}: stock changed`);
  assert.equal(txCount(), beforeTx, `${label}: ledger changed`);
  console.log(`[prover] 2. refused, nothing changed: ${label}`);
}

function main() {
  boot();

  // FIDELITY: the two written tables have live's columns (name, type, nullability) and unique key.
  for (const [table, cols] of Object.entries(LIVE_COLUMNS)) {
    assert.equal(scalar(`SELECT string_agg(column_name||':'||data_type||':'||is_nullable, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}';`), cols, `${table} columns differ from live`);
  }
  assert.equal(scalar("SELECT count(*) FROM pg_constraint WHERE conrelid='public.inventory'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (product_id, location)';"), '1', 'inventory unique(product_id, location) missing');
  console.log('[prover] FIDELITY: inventory and inventory_transactions columns and the inventory unique key match live');

  stageText('candidate.sql', lf(CANDIDATE));

  // 3. Empty: no-op.
  const empty = run('candidate.sql');
  assert.equal(empty.status, 0, `no-op path failed:\n${empty.output}`);
  assert.match(empty.output, /none of the five products exist; no-op/);
  console.log('[prover] 3. schema-only database: no-op, no error');

  seed();
  assert.equal(scalar(LEDGER_MISMATCHES), '5', 'the seed must reproduce the five live mismatches');
  console.log('[prover] seeded the bound preimage: 5 ledger mismatches, as on live');

  // 2. Drift.
  expectDrift('one more delivery', `INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, performed_by) VALUES ('${SR_25}', 'delivered', 1, '${MASON}');`);
  expectDrift('stored value changed', `UPDATE public.inventory SET quantity_available = 24 WHERE product_id = '${AM_25}';`);
  expectDrift('pre-booked stock appeared', `UPDATE public.inventory SET quantity_prebooked = 5 WHERE product_id = '${BS_TOTE}';`);
  expectDrift('one row missing', `DELETE FROM public.inventory WHERE product_id = '${AM_BULK}';`);
  expectDrift('same products, regenerated inventory ids', `SET session_replication_role = replica; UPDATE public.inventory SET id = gen_random_uuid() WHERE product_id IN ('${BS_TOTE}','${SR_TOTE}','${AM_25}','${AM_BULK}','${SR_25}'); SET session_replication_role = origin;`);
  expectDrift('a second location for one product', `INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES ('${SR_25}', 'Second Site', 0, 0, 'GL');`);
  expectDrift('an in-progress cycle count', `SET session_replication_role = replica;
    INSERT INTO public.cycle_counts (id, count_number, initiated_by, status, warehouse) VALUES ('6f108000-0000-4000-8000-0000000000d1', 'CC-PROVER', '${MASON}', 'in_progress', 'Main Warehouse');
    INSERT INTO public.cycle_count_items (cycle_count_id, product_id, expected_qty) VALUES ('6f108000-0000-4000-8000-0000000000d1', '${BS_TOTE}', 2000);
    SET session_replication_role = origin;`);
  // A failure after the +95 row and some updates are written: everything rolls back.
  expectDrift('failure after writing', `CREATE FUNCTION pg_temp.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PROVER_BOOM'; END $$;
    CREATE TRIGGER prover_boom BEFORE UPDATE ON public.inventory FOR EACH ROW WHEN (NEW.product_id = '${SR_25}') EXECUTE FUNCTION pg_temp.boom();`, /PROVER_BOOM/);

  // 1 + 4. Exact preimage.
  const beforeTx = Number(txCount());
  const applied = run('candidate.sql');
  assert.equal(applied.status, 0, `apply failed:\n${applied.output}`);
  const after = Object.fromEntries(scalar("SELECT string_agg(product_id || '=' || quantity_available::numeric::text, ',') FROM public.inventory;").split(',').map((x) => x.split('=')));
  for (const [p, q] of Object.entries(EXPECTED_AFTER)) assert.equal(Number(after[p]), Number(q), `stock for ${p}`);
  assert.equal(Number(txCount()), beforeTx + 1, 'exactly one ledger row added');
  assert.equal(scalar(`SELECT count(*) FROM public.inventory_transactions WHERE product_id='${AM_25}' AND transaction_type='adjusted' AND quantity=95 AND performed_by='${MASON}' AND to_location='Main Warehouse' AND notes LIKE 'KI-108 reconciliation%';`), '1', 'the +95 opening row');
  assert.equal(scalar('SELECT count(*) FROM public.inventory WHERE quantity_prebooked <> 0;'), '0', 'pre-booked untouched');
  assert.equal(scalar(LEDGER_MISMATCHES), '0', 'ledger check must pass for every row');
  console.log('[prover] 1. applied: Tote 675, SR Tote 140.19, 2,4D Bulk 0, SR 2.5G 280, 2,4D 2.5 Gal 25 with one +95 row; integrity check passes for all rows');
  console.log('[prover] 4. Black Strap Bulk (-1325) and the unrelated product (40) unchanged');

  const again = run('candidate.sql');
  assert.notEqual(again.status, 0, 'a second run must be refused');
  assert.match(again.output, /KI108_PREIMAGE_DRIFTED/);
  console.log('[prover] second run refused (KI108_PREIMAGE_DRIFTED)');
  console.log('[prover] PASS');
}

try {
  main();
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
