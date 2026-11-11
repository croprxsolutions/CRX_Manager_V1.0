#!/usr/bin/env node
/**
 * Real-schema proof for 20270102142000_po_close_short (KI-142): a partly received purchase order can be closed short,
 * so its unreceived remainder stops counting as on order. Builds the checked-in schema baseline in a network-disabled
 * PostgreSQL container, replays every migration before the candidate, applies the candidate (a second apply refuses),
 * then on invented rows, through the real RPCs as the real callers: on order drops by exactly the remainder; who may
 * close; which statuses may close; the bill ceiling; the key bound to caller and request; a closed PO refuses receive,
 * edit, cancel, delete and a direct receipt delete, while a receipt reversal keeps it closed; a closed PO can be billed
 * and a cancelled one cannot; close-vs-receive and close-vs-close wait for each other.
 *
 * Run: node scripts/smoke/prove-po-close-short-real-schema.mjs   (needs local Docker image)
 * Prints PO_CLOSE_SHORT_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki142-close-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270102142000_po_close_short.sql');
// KI-16 follow-ups (contract docs/plans/2026-11-10-ki16-rate-unit-followups-CONTRACT.md), applied after P1-P9.
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
const TOUCHED = /(purchase_order|receive_po_items|receiving_record|_recompute_po_on_order|_enforce_po_status_transition|_guard_po_delete|_guard_closed_po|create_vendor_bill|check_idempotency_intent|_bind_replay_receipt_20261015|_replay_fingerprint_20261015)/i;
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
  for (let i = 0; i < 240; i += 1) {
    // The image runs a bootstrap server, stops it, prints this marker, then starts the real one; a busy
    // machine can answer pg_isready from the bootstrap server, so wait for the marker first.
    const logs = docker(['logs', NAME], { allowFailure: true });
    if (`${logs.stdout}\n${logs.stderr}`.includes('PostgreSQL init process complete; ready for start up.')
      && docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
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
const id = (n) => `14200000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
const DRIVER = id('a3');
const OLD_ADMIN = id('a4'); // inactive
const P = (i) => id(`f${i}`);
const VENDOR = '[PROVER] KI142 Vendor';

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function q(sql, options = {}) {
  const r = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: options.allowFailure });
  return { status: r.status, out: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '', err: r.stderr };
}
// One statement as a user (uid null = anon), committed.
function as(uid, sql, { allowFailure = true } = {}) {
  return q(`BEGIN;\n${uid ? claims(uid) : ''}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql};\nCOMMIT;`, { allowFailure });
}
function ok(r) { assert.equal(r.status, 0, r.err); return r.out; }
function refused(r, pattern) {
  assert.notEqual(r.status, 0, 'the call must be refused');
  assert.match(r.err, pattern);
}
// Holds a transaction open for 4 s (session 1) while session 2 runs; session 2 must wait for it.
async function race(name, holderSql, second) {
  stageText(name, `${holderSql}\nSELECT pg_sleep(4);\nCOMMIT;\n`);
  const holder = spawn('docker', [...psqlArgs(), '-f', `/tmp/${name}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  holder.stdout.on('data', (d) => { out += d; });
  holder.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => holder.on('close', resolve));
  let sleeping = false;
  for (let i = 0; i < 100 && !sleeping; i += 1) {
    sleeping = scalar("SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE 'SELECT pg_sleep(4)%' AND pid <> pg_backend_pid();") === '1';
    if (!sleeping) wait(100);
  }
  assert.ok(sleeping, `${name}: session 1 never reached its sleep`);
  const started = Date.now();
  const result = second();
  const waited = Date.now() - started;
  assert.equal(await done, 0, out);
  assert.ok(waited >= 1000, `${name}: session 2 should have waited for session 1 (waited ${waited} ms)`);
  return result;
}

function seed() {
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;`, { user: 'supabase_admin' });
  const users = [[ADMIN, 'admin'], [REP, 'sales_rep'], [DRIVER, 'driver'], [OLD_ADMIN, 'admin']];
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ${users.map(([u, r], i) =>
    `('${u}', 'ki142-${i}@example.invalid', '{"full_name":"[PROVER] ${r} ${i}","role":"${r}"}'::jsonb)`).join(', ')};`);
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id = '${DRIVER}';
    UPDATE public.profiles SET role = 'admin', is_active = false WHERE id = '${OLD_ADMIN}';
    INSERT INTO public.vendors (name) VALUES ('${VENDOR}');`);
  for (let i = 1; i <= 9; i += 1) {
    psql(`SET session_replication_role = replica;
      INSERT INTO public.products (id, product_name, sku, unit_size, current_cost, tier1_price, is_active)
        VALUES ('${P(i)}', '[PROVER] KI142 product ${i}', 'KI142-${i}', 'GL', 1.00, 2.00, true);
      INSERT INTO public.inventory (product_id, location, quantity_available, unit_size)
        VALUES ('${P(i)}', 'Main Warehouse', 0, 'GL');`);
  }
}
let poSeq = 0;
// A PO through the real RPCs as the admin: lines [{p, qty, cents}], then submit (unless draft) and receive.
function makePO(lines, { submit = true, receive = [] } = {}) {
  poSeq += 1;
  const items = lines.map(({ p, qty, cents = 100 }) =>
    `jsonb_build_object('product_id', '${P(p)}', 'product_name', '[PROVER] KI142 product ${p}', 'quantity_ordered', ${qty}, 'unit_cost_cents', ${cents}, 'unit_size', 'GL')`);
  const po = JSON.parse(ok(as(ADMIN, `SELECT public.save_purchase_order(NULL, jsonb_build_object('po_number', 'PROVER-KI142-${poSeq}', 'vendor', '${VENDOR}', 'status', 'draft'),
    jsonb_build_array(${items.join(', ')}), '${ADMIN}', 'k142-save-${poSeq}')::text`))).po_id;
  const itemIds = lines.map(({ p }) => q(`SELECT id FROM public.purchase_order_items WHERE purchase_order_id = '${po}' AND product_id = '${P(p)}';`).out);
  if (submit) ok(as(ADMIN, `SELECT public.submit_purchase_order('${po}', '${ADMIN}', 'k142-submit-${poSeq}')`));
  const receipts = [];
  receive.forEach((qty, i) => { if (qty > 0) receipts.push(...receiveInto(itemIds[i], qty)); });
  return { po, items: itemIds, receipts };
}
let rcvSeq = 0;
function receiveInto(item, qty, { allowFailure = false } = {}) {
  rcvSeq += 1;
  const r = as(ADMIN, `SELECT public.receive_po_items(jsonb_build_array(jsonb_build_object('po_item_id', '${item}', 'quantity', ${qty},
    'storage_location', 'Main Warehouse', 'condition', 'good')), '${ADMIN}', 'k142-rcv-${rcvSeq}', false)::text`);
  if (allowFailure) return r;
  return JSON.parse(ok(r)).receiving_record_ids;
}
const onOrder = (p) => q(`SELECT quantity_on_order FROM public.inventory WHERE product_id = '${P(p)}' AND location = 'Main Warehouse';`).out;
const avail = (p) => q(`SELECT quantity_available FROM public.inventory WHERE product_id = '${P(p)}' AND location = 'Main Warehouse';`).out;
const status = (po) => q(`SELECT status FROM public.purchase_orders WHERE id = '${po}';`).out;
const feed = (po) => q(`SELECT count(*) FROM public.activity_feed WHERE event_type = 'po_closed_short' AND related_entity_id = '${po}';`).out;
const num = (s) => Number(s);
function close(uid, po, reason, key) {
  return as(uid, `SELECT public.close_purchase_order_short(p_po_id => '${po}', p_reason => ${reason === null ? 'NULL' : `'${reason}'`},
    p_idempotency_key => ${key === null ? 'NULL' : `'${key}'`})::text`);
}
function closed(uid, po, reason, key) { return JSON.parse(ok(close(uid, po, reason, key))); }
function bill(po, cents, statusValue = 'unpaid') {
  psql(`SET session_replication_role = replica;
    INSERT INTO public.vendor_bills (vendor_id, purchase_order_id, bill_number, bill_date, due_date, subtotal_cents, total_cents, status)
    SELECT v.id, '${po}', 'PROVER-B-' || gen_random_uuid(), current_date, current_date + 30, ${cents}, ${cents}, '${statusValue}'
      FROM public.vendors v WHERE v.name = '${VENDOR}';`);
}

async function main() {
  buildContainer();
  seed();
  // Before the candidate: the live vendor-bill body, so the re-emit can be compared with it.
  const billSig = 'public._section9_create_vendor_bill_intent_impl_20260826(uuid,uuid,text,date,date,text,bigint,bigint,text,text)';
  const oldBillBody = q(`SELECT md5(prosrc) FROM pg_proc WHERE oid = '${billSig}'::regprocedure;`).out;
  assert.equal(oldBillBody, '501dea14423c9bdf63c01ce961f82fb2', 'the replayed vendor-bill body must be live\'s');

  // PO A: product 1 ordered 10 (4 received) and product 2 ordered 5 (none received). PO B: product 1 ordered 7.
  const A = makePO([{ p: 1, qty: 10 }, { p: 2, qty: 5 }], { receive: [4, 0] });
  makePO([{ p: 1, qty: 7 }]);                                       // B: stays on order
  const C = makePO([{ p: 3, qty: 10 }], { receive: [3] });            // the rep closes it
  const SUB = makePO([{ p: 4, qty: 5 }]);                            // submitted, nothing received
  const DRAFT = makePO([{ p: 4, qty: 5 }], { submit: false });
  const FULL = makePO([{ p: 4, qty: 5 }], { receive: [5] });
  const CANC = makePO([{ p: 4, qty: 5 }]);
  ok(as(ADMIN, `SELECT public.cancel_purchase_order('${CANC.po}', 'Cancelled', '${ADMIN}', 'k142-cancel-c')`));
  const BILLED = makePO([{ p: 5, qty: 10, cents: 100 }], { receive: [5] }); // received value 500 cents
  const D = makePO([{ p: 6, qty: 10 }], { receive: [2] });            // edits, receive, reverse on a closed PO
  const E = makePO([{ p: 7, qty: 10 }], { receive: [2] });            // cancel message; save-to-closed
  const R1 = makePO([{ p: 8, qty: 10 }], { receive: [4] });           // close vs receive
  const R2 = makePO([{ p: 9, qty: 10 }], { receive: [4] });           // close vs close
  assert.equal(status(A.po), 'partially_received');
  assert.equal(num(onOrder(1)), 13);
  assert.equal(num(onOrder(2)), 5);

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /PREFLIGHT_PO_CLOSE_SHORT_DRIFT/);
  const sig = 'public.close_purchase_order_short(uuid,text,text)';
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', '${sig}', 'EXECUTE')::text || has_function_privilege('anon', '${sig}', 'EXECUTE')::text;`), 'truefalse');
  // The re-emitted vendor-bill body is live's with only 'closed' added; its grants are unchanged.
  const newBody = q(`SELECT md5(replace(prosrc, ', ''fully_received'', ''closed'')', ', ''fully_received'')')) FROM pg_proc WHERE oid = '${billSig}'::regprocedure;`).out;
  assert.equal(newBody, oldBillBody, 'the vendor-bill re-emit must change only its status list');
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', '${billSig}', 'EXECUTE')::text;`), 'false');
  assert.equal(scalar("SELECT count(*) FROM public.purchase_orders WHERE status = 'closed';"), '0');
  console.log('[prover] candidate applied once; a second apply refuses; EXECUTE for authenticated only; vendor-bill re-emit = live + closed');

  // 2. Who may close. Nothing changes on a refusal.
  refused(close(null, C.po, 'vendor discontinued', 'k-anon'), /permission denied/);
  refused(close(ADMIN, C.po, 'vendor discontinued', null), /IDEMPOTENCY_KEY_REQUIRED/);
  refused(close(ADMIN, C.po, '   ', 'k-blank'), /PO_CLOSE_INVALID/);
  refused(close(DRIVER, C.po, 'vendor discontinued', 'k-drv'), /INSUFFICIENT_ROLE/);
  refused(close(OLD_ADMIN, C.po, 'vendor discontinued', 'k-old'), /INSUFFICIENT_ROLE/);
  refused(close(ADMIN, id('ee'), 'vendor discontinued', 'k-missing'), /PO_NOT_FOUND/);
  assert.equal(status(C.po), 'partially_received');
  assert.equal(num(onOrder(3)), 7);
  console.log('[prover] anon, no key, a blank reason, a driver, an inactive admin and a missing PO are refused');

  // 1. The admin closes A: on order drops by exactly A's remainder (6 of product 1, 5 of product 2); B still counts.
  const rA = closed(ADMIN, A.po, 'vendor discontinued', 'k-A');
  assert.equal(rA.status, 'closed');
  assert.equal(rA.closed_by, ADMIN);
  assert.equal(rA.close_reason, 'vendor discontinued');
  assert.deepEqual(rA.lines_released.map((l) => `${l.product_id}|${Number(l.quantity)}|${l.unit_size}`).sort(),
    [`${P(1)}|6|GL`, `${P(2)}|5|GL`].sort());
  assert.equal(status(A.po), 'closed');
  assert.equal(q(`SELECT closed_by || '|' || close_reason || '|' || (closed_at IS NOT NULL) FROM public.purchase_orders WHERE id = '${A.po}';`).out,
    `${ADMIN}|vendor discontinued|true`);
  assert.equal(num(onOrder(1)), 7);
  assert.equal(num(onOrder(2)), 0);
  assert.equal(num(avail(1)), 4, 'what was received stays received');
  assert.equal(feed(A.po), '1');
  assert.match(q(`SELECT description FROM public.activity_feed WHERE event_type = 'po_closed_short' AND related_entity_id = '${A.po}';`).out,
    /closed short; the rest of 2 line\(s\) is no longer on order\. Reason: vendor discontinued/);
  // The closed_* columns are readable by the app.
  assert.equal(as(REP, `SELECT close_reason FROM public.purchase_orders WHERE id = '${A.po}'`).out, 'vendor discontinued');
  console.log('[prover] admin close: on order drops by exactly the remainder, the other PO still counts, one activity row');

  // 5. Retry with the same key: same answer, no second row; same key elsewhere or by someone else: refused.
  assert.deepEqual(closed(ADMIN, A.po, 'vendor discontinued', 'k-A'), rA);
  assert.equal(feed(A.po), '1');
  refused(close(ADMIN, C.po, 'vendor discontinued', 'k-A'), /IDEMPOTENCY_INTENT_MISMATCH/);
  refused(close(REP, A.po, 'vendor discontinued', 'k-A'), /IDEMPOTENCY_ACTOR_MISMATCH/);
  // 3. Already closed (new key): says who won, writes nothing.
  const again2 = closed(REP, A.po, 'other reason', 'k-A2');
  assert.equal(again2.status, 'already_closed');
  assert.equal(again2.closed_by, ADMIN);
  assert.equal(again2.close_reason, 'vendor discontinued');
  assert.equal(feed(A.po), '1');
  console.log('[prover] same key retries return the first answer; the key is bound to caller and request; already_closed names the winner');

  // A sales rep may close.
  assert.equal(closed(REP, C.po, 'short shipped', 'k-C').status, 'closed');
  assert.equal(num(onOrder(3)), 0);
  // 3. Only partly received POs close.
  refused(close(ADMIN, SUB.po, 'x', 'k-sub'), /PO_CLOSE_NOTHING_RECEIVED/);
  refused(close(ADMIN, DRAFT.po, 'x', 'k-draft'), /PO_CLOSE_INVALID_STATUS/);
  refused(close(ADMIN, FULL.po, 'x', 'k-full'), /PO_CLOSE_INVALID_STATUS/);
  refused(close(ADMIN, CANC.po, 'x', 'k-canc'), /PO_CLOSE_INVALID_STATUS/);
  console.log('[prover] a sales rep may close; submitted, draft, fully received and cancelled POs are refused');

  // 4. Bills: active bills over the received value block the close; voided ones do not; equal is fine.
  bill(BILLED.po, 501);
  refused(close(ADMIN, BILLED.po, 'x', 'k-b1'), /PO_CLOSE_BILLED_OVER_RECEIVED/);
  psql(`SET session_replication_role = replica; UPDATE public.vendor_bills SET status = 'voided' WHERE purchase_order_id = '${BILLED.po}';`);
  bill(BILLED.po, 900, 'voided');
  bill(BILLED.po, 500);
  assert.equal(closed(ADMIN, BILLED.po, 'x', 'k-b2').status, 'closed');
  // A closed PO can be billed for what arrived; a cancelled one still cannot.
  const vid = q(`SELECT id FROM public.vendors WHERE name = '${VENDOR}';`).out;
  ok(as(ADMIN, `SELECT public.create_vendor_bill(p_vendor_id => '${vid}', p_purchase_order_id => '${A.po}', p_bill_number => 'PROVER-A-1',
    p_subtotal_cents => 400, p_idempotency_key => 'k142-bill-a')`));
  refused(as(ADMIN, `SELECT public.create_vendor_bill(p_vendor_id => '${vid}', p_purchase_order_id => '${CANC.po}', p_bill_number => 'PROVER-C-1',
    p_subtotal_cents => 100, p_idempotency_key => 'k142-bill-c')`), /PO_NOT_BILLABLE/);
  console.log('[prover] bills over received block; voided are ignored; equal is fine; a closed PO can be billed, a cancelled one cannot');

  // 6-8. A closed PO is frozen.
  assert.equal(closed(ADMIN, D.po, 'vendor discontinued', 'k-D').status, 'closed');
  const availD = avail(6);
  refused(receiveInto(D.items[0], 1, { allowFailure: true }), /PO_CLOSED/);
  assert.equal(avail(6), availD);
  refused(as(ADMIN, `SELECT public.save_purchase_order('${D.po}', jsonb_build_object('vendor', '${VENDOR}', 'notes', 'edit'),
    jsonb_build_array(jsonb_build_object('id', '${D.items[0]}', 'product_id', '${P(6)}', 'product_name', '[PROVER] KI142 product 6',
      'quantity_ordered', 20, 'unit_cost_cents', 100, 'unit_size', 'GL')), '${ADMIN}', 'k142-save-d')`), /PO_CLOSED|RECEIVED_PO_LINE_IMMUTABLE/);
  refused(as(ADMIN, `SELECT public.cancel_purchase_order('${D.po}', 'Cancelled', '${ADMIN}', 'k142-cancel-d')`), /PO_CLOSED/);
  refused(as(ADMIN, `SELECT public.delete_purchase_order('${D.po}', '${ADMIN}', 'k142-delete-d')`), /PO_CLOSED|Cannot delete/);
  // A direct receipt removal (no client may do it; postgres here) would lower received without the reversal: refused.
  refused(q(`BEGIN; ${claims(ADMIN)}
DELETE FROM public.receiving_records WHERE id = '${D.receipts[0]}'; COMMIT;`, { allowFailure: true }), /PO_CLOSED/);
  // An admin override does not reopen it.
  refused(q(`BEGIN; SELECT set_config('app.admin_override', 'true', true); UPDATE public.purchase_orders SET status = 'partially_received' WHERE id = '${D.po}'; COMMIT;`, { allowFailure: true }), /PO_CLOSED/);
  assert.equal(status(D.po), 'closed');
  refused(q(`UPDATE public.purchase_orders SET notes = 'rewritten' WHERE id = '${D.po}';`, { allowFailure: true }), /PO_CLOSED/);
  // Any line column outside cost is frozen; a cost correction still lands.
  refused(q(`UPDATE public.purchase_order_items SET unit_size = 'OZ' WHERE id = '${D.items[0]}';`, { allowFailure: true }), /PO_CLOSED/);
  refused(q(`UPDATE public.purchase_order_items SET notes = 'rewritten', product_name = 'other' WHERE id = '${D.items[0]}';`, { allowFailure: true }), /PO_CLOSED/);
  ok(q(`UPDATE public.purchase_order_items SET unit_cost = 1.25 WHERE id = '${D.items[0]}';`, { allowFailure: true }));
  assert.equal(q(`SELECT unit_size || '|' || unit_cost_cents FROM public.purchase_order_items WHERE id = '${D.items[0]}';`).out, 'GL|125');
  console.log('[prover] a closed PO refuses receive, edit, line rewrites, cancel, delete, a direct receipt removal and an override reopen; cost corrections land');

  // 7. A receipt reversal on a closed PO: stock goes down, the line's received drops, it stays closed, on order unchanged.
  const onOrderD = onOrder(6);
  ok(as(ADMIN, `SELECT public.reverse_receiving_record('${D.receipts[0]}', 'wrong receipt', '${ADMIN}', 'k142-rev-d')`));
  assert.equal(num(avail(6)), num(availD) - 2);
  assert.equal(num(q(`SELECT quantity_received FROM public.purchase_order_items WHERE id = '${D.items[0]}';`).out), 0);
  assert.equal(status(D.po), 'closed');
  assert.equal(onOrder(6), onOrderD);
  console.log('[prover] a receipt reversal on a closed PO lowers stock and keeps the PO closed, nothing back on order');

  // 9. Cancel on a partly received PO points to Close Short. Save cannot move a PO into closed, nor create one closed.
  refused(as(ADMIN, `SELECT public.cancel_purchase_order('${E.po}', 'Cancelled', '${ADMIN}', 'k142-cancel-e')`), /Use Close Short/);
  refused(as(ADMIN, `SELECT public.save_purchase_order('${E.po}', jsonb_build_object('vendor', '${VENDOR}', 'status', 'closed'),
    jsonb_build_array(jsonb_build_object('id', '${E.items[0]}', 'product_id', '${P(7)}', 'product_name', '[PROVER] KI142 product 7',
      'quantity_ordered', 10, 'unit_cost_cents', 100, 'unit_size', 'GL')), '${ADMIN}', 'k142-save-e')`), /PO_STATUS_RPC_REQUIRED|closed|transition|check constraint/i);
  refused(as(ADMIN, `SELECT public.save_purchase_order(NULL, jsonb_build_object('po_number', 'PROVER-KI142-X', 'vendor', '${VENDOR}', 'status', 'closed'),
    jsonb_build_array(jsonb_build_object('product_id', '${P(7)}', 'product_name', '[PROVER] KI142 product 7', 'quantity_ordered', 1,
      'unit_cost_cents', 100, 'unit_size', 'GL')), '${ADMIN}', 'k142-save-x')`), /closed|status|check constraint/i);
  assert.equal(status(E.po), 'partially_received');
  console.log('[prover] cancel of a received PO says Use Close Short; save cannot close or create a closed PO');

  // 10. Same instant: a receipt finishing R1 first, then the close waits and is refused (now fully received).
  const closeAfter = await race('rcv-first.sql',
    `BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;\nSELECT public.receive_po_items(jsonb_build_array(jsonb_build_object('po_item_id', '${R1.items[0]}', 'quantity', 6,
      'storage_location', 'Main Warehouse', 'condition', 'good')), '${ADMIN}', 'k142-race-rcv', false);`,
    () => close(REP, R1.po, 'x', 'k-r1'));
  refused(closeAfter, /PO_CLOSE_INVALID_STATUS/);
  assert.equal(status(R1.po), 'fully_received');
  // Two closes at once: the second waits, then answers already_closed with the first one's who and why.
  const second = await race('close-first.sql',
    `BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;\nSELECT public.close_purchase_order_short('${R2.po}', 'first', 'k-r2a');`,
    () => close(REP, R2.po, 'second', 'k-r2b'));
  const s2 = JSON.parse(ok(second));
  assert.equal(s2.status, 'already_closed');
  assert.equal(s2.close_reason, 'first');
  assert.equal(feed(R2.po), '1');
  assert.equal(num(onOrder(9)), 0);
  console.log('[prover] close-vs-receive and close-vs-close wait for each other; one winner');

  console.log('PO_CLOSE_SHORT_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
