#!/usr/bin/env node
/**
 * Real-schema proof for 20270113130000_one_open_count_per_stock_row (KI-160 part) and the stock-matches-history
 * sweep (KI-159); contract docs/plans/2026-11-15-product-master-steps-1-3-CONTRACT.md, PR B.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container, replays
 * every post-baseline migration before the candidate, then drives stock counts the way the app does (count and lines
 * inserted as the signed-in admin, as CycleCounts.tsx does; saves through update_cycle_count_item; Complete, Cancel
 * and Reverse through their RPCs).
 *   S   sweep: a received-then-cancelled return (+10, -10) is no mismatch; one extra unit is reported once per product.
 *   B   BEFORE: two open counts at one warehouse both record +10 and both complete (shelf 110, stock 120); a cancelled
 *       count can be set back to in progress.
 *   P0  the candidate refuses while a warehouse has two open counts; applies; a second run refuses.
 *   P1  a second open count at one warehouse is refused; another warehouse may open its own.
 *   P2  a stock row already on an open count is refused on another count, twice on one count, twice in one statement
 *       and as a move; an unrelated line edit saves.
 *   P3  wrong-warehouse and wrong-product rows refused; two concurrent claims on one stock row: exactly one commits.
 *   P4  completing a count still works and stock still matches history.
 *   P5  a completed or cancelled count cannot be reopened, nor a cancelled one marked completed; a new count may start.
 *   P6  reversing a completed count still works; the reversed count cannot be re-completed and reversed twice.
 *   R   the rollback script removes the guards.
 *
 * Run: node scripts/smoke/prove-one-open-count-real-schema.mjs   (needs Docker)
 * Prints ONE_OPEN_COUNT_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki160-count-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270113130000_one_open_count_per_stock_row.sql');
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
const TOUCHED = /(cycle_count|adjust_inventory|receive_po_items)/i;
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
    if (base === '20270106110000_invoice_brands_rup.sql') {
      // Live ran REG-1's one-time seed before this file; its preflight refuses without the seed row.
      raw(`INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint)
        SELECT '00000000-0000-4000-8000-000000000000', 'unknown', 'ki160-proof' WHERE NOT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);`);
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
const ADMIN = 'c160c160-0000-4000-8000-0000000000a1';
const VENDOR = '[PROVER] KI160 Vendor';
const MAIN = 'Main Warehouse';
const NORTH = 'North Shed';
const PRODUCTS = Object.fromEntries(['b1', 'p1', 'p2', 'r1']
  .map((k, i) => [k, `c160c160-0000-4000-8000-0000000000${(0xb0 + i).toString(16)}`]));
const SWEEP = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'stock-matches-history.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'one-open-count-reverse.sql');

// Runs sql as the signed-in admin (role authenticated), committing only when asked. Returns the first ERROR line or ''.
function asAdmin(sql, { commit = false } = {}) {
  const r = docker(psqlArgs(), { input: `BEGIN;
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', 'authenticated')::text, true);
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    SET LOCAL ROLE authenticated;
    ${sql}
    ${commit ? 'COMMIT;' : 'ROLLBACK;'}`, allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const err = out.split(/\r?\n/).find((l) => /ERROR:/.test(l));
  if (!err && r.status !== 0) throw new Error(`psql failed without an ERROR line:\n${out}`);
  return err ?? '';
}
const ok = (label, sql) => assert.equal(asAdmin(sql, { commit: true }), '', `${label}: expected to succeed`);
const refused = (label, sql, token) => assert.match(asAdmin(sql), new RegExp(token), `${label}: expected ${token}`);
// As the table owner (no grant limits), rolled back: proves a trigger, not the grant.
const refusedAsOwner = (label, sql, token, begin = 'BEGIN;') => {
  const r = docker([...psqlArgs()], { input: `${begin}
${sql}
ROLLBACK;
`, allowFailure: true });
  assert.match(`${r.stdout}
${r.stderr}`, new RegExp(token), `${label}: expected ${token}`);
};
const inv = (p, wh = MAIN) => scalar(`SELECT id FROM public.inventory WHERE product_id = '${p}' AND location = '${wh}';`);
const onHand = (p, wh = MAIN) => Number(scalar(`SELECT quantity_available FROM public.inventory WHERE product_id = '${p}' AND location = '${wh}';`));
let keyN = 0;
const key = (tag) => `prover-ki160-${tag}-${keyN += 1}`;
const sweepRows = () => {
  const sql = lf(SWEEP).replace(/;\s*$/, '');
  return scalar(`SELECT coalesce(string_agg(violation_key || '=' || expected_qty || '/' || actual_qty, ' '), 'none') FROM (${sql}) s;`);
};

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ki160-admin@example.invalid', '{"full_name":"[PROVER] KI160 Admin","role":"admin"}'::jsonb);`);
  assert.equal(scalar(`SELECT role || ',' || is_active FROM public.profiles WHERE id = '${ADMIN}';`), 'admin,true');
  raw(`INSERT INTO public.vendors (name) VALUES ('${VENDOR}');
    INSERT INTO public.warehouses (name, is_active) SELECT '${NORTH}', true WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = '${NORTH}');
    ${Object.entries(PRODUCTS).map(([k, id]) => `INSERT INTO public.products (id, product_name, unit_size, inventory_unit, product_form, current_cost, tier1_price, tier1_margin, is_active)
      VALUES ('${id}', '[PROVER] KI160 ${k}', 'Gal', 'Gal', 'liquid', 10.00, 12.80, 21.875, true);
      INSERT INTO public.inventory (product_id, location, quantity_available) VALUES ('${id}', '${MAIN}', 100), ('${id}', '${NORTH}', 20);
      INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, to_location, notes, performed_by)
        VALUES ('${id}', 'adjusted', 100, '${MAIN}', 'prover opening balance', '${ADMIN}'), ('${id}', 'adjusted', 20, '${NORTH}', 'prover opening balance', '${ADMIN}');`).join('\n')}`);
}

// What CycleCounts.tsx handleCreate does: a number, the count row, one line per stock row at the warehouse.
function startCount(wh, products) {
  return asAdmin(`DO $c$ DECLARE v_cc uuid; BEGIN
    INSERT INTO public.cycle_counts (count_number, warehouse, status)
      VALUES (public.next_cycle_count_number(), '${wh}', 'in_progress') RETURNING id INTO v_cc;
    INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
      SELECT v_cc, i.product_id, i.id, i.quantity_available FROM public.inventory i
       WHERE i.product_id IN (${products.map((p) => `'${p}'`).join(', ')}) AND i.location = '${wh}';
  END $c$;`, { commit: true });
}
const openCount = (wh) => scalar(`SELECT id FROM public.cycle_counts WHERE warehouse = '${wh}' AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1;`);
const itemOn = (cc, p) => scalar(`SELECT id FROM public.cycle_count_items WHERE cycle_count_id = '${cc}' AND product_id = '${p}';`);
const save = (cc, p, qty) => ok(`save ${qty}`, `SELECT public.update_cycle_count_item('${itemOn(cc, p)}', ${qty}, NULL, '${ADMIN}', '${key('save')}');`);
const complete = (cc) => ok('complete', `SELECT public.complete_cycle_count('${cc}', '${ADMIN}', '${key('complete')}',
  (SELECT item_revision FROM public.cycle_counts WHERE id = '${cc}'));`);
const cancel = (cc) => ok('cancel', `SELECT public.cancel_cycle_count('${cc}', '${ADMIN}', '${key('cancel')}');`);

function applyFile(file, label, wantOk) {
  stageText(`${label}.sql`, lf(file));
  const r = apply(`${label}.sql`);
  if (wantOk) assert.equal(r.status, 0, `${label}: should apply\n${r.output}`);
  else assert.notEqual(r.status, 0, `${label}: should refuse`);
  return r.output;
}

// Two sessions insert an item for the same stock row on two different open counts at once.
async function concurrentClaims(ccA, ccB, invId, productId) {
  const claims = (cc, tag) => `BEGIN;
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', 'authenticated')::text, true);
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
      VALUES ('${cc}', '${productId}', '${invId}', 0);
    SELECT pg_sleep(2) AS ki160_${tag};
    COMMIT;`;
  const run = (sql) => new Promise((resolve) => {
    const child = spawn('docker', psqlArgs(), { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(sql);
  });
  const [a, b] = await Promise.all([run(claims(ccA, 'a')), run(claims(ccB, 'b'))]);
  return { a, b };
}

// One session reverses a completed count while another adds a line for the same stock row to a newer count.
async function concurrentReverseAndClaim(ccDone, ccOpen, invId, productId) {
  const asAdminTx = (body) => `BEGIN;
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', 'authenticated')::text, true);
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    SET LOCAL ROLE authenticated;
    ${body}
    SELECT pg_sleep(2);
    COMMIT;`;
  const run = (sql) => new Promise((resolve) => {
    const child = spawn('docker', psqlArgs(), { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(sql);
  });
  const [rev, claim] = await Promise.all([
    run(asAdminTx(`SELECT public.reverse_completed_cycle_count('${ccDone}', '${ADMIN}', '${key('reverse-race')}');`)),
    run(asAdminTx(`INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
      VALUES ('${ccOpen}', '${productId}', '${invId}', 0);`)),
  ]);
  return { rev, claim };
}

async function main() {
  buildContainer();
  seed();
  assert.equal(sweepRows(), 'none', 'seed matches its history');

  // KI-159: a received return (+10) and its cancellation (-10), with the signs the live writers use
  // (receipt 20260827041100:598, _cancel_return_intent_impl_20260812 20260827041500:217); stock nets to 0.
  raw(`INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, to_location, notes, performed_by) VALUES
    ('${PRODUCTS.r1}', 'returned', 10, '${MAIN}', 'prover return receipt', '${ADMIN}'),
    ('${PRODUCTS.r1}', 'returned', -10, '${MAIN}', 'prover return cancelled', '${ADMIN}');`);
  assert.equal(sweepRows(), 'none', 'KI-159: a received-then-cancelled return is not a mismatch');
  const absReading = scalar(`SELECT sum(abs(quantity)) FROM public.inventory_transactions WHERE product_id = '${PRODUCTS.r1}' AND transaction_type = 'returned';`);
  assert.equal(Number(absReading), 20, 'the old abs() reading would expect +20 more');
  raw(`UPDATE public.inventory SET quantity_available = quantity_available + 1 WHERE product_id = '${PRODUCTS.r1}' AND location = '${MAIN}';`);
  assert.equal(sweepRows(), `product:${PRODUCTS.r1}:stock_vs_history=120.00/121.00`, 'a real mismatch is reported once per product');
  raw(`UPDATE public.inventory SET quantity_available = quantity_available - 1 WHERE product_id = '${PRODUCTS.r1}' AND location = '${MAIN}';`);
  console.log('[case] S sweep: a received-then-cancelled return (+10, -10) is no mismatch (abs() would expect +20); one extra unit is reported once for the product (120 history over two warehouses vs 121)');

  // BEFORE: two open counts at one warehouse on the same shelf both record +10 and both complete: 100 -> 120.
  assert.equal(startCount(MAIN, [PRODUCTS.b1]), '');
  const ccA = openCount(MAIN);
  assert.equal(startCount(MAIN, [PRODUCTS.b1]), '', 'BEFORE: a second open count at the same warehouse is allowed');
  const ccB = openCount(MAIN);
  assert.notEqual(ccA, ccB);
  save(ccA, PRODUCTS.b1, 110); save(ccB, PRODUCTS.b1, 110);
  assert.match(applyFile(CANDIDATE, 'cand-open', false), /PREFLIGHT_OPEN_COUNTS: a warehouse has two in-progress counts/);
  complete(ccA); complete(ccB);
  assert.equal(onHand(PRODUCTS.b1), 120, 'BEFORE: the shelf holds 110 but stock ends at 120 (KI-160)');
  // A cancelled count could be set back to in progress and completed again.
  ok('BEFORE reopen', `UPDATE public.cycle_counts SET status = 'cancelled' WHERE id = '${ccB}';`);
  ok('BEFORE reopen', `UPDATE public.cycle_counts SET status = 'in_progress' WHERE id = '${ccB}';`);
  ok('BEFORE reopen close', `UPDATE public.cycle_counts SET status = 'cancelled' WHERE id = '${ccB}';`);
  raw(`UPDATE public.inventory SET quantity_available = 100 WHERE product_id = '${PRODUCTS.b1}' AND location = '${MAIN}';
    DELETE FROM public.inventory_transactions WHERE product_id = '${PRODUCTS.b1}' AND transaction_type = 'adjusted' AND notes LIKE 'Cycle count%';`);
  console.log('[case] B BEFORE: two open counts at one warehouse each record +10 and both complete: shelf 110, stock 120; a cancelled count can be set back to in progress');

  // An open line already pointing at another product's stock row is refused before the guards exist.
  assert.equal(startCount(NORTH, [PRODUCTS.b1]), '');
  const ccX = openCount(NORTH);
  raw(`UPDATE public.cycle_count_items SET product_id = '${PRODUCTS.p1}' WHERE cycle_count_id = '${ccX}';`);
  assert.match(applyFile(CANDIDATE, 'cand-misplaced', false), /PREFLIGHT_OPEN_COUNTS: an in-progress count line is not its product/);
  cancel(ccX);
  applyFile(CANDIDATE, 'cand-apply', true);
  assert.match(applyFile(CANDIDATE, 'cand-again', false), /PREFLIGHT_OPEN_COUNTS: the KI-160 functions already exist/);
  console.log('[case] P0 the candidate refuses while a warehouse has two open counts or an open line sits on another product\'s stock row, applies once they close, and refuses a second run');

  // P1: one open count per warehouse.
  assert.equal(startCount(MAIN, [PRODUCTS.p1, PRODUCTS.p2]), '');
  const cc1 = openCount(MAIN);
  assert.match(startCount(MAIN, [PRODUCTS.p1]), /cycle_counts_one_open_per_warehouse/);
  assert.equal(startCount(NORTH, [PRODUCTS.p1]), '', 'P1: another warehouse may open its own count');
  const ccN = openCount(NORTH);
  console.log('[case] P1 a second open count at Main Warehouse is refused; North Shed may open its own');

  // P2: a stock row on one open item only: another count, the same count twice, or a move onto it.
  refused('P2 other count', `INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
    VALUES ('${ccN}', '${PRODUCTS.p1}', '${inv(PRODUCTS.p1)}', 0);`, 'CYCLE_COUNT_ROW_ALREADY_OPEN: This stock row is already on open count');
  refused('P2 same count twice', `INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
    VALUES ('${cc1}', '${PRODUCTS.p1}', '${inv(PRODUCTS.p1)}', 0);`, 'CYCLE_COUNT_ROW_ALREADY_OPEN');
  refused('P2 one statement twice', `INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
    VALUES ('${ccN}', '${PRODUCTS.p2}', '${inv(PRODUCTS.p2, NORTH)}', 0), ('${ccN}', '${PRODUCTS.p2}', '${inv(PRODUCTS.p2, NORTH)}', 0);`, 'CYCLE_COUNT_ROW_ALREADY_OPEN');
  refusedAsOwner('P2 move onto an open row', `UPDATE public.cycle_count_items SET inventory_id = '${inv(PRODUCTS.p2)}'
    WHERE id = '${itemOn(ccN, PRODUCTS.p1)}';`, 'CYCLE_COUNT_ROW_ALREADY_OPEN');
  refusedAsOwner('P2 reparent onto another count', `UPDATE public.cycle_count_items SET cycle_count_id = '${ccN}'
    WHERE id = '${itemOn(cc1, PRODUCTS.p1)}';`, 'CYCLE_COUNT_ITEM_REPARENT_FORBIDDEN');
  refusedAsOwner('P2 repeatable read', `INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
    VALUES ('${cc1}', '${PRODUCTS.p1}', '${inv(PRODUCTS.p1, NORTH)}', 0);`, 'CYCLE_COUNT_ROW_CLAIM_ISOLATION', 'BEGIN ISOLATION LEVEL REPEATABLE READ;');
  refused('P2 admin moves a line directly', `UPDATE public.cycle_count_items SET inventory_id = '${inv(PRODUCTS.p2)}'
    WHERE id = '${itemOn(ccN, PRODUCTS.p1)}';`, 'permission denied for table cycle_count_items');
  psql(`UPDATE public.cycle_count_items SET notes = 'shelf 3' WHERE id = '${itemOn(cc1, PRODUCTS.p1)}';`);
  assert.equal(scalar(`SELECT notes FROM public.cycle_count_items WHERE id = '${itemOn(cc1, PRODUCTS.p1)}';`), 'shelf 3', 'P2: an unrelated edit (owner) saves');
  console.log('[case] P2 a stock row already on an open count is refused on another count, twice on one count, twice in one statement, and as a move (trigger, as owner); a move onto another count and a repeatable-read claim are refused; a signed-in admin cannot move a line directly; an unrelated owner edit of the line saves');

  // P3: two concurrent claims on one row (North's p2 row, on no open item yet) on the North count: exactly one wins.
  // A stock row from another warehouse, or for another product, is refused.
  raw(`INSERT INTO public.warehouses (name, is_active) SELECT 'South Barn', true WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'South Barn');`);
  assert.equal(asAdmin(`INSERT INTO public.cycle_counts (count_number, warehouse, status) VALUES (public.next_cycle_count_number(), 'South Barn', 'in_progress');`, { commit: true }), '');
  const ccS = openCount('South Barn');
  refused('P3 another warehouse', `INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
    VALUES ('${ccS}', '${PRODUCTS.r1}', '${inv(PRODUCTS.r1, NORTH)}', 0);`, 'CYCLE_COUNT_ROW_WRONG_PLACE');
  refused('P3 another product', `INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
    VALUES ('${ccN}', '${PRODUCTS.p1}', '${inv(PRODUCTS.r1, NORTH)}', 0);`, 'CYCLE_COUNT_ROW_WRONG_PLACE');
  const { a, b } = await concurrentClaims(ccN, ccN, inv(PRODUCTS.p2, NORTH), PRODUCTS.p2);
  assert.equal([a.code, b.code].filter((c) => c === 0).length, 1, `P3: exactly one claim commits\nA: ${a.out}\nB: ${b.out}`);
  assert.match(a.code === 0 ? b.out : a.out, /CYCLE_COUNT_ROW_ALREADY_OPEN/);
  // Changing only a line's product (keeping its stock row) is checked too.
  refusedAsOwner('P3 product swap', `UPDATE public.cycle_count_items SET product_id = '${PRODUCTS.p1}' WHERE id = '${itemOn(ccN, PRODUCTS.p2)}';`, 'CYCLE_COUNT_ROW_WRONG_PLACE');
  assert.equal(scalar(`SELECT count(*) FROM public.cycle_count_items i JOIN public.cycle_counts c ON c.id = i.cycle_count_id
    WHERE i.inventory_id = '${inv(PRODUCTS.p2, NORTH)}' AND c.status = 'in_progress';`), '1');
  cancel(ccS);
  console.log('[case] P3 a stock row from another warehouse or for another product is refused; two concurrent claims on one stock row: exactly one commits, the other is refused');

  // P4: completing still works and moves stock once; the sweep still matches. A line's variance is only set by the RPC.
  refused('P4 admin inserts a counted line with a variance', `INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty, counted_qty, variance, is_counted)
    VALUES ('${cc1}', '${PRODUCTS.p1}', '${inv(PRODUCTS.p1, NORTH)}', 0, 1000, 1000, true);`, 'permission denied for table cycle_count_items');
  refused('P4 admin sets a line variance directly', `UPDATE public.cycle_count_items SET variance = 20 WHERE id = '${itemOn(cc1, PRODUCTS.p1)}';`, 'permission denied for table cycle_count_items');
  save(cc1, PRODUCTS.p1, 95);
  complete(cc1);
  assert.equal(onHand(PRODUCTS.p1), 95, 'P4: counted 95 of 100 -> 95');
  assert.equal(sweepRows(), 'none', 'P4: the count left stock and history in step');
  console.log('[case] P4 a signed-in admin cannot insert a counted line or write a line variance directly; completing a count still works: counted 95 of 100 ends at 95, and stock still matches history');

  // P5: a closed count never reopens (cancelled or completed); a new count at the warehouse may start.
  refusedAsOwner('P5 reopen completed', `UPDATE public.cycle_counts SET status = 'in_progress' WHERE id = '${cc1}';`, 'CYCLE_COUNT_REOPEN_FORBIDDEN: Count .* is completed and cannot become in_progress');
  refusedAsOwner('P5 reopen cancelled', `UPDATE public.cycle_counts SET status = 'in_progress' WHERE id = '${ccB}';`, 'CYCLE_COUNT_REOPEN_FORBIDDEN: Count .* is cancelled and cannot become in_progress');
  refusedAsOwner('P5 cancelled to completed', `UPDATE public.cycle_counts SET status = 'completed' WHERE id = '${ccB}';`, 'CYCLE_COUNT_REOPEN_FORBIDDEN: Count .* is cancelled and cannot become completed');
  refused('P5 admin reopens directly', `UPDATE public.cycle_counts SET status = 'in_progress' WHERE id = '${cc1}';`, 'permission denied for table cycle_counts');
  // The existing revision trigger (20260831235900) already refuses any line write on a closed count.
  refusedAsOwner('P5 line on a completed count', `INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
    VALUES ('${cc1}', '${PRODUCTS.p2}', NULL, 0);`, 'CYCLE_COUNT_NOT_IN_PROGRESS');
  refused('P5 admin edits a count directly', `UPDATE public.cycle_counts SET notes = 'checked' WHERE id = '${cc1}';`, 'permission denied for table cycle_counts');
  psql(`UPDATE public.cycle_counts SET notes = 'checked' WHERE id = '${cc1}';`); // the owner may still edit a closed count's notes
  assert.equal(startCount(MAIN, [PRODUCTS.p1]), '', 'P5: a new count may start once the old one is closed');
  const cc2 = openCount(MAIN);
  cancel(cc2); cancel(ccN);
  console.log('[case] P5 a completed or a cancelled count cannot be set back to in progress (the trigger, as owner); a signed-in admin cannot write cycle_counts directly at all; the owner may still edit a closed count notes; a new count starts after');

  // P6: an admin cannot mark a completed count cancelled directly (that skipped the reversal); Reverse still works.
  refused('P6 admin cancels a completed count directly', `UPDATE public.cycle_counts SET status = 'cancelled' WHERE id = '${cc1}';`, 'permission denied for table cycle_counts');
  assert.equal(onHand(PRODUCTS.p1), 95, 'P6: nothing moved');
  // A newer open count holding the same stock row blocks the reversal (it would shift that count's starting stock).
  assert.equal(startCount(MAIN, [PRODUCTS.p1]), '', 'P6: a newer count opens on the same stock row');
  const ccO = openCount(MAIN);
  refused('P6 reverse while a newer count holds the row', `SELECT public.reverse_completed_cycle_count('${cc1}', '${ADMIN}', '${key('reverse-blocked')}');`,
    'CYCLE_COUNT_REVERSE_BLOCKED: Count .* shares stock with open count');
  assert.equal(onHand(PRODUCTS.p1), 95, 'P6: the refused reversal moved nothing');
  cancel(ccO);
  // Reversal racing a new line on the same stock row: both take the stock row lock first, then the claim lock, so
  // they never deadlock. Either the line lands first (the reversal is refused) or the reversal does (the line saves after).
  assert.equal(startCount(MAIN, [PRODUCTS.p2]), '', 'P6: a newer count opens on another row');
  const ccR = openCount(MAIN);
  const race = await concurrentReverseAndClaim(cc1, ccR, inv(PRODUCTS.p1), PRODUCTS.p1);
  const raceLog = `\nreverse: ${race.rev.out}\nclaim: ${race.claim.out}`;
  assert.doesNotMatch(`${race.rev.out}${race.claim.out}`, /deadlock detected/i, `P6: no deadlock${raceLog}`);
  assert.equal(race.claim.code, 0, `P6: the line saves${raceLog}`);
  if (race.rev.code === 0) {
    assert.doesNotMatch(race.rev.out, /ERROR:/, `P6: reversal ran${raceLog}`);
  } else {
    assert.match(race.rev.out, /CYCLE_COUNT_REVERSE_BLOCKED/, `P6: the reversal is refused, not aborted${raceLog}`);
    cancel(ccR);
    ok('P6 reverse', `SELECT public.reverse_completed_cycle_count('${cc1}', '${ADMIN}', '${key('reverse')}');`);
  }
  if (openCount(MAIN)) cancel(ccR);
  assert.equal(onHand(PRODUCTS.p1), 100, 'P6: reverse puts the 5 back');
  assert.equal(sweepRows(), 'none');
  refusedAsOwner('P6 re-complete a reversed count', `UPDATE public.cycle_counts SET status = 'completed' WHERE id = '${cc1}';`, 'CYCLE_COUNT_REOPEN_FORBIDDEN: Count .* is cancelled and cannot become completed');
  assert.equal(onHand(PRODUCTS.p1), 100, 'P6: nothing moved');
  console.log('[case] P6 a completed count cannot be reversed while a newer open count holds one of its stock rows (CYCLE_COUNT_REVERSE_BLOCKED, nothing moves); once that count is cancelled, reversing still works (95 -> 100) and stock still matches history; an admin cannot mark a completed count cancelled directly (skipping the reversal); the reversed count cannot be set back to completed to reverse it twice');

  // R: rollback removes the guards; two open counts at one warehouse are possible again.
  applyFile(REVERSE, 'reverse', true);
  assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_cycle_count_item_one_open_row', 'trg_cycle_count_no_reopen');`), '0');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname IN ('_cycle_count_item_one_open_row', '_cycle_count_no_reopen');`), '0');
  assert.equal(scalar(`SELECT to_regclass('public.cycle_counts_one_open_per_warehouse') IS NULL;`), 't');
  assert.equal(startCount(MAIN, [PRODUCTS.p2]), ''); assert.equal(startCount(MAIN, [PRODUCTS.p2]), '', 'R: guards gone');
  console.log('[case] R rollback drops both triggers, their functions and the index; two open counts at one warehouse are possible again');

  console.log('ONE_OPEN_COUNT_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
