#!/usr/bin/env node
/**
 * Real-schema proof for 20270102143000_ki143_vendor_bill_received_value_checks (KI-143;
 * contract docs/plans/2026-11-10-ki143-vendor-bill-received-value-CONTRACT.md).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (setup copied from prove-rate-unit-guard-real-schema.mjs),
 * seeds an admin, a sales rep, two vendors and POs (part-received, nothing received, cancelled, odd vendor
 * spelling, blank vendor, fractional receipt, over-received), then through the real RPCs as the signed-in admin:
 *   BEFORE  the full ordered value bills with no reason on a 40%-received PO and on one with nothing received.
 *   C0  the candidate applies; a second apply is refused; grants unchanged.
 *   C1-C2  cancelled PO and another or blank vendor stay refused (private implementation, unchanged).
 *   C3  received value x 1.05 is the line: $420.00 on $400 received saves, $420.01 asks; adjustments count; the
 *       DETAIL carries received and ordered value; a blank reason is refused; a confirmed reason is logged with amounts.
 *   C4  nothing received: the ordered total (+5%) stays the limit.   C5  running totals; voided bills excluded; fractions; over-received stays at ordered.
 *   C6  update_vendor_bill: the same rule on edits.   C7  a later receipt raises the limit.   C8  a sales rep is refused.
 *
 * Run: node scripts/smoke/prove-ki143-vendor-bill-received-value-real-schema.mjs   (needs Docker)
 * Prints KI143_VENDOR_BILL_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki143-bills-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270102143000_ki143_vendor_bill_received_value_checks.sql');
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
const TOUCHED = /(create_vendor_bill|update_vendor_bill|_section9_create_vendor_bill|_section9_update_vendor_bill|purchase_order_items|purchase_orders\b|vendor_bills\b)/i;
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

const ADMIN = 'a1430000-0000-4000-8000-0000000000a1';
const REP = 'a1430000-0000-4000-8000-0000000000a2';
const VENDOR = 'a1430000-0000-4000-8000-0000000000d1';
const OTHER_VENDOR = 'a1430000-0000-4000-8000-0000000000d2';
const PRODUCT = 'a1430000-0000-4000-8000-0000000000b1';
const PO_PART = 'a1430000-0000-4000-8000-0000000000e1';   // ordered $1,000.00, received $400.00
const PO_NONE = 'a1430000-0000-4000-8000-0000000000e2';   // ordered $1,000.00, nothing received
const PO_CANCEL = 'a1430000-0000-4000-8000-0000000000e3'; // cancelled
const PO_ODD = 'a1430000-0000-4000-8000-0000000000e4';    // vendor text '  ki143 SUPPLY co ', $500 all received
const PO_BLANK = 'a1430000-0000-4000-8000-0000000000e5';  // blank vendor text
const PO_FRAC = 'a1430000-0000-4000-8000-0000000000e6';   // 2.5 received at $3.33 -> round(832.5) = 833 cents
const PO_OVER = 'a1430000-0000-4000-8000-0000000000e7';   // ordered $100, received $150 (over-received)
const PO_ZERO = 'a1430000-0000-4000-8000-0000000000e8';   // only a $0-cost line arrived; the $1,000 line did not

// Runs sql as a signed-in user (role authenticated). Returns the first ERROR line, or '' when it ran clean.
function as(user, sql, { commit = false } = {}) {
  const r = docker(psqlArgs(), { input: `BEGIN;
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${user}', 'role', 'authenticated')::text, true);
    SELECT set_config('request.jwt.claim.sub', '${user}', true);
    SET LOCAL ROLE authenticated;
    ${sql}
    ${commit ? 'COMMIT;' : 'ROLLBACK;'}`, allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const err = out.split(/\r?\n/).find((l) => /ERROR:/.test(l));
  if (!err && r.status !== 0) throw new Error(`psql failed without an ERROR line:\n${out}`);
  return err ?? '';
}
function clean(label, sql, opts) {
  const err = as(ADMIN, sql, opts);
  assert.equal(err, '', `${label}: expected to succeed, got ${err}`);
}
function refusedWith(label, sql, token, user = ADMIN) {
  const err = as(user, sql);
  assert.match(err, new RegExp(token), `${label}: expected ${token}, got ${err || 'success'}`);
}
let keyN = 0;
const bill = (vendor, po, cents, { confirm = false, reason = null, number = null, adjustment = 0 } = {}) => {
  keyN += 1;
  return `SELECT public.create_vendor_bill('${vendor}', ${po ? `'${po}'` : 'NULL'}, '${number ?? `KI143-${keyN}`}',
    p_subtotal_cents => ${cents}, p_adjustment_cents => ${adjustment}, p_idempotency_key => 'ki143-key-${keyN}',
    p_confirm_po_overage => ${confirm}, p_po_overage_reason => ${reason ? `'${reason}'` : 'NULL'});`;
};
const edit = (billId, cents, { confirm = false, reason = null } = {}) => {
  keyN += 1;
  return `SELECT public.update_vendor_bill('${billId}', ${cents}, 0, (now() AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date + 30, NULL, 'ki143-edit-${keyN}', ${confirm}, ${reason ? `'${reason}'` : 'NULL'});`;
};
const count = (sql) => scalar(`SELECT count(*) FROM ${sql};`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ki143-admin@example.invalid', '{"full_name":"[PROVER] KI143 Admin","role":"admin"}'::jsonb),
    ('${REP}', 'ki143-rep@example.invalid', '{"full_name":"[PROVER] KI143 Rep","role":"sales_rep"}'::jsonb);`);
  assert.equal(scalar(`SELECT role || ',' || is_active FROM public.profiles WHERE id = '${ADMIN}';`), 'admin,true');
  raw(`UPDATE public.profiles SET role = 'sales_rep' WHERE id = '${REP}';
    INSERT INTO public.vendors (id, name) VALUES ('${VENDOR}', 'KI143 Supply Co'), ('${OTHER_VENDOR}', 'KI143 Other Vendor');
    INSERT INTO public.products (id, product_name, unit_size, inventory_unit, product_form, current_cost, tier1_price, tier1_margin, is_active)
    VALUES ('${PRODUCT}', '[PROVER] KI143 Product', 'Gal', 'Gal', 'liquid', 10.00, 12.80, 21.875, true);
    INSERT INTO public.purchase_orders (id, po_number, vendor, status, total_cost, created_by) VALUES
      ('${PO_PART}', 'KI143-PART', 'KI143 Supply Co', 'partially_received', 1000.00, '${ADMIN}'),
      ('${PO_NONE}', 'KI143-NONE', 'KI143 Supply Co', 'submitted', 1000.00, '${ADMIN}'),
      ('${PO_CANCEL}', 'KI143-CANCEL', 'KI143 Supply Co', 'cancelled', 1000.00, '${ADMIN}'),
      ('${PO_ODD}', 'KI143-ODD', '  ki143 SUPPLY co ', 'fully_received', 500.00, '${ADMIN}'),
      ('${PO_BLANK}', 'KI143-BLANK', '  ', 'fully_received', 500.00, '${ADMIN}'),
      ('${PO_FRAC}', 'KI143-FRAC', 'KI143 Supply Co', 'partially_received', 16.65, '${ADMIN}'),
      ('${PO_OVER}', 'KI143-OVER', 'KI143 Supply Co', 'fully_received', 100.00, '${ADMIN}'),
      ('${PO_ZERO}', 'KI143-ZERO', 'KI143 Supply Co', 'partially_received', 1000.00, '${ADMIN}');
    INSERT INTO public.purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size) VALUES
      ('${PO_PART}', '${PRODUCT}', 60, 20, 10.00, 'Gal'),
      ('${PO_PART}', '${PRODUCT}', 40, 20, 10.00, 'Gal'),
      ('${PO_NONE}', '${PRODUCT}', 100, 0, 10.00, 'Gal'),
      ('${PO_CANCEL}', '${PRODUCT}', 100, 0, 10.00, 'Gal'),
      ('${PO_ODD}', '${PRODUCT}', 50, 50, 10.00, 'Gal'),
      ('${PO_BLANK}', '${PRODUCT}', 50, 50, 10.00, 'Gal'),
      ('${PO_FRAC}', '${PRODUCT}', 5, 2.5, 3.33, 'Gal'),
      ('${PO_OVER}', '${PRODUCT}', 10, 15, 10.00, 'Gal'),
      ('${PO_ZERO}', '${PRODUCT}', 10, 10, 0.00, 'Gal'),
      ('${PO_ZERO}', '${PRODUCT}', 100, 0, 10.00, 'Gal');`);
}

async function main() {
  buildContainer();
  seed();

  // BEFORE: the hole the candidate closes.
  clean('BEFORE the full ordered value bills on a 40%-received PO with no reason', bill(VENDOR, PO_PART, 100000));
  clean('BEFORE the full ordered value bills on a PO with nothing received', bill(VENDOR, PO_NONE, 100000));
  refusedWith('BEFORE a cancelled PO is refused one layer down', bill(VENDOR, PO_CANCEL, 1000), 'PO_NOT_BILLABLE');
  refusedWith("BEFORE another vendor's PO is refused one layer down", bill(OTHER_VENDOR, PO_PART, 1000), 'VENDOR_PO_MISMATCH');
  console.log('[prover] BEFORE: the full ordered value bills with no reason on a 40%-received PO and on one with nothing received; cancelled and other-vendor POs are already refused');

  // The candidate applies once; a second apply is refused by its preflight.
  stageText('candidate.sql', lf(CANDIDATE));
  let r = apply('candidate.sql');
  assert.equal(r.status, 0, `candidate failed:\n${r.output}`);
  r = apply('candidate.sql');
  assert.notEqual(r.status, 0, 'a second apply must be refused');
  assert.match(r.output, /KI143_PREFLIGHT/);
  for (const sig of ['create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)',
    'update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)']) {
    assert.equal(scalar(`SELECT has_function_privilege('anon', 'public.${sig}', 'EXECUTE');`), 'f', `anon on ${sig}`);
    assert.equal(scalar(`SELECT has_function_privilege('authenticated', 'public.${sig}', 'EXECUTE');`), 't', `authenticated on ${sig}`);
  }
  console.log('[prover] the candidate applies; a second apply is refused (KI143_PREFLIGHT); grants unchanged');

  // C1-C2: status and vendor stay refused by the private implementation, confirmed or not.
  refusedWith('C1 cancelled PO, confirmed', bill(VENDOR, PO_CANCEL, 1000, { confirm: true, reason: 'x' }), 'PO_NOT_BILLABLE');
  refusedWith("C2 another vendor's PO", bill(OTHER_VENDOR, PO_PART, 1000), 'VENDOR_PO_MISMATCH');
  refusedWith('C2 blank PO vendor, confirmed', bill(VENDOR, PO_BLANK, 1000, { confirm: true, reason: 'x' }), 'VENDOR_PO_MISMATCH');
  clean('C2 same vendor, other case and spaces', bill(VENDOR, PO_ODD, 50000));
  console.log('[prover] C1-C2: a cancelled PO and a mismatched or blank vendor stay refused; case and outer spaces are ignored');

  // C3 received value: $400 received on a $1,000 PO.
  refusedWith('C3 full ordered value unconfirmed', bill(VENDOR, PO_PART, 100000), 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED');
  clean('C3 the refusal DETAIL carries received and ordered value', `DO $d$ DECLARE v text; BEGIN
    PERFORM public.create_vendor_bill('${VENDOR}', '${PO_PART}', 'KI143-D', p_subtotal_cents => 100000, p_idempotency_key => 'ki143-detail');
    RAISE EXCEPTION 'NO_REFUSAL';
    EXCEPTION WHEN invalid_parameter_value THEN GET STACKED DIAGNOSTICS v = PG_EXCEPTION_DETAIL;
      IF (v::jsonb ->> 'received_value_cents') IS DISTINCT FROM '40000' OR (v::jsonb ->> 'po_total_cents') IS DISTINCT FROM '100000'
        OR (v::jsonb ->> 'limit_cents') IS DISTINCT FROM '40000' THEN
        RAISE EXCEPTION 'BAD_DETAIL %', v; END IF; END $d$;`);
  refusedWith('C3 confirmed with a blank reason', bill(VENDOR, PO_PART, 100000, { confirm: true, reason: '   ' }), 'PO_CUMULATIVE_BILLING_REASON_REQUIRED');
  clean('C3 confirmed with reason (on the $500-received PO)', bill(VENDOR, PO_ODD, 100000, { confirm: true, reason: 'freight and rest invoiced early' }), { commit: true });
  assert.equal(count(`public.activity_feed WHERE event_type = 'po_cumulative_billing_overage_confirmed' AND related_entity_id = '${PO_ODD}'
    AND performed_by = '${ADMIN}' AND description LIKE '% exceeded the cumulative PO billing threshold: freight and rest invoiced early' AND description NOT LIKE '%cents%'`),
    '1', 'C3 the reason is logged, without amounts');
  clean('C3 $420.00 (exactly 105% of received) saves', bill(VENDOR, PO_PART, 42000));
  refusedWith('C3 $420.01 needs confirmation', bill(VENDOR, PO_PART, 42001), 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED');
  clean('C3 a negative adjustment counts: $430 - $10 saves', bill(VENDOR, PO_PART, 43000, { adjustment: -1000 }));
  refusedWith('C3 freight counts: $400 + $21.00 needs confirmation', bill(VENDOR, PO_PART, 40000, { adjustment: 2100 }), 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED');
  // C4 nothing received (Mason 2026-11-10): the ordered total stays the limit, so early bills pass as before.
  clean('C4 nothing received, $1,050.00 (105% of ordered) saves', bill(VENDOR, PO_NONE, 105000));
  refusedWith('C4 nothing received, $1,050.01 needs confirmation', bill(VENDOR, PO_NONE, 105001), 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED');
  clean('C4 nothing received, confirmed overage saves and logs its reason', `${bill(VENDOR, PO_NONE, 200000, { confirm: true, reason: 'prepaid order' })}
    SET LOCAL ROLE postgres;
    DO $c$ BEGIN IF (SELECT count(*) FROM public.activity_feed WHERE event_type = 'po_cumulative_billing_overage_confirmed'
      AND related_entity_id = '${PO_NONE}' AND description LIKE '% exceeded the cumulative PO billing threshold: prepaid order') <> 1
      THEN RAISE EXCEPTION 'C4 activity row missing'; END IF; END $c$;`);
  // C5 running total: $300 then $130 crosses $420; a voided or deleted bill does not count.
  clean('C5 first bill $300', bill(VENDOR, PO_PART, 30000, { number: 'KI143-RUN-1' }), { commit: true });
  refusedWith('C5 second bill $130 crosses', bill(VENDOR, PO_PART, 13000), 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED');
  clean('C5 second bill $120 stays under', bill(VENDOR, PO_PART, 12000));
  clean('C5 a voided $300 bill no longer counts', `SELECT public.void_vendor_bill(
      (SELECT id FROM public.vendor_bills WHERE bill_number = 'KI143-RUN-1'), 'proof: entered twice', 'ki143-void');
    ${bill(VENDOR, PO_PART, 42000)}`);
  // Fractional received quantity rounds per line as the PO total does: 2.5 x $3.33 = 833 cents; x1.05 = 874.65.
  clean('C5 fractional 874 cents saves', bill(VENDOR, PO_FRAC, 874));
  refusedWith('C5 fractional 875 cents needs confirmation', bill(VENDOR, PO_FRAC, 875), 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED');
  // Over-received (Mason 2026-11-10): never above the ordered total, so $100 ordered + 5% is still the limit.
  clean('C5 over-received $105.00 saves', bill(VENDOR, PO_OVER, 10500));
  refusedWith('C5 over-received $105.01 needs confirmation', bill(VENDOR, PO_OVER, 10501), 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED');
  // Arrival is judged by quantity: a $0-cost line arriving makes the received value ($0) the limit, so any bill asks.
  refusedWith('C5 only a $0-cost line arrived, $1 needs confirmation', bill(VENDOR, PO_ZERO, 100), 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED');
  console.log('[prover] C3-C5: billing is checked against received value x 1.05 ($420.00 saves, $420.01 asks; adjustments count), running totals count, voided bills do not, nothing received keeps the ordered limit, over-received never lifts the limit above ordered, fractions round per line, a $0-cost arrival counts as arrived, a confirmed reason is logged (no amounts: the feed is not admin-only)');

  // C6 edits: the committed $300 bill.
  const billId = scalar(`SELECT id FROM public.vendor_bills WHERE purchase_order_id = '${PO_PART}' AND bill_number = 'KI143-RUN-1';`);
  assert.match(billId, /^[0-9a-f-]{36}$/);
  clean('C6 edit to $420.00 saves', edit(billId, 42000));
  refusedWith('C6 edit to $420.01 needs confirmation', edit(billId, 42001), 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED');
  refusedWith('C6 edit confirmed without reason', edit(billId, 90000, { confirm: true }), 'PO_CUMULATIVE_BILLING_REASON_REQUIRED');
  clean('C6 edit confirmed with reason', `${edit(billId, 90000, { confirm: true, reason: 'agreed with vendor' })}
    SET LOCAL ROLE postgres;
    DO $c$ BEGIN IF (SELECT count(*) FROM public.activity_feed WHERE event_type = 'po_cumulative_billing_overage_confirmed'
      AND related_entity_id = '${PO_PART}' AND description LIKE '% edit exceeded the cumulative PO billing threshold: agreed with vendor') <> 1
      THEN RAISE EXCEPTION 'C6 activity row missing'; END IF; END $c$;`);
  console.log('[prover] C6: an edit is checked against received value the same way and logs its reason');

  // C7 receiving more raises the limit.
  raw(`UPDATE public.purchase_order_items SET quantity_received = quantity_ordered WHERE purchase_order_id = '${PO_PART}';`);
  clean('C7 after full receipt, $700 more saves', bill(VENDOR, PO_PART, 70000));
  // C8 a non-admin is refused before anything else.
  refusedWith('C8 sales rep', bill(VENDOR, PO_PART, 100), 'NOT_AUTHORIZED', REP);
  assert.equal(count(`public.vendor_bills WHERE purchase_order_id = '${PO_CANCEL}'`), '0', 'no bill ever reached the cancelled PO');
  console.log('[prover] C7-C8: a later receipt raises the limit; a sales rep is refused');
  console.log('KI143_VENDOR_BILL_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
