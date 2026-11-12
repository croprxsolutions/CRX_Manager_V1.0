#!/usr/bin/env node
/**
 * Real-schema proof for 20270104130000_invoice_brands_rup (Brand PR B, part B-1b; build sheet
 * docs/plans/2026-11-08-product-BRAND-PRB-BUILD-SHEET.md sections 14.4 and 16).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (B-1a included), runs the REG-1 seed, completes one
 * branded delivery the old way, applies the candidate (a second run refuses), then on invented rows proves: the
 * backfill, grants, the invoice line's brand snapshot and number, the re-copy after an admin correction, per-brand
 * restricted-use records under each brand's number with exact cents, the frozen posted line, each brand problem
 * (no record, listed), two payers' exact shares, the mixed-record guard, unbranded lines unchanged, and typed-brand
 * review leaving out voided and cancelled deliveries.
 *
 * Run: node scripts/smoke/prove-invoice-brands-real-schema.mjs   (needs Docker)
 * Prints INVOICE_BRANDS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container (with a bb_snap
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
const NAME = REUSE || `crx-brandb1b-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = REUSE !== '' || process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270104130000_invoice_brands_rup.sql');
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
const TOUCHED = /(invoice_items|rup_sales_records|generate_rup_sales_records|get_epa_sales_to_check|get_rup_sales_register|_capture_invoice_line_rup|delivery_brand_events|delivery_item_brands|review_typed_brand|get_typed_brands_for_review|correct_delivery_brands)/i;
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
const id = (n) => `bb1b0000-0000-4000-8000-${Number(n).toString(16).padStart(12, '0')}`;
const ADMIN = id(1), REP = id(2), DRV = id(3);
const CUST = id(10), LAND = id(11);
const PAR = id(20);
const ALPHA = id(30), BRAVO = id(31), CHARLIE = id(32), DELTA = id(33), ECHO = id(34);
const PR = id(40), PX = id(41);
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
const ownerJs = (sql) => JSON.parse(scalar(sql));
const maxSeq = (d) => Number(scalar(`SELECT COALESCE(max(seq), 0) FROM public.delivery_brand_events WHERE delivery_id = '${d}' AND event_type <> 'line_removed';`));

const D = (n) => id(0x1000 + n);
const O = (n) => id(0x2000 + n);
const OI = (n, k) => id(0x30000 + n * 16 + k);
const DI = (n, k) => id(0x40000 + n * 16 + k);
function mkDelivery(n, lines, { st = 'in_progress' } = {}) {
  raw(`INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${O(n)}', 'PROVER-B1B-${n}', '${CUST}', current_date, 'confirmed', false, '${ADMIN}');
    ${lines.map(([p, qty], k) => `INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
      VALUES ('${OI(n, k)}', '${O(n)}', '${p}', '[PROVER] B1B product', 10, 6, ${qty}, ${qty * 10}, ${qty * 4}, 40, 0, ${qty});`).join('\n')}
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver)
      VALUES ('${D(n)}', 'PROVER-B1B-D${n}', '${O(n)}', '${CUST}', '${ADMIN}', '${st}', current_date, '${DRV}');
    ${lines.map(([p, qty], k) => `INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${DI(n, k)}', '${D(n)}', '${OI(n, k)}', '${p}', ${qty}, 'GL');`).join('\n')}`);
}
const SET = (d, lines, seq, key) => `SELECT public.set_delivery_brands('${d}', ${J(lines)}, ${seq}, ${q(key)})::text;`;
const set = (d, lines, key) => ok(REP, SET(d, lines, maxSeq(d), key));
const COMPLETE = (d, qtys, key) => `SELECT public.complete_delivery(p_delivery_id => '${d}',
  p_signed_by => '${NO_PROOF}', p_performed_by => '${ADMIN}', p_quantities => ${J(qtys)}, p_idempotency_key => ${q(key)},
  p_evidence => 'no_proof', p_evidence_ref => '[PROVER] no proof on the stop')::text;`;
const complete = (d, qtys, key) => ok(ADMIN, COMPLETE(d, qtys, key));
const CORRECT = (d, lines, reason, key) => `SELECT public.correct_delivery_brands('${d}', ${J(lines)}, ${q(reason)}, ${maxSeq(d)}, ${q(key)})::text;`;
const pick = (brand_id, quantity) => ({ brand_id, quantity });
const typed = (typed_name, quantity, typed_epa = null) => ({ typed_name, typed_epa, quantity });

// The draft invoice line a completion made for delivery n, line k.
const invLine = (n, k = 0) => scalar(`SELECT ii.id FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
  WHERE i.delivery_id = '${D(n)}' AND ii.order_item_id = '${OI(n, k)}' AND i.deleted_at IS NULL;`);
const invOf = (line) => scalar(`SELECT invoice_id FROM public.invoice_items WHERE id = '${line}';`);
const brandLines = (line) => JSON.parse(scalar(`SELECT COALESCE(brand_lines, 'null'::jsonb)::text FROM public.invoice_items WHERE id = '${line}';`));
const lineNum = (line) => scalar(`SELECT COALESCE(epa_registration, '') FROM public.invoice_items WHERE id = '${line}';`);
const keys = (line) => (brandLines(line) ?? []).map((e) => `${e.brand_name}:${Number(e.quantity)}`);
const records = (line) => JSON.parse(scalar(`SELECT COALESCE(jsonb_agg(jsonb_build_object('brand', brand_name, 'key', brand_key, 'epa', epa_registration,
  'qty', quantity, 'cents', total_cents, 'signal', signal_word) ORDER BY brand_key NULLS FIRST), '[]')::text
  FROM public.rup_sales_records WHERE invoice_item_id = '${line}' AND voided_at IS NULL;`));
// Posting and the generator in one transaction, as post_invoice does.
function postAndGen(inv, key) {
  const r = psql(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${inv}';
    SET LOCAL session_replication_role = origin;
    SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
    SELECT 'GEN=' || public.generate_rup_sales_records('${inv}', '${key}'); COMMIT;`, { user: 'supabase_admin', allowFailure: true });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return Number(r.stdout.match(/GEN=(\d+)/)[1]);
}
const toCheck = () => js(ADMIN, 'SELECT public.get_epa_sales_to_check()::text;');
const reasons = (line) => toCheck().filter((x) => x.line_id === line).map((x) => `${x.brand_name ?? '-'}:${x.reason}`).sort();
const alloc = (line) => ownerJs(`SELECT public._invoice_line_brand_allocation('${line}')::text;`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'b1b-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'b1b-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('${DRV}', 'b1b-driver@example.invalid', '{"full_name":"[PROVER] Driver","role":"driver"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id = '${DRV}';
    INSERT INTO public.customers (id, farm_name, is_active, email, contact_name) VALUES
      ('${CUST}', '[PROVER] B1B Farm', true, 'b1b-farm@example.invalid', 'Pat Prover'),
      ('${LAND}', '[PROVER] B1B Landlord', true, 'b1b-land@example.invalid', 'Lee Prover');`);
  // REG-1's seed, on a database with no numbered products yet (nothing to pick), switches registrations on.
  const pv = js(ADMIN, `SELECT public.preview_epa_registration_seed('no')::text;`);
  assert.equal(pv.registration_count, 0, JSON.stringify(pv));
  js(ADMIN, `SELECT public.seed_epa_registrations('{}'::jsonb, 'no', ${q(pv.fingerprint)}, 'b1b-seed')::text;`);
  assert.equal(scalar('SELECT public._epa_registrations_seeded()::text;'), 'true');
  raw(`INSERT INTO public.epa_registrations (epa_registration, rup_status, signal_word, created_by, updated_by) VALUES
      ('500-1', 'no', 'Caution', '${ADMIN}', '${ADMIN}'), ('500-2', 'yes', 'Warning', '${ADMIN}', '${ADMIN}'),
      ('100-1', 'yes', 'Danger', '${ADMIN}', '${ADMIN}'), ('100-2', 'no', 'Caution', '${ADMIN}', '${ADMIN}'),
      ('100-4', 'yes', 'Danger', '${ADMIN}', '${ADMIN}'), ('100-5', 'yes', 'Warning', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.products (id, product_name, sku, unit_size, product_form, current_cost, tier1_price, is_active, epa_registration, is_rup, signal_word) VALUES
      ('${PR}', '[PROVER] Grouped 2.5', 'B1B-PR', 'GL', 'liquid', 6.00, 10.00, true, '500-1', false, 'Caution'),
      ('${PX}', '[PROVER] Restricted, no brands', 'B1B-PX', 'GL', 'liquid', 6.00, 10.00, true, '500-2', true, 'Warning');
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
      SELECT p, 'Main Warehouse', 1000, 0, 'GL' FROM unnest(ARRAY['${PR}', '${PX}']::uuid[]) p;
    INSERT INTO public.product_parents (id, name, product_form, created_by, updated_by) VALUES ('${PAR}', '[PROVER] Parent', 'liquid', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_members (product_id, parent_id, added_by) VALUES ('${PR}', '${PAR}', '${ADMIN}');
    INSERT INTO public.product_parent_brands (id, parent_id, brand_name, epa_registration, signal_word, status, created_by, updated_by) VALUES
      ('${ALPHA}', '${PAR}', 'Alpha', '100-1', 'Danger', 'active', '${ADMIN}', '${ADMIN}'),
      ('${BRAVO}', '${PAR}', 'Bravo', '100-2', 'Caution', 'active', '${ADMIN}', '${ADMIN}'),
      ('${CHARLIE}', '${PAR}', 'Charlie', NULL, NULL, 'active', '${ADMIN}', '${ADMIN}'),
      ('${DELTA}', '${PAR}', 'Delta', '100-4', 'Danger', 'active', '${ADMIN}', '${ADMIN}'),
      ('${ECHO}', '${PAR}', 'Echo', '100-5', 'Warning', 'active', '${ADMIN}', '${ADMIN}');`);
  console.log('[prover] seeded: registrations switched on; a grouped size (not restricted, number 500-1) with five brands (restricted Alpha, Delta, Echo; Bravo not; Charlie with no number); a restricted size with no brands');
}

const PRIVATE_FNS = ['public._invoice_brand_key(text,text)', 'public._invoice_line_brand_lines(uuid,uuid,uuid)',
  'public._invoice_line_brand_keys(jsonb)', 'public._fill_invoice_line_brands()', 'public._invoice_brand_recopy_invoice(uuid)',
  'public._invoice_brand_recopy(uuid)', 'public._delivery_brand_event_recopy()', 'public._brand_largest_remainder(numeric,numeric[],numeric)',
  'public._invoice_line_brand_allocation(uuid)', 'public._invoice_brand_rup_facts(uuid,text,text)',
  'public._sync_invoice_line_brand_captures(uuid,uuid,jsonb,text)'];
const PUBLIC_FNS = ['public.get_rup_sales_register(date,date,uuid,uuid,text,boolean)', 'public.get_epa_sales_to_check()',
  'public.review_typed_brand(uuid,text,uuid,text,text)', 'public.get_typed_brands_for_review()'];

async function main() {
  if (REUSE) {
    if (!/^crx-brandb1b-\d+-[a-z0-9]+$/.test(REUSE)) throw new Error(`CRX_PROVER_REUSE must name a crx-brandb1b-<pid>-<id> prover container, got ${REUSE}`);
    if (scalar(`SELECT count(*) FROM pg_database WHERE datname = 'bb_snap';`) !== '1') throw new Error(`${REUSE} has no bb_snap copy; run the prover fresh`);
    copyDatabase('bb_snap', 'postgres');
  } else {
    buildContainer();
    if (KEEP) copyDatabase('postgres', 'bb_snap');
  }
  // 15. Before the REG-1 seed, the preflight refuses.
  stageText('candidate.sql', lf(CANDIDATE));
  const early = apply('candidate.sql');
  assert.notEqual(early.status, 0); assert.match(early.output, /run the REG-1 registration seed first/);
  console.log('[prover] case 15: before the registration seed, the file refuses');
  seed();

  // 0. Before the candidate: a delivery with two brands completed, its draft invoice made the old way.
  mkDelivery(0, [[PR, 5]]);
  set(D(0), [{ delivery_item_id: DI(0, 0), picks: [pick(ALPHA, 2), pick(BRAVO, 3)] }], 'b1b-k0');
  complete(D(0), { [DI(0, 0)]: 5 }, 'b1b-c0');
  const L0 = invLine(0);
  assert.ok(L0, 'completion drafted an invoice line');
  const cents0 = scalar(`SELECT extended_cents FROM public.invoice_items WHERE id = '${L0}';`);

  // 1. Apply: one transaction, once; the backfill copies the open draft's brands.
  stageText('candidate.sql', lf(CANDIDATE));
  let r = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.match(`${r.stdout}\n${r.stderr}`, /INVOICE_BRANDS_RUP_NOT_IN_TRANSACTION/);
  r = apply('candidate.sql'); assert.equal(r.status, 0, r.output);
  assert.match(r.output, /INVOICE_BRANDS_BACKFILL/);
  r = apply('candidate.sql'); assert.notEqual(r.status, 0); assert.match(r.output, /INVOICE_BRANDS_RUP_PREFLIGHT: this file was already applied/);
  assert.deepEqual(keys(L0), ['Alpha:2', 'Bravo:3'], 'the backfill copied the open draft');
  assert.equal(lineNum(L0), '500-1', 'two brands: the product\'s number');
  assert.equal(scalar(`SELECT extended_cents FROM public.invoice_items WHERE id = '${L0}';`), cents0, 'no amount changes');
  console.log('[prover] case 1: outside a transaction it refuses; it applies once (the replay matched every pinned live body); a second run refuses; the backfill copied an open draft\'s brands without touching its amounts');

  // 2. Grants and ownership.
  for (const sig of [...PRIVATE_FNS, ...PUBLIC_FNS]) {
    const row = scalar(`SELECT pg_get_userbyid(p.proowner) || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE') || '|'
      || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || (p.prosecdef = false OR p.proconfig @> ARRAY['search_path=public, pg_temp'])
      FROM pg_proc p WHERE p.oid = '${sig}'::regprocedure;`);
    assert.equal(row, `postgres|${PUBLIC_FNS.includes(sig)}|false|true`, sig);
  }
  for (const sig of PRIVATE_FNS) assert.equal(scalar(`SELECT has_function_privilege('service_role', '${sig}'::regprocedure, 'EXECUTE')::text;`), 'false', sig);
  assert.equal(scalar(`SELECT relrowsecurity || '|' || has_table_privilege('authenticated', 'public.invoice_line_brand_rup_captures', 'SELECT,INSERT,UPDATE,DELETE')
    || '|' || has_table_privilege('anon', 'public.invoice_line_brand_rup_captures', 'SELECT') || '|' || has_table_privilege('service_role', 'public.invoice_line_brand_rup_captures', 'SELECT')
    FROM pg_class WHERE oid = 'public.invoice_line_brand_rup_captures'::regclass;`), 'true|false|false|false');
  refused(REP, 'SELECT public.get_epa_sales_to_check()::text;', /ADMIN_REQUIRED|not authorized|42501/i);
  console.log('[prover] case 2: every new helper is owned by postgres, pinned, and runs for no app role; the capture table is private; the four public functions keep their grants');

  // 3. Snapshot and the line number: one brand gives the brand's number; a correction on a draft re-copies at commit.
  mkDelivery(3, [[PR, 4]]);
  set(D(3), [{ delivery_item_id: DI(3, 0), picks: [pick(ALPHA, 4)] }], 'b1b-k3');
  complete(D(3), { [DI(3, 0)]: 4 }, 'b1b-c3');
  const L3 = invLine(3);
  const cents3 = scalar(`SELECT extended_cents || '|' || quantity FROM public.invoice_items WHERE id = '${L3}';`);
  assert.deepEqual(keys(L3), ['Alpha:4']);
  assert.equal(lineNum(L3), '100-1', 'one brand: its own number');
  ok(ADMIN, CORRECT(D(3), [{ delivery_item_id: DI(3, 0), picks: [pick(ALPHA, 2), pick(BRAVO, 2)] }], 'jug read wrong', 'b1b-x3a'));
  assert.deepEqual(keys(L3), ['Alpha:2', 'Bravo:2'], 'the correction re-copied the draft at commit');
  assert.equal(lineNum(L3), '500-1');
  ok(ADMIN, CORRECT(D(3), [{ delivery_item_id: DI(3, 0), picks: [pick(BRAVO, 4)] }], 'all Bravo', 'b1b-x3b'));
  assert.deepEqual(keys(L3), ['Bravo:4']); assert.equal(lineNum(L3), '100-2');
  assert.equal(scalar(`SELECT extended_cents || '|' || quantity FROM public.invoice_items WHERE id = '${L3}';`), cents3, 'no amount changes');
  const e3 = brandLines(L3)[0];
  assert.deepEqual([e3.brand_key, e3.epa_registration, e3.typed, e3.delivery_id, e3.delivery_item_id, Number(e3.line_delivered)],
    ['b:bravo|100-2', '100-2', false, D(3), DI(3, 0), 4]);
  console.log('[prover] case 3: the snapshot names each brand with its number; one brand puts its number on the line, several leave the product\'s; an admin correction re-copies the draft when it commits; amounts never move');

  // 4. Per-brand records under each brand's number; cents add up exactly (largest remainder).
  mkDelivery(4, [[PR, 10]]);
  set(D(4), [{ delivery_item_id: DI(4, 0), picks: [pick(ALPHA, 6), pick(BRAVO, 4)] }], 'b1b-k4');
  complete(D(4), { [DI(4, 0)]: 10 }, 'b1b-c4');
  const L4 = invLine(4);
  const ext4 = BigInt(scalar(`SELECT extended_cents FROM public.invoice_items WHERE id = '${L4}';`)); assert.equal(ext4 % 10n, 0n, 'whole-cent expectation');
  assert.equal(postAndGen(invOf(L4), 'b1b-g4'), 1);
  assert.deepEqual(records(L4), [{ brand: 'Alpha', key: 'b:alpha|100-1', epa: '100-1', qty: 6, cents: Number(ext4 * 6n / 10n), signal: 'Danger' }]);
  assert.equal(postAndGen(invOf(L4), 'b1b-g4'), 1, 'a replay answers the same');
  assert.equal(ok(ADMIN, `SELECT brand_name FROM public.get_rup_sales_register() WHERE invoice_id = '${invOf(L4)}';`), 'Alpha', 'the register shows the brand');
  mkDelivery(5, [[PR, 3]]);
  set(D(5), [{ delivery_item_id: DI(5, 0), picks: [pick(ALPHA, 1), pick(DELTA, 1), pick(ECHO, 1)] }], 'b1b-k5');
  complete(D(5), { [DI(5, 0)]: 3 }, 'b1b-c5');
  const L5 = invLine(5);
  raw(`UPDATE public.invoice_items SET unit_price_cents = 333, extended_cents = 1000 WHERE id = '${L5}';`);
  assert.equal(postAndGen(invOf(L5), 'b1b-g5'), 3);
  assert.deepEqual(records(L5).map((x) => [x.brand, x.qty, x.cents, x.epa]), [['Alpha', 1, 334, '100-1'], ['Delta', 1, 333, '100-4'], ['Echo', 1, 333, '100-5']]);
  console.log('[prover] case 4: posting writes one record per restricted brand under its own number and signal word (none for a brand that is not restricted); the register shows the brand; cents split by largest remainder add up to the line exactly');

  // 5. A posted line is frozen; a stale snapshot is listed, never re-copied.
  raw(`UPDATE public.delivery_item_brands SET quantity = 5 WHERE delivery_item_id = '${DI(4, 0)}' AND brand_name = 'Alpha' AND superseded_at IS NULL;`);
  const before5 = JSON.stringify(brandLines(L4));
  assert.equal(scalar(`SELECT public._invoice_brand_recopy('${D(4)}');`), '0');
  assert.equal(JSON.stringify(brandLines(L4)), before5, 'a posted line keeps its brands');
  psql(`UPDATE public.invoice_items SET description = description WHERE id = '${L4}';`, { allowFailure: true });
  assert.equal(JSON.stringify(brandLines(L4)), before5, 'an update to a posted line keeps its brands');
  assert.ok(reasons(L4).includes('-:brand_lines_stale'), JSON.stringify(reasons(L4)));
  raw(`UPDATE public.delivery_item_brands SET quantity = 6 WHERE delivery_item_id = '${DI(4, 0)}' AND brand_name = 'Alpha' AND superseded_at IS NULL;`);
  assert.deepEqual(reasons(L4), [], 'back in step: nothing to check');
  console.log('[prover] case 5: a posted line keeps its brands through a re-copy and an update; a snapshot that no longer matches the picks is listed');

  // 6. Brand problems: no record, a listed reason, and posting still succeeds.
  mkDelivery(6, [[PR, 5]]);
  set(D(6), [{ delivery_item_id: DI(6, 0), picks: [pick(ALPHA, 3)] }], 'b1b-k6');
  complete(D(6), { [DI(6, 0)]: 5 }, 'b1b-c6');  // the split does not add up to delivered
  const L6 = invLine(6);
  assert.equal(postAndGen(invOf(L6), 'b1b-g6'), 0);
  assert.deepEqual(records(L6), []);
  assert.deepEqual(reasons(L6), ['-:brand_split_mismatch']);
  mkDelivery(7, [[PR, 2]]);
  set(D(7), [{ delivery_item_id: DI(7, 0), picks: [pick(ALPHA, 2)] }], 'b1b-k7');
  complete(D(7), { [DI(7, 0)]: 2 }, 'b1b-c7');
  const L7 = invLine(7);
  raw(`UPDATE public.invoice_items SET quantity = 3, extended_cents = 3000 WHERE id = '${L7}';`);
  assert.equal(postAndGen(invOf(L7), 'b1b-g7'), 0);
  assert.deepEqual(reasons(L7), ['-:billed_above_delivered']);
  mkDelivery(8, [[PR, 2]]);
  set(D(8), [{ delivery_item_id: DI(8, 0), picks: [pick(ALPHA, 2)] }], 'b1b-k8');
  complete(D(8), { [DI(8, 0)]: 2 }, 'b1b-c8');
  const L8 = invLine(8);
  raw(`INSERT INTO public.invoices (id, customer_id, order_id, invoice_number, status, invoice_date, created_by)
      VALUES ('${id(0x808)}', '${CUST}', '${O(8)}', 'B1B-I8b', 'draft', current_date, '${ADMIN}');
    INSERT INTO public.invoice_items (id, invoice_id, product_id, order_item_id, description, quantity, unit_size, unit_price_cents, extended_cents)
      VALUES ('${id(0x809)}', '${id(0x808)}', '${PR}', '${OI(8, 0)}', '[PROVER] order-wide line', 1, 'GL', 1000, 1000);`);
  assert.equal(postAndGen(invOf(L8), 'b1b-g8'), 0);
  assert.deepEqual(reasons(L8), ['-:overlapping_invoices']);
  console.log('[prover] case 6: a split that does not add up, billing above delivered, and an overlapping order-wide invoice each post with no record and are listed on Sales to check');

  // 7. Two payers on one delivery line: brand shares split exactly; payers whose brands differ are listed.
  mkDelivery(9, [[PR, 10]]);
  set(D(9), [{ delivery_item_id: DI(9, 0), picks: [pick(ALPHA, 5), pick(BRAVO, 5)] }], 'b1b-k9');
  complete(D(9), { [DI(9, 0)]: 10 }, 'b1b-c9');
  const L9 = invLine(9);
  raw(`UPDATE public.invoice_items SET quantity = 6, extended_cents = 6001 WHERE id = '${L9}';
    INSERT INTO public.invoices (id, customer_id, order_id, delivery_id, invoice_number, status, invoice_date, created_by)
      VALUES ('${id(0x908)}', '${CUST}', '${O(9)}', '${D(9)}', 'B1B-I9b', 'draft', current_date, '${ADMIN}');
    INSERT INTO public.invoice_items (id, invoice_id, product_id, order_item_id, description, quantity, unit_size, unit_price_cents, extended_cents, brand_lines)
      SELECT '${id(0x909)}', '${id(0x908)}', '${PR}', '${OI(9, 0)}', '[PROVER] second payer', 4, 'GL', 1000, 3999, brand_lines
        FROM public.invoice_items WHERE id = '${L9}';`);
  const a1 = alloc(L9), a2 = alloc(id(0x909));
  assert.equal(a1.problem, null); assert.equal(a2.problem, null);
  const total = (a, f) => a.brands.reduce((s, b) => s + Number(b[f]), 0);
  assert.deepEqual([total(a1, 'quantity'), total(a1, 'cents'), total(a2, 'quantity'), total(a2, 'cents')], [6, 6001, 4, 3999]);
  const byBrand = (name) => Number(a1.brands.find((b) => b.brand_name === name).quantity) + Number(a2.brands.find((b) => b.brand_name === name).quantity);
  assert.deepEqual([byBrand('Alpha'), byBrand('Bravo')], [5, 5]);
  raw(`UPDATE public.invoice_items SET brand_lines = '[]'::jsonb WHERE id = '${id(0x909)}';`);
  assert.equal(alloc(L9).problem, 'payer_split_changed');
  console.log('[prover] case 7: two payers on one delivery line share each brand exactly (quantities and cents add up); payers whose brands differ are a payer_split_changed problem');

  // 8. A line with one per-line record and brand records at once is refused.
  r = psql(`INSERT INTO public.rup_sales_records (invoice_id, invoice_item_id, order_id, customer_id, product_id, sale_date, product_name,
      epa_registration, quantity, unit, unit_price_cents, total_cents, season, buyer_name)
    VALUES ('${invOf(L4)}', '${L4}', '${O(4)}', '${CUST}', '${PR}', current_date, '[PROVER] mixed', '500-1', 1, 'GL', 1000, 1000, 2027, 'x');`, { allowFailure: true });
  assert.match(`${r.stdout}\n${r.stderr}`, /RUP_RECORD_LINE_KIND_MIXED/);
  console.log('[prover] case 8: a per-line record beside brand records on the same line is refused');

  // 9. Unbranded lines keep #1746's path; a brand list with no pick is listed; a brand with no number is listed.
  mkDelivery(10, [[PX, 2], [PR, 2]]);
  complete(D(10), { [DI(10, 0)]: 2, [DI(10, 1)]: 2 }, 'b1b-c10');
  const LX = invLine(10, 0), LN = invLine(10, 1);
  assert.equal(brandLines(LX), null, 'a size with no brands keeps NULL');
  assert.deepEqual(brandLines(LN), [], 'a size with a brand list and no pick keeps []');
  assert.equal(postAndGen(invOf(LX), 'b1b-g10'), 1);
  assert.deepEqual(records(LX).map((x) => [x.brand, x.key, x.qty, x.epa]), [[null, null, 2, '500-2']], 'one per-line record, as before');
  assert.deepEqual(records(LN), []);
  assert.deepEqual(reasons(LN), ['-:brand_not_recorded']);
  mkDelivery(11, [[PR, 2]]);
  set(D(11), [{ delivery_item_id: DI(11, 0), picks: [pick(CHARLIE, 2)] }], 'b1b-k11');
  complete(D(11), { [DI(11, 0)]: 2 }, 'b1b-c11');
  const L11 = invLine(11);
  assert.equal(lineNum(L11), '500-1', 'a brand with no number leaves the product\'s');
  assert.equal(postAndGen(invOf(L11), 'b1b-g11'), 0);
  assert.deepEqual(reasons(L11), ['Charlie:brand_no_epa_number']);
  console.log('[prover] case 9: a size with no brands records per line exactly as before; a brand list with no pick and a brand with no EPA number are listed, never blocking');

  // 10. Typed-brand review leaves out voided and cancelled deliveries.
  mkDelivery(12, [[PR, 1]]);
  set(D(12), [{ delivery_item_id: DI(12, 0), picks: [typed('Zulu', 1)] }], 'b1b-k12');
  const zulu = () => js(ADMIN, 'SELECT public.get_typed_brands_for_review()::text;').find((x) => x.delivery_id === D(12));
  const pickId = zulu().pick_id;
  for (const st of ['cancelled', 'voided']) {
    raw(`UPDATE public.deliveries SET status = '${st}' WHERE id = '${D(12)}';`);
    assert.equal(zulu(), undefined, `a ${st} delivery's typed brand is not listed`);
    refused(ADMIN, `SELECT public.review_typed_brand('${pickId}', 'dismiss', NULL, 'x', 'b1b-r-${st}')::text;`, /BRAND_PICK_NOT_FOUND/);
  }
  raw(`UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${D(12)}';`);
  assert.equal(zulu().pick_id, pickId);
  const reviewed = ok(ADMIN, `SELECT public.review_typed_brand('${pickId}', 'dismiss', NULL, 'not a brand', 'b1b-r-ok')::text;`);
  raw(`UPDATE public.deliveries SET status = 'voided' WHERE id = '${D(12)}';`);
  assert.equal(ok(ADMIN, `SELECT public.review_typed_brand('${pickId}', 'dismiss', NULL, 'not a brand', 'b1b-r-ok')::text;`), reviewed,
    'a retry of a committed review answers the same after the delivery is voided');
  raw(`UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${D(12)}';`);
  console.log('[prover] case 10: typed brands on voided or cancelled deliveries are not listed and cannot be reviewed; on a live delivery they can');

  // 11. Partial billing, two payers at 50/50, a 5-place delivered amount, a typed '~none' brand.
  mkDelivery(13, [[PR, 100]]);
  set(D(13), [{ delivery_item_id: DI(13, 0), picks: [pick(ALPHA, 60), pick(DELTA, 40)] }], 'b1b-k13');
  complete(D(13), { [DI(13, 0)]: 100 }, 'b1b-c13');
  const L13 = invLine(13);
  raw(`UPDATE public.invoice_items SET quantity = 60, extended_cents = 60000 WHERE id = '${L13}';`);
  assert.equal(postAndGen(invOf(L13), 'b1b-g13'), 1);
  assert.deepEqual(records(L13).map((x) => [x.brand, x.qty, x.cents]), [['Alpha', 60, 60000]], 'billed at 60: A 60, no B record');
  assert.deepEqual(reasons(L13), [], 'B is not listed as unrecorded');
  mkDelivery(14, [[PR, 100]]);
  set(D(14), [{ delivery_item_id: DI(14, 0), picks: [pick(ALPHA, 60), pick(DELTA, 40)] }], 'b1b-k14');
  complete(D(14), { [DI(14, 0)]: 100 }, 'b1b-c14');
  const L14 = invLine(14);
  raw(`UPDATE public.invoice_items SET quantity = 50, extended_cents = 50000 WHERE id = '${L14}';
    INSERT INTO public.invoices (id, customer_id, order_id, delivery_id, invoice_number, status, invoice_date, created_by)
      VALUES ('${id(0xe08)}', '${CUST}', '${O(14)}', '${D(14)}', 'B1B-I14b', 'draft', current_date, '${ADMIN}');
    INSERT INTO public.invoice_items (id, invoice_id, product_id, order_item_id, description, quantity, unit_size, unit_price_cents, extended_cents, brand_lines)
      SELECT '${id(0xe09)}', '${id(0xe08)}', '${PR}', '${OI(14, 0)}', '[PROVER] payer two', 50, 'GL', 1000, 50000, brand_lines
        FROM public.invoice_items WHERE id = '${L14}';`);
  assert.equal(postAndGen(invOf(L14), 'b1b-g14a'), 2);
  assert.equal(postAndGen(id(0xe08), 'b1b-g14b'), 2);
  for (const l of [L14, id(0xe09)]) assert.deepEqual(records(l).map((x) => [x.brand, x.qty]), [['Alpha', 30], ['Delta', 20]], 'each payer records A 30 and B 20');
  mkDelivery(15, [[PR, 3]]);
  set(D(15), [{ delivery_item_id: DI(15, 0), picks: [pick(ALPHA, 2.3333)] }], 'b1b-k15');
  complete(D(15), { [DI(15, 0)]: 2.33333 }, 'b1b-c15');
  const L15 = invLine(15);
  assert.equal(Number(brandLines(L15)[0].line_delivered), 2.3333, 'a 5-place delivered amount uses its 4-place value');
  assert.equal(postAndGen(invOf(L15), 'b1b-g15'), 1);
  assert.equal(records(L15)[0].qty, 2.3333);
  mkDelivery(16, [[PR, 1]]);
  set(D(16), [{ delivery_item_id: DI(16, 0), picks: [typed('~none', 1)] }], 'b1b-k16');
  complete(D(16), { [DI(16, 0)]: 1 }, 'b1b-c16');
  assert.equal(brandLines(invLine(16))[0].brand_key, 'b:~none|', 'a typed brand named ~none keeps its own key');
  console.log('[prover] case 11: billed at 60 of A 60 / B 40 records A 60 and lists nothing; two payers at 50 each record A 30 and B 20; a 5-place delivered amount uses its 4-place value; a typed brand named ~none keeps its own key');

  // 12. The snapshot cannot be written by hand, survives save_invoice, and a brand change re-captures only that brand.
  mkDelivery(17, [[PR, 4]]);
  set(D(17), [{ delivery_item_id: DI(17, 0), picks: [pick(ALPHA, 2), pick(BRAVO, 2)] }], 'b1b-k17');
  complete(D(17), { [DI(17, 0)]: 4 }, 'b1b-c17');
  const L17 = invLine(17);
  const snap17 = JSON.stringify(brandLines(L17));
  psql(`UPDATE public.invoice_items SET brand_lines = '[]'::jsonb WHERE id = '${L17}';`, { user: 'supabase_admin' });
  assert.equal(JSON.stringify(brandLines(L17)), snap17, 'a direct write of brand_lines is overwritten');
  const capAt = (line, key) => scalar(`SELECT captured_at::text FROM public.invoice_line_brand_rup_captures WHERE invoice_item_id = '${line}' AND brand_key = '${key}';`);
  assert.ok(capAt(L17, 'b:alpha|100-1'), 'each brand is captured at save');
  const INV17 = invOf(L17);
  const items17 = JSON.parse(scalar(`SELECT jsonb_agg(jsonb_build_object('id', id, 'product_id', product_id, 'order_item_id', order_item_id, 'description', description,
    'quantity', quantity, 'unit_size', unit_size, 'unit_price_cents', unit_price_cents + 5, 'epa_registration', epa_registration)) FROM public.invoice_items WHERE invoice_id = '${INV17}';`));
  const hdr17 = JSON.parse(scalar(`SELECT jsonb_build_object('id', id, 'customer_id', customer_id, 'order_id', order_id, 'delivery_id', delivery_id, 'status', status,
    'invoice_date', invoice_date)::text FROM public.invoices WHERE id = '${INV17}';`));
  ok(ADMIN, `SELECT public.save_invoice(${J(hdr17)}, ${J(items17)}, 'b1b-save17')::text;`);
  const L17b = invLine(17);
  assert.equal(JSON.stringify(brandLines(L17b)), snap17, 'save_invoice with a price change keeps the brands');
  assert.equal(scalar(`SELECT count(*) FROM public.invoice_line_brand_rup_captures WHERE invoice_item_id = '${L17b}';`), '2', 'and the brand captures');
  const alphaAt2 = capAt(L17b, 'b:alpha|100-1');
  ok(ADMIN, CORRECT(D(17), [{ delivery_item_id: DI(17, 0), picks: [pick(ALPHA, 2), pick(DELTA, 2)] }], 'Bravo was Delta', 'b1b-x17'));
  assert.deepEqual(keys(L17b), ['Alpha:2', 'Delta:2']);
  assert.equal(capAt(L17b, 'b:alpha|100-1'), alphaAt2, 'an unchanged brand keeps its capture');
  assert.equal(capAt(L17b, 'b:bravo|100-2'), '', 'a gone brand loses its capture');
  assert.ok(capAt(L17b, 'b:delta|100-4'), 'a new brand is captured');
  console.log('[prover] case 12: a direct write of brand_lines is overwritten; save_invoice with a price change keeps the brands and captures; a correction re-captures only the changed brand');

  // 13. Unpost and repost: fresh active records.
  const recCount = (line, active) => Number(scalar(`SELECT count(*) FROM public.rup_sales_records WHERE invoice_item_id = '${line}' AND voided_at IS ${active ? '' : 'NOT '}NULL;`));
  const un = js(ADMIN, `SELECT public.unpost_invoice('${invOf(L5)}', '${ADMIN}', 'b1b-unpost5')::text;`);
  assert.equal(un.rup_rows_voided, 3);
  assert.equal(recCount(L5, true), 0);
  assert.equal(postAndGen(invOf(L5), 'b1b-g5b'), 3);
  assert.equal(recCount(L5, true), 3); assert.equal(recCount(L5, false), 3);
  console.log('[prover] case 13: unposting voids the brand records; re-posting writes fresh ones');

  // 14. Money: the same delivery with and without brands bills the same.
  mkDelivery(18, [[PR, 6]]); mkDelivery(19, [[PR, 6]]);
  set(D(19), [{ delivery_item_id: DI(19, 0), picks: [pick(ALPHA, 4), pick(BRAVO, 2)] }], 'b1b-k19');
  complete(D(18), { [DI(18, 0)]: 6 }, 'b1b-c18'); complete(D(19), { [DI(19, 0)]: 6 }, 'b1b-c19');
  const money = (n) => scalar(`SELECT jsonb_build_object('line', (SELECT to_jsonb(ii) - ARRAY['id','invoice_id','order_item_id','delivery_item_id','created_at','updated_at','brand_lines','epa_registration']
      FROM public.invoice_items ii WHERE ii.id = '${invLine(n)}'),
    'invoice', (SELECT to_jsonb(i) - ARRAY['id','invoice_number','order_id','delivery_id','created_at','updated_at','created_by','invoice_date','due_date','posted_at','idempotency_key','notes','po_number']
      FROM public.invoices i WHERE i.id = '${invOf(invLine(n))}'))::text;`);
  assert.equal(money(19), money(18));
  console.log('[prover] case 14: a delivery with brands and one without leave identical invoice amounts and totals');

  // 16. Split-billing provenance and posted-line captures.
  assert.equal(scalar(`SELECT count(*) FROM public.invoice_items ii WHERE ii.brand_lines IS NOT NULL
      AND public._split_invoice_content_claim(ii.invoice_id)->'items'->0 ? 'brand_lines';`), '0', 'the split claim leaves brand_lines out');
  mkDelivery(20, [[PR, 4]]);
  set(D(20), [{ delivery_item_id: DI(20, 0), picks: [pick(ALPHA, 4)] }], 'b1b-k20');
  complete(D(20), { [DI(20, 0)]: 4 }, 'b1b-c20');
  const L20 = invLine(20); const INV20 = invOf(L20);
  raw(`INSERT INTO public.split_invoice_provenance (invoice_id, order_id, invoice_group_id, customer_id, invoice_type, season, total_amount_cents, content_claim, created_by)
    SELECT i.id, i.order_id, gen_random_uuid(), i.customer_id, i.invoice_type, 2027, 0, public._split_invoice_content_claim(i.id), '${ADMIN}'
      FROM public.invoices i WHERE i.id = '${INV20}';`);
  const claim20 = scalar(`SELECT content_claim::text FROM public.split_invoice_provenance WHERE invoice_id = '${INV20}';`);
  ok(ADMIN, CORRECT(D(20), [{ delivery_item_id: DI(20, 0), picks: [pick(BRAVO, 4)] }], 'was Bravo', 'b1b-x20'));
  assert.deepEqual(keys(L20), ['Alpha:4'], 'a split-group draft is not re-copied');
  assert.equal(scalar(`SELECT public._split_invoice_content_claim('${INV20}')::text;`), claim20, 'so its stored claim still matches');
  const cap4 = scalar(`SELECT jsonb_agg(to_jsonb(c) ORDER BY brand_key)::text FROM public.invoice_line_brand_rup_captures c WHERE invoice_item_id = '${L4}';`);
  raw(`UPDATE public.products SET epa_registration = '500-2' WHERE id = '${PR}';`);
  psql(`UPDATE public.invoice_items SET cost_cents = cost_cents WHERE id = '${L4}';`, { user: 'supabase_admin' });
  assert.equal(scalar(`SELECT jsonb_agg(to_jsonb(c) ORDER BY brand_key)::text FROM public.invoice_line_brand_rup_captures c WHERE invoice_item_id = '${L4}';`), cap4,
    'a posted line keeps its brand captures when the product number changes and the line is touched');
  raw(`UPDATE public.products SET epa_registration = '500-1' WHERE id = '${PR}';`);
  console.log('[prover] case 16: the split-invoice claim leaves the brand snapshot out; a split-group draft is not re-copied, so its claim still matches; a posted line keeps its brand captures');

  // 17. A REAL Bill Split completion (the body drafts one invoice per payer before B-1a's completion rule runs):
  //     one pick of 3 loaded, 2 delivered, and a brand-listed line with no pick.
  const payerLines = (n, k = 0) => scalar(`SELECT string_agg(ii.id::text, ',' ORDER BY i.customer_id) FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id WHERE i.order_id = '${O(n)}' AND ii.order_item_id = '${OI(n, k)}' AND i.deleted_at IS NULL;`).split(',').filter(Boolean);
  const claimMatches = (inv) => scalar(`SELECT (sp.content_claim = public._split_invoice_content_claim(sp.invoice_id))::text
    FROM public.split_invoice_provenance sp WHERE sp.invoice_id = '${inv}';`);
  const billSplit = (n) => raw(`INSERT INTO public.order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents)
    SELECT '${O(n)}', '${LAND}', '[PROVER] B1B Landlord', 40, round(sum(total_price) * 40)::bigint FROM public.order_items WHERE order_id = '${O(n)}';`);
  const noStale = (l) => assert.ok(!reasons(l).some((x) => /stale|mismatch|payer_split/.test(x)), `${l}: ${reasons(l)}`);
  mkDelivery(21, [[PR, 3], [PR, 2]]);
  billSplit(21);
  set(D(21), [{ delivery_item_id: DI(21, 0), picks: [pick(ALPHA, 3)] }], 'b1b-k21');
  complete(D(21), { [DI(21, 0)]: 2, [DI(21, 1)]: 2 }, 'b1b-c21');
  const L21 = payerLines(21, 0), L21n = payerLines(21, 1);
  assert.equal(L21.length, 2, 'the completion drafted one line per payer (the Bill Split ran)');
  for (const l of L21) {
    assert.deepEqual(keys(l), ['Alpha:2'], 'each payer line holds the trimmed pick');
    assert.equal(Number(brandLines(l)[0].line_delivered), 2);
    assert.equal(claimMatches(invOf(l)), 'true', 'the stored split claim matches');
  }
  for (const l of L21n) assert.deepEqual(brandLines(l), [], 'a brand-listed line with no pick holds [] (not NULL)');
  let gen21 = 0;
  for (const inv of new Set(L21.map(invOf))) gen21 += postAndGen(inv, `b1b-g21-${inv}`);
  assert.equal(gen21, 2, 'each payer gets its Alpha record');
  assert.equal(L21.reduce((s, l) => s + records(l).reduce((x, r) => x + Number(r.qty), 0), 0), 2, 'the payers\' Alpha records add up to what was delivered');
  for (const l of [...L21, ...L21n]) noStale(l);
  console.log('[prover] case 17: a real Bill Split completion drafts each payer line with the trimmed pick and [] for a listed line with no pick; the stored split claims match; posting writes each payer\'s record and nothing is listed stale');

  // 18. A REAL landlord (field) auto-split completion: the order's lines are allocated to a field the landlord owns.
  mkDelivery(22, [[PR, 3], [PR, 2]]);
  raw(`UPDATE public.order_items SET total_units_needed = 2, total_price = 20, profit = 8, quantity_remaining = 2 WHERE id = '${OI(22, 0)}';
    INSERT INTO public.fields (id, customer_id, field_name, crop_type, total_acres) VALUES ('${id(0x1622)}', '${LAND}', '[PROVER] B1B Field', 'corn', 100);
    INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
      VALUES ('${OI(22, 0)}', '${id(0x1622)}', 100), ('${OI(22, 1)}', '${id(0x1622)}', 100);`);
  set(D(22), [{ delivery_item_id: DI(22, 0), picks: [pick(ALPHA, 3)] }], 'b1b-k22');
  complete(D(22), { [DI(22, 0)]: 2, [DI(22, 1)]: 2 }, 'b1b-c22');
  const L22 = payerLines(22, 0), L22n = payerLines(22, 1);
  assert.ok(L22.length >= 1 && L22n.length >= 1,
    `the landlord auto-split ran (needs_split_billing=${scalar(`SELECT needs_split_billing::text FROM public.orders WHERE id = '${O(22)}';`)})`);
  for (const l of L22) { assert.deepEqual(keys(l), ['Alpha:2'], 'the landlord line holds the trimmed pick'); assert.equal(claimMatches(invOf(l)), 'true'); }
  for (const l of L22n) assert.deepEqual(brandLines(l), [], 'a listed line with no pick holds []');
  for (const inv of new Set(L22.map(invOf))) postAndGen(inv, `b1b-g22-${inv}`);
  assert.equal(L22.reduce((s, l) => s + records(l).length, 0), L22.length, 'one Alpha record per landlord line');
  for (const l of [...L22, ...L22n]) noStale(l);
  console.log('[prover] case 18: a real landlord auto-split completion drafts its lines with the trimmed pick and []; claims match; posting records and lists nothing stale');

  // 19. A backdated completion of a plain sale: the draft holds the final brands too.
  mkDelivery(23, [[PR, 3]]);
  set(D(23), [{ delivery_item_id: DI(23, 0), picks: [pick(ALPHA, 3)] }], 'b1b-k23');
  ok(ADMIN, `SELECT public.complete_delivery(p_delivery_id => '${D(23)}', p_signed_by => '${NO_PROOF}', p_performed_by => '${ADMIN}',
    p_quantities => ${J({ [DI(23, 0)]: 2 })}, p_idempotency_key => 'b1b-c23', p_completed_at => now() - interval '3 days',
    p_evidence => 'no_proof', p_evidence_ref => '[PROVER] no proof on the stop')::text;`);
  assert.deepEqual(keys(invLine(23)), ['Alpha:2']);
  console.log('[prover] case 19: a backdated plain completion drafts the trimmed pick');

  // 20. A Bill Split draft corrected after it was made keeps its brands (never re-copied); posting writes no record
  //     under the old brand and lists the line as stale.
  mkDelivery(24, [[PR, 2]]);
  billSplit(24);
  set(D(24), [{ delivery_item_id: DI(24, 0), picks: [pick(ALPHA, 2)] }], 'b1b-k24');
  complete(D(24), { [DI(24, 0)]: 2 }, 'b1b-c24');
  const L24 = payerLines(24, 0);
  assert.equal(L24.length, 2);
  ok(ADMIN, CORRECT(D(24), [{ delivery_item_id: DI(24, 0), picks: [pick(DELTA, 2)] }], 'was Delta', 'b1b-x24'));
  for (const l of L24) { assert.deepEqual(keys(l), ['Alpha:2'], 'a split draft is not re-copied'); assert.equal(claimMatches(invOf(l)), 'true'); }
  assert.equal(scalar(`SELECT public._invoice_brand_recopy_invoice('${invOf(L24[0])}')::text;`), 'false', 'a split draft counts as skipped');
  for (const l of L24) assert.equal(postAndGen(invOf(l), `b1b-g24-${l}`), 0, 'no record under the old brand');
  for (const l of L24) assert.ok(reasons(l).includes('-:brand_lines_stale'), `${l}: ${reasons(l)}`);
  console.log('[prover] case 20: a Bill Split draft corrected after it was made keeps its brands and claim, counts as skipped, posts with no record, and is listed as stale');

  // 21. (Sol r1) A Bill Split draft made with no pick ([]) on a restricted product, then corrected to a brand: posting
  //     writes no per-line record under the product's number; the line is listed as stale.
  raw(`UPDATE public.products SET epa_registration = '500-2' WHERE id = '${PR}';`);
  mkDelivery(25, [[PR, 2]]);
  billSplit(25);
  complete(D(25), { [DI(25, 0)]: 2 }, 'b1b-c25');
  const L25 = payerLines(25, 0);
  assert.equal(L25.length, 2);
  for (const l of L25) assert.deepEqual(brandLines(l), [], 'made with no pick');
  ok(ADMIN, CORRECT(D(25), [{ delivery_item_id: DI(25, 0), picks: [pick(ALPHA, 2)] }], 'it was Alpha', 'b1b-x25'));
  for (const l of L25) assert.equal(postAndGen(invOf(l), `b1b-g25-${l}`), 0, 'no record under the product number');
  for (const l of L25) { assert.deepEqual(records(l), []); assert.ok(reasons(l).includes('-:brand_lines_stale'), `${l}: ${reasons(l)}`); }
  raw(`UPDATE public.products SET epa_registration = '500-1' WHERE id = '${PR}';`);
  console.log('[prover] case 21: a split draft made with no brand and corrected to a restricted brand posts with no record under the product number and is listed as stale');

  console.log('INVOICE_BRANDS_PROOF_PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
  else console.log(`[prover] kept ${NAME}`);
});
