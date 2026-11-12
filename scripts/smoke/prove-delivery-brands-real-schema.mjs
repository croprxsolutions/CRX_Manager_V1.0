#!/usr/bin/env node
/**
 * Real-schema proof for 20270104120000_delivery_brands (Brand PR B, part B-1a; build sheet
 * docs/plans/2026-11-08-product-BRAND-PRB-BUILD-SHEET.md section 15.6).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, checks the replay reproduces the six live bodies the
 * candidate pins, completes one delivery the old way, applies the candidate (a second run refuses), then on invented
 * rows proves who may save, retry safety, brand-list checks, completion never blocked by brands, the stale-seq
 * check (direct and through start_and_complete_delivery), the completion rule, edit carry, admin correction with
 * the posted-invoice refusal, typed-brand review, the receipt lines, the office list, grants, and that no money,
 * quantity, stock or invoice column differs between a completion with picks and one without.
 *
 * Run: node scripts/smoke/prove-delivery-brands-real-schema.mjs   (needs Docker)
 * Prints DELIVERY_BRANDS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container (with a bb_snap
 * copy made after the replay); CRX_PROVER_REUSE=<container> reruns the cases from that copy.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REUSE = process.env.CRX_PROVER_REUSE || '';
const NAME = REUSE || `crx-brandb1-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = REUSE !== '' || process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270104120000_delivery_brands.sql');
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
const TOUCHED = /(complete_delivery|edit_delivery|_enqueue_delivery_receipt|delivery_items|product_parent_brands|product_brands|delivery_brand|delivery_item_brands)/i;
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


const raw = (sql) => psql(`SET session_replication_role = replica;\n${sql}\nSET session_replication_role = origin;`, { user: 'supabase_admin' });

// Copies a database inside the throwaway container (the copy needs its source idle). A used copy is renamed
// aside, never removed. shortcut: set-aside copies fill the 1 GB scratch disk after a few reuse runs; start a fresh
// kept container then.
function copyDatabase(from, to) {
  const sql = (s) => {
    for (let i = 0; ; i += 1) {
      ready();
      const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'template1', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', s], { allowFailure: true });
      if (r.status === 0) return r;
      if (i >= 20) throw new Error(`${s}\n${r.stderr}`);
      wait(1000);
    }
  };
  if (sql(`SELECT 1 FROM pg_database WHERE datname = '${to}';`).stdout.includes('1')) {
    sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${to}' AND pid <> pg_backend_pid();`);
    sql(`ALTER DATABASE ${to} RENAME TO used_${Date.now().toString(36)};`);
  }
  sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${from}' AND pid <> pg_backend_pid();`);
  sql(`CREATE DATABASE ${to} TEMPLATE ${from} OWNER postgres;`);
  wait(3000);
  sql(`SELECT 1 FROM pg_database WHERE datname = '${to}';`);
}

// ---------------------------------------------------------------------------------------------------------------
// Invented rows and helpers.
// ---------------------------------------------------------------------------------------------------------------
const id = (n) => `bb1a0000-0000-4000-8000-${Number(n).toString(16).padStart(12, '0')}`;
const ADMIN = id(1), REP = id(2), DRV = id(3), DRV2 = id(4), OLD = id(5);
const CUST = id(10);
const PAR = id(20), PAR2 = id(21);
const PB1 = id(30), PB2 = id(31), PB3 = id(32), PB5 = id(34);
const PG = id(40), PL = id(41), PL2 = id(42), PN = id(43), PL3 = id(44);
const LB1 = id(50), LB2 = id(51), LB3 = id(52), LB4 = id(53);
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
const NO_PROOF = 'No proof — recorded by office';

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
const num = (sql) => Number(scalar(sql));
const events = (d, type) => num(`SELECT count(*) FROM public.delivery_brand_events WHERE delivery_id = '${d}'${type ? ` AND event_type = '${type}'` : ''};`);
const maxSeq = (d) => num(`SELECT COALESCE(max(seq), 0) FROM public.delivery_brand_events WHERE delivery_id = '${d}' AND event_type <> 'line_removed';`);
const picks = (line) => JSON.parse(scalar(`SELECT COALESCE(jsonb_agg(jsonb_build_object('source', source, 'parent_brand_id', parent_brand_id,
  'legacy_brand_id', legacy_brand_id, 'brand_name', brand_name, 'epa', epa_registration, 'quantity', quantity, 'review_state', review_state,
  'review_note', review_note) ORDER BY lower(brand_name), COALESCE(epa_registration, '')), '[]') FROM public.delivery_item_brands
  WHERE delivery_item_id = '${line}' AND superseded_at IS NULL;`));
const status = (d) => scalar(`SELECT status FROM public.deliveries WHERE id = '${d}';`);

// Delivery n: its order, order items, delivery and lines (each [product, quantity]); line k is DI(n, k).
const D = (n) => id(0x1000 + n);
const O = (n) => id(0x2000 + n);
const OI = (n, k) => id(0x30000 + n * 16 + k);
const DI = (n, k) => id(0x40000 + n * 16 + k);
function mkDelivery(n, lines, { st = 'in_progress', driver = DRV } = {}) {
  raw(`INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${O(n)}', 'PROVER-BB-${n}', '${CUST}', current_date, 'confirmed', false, '${ADMIN}');
    ${lines.map(([p, qty], k) => `INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
      VALUES ('${OI(n, k)}', '${O(n)}', '${p}', '[PROVER] BB product', 10, 6, ${qty}, ${qty * 10}, ${qty * 4}, 40, 0, ${qty});`).join('\n')}
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver)
      VALUES ('${D(n)}', 'PROVER-BB-D${n}', '${O(n)}', '${CUST}', '${ADMIN}', '${st}', current_date, ${q(driver)});
    ${lines.map(([p, qty], k) => `INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${DI(n, k)}', '${D(n)}', '${OI(n, k)}', '${p}', ${qty}, 'GL');`).join('\n')}`);
}
const SET = (d, lines, seq, key) => `SELECT public.set_delivery_brands('${d}', ${J(lines)}, ${seq === null ? 'NULL' : seq}, ${q(key)})::text;`;
const set = (uid, d, lines, key, seq = maxSeq(d)) => JSON.parse(ok(uid, SET(d, lines, seq, key)));
const COMPLETE = (d, qtys, key, { seq = null, receipt = null } = {}) => `SELECT public.complete_delivery(p_delivery_id => '${d}',
  p_signed_by => '${NO_PROOF}', p_performed_by => '${ADMIN}', p_quantities => ${J(qtys)}, p_idempotency_key => ${q(key)},
  p_evidence => 'no_proof', p_evidence_ref => '[PROVER] no proof on the stop'${receipt === null ? '' : `, p_email_receipt => ${receipt}`}${seq === null ? '' : `, p_brand_base_seq => ${seq}`})::text;`;
const CORRECT = (d, lines, reason, seq, key) => `SELECT public.correct_delivery_brands('${d}', ${J(lines)}, ${q(reason)}, ${seq}, ${q(key)})::text;`;
const pick = (brand_id, quantity) => ({ brand_id, quantity });
const typed = (typed_name, quantity, typed_epa = null) => ({ typed_name, typed_epa, quantity });

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'bb-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'bb-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('${DRV}', 'bb-driver@example.invalid', '{"full_name":"[PROVER] Driver","role":"driver"}'::jsonb),
    ('${DRV2}', 'bb-driver2@example.invalid', '{"full_name":"[PROVER] Other Driver","role":"driver"}'::jsonb),
    ('${OLD}', 'bb-old@example.invalid', '{"full_name":"[PROVER] Former Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id IN ('${DRV}', '${DRV2}');
    UPDATE public.profiles SET role = 'admin', is_active = false WHERE id = '${OLD}';
    INSERT INTO public.customers (id, farm_name, is_active, email, contact_name) VALUES
      ('${CUST}', '[PROVER] BB Farm', true, 'bb-farm@example.invalid', 'Pat Prover');
    INSERT INTO public.products (id, product_name, sku, unit_size, product_form, current_cost, tier1_price, is_active) VALUES
      ('${PG}', '[PROVER] Grouped 2.5', 'BB-PG', 'GL', 'liquid', 6.00, 10.00, true),
      ('${PL}', '[PROVER] Legacy 2.5', 'BB-PL', 'GL', 'liquid', 6.00, 10.00, true),
      ('${PL2}', '[PROVER] Legacy other size', 'BB-PL2', 'GL', 'liquid', 6.00, 10.00, true),
      ('${PN}', '[PROVER] No brands', 'BB-PN', 'GL', 'liquid', 6.00, 10.00, true),
      ('${PL3}', '[PROVER] Legacy to be grouped', 'BB-PL3', 'GL', 'liquid', 6.00, 10.00, true);
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
      SELECT p, 'Main Warehouse', 1000, 0, 'GL' FROM unnest(ARRAY['${PG}', '${PL}', '${PL2}', '${PN}', '${PL3}']::uuid[]) p;
    INSERT INTO public.product_parents (id, name, product_form, created_by, updated_by) VALUES
      ('${PAR}', '[PROVER] Parent A', 'liquid', '${ADMIN}', '${ADMIN}'),
      ('${PAR2}', '[PROVER] Parent B', 'liquid', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_members (product_id, parent_id, added_by) VALUES ('${PG}', '${PAR}', '${ADMIN}');
    INSERT INTO public.product_parent_brands (id, parent_id, brand_name, epa_registration, signal_word, status, created_by, updated_by) VALUES
      ('${PB1}', '${PAR}', 'Alpha', '100-1', 'Caution', 'active', '${ADMIN}', '${ADMIN}'),
      ('${PB2}', '${PAR}', 'Bravo', '100-2', 'Warning', 'active', '${ADMIN}', '${ADMIN}'),
      ('${PB3}', '${PAR}', 'Retired Brand', '100-3', NULL, 'retired', '${ADMIN}', '${ADMIN}'),
      ('${PB5}', '${PAR2}', 'Golf', '300-1', NULL, 'active', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_brands (id, product_id, brand_name, epa_registration, signal_word, is_rup, created_by, updated_by) VALUES
      ('${LB1}', '${PL}', 'Delta', '200-1', 'Caution', false, '${ADMIN}', '${ADMIN}'),
      ('${LB2}', '${PL}', 'Echo', NULL, NULL, false, '${ADMIN}', '${ADMIN}'),
      ('${LB3}', '${PL2}', 'Foxtrot', '200-3', NULL, false, '${ADMIN}', '${ADMIN}'),
      ('${LB4}', '${PL3}', 'Hotel', '200-4', NULL, false, '${ADMIN}', '${ADMIN}');`);
  console.log('[prover] seeded: admin, rep, two drivers, an inactive admin, a grouped size with three parent brands (one retired), a second parent, three legacy sizes and an unbranded size');
}

const LIVE_MD5 = {
  _complete_delivery_aggregate_impl: 'b888901587accbee7f7fe4aeb512e683',
  complete_delivery: 'eed8da07fedbec14a198ca4f6e26c213',
  start_and_complete_delivery: '640603e6dce34abc1fe18d4dad6adc56',
  edit_delivery: '99d606e01caacc135c9469eedba11491',
  _enqueue_delivery_receipt: 'edd5ddb32392517994c6587654c9cbc7',
  _edit_delivery_replay_impl_20261015: '942011a2bf15b83269e74830fa057377',
};
const PUBLIC_FNS = ['public.set_delivery_brands(uuid,jsonb,bigint,text)', 'public.correct_delivery_brands(uuid,jsonb,text,bigint,text)',
  'public.review_typed_brand(uuid,text,uuid,text,text)', 'public.get_delivery_brands(uuid)', 'public.get_typed_brands_for_review()',
  'public.get_deliveries_missing_brands(date,date)'];
const PRIVATE_FNS = ['public._delivery_line_brand_list(uuid)', 'public._delivery_brand_max_seq(uuid)', 'public._delivery_brand_rows(uuid,uuid[])',
  'public._delivery_brand_event(uuid,text,text,uuid[],jsonb,jsonb,jsonb)', 'public._delivery_brand_resolve_picks(uuid,jsonb)',
  'public._delivery_brand_insert(uuid,uuid,uuid,jsonb)', 'public._delivery_brands_on_complete(uuid,boolean)',
  'public._delivery_brand_may_read(uuid)', 'public._delivery_brand_events_append_only()',
  'public._complete_delivery_evidence_impl_20270104(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean)',
  'public._start_and_complete_delivery_impl_20270104(uuid,text,date,uuid,jsonb,text,text,text,text,text)'];
// What a completion changes in money, quantity, stock and invoices, with ids and times left out.
const moneyShape = (d) => scalar(`SELECT jsonb_build_object(
  'delivery', (SELECT jsonb_build_object('status', status) FROM public.deliveries WHERE id = '${d}'),
  'lines', (SELECT jsonb_agg(jsonb_build_object('q', quantity, 'qd', quantity_delivered) ORDER BY id) FROM public.delivery_items WHERE delivery_id = '${d}'),
  'order_items', (SELECT jsonb_agg(jsonb_build_object('qd', oi.quantity_delivered, 'qr', oi.quantity_remaining) ORDER BY oi.id)
                    FROM public.order_items oi JOIN public.deliveries x ON x.order_id = oi.order_id WHERE x.id = '${d}'),
  'invoices', (SELECT jsonb_agg((to_jsonb(i) - ARRAY['id','invoice_number','order_id','delivery_id','created_at','updated_at','created_by','invoice_date','due_date','posted_at','idempotency_key','notes','po_number']) ORDER BY i.id)
                 FROM public.invoices i WHERE i.delivery_id = '${d}'),
  'invoice_items', (SELECT jsonb_agg((to_jsonb(ii) - ARRAY['id','invoice_id','order_item_id','delivery_item_id','created_at','updated_at']) ORDER BY ii.quantity, ii.extended_cents)
                      FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id WHERE i.delivery_id = '${d}'))::text;`);
const stock = (p) => scalar(`SELECT quantity_available || '/' || quantity_prebooked FROM public.inventory WHERE product_id = '${p}';`);

async function main() {
  if (REUSE) {
    // Only this prover's own throwaway containers, and only once the saved copy exists, so a mistyped name never renames a real database.
    if (!/^crx-brandb1-\d+-[a-z0-9]+$/.test(REUSE)) throw new Error(`CRX_PROVER_REUSE must name a crx-brandb1-<pid>-<id> prover container, got ${REUSE}`);
    if (scalar(`SELECT count(*) FROM pg_database WHERE datname = 'bb_snap';`) !== '1') throw new Error(`${REUSE} has no bb_snap copy; run the prover fresh`);
    copyDatabase('bb_snap', 'postgres');
  } else {
    buildContainer();
    if (KEEP) copyDatabase('postgres', 'bb_snap');
  }

  // 0. The replay reproduces the five live bodies the candidate pins (so the preflight is tested against live), and the receipt helper it must leave alone.
  for (const [fn, md5] of Object.entries(LIVE_MD5)) {
    assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '${fn}';`), md5, `${fn} replay differs from live`);
  }
  seed();
  // A delivery completed the old way, before the candidate; its key replays after it with no brand event.
  mkDelivery(0, [[PG, 10]]);
  const legacy = ok(ADMIN, COMPLETE(D(0), { [DI(0, 0)]: 10 }, 'bb-legacy-0'));
  console.log('[prover] case 0: the replay reproduces the six live bodies; one delivery completed before the candidate');

  // 1. Apply: one transaction, once.
  stageText('candidate.sql', lf(CANDIDATE));
  let r = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.match(`${r.stdout}\n${r.stderr}`, /DELIVERY_BRANDS_NOT_IN_TRANSACTION/);
  r = apply('candidate.sql'); assert.equal(r.status, 0, r.output);
  r = apply('candidate.sql'); assert.notEqual(r.status, 0); assert.match(r.output, /PREFLIGHT_DELIVERY_BRANDS_(DRIFT|ALREADY_APPLIED)/);
  assert.equal(ok(ADMIN, COMPLETE(D(0), { [DI(0, 0)]: 10 }, 'bb-legacy-0')), legacy, 'a pre-apply completion replays its saved answer');
  assert.equal(events(D(0)), 0);
  console.log('[prover] case 1: outside a transaction it refuses; it applies once; a second run refuses; an old completion replays unchanged with no brand event');

  // 2. Grants and ownership.
  for (const sig of [...PUBLIC_FNS, ...PRIVATE_FNS]) {
    const row = scalar(`SELECT pg_get_userbyid(p.proowner) || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE') || '|'
      || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')
      || '|' || (p.prosecdef = false OR p.proconfig @> ARRAY['search_path=public, pg_temp'])
      FROM pg_proc p WHERE p.oid = '${sig}'::regprocedure;`);
    assert.equal(row, `postgres|${PUBLIC_FNS.includes(sig)}|false|false|true`, sig);
  }
  for (const t of ['delivery_item_brands', 'delivery_brand_events']) {
    assert.equal(scalar(`SELECT relrowsecurity || '|' || has_table_privilege('authenticated', 'public.${t}', 'SELECT') || '|'
      || has_table_privilege('authenticated', 'public.${t}', 'INSERT,UPDATE,DELETE,TRUNCATE') || '|' || has_table_privilege('anon', 'public.${t}', 'SELECT')
      FROM pg_class WHERE oid = 'public.${t}'::regclass;`), 'true|true|false|false', t);
  }
  assert.equal(scalar(`SELECT has_function_privilege('service_role', 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean,bigint)', 'EXECUTE')
    || '|' || has_function_privilege('service_role', 'public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint)', 'EXECUTE');`), 'true|false');
  console.log('[prover] case 2: every new function is owned by postgres with a pinned search_path; only the six public ones run for signed-in users; app roles only read the tables');

  // 3. Who may save, and retry safety.
  mkDelivery(1, [[PG, 10], [PL, 5], [PN, 4]]);
  const L1 = [{ delivery_item_id: DI(1, 0), picks: [pick(PB1, 6), pick(PB2, 4)] }];
  refused(DRV2, SET(D(1), L1, 0, 'bb-k1'), /NOT_AUTHORIZED/);
  refused(OLD, SET(D(1), L1, 0, 'bb-k1'), /NOT_AUTHORIZED/);
  refused(null, SET(D(1), L1, 0, 'bb-k1'), /permission denied/);
  refused(DRV, SET(D(1), L1, 0, null), /IDEMPOTENCY_KEY_REQUIRED/);
  const first = set(DRV, D(1), L1, 'bb-k1', 0);
  assert.equal(JSON.stringify(set(DRV, D(1), L1, 'bb-k1', 0)), JSON.stringify(first), 'same key, same save: same answer');
  assert.equal(events(D(1), 'set'), 1);
  refused(DRV, SET(D(1), [{ delivery_item_id: DI(1, 0), picks: [pick(PB1, 10)] }], 0, 'bb-k1'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  refused(REP, SET(D(1), L1, 0, 'bb-k1'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  refused(DRV, SET(D(1), L1, maxSeq(D(1)), 'bb-legacy-0'), /IDEMPOTENCY_(CROSS_OP_KEY_REUSE|PAYLOAD_MISMATCH)/);
  // The driver read rule: an inactive assigned driver loses it.
  raw(`UPDATE public.profiles SET is_active = false WHERE id = '${DRV}';`);
  refused(DRV, `SELECT public.get_delivery_brands('${D(1)}')::text;`, /NOT_AUTHORIZED/);
  assert.equal(ok(DRV, `SELECT count(*) FROM public.delivery_item_brands WHERE delivery_id = '${D(1)}';`), '0');
  raw(`UPDATE public.profiles SET is_active = true WHERE id = '${DRV}';`);
  assert.equal(ok(DRV, `SELECT count(*) FROM public.delivery_item_brands WHERE delivery_id = '${D(1)}';`), '2');
  assert.equal(ok(DRV2, `SELECT count(*) FROM public.delivery_item_brands WHERE delivery_id = '${D(1)}';`), '0');
  refused(DRV2, `SELECT public.get_delivery_brands('${D(1)}')::text;`, /NOT_AUTHORIZED/);
  const view = js(DRV, `SELECT public.get_delivery_brands('${D(1)}')::text;`);
  assert.equal(view.event_seq, maxSeq(D(1)));
  assert.deepEqual(view.lines.find((l) => l.delivery_item_id === DI(1, 0)).brand_list.map((b) => b.brand_name).sort(), ['Alpha', 'Bravo']);
  refused(DRV, `INSERT INTO public.delivery_item_brands (delivery_item_id, delivery_id, product_id, source, brand_name, quantity, review_state)
    VALUES ('${DI(1, 2)}', '${D(1)}', '${PN}', 'typed', 'x', 1, 'pending');`, /permission denied/);
  console.log('[prover] case 3: another driver, an inactive user and anon are refused; same key replays once; another payload, actor or operation is refused; reads follow the delivery rule');

  // 4. Brand-list checks, typed names, amounts, stale saves.
  const bad = (line, picksIn, pattern) => refused(REP, SET(D(1), [{ delivery_item_id: line, picks: picksIn }], maxSeq(D(1)), `bb-bad-${Math.random()}`), pattern);
  bad(DI(1, 0), [pick(PB5, 1)], /BRAND_NOT_FOR_PRODUCT/);   // another parent's brand
  bad(DI(1, 1), [pick(LB3, 1)], /BRAND_NOT_FOR_PRODUCT/);   // another size's legacy brand
  bad(DI(1, 0), [pick(PB3, 1)], /BRAND_NOT_FOR_PRODUCT/);   // retired parent brand
  bad(DI(1, 0), [pick(LB1, 1)], /BRAND_NOT_FOR_PRODUCT/);   // a legacy brand on a grouped size
  bad(DI(1, 0), [pick(PB1, 0)], /BRAND_PICK_QUANTITY_INVALID/);
  bad(DI(1, 0), [pick(PB1, 1.23456)], /BRAND_PICK_QUANTITY_INVALID/);
  bad(DI(1, 0), [pick(PB1, 6), pick(PB2, 5)], /BRAND_SPLIT_OVER_LOADED/);
  bad(DI(1, 0), [pick(PB1, 1), typed(' alpha ', 1)], /BRAND_PICK_DUPLICATE/);
  bad(DI(1, 0), [typed('', 1)], /BRAND_TYPED_NAME_REQUIRED/);
  bad(DI(1, 0), [typed('Zulu', 1, 'not a number')], /BRAND_EPA_NUMBER_INVALID/);
  bad(id(999), [pick(PB1, 1)], /DELIVERY_ITEM_NOT_ON_DELIVERY/);
  raw(`UPDATE public.product_parent_brands SET is_currently_sourced = false WHERE id = '${PB2}';`);
  set(REP, D(1), [
    { delivery_item_id: DI(1, 0), picks: [typed('alpha', 3), pick(PB2, 2), typed('Alpha', 1, '999-9'), typed('Zulu', 1.5)] },
    { delivery_item_id: DI(1, 1), picks: [typed('ECHO', 5)] }], 'bb-k2');
  raw(`UPDATE public.product_parent_brands SET is_currently_sourced = true WHERE id = '${PB2}';`);
  assert.deepEqual(picks(DI(1, 0)), [
    { source: 'parent', parent_brand_id: PB1, legacy_brand_id: null, brand_name: 'Alpha', epa: '100-1', quantity: 3, review_state: null, review_note: null },
    { source: 'typed', parent_brand_id: null, legacy_brand_id: null, brand_name: 'Alpha', epa: '999-9', quantity: 1, review_state: 'pending', review_note: 'number_differs_from_list' },
    { source: 'parent', parent_brand_id: PB2, legacy_brand_id: null, brand_name: 'Bravo', epa: '100-2', quantity: 2, review_state: null, review_note: null },
    { source: 'typed', parent_brand_id: null, legacy_brand_id: null, brand_name: 'Zulu', epa: null, quantity: 1.5, review_state: 'pending', review_note: null }]);
  assert.deepEqual(picks(DI(1, 1)), [{ source: 'size', parent_brand_id: null, legacy_brand_id: LB2, brand_name: 'Echo', epa: null, quantity: 5, review_state: null, review_note: null }]);
  refused(REP, SET(D(1), [{ delivery_item_id: DI(1, 1), picks: [] }], maxSeq(D(1)) - 1, 'bb-stale'), /BRAND_PICKS_CHANGED/);
  console.log('[prover] case 4: another parent\'s, another size\'s, a retired or a legacy-on-grouped brand is refused; a not-currently-sourced brand is accepted; a typed name matching one listed brand becomes it, a different number stays typed for review; bad amounts, over-loaded splits, duplicates and stale saves are refused');

  // 5. Completion is never blocked by brands, and applies the completion rule. D1: line 0 loaded 10 with picks
  // adding to 7.5 (delivers 8); line 1 delivers 0 with a pick (dropped); line 2 unbranded. D2: one pick of 10,
  // 6 delivered (trimmed to 6); a branded line with no pick.
  mkDelivery(2, [[PL, 10], [PG, 3]]);
  set(ADMIN, D(2), [{ delivery_item_id: DI(2, 0), picks: [pick(LB1, 10)] }], 'bb-k3');
  const before1 = maxSeq(D(1));
  ok(ADMIN, COMPLETE(D(1), { [DI(1, 0)]: 8, [DI(1, 1)]: 0, [DI(1, 2)]: 4 }, 'bb-c1'));
  ok(ADMIN, COMPLETE(D(2), { [DI(2, 0)]: 6, [DI(2, 1)]: 3 }, 'bb-c2'));
  assert.equal(status(D(1)), 'completed'); assert.equal(status(D(2)), 'completed');
  assert.equal(picks(DI(1, 0)).length, 4, 'a split that does not add up is kept as recorded');
  assert.deepEqual(picks(DI(1, 1)), [], 'zero delivered keeps no picks');
  assert.deepEqual(picks(DI(2, 0)).map((p) => p.quantity), [6], 'one pick above delivered is trimmed');
  const done1 = JSON.parse(scalar(`SELECT details::text FROM public.delivery_brand_events WHERE delivery_id = '${D(1)}' AND event_type = 'completed';`));
  assert.equal(done1.picks_confirmed, null, 'no seq sent (the app before B-2) records not stated');
  assert.deepEqual(done1.lines.map((l) => [l.delivery_item_id, Number(l.quantity_delivered), Number(l.brand_list_size)]).sort(),
    [[DI(1, 0), 8, 2], [DI(1, 1), 0, 2], [DI(1, 2), 4, 0]].sort());
  assert.ok(maxSeq(D(1)) > before1);
  ok(ADMIN, COMPLETE(D(1), { [DI(1, 0)]: 8, [DI(1, 1)]: 0, [DI(1, 2)]: 4 }, 'bb-c1'));
  assert.equal(events(D(1), 'completed'), 1, 'a replay writes no second event');
  refused(REP, SET(D(1), [{ delivery_item_id: DI(1, 2), picks: [] }], maxSeq(D(1)), 'bb-k4'), /DELIVERY_BRANDS_LOCKED/);
  console.log('[prover] case 5: a split that does not add up, a branded line with no pick and zero delivered all complete; zero keeps no picks, one pick above delivered is trimmed, one completed event records delivered amounts and list sizes; a replay adds none; saving after completion is refused');

  // 6. The stale-picks check, direct and through start_and_complete_delivery (the nested call keeps the value).
  mkDelivery(3, [[PG, 4]]);
  set(REP, D(3), [{ delivery_item_id: DI(3, 0), picks: [pick(PB1, 4)] }], 'bb-k5');
  const loaded = maxSeq(D(3));
  set(DRV, D(3), [{ delivery_item_id: DI(3, 0), picks: [pick(PB2, 4)] }], 'bb-k6');
  const stock3 = stock(PG);
  r = psql(`BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true); SET LOCAL ROLE authenticated;
    ${COMPLETE(D(3), { [DI(3, 0)]: 4 }, 'bb-c3b', { seq: -1 })} ROLLBACK;`, { allowFailure: true });
  assert.doesNotMatch(`${r.stdout}
${r.stderr}`, /ERROR/, 'a negative seq never refuses a completion (reads as not confirmed)');
  r = psql(`BEGIN; SELECT set_config('crx.brand_base_seq', 'not-a-number', true);
    SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true); SET LOCAL ROLE authenticated;
    ${COMPLETE(D(3), { [DI(3, 0)]: 4 }, 'bb-c3g')} ROLLBACK;`, { allowFailure: true });
  assert.doesNotMatch(`${r.stdout}
${r.stderr}`, /ERROR/, 'a garbage setting never errors a completion');
  assert.equal(status(D(3)), 'in_progress'); assert.equal(stock(PG), stock3); assert.equal(events(D(3), 'completed'), 0);
  ok(ADMIN, COMPLETE(D(3), { [DI(3, 0)]: 4 }, 'bb-c3', { seq: loaded }));
  assert.equal(status(D(3)), 'completed', 'a stale brand seq never refuses the completion');
  assert.equal(JSON.parse(scalar(`SELECT details::text FROM public.delivery_brand_events WHERE delivery_id = '${D(3)}' AND event_type = 'completed';`)).picks_confirmed, false);
  assert.equal(picks(DI(3, 0))[0].parent_brand_id, PB2, 'it completes against the current picks');
  assert.equal(scalar(`SELECT current_setting('crx.brand_base_seq', true);`), '', 'the setting never outlives a call');
  mkDelivery(4, [[PG, 2]], { st: 'scheduled' });
  set(REP, D(4), [{ delivery_item_id: DI(4, 0), picks: [pick(PB1, 2)] }], 'bb-k7');
  const START = (seq, key) => `SELECT public.start_and_complete_delivery(p_delivery_id => '${D(4)}', p_signed_by => '${NO_PROOF}',
    p_delivered_on => current_date, p_performed_by => '${ADMIN}', p_quantities => ${J({ [DI(4, 0)]: 2 })}, p_idempotency_key => '${key}',
    p_evidence => 'no_proof', p_evidence_ref => '[PROVER] no proof on the stop', p_brand_base_seq => ${seq})::text;`;
  assert.equal(status(D(4)), 'scheduled');
  ok(ADMIN, START(maxSeq(D(4)), 'bb-s4b'));
  assert.equal(status(D(4)), 'completed');
  assert.equal(JSON.parse(scalar(`SELECT details::text FROM public.delivery_brand_events WHERE delivery_id = '${D(4)}' AND event_type = 'completed';`)).picks_confirmed, true);
  console.log('[prover] case 6: a stale seq still completes, against the current picks, recorded as not confirmed; a malformed or negative seq never errors and reads as not confirmed; the current seq (direct and through start_and_complete) completes with picks confirmed');

  // 7. A legacy pick whose size is grouped before completion follows its parent brand; the snapshot stays.
  mkDelivery(5, [[PL3, 3]]);
  set(REP, D(5), [{ delivery_item_id: DI(5, 0), picks: [pick(LB4, 3)] }], 'bb-k8');
  raw(`INSERT INTO public.product_parent_members (product_id, parent_id, added_by) VALUES ('${PL3}', '${PAR}', '${ADMIN}');
    INSERT INTO public.product_parent_brands (id, parent_id, brand_name, epa_registration, status, created_by, updated_by)
      VALUES ('${id(35)}', '${PAR}', 'Hotel', '200-4', 'active', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_brand_sources (legacy_brand_id, parent_brand_id, legacy_row_version, mapped_by)
      VALUES ('${LB4}', '${id(35)}', 1, '${ADMIN}');`);
  ok(ADMIN, COMPLETE(D(5), { [DI(5, 0)]: 3 }, 'bb-c5'));
  assert.deepEqual(picks(DI(5, 0)), [{ source: 'parent', parent_brand_id: id(35), legacy_brand_id: null, brand_name: 'Hotel', epa: '200-4', quantity: 3, review_state: null, review_note: null }]);
  console.log('[prover] case 7: a legacy pick on a size grouped before completion is re-pointed to its parent brand, snapshot unchanged');

  // 8. edit_delivery carries picks across re-created lines.
  mkDelivery(6, [[PG, 5], [PL, 4]], { st: 'scheduled' });
  set(REP, D(6), [{ delivery_item_id: DI(6, 0), picks: [pick(PB1, 5)] }, { delivery_item_id: DI(6, 1), picks: [pick(LB1, 1), typed('Kilo', 3)] }], 'bb-k9');
  const items = (q1, q2) => [{ order_item_id: OI(6, 0), product_id: PG, quantity: q1, unit_size: 'GL' }, { order_item_id: OI(6, 1), product_id: PL, quantity: q2, unit_size: 'GL' }];
  const EDIT = (it, key) => `SELECT public.edit_delivery(p_delivery_id => '${D(6)}', p_scheduled_date => current_date + 1, p_items => ${J(it)}, p_idempotency_key => '${key}')::text;`;
  const e1 = js(ADMIN, EDIT(items(5, 4), 'bb-e1'));
  const lines6 = () => JSON.parse(scalar(`SELECT jsonb_agg(id ORDER BY product_id) FROM public.delivery_items WHERE delivery_id = '${D(6)}';`));
  const [n0, n1] = lines6().map(String);
  assert.ok(![DI(6, 0), DI(6, 1)].includes(n0), 'the body re-created the lines');
  assert.equal(e1.brand_picks_kept.length, 2); assert.equal(e1.brand_lines_dropped.length, 0);
  assert.equal(picks(n0).length + picks(n1).length, 3);
  assert.equal(scalar(`SELECT count(*) FROM public.delivery_item_brands WHERE delivery_id = '${D(6)}' AND brand_name = 'Kilo' AND review_state = 'pending' AND entered_by = '${REP}';`), '1', 'entry and review fields carried');
  assert.equal(JSON.stringify(js(ADMIN, EDIT(items(5, 4), 'bb-e1'))), JSON.stringify(e1), 'a replay returns the same answer, brand fields included');
  assert.equal(events(D(6), 'edited'), 1);
  const e2 = js(ADMIN, EDIT(items(5, 3), 'bb-e2'));
  assert.equal(e2.brand_picks_kept.length, 1); assert.equal(e2.brand_lines_dropped.length, 1);
  assert.equal(scalar(`SELECT count(*) FROM public.delivery_item_brands b JOIN public.delivery_items di ON di.id = b.delivery_item_id WHERE b.delivery_id = '${D(6)}' AND di.product_id = '${PL}';`), '0');
  assert.equal(events(D(6), 'edited'), 2);
  assert.equal(events(D(6), 'line_removed'), 0, 'edit_delivery records its re-create once, as edited');
  refused(REP, SET(D(6), [{ delivery_item_id: lines6()[0], picks: [] }], maxSeq(D(6)) - 1, 'bb-k10'), /BRAND_PICKS_CHANGED/);
  console.log('[prover] case 8: an edit that keeps a line keeps its picks (with entry and review history) under the new id; a changed quantity drops that line\'s picks; each writes one edited event; a replay answers the same; a save from before the edit is stale');

  // 9. Admin correction after completion.
  const C = (lines, seq, key, uid = ADMIN, reason = 'jug label read wrong') => as(uid, CORRECT(D(2), lines, reason, seq, key));
  const fix = [{ delivery_item_id: DI(2, 0), picks: [pick(LB1, 4), pick(LB2, 2)] }];
  refused(REP, CORRECT(D(2), fix, 'x', maxSeq(D(2)), 'bb-x1'), /ADMIN_REQUIRED/);
  refused(OLD, CORRECT(D(2), fix, 'x', maxSeq(D(2)), 'bb-x1'), /ADMIN_REQUIRED/);
  refused(ADMIN, CORRECT(D(2), fix, '  ', maxSeq(D(2)), 'bb-x1'), /BRAND_CORRECTION_REASON_REQUIRED/);
  refused(ADMIN, CORRECT(D(2), [{ delivery_item_id: DI(2, 0), picks: [pick(LB1, 5)] }], 'x', maxSeq(D(2)), 'bb-x1'), /BRAND_SPLIT_NOT_DELIVERED/);
  refused(ADMIN, CORRECT(D(3), fix, 'x', maxSeq(D(3)), 'bb-x1'), /DELIVERY_ITEM_NOT_ON_DELIVERY/);
  refused(ADMIN, CORRECT(D(6), [{ delivery_item_id: lines6()[0], picks: [] }], 'x', maxSeq(D(6)), 'bb-x1'), /DELIVERY_NOT_COMPLETED/);
  const inv2 = scalar(`SELECT id FROM public.invoices WHERE delivery_id = '${D(2)}' AND deleted_at IS NULL;`);
  assert.ok(inv2, 'completion drafted an invoice');
  raw(`SET session_replication_role = replica; UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${inv2}';`);
  refused(ADMIN, CORRECT(D(2), fix, 'x', maxSeq(D(2)), 'bb-x2'), /INVOICE_POSTED/);
  raw(`SET session_replication_role = replica; UPDATE public.invoices SET status = 'draft', posted_at = NULL WHERE id = '${inv2}';`);
  const base2 = maxSeq(D(2));
  const old2 = scalar(`SELECT id FROM public.delivery_item_brands WHERE delivery_item_id = '${DI(2, 0)}' AND superseded_at IS NULL;`);
  const c1 = JSON.parse(C(fix, base2, 'bb-x3').rows.at(-1));
  assert.deepEqual(c1.invoice_ids, [inv2]);
  assert.deepEqual(picks(DI(2, 0)).map((p) => [p.brand_name, p.quantity]), [['Delta', 4], ['Echo', 2]]);
  assert.equal(scalar(`SELECT superseded_by_event_seq = ${c1.event_seq} AND supersede_reason = 'jug label read wrong' FROM public.delivery_item_brands WHERE id = '${old2}';`), 't');
  const ev = JSON.parse(scalar(`SELECT jsonb_build_object('after', after_rows, 'before', before_rows)::text FROM public.delivery_brand_events WHERE seq = ${c1.event_seq};`));
  assert.deepEqual(ev.after.map((x) => x.id).sort(), JSON.parse(scalar(`SELECT jsonb_agg(id) FROM public.delivery_item_brands WHERE delivery_item_id = '${DI(2, 0)}' AND superseded_at IS NULL;`)).sort());
  assert.equal(ev.before.length, 1);
  refused(ADMIN, CORRECT(D(2), [{ delivery_item_id: DI(2, 0), picks: [] }], 'second', base2, 'bb-x4'), /BRAND_PICKS_CHANGED/);
  JSON.parse(C([{ delivery_item_id: DI(2, 0), picks: [] }], maxSeq(D(2)), 'bb-x5', ADMIN, 'brand not known').rows.at(-1));
  assert.deepEqual(picks(DI(2, 0)), [], 'a correction may empty a line');
  refused(ADMIN, `UPDATE public.delivery_brand_events SET reason = 'x';`, /permission denied/);
  r = psql(`UPDATE public.delivery_brand_events SET reason = 'x';`, { allowFailure: true });
  assert.match(`${r.stdout}\n${r.stderr}`, /DELIVERY_BRAND_EVENTS_APPEND_ONLY/);
  r = psql(`TRUNCATE public.delivery_brand_events CASCADE;`, { allowFailure: true });
  assert.match(`${r.stdout}\n${r.stderr}`, /DELIVERY_BRAND_EVENTS_APPEND_ONLY/);
  console.log('[prover] case 9: only an active admin corrects, with a reason and picks adding to delivered (or none); a posted invoice is refused; a draft is listed; old picks are superseded by the event, never overwritten; a second correction from the same base is stale; history cannot be changed');

  // 10. Typed-brand review.
  const queue = js(ADMIN, 'SELECT public.get_typed_brands_for_review()::text;');
  const zulu = queue.find((x) => x.brand_name === 'Zulu' && x.delivery_id === D(1));
  assert.ok(zulu, 'a pending typed pick is listed');
  refused(REP, 'SELECT public.get_typed_brands_for_review()::text;', /ADMIN_REQUIRED/);
  const REVIEW = (action, brand, key) => `SELECT public.review_typed_brand('${zulu.pick_id}', '${action}', ${q(brand)}, 'checked the jug', '${key}')::text;`;
  refused(REP, REVIEW('link', PB1, 'bb-r1'), /ADMIN_REQUIRED/);
  refused(ADMIN, REVIEW('link', PB5, 'bb-r1'), /BRAND_NOT_FOR_PRODUCT/);
  refused(ADMIN, REVIEW('keep', null, 'bb-r1'), /BRAND_REVIEW_ACTION_INVALID/);
  ok(ADMIN, REVIEW('link', PB1, 'bb-r2'));
  assert.equal(scalar(`SELECT review_state || '|' || review_brand_ref || '|' || brand_name FROM public.delivery_item_brands WHERE id = '${zulu.pick_id}';`), `added|${PB1}|Zulu`);
  ok(ADMIN, REVIEW('link', PB1, 'bb-r2'));
  assert.equal(events(D(1), 'reviewed'), 1, 'a replay writes no second event');
  refused(ADMIN, REVIEW('dismiss', null, 'bb-r3'), /BRAND_REVIEW_NOT_PENDING/);
  assert.ok(!js(ADMIN, 'SELECT public.get_typed_brands_for_review()::text;').some((x) => x.pick_id === zulu.pick_id));
  console.log('[prover] case 10: an admin links a typed pick to a brand on its list (snapshot unchanged) or dismisses it, once; others are refused');

  // 11. The receipt lines.
  mkDelivery(7, [[PG, 4], [PL, 2], [PN, 1], [PL2, 3], [PG, 3]]);
  set(REP, D(7), [{ delivery_item_id: DI(7, 0), picks: [pick(PB1, 3), typed('Lima', 1)] }, { delivery_item_id: DI(7, 3), picks: [pick(LB3, 3)] },
    { delivery_item_id: DI(7, 4), picks: [pick(PB1, 2), typed('Kilo', 1)] }], 'bb-k11');
  // A receipt is queued only for a completion with proof: left at site, with its photo.
  const photo = `delivery-photos/${D(7)}/drop.jpg`;
  raw(`INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
      VALUES ('delivery-photos', '${photo}', '${ADMIN}', '{"mimetype":"image/jpeg","size":"5000"}'::jsonb);
    INSERT INTO public.delivery_photos (id, delivery_id, storage_path, image_url, caption, uploaded_by)
      VALUES ('${id(77)}', '${D(7)}', '${photo}', '${photo}', 'Left at site — drop location', '${ADMIN}');`);
  ok(ADMIN, `SELECT public.complete_delivery(p_delivery_id => '${D(7)}', p_signed_by => 'No one present — left at site',
    p_performed_by => '${ADMIN}', p_quantities => ${J({ [DI(7, 0)]: 4, [DI(7, 1)]: 2, [DI(7, 2)]: 1, [DI(7, 3)]: 2, [DI(7, 4)]: 2 })}, p_idempotency_key => 'bb-c7',
    p_evidence => 'left_at_site', p_evidence_ref => '${id(77)}', p_email_receipt => true)::text;`);
  const receipt = JSON.parse(scalar(`SELECT receipt::text FROM public.delivery_receipt_queue WHERE delivery_id = '${D(7)}';`));
  assert.equal(receipt.lines.length, 5);
  assert.ok(receipt.lines.every((l) => Object.keys(l).sort().join() === 'name,qty'), 'receipt lines are exactly as before B-1a (brands ship with B-3)');
  assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._enqueue_delivery_receipt(uuid,uuid)'::regprocedure;`), LIVE_MD5._enqueue_delivery_receipt, 'the receipt helper is unchanged');
  console.log('[prover] case 11: a completion with picks queues the same receipt as before B-1a; the receipt helper is unchanged');

  // 12. The office list.
  refused(REP, `SELECT public.get_deliveries_missing_brands(current_date - 1, current_date + 1)::text;`, /ADMIN_REQUIRED/);
  refused(ADMIN, `SELECT public.get_deliveries_missing_brands(current_date, current_date - 1)::text;`, /DATE_RANGE_INVALID/);
  raw(`UPDATE public.product_parent_brands SET status = 'retired' WHERE id = '${PB2}';`); // a picked brand leaves the list
  const list = js(ADMIN, `SELECT public.get_deliveries_missing_brands(current_date - 2, current_date + 2)::text;`);
  const reasons = (line) => (list.find((x) => x.delivery_item_id === line) ?? { reasons: [] }).reasons.sort();
  assert.deepEqual(reasons(DI(0, 0)), ['completed_before_brand_capture']);
  assert.deepEqual(reasons(DI(1, 0)), ['brand_no_longer_listed', 'epa_number_not_recorded', 'split_does_not_match_delivered'], 'no seq sent is not flagged');
  assert.deepEqual(reasons(DI(1, 1)), [], 'zero delivered is not listed');
  assert.deepEqual(reasons(DI(1, 2)), [], 'an unbranded line is not listed');
  assert.deepEqual(reasons(DI(2, 1)), ['brand_not_recorded']);
  assert.deepEqual(reasons(DI(7, 1)), ['brand_not_recorded']);
  assert.deepEqual(reasons(DI(7, 0)), ['epa_number_not_recorded']);
  assert.deepEqual(reasons(DI(2, 0)), ['brand_not_recorded'], 'an emptied line goes back on the list');
  assert.deepEqual(reasons(DI(3, 0)), ['brand_no_longer_listed', 'picks_not_confirmed'], 'completed from an out-of-date screen');
  raw(`UPDATE public.product_parent_brands SET status = 'active' WHERE id = '${PB2}';`);
  // An out-of-date completion with one branded line left empty; a correction that adds its first pick confirms it.
  mkDelivery(12, [[PG, 2], [PG, 1]]);
  set(REP, D(12), [{ delivery_item_id: DI(12, 0), picks: [pick(PB1, 2)] }], 'bb-k12b');
  ok(ADMIN, COMPLETE(D(12), { [DI(12, 0)]: 2, [DI(12, 1)]: 1 }, 'bb-c12', { seq: 0 }));
  const list12 = () => js(ADMIN, 'SELECT public.get_deliveries_missing_brands(current_date - 2, current_date + 2)::text;');
  const why12 = (line) => (list12().find((x) => x.delivery_item_id === line) ?? { reasons: [] }).reasons.sort();
  assert.deepEqual(why12(DI(12, 0)), ['picks_not_confirmed']);
  assert.deepEqual(why12(DI(12, 1)), ['brand_not_recorded']);
  ok(ADMIN, CORRECT(D(12), [{ delivery_item_id: DI(12, 1), picks: [pick(PB1, 1)] }], 'read the jug', maxSeq(D(12)), 'bb-x12'));
  assert.deepEqual(why12(DI(12, 1)), [], 'a correction adding the first pick confirms the line');
  assert.deepEqual(why12(DI(12, 0)), ['picks_not_confirmed'], 'an uncorrected line stays listed');
  console.log('[prover] case 12: the office list shows what is missing (before capture, not recorded, split mismatch, no EPA number, completed from an out-of-date screen) and never zero-delivered or unbranded lines');

  // 13. Picks change no money, quantity, stock or invoice: the same delivery with and without picks.
  mkDelivery(8, [[PL2, 6], [PG, 2]]); mkDelivery(9, [[PL2, 6], [PG, 2]]);
  set(REP, D(9), [{ delivery_item_id: DI(9, 0), picks: [pick(LB3, 4), typed('Mike', 2)] }, { delivery_item_id: DI(9, 1), picks: [pick(PB2, 2)] }], 'bb-k12');
  const s0 = stock(PL2);
  ok(ADMIN, COMPLETE(D(8), { [DI(8, 0)]: 5, [DI(8, 1)]: 2 }, 'bb-c8'));
  const s1 = stock(PL2);
  ok(ADMIN, COMPLETE(D(9), { [DI(9, 0)]: 5, [DI(9, 1)]: 2 }, 'bb-c9'));
  const s2 = stock(PL2);
  assert.equal(moneyShape(D(9)), moneyShape(D(8)));
  const delta = (a, b) => a.split('/').map((x, i) => Number(x) - Number(b.split('/')[i])).join('/');
  assert.equal(delta(s2, s1), delta(s1, s0));
  console.log('[prover] case 13: a completion with picks and one without leave identical delivery, order, invoice and stock numbers');

  // 14. An office review does not make a driver's picks stale; a delivered amount finer than 4 places never blocks completion.
  mkDelivery(10, [[PL2, 6], [PG, 2]]);
  set(REP, D(10), [{ delivery_item_id: DI(10, 0), picks: [pick(LB3, 6)] }, { delivery_item_id: DI(10, 1), picks: [typed('Oscar', 2)] }], 'bb-k14');
  const seq10 = maxSeq(D(10));
  const oscar = js(ADMIN, 'SELECT public.get_typed_brands_for_review()::text;').find((x) => x.brand_name === 'Oscar' && x.delivery_id === D(10));
  assert.ok(oscar, 'the typed pick is listed for review');
  ok(ADMIN, `SELECT public.review_typed_brand('${oscar.pick_id}', 'dismiss', NULL, 'not a real brand', 'bb-r14')::text;`);
  assert.equal(events(D(10), 'reviewed'), 1);
  assert.ok(maxSeq(D(10)) > seq10, 'a review moves the stale-save base, so a driver save cannot undo a dismissal');
  ok(ADMIN, COMPLETE(D(10), { [DI(10, 0)]: 2.33333, [DI(10, 1)]: 2 }, 'bb-c14', { seq: seq10 }));
  assert.equal(status(D(10)), 'completed', 'a screen loaded before the review still completes');
  assert.equal(JSON.parse(scalar(`SELECT details::text FROM public.delivery_brand_events WHERE delivery_id = '${D(10)}' AND event_type = 'completed';`)).picks_confirmed, false);
  assert.equal(Number(picks(DI(10, 0))[0].quantity), 6, 'a pick is not trimmed to an amount it cannot hold');
  const miss10 = () => (js(ADMIN, 'SELECT public.get_deliveries_missing_brands(current_date - 2, current_date + 2)::text;')
    .find((x) => x.delivery_item_id === DI(10, 0)) ?? { reasons: [] }).reasons;
  assert.deepEqual(miss10().sort(), ['picks_not_confirmed', 'split_does_not_match_delivered']);
  ok(ADMIN, CORRECT(D(10), [{ delivery_item_id: DI(10, 0), picks: [pick(LB3, 2.3333)] }], 'match delivered', maxSeq(D(10)), 'bb-x14'));
  assert.deepEqual(miss10(), [], 'a correction to the 4-place delivered amount clears the line, and confirms it');
  console.log('[prover] case 14: a screen loaded before an office review still completes (picks not confirmed); a 5-place delivered amount completes, keeps the pick and lists it; a 4-place correction clears it');

  // 15. A line deleted outside edit_delivery records its picks first (history only; no delivery lock, base unchanged).
  mkDelivery(11, [[PL2, 4], [PG, 2]], { st: 'scheduled' });
  set(REP, D(11), [{ delivery_item_id: DI(11, 0), picks: [pick(LB3, 4)] }, { delivery_item_id: DI(11, 1), picks: [pick(PB1, 2)] }], 'bb-k15');
  const seq11 = maxSeq(D(11));
  const removedBefore = events(D(11), 'line_removed');
  ok(REP, `DELETE FROM public.delivery_items WHERE id = '${DI(11, 0)}' RETURNING id;`);
  assert.equal(num(`SELECT count(*) FROM public.delivery_items WHERE id = '${DI(11, 0)}';`), 0, 'the rep could delete the scheduled line');
  assert.equal(events(D(11), 'line_removed') - removedBefore, 1, 'one line_removed event');
  const ev11 = JSON.parse(scalar(`SELECT jsonb_build_object('before', before_rows, 'details', details)::text FROM public.delivery_brand_events
    WHERE delivery_id = '${D(11)}' AND event_type = 'line_removed';`));
  assert.equal(ev11.before.length, 1); assert.equal(ev11.details.delivery_item_id, DI(11, 0));
  assert.equal(maxSeq(D(11)), seq11, 'the removal is history only and does not move the stale-save base');
  refused(REP, SET(D(11), [{ delivery_item_id: DI(11, 0), picks: [] }], seq11, 'bb-k15b'), /DELIVERY_ITEM_NOT_ON_DELIVERY/);
  set(REP, D(11), [{ delivery_item_id: DI(11, 1), picks: [] }], 'bb-k15c', seq11);
  console.log('[prover] case 15: a direct delete of a line with picks records them in one line_removed event first; a save naming the gone line is refused, the rest still saves');

  console.log('DELIVERY_BRANDS_PROOF_PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
  else console.log(`[prover] kept ${NAME}`);
});
