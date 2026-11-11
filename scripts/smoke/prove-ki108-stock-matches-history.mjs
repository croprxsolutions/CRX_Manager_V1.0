#!/usr/bin/env node
/**
 * Proof for 20270102100000_ki108_stock_matches_history.sql (data-only).
 *
 * Builds the checked-in production schema baseline in a network-disabled PostgreSQL 17 container,
 * seeds the exact live rows the migration targets (copied read-only from live on 2026-11-10: the five
 * inventory rows, Black Strap Bulk, and all 48 of their ledger rows), and proves the contract cases in
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

// Live ledger rows, 2026-11-10 (id, product, type, quantity, created_at, to_location).
const LEDGER = `
('27b2f86d-d554-40ad-b1e3-481fa13e1dc2','${SR_TOTE}','received',265,'2026-03-09 19:46:25.146917+00','Main Warehouse'),
('807e5927-a98a-410b-9afa-477c375039e6','${SR_TOTE}','booked',177.51,'2026-03-12 16:34:47.821829+00','Main Warehouse'),
('61d9da76-fb39-4f18-9442-c82e6155cacc','${BS_TOTE}','received',2000,'2026-03-12 17:45:47.597207+00','Main Warehouse'),
('9bb50a8c-053f-42b4-a255-4e135e78d1bf','${SR_TOTE}','booked',178.8,'2026-03-13 14:46:01.625675+00','Main Warehouse'),
('ee856e69-b383-4897-8bee-a3dbdcaf8f29','${SR_TOTE}','booked',150,'2026-03-13 16:38:23.624544+00','Main Warehouse'),
('a88ac62e-58bd-46f1-85c5-6629afc76e65','${SR_TOTE}','booked',150,'2026-03-13 16:41:11.866469+00','Main Warehouse'),
('42997206-9063-4d17-8e23-4ddbbf886b54','${SR_TOTE}','booked',350,'2026-03-13 16:46:29.447958+00','Main Warehouse'),
('68db32d6-22dd-4651-8841-472d9a00b3f3','${SR_TOTE}','booked',375,'2026-03-13 17:02:09.584324+00','Main Warehouse'),
('c7300cba-4656-4696-8cf2-193e639f9474','${SR_TOTE}','booked',500,'2026-03-13 17:11:32.526628+00','Main Warehouse'),
('66dd785c-2e87-4aff-a695-ec88ee1a2359','${AM_25}','prebooked',5,'2026-03-14 16:19:30.702496+00',NULL),
('7d676bda-aa55-4aaf-b88a-3bedb3edc8c0','${AM_25}','prebooked',5,'2026-03-14 16:22:36.943523+00',NULL),
('636ecf6f-6ae7-4be3-a744-ade9d06475eb','${AM_BULK}','prebooked',5,'2026-03-14 16:25:20.371456+00',NULL),
('7d65faae-a4e9-4a61-90f4-9170059e1723','${AM_25}','job_applied',10,'2026-03-15 14:27:57.035348+00',NULL),
('8d891731-ac41-443a-b569-e248fc9618d3','${AM_25}','job_applied',10,'2026-03-15 15:56:56.435295+00',NULL),
('a51418fe-6832-4835-97a5-4a7b904c72cb','${AM_25}','job_applied',10,'2026-03-15 16:19:21.977455+00',NULL),
('6b59ef89-84f6-41b9-827b-fd27b0aa9bd3','${AM_25}','job_applied',10,'2026-03-15 16:34:36.338328+00',NULL),
('bb4562b3-db45-427e-9d27-117e35d3789e','${AM_25}','job_applied',10,'2026-03-15 17:06:39.860205+00',NULL),
('5c3e1506-4863-4538-b9a1-f40afa2804e5','${AM_BULK}','booked',10,'2026-03-16 15:15:37.506701+00','Main Warehouse'),
('000b6161-dfcf-4306-ac44-00a10feb289c','${AM_BULK}','released',10,'2026-03-16 15:15:45.616996+00',NULL),
('1f002a0c-48e4-4931-a751-d4a3b0d989af','${AM_BULK}','released',5,'2026-03-18 14:57:18.204829+00',NULL),
('b48618ae-6461-4ec5-a67f-ccfc43e3653a','${AM_25}','released',5,'2026-03-18 14:57:18.204829+00',NULL),
('466b0d4f-ed33-45a4-bbe2-b8d47e2feaf4','${SR_TOTE}','booked',236,'2026-03-19 22:39:42.623082+00','Main Warehouse'),
('aafe1eaf-339f-40c0-a443-a3e22e62cc9d','${BS_TOTE}','adjusted',-1325,'2026-03-21 15:53:51.866405+00','Main Warehouse'),
('09305936-0954-4f9b-a121-6603b2502b19','${BS_TOTE}','adjusted',-2000,'2026-03-23 20:19:50.24974+00','Main Warehouse'),
('e263c920-35da-47c2-b19b-3d3620dd2023','${BS_TOTE}','received',2000,'2026-03-23 20:20:06.997524+00','Main Warehouse'),
('46b60621-6513-4188-a576-b8dde991b166','${SR_TOTE}','adjusted',-265,'2026-03-25 01:44:54.68178+00','Main Warehouse'),
('86de9fa9-063e-4f3a-82cd-f3fed026de83','${SR_25}','received',180,'2026-03-25 12:40:51.543465+00','Main Warehouse'),
('7a78503b-bb10-423f-a19c-ec8ba6c21121','${SR_TOTE}','received',2250,'2026-03-25 12:40:51.543465+00','Main Warehouse'),
('201bf6d1-8b77-466f-a4ff-7d45cc72ed15','${SR_TOTE}','booked',292.5,'2026-03-25 14:07:27.04789+00','Main Warehouse'),
('647f4e59-7ca8-41ee-b64f-4ae74edb66f2','${SR_TOTE}','delivered',250,'2026-03-25 19:03:11.726456+00',NULL),
('6906d322-0342-4fe0-b7ac-f37c9b6b1a64','${SR_TOTE}','delivered',500,'2026-03-25 22:04:49.043901+00',NULL),
('c76bbc8c-669d-46ca-a864-1b9dd24ac0f5','${SR_TOTE}','delivered',350,'2026-03-27 13:46:02.544113+00',NULL),
('5c7b0323-c7b6-4818-94b0-3c9309b0eb7c','${SR_TOTE}','delivered',292.5,'2026-03-27 16:51:26.923729+00',NULL),
('49c7f005-13e7-4e32-b37d-0821492842c1','${SR_TOTE}','delivered',125,'2026-03-27 20:25:58.198177+00',NULL),
('0db2e477-da02-4584-8771-0b41a77654bd','${SR_TOTE}','delivered',236,'2026-03-27 20:27:11.558426+00',NULL),
('ac512c0b-a8dc-4c0d-aaa7-307f5d09de69','${SR_TOTE}','delivered',150,'2026-03-27 20:28:30.644123+00',NULL),
('02750b10-4cc8-4c39-81ba-8b02f637ef27','${AM_25}','released',5,'2026-03-27 20:29:21.720763+00',NULL),
('7ef4312a-b15a-46c1-a8c4-48aa70dc62bf','${SR_25}','booked',80,'2026-04-07 16:22:33.520744+00','Main Warehouse'),
('3fb91379-f541-4661-a748-74c04890928b','${SR_25}','delivered',80,'2026-04-08 13:52:34.141405+00',NULL),
('54564337-ca4b-4a1b-bd15-819ed6efba43','${SR_25}','received',180,'2026-04-16 18:24:30.82271+00','Main Warehouse'),
('d7cdf008-4d83-42f7-af44-2c2a7036666f','${SR_TOTE}','received',300,'2026-04-16 18:25:27.010274+00','Main Warehouse'),
('b91b2635-292a-4138-aaf6-4c52d59de5ef','${SR_TOTE}','delivered',150,'2026-04-28 13:58:11.84277+00',NULL),
('e89b0cfc-8b29-4d23-89d5-a687e7dac904','${SR_TOTE}','delivered',178.8,'2026-04-28 14:41:36.638975+00',NULL),
('87c194c4-3800-426e-93df-1da6ac7b96dd','${SR_TOTE}','delivered',177.51,'2026-04-28 14:42:30.410206+00',NULL),
('834de86b-753d-4203-872a-7bc150301edb','${AM_25}','booked',20,'2026-07-17 20:10:07.13883+00','Main Warehouse'),
('c36050dd-358b-4397-93c8-9716b8b6fdc1','${AM_25}','delivered',20,'2026-07-17 20:10:34.295591+00',NULL),
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
  console.log('[prover] seeded the live preimage: 5 ledger mismatches, as on live');

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
