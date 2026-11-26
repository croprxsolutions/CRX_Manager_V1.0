#!/usr/bin/env node
/**
 * Real-schema proof for 20270311200000_job_invoice_split_cents.sql (Mason, 2026-11-26: "Job-invoice cents: yes please,
 * fix it before Dec 15"). Harness copied from prove-tiny-line-counts-as-zero-real-schema.mjs; seed and cases follow
 * prove-job-invoice-kept-epa-real-schema.mjs.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container, replays
 * every post-baseline migration before the candidate (staging's current transfer body), then runs completed jobs
 * through the app's own transfer_job_to_invoice as a signed-in admin, each case rolled back.
 *   BEFORE:   a $100.00 line split 50.01% / 50.00% bills $100.01; 10 Gal at $12.34 in thirds bills $123.39; a 3-cent
 *             line in three bills 4 cents; 1 Gal at $9,999.99 in three bills $10,000.00.
 *   AFTER:    every priced line's owner amounts add up to the line to the cent, split by acre share (one and two
 *             products, two and three owners), and an owner with a quantity bills at least 1 cent when the line has
 *             enough cents (else the line is refused by name, as before); quantities, unit prices, per-unit costs,
 *             booked costs, member headers and shares, the anchor, single-owner and customer-supplied invoices are
 *             unchanged; the body differs from the pinned one only in the line amount; grants unchanged; a second
 *             apply stops at the preflight.
 *   ROLLBACK: re-emitting the 20270303100000 body restores its md5 and the old amounts.
 *
 * Run: node scripts/smoke/prove-job-invoice-split-cents-real-schema.mjs   (needs Docker)
 * Prints JOB_INVOICE_SPLIT_CENTS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a disposable container this run creates (no reuse of another container or database: Sol r1).
const NAME = `crx-jobcents-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270311200000_job_invoice_split_cents.sql');
const PINNED = path.join(MIGRATIONS, '20270303100000_job_invoice_kept_epa.sql');
const FOLLOW_UPS = [];
const LATER_READ_ONLY = new Set([]);
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate or its follow-up creates or relies on.
const TOUCHED = /(_transfer_job_to_invoice_intent_impl_20260908|_job_transfer_split_qty_20270207|_job_transfer_line_price_20270207|_job_transfer_shares_20270207)/i;
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const LIVE_UNIT_ROWS = "('3f5c3827-8523-4b42-9913-ad479588ff95'::uuid, 'Dry oz', 1, 'dry', '1 dry ounce'), ('5ed18e4b-c4d9-42fc-b85e-22babd3fc098'::uuid, 'Ea', 1, 'both', 'Each / unit'), ('f9e10e66-5027-464e-bb9e-ed9800875256'::uuid, 'fl oz', 1, 'liquid', '1 fluid ounce'), ('4406cacd-a7fe-42db-8c84-694e61bb937b'::uuid, 'g', 0.03527396, 'dry', '1 gram = 0.03527396 dry ounces (1000 mg)'), ('29d05e43-cb40-461b-a969-88ee299faca8'::uuid, 'Gal', 128, 'liquid', '1 gallon = 128 fluid ounces'), ('53997e31-d152-4ab6-b768-d1aa81b657bf'::uuid, 'Lb', 16, 'dry', '1 pound = 16 dry ounces'), ('fc5d349f-b58c-48f1-991d-fa0161fd3d01'::uuid, 'LB', 16, 'dry', '1 pound (capitalized alias)'), ('ddde7daf-8090-492b-aed9-c0b7f8ecfd34'::uuid, 'MG', 0.00003527396, 'dry', '1 milligram = 0.00003527396 dry ounces'), ('438d5f7b-f015-4319-b2b7-4f9a672cb350'::uuid, 'oz', 1, 'liquid', '1 fluid ounce (alias for fl oz)'), ('b69ddac6-68ed-4f1d-8e09-e63a7fa6635a'::uuid, 'Oz', 1, 'liquid', '1 fluid ounce (capitalized alias)'), ('a31f95a0-df80-4025-977f-f1fb4e5c8d53'::uuid, 'Pt', 16, 'liquid', '1 pint = 16 fluid ounces'), ('35532f45-2fd0-4400-87d8-3509a58377c0'::uuid, 'qt', 32, 'liquid', '1 quart lowercase (alias for Qt)'), ('915f25ff-8876-4a49-a375-940047e38313'::uuid, 'Qt', 32, 'liquid', '1 quart = 32 fluid ounces'), ('722e8d86-8e68-47d8-a940-209fad38c70e'::uuid, 'Unit', 1, 'both', 'Each / unit (alias for Ea)')";

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
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
// 20261104150000 (WP-PM-9, live) pins three live function bodies that the historical LF replay
// does not reproduce; install them exactly as PM-9's own prover does, right before that file.
const FORMS_SEED_EACH = '20261104150000_product_forms_seed_each.sql';
const LIVE_BODY_MD5 = {
  'public.field_app_priced_quantity(numeric,text,text,text)': 'bc91a52577840973f18f1710e47edf2b',
  'public.convert_to_gl_lb(numeric,text,text)': 'ce9265521821c09b0cf74de45afb375b',
  'public.validate_product_units()': '83a51c58c83cd83bea760bd117410a38',
};

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
  const seededConvert = bodyFrom(FORMS_SEED_EACH,
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
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs', '--include-one-shot'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  // Others' migrations may sort between the candidate and a follow-up (live applied them in between);
  // they are not replayed, so each must leave alone what this proof covers.
  let last = at;
  for (const file of FOLLOW_UPS) {
    const i = all.indexOf(file);
    assert.ok(i > last, `${path.basename(file)} must sort after the candidate and earlier follow-ups`);
    last = i;
  }
  for (const file of all.slice(at + 1).filter((f) => !FOLLOW_UPS.includes(f) && !LATER_READ_ONLY.has(path.basename(f)))) {
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, created_at timestamptz DEFAULT now(), UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;
    -- Row security on, as live has it: 20261217100000 (the current job completion body) checks it (Sol r1).
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    // Other one-shot data migrations rewrite live rows this database does not have: ledger only, as live has them.
    if (ONE_SHOT.has(base.slice(0, -4))) { ledger(base.slice(0, -4)); continue; }
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    // BLK-1a's preflight needs live's count units (live has Ea and Unit, factor 1, both).
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
    }
    // RT-1's preflight pins live's unit factors; give it live's 14 unit rows (read live 2026-11-10).
    if (base === '20261229110000_product_rates_draft.sql') {
      raw(`DELETE FROM public.unit_conversions;
        INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};`);
    }
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    if (base === '20270106110000_invoice_brands_rup.sql') {
      // Live ran REG-1's one-time seed before this file; its preflight refuses without the seed row.
      raw(`INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint)
        SELECT '00000000-0000-4000-8000-000000000000', 'unknown', 'units-proof' WHERE NOT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);`);
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}


const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
// A rolled-back probe: as postgres with triggers on (uid null) or as a signed-in user. Returns the last row.
function probe(sql, uid = null) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${claims}\n${sql}\nROLLBACK;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '' };
}
function okProbe(sql, uid) { const r = probe(sql, uid); assert.equal(r.status, 0, r.output); return r.last; }

const id = (s) => `c3c3c3c3-1126-4000-8000-${String(s).padStart(12, '0')}`;
// Farms A < B < C by id (owners are ordered by id, so ties go to A first).
const ADMIN = id('a1'), A = id('c1'), B = id('c2'), C = id('c3');
const G = id('f1'), F2 = id('f2'), F3A = id('f3a'), F3B = id('f3b'), F3C = id('f3c'), F4 = id('f4');
const X = id('d1'), Y = id('d2'), Z = id('d3');
const IMPL = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)';
const OLD_IMPL = '53ecf1279da3aa7ea1590f440c6eb225';  // 20270303100000 (staging's current body)
const NEW_IMPL = '2714b8df71f9e191c5d11e41f205473d';
const md5Of = (sig) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
const meta = (sig) => scalar(`SELECT concat_ws('|', prosecdef, proowner::regrole, proconfig::text, coalesce(proacl::text, '-')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'jobcents-admin@example.invalid', '{"full_name":"[PROVER] Job Cents Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active) VALUES
      ('${A}', '[PROVER] JC Farm A', 1, true), ('${B}', '[PROVER] JC Farm B', 1, true), ('${C}', '[PROVER] JC Farm C', 1, true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active, is_rup, epa_registration) VALUES
      ('${X}', '[PROVER] JC X', 'JC-X', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 6, 10, 10, 10, true, false, NULL),
      ('${Y}', '[PROVER] JC Y', 'JC-Y', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 7, 12.34, 12.34, 12.34, true, false, NULL),
      ('${Z}', '[PROVER] JC Z', 'JC-Z', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 5, 9, 9, 9, true, false, NULL);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
      ('${G}', '${A}', '[PROVER] JC field A', 100, true), ('${F2}', '${A}', '[PROVER] JC field A+B', 100, true),
      ('${F3A}', '${A}', '[PROVER] JC third A', 1000, true), ('${F3B}', '${B}', '[PROVER] JC third B', 1000, true),
      ('${F3C}', '${C}', '[PROVER] JC third C', 1000, true), ('${F4}', '${A}', '[PROVER] JC field A+B+C', 100, true);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES
      ('${G}', '${A}', 100, true, NULL), ('${F2}', '${A}', 50.01, true, NULL), ('${F2}', '${B}', 50.00, false, NULL),
      ('${F3A}', '${A}', 100, true, NULL), ('${F3B}', '${B}', 100, true, NULL), ('${F3C}', '${C}', 100, true, NULL),
      ('${F4}', '${A}', 16.67, true, NULL), ('${F4}', '${B}', 23.33, false, NULL), ('${F4}', '${C}', 60.00, false, NULL);`);
  // Test-only helpers (prover database only), callable by the signed-in admin so each case runs as the real caller.
  psql(`CREATE SCHEMA jx AUTHORIZATION supabase_admin;
    -- A completed job for farm A on p_fields (p_acres each); p_lines: [{"p": product, "q": Gal, "c": price cents, "s": grower's own}].
    CREATE FUNCTION jx.job(p_fields uuid[], p_acres numeric[], p_lines jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
    DECLARE v_j uuid := gen_random_uuid(); v_l jsonb; v_i integer;
    BEGIN
      INSERT INTO jobs (id, job_number, customer_id, status, job_date, total_acres, total_cost_cents, total_price_cents)
      VALUES (v_j, 'JC-' || left(v_j::text, 8), '${A}', 'completed', (now() AT TIME ZONE 'America/Chicago')::date,
              (SELECT sum(a) FROM unnest(p_acres) a), 0, 0);
      FOR v_i IN 1 .. cardinality(p_fields) LOOP
        INSERT INTO job_fields (job_id, field_id, acres_to_treat) VALUES (v_j, p_fields[v_i], p_acres[v_i]);
      END LOOP;
      FOR v_l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, cost_per_unit_cents, customer_supplied)
        VALUES (v_j, (v_l->>'p')::uuid, (v_l->>'q')::numeric, 'Gal', 1, 'Gal',
                CASE WHEN (v_l->>'s')::boolean THEN 0 ELSE (v_l->>'c')::bigint END, 0, COALESCE((v_l->>'s')::boolean, false));
      END LOOP;
      RETURN v_j;
    END $f$;
    -- Each owner invoice's header (amount/cost), then each priced product: the owners' amounts summed / the line as one
    -- invoice bills it, round(unit price x the owners' quantities summed).
    CREATE FUNCTION jx.sums(p_job uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT (SELECT string_agg(format('%s=%s/%s', right(c.farm_name, 1), i.total_amount_cents, i.total_cost_cents), ' ' ORDER BY c.farm_name)
                FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.job_id = p_job AND i.deleted_at IS NULL)
        || ' | ' || COALESCE((SELECT string_agg(format('%s=%s/%s', right(s.sku, 1), s.billed, s.line), ' ' ORDER BY s.sku) FROM (
             SELECT p.sku, sum(x.extended_cents) AS billed, public.safe_cents_qty(max(x.unit_price_cents), sum(x.quantity)) AS line
               FROM invoices i JOIN invoice_items x ON x.invoice_id = i.id JOIN products p ON p.id = x.product_id
              WHERE i.job_id = p_job AND i.deleted_at IS NULL AND NOT x.is_application_fee
              GROUP BY p.sku) s), 'no priced lines') $f$;
    -- Every line without its amount: farm:description:quantity@unit price:per-unit cost:booked cost:acres:sort.
    CREATE FUNCTION jx.lines(p_job uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT string_agg(format('%s:%s:%s@%s:%s:%s:%s:%s', right(c.farm_name, 1), x.description, x.quantity, x.unit_price_cents,
               x.cost_cents, public.safe_cents_qty(x.cost_cents, x.quantity), x.acres, x.sort_order), ' ' ORDER BY c.farm_name, x.sort_order)
        FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN invoice_items x ON x.invoice_id = i.id
       WHERE i.job_id = p_job AND i.deleted_at IS NULL $f$;
    -- What every reader relies on: each header bills its lines and books their cost (a fee line's cost is its total), its
    -- share carries the header, the job points at the primary owner's invoice (the anchor), and the invoices are unposted.
    -- Sol r1: a member with no lines or no share compares as 0 (never NULL, which bool_and would skip), and has a share.
    CREATE FUNCTION jx.ties(p_job uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT CASE WHEN count(*) > 0 AND bool_and(COALESCE(
                    i.total_amount_cents = (SELECT COALESCE(sum(x.extended_cents), 0) FROM invoice_items x WHERE x.invoice_id = i.id)
                    AND i.total_cost_cents = (SELECT COALESCE(sum(CASE WHEN x.is_application_fee THEN COALESCE(x.cost_cents, 0)
                                                     ELSE public.safe_cents_qty(x.cost_cents, x.quantity) END), 0)
                                                FROM invoice_items x WHERE x.invoice_id = i.id)
                    AND i.total_amount_cents = (SELECT COALESCE(sum(s.amount_cents), 0) FROM invoice_shares s WHERE s.invoice_id = i.id)
                    AND EXISTS (SELECT 1 FROM invoice_shares s WHERE s.invoice_id = i.id)
                    AND i.status = 'unposted', false))
              THEN 'ties' ELSE 'BROKEN' END
          || ' anchor=' || (SELECT right(c.farm_name, 1) FROM jobs j JOIN invoices i2 ON i2.id = j.invoice_id
                              JOIN customers c ON c.id = i2.customer_id WHERE j.id = p_job)
        FROM invoices i WHERE i.job_id = p_job AND i.deleted_at IS NULL $f$;
    GRANT USAGE ON SCHEMA jx TO authenticated;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA jx TO authenticated;`, { user: 'supabase_admin' });
  console.log('[prover] test rows: an admin; farms A, B, C; field A (A 100%), field A+B (A 50.01% primary, B 50.00%), three'
    + ' 5-acre fields each 100% one farm; X ($6.00/Gal cost), Y ($7.00/Gal cost), Z (grower-supplied)');
}

const asAdmin = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;\n`;
const L = (p, q, c, s = false) => ({ p, q, c, s });
// One rolled-back case as the signed-in admin: make the completed job, then Create Invoice through the app's own
// transfer_job_to_invoice; returns sums || lines || ties (split by ' || ').
const invoiceCase = (fields, acres, lines) => `${asAdmin}
CREATE TEMP TABLE j AS SELECT jx.job(ARRAY[${fields.map((x) => `'${x}'`).join(',')}]::uuid[], ARRAY[${acres.join(',')}]::numeric[],
  '${JSON.stringify(lines)}'::jsonb) AS id;
SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jobcents-' || gen_random_uuid());
SELECT jx.sums((SELECT id FROM j)) || ' || ' || jx.lines((SELECT id FROM j)) || ' || ' || jx.ties((SELECT id FROM j));`;
const THIRDS = [[F3A, F3B, F3C], [5, 5, 5]];
const CASES = {
  // Desk example 1: a $100.00 line (10 Gal at $10.00) split 50.01% / 50.00%.
  halves: invoiceCase([F2], [10], [L(X, 10, 1000)]),
  // Desk example 2: 10 Gal at $12.34 in thirds.
  thirds: invoiceCase(...THIRDS, [L(Y, 10, 1234)]),
  // Two products, three owners (X in thirds drifts too: 3 x $33.33 = $99.99).
  twoProductsThirds: invoiceCase(...THIRDS, [L(X, 10, 1000), L(Y, 10, 1234)]),
  // Two products and a grower's own product, two owners.
  twoProductsHalves: invoiceCase([F2], [10], [L(X, 10, 1000), L(Y, 3, 1234), L(Z, 2, 0, true)]),
  // Sol r1 HIGH: 0.003 Gal at $10 (3 cents) split 16.67/23.33/60%. Old body bills 1 + 1 + 2 = 4 cents; the remainder
  // alone would leave A at $0 (refused), so A takes a cent from C: 1 + 1 + 1.
  tiny: invoiceCase([F4], [10], [L(X, 0.003, 1000)]),
  // Sol r1 MED: 1 Gal at $9,999.99 on 40.23 / 100.61 / 60.36 acres. Split by acre share, each owner within a cent of its
  // exact share (a split by quantity, 0.2 / 0.5 / 0.3, would put B 50.2 cents under and be refused).
  bigEdge: invoiceCase([F3A, F3B, F3C], [40.23, 100.61, 60.36], [L(X, 1, 999999)]),
  // One owner: the single-invoice path, untouched.
  single: invoiceCase([G], [10], [L(X, 10, 1000), L(Y, 10, 1234)]),
  // Grower's own product only, two owners: $0 lines, untouched.
  suppliedOnly: invoiceCase([F2], [10], [L(Z, 10, 0, true)]),
};
const split = (s) => { const [sums, lines, ties] = s.split(' || '); return { sums, lines, ties }; };
// Header amount/cost per owner | per product: owners' amounts summed / the line. Cost per owner is its own lines' cost x
// quantity (unchanged by the fix): thirds book 3 x $23.33 = $69.99 of a $70.00 line (see the migration's NOT CHANGED).
const EXPECT_BEFORE = {
  halves: 'A=5001/3000 B=5000/3000 | X=10001/10000',
  thirds: 'A=4113/2333 B=4113/2333 C=4113/2333 | Y=12339/12340',
  twoProductsThirds: 'A=7446/4333 B=7446/4333 C=7446/4333 | X=9999/10000 Y=12339/12340',
  twoProductsHalves: 'A=6852/4050 B=6851/4050 | X=10001/10000 Y=3702/3702',
  tiny: 'A=1/0 B=1/0 C=2/1 | X=4/3',
  bigEdge: 'A=200000/120 B=500000/300 C=300000/180 | X=1000000/999999',
};
const EXPECT_AFTER = {
  halves: 'A=5000/3000 B=5000/3000 | X=10000/10000',  // exact shares 5000.4999 / 4999.5000
  thirds: 'A=4114/2333 B=4113/2333 C=4113/2333 | Y=12340/12340',
  twoProductsThirds: 'A=7448/4333 B=7446/4333 C=7446/4333 | X=10000/10000 Y=12340/12340',
  twoProductsHalves: 'A=6851/4050 B=6851/4050 | X=10000/10000 Y=3702/3702',
  tiny: 'A=1/0 B=1/0 C=1/1 | X=3/3',
  bigEdge: 'A=199950/120 B=500049/300 C=300000/180 | X=999999/999999',
};
// Fewer cents than owners with a quantity (0.002 Gal at $10 = 2 cents, three owners): one owner would bill $0, so the
// line is refused by name, before and after (Mason, 2026-11-22, "never $0").
const TOO_TINY = invoiceCase([F4], [10], [L(X, 0.002, 1000)]);
function refusedTooTiny(label) {
  const r = probe(TOO_TINY);
  assert.notEqual(r.status, 0, `${label}: a 2-cent line across three owners is refused\n${r.output}`);
  assert.match(r.output, /JOB_LINE_ROUNDING: \[PROVER\] JC X can't be split between this job's owners/);
  console.log(`[${label}] tooTiny: 2 cents across three owners is refused (JOB_LINE_ROUNDING, never $0)`);
}
function runCases(label) {
  const out = {};
  for (const [k, sql] of Object.entries(CASES)) {
    out[k] = split(okProbe(sql));
    console.log(`[${label}] ${k}: ${out[k].sums} (${out[k].ties})`);
    assert.match(out[k].ties, /^ties anchor=A$/, `${label} ${k}: headers, costs and shares tie to the lines; anchor is A`);
  }
  return out;
}
function priced(sums) {  // [[product, billed, line], ...] as exact integers (Sol r1: never Number)
  return [...sums.split(' | ')[1].matchAll(/([A-Z])=(\d+)\/(\d+)/g)].map((m) => [m[1], BigInt(m[2]), BigInt(m[3])]);
}
function reverseSql() {
  // ROLLBACK as the migration states it: re-emit the 20270303100000 transfer body exactly as that file has it.
  const s = lf(PINNED);
  const start = s.indexOf('CREATE OR REPLACE FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(');
  const end = s.indexOf('$function$;', s.indexOf('AS $function$', start) + 13) + '$function$;'.length;
  assert.ok(start > 0 && end > start, '20270303100000 no longer holds the transfer body');
  return `${s.slice(start, end)}\n`;
}

function main() {
  buildContainer();
  assert.equal(md5Of(IMPL), OLD_IMPL, "the replayed transfer body is staging's current one (20270303100000), which the candidate pins");
  const implMeta = meta(IMPL);
  seed();

  const before = runCases('before');
  for (const [k, want] of Object.entries(EXPECT_BEFORE)) assert.equal(before[k].sums, want, `before: ${k}`);
  refusedTooTiny('before');
  console.log('[before] the bug: $100.00 bills $100.01 (50.01/50.00); $123.40 bills $123.39 (thirds); $100.00 bills $99.99 (thirds); 3 cents bill 4; $9,999.99 bills $10,000.00');

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.equal(md5Of(IMPL), NEW_IMPL);
  assert.equal(meta(IMPL), implMeta, 'transfer owner, SECURITY DEFINER, search_path and grants unchanged');
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /JOB_INVOICE_SPLIT_CENTS_PREFLIGHT: the transfer body is not the reviewed one/);
  console.log('[apply] candidate committed (postflight passed); grants and settings unchanged; a second apply stops at its preflight');

  const after = runCases('after');
  for (const [k, want] of Object.entries(EXPECT_AFTER)) assert.equal(after[k].sums, want, `after: ${k}`);
  for (const k of Object.keys(CASES)) {
    for (const [p, billed, line] of priced(after[k].sums)) assert.equal(billed, line, `after: ${k} ${p} owners add up to the line`);
    // Quantities, unit prices, per-unit and booked costs, acres and line order are the old ones; only amounts move.
    assert.equal(after[k].lines, before[k].lines, `after: ${k} lines apart from their amounts are unchanged`);
    // Each owner's header cost is unchanged (a line's booked cost is cost x quantity, as before).
    assert.deepEqual(after[k].sums.split(' | ')[0].replace(/=\d+\//g, '='), before[k].sums.split(' | ')[0].replace(/=\d+\//g, '='), `after: ${k} costs unchanged`);
  }
  for (const k of ['single', 'suppliedOnly']) assert.equal(after[k].sums, before[k].sums, `after: ${k} is unchanged`);
  refusedTooTiny('after');
  console.log('[after] every priced line: owners add up to the line to the cent; quantities, prices, costs, headers, shares and anchor tie; single-owner and grower-supplied invoices unchanged');

  // Negative control: the new body is the pinned one with only the line amount changed.
  const body = Buffer.from(scalar(`SELECT translate(encode(convert_to(replace(prosrc, chr(13), ''), 'UTF8'), 'base64'), E'\\n', '') FROM pg_proc WHERE oid = '${IMPL}'::regprocedure;`), 'base64').toString('utf8');
  const swap = (text, from, to) => { assert.equal(text.split(from).length, 2, `exactly one: ${from.slice(0, 60)}`); return text.replace(from, to); };
  const ALLOC = / {8}-- Mason, 2026-11-26 [\s\S]*?\n {8}END LOOP;\n/;
  assert.equal(body.match(new RegExp(ALLOC.source, 'g'))?.length, 1, 'the allocation step is in the body once');
  let old = body.replace(ALLOC, '');
  old = swap(old, '  v_qtys numeric[];\n  v_line_cents bigint;\n  v_owner_cents bigint[];\n  v_take integer;\n  v_give integer;\n', '  v_qtys numeric[];\n');
  old = swap(old, '          v_owner_ext := v_owner_cents[v_oidx];\n',
    '          v_owner_ext := safe_cents_qty(v_line.o_unit_price_cents, v_qtys[v_oidx]);\n');
  assert.equal(createHash('md5').update(old).digest('hex'), OLD_IMPL,
    'apart from the line amount, the transfer body (quantities, price, cost, checks, fee, shares, anchor, commissions) is the pinned one');
  console.log('[after] transfer body = pinned body with only the owner line amount changed');

  stageText('reverse.sql', reverseSql());
  const back = apply('reverse.sql');
  assert.equal(back.status, 0, back.output);
  assert.equal(md5Of(IMPL), OLD_IMPL, 'rollback restores the 20270303100000 body');
  assert.equal(meta(IMPL), implMeta, 'rollback keeps owner, settings and grants');
  const rolled = runCases('rollback');
  for (const k of Object.keys(CASES)) assert.equal(rolled[k].sums, before[k].sums, `rollback: ${k} bills as before`);
  refusedTooTiny('rollback');
  console.log('[rollback] re-emitting the 20270303100000 body restores its md5 and the old amounts ($100.01, $123.39)');
  console.log('JOB_INVOICE_SPLIT_CENTS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
