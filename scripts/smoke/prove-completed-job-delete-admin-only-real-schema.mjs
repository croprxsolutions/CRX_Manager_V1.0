#!/usr/bin/env node
/**
 * Real-schema proof for 20270210110000_completed_job_delete_admin_only (#2196).
 * Contract: docs/plans/2026-11-22-completed-job-delete-admin-only-CONTRACT.md.
 * Container setup, replay and seed copied from prove-edit-jobs-real-schema.mjs. Then:
 *   1. BEFORE: a sales rep (and the assigned applicator) soft-delete a completed job by a direct update under RLS.
 *   2. The candidate applies; a second apply is refused by its preflight.
 *   3. AFTER: rep and applicator direct deletes of a completed job are refused; an admin's goes through;
 *      edit_jobs deletes as before (admin: completed deleted; rep: completed skipped); a rep still deletes a
 *      scheduled job and still edits a completed job's comment; every listed job chain passes before and after.
 *
 * Run: node scripts/smoke/prove-completed-job-delete-admin-only-real-schema.mjs   (needs Docker)
 * Prints COMPLETED_JOB_DELETE_ADMIN_ONLY_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a fresh, network-less container this run builds (no reuse: seed() rewrites reference data).
const NAME = `crx-cjda-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270210110000_completed_job_delete_admin_only.sql');
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
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate changes or relies on.
const TOUCHED = /(_enforce_billed_job_immutability|enforce_billed_job_immutability|edit_jobs|jobs_update|FUNCTION (public\.)?(is_admin|_is_admin_override)\()/i;
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


const ADMIN = 'e1100000-0000-4000-8000-0000000000a1';
const REP = 'e1100000-0000-4000-8000-0000000000b2';
const REP2 = 'e1100000-0000-4000-8000-0000000000c3';
const APPL = 'e1100000-0000-4000-8000-0000000000d4';
// Existing chains that write jobs; each must pass before and after the candidate.
// transfer-invoice-to-job and field-functions-require-field-access were rewritten to current behaviour in #2168.
const REGRESSION = ('smoke-edit-jobs smoke-booking-live-job-guard smoke-booking-guard-rep-and-delete smoke-field-invoice-loop '
  + 'smoke-ops-replay-binding-batch4e smoke-get-jobs-billed-customers smoke-offline-action-receipts '
  + 'smoke-billed-job-immutability smoke-transfer_job_invoice_column_fixes smoke-transfer_job_invoice_machine_fee '
  + 'smoke-dispatch-job-locations smoke-undispatch-job-locations smoke-job_from_quote_activity_feed_fix '
  + 'smoke-delivery-job-replay-binding-batch3a smoke-transfer-invoice-to-job smoke-field-functions-require-field-access')
  .split(' ').map((s) => `${s}.sql`);

function seed() {
  // Live auth has these; deactivating a profile (probe P5) bans the user and ends their sessions.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ejob-admin@example.invalid', '{"full_name":"[PROVER] EJ Admin","role":"admin"}'::jsonb),
    ('${REP}', 'ejob-rep@example.invalid', '{"full_name":"[PROVER] EJ Rep","role":"sales_rep"}'::jsonb),
    ('${REP2}', 'ejob-rep2@example.invalid', '{"full_name":"[PROVER] EJ Rep 2","role":"sales_rep"}'::jsonb),
    ('${APPL}', 'ejob-appl@example.invalid', '{"full_name":"[PROVER] EJ Applicator","role":"applicator"}'::jsonb),
    ('e1100000-0000-4000-8000-0000000000a5', 'ejob-admin2@example.invalid', '{"full_name":"[PROVER] EJ Admin 2","role":"admin"}'::jsonb),
    ('e1100000-0000-4000-8000-0000000000d6', 'ejob-appl2@example.invalid', '{"full_name":"[PROVER] EJ Applicator 2","role":"applicator"}'::jsonb),
    -- the invented profiles smoke-ops-replay-binding-batch4e expects
    ('4c4d0000-0000-4000-8000-0000000000a1', 'ejob-inv-a1@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('4c4d0000-0000-4000-8000-0000000000a2', 'ejob-inv-a2@example.invalid', '{"full_name":"[PROVER] Admin B","role":"admin"}'::jsonb),
    ('4c4d0000-0000-4000-8000-0000000000b1', 'ejob-inv-b1@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('4c4d0000-0000-4000-8000-0000000000c1', 'ejob-inv-c1@example.invalid', '{"full_name":"[PROVER] Applicator","role":"applicator"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id IN ('${REP}', '${REP2}');
    UPDATE public.profiles SET role = 'applicator', is_active = true WHERE id = '${APPL}';
    UPDATE public.profiles SET role = 'admin', is_active = true
     WHERE id IN ('e1100000-0000-4000-8000-0000000000a5', '4c4d0000-0000-4000-8000-0000000000a1', '4c4d0000-0000-4000-8000-0000000000a2');
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '4c4d0000-0000-4000-8000-0000000000b1';
    UPDATE public.profiles SET role = 'applicator', is_active = true
     WHERE id IN ('e1100000-0000-4000-8000-0000000000d6', '4c4d0000-0000-4000-8000-0000000000c1');
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};`);
}
function chainOutcome(file) {
  stageText(file, lf(path.join(ROOT, 'scripts', 'smoke', file)));
  const r = apply(file);
  const line = r.output.split(/\r?\n/).find((l) => /ERROR:/.test(l)) ?? `(no error, status ${r.status})`;
  return { outcome: line.replace(/^.*?ERROR:\s*/, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>').replace(/\b[0-9a-f]{8}\b/g, '<sfx>'), output: r.output };
}

const ADMIN2 = 'e1100000-0000-4000-8000-0000000000a5';
const job = (n) => `(SELECT id FROM jobs WHERE job_number = 'J-PRV-CJ-${n}')`;
const del = (n) => `UPDATE jobs SET deleted_at = now() WHERE id = ${job(n)};\nRESET ROLE;\nSELECT (deleted_at IS NOT NULL)::text FROM jobs WHERE id = ${job(n)};`;
const REFUSED = /A completed job is billable work and only an admin can delete it \(job J-PRV-CJ-/;
const editJobs = (ids, uid, key) => `SELECT public.edit_jobs(ARRAY[${ids.map(job).join(', ')}]::uuid[], NULL, 'delete', '${uid}', '${key}')::text;`;

async function main() {
  buildContainer();
  seed();
  // Fixture jobs, committed (disposable container), inserted with triggers off so each starts in its status.
  raw(`INSERT INTO customers (farm_name) VALUES ('[PROVER] CJ Farm');
    INSERT INTO jobs (job_number, customer_id, job_date, status, applicator_id, deleted_at)
    SELECT 'J-PRV-CJ-' || n, (SELECT id FROM customers WHERE farm_name = '[PROVER] CJ Farm'), CURRENT_DATE, s, '${APPL}', d
      FROM (VALUES ('DONE', 'completed', NULL::timestamptz), ('DONE2', 'completed', NULL), ('SCHED', 'scheduled', NULL),
                   ('RUN', 'in_progress', NULL), ('RUNDEL', 'in_progress', now())) v(n, s, d);`);

  // 1. BEFORE: the hole is real.
  assert.equal(okProbe(del('DONE'), REP), 'true', 'before the candidate a rep can soft-delete a completed job directly');
  assert.equal(okProbe(`UPDATE jobs SET status = 'completed' WHERE id = ${job('RUNDEL')} RETURNING status;`, REP), 'completed',
    'before the candidate a rep can complete a deleted job directly');
  console.log('[case] BEFORE: a sales rep soft-deletes a completed job, and completes a deleted job, by direct updates under RLS');
  const before = Object.fromEntries(REGRESSION.map((f) => [f, chainOutcome(f).outcome]));
  const notPassing = REGRESSION.filter((f) => !/^SMOKE_PASS_ROLLBACK/.test(before[f]));
  assert.deepEqual(notPassing.map((f) => `${f}: ${before[f]}`), [], 'regression chains must pass before the candidate');

  // 2. Apply, then a second apply stops at the preflight.
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  ledger(path.basename(CANDIDATE, '.sql'));
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.output, /PREFLIGHT_BILLED_JOB_GUARD_DRIFT/);
  console.log('[case] the candidate applies; a second apply stops at its preflight');

  // 3. AFTER (rolled-back probes as the signed-in user under RLS).
  // Override never set in this session, so _is_admin_override() is NULL (Astra #3).
  assert.equal(scalar("SELECT coalesce(public._is_admin_override()::text, 'null');"), 'null');
  refusedProbe(del('DONE'), REFUSED, REP);
  refusedProbe(`SELECT set_config('app.admin_override', 'false', true);\n${del('DONE')}`, REFUSED, REP);
  console.log('[case] AFTER: a rep\'s direct delete of a completed job is refused (override unset, and override false)');
  refusedProbe(`UPDATE jobs SET status = 'completed', deleted_at = now() WHERE id = ${job('RUN')};`, REFUSED, REP);
  refusedProbe(`UPDATE jobs SET status = 'completed' WHERE id = ${job('RUNDEL')};`, REFUSED, REP);
  // Luna r2: nor move it on to invoiced (allowed directly today) while deleting it.
  refusedProbe(`UPDATE jobs SET status = 'invoiced', deleted_at = now() WHERE id = ${job('DONE')};`, REFUSED, REP);
  console.log('[case] AFTER: a rep cannot complete-and-delete in one write, complete a deleted job, or invoice-and-delete a completed one');
  assert.equal(okProbe(`WITH u AS (UPDATE jobs SET deleted_at = now() WHERE id = ${job('DONE')} RETURNING 1) SELECT count(*) FROM u;`, APPL), '0',
    'the assigned applicator has no direct UPDATE (RLS filters the row)');
  console.log('[case] AFTER: the assigned applicator\'s direct update touches no row (jobs_update is admin/rep only)');
  assert.equal(okProbe(del('DONE'), ADMIN), 'true', 'an admin deletes a completed job directly');
  assert.equal(okProbe(`SELECT set_config('app.admin_override', 'true', true);\n${del('DONE')}`, REP), 'true', 'the sanctioned override hatch passes');
  console.log('[case] AFTER: an admin\'s direct delete goes through; the definer-flow override hatch passes as before');
  raw(`UPDATE profiles SET is_active = false WHERE id = '${ADMIN2}';`);
  assert.equal(okProbe(del('DONE'), ADMIN2), 'false', 'an inactive admin must not delete a completed job');
  console.log('[case] AFTER: an inactive admin deletes nothing (jobs_update filters the row; is_admin() is false too)');
  const adminRpc = okProbe(`${editJobs(['DONE'], ADMIN, 'cj-admin-del')}\nRESET ROLE;\nSELECT (deleted_at IS NOT NULL)::text FROM jobs WHERE id = ${job('DONE')};`, ADMIN);
  assert.equal(adminRpc, 'true', 'edit_jobs deletes a completed job for an admin');
  const repRpc = okProbe(`${editJobs(['SCHED', 'DONE2'], REP, 'cj-rep-del')}`, REP);
  const res = JSON.parse(repRpc);
  assert.equal(res.deleted.length, 1);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].reason, 'status');
  assert.equal(res.skipped[0].status, 'completed');
  console.log('[case] AFTER: edit_jobs as before: admin deletes the completed job; a rep deletes the scheduled one and the completed one is skipped (status)');
  assert.equal(okProbe(del('SCHED'), REP), 'true', 'a rep still deletes a scheduled job directly');
  assert.equal(okProbe(`UPDATE jobs SET loader_comment = 'x' WHERE id = ${job('DONE')} RETURNING loader_comment;`, REP), 'x', 'a rep still edits a completed job');
  assert.equal(okProbe(`UPDATE jobs SET deleted_at = NULL WHERE id = ${job('RUNDEL')} RETURNING (deleted_at IS NULL)::text;`, REP), 'true', 'restoring is untouched');
  console.log('[case] AFTER: no wider change: a rep deletes a scheduled job, edits a completed job\'s comment, restores a deleted job');

  for (const f of REGRESSION) {
    const now = chainOutcome(f).outcome;
    assert.match(now, /^SMOKE_PASS_ROLLBACK/, `${f} no longer passes after the candidate: ${now}`);
  }
  console.log(`[case] AFTER: ${REGRESSION.length} existing job chains pass before and after`);
  console.log('COMPLETED_JOB_DELETE_ADMIN_ONLY_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
