#!/usr/bin/env node
/**
 * Real-schema proof for 20270303100000_job_invoice_kept_epa (#2341; contract
 * docs/plans/2026-11-24-job-invoice-kept-epa-CONTRACT.md). Container setup and replay copied from
 * prove-job-transfer-below-cost-real-schema.mjs. Completed jobs go through transfer_job_to_invoice as a signed-in
 * admin, each case rolled back. The spray is recorded through the real _job_epa_freeze while the catalog has the old
 * number; the catalog is then corrected; then Create Invoice runs.
 *   FIDELITY: the replayed transfer and capture bodies are the ones the candidate pins (the capture's is live's).
 *   BEFORE:   the invoice line, its restricted-use capture and the posted restricted-use record show the NEW number.
 *   AFTER:    they show the number the job kept, for a single owner, two owners and a grower's own product; a product
 *             kept with no number and a "Not recorded" job take the catalog number (contract D1 a); an invoice not
 *             made from a job is unchanged. Grants and settings unchanged; a second apply stops at the preflight.
 *
 * Run: node scripts/smoke/prove-job-invoice-kept-epa-real-schema.mjs   (needs Docker)
 * Prints JOB_INVOICE_KEPT_EPA_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Iterating: CRX_PROVER_REUSE=<kept container> CRX_PROVER_DB=<a copy of its replayed database> skips the replay.
const REUSE = process.env.CRX_PROVER_REUSE;
const NAME = REUSE || `crx-kept-epa-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
// Shell commands below name the database; only a bare name is accepted (Sol r1).
if (!/^[a-z0-9_]+$/.test(DB)) throw new Error('CRX_PROVER_DB must be a bare database name (a-z, 0-9, _)');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270303100000_job_invoice_kept_epa.sql');
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
  // Need live's storage.objects policies, which this database does not have; neither touches units or stock.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
  // Its preflight pins stage_offline_action as 20261217100000 (ledger-only above) leaves it; delivery driver checks only.
  '20270227110000_delivery_driver_checks_need_a_driver.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate changes or relies on.
const TOUCHED = /(_transfer_job_to_invoice_intent_impl_20260908|_capture_invoice_line_rup|_invoice_line_rup_facts|_job_kept_epa|job_product_epa|_fill_invoice_line_epa|_fill_invoice_line_brands)/i;
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
  // 20261217100000 (ledger only) names the transfer only in a comment saying it is untouched.
  for (const name of [...PARKED, '20270227110000_delivery_driver_checks_need_a_driver.sql']) {
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
  if (REUSE) return;
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

const id = (s) => `b5b5b5b5-2341-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), A = id('c1'), B = id('c2'), G = id('f1'), F = id('f2'), P = id('d1'), R = id('d2'), NONE = id('d3');
const IMPL = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)';
const CAPTURE = 'public._capture_invoice_line_rup()';
const KEPT = 'public._job_kept_epa(uuid,uuid)';
const OLD_IMPL = 'aa385acd9adb57eadb0a52ac37b833d8';
const OLD_CAPTURE = '5fb2eb8c484b08242a46f647f9d09ec4';  // live, read 2026-11-24
const md5Of = (sig) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
const meta = (sig) => scalar(`SELECT concat_ws('|', prosecdef, proowner::regrole, proconfig::text, coalesce(proacl::text, '-')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
const OLD_NUM = '100-1070', NEW_NUM = '100-2070', R_OLD = '100-1080', R_NEW = '100-2080';

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'kept-epa-admin@example.invalid', '{"full_name":"[PROVER] Kept EPA Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active) VALUES ('${A}', '[PROVER] KEPT Farm A', 1, true), ('${B}', '[PROVER] KEPT Farm B', 1, true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active, is_rup, epa_registration) VALUES
      ('${P}', '[PROVER] KEPT chem', 'KEPT-1', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 30, 50, 50, 50, true, false, '${OLD_NUM}'),
      ('${R}', '[PROVER] KEPT restricted chem', 'KEPT-2', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 30, 50, 50, 50, true, false, '${R_OLD}'),
      ('${NONE}', '[PROVER] KEPT no-number chem', 'KEPT-3', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 30, 50, 50, 50, true, false, NULL);
    INSERT INTO public.epa_registrations (epa_registration, rup_status, signal_word, created_by, updated_by) VALUES
      ('${R_OLD}', 'yes', 'Danger', '${ADMIN}', '${ADMIN}'), ('${R_NEW}', 'no', 'Caution', '${ADMIN}', '${ADMIN}'),
      ('${OLD_NUM}', 'no', 'Warning', '${ADMIN}', '${ADMIN}'), ('${NEW_NUM}', 'no', 'Caution', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
      ('${G}', '${A}', '[PROVER] KEPT field A', 100, true), ('${F}', '${A}', '[PROVER] KEPT field A+B', 100, true);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES
      ('${G}', '${A}', 100, true, NULL), ('${F}', '${A}', 60, true, NULL), ('${F}', '${B}', 40, false, NULL);`);
  // Test-only helpers (prover database only), callable by the signed-in admin so each case runs as the real caller.
  psql(`CREATE SCHEMA kx AUTHORIZATION supabase_admin;
    -- A completed job on p_field: 10 acres, one line per product (10 Gal at $50, $30 cost; p_supplied = grower's own).
    CREATE FUNCTION kx.job(p_field uuid, p_products uuid[], p_supplied boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
    DECLARE v_j uuid := gen_random_uuid(); v_p uuid;
    BEGIN
      INSERT INTO jobs (id, job_number, customer_id, status, job_date, total_acres, total_cost_cents, total_price_cents)
      VALUES (v_j, 'KEPT-' || left(v_j::text, 8), '${A}', 'completed', (now() AT TIME ZONE 'America/Chicago')::date, 10,
              CASE WHEN p_supplied THEN 0 ELSE 30000 * cardinality(p_products) END,
              CASE WHEN p_supplied THEN 0 ELSE 50000 * cardinality(p_products) END);
      INSERT INTO job_fields (job_id, field_id, acres_to_treat) VALUES (v_j, p_field, 10);
      FOREACH v_p IN ARRAY p_products LOOP
        INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, cost_per_unit_cents, customer_supplied)
        VALUES (v_j, v_p, 10, 'Gal', 1, 'Gal', CASE WHEN p_supplied THEN 0 ELSE 5000 END, CASE WHEN p_supplied THEN 0 ELSE 3000 END, p_supplied);
      END LOOP;
      RETURN v_j;
    END $f$;
    -- The spray is recorded: the real recording function keeps each product's number as the catalog has it now.
    CREATE FUNCTION kx.spray(p_job uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT public._job_epa_freeze(p_job) $f$;
    -- A job sprayed before the recording existed ("Not recorded"), as 20261204120000's backfill marks it.
    CREATE FUNCTION kx.not_recorded(p_job uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      INSERT INTO job_epa_sprayed (job_id, not_recorded) VALUES (p_job, true);
      INSERT INTO job_product_epa (job_id, product_id, epa_registration, not_recorded)
        SELECT p_job, product_id, NULL, true FROM job_chemicals WHERE job_id = p_job $f$;
    -- The catalog number is corrected after the spray.
    CREATE FUNCTION kx.set_epa(p_product uuid, p_epa text) RETURNS void LANGUAGE sql SECURITY DEFINER
      SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
      UPDATE products SET epa_registration = p_epa WHERE id = p_product $f$;
    -- Every line of the job's invoices: farm:product:line number/captured number, ordered.
    CREATE FUNCTION kx.epas(p_job uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT COALESCE(string_agg(format('%s:%s:%s/%s', right(c.farm_name, 1), COALESCE(right(p.sku, 1), 'supplied'),
               COALESCE(x.epa_registration, '-'), COALESCE(cap.epa_registration || '(' || cap.rup_status || ',' || COALESCE(cap.signal_word, '-') || ')', '-')), ' ' ORDER BY c.farm_name, x.sort_order), '-')
        FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN invoice_items x ON x.invoice_id = i.id
        LEFT JOIN products p ON p.id = x.product_id LEFT JOIN invoice_line_rup_captures cap ON cap.invoice_item_id = x.id
       WHERE i.job_id = p_job AND i.deleted_at IS NULL AND NOT x.is_application_fee $f$;
    CREATE FUNCTION kx.records(p_job uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT COALESCE(string_agg(s.epa_registration || '(' || COALESCE(s.signal_word, '-') || ')', ',' ORDER BY s.epa_registration), 'none') FROM rup_sales_records s
        JOIN invoices i ON i.id = s.invoice_id WHERE i.job_id = p_job AND s.voided_at IS NULL $f$;
    -- A draft invoice NOT made from a job, with one line of p_product (number left blank, as a new line is).
    CREATE FUNCTION kx.plain_invoice_line(p_product uuid, p_typed text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
    DECLARE v_i uuid := gen_random_uuid(); v_x uuid := gen_random_uuid();
    BEGIN
      INSERT INTO invoices (id, invoice_number, customer_id, status, invoice_type, invoice_date, total_amount_cents)
      VALUES (v_i, 'KEPT-PLAIN-' || left(v_i::text, 8), '${A}', 'draft', 'field_application', (now() AT TIME ZONE 'America/Chicago')::date, 5000);
      INSERT INTO invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, cost_cents, sort_order)
      VALUES (v_x, v_i, p_product, 'plain', 1, 'Gal', 5000, 5000, 3000, 0);
      UPDATE invoice_items SET epa_registration = p_typed WHERE id = v_x AND p_typed IS NOT NULL;
      RETURN (SELECT format('%s/%s(%s,%s)', x.epa_registration, c.epa_registration, c.rup_status, COALESCE(c.signal_word, '-')) FROM invoice_items x
                LEFT JOIN invoice_line_rup_captures c ON c.invoice_item_id = x.id WHERE x.id = v_x);
    END $f$;
    -- Add product on the job's invoice: one more line of p_product, number left blank (filled from today's catalog).
    CREATE FUNCTION kx.add_line(p_job uuid, p_product uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, cost_cents, sort_order)
      SELECT i.id, p_product, 'added', 1, 'Gal', 5000, 5000, 3000, 99 FROM invoices i WHERE i.job_id = p_job AND i.deleted_at IS NULL $f$;
    GRANT USAGE ON SCHEMA kx TO authenticated;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA kx TO authenticated;`, { user: 'supabase_admin' });
  console.log(`[prover] test rows: an admin; farms A and B; field A (A 100%), field A+B (A 60%, B 40%); a chemical (EPA ${OLD_NUM}), a chemical whose kept registration ${R_OLD} is restricted use (Danger) and whose corrected ${R_NEW} is not (Caution) and a chemical with no EPA number`);
}

const asAdmin = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;\n`;
const key = () => `'kept-' || gen_random_uuid()`;
// One rolled-back case as the signed-in admin: make the job, record the spray (or not), correct the catalog, then
// Create Invoice through the app's own transfer_job_to_invoice; returns the invoice lines' numbers.
const invoiceCase = ({ field = G, products = [P], supplied = false, before = 'spray', post = false, add = null, tail = true }) => `${asAdmin}
CREATE TEMP TABLE j AS SELECT kx.job('${field}', ARRAY[${products.map((x) => `'${x}'`).join(',')}]::uuid[], ${supplied}) AS id;
${before === 'spray' ? 'SELECT kx.spray((SELECT id FROM j));' : 'SELECT kx.not_recorded((SELECT id FROM j));'}
SELECT kx.set_epa('${P}', '${NEW_NUM}'), kx.set_epa('${R}', '${R_NEW}'), kx.set_epa('${NONE}', '100-2090');
SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', ${key()});
${add ? `SELECT kx.add_line((SELECT id FROM j), '${add}');` : ''}
${post ? `-- As the app posts: the version the list loaded from invoices_postable.
SELECT public.post_invoice(v.id, public.invoice_postable_version(v), ${key()}) FROM invoices_postable v
  WHERE v.id IN (SELECT i.id FROM invoices i WHERE i.job_id = (SELECT id FROM j));` : ''}
${tail ? "SELECT kx.epas((SELECT id FROM j)) || ' | records=' || kx.records((SELECT id FROM j));" : ''}`;

const CASES = {
  single: invoiceCase({}),
  restricted: invoiceCase({ products: [R], post: true }),
  twoProducts: invoiceCase({ products: [P, R] }),
  twoOwners: invoiceCase({ field: F }),
  supplied: invoiceCase({ supplied: true }),
  keptNoNumber: invoiceCase({ products: [NONE] }),
  notRecorded: invoiceCase({ before: 'not_recorded' }),
  // Sol r1: Add product bills more of the same product under today's number; that line keeps its own number.
  addedLine: invoiceCase({ products: [R], add: R }),
};
const EXPECT_BEFORE = {
  single: `A:1:${NEW_NUM}/${NEW_NUM}(no,Caution) | records=none`,
  restricted: `A:2:${R_NEW}/${R_NEW}(no,Caution) | records=none`,  // the bug: the restricted-use sale went unrecorded
  twoOwners: `A:1:${NEW_NUM}/${NEW_NUM}(no,Caution) B:1:${NEW_NUM}/${NEW_NUM}(no,Caution) | records=none`,
};
const EXPECT_AFTER = {
  single: `A:1:${OLD_NUM}/${OLD_NUM}(no,Warning) | records=none`,
  restricted: `A:2:${R_OLD}/${R_OLD}(yes,Danger) | records=${R_OLD}(Danger)`,
  twoProducts: `A:1:${OLD_NUM}/${OLD_NUM}(no,Warning) A:2:${R_OLD}/${R_OLD}(yes,Danger) | records=none`,  // not posted
  twoOwners: `A:1:${OLD_NUM}/${OLD_NUM}(no,Warning) B:1:${OLD_NUM}/${OLD_NUM}(no,Warning) | records=none`,
  supplied: `A:supplied:${OLD_NUM}/- | records=none`,  // grower's own: no catalog link, so no capture or record (unchanged)
  keptNoNumber: 'A:3:100-2090/100-2090(unknown,-) | records=none',  // D1 (a): no kept number -> the catalog's
  notRecorded: `A:1:${NEW_NUM}/${NEW_NUM}(no,Caution) | records=none`,  // D1 (a)
  addedLine: `A:2:${R_OLD}/${R_OLD}(yes,Danger) A:2:${R_NEW}/${R_NEW}(no,Caution) | records=none`,
};
const plainLine = (typed) => `${asAdmin}SELECT kx.set_epa('${P}', '${NEW_NUM}'); SELECT kx.plain_invoice_line('${P}', ${typed ? `'${typed}'` : 'NULL'});`;

async function main() {
  buildContainer();
  assert.equal(md5Of(IMPL), OLD_IMPL, 'the replayed transfer body is the one the candidate pins');
  assert.equal(md5Of(CAPTURE), OLD_CAPTURE, "the replayed capture body is live's, which the candidate pins");
  console.log('[fidelity] replayed transfer (20270226150000) and capture (20270106110000, = live) bodies match the pins');
  const implMeta = meta(IMPL), captureMeta = meta(CAPTURE);
  if (!REUSE) seed();  // a reused container already has the seed rows

  for (const [k, want] of Object.entries(EXPECT_BEFORE)) {
    const got = okProbe(CASES[k]);
    console.log(`[before] ${k}: ${got}`);
    assert.equal(got, want, `before: ${k}`);
  }
  const plainBefore = [okProbe(plainLine(null)), okProbe(plainLine('100-3070'))];
  console.log(`[before] invoices not made from a job (blank, typed): ${plainBefore.join(' ; ')}`);

  stageText('candidate.sql', lf(CANDIDATE));
  // Sol r1: an open job invoice already written under the catalog's number stops the apply (rolled back).
  refusedProbe(`${invoiceCase({ tail: false })}\nRESET ROLE;\n\\i /tmp/candidate.sql`,
    /JOB_INVOICE_KEPT_EPA_PREFLIGHT: an open job invoice has a line whose EPA number is not the job's kept number/);
  console.log('[apply] an open job invoice written under the catalog number stops the apply at its preflight');
  // Luna: an open invoice of a job that kept no number (catalog number on the line, as intended) does not stop it.
  assert.equal(okProbe(`${invoiceCase({ products: [NONE], tail: false })}\nRESET ROLE;\n\\i /tmp/candidate.sql\nSELECT 'applied';`), 'applied');
  console.log('[apply] an open invoice of a job that kept no number does not stop the apply (rolled back)');
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.equal(meta(IMPL), implMeta, 'transfer owner, SECURITY DEFINER, search_path and grants unchanged');
  assert.equal(meta(CAPTURE), captureMeta, 'capture owner, SECURITY DEFINER, search_path and grants unchanged');
  assert.equal(meta(KEPT), 'f|postgres|{"search_path=public, pg_temp"}|{postgres=X/postgres}', '_job_kept_epa: owner only');
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /JOB_INVOICE_KEPT_EPA_PREFLIGHT: the transfer body is not the reviewed one/);
  console.log('[apply] candidate committed (postflight passed); grants and settings unchanged; a second apply stops at its preflight');

  for (const [k, want] of Object.entries(EXPECT_AFTER)) {
    const got = okProbe(CASES[k]);
    console.log(`[after] ${k}: ${got}`);
    assert.equal(got, want, `after: ${k}`);
  }
  const plainAfter = [okProbe(plainLine(null)), okProbe(plainLine('100-3070'))];
  console.log(`[after] invoices not made from a job (blank, typed): ${plainAfter.join(' ; ')}`);
  assert.deepEqual(plainAfter, plainBefore, 'an invoice not made from a job is captured exactly as before');
  assert.deepEqual(plainAfter, [`${NEW_NUM}/${NEW_NUM}(no,Caution)`, `100-3070/${NEW_NUM}(unknown,Caution)`]);
  // Negative control for billing: the new transfer body is the old one with only the EPA read changed (both loops).
  const keptRead = "COALESCE(NULLIF(btrim(jc.unit), ''), p.unit_size) AS unit_size,\n"
    + "             -- #2341: the EPA number the job kept for this product, else the catalog's (as before).\n"
    + "             COALESCE(public._job_kept_epa(p_job_id, jc.product_id), p.epa_registration) AS epa_registration, p.product_form,";
  const oldRead = "COALESCE(NULLIF(btrim(jc.unit), ''), p.unit_size) AS unit_size, p.epa_registration, p.product_form,";
  const q = (s) => `$q$${s}$q$`;
  const src = `replace(prosrc, chr(13), '')`;
  assert.equal(scalar(`SELECT (length(${src}) - length(replace(${src}, ${q(keptRead)}, ''))) / length(${q(keptRead)}) FROM pg_proc WHERE oid = '${IMPL}'::regprocedure;`),
    '2', 'both chemical reads take the kept number');
  assert.equal(scalar(`SELECT md5(replace(${src}, ${q(keptRead)}, ${q(oldRead)})) FROM pg_proc WHERE oid = '${IMPL}'::regprocedure;`), OLD_IMPL,
    'apart from the EPA read, the transfer body (pricing, payer, split, cost, locks, checks) is byte-for-byte the pinned one');
  console.log('[after] transfer body = pinned body with only the two EPA reads changed (billing logic untouched)');
  console.log('JOB_INVOICE_KEPT_EPA_PROOF_PASS');
}

try { await main(); }
// Sol r1: never remove a container this run did not create.
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
