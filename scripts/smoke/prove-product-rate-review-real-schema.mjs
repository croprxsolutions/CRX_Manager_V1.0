#!/usr/bin/env node
/**
 * Real-schema proof for 20270104110000_product_rate_review (RT-3; contract
 * docs/plans/2026-11-11-product-RT3-rate-review-CONTRACT.md, proof cases 1 to 13).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, seeds invented parents and draft rates through
 * RT-1's own RPCs, applies the candidate (and a second run, which refuses), then checks each case through the
 * real RPCs as a signed-in admin, a signed-in sales rep and anon.
 *
 * Run: node scripts/smoke/prove-product-rate-review-real-schema.mjs   (needs Docker)
 * Prints PRODUCT_RATE_REVIEW_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-rt3-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270104110000_product_rate_review.sql');
const FOLLOW_UPS = [];
// Later files that only READ what this proof covers and redefine none of it.
const LATER_READ_ONLY = new Set();
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
  // DATA-11 rewrites live rows only (every product gets one preferred link); the proof seeds that state.
  '20261105170000_data11_preferred_vendor_links.sql',
  // KI-01 part C and its KI-73 follow-up need live's storage.objects policies, which this database does not have
  // (same approach as prove-document-restore-photo-uploader-real-schema.mjs); neither touches units or products.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(product_rate|_product_parent_require_admin|_product_parent_replay|product_parent_rate_outcomes|rate_review)/i;
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

// Live unit_conversions, read-only 2026-11-10 (RT-1's preflight pins them).
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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
const id = (n) => `a3000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = id('a1'), REP = id('a2');
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);

function txIn(uid, sql) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  return `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n`;
}
function as(uid, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: txIn(uid, sql) });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
const js = (uid, sql) => JSON.parse(ok(uid, sql));
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}\n${r.output}`);
  assert.match(r.output, pattern);
  return r.output;
}
const n = (sql) => Number(scalar(sql));
// postgres itself (triggers on): what a direct table write does.
const pg = (sql) => { const r = psql(sql, { allowFailure: true }); return { status: r.status, output: `${r.stdout}\n${r.stderr}` }; };

const L = Array.from({ length: 11 }, (_, i) => id(`b${i + 1}`)); // liquid parents L[0]..L[8]
const DRY = id('c1');
const EPA = '100-1';

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'rt3-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'rt3-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  const parent = (pid, name, form, epa = null) => `('${pid}', '[PROVER] ${name}', '${form}', ${q(epa)}, true, '${ADMIN}', '${ADMIN}')`;
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.product_parents (id, name, product_form, generic_epa_registration, is_active, created_by, updated_by) VALUES
      ${L.map((p, i) => parent(p, `Liquid ${i + 1}`, 'liquid', i === 4 ? EPA : null)).join(', ')}, ${parent(DRY, 'Dry 1', 'dry')};`);
  console.log('[prover] seeded an admin, a sales rep, 11 liquid parents (Liquid 5 carries EPA 100-1) and 1 dry parent');
}

let seedSeq = 0;
// A draft saved through RT-1's own writer, as an admin.
function save(pid, { basis = 'per_acre', source = 'house_standard', low = null, rec = null, high = null, unit = 'pt', def = false, reason = null }) {
  const num = (v) => (v === null ? 'NULL' : String(v));
  return js(ADMIN, `SELECT public.save_draft_product_rate('${pid}', NULL, NULL, ${q(basis)}, ${q(source)}, ${num(low)}, ${num(rec)}, ${num(high)}, ${q(unit)}, ${def}, ${q(reason)}, 'rt3-seed-${++seedSeq}');`).rate_id;
}
const dl = () => js(ADMIN, 'SELECT public.get_rate_review_workbook();');
const par = (pid) => dl().parents.find((p) => p.parent_id === pid);
const rateOf = (pid, rid) => par(pid).rates.find((r) => r.rate_id === rid);
// A downloaded rate row turned back into an upload row (the screen does the same).
const up = (pid, r, extra = {}) => ({ rate_id: r.rate_id, parent_id: pid, expected_row_version: r.row_version, basis: r.basis,
  source: r.source, low: r.low, recommended: r.recommended, high: r.high, unit: r.unit, is_quoting_default: r.is_quoting_default,
  over_label_reason: r.over_label_reason, ...extra });
const upId = (pid, rid, extra) => up(pid, rateOf(pid, rid), extra);
const outRow = (pid, outcome, note = null, p = par(pid)) => ({ parent_id: pid, expected_outcome_version: p.outcome_version, outcome, note });
let keySeq = 0;
const commit = (rates, outs = [], key = `rt3-k-${++keySeq}`) => `SELECT public.commit_rate_review(${J(rates)}, ${J(outs)}, ${q(key)});`;
const preview = (rates, outs = []) => `SELECT public.preview_rate_review(${J(rates)}, ${J(outs)});`;
const outcomeOf = (pid) => scalar(`SELECT COALESCE((SELECT outcome FROM public.product_parent_rate_outcomes WHERE parent_id = '${pid}'), '<undecided>');`);
const events = (type, pid) => n(`SELECT count(*) FROM public.product_rate_draft_events WHERE event_type = '${type}' AND parent_id = '${pid}';`);
const statusOf = (rid) => scalar(`SELECT status FROM public.product_rates WHERE id = '${rid}';`);
const writes = () => scalar(`SELECT (SELECT count(*) FROM public.product_rate_draft_events) || '/' || (SELECT count(*) FROM public.product_rates)
  || '/' || (SELECT COALESCE(sum(row_version), 0) FROM public.product_rates) || '/' || (SELECT COALESCE(sum(outcome_version), 0) FROM public.product_parent_rate_outcomes)
  || '/' || (SELECT count(*) FROM public.idempotency_keys);`);
const CLEARED_BY_CHANGE = "reason = 'the parent''s rates changed'";

const R = {};
function seedRates() {
  R.a1 = save(L[0], { rec: 1, def: true }); // Liquid 1: house default
  R.b1 = save(L[0], { source: 'label', rec: 1.5 }); // Liquid 1: label row
  R.a3 = save(L[2], { rec: 1, def: true }); // Liquid 3: default + a label row
  R.b3 = save(L[2], { source: 'label', low: 1, high: 2 });
  R.b4 = save(L[3], { source: 'label', rec: 2 }); // Liquid 4: no default at all
  R.a5 = save(L[4], { rec: 2 }); // Liquid 5: 2 pt/acre, saved before the label max is known
  R.a6 = save(L[5], { rec: 1 }); // Liquid 6: its unit stops fitting below
  R.a9 = save(L[8], { rec: 1, def: true });
  R.b9 = save(L[8], { source: 'label', rec: 1 });
  // A derived house row whose basis is in doubt (only the derivation writes these).
  R.u2 = id('d2');
  raw(`INSERT INTO public.product_rates (id, parent_id, basis, source, recommended, unit, origin, basis_confirmed, source_text, created_by, updated_by)
    VALUES ('${R.u2}', '${L[1]}', 'per_acre', 'house_standard', 1, 'pt', 'derived_house', false, '1 pt per 100 gal?', '${ADMIN}', '${ADMIN}');`);
  // Liquid 5's label maximum becomes known: 24 fl oz/acre, so 2 pt (32 fl oz) is above it.
  raw(`INSERT INTO public.epa_registrations (epa_registration, max_label_rate, max_label_rate_unit, created_by, updated_by)
      VALUES ('${EPA}', 24, 'oz/acre', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint) VALUES ('${ADMIN}', 'unknown', 'rt3-proof');`);
  // Liquid 6 becomes a dry product (a fixture only): its pt row no longer fits.
  raw(`UPDATE public.product_parents SET product_form = 'dry' WHERE id = '${L[5]}';`);
  // Two derivations' notes for Liquid 1: an old batch of two, a new batch of one.
  const r = pg(`INSERT INTO public.product_rate_draft_events (parent_id, event_type, note_code, after_values, changed_by, changed_at) VALUES
    ('${L[0]}', 'derive_note', 'no_rate', '{"batch":"old","n":1}', '${ADMIN}', now() - interval '1 day'),
    ('${L[0]}', 'derive_note', 'unit_unknown', '{"batch":"old","n":2}', '${ADMIN}', now() - interval '1 day'),
    ('${L[0]}', 'derive_note', 'basis_suspect', '{"batch":"new","n":3}', '${ADMIN}', now());`);
  assert.equal(r.status, 0, r.output);
}

function approvalCases() {
  // 1. Approve a draft at its version.
  const a1 = rateOf(L[0], R.a1);
  assert.equal(a1.status, 'draft'); assert.equal(a1.row_version, 1);
  const rec = js(ADMIN, commit([up(L[0], a1, { decision: 'approve' })]));
  assert.equal(rec.rates_changed, 1); assert.deepEqual(rec.rates[0].actions, ['approve']);
  assert.equal(scalar(`SELECT status || '|' || approved_by || '|' || (approved_at IS NOT NULL) || '|' || row_version FROM public.product_rates WHERE id = '${R.a1}';`),
    `approved|${ADMIN}|true|2`);
  assert.equal(n(`SELECT count(*) FROM public.product_rate_draft_events WHERE rate_id = '${R.a1}' AND event_type = 'approved' AND changed_by = '${ADMIN}';`), 1);
  const after = rateOf(L[0], R.a1);
  assert.equal(after.approved_by, '[PROVER] Admin'); assert.ok(after.approved_at);
  console.log('[case] 1 an admin approves a draft at its version: approved, approver and time recorded, an "approved" event written');

  // 2. An old version is stale and saves nothing.
  const old = up(L[0], rateOf(L[0], R.b1), { expected_row_version: 0, decision: 'approve' });
  const w0 = writes();
  assert.equal(js(ADMIN, preview([old])).rates[0].status, 'stale');
  refused(ADMIN, commit([old]), /RATE_REVIEW_REFUSED: nothing was saved\. \[PROVER\] Liquid 1: changed by someone else/);
  assert.equal(writes(), w0); assert.equal(statusOf(R.b1), 'draft');
  console.log('[case] 2 an old version is refused as stale by name and nothing is saved');

  // 3. Basis unconfirmed, above the label max with no reason, a unit that no longer fits: each refused with its reason.
  const cases3 = [[L[1], R.u2, /PRODUCT_RATE_BASIS_UNCONFIRMED/], [L[4], R.a5, /PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED: .*100-1/],
    [L[5], R.a6, /PRODUCT_RATE_UNIT_NOT_FOR_BASIS: pt is not allowed for per_acre on a dry product/]];
  for (const [pid, rid, pattern] of cases3) {
    const res = js(ADMIN, preview([upId(pid, rid, { decision: 'approve' })])).rates[0];
    assert.equal(res.status, 'invalid', JSON.stringify(res)); assert.match(res.problem, pattern);
    refused(ADMIN, commit([upId(pid, rid, { decision: 'approve' })]), pattern);
    assert.equal(statusOf(rid), 'draft');
  }
  assert.equal(rateOf(L[4], R.a5).label_check.status, 'above', 'the download shows the row as above the label');
  // "Label maximum not checked" (no registration) may be approved.
  assert.equal(rateOf(L[8], R.a9).label_check.status, 'not_checked');
  js(ADMIN, commit([upId(L[8], R.a9, { decision: 'approve' }), upId(L[8], R.b9, { decision: 'approve' })]));
  assert.equal(statusOf(R.a9), 'approved');
  // Fixing the above row with a reason, in the same upload as its approval, works (save runs before approve).
  js(ADMIN, commit([upId(L[4], R.a5, { over_label_reason: 'Mason: label allows 32 oz on heavy ground', decision: 'approve' })]));
  assert.equal(statusOf(R.a5), 'approved');
  console.log('[case] 3 basis unconfirmed, above-label with no reason and a unit that no longer fits are each refused by name; "not checked" approves; a reason saved in the same upload lets it approve');
}

function reopenCases() {
  // 4. An approved row cannot be edited without reopen; reopen + reason makes it a draft with the new values.
  const res = js(ADMIN, preview([upId(L[0], R.a1, { recommended: '1.25' })])).rates[0];
  assert.equal(res.status, 'invalid'); assert.match(res.problem, /PRODUCT_RATE_APPROVED/);
  assert.match(js(ADMIN, preview([upId(L[0], R.a1, { recommended: '1.25', decision: 'reopen' })])).rates[0].problem, /PRODUCT_RATE_REASON_REQUIRED/);
  assert.match(js(ADMIN, preview([upId(L[0], R.a1, { decision: 'delete', reason: 'x' })])).rates[0].problem, /PRODUCT_RATE_APPROVED/);
  js(ADMIN, commit([upId(L[0], R.a1, { recommended: '1.25', decision: 'reopen', reason: 'Mason: 1.25 pt is our house rate' })]));
  assert.equal(scalar(`SELECT status || '|' || recommended || '|' || (approved_by IS NULL) FROM public.product_rates WHERE id = '${R.a1}';`), 'draft|1.25|true');
  assert.equal(n(`SELECT count(*) FROM public.product_rate_draft_events WHERE rate_id = '${R.a1}' AND event_type = 'reopened' AND reason = 'Mason: 1.25 pt is our house rate' AND before_values->>'approved_by' = '${ADMIN}';`), 1, 'the old approval stays in the history');
  assert.equal(n(`SELECT count(*) FROM public.product_rate_draft_events WHERE rate_id = '${R.a1}' AND event_type = 'saved' AND after_values->>'recommended' = '1.25';`), 1);
  assert.match(js(ADMIN, preview([upId(L[0], R.a1, { decision: 'reopen', reason: 'again' })])).rates[0].problem, /PRODUCT_RATE_NOT_APPROVED/);
  console.log('[case] 4 an approved row edited without reopen is refused; reopen with a reason makes it a draft with the new value; both events kept');

  // 5. postgres itself: change or delete of an approved row refused; approved -> draft with identical values allowed.
  js(ADMIN, commit([upId(L[0], R.a1, { decision: 'approve' })]));
  for (const sql of [`UPDATE public.product_rates SET recommended = 9 WHERE id = '${R.a1}';`, `DELETE FROM public.product_rates WHERE id = '${R.a1}';`,
    `UPDATE public.product_rates SET status = 'draft', approved_by = NULL, approved_at = NULL, recommended = 9 WHERE id = '${R.a1}';`,
    `UPDATE public.product_rates SET status = 'draft', approved_by = NULL, approved_at = NULL, is_quoting_default = false WHERE id = '${R.a1}';`,
    `UPDATE public.product_rates SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = '${R.a1}';`,
    `UPDATE public.product_rates SET status = 'draft', approved_by = NULL, approved_at = NULL, row_version = 1 WHERE id = '${R.a1}';`]) {
    const r = pg(sql);
    assert.notEqual(r.status, 0, sql); assert.match(r.output, /PRODUCT_RATE_APPROVED/);
  }
  const r = pg(`UPDATE public.product_rates SET status = 'draft', approved_by = NULL, approved_at = NULL, row_version = row_version + 1 WHERE id = '${R.a1}';`);
  assert.equal(r.status, 0, r.output); assert.equal(statusOf(R.a1), 'draft');
  js(ADMIN, commit([upId(L[0], R.a1, { decision: 'approve' })]));
  console.log('[case] 5 a direct table change or delete of an approved row is refused; only approved -> draft with identical values and a higher version passes');
}

function outcomeCases() {
  // 6. approved_default needs no drafts and an approved default.
  const res = js(ADMIN, preview([], [outRow(L[2], 'approved_default')])).outcomes[0];
  assert.equal(res.status, 'invalid'); assert.match(res.problem, /PRODUCT_RATE_OUTCOME_DRAFTS_LEFT: \[PROVER\] Liquid 3 has 2/);
  js(ADMIN, commit([upId(L[2], R.b3, { decision: 'approve' })]));
  assert.match(js(ADMIN, preview([], [outRow(L[2], 'approved_default')])).outcomes[0].problem, /DRAFTS_LEFT: .* has 1 rate/, 'the default is still a draft');
  js(ADMIN, commit([upId(L[3], R.b4, { decision: 'approve' })]));
  refused(ADMIN, commit([], [outRow(L[3], 'approved_default')]), /PRODUCT_RATE_OUTCOME_NO_DEFAULT/);
  js(ADMIN, commit([upId(L[2], R.a3, { decision: 'approve' })]));
  const rec = js(ADMIN, commit([], [outRow(L[2], 'approved_default', 'checked against the 2026 label')]));
  assert.equal(rec.outcomes_changed, 1);
  assert.equal(scalar(`SELECT outcome || '|' || decided_by || '|' || (decided_at IS NOT NULL) || '|' || note FROM public.product_parent_rate_outcomes WHERE parent_id = '${L[2]}';`),
    `approved_default|${ADMIN}|true|checked against the 2026 label`);
  assert.equal(n(`SELECT jsonb_array_length(after_values->'rates') FROM public.product_rate_draft_events WHERE parent_id = '${L[2]}' AND event_type = 'outcome_set';`), 2, 'the decision names the rows it covers');
  assert.equal(events('outcome_set', L[2]), 1);
  const p3 = par(L[2]);
  assert.equal(p3.outcome, 'approved_default'); assert.equal(p3.outcome_decided_by, '[PROVER] Admin');
  console.log('[case] 6 approved_default is refused while a draft remains, with no default, or with the default a draft; set once all rows and the default are approved, with who and when');

  // 7. no_per_acre_default: refused with a default; set on a parent with zero rows.
  js(ADMIN, commit([upId(L[0], R.b1, { decision: 'approve' })]));
  refused(ADMIN, commit([], [outRow(L[0], 'no_per_acre_default')]), /PRODUCT_RATE_OUTCOME_HAS_DEFAULT/);
  js(ADMIN, commit([], [outRow(L[6], 'no_per_acre_default')]));
  assert.equal(outcomeOf(L[6]), 'no_per_acre_default');
  js(ADMIN, commit([], [outRow(L[3], 'no_per_acre_default')]));
  assert.equal(outcomeOf(L[3]), 'no_per_acre_default', 'approved rows and no default');
  // needs_label_data takes any rows; an unknown outcome or a note with no outcome is invalid; clearing works.
  js(ADMIN, commit([], [outRow(L[1], 'needs_label_data')]));
  assert.match(js(ADMIN, preview([], [outRow(L[1], 'maybe')])).outcomes[0].problem, /PRODUCT_RATE_OUTCOME_INVALID/);
  assert.match(js(ADMIN, preview([], [outRow(L[1], null, 'a note')])).outcomes[0].problem, /a note needs an outcome/);
  js(ADMIN, commit([], [outRow(L[1], null)]));
  assert.equal(outcomeOf(L[1]), '<undecided>');
  assert.equal(n(`SELECT count(*) FROM public.product_rate_draft_events WHERE parent_id = '${L[1]}' AND event_type = 'outcome_cleared' AND reason = 'cleared by an admin';`), 1);
  // An outcome row that matches the database is "unchanged"; an old outcome version is stale.
  assert.equal(js(ADMIN, preview([], [outRow(L[6], 'no_per_acre_default')])).outcomes[0].status, 'unchanged');
  assert.equal(js(ADMIN, preview([], [{ ...outRow(L[6], 'needs_label_data'), expected_outcome_version: 0 }])).outcomes[0].status, 'stale');
  console.log('[case] 7 no_per_acre_default is refused with a default and set with zero rows; needs_label_data takes any rows; blank clears; stale and unchanged outcome rows are reported');

  // 8. Any change to a decided parent's rate rows makes it undecided again and logs outcome_cleared.
  const clearedCount = () => n(`SELECT count(*) FROM public.product_rate_draft_events WHERE parent_id = '${L[6]}' AND event_type = 'outcome_cleared' AND ${CLEARED_BY_CHANGE};`);
  const decide = () => { js(ADMIN, commit([], [outRow(L[6], 'needs_label_data')])); assert.equal(outcomeOf(L[6]), 'needs_label_data'); };
  const cleared = (what, fn) => {
    const before = clearedCount();
    fn();
    assert.equal(outcomeOf(L[6]), '<undecided>', `${what} clears the outcome`);
    assert.equal(clearedCount(), before + 1, `${what} logs outcome_cleared`);
  };
  // A derivation's insert (the trigger is on the table, so every writer is covered): postgres inserts a derived row.
  cleared('a derived row', () => {
    const r = pg(`INSERT INTO public.product_rates (parent_id, basis, source, recommended, unit, origin, source_text, created_by, updated_by)
      VALUES ('${L[6]}', 'per_acre', 'label', 1, 'pt', 'derived_text', '1 pt/A', '${ADMIN}', '${ADMIN}');`);
    assert.equal(r.status, 0, r.output);
  });
  const d7 = scalar(`SELECT id FROM public.product_rates WHERE parent_id = '${L[6]}';`);
  decide(); cleared('a save', () => js(ADMIN, commit([upId(L[6], d7, { recommended: '1.5' })])));
  decide(); cleared('an approval', () => js(ADMIN, commit([upId(L[6], d7, { decision: 'approve' })])));
  decide(); cleared('a reopen', () => js(ADMIN, commit([upId(L[6], d7, { decision: 'reopen', reason: 'recheck' })])));
  decide(); cleared('a delete', () => js(ADMIN, commit([upId(L[6], d7, { decision: 'delete', reason: 'wrong product' })])));
  decide(); cleared('an added row', () => js(ADMIN, commit([{ parent_id: L[6], basis: 'per_acre', source: 'label', recommended: '1', unit: 'pt' }])));
  // So a promotable outcome never sits on an unapproved row.
  assert.equal(n(`SELECT count(*) FROM public.product_parent_rate_outcomes o JOIN public.product_rates r ON r.parent_id = o.parent_id
    WHERE o.outcome IN ('approved_default', 'no_per_acre_default') AND r.status = 'draft';`), 0);
  console.log('[case] 8 a derived insert, save, approval, reopen, delete or added row on a decided parent makes it undecided and logs outcome_cleared');
}

function contextCases() {
  // 14. Someone else changes an undecided parent's rows after the download: the old outcome row is stale.
  const a10 = save(L[9], { rec: 1, def: true });
  js(ADMIN, commit([upId(L[9], a10, { decision: 'approve' })]));
  const old10 = par(L[9]);
  js(ADMIN, commit([{ parent_id: L[9], basis: 'per_acre', source: 'label', recommended: '1', unit: 'pt', decision: 'approve' }]));
  refused(ADMIN, commit([], [outRow(L[9], 'approved_default', null, old10)]), /PRODUCT_RATE_OUTCOME_STALE: \[PROVER\] Liquid 10/);
  js(ADMIN, commit([], [outRow(L[9], 'approved_default')]));
  console.log('[case] 14 an outcome row downloaded before another admin added and approved a row is stale; a fresh one sets');

  // 15. The parent becomes dry after approval: setting a promotable outcome re-checks every approved row and refuses;
  // the rows can still be sent back to draft (the unit check no longer traps them) and deleted.
  raw(`UPDATE public.product_parents SET product_form = 'dry' WHERE id = '${L[9]}';`);
  js(ADMIN, commit([], [outRow(L[9], null)]));
  refused(ADMIN, commit([], [outRow(L[9], 'approved_default')]), /PRODUCT_RATE_OUTCOME_ROW_INVALID: \[PROVER\] Liquid 10 no longer passes approval \(.*pt does not fit a dry product/);
  const rows10 = par(L[9]).rates;
  js(ADMIN, commit(rows10.map((r) => up(L[9], r, { decision: 'reopen', reason: 'now a dry product' }))));
  assert.equal(n(`SELECT count(*) FROM public.product_rates WHERE parent_id = '${L[9]}' AND status = 'draft';`), 2);
  js(ADMIN, commit(par(L[9]).rates.map((r) => up(L[9], r, { decision: 'delete', reason: 'now a dry product' }))));
  js(ADMIN, commit([], [outRow(L[9], 'no_per_acre_default')]));
  assert.equal(outcomeOf(L[9]), 'no_per_acre_default');
  console.log('[case] 15 a form change after approval blocks a promotable outcome by name; the rows can still be reopened and deleted');

  // 16. Drafts stay editable and approvable while the live-rate lock is on; the lock is untouched.
  raw('UPDATE public.product_rate_lock SET is_locked = true;');
  js(ADMIN, commit([{ parent_id: L[10], basis: 'per_acre', source: 'house_standard', recommended: '1', unit: 'pt', is_quoting_default: true, decision: 'approve' }],
    [outRow(L[10], 'approved_default')]));
  assert.equal(outcomeOf(L[10]), 'approved_default');
  assert.equal(scalar('SELECT is_locked FROM public.product_rate_lock;'), 't');
  raw('UPDATE public.product_rate_lock SET is_locked = false;');
  console.log('[case] 16 with the live-rate lock on, a draft is added, approved and its parent decided; the lock is unchanged');

  // 17. A bulk wipe is refused on both tables.
  for (const t of ['product_rates', 'product_parent_rate_outcomes']) {
    const r = pg(`TRUNCATE public.${t} CASCADE;`);
    assert.notEqual(r.status, 0); assert.match(r.output, /PRODUCT_RATE_NO_TRUNCATE/);
  }
  console.log('[case] 17 TRUNCATE is refused on product_rates and product_parent_rate_outcomes');
}

function batchCases() {
  // 9. One invalid row in three: preview shows each row, writes nothing; commit saves nothing and names it.
  const three = [upId(L[8], R.b9, { decision: 'reopen', reason: 'recheck' }),
    { parent_id: L[7], basis: 'per_acre', source: 'label', recommended: '1', unit: 'xx' },
    { parent_id: L[7], basis: 'per_100_gal', source: 'label', recommended: '1', unit: 'qt', decision: 'approve' }];
  const w0 = writes();
  const prev = js(ADMIN, preview(three));
  assert.deepEqual(prev.rates.map((r) => r.status), ['change', 'invalid', 'change'], JSON.stringify(prev.rates));
  assert.match(prev.rates[1].problem, /PRODUCT_RATE_UNIT_UNKNOWN/);
  assert.equal(writes(), w0, 'a preview writes nothing (not even a retry receipt)');
  refused(ADMIN, commit(three), /RATE_REVIEW_REFUSED: nothing was saved\. \[PROVER\] Liquid 8: PRODUCT_RATE_UNIT_UNKNOWN/);
  assert.equal(writes(), w0); assert.equal(statusOf(R.b9), 'approved');
  // Malformed rows are invalid rows, not a failed preview.
  const odd = js(ADMIN, preview([upId(L[8], R.a9, { extra: 1 }), upId(L[8], R.b9, { recommended: 2 }),
    upId(L[8], R.b9), { parent_id: L[7], basis: 'per_acre', source: 'label', recommended: '1.1234567', unit: 'pt' },
    upId(L[8], R.a9, { expected_row_version: 'x' }), upId(L[8], R.a9, { decision: 'maybe' })])).rates;
  assert.deepEqual(odd.map((r) => r.status), ['invalid', 'invalid', 'unchanged', 'invalid', 'invalid', 'invalid'], JSON.stringify(odd));
  refused(ADMIN, commit([upId(L[8], R.a9)]), /RATE_REVIEW_NOTHING_TO_SAVE/);
  refused(ADMIN, commit([], []), /RATE_REVIEW_ROWS_REQUIRED/);
  console.log('[case] 9 one invalid row in three: the preview shows each row and writes nothing; commit refuses by name and saves nothing; malformed rows are invalid');

  // 10. Order inside one upload: a new default added and approved, then the outcome on the same parent.
  const p8 = par(L[7]);
  assert.equal(p8.rates.length, 0);
  const rec = js(ADMIN, commit([{ parent_id: L[7], basis: 'per_acre', source: 'house_standard', recommended: '1', unit: 'pt', is_quoting_default: true, decision: 'approve' },
    { parent_id: L[7], basis: 'per_acre', source: 'label', low: '0.5', high: '1.5', unit: 'pt', decision: 'approve' }], [outRow(L[7], 'approved_default', null, p8)]));
  assert.equal(rec.rates_changed, 2); assert.equal(rec.outcomes_changed, 1);
  assert.equal(outcomeOf(L[7]), 'approved_default');
  // A reopen + edit on a decided parent, with its outcome row downloaded before the upload: not stale.
  const p3 = par(L[2]);
  js(ADMIN, commit([up(L[2], p3.rates.find((r) => r.rate_id === R.b3), { high: '2.5', decision: 'reopen', reason: 'label 2026' })],
    [outRow(L[2], 'needs_label_data', 'waiting on the 2026 label', p3)]));
  assert.equal(outcomeOf(L[2]), 'needs_label_data');
  assert.equal(statusOf(R.b3), 'draft');
  // But an outcome row whose parent's outcome moved since the download is stale.
  refused(ADMIN, commit([], [outRow(L[2], 'needs_label_data', 'other', p3)]), /PRODUCT_RATE_OUTCOME_STALE/);
  console.log('[case] 10 one upload adds and approves a default, then sets approved_default; a reopen + edit with the outcome in the same upload is not stale');

  // 11a. The upload's parent_id must be the rate's parent; unknown parents; duplicates.
  const wrong = js(ADMIN, preview([upId(L[8], R.a9, { parent_id: L[0], decision: 'reopen', reason: 'x' })])).rates[0];
  assert.equal(wrong.status, 'invalid'); assert.match(wrong.problem, /belongs to a different parent/);
  assert.equal(js(ADMIN, preview([{ parent_id: id('ff'), basis: 'per_acre', source: 'label', recommended: '1', unit: 'pt' }])).rates[0].status, 'not_found');
  assert.equal(js(ADMIN, preview([], [{ parent_id: id('ff'), expected_outcome_version: 0, outcome: 'needs_label_data' }])).outcomes[0].status, 'not_found');
  assert.deepEqual(js(ADMIN, preview([upId(L[8], R.a9), upId(L[8], R.a9)])).rates.map((r) => r.status), ['unchanged', 'invalid']);
  assert.deepEqual(js(ADMIN, preview([], [outRow(L[8], null), outRow(L[8], null)])).outcomes.map((r) => r.status), ['unchanged', 'invalid']);
  console.log("[case] 11a an upload whose parent_id is not the rate's parent is refused; unknown parents are not_found; duplicates are invalid");

  // 12. One retry key writes once.
  const body = [upId(L[8], R.b9, { decision: 'reopen', reason: 'twice' })];
  const first = js(ADMIN, commit(body, [], 'rt3-same'));
  const w1 = writes();
  assert.deepEqual(js(ADMIN, commit(body, [], 'rt3-same')), first, 'the retry returns the first receipt');
  assert.equal(writes(), w1, 'the retry writes nothing');
  refused(ADMIN, commit([upId(L[8], R.a9, { decision: 'reopen', reason: 'other' })], [], 'rt3-same'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  refused(ADMIN, `SELECT public.commit_rate_review(${J(body)}, '[]'::jsonb, NULL);`, /IDEMPOTENCY_KEY_REQUIRED/);
  console.log('[case] 12 the same retry key returns the first receipt and writes nothing; a different body is refused; a key is required');
}

function downloadCases() {
  // 13. Only the latest derivation's notes; totals match the table.
  const d = dl();
  const p1 = d.parents.find((p) => p.parent_id === L[0]);
  assert.deepEqual(p1.notes, [{ batch: 'new', n: 3 }]);
  assert.equal(d.parents.length, n('SELECT count(*) FROM public.product_parents WHERE is_active;'));
  const t = d.totals;
  assert.equal(t.rates, n('SELECT count(*) FROM public.product_rates;'));
  assert.equal(t.drafts, n("SELECT count(*) FROM public.product_rates WHERE status = 'draft';"));
  assert.equal(t.approved, n("SELECT count(*) FROM public.product_rates WHERE status = 'approved';"));
  assert.equal(t.drafts + t.approved, t.rates);
  assert.equal(t.per_100_gal, n("SELECT count(*) FROM public.product_rates WHERE basis = 'per_100_gal';"));
  assert.equal(t.per_100_gal_approved, n("SELECT count(*) FROM public.product_rates WHERE basis = 'per_100_gal' AND status = 'approved';"));
  assert.equal(t.parents_undecided + t.approved_default + t.no_per_acre_default + t.needs_label_data, t.parents);
  assert.equal(t.approved_default, n("SELECT count(*) FROM public.product_parent_rate_outcomes WHERE outcome = 'approved_default';"));
  assert.equal(d.parents.reduce((s, p) => s + p.rates.length, 0), t.rates);
  assert.equal(d.units.length, 9);
  assert.ok(d.parents.every((p) => Array.isArray(p.sizes) && 'outcome_version' in p));
  console.log(`[case] 13 the download shows only the latest derivation's notes; totals match the table (${JSON.stringify(t)})`);
}

function accessCases() {
  const rows = [upId(L[8], R.a9)];
  for (const sql of ['SELECT public.get_rate_review_workbook();', preview(rows), commit(rows, [], 'rt3-rep')]) {
    refused(REP, sql, /ADMIN_REQUIRED/);
    refused(null, sql, /permission denied for function/);
  }
  assert.equal(ok(REP, 'SELECT count(*) FROM public.product_parent_rate_outcomes;'), '0', 'a sales rep reads no outcomes');
  assert.ok(Number(ok(ADMIN, 'SELECT count(*) FROM public.product_parent_rate_outcomes;')) > 0, 'an admin reads them');
  refused(ADMIN, "UPDATE public.product_parent_rate_outcomes SET outcome = 'approved_default';", /permission denied for table/);
  refused(ADMIN, `INSERT INTO public.product_parent_rate_outcomes (parent_id) VALUES ('${L[8]}');`, /permission denied for table/);
  refused(ADMIN, "UPDATE public.product_rates SET status = 'approved';", /permission denied for table/);
  refused(null, 'SELECT count(*) FROM public.product_parent_rate_outcomes;', /permission denied for table/);
  for (const fn of ['_product_rate_review_run(jsonb,jsonb,text,uuid)', '_product_rate_review_approve(uuid,bigint,uuid)',
    '_product_rate_review_reopen(uuid,bigint,text,uuid)', '_product_rate_review_outcome(uuid,bigint,text,text,uuid)',
    '_product_rate_review_lock(uuid)', '_product_rates_clear_outcome()', '_product_rate_review_no_truncate()']) {
    assert.equal(ok(ADMIN, `SELECT has_function_privilege('public.${fn}', 'EXECUTE');`), 'f', `${fn} is private`);
  }
  console.log('[case] 11 a sales rep and anon are refused by every new function; reps read no outcomes; nobody writes the tables directly; the helpers are private');
}

async function main() {
  buildContainer();
  seed();
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /POSTFLIGHT_OK/);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /RT3_ALREADY_APPLIED/);
  console.log('[case] M1 the candidate applies (its postflight checks every grant) and a second run refuses');
  seedRates();
  approvalCases();
  reopenCases();
  outcomeCases();
  contextCases();
  batchCases();
  downloadCases();
  accessCases();
  console.log('PRODUCT_RATE_REVIEW_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
