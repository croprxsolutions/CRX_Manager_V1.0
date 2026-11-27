#!/usr/bin/env node
/**
 * Real-schema proof for 20270314100000_whole_item_quantities_followups.sql (contract
 * docs/plans/2026-11-26-whole-item-followups-CONTRACT.md). Harness copied from the #2675 whole-item prover.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, shows the gap, applies the candidate, then checks
 * every proof case through the real RPCs as the signed-in admin, and the rollback.
 *
 * Run: node scripts/smoke/prove-whole-item-followups-real-schema.mjs   (needs Docker)
 * Prints WHOLE_ITEM_FOLLOWUPS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container;
 * CRX_PROVER_STOP_BEFORE_CANDIDATE=1 stops after seeding (to read the bodies the migration pins).
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a disposable container this run creates (no reuse of another container or database: Sol r1).
const NAME = `crx-wholefu-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270314100000_whole_item_quantities_followups.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'whole-item-followups-reverse.sql');
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
const TOUCHED = /(_enforce_whole_item_quantity|_assert_whole_item_quantity|a3_whole_item_quantity|FUNCTION public\.adjust_inventory\(|_manual_inventory_add_replay_impl_20261015)/i;
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
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
// A rolled-back probe: as postgres with triggers on (uid null) or as a signed-in user. Returns the last row.
function probe(sql, uid = null) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${claims}\n${sql}\nROLLBACK;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '' };
}



const id = (s) => `a7179000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), CUST = id('c1'), PE = id('b1'), PU = id('b2'), PG = id('b3'), PN = id('b4');
const IE = id('d1'), IG = id('d2'), IU = id('d3');
const ORD = id('e1'), OE = id('e11'), DW = id('f2'), DWE = id('f21');
const LPO = id('71'), LPOE = id('711');   // legacy PO: a 2.5 Ea line made before the rule
const product = (pid, name, form, unit) => `('${pid}', '${name}', '${name}', '${form}', '${unit}', '${unit}', '${unit}', '${unit}', 1, 8, 10, 10, 10, 1, true)`;

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'wholefu-admin@example.invalid', '{"full_name":"[PROVER] Whole FU Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Whole FU Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ${product(PE, '[PROVER] Seed Ea', 'each', 'Ea')}, ${product(PU, '[PROVER] Seed Unit', 'each', 'Unit')},
      ${product(PG, '[PROVER] Gallon', 'liquid', 'Gal')}, ${product(PN, '[PROVER] New Ea', 'each', 'Ea')};
    INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order) VALUES
      ('${IE}', '${PE}', 'Main Warehouse', 'Ea', 10, 0, 0), ('${IG}', '${PG}', 'Main Warehouse', 'Gal', 50, 0, 0),
      ('${IU}', '${PU}', 'Main Warehouse', 'Unit', 1.5, 0, 0);
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES ('${ORD}', 'WHOLEFU-O1', '${CUST}', 'confirmed');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, cost_per_unit) VALUES
      ('${OE}', '${ORD}', '${PE}', '[PROVER] Seed Ea', 'Ea', 2, 0, 2, 10, 8);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, assigned_driver, status, is_quick_delivery) VALUES
      ('${DW}', 'WHOLEFU-DW', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'in_progress', false);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size) VALUES
      ('${DWE}', '${DW}', '${OE}', '${PE}', 2, 'Ea');
    INSERT INTO public.purchase_orders (id, po_number, vendor, status, created_by) VALUES ('${LPO}', 'WHOLEFU-LEGACY', '[PROVER] Vendor', 'submitted', '${ADMIN}');
    INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, product_name, quantity_ordered, quantity_received, unit_size, unit_cost)
      VALUES ('${LPOE}', '${LPO}', '${PE}', '[PROVER] Seed Ea', 2.5, 0, 'Ea', 5);`);
  console.log('[prover] seeded Ea, Unit and Gal products, stock (Unit at a legacy 1.5), a load of 2 Ea in progress and a legacy PO with a 2.5 Ea line');
}

const AS_ADMIN = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true); SET LOCAL ROLE authenticated;`;
function committed(sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${AS_ADMIN}\n${sql};\nCOMMIT;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '' };
}
// A rolled-back call as the signed-in admin.
const asAdmin = (sql) => probe(sql, ADMIN);
const WHOLE = (name, unit, n) => new RegExp(`WHOLE_ITEMS_ONLY: \\[PROVER\\] ${name} is sold by the whole item \\(${unit}\\), so ${n.replace('.', '\\.')} can't be used\\. Enter a whole number\\.`);
function refusedAs(r, re, what) { assert.notEqual(r.status, 0, `${what} should be refused:\n${r.output}`); assert.match(r.output, re, r.output); assert.match(r.output, /check_violation|23514|WHOLE_ITEMS_ONLY/); }
function okAs(r, what) { assert.equal(r.status, 0, `${what} should work:\n${r.output}`); }

let key = 0;
const k = (tag) => `wholefu-${tag}-${key += 1}`;
const savePo = (items, tag) => `SELECT public.save_purchase_order(NULL::uuid,
  ${J({ po_number: null, vendor: `[PROVER] Vendor ${tag}`, status: 'draft', submitted_date: null, expected_delivery_date: null, notes: null })},
  ${J(items)}, '${ADMIN}'::uuid, '${k('po')}')`;
const poLine = (pid, qty, unit) => ({ product_id: pid, product_name: 'x', quantity_ordered: qty, unit_size: unit, quantity_received: 0, unit_cost: 5, unit_cost_cents: 500 });
const receive = (entries, fn = 'receive_po_items', over = false) => `SELECT public.${fn}(
  ${J(entries.map(([po_item_id, quantity]) => ({ po_item_id, quantity, condition: 'good', lot_number: null, notes: null, storage_location: 'Main Warehouse', ...(over ? { over_receive_reason: '[PROVER] supplier sent extra' } : {}) })))},
  '${ADMIN}'::uuid, '${k('rcv')}', ${over})`;
const stock = (inv) => scalar(`SELECT quantity_available FROM public.inventory WHERE id = '${inv}';`);
const ledgerCount = () => scalar('SELECT count(*) FROM public.inventory_transactions;');

function beforeCases() {
  okAs(asAdmin(savePo([poLine(PE, 2.5, 'Ea')], 'before')), 'before the fix, a 2.5 Ea PO');
  console.log('[before] reproduced: save_purchase_order stores a 2.5 Ea line');
}

// The six function bodies the migration and its rollback pin, read from a database where they are current.
function pinnedBodies() {
  const md5 = (sig) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
  return {
    trigger: md5('public._enforce_whole_item_quantity()'),
    adjust: md5('public.adjust_inventory(uuid,numeric,text,uuid,text)'),
    madd: md5('public._manual_inventory_add_replay_impl_20261015(uuid,text,numeric,text,uuid,text,numeric,text,numeric,numeric)'),
  };
}

function applyCandidate() {
  const before = pinnedBodies();
  for (const [name, pin] of [['trigger', /'_enforce_whole_item_quantity\(\)' THEN '([0-9a-f]{32})'/], ['madd', /ELSE '([0-9a-f]{32})' END;\n  IF v_bad IS NOT NULL THEN\n    RAISE EXCEPTION 'WHOLE_ITEMS_FOLLOWUPS_PREFLIGHT/]]) {
    assert.equal(pin.exec(lf(CANDIDATE))?.[1], before[name], `the preflight pins the current ${name} body`);
  }
  assert.equal(before.adjust, 'a65294fccbf7d49375b96ed6c46ab29e', 'adjust_inventory is the 20270201140000 body');
  stageText('candidate.sql', lf(CANDIDATE));
  // 8. A legacy 2.5 Ea PO line blocks the apply, naming its PO; nothing stays installed.
  const blocked = apply('candidate.sql');
  assert.notEqual(blocked.status, 0, 'the apply must be refused while a fractional Ea PO line exists');
  assert.match(blocked.output, /WHOLE_ITEMS_FOLLOWUPS_POSTFLIGHT: fractional quantities already exist on Ea\/Unit products \(first ten: PO /, blocked.output);
  assert.match(blocked.output, /WHOLEFU-LEGACY/, blocked.output);
  assert.equal(scalar("SELECT to_regprocedure('public._assert_whole_item_quantity(uuid,numeric,text)') IS NULL;"), 't');
  // The before-case PO (2.5 Ea) and the legacy one: made whole for the apply, then the legacy one back to 2.5.
  raw(`UPDATE public.purchase_order_items SET quantity_ordered = 3 WHERE product_id = '${PE}' AND quantity_ordered = 2.5;`);
  const r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  raw(`UPDATE public.purchase_order_items SET quantity_ordered = 2.5 WHERE id = '${LPOE}';`);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.output, /WHOLE_ITEMS_FOLLOWUPS_PREFLIGHT/);
  const after = pinnedBodies();
  for (const [name, pin] of [['trigger', /'_enforce_whole_item_quantity\(\)' THEN '([0-9a-f]{32})'/], ['adjust', /'adjust_inventory\(uuid,numeric,text,uuid,text\)' THEN '([0-9a-f]{32})'/]]) {
    assert.equal([...lf(CANDIDATE).matchAll(new RegExp(pin.source, 'g'))].at(-1)?.[1], after[name], `the postflight pins the new ${name} body`);
  }
  console.log('[case 8] the apply is refused while PO WHOLEFU-LEGACY holds 2.5 Ea, naming it; once whole it applies; a second apply is refused');
  return { before, after };
}

function afterCases() {
  // 1. Purchase orders through the real save.
  refusedAs(asAdmin(savePo([poLine(PE, 2.5, 'Ea')], 'frac')), WHOLE('Seed Ea', 'Ea', '2.5'), 'a 2.5 Ea PO line');
  refusedAs(asAdmin(savePo([poLine(PG, 4, 'Gal'), poLine(PU, 0.5, 'Unit')], 'frac2')), WHOLE('Seed Unit', 'Unit', '0.5'), 'a PO with a valid Gal line and a 0.5 Unit line');
  assert.equal(scalar("SELECT count(*) FROM public.purchase_orders WHERE vendor LIKE '[PROVER] Vendor frac%';"), '0');
  okAs(asAdmin(savePo([poLine(PE, 3, 'Ea'), poLine(PG, 2.5, 'Gal')], 'whole')), 'a 3 Ea and 2.5 Gal PO');
  // The legacy 2.5 Ea PO saves a header change through the real save (its line resent unchanged).
  const legacy = asAdmin(`SELECT public.save_purchase_order('${LPO}'::uuid,
    ${J({ po_number: 'WHOLEFU-LEGACY', vendor: '[PROVER] Vendor', status: 'submitted', submitted_date: null, expected_delivery_date: null, notes: 'legacy header edit' })},
    ${J([{ id: LPOE, ...poLine(PE, 2.5, 'Ea') }])}, '${ADMIN}'::uuid, '${k('legacy')}');
    SELECT quantity_ordered || '/' || (SELECT notes FROM public.purchase_orders WHERE id = '${LPO}') FROM public.purchase_order_items WHERE purchase_order_id = '${LPO}';`);
  okAs(legacy, 'a header edit on the legacy 2.5 Ea PO');
  assert.equal(legacy.last, '2.5/legacy header edit', legacy.output);
  console.log('[case 1] PO: 2.5 Ea and 0.5 Unit (beside a valid Gal line) refused, no PO; 3 Ea + 2.5 Gal saves; the legacy 2.5 Ea PO saves a header edit');

  // 7. A product change re-checks the figure.
  refusedAs(probe(`INSERT INTO public.purchase_order_items (purchase_order_id, product_id, product_name, quantity_ordered, quantity_received, unit_size, unit_cost)
      VALUES ('${LPO}', '${PG}', 'x', 2.5, 0, 'Gal', 5) RETURNING id \\gset
    UPDATE public.purchase_order_items SET product_id = '${PE}', unit_size = 'Ea' WHERE id = :'id';`), WHOLE('Seed Ea', 'Ea', '2.5'), 'a 2.5 Gal PO line moved to Ea');
  console.log('[case 7] a 2.5 Gal PO line re-pointed to the Ea product (unit too) is refused');

  // 2. Receiving, on a submitted PO with a 3 Ea line, a 4 Ea line and a 2.5 Gal line.
  const made = committed(savePo([poLine(PE, 3, 'Ea'), poLine(PE, 4, 'Ea'), poLine(PG, 2.5, 'Gal')], 'recv'));
  okAs(made, 'the receiving PO');
  const po = scalar("SELECT id FROM public.purchase_orders WHERE vendor = '[PROVER] Vendor recv';");
  okAs(committed(`SELECT public.submit_purchase_order('${po}'::uuid, '${ADMIN}'::uuid, '${k('submit')}')`), 'submitting it');
  const line = (qty, pid = PE) => scalar(`SELECT id FROM public.purchase_order_items WHERE purchase_order_id = '${po}' AND product_id = '${pid}' AND quantity_ordered = ${qty};`);
  const L3 = line(3), L4 = line(4), LG = line(2.5, PG);
  const s0 = stock(IE), t0 = ledgerCount();
  refusedAs(asAdmin(receive([[L3, 0.5]])), WHOLE('Seed Ea', 'Ea', '0.5'), 'receiving 0.5 Ea');
  refusedAs(asAdmin(receive([[L3, 0.5], [L3, 0.5]])), WHOLE('Seed Ea', 'Ea', '0.5'), 'receiving 0.5 + 0.5 Ea in one call');
  refusedAs(asAdmin(receive([[LG, 1], [L4, 1.5]])), WHOLE('Seed Ea', 'Ea', '1.5'), 'a valid Gal entry beside 1.5 Ea');
  assert.equal(stock(IE), s0); assert.equal(ledgerCount(), t0);
  const two = committed(receive([[L3, 1], [L3, 1], [LG, 0.5]]));
  okAs(two, 'receiving 1 + 1 Ea and 0.5 Gal in one call');
  assert.equal(scalar(`SELECT count(*) || '/' || sum(quantity_received) FROM public.receiving_records WHERE po_item_id = '${L3}';`), '2/2');
  assert.equal(Number(stock(IE)), Number(s0) + 2);
  const rec = scalar(`SELECT id FROM public.receiving_records WHERE po_item_id = '${L3}' ORDER BY received_at, id LIMIT 1;`);
  okAs(committed(`SELECT public.reverse_receiving_record('${rec}'::uuid, '[PROVER] mistake', '${ADMIN}'::uuid, '${k('rev')}')`), 'reversing one receipt');
  assert.equal(Number(scalar(`SELECT quantity_received FROM public.purchase_order_items WHERE id = '${L3}';`)), 1);
  // Excess path on the 4 Ea line holding a legacy 2.5 received (made with triggers off): 1.5 refused, 2 saves.
  raw(`UPDATE public.purchase_order_items SET quantity_received = 2.5 WHERE id = '${L4}';`);
  const t1 = ledgerCount();
  refusedAs(asAdmin(receive([[L4, 1.5]], 'receive_po_items_with_excess_notice', true)), WHOLE('Seed Ea', 'Ea', '1.5'), 'receiving 1.5 Ea over a legacy 2.5');
  assert.equal(ledgerCount(), t1);
  okAs(asAdmin(receive([[L4, 2]], 'receive_po_items_with_excess_notice', true)), 'receiving 2 Ea over a legacy 2.5 (4.5 of 4)');
  console.log('[case 2] receiving: 0.5, 0.5 + 0.5, and 1.5 beside a valid Gal entry refused with nothing moved; 1 + 1 Ea and 0.5 Gal save (two receipts); one receipt reverses; over a legacy 2.5 the excess path refuses 1.5 and takes 2');

  // 3. Cycle counts through the real RPCs. Unit stock is a legacy 1.5.
  const cc = committed(`SELECT public.create_cycle_count(p_warehouse => 'Main Warehouse', p_performed_by => '${ADMIN}'::uuid, p_idempotency_key => '${k('cc')}')`);
  okAs(cc, 'starting a count');
  const ccId = JSON.parse(cc.output.split(/\r?\n/).find((l) => l.includes('cycle_count_id'))).cycle_count_id;
  const item = (inv) => scalar(`SELECT id FROM public.cycle_count_items WHERE cycle_count_id = '${ccId}' AND inventory_id = '${inv}';`);
  const count = (it, qty) => `SELECT public.update_cycle_count_item('${it}'::uuid, ${qty}, NULL, '${ADMIN}'::uuid, '${k('cnt')}')`;
  refusedAs(asAdmin(count(item(IE), 4.5)), WHOLE('Seed Ea', 'Ea', '4.5'), 'counting 4.5 Ea');
  okAs(committed(count(item(IE), Number(stock(IE)))), 'counting the Ea stock whole');
  okAs(committed(count(item(IG), 49.5)), 'counting 49.5 Gal');
  okAs(committed(count(item(IU), 2)), 'counting 2 Unit on a legacy 1.5');
  const rev = Number(scalar(`SELECT item_revision FROM public.cycle_counts WHERE id = '${ccId}';`));
  okAs(committed(`SELECT public.complete_cycle_count(p_cycle_count_id => '${ccId}'::uuid, p_completed_by => '${ADMIN}'::uuid, p_idempotency_key => '${k('ccdone')}', p_expected_item_revision => ${rev})`), 'completing the count');
  assert.equal(Number(stock(IU)), 2, 'the Unit stock is whole after the count (+0.5 variance)');
  okAs(committed(`SELECT public.reverse_completed_cycle_count(p_cycle_count_id => '${ccId}'::uuid, p_reversed_by => '${ADMIN}'::uuid, p_idempotency_key => '${k('ccrev')}')`), 'reversing the count');
  assert.equal(Number(stock(IU)), 1.5, 'the reversal restores the legacy 1.5');
  console.log('[case 3] count: 4.5 Ea refused; whole Ea, 49.5 Gal and 2 Unit (over a legacy 1.5) save and complete (+0.5); the reversal restores 1.5');

  // 4. Adjustments.
  const adj = (inv, d, key = k('adj')) => `SELECT public.adjust_inventory('${inv}'::uuid, ${d}, '[PROVER] adjust', '${ADMIN}'::uuid, '${key}')`;
  const s4 = stock(IE), t4 = ledgerCount();
  refusedAs(asAdmin(adj(IE, -0.5)), WHOLE('Seed Ea', 'Ea', '-0.5'), 'adjusting -0.5 Ea');
  refusedAs(asAdmin(adj(IU, 0.5)), WHOLE('Seed Unit', 'Unit', '0.5'), 'adjusting +0.5 Unit (stock at a legacy 1.5)');
  assert.equal(stock(IE), s4); assert.equal(ledgerCount(), t4);
  const once = k('adj-once');
  const first = committed(adj(IE, -1, once));
  okAs(first, 'adjusting -1 Ea');
  okAs(committed(adj(IG, -0.5)), 'adjusting -0.5 Gal');
  const replay = committed(adj(IE, -1, once));
  okAs(replay, 'a retry of the -1 adjustment');
  assert.equal(replay.last, first.last, 'the retry returns the saved receipt');
  assert.equal(Number(stock(IE)), Number(s4) - 1, 'the retry moves nothing');
  console.log('[case 4] adjust: -0.5 Ea and +0.5 Unit refused, nothing moved; -1 Ea and -0.5 Gal work; a retry returns the receipt');

  // 5. Manual add (the product has no stock row yet).
  const madd = (qty) => `SELECT public.manual_inventory_add(p_product_id => '${PN}'::uuid, p_location => 'Main Warehouse', p_quantity => ${qty},
    p_performed_by => '${ADMIN}'::uuid, p_idempotency_key => '${k('madd')}')`;
  refusedAs(asAdmin(madd(2.5)), WHOLE('New Ea', 'Ea', '2.5'), 'adding 2.5 Ea');
  assert.equal(scalar(`SELECT count(*) FROM public.inventory WHERE product_id = '${PN}';`), '0');
  okAs(asAdmin(madd(2)), 'adding 2 Ea');
  console.log('[case 5] manual add: 2.5 Ea refused, no stock row; 2 Ea works');

  // 6. Returns: complete the 2 Ea load, then return from it.
  okAs(committed(`SELECT public.complete_delivery(p_delivery_id => '${DW}', p_signed_by => 'No proof — recorded by office',
    p_performed_by => '${ADMIN}', p_quantities => ${J({ [DWE]: 2 })}, p_idempotency_key => '${k('done')}',
    p_evidence => 'no_proof', p_evidence_ref => '[PROVER] whole item')`), 'completing the 2 Ea load');
  const ret = (qty) => `SELECT public.create_return(
    ${J({ customer_id: CUST, order_id: ORD, reason: 'damaged', reason_notes: null, notes: null })},
    ${J([{ order_item_id: OE, product_id: PE, product_name: '[PROVER] Seed Ea', quantity: qty, unit: 'Ea', unit_price_cents: 1000, condition: 'unopened', restock: true, sort_order: 0, notes: null }])},
    '${k('ret')}')`;
  refusedAs(asAdmin(ret(0.5)), WHOLE('Seed Ea', 'Ea', '0.5'), 'returning 0.5 Ea');
  assert.equal(scalar(`SELECT count(*) FROM public.returns WHERE order_id = '${ORD}';`), '0');
  okAs(asAdmin(ret(1)), 'returning 1 Ea');
  // Split-billed sale (Mason 2026-11-26): a payer's share of one item may come back as a fraction, through the real
  // create_return. Posted invoices (made with triggers off) bill the 2 Ea line 1 + 1 to two payers. With only the
  // order customer's invoice, the order still flagged for split billing, 0.5 is refused: one payer is not a split.
  const C2 = id('c2');
  const splitReturn = (payers) => probe(`SET LOCAL session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${C2}', '[PROVER] Whole FU Partner', true);
    UPDATE public.orders SET needs_split_billing = true WHERE id = '${ORD}';
    ${payers.map((c, n) => `INSERT INTO public.invoices (id, customer_id, order_id, invoice_number, status, posted_at, invoice_date, created_by, invoice_group_id)
      VALUES ('${id(`d${n}`)}', '${c}', '${ORD}', 'WHOLEFU-I${n}', 'posted', now(), current_date, '${ADMIN}', '${id('d9')}');
    INSERT INTO public.invoice_items (invoice_id, product_id, order_item_id, description, quantity, unit_size, unit_price_cents, extended_cents)
      VALUES ('${id(`d${n}`)}', '${PE}', '${OE}', '[PROVER] Seed Ea', 1, 'Ea', 1000, 1000);
    INSERT INTO public.split_invoice_provenance (invoice_id, order_id, invoice_group_id, customer_id, invoice_type, season, total_amount_cents, content_claim, created_by)
      SELECT i.id, i.order_id, '${id('d9')}', i.customer_id, i.invoice_type, 2027, 1000, public._split_invoice_content_claim(i.id), '${ADMIN}'
        FROM public.invoices i WHERE i.id = '${id(`d${n}`)}';`).join('\n')}
    SET LOCAL session_replication_role = origin;
    ${AS_ADMIN}
    SELECT public.create_return(
      ${J({ customer_id: payers.at(-1), order_id: ORD, reason: 'damaged', reason_notes: null, notes: null })},
      ${J([{ order_item_id: OE, product_id: PE, product_name: '[PROVER] Seed Ea', quantity: 0.5, unit: 'Ea', unit_price_cents: 1000, condition: 'unopened', restock: true, sort_order: 0, notes: null }])},
      '${k('split')}');
    SELECT trim_scale(ri.quantity)::text FROM public.return_items ri JOIN public.returns r ON r.id = ri.return_id
     WHERE r.order_id = '${ORD}' AND r.customer_id = '${payers.at(-1)}';`);
  const split = splitReturn([CUST, C2]);
  okAs(split, 'the partner payer returning 0.5 Ea of a line billed 1 + 1 to two payers');
  assert.equal(split.last, '0.5', split.output);
  refusedAs(splitReturn([CUST]), WHOLE('Seed Ea', 'Ea', '0.5'), 'returning 0.5 Ea of a line billed to one payer (order flagged split)');
  console.log('[case 6] returns: 0.5 Ea refused, no return; 1 Ea works; create_return takes 0.5 Ea from a payer of a line billed to two payers, refused when one payer was billed');

  // 9. No API role can call the helper or the trigger function; the two RPCs keep their grants.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public._assert_whole_item_quantity(uuid,numeric,text)', 'EXECUTE')
      OR has_function_privilege('${role}', 'public._enforce_whole_item_quantity()', 'EXECUTE');`), 'f', role);
  }
  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public.adjust_inventory(uuid,numeric,text,uuid,text)', 'EXECUTE');"), 't');
  console.log('[case 9] no API role can call the helper or trigger function; adjust_inventory keeps its grant');

  // #2675's rules still hold: a 14.8 Ea quote figure is refused with the quote hint.
  const q = probe(`INSERT INTO public.quotes (id, quote_number, customer_id, created_by) VALUES ('${id('91')}', 'WHOLEFU-Q1', '${CUST}', '${ADMIN}');
    INSERT INTO public.quote_sections (id, quote_id) VALUES ('${id('92')}', '${id('91')}');
    INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, current_cost, total_units_needed, unit_size, calc_mode)
    VALUES ('${id('91')}', '${id('92')}', '${PE}', 1, 10, 8, 14.8, 'Ea', 'units_direct');`);
  refusedAs(q, /WHOLE_ITEMS_ONLY: \[PROVER\] Seed Ea is sold by the whole item \(Ea\), so 14\.8 can't be used\. Enter a whole number\. Change the rate or acres, or type the number of items\./, 'a 14.8 Ea quote line');
  refusedAs(probe(`UPDATE public.order_items SET total_units_needed = 2.5 WHERE id = '${OE}';`), WHOLE('Seed Ea', 'Ea', '2.5'), 'an order line changed to 2.5');
  console.log('[#2675] quote (with its hint) and order lines are still refused');
}

function rollbackCases(pins) {
  const rev = lf(REVERSE);
  for (const [name, val] of Object.entries(pins.after)) assert.ok(rev.includes(`'${val}'`), `the reverse script pins the new ${name} body`);
  for (const [name, val] of Object.entries(pins.before)) assert.ok(rev.includes(`'${val}'`), `the reverse script restores the ${name} body`);
  stageText('reverse.sql', rev);
  const r = apply('reverse.sql');
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(pinnedBodies(), pins.before, 'the three earlier bodies are back');
  okAs(asAdmin(savePo([poLine(PE, 2.5, 'Ea')], 'after-rollback')), 'after the rollback, a 2.5 Ea PO');
  refusedAs(probe(`UPDATE public.order_items SET total_units_needed = 2.5 WHERE id = '${OE}';`), WHOLE('Seed Ea', 'Ea', '2.5'), "#2675's order rule after the rollback");
  const twice = apply('reverse.sql');
  assert.notEqual(twice.status, 0);
  assert.match(twice.output, /WHOLE_ITEMS_FOLLOWUPS_REVERSE/);
  stageText('candidate.sql', lf(CANDIDATE));
  raw(`UPDATE public.purchase_order_items SET quantity_ordered = 3 WHERE product_id = '${PE}' AND quantity_ordered = 2.5;`);
  const re = apply('candidate.sql');
  assert.equal(re.status, 0, `re-apply after the rollback:\n${re.output}`);
  console.log('[rollback] the reverse script restores the three bodies (2.5 Ea PO saves again; #2675 order rule holds); a second run is refused; the migration re-applies');
}

function main() {
  buildContainer();
  seed();
  beforeCases();
  if (process.env.CRX_PROVER_STOP_BEFORE_CANDIDATE === "1") { console.log(JSON.stringify(pinnedBodies())); return; }
  const pins = applyCandidate();
  afterCases();
  rollbackCases(pins);
  console.log('WHOLE_ITEM_FOLLOWUPS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
