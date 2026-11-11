#!/usr/bin/env node
/**
 * Real-schema proof for 20270101134000_cycle_count_variance_vs_onhand_at_count (KI-134;
 * contract docs/plans/2026-11-10-ki134-cycle-count-drift-CONTRACT.md).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container, replays
 * every post-baseline migration before the candidate, then drives stock counts the way the app does (the count and
 * its lines are inserted as the signed-in admin, as CycleCounts.tsx does; counts are saved through
 * update_cycle_count_item; Complete through complete_cycle_count). Stock moves during the count through the real
 * receiving RPC (save_purchase_order + receive_po_items) and the real stock-out RPC (adjust_inventory).
 *   B1  BEFORE: created at 100, a 10-unit PO receipt, the shelf counted at 110 -> Complete leaves 120 (the bug).
 *   B2  BEFORE: created at 100, 10 leave, counted at 90 -> Complete leaves 80 (the bug, other direction).
 *   P0  a changed update_cycle_count_item body makes the candidate refuse; it applies; a second run refuses.
 *   P1  receipt during the count: counted 110 -> on hand 110, variance 0, no adjustment ledger row.
 *   P2  stock out during the count: counted 90 -> on hand 90.
 *   P3  real shrink plus a receipt: created 100, receipt 10, counted 105 -> 105 (variance -5, ledger -5).
 *   P4  movement AFTER the line is counted (counted 97 of 100, then +10 received and 4 out) -> Complete leaves 103.
 *   P8  the candidate refuses while an open count holds a line counted under the old rule (clean cutover).
 *   P5  a same-key retry after stock moved replays the first result and leaves expected_qty alone.
 *   P6  clearing a count keeps expected_qty; a line with no inventory row keeps its stored expected_qty.
 *   P7  a non-admin, a wrong actor and a missing key are refused; reverse undoes P3 exactly.
 *   P9  on hand with more than two decimals is rounded like the stored columns; a tiny on hand leaves no percentage.
 *   P10 a stock change still in flight on the row when the count is saved commits first and is in the baseline.
 *
 * Run: node scripts/smoke/prove-cycle-count-onhand-at-count-real-schema.mjs   (needs Docker)
 * Prints CYCLE_COUNT_ONHAND_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki134-count-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270101134000_cycle_count_variance_vs_onhand_at_count.sql');
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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
const ADMIN = 'c134c134-0000-4000-8000-0000000000a1';
const REP = 'c134c134-0000-4000-8000-0000000000a2';
const VENDOR = '[PROVER] KI134 Vendor';
const PRODUCTS = Object.fromEntries(['b1', 'b2', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']
  .map((k, i) => [k, `c134c134-0000-4000-8000-0000000000${(0xb0 + i).toString(16)}`]));
const FN = "'public.update_cycle_count_item(uuid,numeric,text,uuid,text)'::regprocedure";

// Runs sql as a signed-in user (role authenticated), committing only when asked. Returns the first ERROR line or ''.
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
const ok = (label, sql) => assert.equal(as(ADMIN, sql, { commit: true }), '', `${label}: expected to succeed`);
const refused = (label, user, sql, token) => assert.match(as(user, sql), new RegExp(token), `${label}: expected ${token}`);
const num = (v) => (v === '' || v === '-' ? v : String(Number(v)));
const onHand = (p) => Number(scalar(`SELECT quantity_available FROM public.inventory WHERE product_id = '${p}' AND location = 'Main Warehouse';`));
const latest = (p, col) => scalar(`SELECT coalesce(${col}::text, '-') FROM public.cycle_count_items WHERE product_id = '${p}' ORDER BY created_at DESC LIMIT 1;`);
const line = (p) => ['expected_qty', 'counted_qty', 'variance'].map((c) => num(latest(p, c))).join(',');
const itemOf = (p) => latest(p, 'id');
const countOf = (p) => latest(p, 'cycle_count_id');
let keyN = 0;
const key = (tag) => `prover-ki134-${tag}-${keyN += 1}`;

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ki134-admin@example.invalid', '{"full_name":"[PROVER] KI134 Admin","role":"admin"}'::jsonb),
    ('${REP}', 'ki134-rep@example.invalid', '{"full_name":"[PROVER] KI134 Rep","role":"sales_rep"}'::jsonb);`);
  assert.equal(scalar(`SELECT string_agg(role || ',' || is_active, ' ' ORDER BY role) FROM public.profiles WHERE id IN ('${ADMIN}', '${REP}');`),
    'admin,true sales_rep,true');
  raw(`INSERT INTO public.vendors (name) VALUES ('${VENDOR}');
    ${Object.entries(PRODUCTS).map(([k, id]) => `INSERT INTO public.products (id, product_name, unit_size, inventory_unit, product_form, current_cost, tier1_price, tier1_margin, is_active)
      VALUES ('${id}', '[PROVER] KI134 ${k}', 'Gal', 'Gal', 'liquid', 10.00, 12.80, 21.875, true);
      INSERT INTO public.inventory (product_id, location, quantity_available) VALUES ('${id}', 'Main Warehouse', 100);`).join('\n')}`);
}

// What CycleCounts.tsx handleCreate does: a number, the count row, one line per product with the on-hand read now.
function startCount(p) {
  ok(`start count ${p}`, `DO $c$ DECLARE v_cc uuid; BEGIN
    INSERT INTO public.cycle_counts (count_number, warehouse, status)
      VALUES (public.next_cycle_count_number(), 'Main Warehouse', 'in_progress') RETURNING id INTO v_cc;
    INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
      SELECT v_cc, i.product_id, i.id, i.quantity_available FROM public.inventory i
       WHERE i.product_id = '${p}' AND i.location = 'Main Warehouse';
  END $c$;`);
}
// A real purchase-order receipt of n units into Main Warehouse.
function receive(p, n) {
  ok(`receive ${n} of ${p}`, `DO $r$ DECLARE v_po uuid; v_item uuid; BEGIN
    v_po := (public.save_purchase_order(NULL,
      jsonb_build_object('po_number', '${key('po')}', 'vendor', '${VENDOR}', 'status', 'draft'),
      jsonb_build_array(jsonb_build_object('product_id', '${p}', 'product_name', '[PROVER] KI134', 'quantity_ordered', ${n},
        'unit_cost_cents', 1000, 'unit_size', 'Gal')),
      '${ADMIN}', '${key('po-save')}') ->> 'po_id')::uuid;
    PERFORM public.submit_purchase_order(v_po, '${ADMIN}', '${key('po-submit')}');
    SELECT id INTO v_item FROM public.purchase_order_items WHERE purchase_order_id = v_po;
    PERFORM public.receive_po_items(jsonb_build_array(jsonb_build_object('po_item_id', v_item, 'quantity', ${n},
      'storage_location', 'Main Warehouse', 'condition', 'good')), '${ADMIN}', '${key('receive')}', false);
  END $r$;`);
}
const stockOut = (p, n) => ok(`stock out ${n} of ${p}`, `SELECT public.adjust_inventory(
  (SELECT id FROM public.inventory WHERE product_id = '${p}' AND location = 'Main Warehouse'), -${n},
  'prover: stock leaves during the count', '${ADMIN}', '${key('out')}');`);
const saveCount = (p, qty, k = key('save')) => `SELECT public.update_cycle_count_item('${itemOf(p)}', ${qty}, NULL, '${ADMIN}', '${k}');`;
const complete = (p) => ok(`complete ${p}`, `SELECT public.complete_cycle_count('${countOf(p)}', '${ADMIN}', '${key('complete')}',
  (SELECT item_revision FROM public.cycle_counts WHERE id = '${countOf(p)}'));`);
const adjustedRows = (p) => scalar(`SELECT count(*) FROM public.inventory_transactions WHERE product_id = '${p}' AND transaction_type = 'adjusted';`);

function applyCandidate(label, wantOk) {
  stageText(`cand-${label}.sql`, lf(CANDIDATE));
  const r = apply(`cand-${label}.sql`);
  if (wantOk) assert.equal(r.status, 0, `${label}: candidate should apply\n${r.output}`);
  else assert.notEqual(r.status, 0, `${label}: candidate should refuse`);
  return r.output;
}
const bodyEdit = (from, to) => psql(`DO $d$ DECLARE v text; BEGIN
  SELECT pg_get_functiondef(${FN}) INTO v; EXECUTE replace(v, '${from}', '${to}'); END $d$;`);

async function main() {
  buildContainer();
  seed();

  // BEFORE: the bug, both directions.
  startCount(PRODUCTS.b1); receive(PRODUCTS.b1, 10);
  assert.equal(onHand(PRODUCTS.b1), 110, 'B1: the PO receipt added 10');
  ok('B1 save', saveCount(PRODUCTS.b1, 110)); complete(PRODUCTS.b1);
  assert.equal(onHand(PRODUCTS.b1), 120, 'B1: before the fix a receipt during the count is added twice');
  startCount(PRODUCTS.b2); stockOut(PRODUCTS.b2, 10);
  ok('B2 save', saveCount(PRODUCTS.b2, 90)); complete(PRODUCTS.b2);
  assert.equal(onHand(PRODUCTS.b2), 80, 'B2: before the fix stock out during the count is taken twice');
  console.log('[prover] BEFORE: receipt during a count ends 120 (shelf 110); stock out ends 80 (shelf 90) - KI-134 reproduced');

  // P0: drift refusal, apply, second run refuses.
  const original = scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = ${FN};`);
  bodyEdit('CYCLE_COUNT_ITEM_NOT_FOUND', 'CYCLE_COUNT_ITEM_NOT_FOUND ');
  assert.match(applyCandidate('drift', false), /KI134_PREFLIGHT: update_cycle_count_item body/);
  bodyEdit('CYCLE_COUNT_ITEM_NOT_FOUND ', 'CYCLE_COUNT_ITEM_NOT_FOUND');
  assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = ${FN};`), original, 'P0: body restored');
  // P8: an open count with a line counted under the old rule blocks the apply until it is cancelled.
  startCount(PRODUCTS.b1); ok('P8 old-rule save', saveCount(PRODUCTS.b1, 120));
  assert.match(applyCandidate('cutover', false), /KI134_PREFLIGHT: an in-progress count has lines counted under the old rule/);
  ok('P8 cancel', `SELECT public.cancel_cycle_count('${countOf(PRODUCTS.b1)}', '${ADMIN}', '${key('cancel')}');`);
  applyCandidate('apply', true);
  assert.match(applyCandidate('again', false), /KI134_PREFLIGHT/);
  console.log('[prover] P0: a drifted body is refused; the candidate applies; a second run is refused');

  // P1: receipt during the count.
  startCount(PRODUCTS.p1); receive(PRODUCTS.p1, 10);
  ok('P1 save', saveCount(PRODUCTS.p1, 110));
  assert.equal(line(PRODUCTS.p1), '110,110,0');
  const before1 = adjustedRows(PRODUCTS.p1);
  complete(PRODUCTS.p1);
  assert.equal(onHand(PRODUCTS.p1), 110, 'P1: a receipt during the count is counted once');
  assert.equal(adjustedRows(PRODUCTS.p1), before1, 'P1: no adjustment row');
  // P2: stock out during the count.
  startCount(PRODUCTS.p2); stockOut(PRODUCTS.p2, 10);
  ok('P2 save', saveCount(PRODUCTS.p2, 90)); complete(PRODUCTS.p2);
  assert.equal(onHand(PRODUCTS.p2), 90, 'P2: stock out during the count is taken once');
  // P3: real shrink plus a receipt; reverse undoes exactly it.
  startCount(PRODUCTS.p3); receive(PRODUCTS.p3, 10);
  ok('P3 save', saveCount(PRODUCTS.p3, 105));
  assert.equal(line(PRODUCTS.p3), '110,105,-5');
  complete(PRODUCTS.p3);
  assert.equal(onHand(PRODUCTS.p3), 105);
  assert.equal(num(scalar(`SELECT quantity FROM public.inventory_transactions WHERE product_id = '${PRODUCTS.p3}'
    AND transaction_type = 'adjusted' ORDER BY created_at DESC LIMIT 1;`)), '-5', 'P3: ledger -5');
  ok('P3 reverse', `SELECT public.reverse_completed_cycle_count('${countOf(PRODUCTS.p3)}', '${ADMIN}', '${key('reverse')}');`);
  assert.equal(onHand(PRODUCTS.p3), 110, 'P3: reverse undoes exactly the -5');
  // P4: movement after the line is counted is kept.
  startCount(PRODUCTS.p4);
  ok('P4 save', saveCount(PRODUCTS.p4, 97)); receive(PRODUCTS.p4, 10); stockOut(PRODUCTS.p4, 4); complete(PRODUCTS.p4);
  assert.equal(onHand(PRODUCTS.p4), 103, 'P4: shelf 97 at count (-3), then +10 and -4 after it: 103');
  console.log('[prover] P1-P4: receipt 110->110, stock out 90->90, shrink 105 (ledger -5; reverse back to 110), -3 at count then +10/-4 after it ends 103');

  // P5: same-key retry after stock moved replays the first result; a new save re-reads on hand.
  startCount(PRODUCTS.p5);
  const k5 = key('retry');
  ok('P5 first save', saveCount(PRODUCTS.p5, 97, k5));
  stockOut(PRODUCTS.p5, 4);
  ok('P5 retry', saveCount(PRODUCTS.p5, 97, k5));
  assert.equal(line(PRODUCTS.p5), '100,97,-3', 'P5: a retry does not re-read on hand');
  ok('P5 new save', saveCount(PRODUCTS.p5, 97));
  assert.equal(line(PRODUCTS.p5), '96,97,1', 'P5: a new save compares with on hand now');
  // P6: clearing keeps expected; a line with no inventory row keeps its stored expected.
  ok('P6 clear', saveCount(PRODUCTS.p5, 'NULL'));
  assert.equal(line(PRODUCTS.p5), '96,-,-');
  startCount(PRODUCTS.p6);
  raw(`UPDATE public.cycle_count_items SET inventory_id = NULL, expected_qty = 42 WHERE id = '${itemOf(PRODUCTS.p6)}';`);
  ok('P6 no inventory row', saveCount(PRODUCTS.p6, 40));
  assert.equal(line(PRODUCTS.p6), '42,40,-2');
  console.log('[prover] P5-P6: same-key retry replays (100,97,-3); a new save re-reads on hand (96); clearing keeps it; no inventory row keeps 42');

  // P7: guards unchanged.
  refused('P7 non-admin', REP, `SELECT public.update_cycle_count_item('${itemOf(PRODUCTS.p6)}', 41, NULL, '${REP}', '${key('rep')}');`, 'ADMIN_REQUIRED');
  refused('P7 wrong actor', ADMIN, `SELECT public.update_cycle_count_item('${itemOf(PRODUCTS.p6)}', 41, NULL, '${REP}', '${key('x')}');`, 'ACTOR_MISMATCH');
  refused('P7 no key', ADMIN, `SELECT public.update_cycle_count_item('${itemOf(PRODUCTS.p6)}', 41, NULL, '${ADMIN}', NULL);`, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(scalar(`SELECT has_function_privilege('anon', ${FN}, 'EXECUTE')::text;`), 'false', 'P7: anon cannot execute');
  console.log('[prover] P7: non-admin, wrong actor and missing key refused; anon cannot execute');

  // P9: on hand with more than two decimals is rounded like the stored columns, so row, result and Complete agree;
  // a tiny on hand cannot make a count unsavable through the numeric(8,2) percentage.
  raw(`UPDATE public.inventory SET quantity_available = 9.875 WHERE product_id = '${PRODUCTS.b2}' AND location = 'Main Warehouse';`);
  startCount(PRODUCTS.b2);
  const k9 = key('p9');
  ok('P9 save', saveCount(PRODUCTS.b2, 10, k9));
  const r9 = scalar(`SELECT result::text FROM public.idempotency_keys WHERE idempotency_key = '${k9}' AND operation = 'update_cycle_count_item';`);
  assert.match(r9, /"expected_qty": 9\.88,/, `P9: result expected_qty rounded: ${r9}`);
  assert.match(r9, /"variance": 0\.12,/, `P9: result variance from the rounded on hand: ${r9}`);
  assert.equal(scalar(`SELECT expected_qty::text || ',' || variance::text FROM public.cycle_count_items WHERE id = '${itemOf(PRODUCTS.b2)}';`), '9.88,0.12', 'P9: stored row agrees with the result');
  raw(`UPDATE public.inventory SET quantity_available = 0.01 WHERE product_id = '${PRODUCTS.b2}' AND location = 'Main Warehouse';`);
  ok('P9 tiny on hand', saveCount(PRODUCTS.b2, 100000));
  assert.equal(scalar(`SELECT expected_qty::text || ',' || variance::text || ',' || coalesce(variance_pct::text, '-') FROM public.cycle_count_items WHERE id = '${itemOf(PRODUCTS.b2)}';`), '0.01,99999.99,-', 'P9: an out-of-range percentage is left empty');
  console.log('[prover] P9: on hand 9.875 counted 10 -> 9.88 / 0.12 in row and result; on hand 0.01 counted 100000 saves with no percentage');

  // P10: a stock change still in flight on the line's inventory row when the count is saved commits first and is in
  // the baseline (the save reads the row FOR SHARE), so Complete does not add it a second time.
  startCount(PRODUCTS.p1);
  assert.equal(onHand(PRODUCTS.p1), 110, 'P10: starts at 110');
  const holder = spawn('docker', [...psqlArgs('supabase_admin')], { cwd: ROOT, stdio: ['pipe', 'ignore', 'inherit'] });
  const holderDone = new Promise((resolve) => holder.on('close', resolve));
  // Read as supabase_admin: postgres cannot see another role's query text in pg_stat_activity.
  const holding = () => docker([...psqlArgs('supabase_admin'), '-A', '-t'], { input: `SELECT count(*) FROM pg_stat_activity
    WHERE query LIKE '%ki134_p10_holder%' AND state = 'active' AND pid <> pg_backend_pid();` }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  holder.stdin.end(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE public.inventory SET quantity_available = quantity_available + 10
     WHERE product_id = '${PRODUCTS.p1}' AND location = 'Main Warehouse';
    SELECT pg_sleep(5) AS ki134_p10_holder; COMMIT;`);
  for (let i = 0; i < 100 && holding() !== '1'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the holder's stdin flush
  }
  assert.equal(holding(), '1', 'P10: the in-flight change holds the row');
  ok('P10 save during an in-flight change', saveCount(PRODUCTS.p1, 120));
  assert.equal(await holderDone, 0, 'P10: the in-flight change committed');
  assert.equal(line(PRODUCTS.p1), '120,120,0', 'P10: the save waited for the in-flight change and compared with 120');
  complete(PRODUCTS.p1);
  assert.equal(onHand(PRODUCTS.p1), 120, 'P10: Complete does not add the in-flight change twice');
  console.log('[prover] P10: a change in flight during the save is in the baseline (120,120,0); Complete leaves 120');

  console.log('CYCLE_COUNT_ONHAND_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
