#!/usr/bin/env node
/**
 * Real-schema proof for 20270125183000_booking_live_job_guard (#1959; contract
 * docs/plans/2026-11-18-booking-live-job-guard-CONTRACT.md). Container setup and replay copied from
 * prove-save-quote-section-ids-real-schema.mjs. Then:
 *   1. BEFORE: the bypass is real: a sales rep's direct decline of a booking with a live job goes
 *      through. Records how each existing chain ends; the new chain fails at its first case (the
 *      convert, nightly-expiry and job-side cases are proven only in the AFTER run).
 *   2. The candidate applies; a second apply is refused by its preflight.
 *   3. AFTER: smoke-booking-live-job-guard.sql passes; a sales rep's direct decline and cancel (the
 *      screen's path, under RLS) are refused BOOKING_HAS_JOB; a decline and a job insert serialize in
 *      both orders; every existing chain ends exactly as before.
 *
 * Run: node scripts/smoke/prove-booking-live-job-guard-real-schema.mjs   (needs Docker)
 * Prints BOOKING_LIVE_JOB_GUARD_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Iterating: CRX_PROVER_REUSE=<kept container> CRX_PROVER_DB=<a copy of its replayed database> skips the replay.
const REUSE = process.env.CRX_PROVER_REUSE;
const NAME = REUSE || `crx-bljg-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270125183000_booking_live_job_guard.sql');
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
const TOUCHED = /(auto_expire_quotes|_enforce_booking_live_job_rules|quotes_booking_live_job_rules|_enforce_job_live_on_open_booking|jobs_live_on_open_booking|_enforce_section_with_live_job_stays|quote_sections_live_job_stays)/i;
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


const ADMIN = 'b1100000-0000-4000-8000-0000000000a1';
const REP = 'b1100000-0000-4000-8000-0000000000b2';
const CHAIN = 'smoke-booking-live-job-guard.sql';
// Existing chains that write jobs or quote statuses, convert or auto-expire; each must end the same way before
// and after the candidate (some stop at their own setup on this database, the same way both times).
const REGRESSION = [
  'smoke-save-quote-drawn-guard.sql', 'smoke-quote-version-restore-trust.sql',
  ...('smoke-auto-expire-draw-skip smoke-backfill-refuse-split-billing smoke-billed-job-immutability '
    + 'smoke-blend-invoice-approval-binding smoke-blend-invoice-binding-lows smoke-blend-ticket-pricing-guards '
    + 'smoke-convert-sent-quote-in-one-step smoke-delivery-job-replay-binding-batch3a smoke-dispatch-job-locations '
    + 'smoke-draw-ledger-reversal smoke-field-functions-require-field-access smoke-field-invoice-loop '
    + 'smoke-field-tables-follow-field-access smoke-forbid-restore-cancelled-order smoke-get-jobs-billed-customers '
    + 'smoke-jarf-field-membership-rls smoke-job_from_quote_activity_feed_fix smoke-money-replay-binding-batch4a '
    + 'smoke-offline-action-receipts smoke-ops-replay-binding-batch4e smoke-order-draw-lock smoke-per-line-split-billing '
    + 'smoke-quote-price-trail-and-expiry smoke-quote-sent-price-lock smoke-quote-sent-requires-version '
    + 'smoke-quote-version-write-boundary smoke-recipe-pricing-bundle smoke-revert-quote-escape-hatch '
    + 'smoke-rollover-remainder smoke-save-quote-customer-row-version smoke-save-quote-repeated-product-line-ids '
    + 'smoke-save-quote-section-ids smoke-transfer-invoice-to-job smoke-transfer_job_invoice_column_fixes '
    + 'smoke-transfer_job_invoice_machine_fee smoke-undispatch-job-locations').split(' ').map((s) => `${s}.sql`),
];

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'bljg-admin@example.invalid', '{"full_name":"[PROVER] Live Job Admin","role":"admin"}'::jsonb),
    ('${REP}', 'bljg-rep@example.invalid', '{"full_name":"[PROVER] Live Job Rep","role":"sales_rep"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};`);
}

function chainOutcome(file) {
  stageText(file, lf(path.join(ROOT, 'scripts', 'smoke', file)));
  const r = apply(file);
  const line = r.output.split(/\r?\n/).find((l) => /ERROR:/.test(l)) ?? `(no error, status ${r.status})`;
  return line.replace(/^.*?ERROR:\s*/, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>').replace(/\b[0-9a-f]{8}\b/g, '<sfx>');
}

// A sent booking the rep created, with a section and (except RACE) a scheduled job on it. Committed: the
// database is a disposable prover container.
const FIXTURE = (tag) => `DO $fx$
DECLARE v_c uuid; v_q uuid; v_s uuid;
BEGIN
  INSERT INTO customers (farm_name) VALUES ('[PROVER] ${tag} Farm') RETURNING id INTO v_c;
  INSERT INTO quotes (quote_number, customer_id, status, tier, created_by) VALUES ('[PROVER] ${tag}', v_c, 'draft', 1, '${REP}') RETURNING id INTO v_q;
  INSERT INTO quote_sections (quote_id, section_name, sort_order) VALUES (v_q, 'North', 0) RETURNING id INTO v_s;
  INSERT INTO quote_versions (quote_id, sent_by, snapshot_data) VALUES (v_q, '${ADMIN}', '{}'::jsonb);
  UPDATE quotes SET status = 'sent' WHERE id = v_q;
  ${tag.startsWith('RACE') ? '' :`INSERT INTO jobs (job_number, customer_id, job_date, quote_id, quote_section_id)
    VALUES ('J-PRV-${tag}', v_c, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_q, v_s);`}
END $fx$;`;
const quoteId = (tag) => scalar(`SELECT id FROM quotes WHERE quote_number = '[PROVER] ${tag}';`);
const REP_UPDATE = (tag, status) => `UPDATE quotes SET status = '${status}', updated_at = now() WHERE quote_number = '[PROVER] ${tag}' RETURNING status;`;

// Two sessions: one schedules a job the way _create_job_from_quote_section does (quote row FOR UPDATE, then the
// insert) and holds its transaction open; the other declines meanwhile. The decline must wait, then be refused.
function race() {
  const q = quoteId('RACE');
  docker(['exec', '-d', NAME, 'psql', '-U', 'postgres', '-d', DB, '-X', '-q', '-c',
    `BEGIN; SELECT 1 FROM quotes WHERE id = '${q}' FOR UPDATE;
     INSERT INTO jobs (job_number, customer_id, job_date, quote_id) SELECT 'J-PRV-RACE', customer_id, CURRENT_DATE + 7, id FROM quotes WHERE id = '${q}';
     SELECT pg_sleep(4); COMMIT;`]);
  wait(1500);
  assert.equal(scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND pid <> pg_backend_pid();"), '1',
    'the job-scheduling session is not holding the quote');
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `UPDATE quotes SET status = 'declined' WHERE id = '${q}';` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`,
    after: scalar(`SELECT status || '/' || (SELECT count(*) FROM jobs WHERE quote_id = '${q}') FROM quotes WHERE id = '${q}';`) };
}

// The reverse order: a decline holds the booking row uncommitted; a direct job insert meanwhile must wait, then
// be refused BOOKING_CLOSED once the decline commits.
function raceReverse() {
  const q = quoteId('RACE2');
  docker(['exec', '-d', NAME, 'psql', '-U', 'postgres', '-d', DB, '-X', '-q', '-c',
    `BEGIN; UPDATE quotes SET status = 'declined' WHERE id = '${q}'; SELECT pg_sleep(4); COMMIT;`]);
  wait(1500);
  assert.equal(scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND pid <> pg_backend_pid();"), '1',
    'the declining session is not holding the booking');
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true,
    input: `INSERT INTO jobs (job_number, customer_id, job_date, quote_id) SELECT 'J-PRV-RACE2', customer_id, CURRENT_DATE + 7, id FROM quotes WHERE id = '${q}';` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`,
    after: scalar(`SELECT status || '/' || (SELECT count(*) FROM jobs WHERE quote_id = '${q}') FROM quotes WHERE id = '${q}';`) };
}

// A section moving to the closed RACE2 booking holds its row uncommitted; a job attached to that section meanwhile
// (having read its old, open booking) must wait, then be refused once the move commits (Luna HIGH, #1959).
function raceSection() {
  const s = scalar(`SELECT id FROM quote_sections WHERE quote_id = '${quoteId('RACE')}';`);
  docker(['exec', '-d', NAME, 'psql', '-U', 'postgres', '-d', DB, '-X', '-q', '-c',
    `BEGIN; UPDATE quote_sections SET quote_id = '${quoteId('RACE2')}' WHERE id = '${s}'; SELECT pg_sleep(4); COMMIT;`]);
  wait(1500);
  assert.equal(scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND pid <> pg_backend_pid();"), '1',
    'the section-moving session is not holding the section');
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true,
    input: `INSERT INTO jobs (job_number, customer_id, job_date, quote_section_id) SELECT 'J-PRV-RACE3', c.id, CURRENT_DATE + 7, '${s}' FROM customers c WHERE c.farm_name = '[PROVER] RACE Farm';` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`,
    after: scalar(`SELECT (SELECT quote_number FROM quotes WHERE id = qs.quote_id) || '/' || (SELECT count(*) FROM jobs WHERE quote_section_id = qs.id) FROM quote_sections qs WHERE qs.id = '${s}';`) };
}

// A decline of RACE3 holds its row uncommitted; meanwhile RACE4's section, which a job linked by section only comes
// from, is deleted and re-created under the same id on RACE3. It must wait, then be refused (Luna HIGH, #1959).
function raceReinsert() {
  const target = quoteId('RACE3');
  const s = scalar(`SELECT id FROM quote_sections WHERE quote_id = '${quoteId('RACE4')}';`);
  psql(`INSERT INTO jobs (job_number, customer_id, job_date, quote_section_id) SELECT 'J-PRV-RACE4', c.id, CURRENT_DATE + 7, '${s}' FROM customers c WHERE c.farm_name = '[PROVER] RACE4 Farm';`);
  docker(['exec', '-d', NAME, 'psql', '-U', 'postgres', '-d', DB, '-X', '-q', '-c',
    `BEGIN; UPDATE quotes SET status = 'declined' WHERE id = '${target}'; SELECT pg_sleep(4); COMMIT;`]);
  wait(1500);
  assert.equal(scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND pid <> pg_backend_pid();"), '1',
    'the declining session is not holding RACE3');
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true,
    input: `BEGIN; CREATE TEMP TABLE prv_s AS SELECT * FROM quote_sections WHERE id = '${s}'; DELETE FROM quote_sections WHERE id = '${s}'; UPDATE prv_s SET quote_id = '${target}'; INSERT INTO quote_sections SELECT * FROM prv_s; COMMIT;` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`,
    after: scalar(`SELECT (SELECT status FROM quotes WHERE id = '${target}') || '/' || (SELECT quote_number FROM quotes q JOIN quote_sections qs ON qs.quote_id = q.id WHERE qs.id = '${s}');`) };
}

async function main() {
  if (REUSE) {
    // Reuse writes seed rows and replaces unit_conversions: only on a kept, network-less prover container, on a copied database.
    assert.match(REUSE, /^crx-[a-z0-9-]+$/, 'CRX_PROVER_REUSE must name a kept prover container (crx-...)');
    assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', REUSE]).stdout.trim(), 'none', 'CRX_PROVER_REUSE must be a network-less prover container');
    assert.ok(process.env.CRX_PROVER_DB && DB !== 'postgres', 'CRX_PROVER_REUSE needs CRX_PROVER_DB naming a copy, not postgres');
  } else buildContainer();
  seed();
  for (const tag of ['REP', 'RACE', 'RACE2', 'RACE3', 'RACE4']) psql(FIXTURE(tag));

  // 1. BEFORE: the rep's direct decline of a booking with a live job goes through.
  assert.equal(okProbe(REP_UPDATE('REP', 'declined'), REP), 'declined', 'before the candidate the rep decline should go through');
  console.log('[case] BEFORE: a sales rep declines a booking with a scheduled job by a direct update (the bypass)');
  const before = Object.fromEntries(REGRESSION.map((f) => [f, chainOutcome(f)]));
  for (const [f, o] of Object.entries(before)) console.log(`[before] ${f}: ${o.slice(0, 160)}`);
  const chainBefore = chainOutcome(CHAIN);
  assert.doesNotMatch(chainBefore, /SMOKE_PASS_ROLLBACK/, 'the new chain must fail before the candidate');
  console.log(`[before] ${CHAIN}: ${chainBefore.slice(0, 160)}`);

  // 2. Apply, then a second apply is refused.
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /PREFLIGHT_AUTO_EXPIRE_DRIFT/);
  console.log('[case] the candidate applies; a second apply stops at its preflight');

  // 3. AFTER
  const chain = chainOutcome(CHAIN);
  assert.match(chain, /^SMOKE_PASS_ROLLBACK/, chain);
  console.log(`[case] AFTER: ${CHAIN}: ${chain}`);
  refusedProbe(REP_UPDATE('REP', 'declined'), /BOOKING_HAS_JOB: spray job J-PRV-REP was made from this booking, so the booking cannot be marked declined\. Cancel the job first\./, REP);
  refusedProbe(REP_UPDATE('REP', 'cancelled'), /BOOKING_HAS_JOB: spray job J-PRV-REP .* cannot be marked cancelled/, REP);
  console.log("[case] AFTER: the rep's direct decline and cancel (the booking screen's path, under RLS) are refused BOOKING_HAS_JOB");
  const raced = race();
  assert.notEqual(raced.status, 0, `the decline racing a job schedule went through: ${raced.output}`);
  assert.match(raced.output, /BOOKING_HAS_JOB: spray job J-PRV-RACE/);
  assert.equal(raced.after, 'sent/1');
  console.log('[case] AFTER: a decline racing a job being scheduled waits for it, then is refused; the booking stays sent with its job');
  const reversed = raceReverse();
  assert.notEqual(reversed.status, 0, `the job insert racing a decline went through: ${reversed.output}`);
  assert.match(reversed.output, /BOOKING_CLOSED: booking \[PROVER\] RACE2 is declined/);
  assert.equal(reversed.after, 'declined/0');
  console.log('[case] AFTER: a job insert racing a decline waits for it, then is refused BOOKING_CLOSED; the booking is declined with no job');
  const moved = raceSection();
  assert.notEqual(moved.status, 0, `the job attach racing a section move went through: ${moved.output}`);
  assert.match(moved.output, /BOOKING_CLOSED: the booking section changed while this spray job was being scheduled/);
  assert.equal(moved.after, '[PROVER] RACE2/0');
  console.log('[case] AFTER: a job attach racing a section move to a closed booking waits for it, then is refused; no job on the section');
  const recreated = raceReinsert();
  assert.notEqual(recreated.status, 0, `re-creating a section with a live job on a booking being declined went through: ${recreated.output}`);
  assert.match(recreated.output, /BOOKING_HAS_JOB: spray job J-PRV-RACE4 was made from this section, so the section cannot move to another booking/);
  assert.equal(recreated.after, 'declined/[PROVER] RACE4');
  console.log('[case] AFTER: re-creating a section with a live job on a booking being declined waits for it, then is refused; the section stays put');
  for (const f of REGRESSION) {
    const after = chainOutcome(f);
    assert.equal(after, before[f], `${f} ends differently after the candidate`);
  }
  console.log(`[case] AFTER: ${REGRESSION.length} existing quote chains end exactly as before`);
  console.log('BOOKING_LIVE_JOB_GUARD_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }