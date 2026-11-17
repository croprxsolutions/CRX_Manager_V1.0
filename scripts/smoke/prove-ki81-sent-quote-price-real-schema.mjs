#!/usr/bin/env node
/**
 * Real-schema proof for KI-81 (contract docs/plans/2026-11-17-ki81-sent-price-invoices-CONTRACT.md):
 *   20270123100000_ki81_invoices_bill_sent_quote_price.sql (the candidate)
 *   scripts/smoke/ki81-sent-quote-price-reverse.sql (its rollback)
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, commits invented test rows (ids a81a81a8-...)
 * and a private k81 schema of seeding helpers, then:
 *   before  the chain scripts/smoke/smoke-ki81-sent-quote-price.sql FAILS (today's code bills an unsent price);
 *   apply   the candidate applies; the chain passes (cases F1-F5, X1-X3, B1-B3);
 *   C9      while a field-app save holds a sent quote, a quote edit's row lock waits (save_quote locks the
 *           quote FOR UPDATE first), and gets it once the save ends;
 *   grants  the helper is executable by no API role, the resolver by neither anon nor authenticated;
 *   again   a second apply refuses (KI81_PREFLIGHT); a drifted old body refuses the apply;
 *   reverse the rollback restores all four old bodies byte-identical (md5) and drops the helper; a second
 *           reverse refuses; the candidate re-applies cleanly after it.
 *
 * Run: node scripts/smoke/prove-ki81-sent-quote-price-real-schema.mjs   (needs Docker)
 * Prints KI81_SENT_QUOTE_PRICE_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Iterating: CRX_PROVER_REUSE=<kept container> CRX_PROVER_DB=<a copy of its replayed database> skips the replay.
const REUSE = process.env.CRX_PROVER_REUSE;
const NAME = REUSE || `crx-ki81-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270123100000_ki81_invoices_bill_sent_quote_price.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'ki81-sent-quote-price-reverse.sql');
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-ki81-sent-quote-price.sql');
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
  // Need live's storage.objects policies, which this database does not have; neither touches quotes or invoices.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate or its follow-up creates or relies on.
const TOUCHED = /(create_invoice_from_blend_ticket|_save_field_app_invoice_impl_20260714|_save_field_app_split_invoice_impl|resolve_field_app_chemical_price|_assert_quote_prices_as_sent|_field_app_sent_quote_price_cents)/i;
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
const n = (sql) => Number(scalar(sql));
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
// A rolled-back probe: as postgres with triggers on (uid null) or as a signed-in user. Returns the last row.
function probe(sql, uid = null) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${claims}\n${sql}\nROLLBACK;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '' };
}
function okProbe(sql, uid) { const r = probe(sql, uid); assert.equal(r.status, 0, r.output); return r.last; }
function refusedProbe(sql, pattern, uid) {
  const r = probe(sql, uid);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}\n${r.output}`);
  assert.match(r.output, pattern);
}

const id = (s) => `a81a81a8-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), A = id('c1'), B = id('c2'), C = id('c3'), G = id('f1'), F = id('f2'), P = id('d1'), BP = id('d2');
const FNS = ['create_invoice_from_blend_ticket', '_save_field_app_invoice_impl_20260714', '_save_field_app_split_invoice_impl',
  'resolve_field_app_chemical_price', '_field_app_sent_quote_price_cents'];
const OLD = 'create_invoice_from_blend_ticket:a6f5c6e72d6632313549313b34f406ad,_save_field_app_invoice_impl_20260714:0f5da38476fe174cd25c9bf3e364055f,'
  + '_save_field_app_split_invoice_impl:a69f21d8e9f32fc6fecb38ac3a54801c,resolve_field_app_chemical_price:d2617d60d7b6e5b922bc3e3be4e5850b';
const NEW = 'create_invoice_from_blend_ticket:2a45b09ef78fb4b289db979401bc1bee,_save_field_app_invoice_impl_20260714:f44ed39784f88be2b01de43868d60058,'
  + '_save_field_app_split_invoice_impl:ccb5dfb90cc2f4faa6d839c64eaa7267,resolve_field_app_chemical_price:a9f32657d9c266b6a5f634d4b51d7823,'
  + '_field_app_sent_quote_price_cents:097fcb3f70b096a8f925158ffad0346b';
const ASSERT_MD5 = '4e3bca2b48a4af44de9d1f219a880586';
const bodies = () => scalar(`SELECT string_agg(proname || ':' || md5(replace(prosrc, chr(13), '')), ',' ORDER BY array_position(ARRAY['${FNS.join("','")}'], proname::text))
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('${FNS.join("','")}');`);
const assertMd5 = () => scalar("SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._assert_quote_prices_as_sent(uuid)'::regprocedure;");

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ki81-admin@example.invalid', '{"full_name":"[PROVER] KI81 Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active) VALUES
      ('${A}', '[PROVER] KI81 Farm A', 1, true), ('${B}', '[PROVER] KI81 Farm B', 1, true), ('${C}', '[PROVER] KI81 Farm C', 1, true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active) VALUES
      ('${P}', '[PROVER] KI81 Gallon chem', 'K81-GAL', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 5, 10, 10, 10, true),
      ('${BP}', '[PROVER] KI81 Blend chem', 'K81-BLEND', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 5, 10, 10, 10, true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
      ('${G}', '${A}', '[PROVER] KI81 field A', 100, true), ('${F}', '${A}', '[PROVER] KI81 field A+B', 100, true);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES
      ('${G}', '${A}', 100, true, NULL), ('${F}', '${A}', 50, true, NULL), ('${F}', '${B}', 50, false, NULL);
    DELETE FROM public.app_settings WHERE setting_key = 'per_line_split_billing_enabled';
    INSERT INTO public.app_settings (setting_key, setting_value) VALUES ('per_line_split_billing_enabled', 'true');`);
  // Seeding helpers for the chain (test data only, never shipped). k81.quote writes a quote, one section on the
  // field and one line, and (when sent) a trusted V1 snapshot of that line, with user triggers off, as a send leaves it.
  psql(`CREATE SCHEMA k81 AUTHORIZATION supabase_admin;
    CREATE FUNCTION k81.quote(p_customer uuid, p_field uuid, p_product uuid, p_price numeric, p_status text, p_expires date, p_sent boolean)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
    DECLARE v_q uuid := gen_random_uuid(); v_s uuid := gen_random_uuid(); v_i uuid := gen_random_uuid();
    BEGIN
      INSERT INTO quotes (id, quote_number, customer_id, created_by, status, expires_at)
      VALUES (v_q, 'K81-' || left(v_q::text, 8), p_customer, '${ADMIN}', p_status,
              ((p_expires + 1)::timestamp - interval '1 minute') AT TIME ZONE 'America/Chicago');
      INSERT INTO quote_sections (id, quote_id, section_name, sort_order, field_id) VALUES (v_s, v_q, 'K81', 0, p_field);
      INSERT INTO quote_items (id, quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
      VALUES (v_i, v_q, v_s, p_product, 0, p_price, 20, 10, 2, 'gal/acre');
      IF p_sent THEN
        INSERT INTO quote_versions (quote_id, version_number, sent_by, snapshot_data, restore_trusted_at)
        VALUES (v_q, 1, '${ADMIN}', jsonb_build_object('quote', jsonb_build_object('customer_id', p_customer),
          'sections', jsonb_build_array(jsonb_build_object('items', jsonb_build_array(jsonb_build_object(
            'quote_item_id', v_i, 'product_id', p_product, 'price_per_unit', p_price))))), now());
      END IF;
      RETURN v_q;
    END $f$;
    -- A price change after the send; recorded = save_quote's trail row for V1 (a lower price needs no grower tick).
    CREATE FUNCTION k81.reprice(p_quote uuid, p_price numeric, p_recorded boolean DEFAULT false)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
    DECLARE v_i record;
    BEGIN
      SELECT id, product_id, price_per_unit INTO v_i FROM quote_items WHERE quote_id = p_quote;
      UPDATE quote_items SET price_per_unit = p_price WHERE id = v_i.id;
      IF p_recorded THEN
        INSERT INTO quote_price_changes (quote_id, quote_item_id, product_id, old_price_cents, new_price_cents, changed_by, sent_version)
        VALUES (p_quote, v_i.id, v_i.product_id, ROUND(v_i.price_per_unit * 100), ROUND(p_price * 100), '${ADMIN}', 1);
      END IF;
    END $f$;
    CREATE FUNCTION k81.soft_delete(p_quote uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
      SET session_replication_role = replica AS $f$ UPDATE quotes SET deleted_at = now() WHERE id = p_quote $f$;
    -- A job on the quote's section, and an approved, unbilled blend ticket for 20 Gal of the product on the field.
    CREATE FUNCTION k81.blend_ticket(p_by uuid, p_customer uuid, p_field uuid, p_product uuid, p_quote uuid)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
    DECLARE v_job uuid; v_t uuid;
    BEGIN
      INSERT INTO jobs (job_number, customer_id, job_date, status, quote_id, quote_section_id, total_acres)
      VALUES ('K81-J-' || left(gen_random_uuid()::text, 8), p_customer, (now() AT TIME ZONE 'America/Chicago')::date, 'scheduled',
              p_quote, (SELECT id FROM quote_sections WHERE quote_id = p_quote), 10) RETURNING id INTO v_job;
      INSERT INTO blend_tickets (ticket_number, uploaded_by, customer_id, status, review_status, payment_status, order_link_status,
          season, total_acres, source, job_id)
      VALUES ('K81-BT-' || left(gen_random_uuid()::text, 8), p_by, p_customer, 'completed', 'approved', 'unbilled', 'unlinked',
              public.current_season(), 10, 'manual', v_job) RETURNING id INTO v_t;
      INSERT INTO blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres) VALUES (v_t, p_field, p_customer, 10);
      INSERT INTO blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
      VALUES (v_t, p_product, '[PROVER] KI81 blend line', 20, 'Gal', 2, 'gal/ac', 1);
      RETURN v_t;
    END $f$;
    GRANT USAGE, CREATE ON SCHEMA k81 TO postgres; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA k81 TO postgres;`, { user: 'supabase_admin' });
  // The saves run as the caller (postgres, signed in as the admin), through the public wrappers.
  psql(`CREATE FUNCTION k81.save_single(p_by uuid, p_field uuid, p_product uuid, p_manual bigint)
    RETURNS TABLE (unit_price_cents bigint, price_source text) LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$
    DECLARE v_res jsonb;
    BEGIN
      v_res := public.save_field_app_invoice(NULL,
        jsonb_build_object('invoice_date', ((now() AT TIME ZONE 'America/Chicago')::date)::text, 'salesman_id', p_by),
        jsonb_build_array(jsonb_build_object('field_id', p_field, 'map_number', 1, 'total_acres', 100, 'planted_acres', 100,
          'applied_acres', 10, 'sort_order', 0)),
        jsonb_build_array(jsonb_build_object('description', 'K81 chem', 'rate_per_acre', 16, 'rate_unit', 'oz', 'unit_size', 'Gal',
          'cost_cents', 500, 'sort_order', 0, 'manual_override', p_manual IS NOT NULL, 'product_id', p_product, 'unit_price_cents', p_manual)),
        p_by, NULL, 'k81-single-' || gen_random_uuid());
      RETURN QUERY SELECT ii.unit_price_cents::bigint, ii.price_source FROM invoice_items ii
        WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid AND ii.product_id = p_product;
    END $f$;
    -- 1 Gal on the field through the split-bill save; returns the total of every child invoice.
    CREATE FUNCTION k81.save_split(p_by uuid, p_field uuid, p_product uuid) RETURNS bigint LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$
    DECLARE v_res jsonb;
    BEGIN
      v_res := public.save_field_app_split_invoice(NULL, NULL,
        jsonb_build_object('invoice_date', ((now() AT TIME ZONE 'America/Chicago')::date)::text),
        jsonb_build_array(jsonb_build_object('field_id', p_field, 'applied_acres', 10)),
        jsonb_build_array(jsonb_build_object('line_kind', 'chemical', 'product_id', p_product, 'description', 'K81 split chem',
          'source_quantity', 1, 'rate_unit', 'Gal', 'manual_override', false)),
        p_by, NULL, 'k81-split-' || gen_random_uuid());
      RETURN (SELECT sum(total_amount_cents) FROM invoices WHERE invoice_group_id = (v_res->>'invoice_group_id')::uuid AND deleted_at IS NULL);
    END $f$;`);
  console.log('[prover] committed test rows: growers A, B, C; field G (A) and field F (A 50% / B 50%); a $10.00 Gal chemical and a blend chemical');
}

function runChain() {
  stageText('chain.sql', lf(SMOKE));
  return apply('chain.sql');
}

// C9: a field-app save holds a sent quote (FOR SHARE) until its transaction ends; save_quote's first step, the quote
// row lock FOR UPDATE, must wait for it, so the price cannot change between the check and the invoice line.
async function concurrencyCase() {
  const q = scalar(`SELECT k81.quote('${A}', '${G}', '${P}', 20.00, 'sent', (now() AT TIME ZONE 'America/Chicago')::date, true);`);
  const held = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT });
  let out = '';
  held.stdout.on('data', (d) => { out += d; }); held.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => held.on('close', resolve));
  held.stdin.end(`BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
SELECT 'saved:' || unit_price_cents || ':' || price_source FROM k81.save_single('${ADMIN}', '${G}', '${P}', NULL);
SELECT pg_sleep(6);
ROLLBACK;
`);
  let waited = false;
  for (let i = 0; i < 40 && !waited; i += 1) {
    wait(250);
    waited = scalar(`SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'tuple' OR (a.query LIKE '%pg_sleep(6)%' AND a.state = 'active');`) !== '0';
  }
  assert.ok(waited, `the held save never reached its sleep:\n${out}`);
  const r = probe(`SET LOCAL lock_timeout = '1s';\nSELECT 1 FROM public.quotes WHERE id = '${q}' FOR UPDATE;`);
  assert.notEqual(r.status, 0, 'a quote edit took the quote lock while a field-app save held it');
  assert.match(r.output, /lock timeout/i);
  const code = await done;
  assert.equal(code, 0, out);
  assert.match(out, /saved:2000:quoted/);
  okProbe(`SET LOCAL lock_timeout = '1s';\nSELECT 1 FROM public.quotes WHERE id = '${q}' FOR UPDATE;`);
  raw(`DELETE FROM public.quote_versions WHERE quote_id = '${q}'; DELETE FROM public.quote_items WHERE quote_id = '${q}';
    DELETE FROM public.quote_sections WHERE quote_id = '${q}'; DELETE FROM public.quotes WHERE id = '${q}';`);
  console.log('[case] C9 while a field-app save holds a sent quote (billing it 2000, quoted), a quote edit\'s row lock waits (lock timeout), and gets it once the save ends');
}

function grantCase() {
  const can = (role, fn) => scalar(`SELECT has_function_privilege('${role}', '${fn}'::regprocedure, 'EXECUTE');`);
  const helper = 'public._field_app_sent_quote_price_cents(uuid,uuid[],uuid[],date)';
  const resolver = 'public.resolve_field_app_chemical_price(uuid,uuid[],integer,bigint,uuid[],date)';
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(can(role, helper), 'f', `${role} may run the helper`);
  for (const role of ['anon', 'authenticated']) assert.equal(can(role, resolver), 'f', `${role} may run the resolver`);
  assert.equal(scalar(`SELECT prosecdef::text || ',' || provolatile::text FROM pg_proc WHERE oid = '${helper}'::regprocedure;`), 'false,v');
  assert.equal(scalar(`SELECT prosecdef::text || ',' || provolatile::text || ',' || array_to_string(proconfig, ';') FROM pg_proc WHERE oid = '${resolver}'::regprocedure;`),
    'true,v,search_path=public, pg_temp');
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname = 'resolve_field_app_chemical_price';"), '1', 'the old resolver signature is gone');
  console.log('[case] G the helper is executable by no API role (invoker rights); the resolver (definer rights, search_path public, pg_temp, volatile) by neither anon nor authenticated; one resolver signature');
}

async function main() {
  if (!REUSE) buildContainer();
  installLiveAuthUid();
  seed();
  assert.equal(bodies(), OLD, 'the four bodies before the candidate are not the reviewed live bodies');
  assert.equal(assertMd5(), ASSERT_MD5, 'the sent-price lock is not the reviewed body');

  const before = runChain();
  assert.notEqual(before.status, 0, 'the chain passed before the fix');
  assert.match(before.output, /SMOKE_FAIL\(F2\)/, before.output);
  console.log(`[case] B before the fix the chain fails at F2: ${/SMOKE_FAIL\(F2\)[^\n]*/.exec(before.output)[0]}`);

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.equal(bodies(), NEW);
  assert.equal(assertMd5(), ASSERT_MD5, 'the sent-price lock is unchanged');

  const after = runChain();
  assert.equal(after.status, 0, after.output);
  assert.match(after.output, /SMOKE_PASS_ROLLBACK/);
  console.log('[case] F1-F5, X1-X3, B1-B3 pass: sent price bills; unsent change refuses; recorded change bills; ineligible quotes give the tier price; two prices refuse, a typed price saves; split and blend follow the same rule');

  await concurrencyCase();
  grantCase();

  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /KI81_PREFLIGHT/);
  console.log('[case] A a second apply refuses (KI81_PREFLIGHT)');

  stageText('reverse.sql', lf(REVERSE));
  const rev = apply('reverse.sql');
  assert.equal(rev.status, 0, rev.output);
  assert.equal(bodies(), OLD, 'the reverse did not restore the four old bodies byte-identical');
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname = '_field_app_sent_quote_price_cents';"), '0');
  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public.resolve_field_app_chemical_price(uuid,uuid[],integer,bigint)'::regprocedure, 'EXECUTE');"), 'f');
  const rev2 = apply('reverse.sql');
  assert.notEqual(rev2.status, 0); assert.match(rev2.output, /KI81_REVERSE_PREFLIGHT/);
  console.log(`[case] R the reverse restores the four old bodies (md5 ${OLD.split(',').map((x) => x.split(':')[1].slice(0, 8)).join(', ')}) and drops the helper; a second reverse refuses`);

  // A drifted old body refuses the apply and changes nothing.
  const drift = probe(`DO $d$ BEGIN EXECUTE replace(pg_get_functiondef('public._save_field_app_invoice_impl_20260714(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure),
    E'\\n$function$', E'\\n-- drift\\n$function$'); END $d$;\n${lf(CANDIDATE)}`);
  assert.notEqual(drift.status, 0); assert.match(drift.output, /KI81_PREFLIGHT/);
  assert.equal(bodies(), OLD);
  console.log('[case] D a drifted old body refuses the apply (KI81_PREFLIGHT)');

  const reapply = apply('candidate.sql');
  assert.equal(reapply.status, 0, reapply.output);
  assert.equal(bodies(), NEW);
  assert.equal(runChain().status, 0);
  console.log('[case] RA the candidate re-applies after the reverse and the chain passes again');
  console.log('KI81_SENT_QUOTE_PRICE_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
