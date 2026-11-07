#!/usr/bin/env node
/**
 * Real-schema proof for 20261104190000_job_invoice_lines_keep_job_unit.
 *
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container and replays
 * every migration before the candidate. Then, with job lines entered in a unit other than the
 * product's Unit, it proves:
 *   1. BEFORE: the live body labels each new invoice line with the product's Unit (the defect).
 *   2. APPLY: the candidate applies; the private body keeps its owner, settings and owner-only ACL,
 *      and the public wrapper is untouched.
 *   3. AFTER: on both the single-invoice and the multi-owner split paths, each invoice line carries
 *      the job line's unit and rate unit (blank or missing falls back as documented), while every
 *      money column, quantity, acres and every invoice header column match the BEFORE run exactly.
 *   4. RE-APPLY: the file refuses on its own output (source pin), changing nothing.
 *
 * Run: node scripts/smoke/prove-job-invoice-lines-keep-job-unit-real-schema.mjs   (needs Docker)
 * Prints JOB_INVOICE_UNIT_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-job-invoice-unit-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
let started = false;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261104190000_job_invoice_lines_keep_job_unit.sql');
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
// A later or parked file that changes what the transfer fix touches or relies on.
// 20261104150000 (WP-PM-9) pins three live bodies that live stores with CRLF line endings; install
// them before replaying it, exactly as its own prover does (scripts/smoke/prove-product-forms-seed-each-real-schema.mjs).
const PM9 = '20261104150000_product_forms_seed_each.sql';
const LIVE_BODY_MD5 = {
  'public.field_app_priced_quantity(numeric,text,text,text)': 'bc91a52577840973f18f1710e47edf2b',
  'public.convert_to_gl_lb(numeric,text,text)': 'ce9265521821c09b0cf74de45afb375b',
  'public.validate_product_units()': '83a51c58c83cd83bea760bd117410a38',
};
const TOUCHED = /transfer_job_to_invoice|job_chemicals|convert_to_gl_lb/i;
// Later files that match TOUCHED and were checked against this proof. This proof replays only up to
// its candidate, so a later file never runs here; each entry says why it leaves what it relies on intact.
const REVIEWED_LATER = new Set([
  // Revokes direct app writes on job_chemicals and adds an AFTER trigger that records a sprayed job's
  // product EPA numbers in a separate table; transfer_job_to_invoice, the line units and convert_to_gl_lb
  // are unchanged.
  '20261204120000_job_lines_keep_epa_number.sql',
]);
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
function ledger(stem) {
  psql(`INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    SELECT '${stem.slice(0, 14)}', '${stem}', ARRAY[]::text[]
     WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '${stem}')
    ON CONFLICT (version) DO NOTHING;`);
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${stem}';`), '1', `${stem} is not in the ledger`);
}
function restoreLiveCrLfCloseRemainder() {
  const source = lf(path.join(MIGRATIONS, '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql'));
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`);
}
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  for (const file of all.slice(at + 1)) {
    if (REVIEWED_LATER.has(path.basename(file))) continue;
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches what it relies on; re-think this proof`);
  }
  const before = all.slice(0, at);
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
function bodyFrom(file, expression) {
  const match = expression.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  assert.ok(match, `${file} no longer contains its pinned function body`);
  return match[1];
}
function restoreLiveBodies() {
  // Historical replay uses LF staging; validate_product_units had CRLF in live prosrc.
  const validate = bodyFrom('20260211000000_unit_tracking_pricing_overhaul.sql',
    /CREATE OR REPLACE FUNCTION validate_product_units\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)
    .replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');  // same bytes on an LF or CRLF checkout
  const field = bodyFrom('20260630180000_field_app_pricing_unit_fix.sql',
    /CREATE OR REPLACE FUNCTION public.field_app_priced_quantity\([\s\S]*?AS \$fapq\$([\s\S]*?)\$fapq\$;/);
  const seededConvert = bodyFrom(PM9,
    /CREATE OR REPLACE FUNCTION public.convert_to_gl_lb\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/).replaceAll('\r\n', '\n');
  const seedArm = "  IF lower(coalesce(p_product_form, '')) IN ('seed','each') THEN RETURN QUERY SELECT NULL::numeric, NULL::text; RETURN; END IF;\n";
  assert.equal(seededConvert.split(seedArm).length - 1, 1);
  const convert = seededConvert.replace(seedArm, '');
  psql(`CREATE OR REPLACE FUNCTION public.validate_product_units() RETURNS trigger LANGUAGE plpgsql
    SET search_path = public, pg_temp AS $live_validate$${validate}$live_validate$;`);
  psql(`CREATE OR REPLACE FUNCTION public.field_app_priced_quantity(
      p_applied_qty numeric, p_rate_unit text, p_inventory_unit text, p_product_form text)
    RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp
    AS $live_field$${field}$live_field$;`);
  psql(`CREATE OR REPLACE FUNCTION public.convert_to_gl_lb(
      p_total_applied numeric, p_rate_unit text, p_product_form text)
    RETURNS TABLE(converted_value numeric, converted_unit text) LANGUAGE plpgsql IMMUTABLE
    SET search_path = public AS $live_convert$${convert}$live_convert$;`);
  for (const [signature, expected] of Object.entries(LIVE_BODY_MD5)) {
    assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = '${signature}'::regprocedure;`),
      expected, `${signature} is not the pinned live body before the candidate`);
  }
}
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  started = true; // only now is the container ours to remove
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
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    if (base === PM9) restoreLiveBodies();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const ADMIN = '7c6b0000-0000-4000-8000-0000000000a1';
const CUST = '7c6b0000-0000-4000-8000-0000000000c1';
const CUST2 = '7c6b0000-0000-4000-8000-0000000000c2';
const [P_PT, P_NULL, P_BLANK, P_QT, P_BLANK_RATE] = ['d1', 'd2', 'd3', 'd4', 'd5'].map((s) => `7c6b0000-0000-4000-8000-0000000000${s}`);
const [F_SINGLE, F_SPLIT] = ['f1', 'f2'].map((s) => `7c6b0000-0000-4000-8000-0000000000${s}`);
const [JOB_SINGLE, JOB_SPLIT] = ['e1', 'e2'].map((s) => `7c6b0000-0000-4000-8000-0000000000${s}`);
const IMPL = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)';
const WRAPPER = 'public.transfer_job_to_invoice(uuid,uuid,text)';
const LIVE_IMPL_MD5 = '85cd07a0a6b978cb066edab7df369fea';
const NEW_IMPL_MD5 = 'a72cf3a5cff53d4024ad52b832985724';
// Every product's Unit is Gal; the job lines are entered in other units (or none).
// [product, job unit, job rate unit, quantity, price cents, cost cents, rate per acre]
const LINES = [
  [P_PT, "'Pt'", "'pt/ac'", 80, 450, 300, 8],
  [P_NULL, 'NULL', 'NULL', 20, 2500, 1800, 2],
  [P_BLANK, "'  '", 'NULL', 5, 3100, 2000, 0.5],
  [P_QT, "'Qt'", 'NULL', 40, 900, 610, 4],
  [P_BLANK_RATE, "'Pt'", "' '", 16, 700, 450, 1.6],
];

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('${ADMIN}', 'job-invoice-unit@example.invalid', '{"full_name":"[PROVER] Admin"}'::jsonb);`);
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES
      ('${CUST}', '[PROVER] Owner Farm', true), ('${CUST2}', '[PROVER] Landlord Farm', true);
    INSERT INTO public.products (id, product_name, unit_size, inventory_unit, product_form, container_unit, current_cost, is_active) VALUES
      ('${P_PT}', '[PROVER] A Pint line', 'Gal', 'Gal', 'liquid', 'Gal', 1.00, true),
      ('${P_NULL}', '[PROVER] B No unit', 'Gal', 'Gal', 'liquid', 'Gal', 1.00, true),
      ('${P_BLANK}', '[PROVER] C Blank unit', 'Gal', 'Gal', 'liquid', 'Gal', 1.00, true),
      ('${P_QT}', '[PROVER] D Quart line', 'Gal', 'Gal', 'liquid', 'Gal', 1.00, true),
      ('${P_BLANK_RATE}', '[PROVER] E Blank rate unit', 'Gal', 'Gal', 'liquid', 'Gal', 1.00, true);
    INSERT INTO public.fields (id, customer_id, field_name, crop_type) VALUES
      ('${F_SINGLE}', '${CUST}', '[PROVER] North', 'corn'), ('${F_SPLIT}', '${CUST}', '[PROVER] South', 'soy');
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES
      ('${F_SPLIT}', '${CUST}', 60, true), ('${F_SPLIT}', '${CUST2}', 40, false);
    INSERT INTO public.jobs (id, job_number, customer_id, status, job_date) VALUES
      ('${JOB_SINGLE}', 'PROVER-UNIT-1', '${CUST}', 'completed', CURRENT_DATE),
      ('${JOB_SPLIT}', 'PROVER-UNIT-2', '${CUST}', 'completed', CURRENT_DATE);
    INSERT INTO public.job_fields (job_id, field_id, acres_to_treat) VALUES
      ('${JOB_SINGLE}', '${F_SINGLE}', 10), ('${JOB_SPLIT}', '${F_SPLIT}', 25);
    INSERT INTO public.job_chemicals (job_id, product_id, unit, rate_unit, quantity, price_per_unit_cents, cost_per_unit_cents, rate_per_acre) VALUES
      ${[JOB_SINGLE, JOB_SPLIT].flatMap((job) => LINES.map(([p, u, r, qty, price, cost, rate]) => `('${job}', '${p}', ${u}, ${r}, ${qty}, ${price}, ${cost}, ${rate})`)).join(',\n      ')};
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  assert.equal(scalar(`SELECT count(*) FROM public.job_chemicals WHERE job_id IN ('${JOB_SINGLE}', '${JOB_SPLIT}');`), '10');
  console.log('[prover] seeded two completed jobs (single owner; 60/40 split) with Pt, missing, all-space, Qt and all-space-rate job units on Gal products');
}

// Transfers `job` as the admin in a rolled-back transaction; returns each invoice line (sorted by
// owner then line) with its invoice header, minus the ids, numbers and clock columns.
function transfer(job) {
  const r = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
SET LOCAL ROLE authenticated;
SELECT public.transfer_job_to_invoice('${job}', '${ADMIN}', 'prover-' || gen_random_uuid()) IS NOT NULL;
RESET ROLE;
SELECT 'SNAP|' || jsonb_agg(jsonb_build_object(
    'owner', i.customer_id, 'line', ii.description,
    'item', to_jsonb(ii) - 'id' - 'invoice_id' - 'created_at' - 'updated_at',
    'invoice', to_jsonb(i) - 'id' - 'invoice_number' - 'created_at' - 'updated_at' - 'invoice_group_id')
  ORDER BY i.customer_id, ii.sort_order, ii.description)::text
  FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice_id = i.id WHERE i.job_id = '${job}';
ROLLBACK;
`, allowFailure: true });
  assert.equal(r.status, 0, `transfer of ${job} failed:\n${r.stderr}`);
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('SNAP|'));
  assert.ok(line, `transfer of ${job} printed no snapshot:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(5));
}
const labels = (snap) => snap.map((r) => `${r.line.replace('[PROVER] ', '')}=${r.item.unit_size}/${r.item.rate_unit}/${r.item.total_applied_unit}`);
const LABEL_KEYS = new Set(['unit_size', 'rate_unit', 'total_applied_unit', 'total_applied_gl_lb', 'gl_lb_unit']);
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.has(k)));
function onlyLabelsMoved(before, after, what) {
  assert.equal(after.length, before.length, `${what}: line count changed`);
  before.forEach((b, i) => {
    const a = after[i];
    assert.equal(a.owner, b.owner, `${what}: line order changed`);
    assert.equal(a.line, b.line, `${what}: line order changed`);
    assert.deepEqual(a.invoice, b.invoice, `${what}: an invoice header column changed (totals, cost, acres, dates)`);
    assert.deepEqual(without(a.item, LABEL_KEYS), without(b.item, LABEL_KEYS), `${what}: ${b.line} changed outside its unit labels`);
  });
}
const implState = () => scalar(`SELECT md5(prosrc) || '|' || prosecdef || '|' || array_to_string(proconfig, ';') || '|' || pg_get_userbyid(proowner) || '|' || proacl::text FROM pg_proc WHERE oid = '${IMPL}'::regprocedure;`);
const wrapperState = () => scalar(`SELECT md5(prosrc) || '|' || proacl::text FROM pg_proc WHERE oid = '${WRAPPER}'::regprocedure;`);

try {
  buildContainer();
  assert.equal(implState(), `${LIVE_IMPL_MD5}|true|search_path=public, pg_temp|postgres|{postgres=X/postgres}`, 'replayed private body is not the live one');
  const wrapperBefore = wrapperState();
  seed();

  // 1. Before: the defect.
  const single0 = transfer(JOB_SINGLE);
  const split0 = transfer(JOB_SPLIT);
  assert.deepEqual(labels(single0), ['A Pint line=Gal/pt/ac/pt/ac', 'B No unit=Gal/Gal/Gal', 'C Blank unit=Gal/Gal/Gal', 'D Quart line=Gal/Gal/Gal', 'E Blank rate unit=Gal/ / ']);
  assert.equal(split0.length, 10, 'the split job did not make one line per chemical per owner');
  assert.equal(new Set(split0.map((r) => r.owner)).size, 2, 'the split job did not bill two owners');
  console.log(`[prover] BEFORE: single ${labels(single0).join(', ')}`);

  // 2. Apply.
  const candidate = lf(CANDIDATE);
  stageText('candidate.sql', candidate);
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);
  assert.equal(implState(), `${NEW_IMPL_MD5}|true|search_path=public, pg_temp|postgres|{postgres=X/postgres}`, 'private body, settings, owner or ACL is not as reviewed');
  assert.equal(wrapperState(), wrapperBefore, 'the public wrapper changed');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(scalar(`SELECT has_function_privilege('${role}', '${IMPL}', 'EXECUTE');`), 'f', `${role} can call the private body`);
  }
  console.log('[prover] APPLY: new body pinned; owner-only ACL and the public wrapper unchanged');

  // 3. After: the job line's units; nothing else moves.
  const single1 = transfer(JOB_SINGLE);
  const split1 = transfer(JOB_SPLIT);
  const expected = ['A Pint line=Pt/pt/ac/pt/ac', 'B No unit=Gal/Gal/Gal', 'C Blank unit=Gal/Gal/Gal', 'D Quart line=Qt/Qt/Qt', 'E Blank rate unit=Pt/Pt/Pt'];
  assert.deepEqual(labels(single1), expected);
  for (const owner of new Set(split1.map((r) => r.owner))) {
    assert.deepEqual(labels(split1.filter((r) => r.owner === owner)), expected, `split owner ${owner} lines are mislabelled`);
  }
  onlyLabelsMoved(single0, single1, 'single');
  onlyLabelsMoved(split0, split1, 'split');
  // Only lines D and E gain a new conversion (40 Qt is 10 Gal; 16 Pt is 2 Gal, where a blank rate unit had none).
  const glLb = (snap) => snap.map((r) => `${r.item.total_applied_gl_lb ?? '-'} ${r.item.gl_lb_unit ?? '-'}`);
  assert.deepEqual(glLb(single1).slice(0, 3), glLb(single0).slice(0, 3), 'lines A-C changed their gl/lb amount');
  assert.equal(Number(single1[3].item.total_applied_gl_lb) * 4, Number(single0[3].item.total_applied_gl_lb), 'the Qt line is not converted as quarts');
  assert.equal(single0[4].item.total_applied_gl_lb, null, 'the blank-rate line had a conversion before');
  assert.equal(Number(single1[4].item.total_applied_gl_lb), 2, 'the blank-rate line is not converted from its pints');
  console.log(`[prover] AFTER: single ${labels(single1).join(', ')}; both split owners match; every amount, quantity, acre and header column unchanged`);

  // 4. Re-apply refuses on the source pin.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied twice');
  assert.match(again.output, /JOB_INVOICE_UNIT_SOURCE_DRIFT/);
  assert.equal(implState().split('|')[0], NEW_IMPL_MD5);
  console.log('[prover] RE-APPLY: refused on the source pin, nothing changed');
  console.log('JOB_INVOICE_UNIT_PROOF_PASS');
} finally {
  if (KEEP && started) console.log(`[prover] kept container ${NAME}`);
  else if (started) docker(['rm', '-f', NAME], { allowFailure: true });
}

