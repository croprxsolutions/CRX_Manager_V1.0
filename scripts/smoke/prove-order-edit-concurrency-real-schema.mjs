#!/usr/bin/env node
// Isolated PostgreSQL proof: supported baseline plus ledger-selected main migrations.
// No DB URL, no production write, and the disposable container has no network.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-order-edit-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261028185500_order_edit_and_number_concurrency.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations rewrite live rows this disposable database does not have; they are
// recorded in the ledger (as live has them) instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /order_edit_and_number_concurrency/i;
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
function psql(sql, options = {}) { return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure }); }
function scalar(sql) { return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''; }
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function stageText(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  writeFileSync(staged, text, 'utf8');
  try { docker(['cp', staged, `${NAME}:/tmp/${name}`]); } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove ${staged}: ${e.message}`); }
  }
}
function apply(name) {
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
function ledgerSql(stem) {
  return `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    SELECT '${stem.slice(0, 14)}', '${stem}', ARRAY[]::text[]
     WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '${stem}')
    ON CONFLICT (version) DO NOTHING;`;
}
function restoreLiveCrLfCloseRemainderSql() {
  const source = lf(path.join(MIGRATIONS, '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql'));
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  return `CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`;
}
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const before = all.filter((file) => path.basename(file) < path.basename(CANDIDATE));
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return before;
}
function installLiveAuthUid() {
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
}
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  // storage.objects carries metadata and a (bucket_id, name) key, and postgres may read it, as live
  // has them: 20261022075000 (replayed before the candidate) checks that shape in its preflight.
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  const files = plan();
  let replayed = 0;
  let batch = ''; const ledgerAdded = new Set();
  for (const file of files) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) {
      if (only < base && !ledgerAdded.has(only)) {
        batch += ledgerSql(path.basename(only, '.sql')) + '\n'; ledgerAdded.add(only);
      }
    }
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') batch += restoreLiveCrLfCloseRemainderSql() + '\n';
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') {
      if (batch) psql(batch);
      batch = '';
      installLiveAuthUid();
    }
    batch += `BEGIN;\n${lf(file)}\nCOMMIT;\n${ledgerSql(path.basename(file, '.sql'))}\n`;
    replayed += 1;
    if (replayed % 20 === 0 || file === files.at(-1)) {
      psql(batch); batch = '';
      console.log(`[prover] replayed ${replayed}: ${base}`);
    }
  }
  if (batch) psql(batch);
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const id = (n) => `7e120000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1'); const REP = id('b1'); const DRIVER = id('d1'); const APPLICATOR = id('e1');
const CUSTOMER = id('c1'); const ORDER = id('01'); const PRODUCT = id('f1'); const LINE = id('11');
const claims = (uid = ADMIN) => `SELECT set_config('request.jwt.claim.sub','${uid}',true);
 SELECT set_config('request.jwt.claims','{"sub":"${uid}","role":"authenticated"}',true);`;
function seed() {
  psql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id, email) VALUES
      ('${ADMIN}', 'order-admin@example.invalid'), ('${REP}', 'order-rep@example.invalid'),
      ('${DRIVER}', 'order-driver@example.invalid'), ('${APPLICATOR}', 'order-applicator@example.invalid');
    INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES
      ('${ADMIN}', 'order-admin@example.invalid', '[PROVER] Admin', 'admin', true),
      ('${REP}', 'order-rep@example.invalid', '[PROVER] Rep', 'sales_rep', true),
      ('${DRIVER}', 'order-driver@example.invalid', '[PROVER] Driver', 'driver', true),
      ('${APPLICATOR}', 'order-applicator@example.invalid', '[PROVER] Applicator', 'applicator', true);
    INSERT INTO public.customers (id, farm_name, assigned_tier) VALUES ('${CUSTOMER}', '[PROVER] Order Farm', 1);
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, is_active)
      VALUES ('${PRODUCT}', '[PROVER] Order Product', 'gal', 10, 20, 'liquid', true);
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES ('${PRODUCT}', 'Main Warehouse', 1000, 10, 0);
    INSERT INTO public.orders (id, order_number, customer_id, status, total_price, total_cost)
      VALUES ('${ORDER}', 'ORD-PROVER-CONCURRENCY', '${CUSTOMER}', 'confirmed', 200, 100);
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit, total_units_needed, total_price)
      VALUES ('${LINE}', '${ORDER}', '${PRODUCT}', '[PROVER] Order Product', 'gal', 20, 10, 10, 200);
    COMMIT;`);
}
const payload = (qty) => JSON.stringify([{ id: LINE, product_id: PRODUCT, product_name: '[PROVER] Order Product',
  unit_size: 'gal', price_per_unit: 20, cost_per_unit: 10, total_units_needed: qty }]);
const save = (qty, version, key, actor = ADMIN) => `SELECT public.update_order_items('${ORDER}', '${payload(qty)}'::jsonb,
 '${actor}', ${key ? `'${key}'` : 'NULL'}, ${version ?? 'NULL'});`;
const version = () => Number(scalar(`SELECT row_version FROM public.orders WHERE id='${ORDER}';`));
const quantity = () => Number(scalar(`SELECT total_units_needed FROM public.order_items WHERE id='${LINE}';`));
const sessionSql = (sql, actor = ADMIN) => `BEGIN; ${claims(actor)} SET LOCAL ROLE authenticated; ${sql} COMMIT;`;
function refused(sql, token, actor = ADMIN) {
  const result = psql(sessionSql(sql, actor), { allowFailure: true });
  assert.notEqual(result.status, 0, `expected refusal ${token}`);
  assert.match(result.stderr, new RegExp(token));
}
function asyncSql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', psqlArgs(), { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(sql);
  });
}
async function concurrency() {
  const expected = version();
  const [a, b] = await Promise.all([
    asyncSql(sessionSql(`${save(14, expected, 'edit-concurrent-a')} SELECT pg_sleep(0.5);`)),
    asyncSql(sessionSql(`${save(17, expected, 'edit-concurrent-b', REP)} SELECT pg_sleep(0.5);`, REP)),
  ]);
  assert.equal([a, b].filter((r) => r.status === 0).length, 1, 'exactly one editor must save');
  assert.match([a, b].find((r) => r.status !== 0).stderr, /ORDER_STALE_WRITE/);
  assert.ok([14, 17].includes(quantity()));
  console.log('[proof] two simultaneous editors: one saved, one stale refusal; losing request made no write');

  const retryVersion = version(); const before = quantity();
  const retrySql = sessionSql(`${save(before + 1, retryVersion, 'edit-double-submit')} SELECT pg_sleep(0.3);`);
  const retries = await Promise.all([asyncSql(retrySql), asyncSql(retrySql)]);
  for (const r of retries) assert.equal(r.status, 0, r.stderr);
  assert.equal(quantity(), before + 1);
  const committedVersion = version();
  psql(retrySql); assert.equal(version(), committedVersion, 'retry must not advance the version');
  refused(save(before + 2, retryVersion, 'edit-double-submit'), 'IDEMPOTENCY_PAYLOAD_CONFLICT');
  console.log('[proof] concurrent double-submit and sequential retry replay one receipt; changed payload refused');

  const payments = (key) => `SELECT public.allocate_payment('${CUSTOMER}',100,'check',NULL,NULL,CURRENT_DATE,NULL,'[]'::jsonb,'${ADMIN}','${key}');`;
  const paid = await Promise.all([asyncSql(sessionSql(`${payments('allocation-a')} SELECT pg_sleep(0.4);`)),
    asyncSql(sessionSql(`${payments('allocation-b')} SELECT pg_sleep(0.4);`))]);
  for (const r of paid) assert.equal(r.status, 0, r.stderr);
  assert.equal(scalar(`SELECT string_agg(version::text, ',' ORDER BY version) FROM public.allocation_sets WHERE entity_type='payment' AND entity_id='${CUSTOMER}';`), '1,2');
  assert.equal(scalar(`SELECT sum(total_payment_cents) FROM public.allocation_sets WHERE customer_id='${CUSTOMER}';`), '200');
  console.log('[proof] two real payment RPCs: versions 1 and 2, both cents amounts retained');

  const ticket = () => `INSERT INTO public.blend_tickets (ticket_number, uploaded_by, status)
    VALUES (public.generate_ticket_number(),'${ADMIN}','pending') RETURNING ticket_number;`;
  const tickets = await Promise.all([asyncSql(`BEGIN; ${claims()} ${ticket()} SELECT pg_sleep(0.4); COMMIT;`),
    asyncSql(`BEGIN; ${claims()} ${ticket()} SELECT pg_sleep(0.4); COMMIT;`)]);
  for (const r of tickets) assert.equal(r.status, 0, r.stderr);
  assert.equal(scalar('SELECT count(DISTINCT ticket_number) FROM public.blend_tickets;'), '2');
  console.log('[proof] simultaneous ticket creation transactions produced two distinct numbers');
}

try {
  buildContainer();
  seed();
  // Observe the old public path before the candidate: a second editor overwrites
  // the first without any version token. This makes the stale-edit regression non-vacuous.
  psql(sessionSql(save(11, null, 'legacy-editor-a').replace(', NULL);', ');')));
  psql(sessionSql(save(13, null, 'legacy-editor-b', REP).replace(', NULL);', ');'), REP));
  assert.equal(quantity(), 13);
  console.log('[proof] BEFORE: two unversioned editors silently replaced the same line in sequence');
  stageText('candidate.sql', lf(CANDIDATE));
  const applied = apply('candidate.sql'); assert.equal(applied.status, 0, applied.output);
  let v = version();
  psql(sessionSql(save(12, v, 'edit-ordinary'))); assert.equal(quantity(), 12); assert.ok(version() > v);
  refused(save(13, v, 'edit-stale'), 'ORDER_STALE_WRITE'); assert.equal(quantity(), 12);
  refused(save(13, null, 'edit-no-version'), 'ORDER_EXPECTED_VERSION_REQUIRED');
  refused(save(13, version(), 'edit-driver', DRIVER), 'INSUFFICIENT_ROLE', DRIVER);
  refused(save(13, version(), 'edit-applicator', APPLICATOR), 'INSUFFICIENT_ROLE', APPLICATOR);
  refused(save(13, version(), 'edit-forged', REP), 'ACTOR_MISMATCH');
  console.log('[proof] ordinary save, stale/missing versions, both excluded roles and forged actor checked');
  v = version(); psql(`UPDATE public.order_items SET product_name='Another workflow label' WHERE id='${LINE}';`);
  refused(save(14, v, 'edit-child-change'), 'ORDER_STALE_WRITE');
  v = version(); psql(`UPDATE public.orders SET notes='Another workflow' WHERE id='${ORDER}';`);
  refused(save(14, v, 'edit-header-change'), 'ORDER_STALE_WRITE');
  console.log('[proof] header and child writes both invalidate a prior editor snapshot');
  await concurrency();
  assert.equal(Number(scalar(`SELECT total_price FROM public.orders WHERE id='${ORDER}';`)), quantity() * 20);
  assert.equal(Number(scalar(`SELECT total_cost FROM public.orders WHERE id='${ORDER}';`)), quantity() * 10);
  assert.equal(Number(scalar(`SELECT total_profit FROM public.orders WHERE id='${ORDER}';`)), quantity() * 10);
  assert.equal(Number(scalar(`SELECT quantity_prebooked FROM public.inventory WHERE product_id='${PRODUCT}' AND location='Main Warehouse';`)), quantity());
  console.log('[proof] final order price, cost, profit and inventory reservation match the winning quantity');
  const again = apply('candidate.sql'); assert.equal(again.status, 0, again.output);
  console.log('ORDER_EDIT_CONCURRENCY_REAL_SCHEMA_PASS');
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
