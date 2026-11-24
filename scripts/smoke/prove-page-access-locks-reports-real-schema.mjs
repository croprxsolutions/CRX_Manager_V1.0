#!/usr/bin/env node
/**
 * Real-schema proof for 20270201100000_page_access_locks_reports (KI-119, Mason 2026-11-19).
 * Container setup and replay copied from prove-booking-guard-rep-and-delete-real-schema.mjs. Then:
 *   1. BEFORE: the gap is real: a sales rep with `reports` and `sales-reports` hidden still runs every report
 *      function, and signed-out callers may execute the logbooks. The new chain fails.
 *   2. The candidate applies; a second apply is refused by its preflight.
 *   3. AFTER: smoke-page-access-locks-reports.sql passes; the hidden rep is refused PAGE_ACCESS_DENIED; the admin's
 *      and an undenied rep's results equal the BEFORE results on the same data; every existing chain that calls a
 *      guarded function ends exactly as before.
 *
 * Run: node scripts/smoke/prove-page-access-locks-reports-real-schema.mjs   (needs Docker)
 * Prints PAGE_ACCESS_LOCKS_REPORTS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
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
const NAME = REUSE || `crx-pal-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270201100000_page_access_locks_reports.sql');
const FOLLOW_UPS = [];
// 20270224120000 (KI-129 payments / #2175) re-creates the Month-End functions after this candidate; this proof stops before it.
// 20270228130000 (#2388 Sol HIGH 2) widens _require_page_access to 'inventory'; this proof stops before it
// (prove-purchasing-plan-inventory-page-real-schema.mjs covers it).
const LATER_READ_ONLY = new Set(['20270224120000_month_close_payments_received_recheck.sql', '20270228130000_purchasing_plan_requires_inventory_page.sql']);
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
const TOUCHED = /(_require_page_access|get_customer_balance_listing|get_chemical_history|get_batch_year_end_summaries|get_customer_year_end_summary|get_logbook_|get_sales_summary_report|get_sales_detail_report|profiles_role_lock|denied_pages|comm_select|commissions)/i;
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


const ADMIN = 'c1190000-0000-4000-8000-0000000000a1';
const REP = 'c1190000-0000-4000-8000-0000000000b2';
const REP_DENIED = 'c1190000-0000-4000-8000-0000000000b3';
const REP_SALES_ONLY = 'c1190000-0000-4000-8000-0000000000b4';
const REP_INACTIVE = 'c1190000-0000-4000-8000-0000000000b5';
const DRIVER = 'c1190000-0000-4000-8000-0000000000d6';
const APPL = 'c1190000-0000-4000-8000-0000000000e7';
const ADMIN_STALE = 'c1190000-0000-4000-8000-0000000000a8';
const RECIPIENT = 'c1190000-0000-4000-8000-0000000000aa';
const CUSTOMER = 'c1190000-0000-4000-8000-0000000000f9';
const FIELD = 'c1190000-0000-4000-8000-0000000000fa';
const PLANE = 'c1190000-0000-4000-8000-0000000000fb';
const ORDER = 'c1190000-0000-4000-8000-0000000000fc';
const OWN_COMMISSIONS = "SELECT count(*) FROM public.commissions WHERE recipient LIKE '[PROVER]%';";
const CHAIN = 'smoke-page-access-locks-reports.sql';
// Existing chains that call a guarded function; each must end the same way before and after the candidate.
const REGRESSION = ['smoke-cost_margin_admin_only_rpc_leaks.sql', 'smoke-remaining-money-inventory-hardening.sql',
  'smoke-sales-reports-per-payer.sql', 'smoke-return-credit-chain.sql', 'smoke-historical-ar-report-cutoffs.sql'];
const YEAR = 'extract(year FROM CURRENT_DATE)::int';
// One digest per call so before/after results can be compared row for row.
const digest = (from) => `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM ${from} t;`;
const REPORTS = {
  balance: digest('public.get_customer_balance_listing(CURRENT_DATE)'),
  chemical: digest('public.get_chemical_history(NULL, CURRENT_DATE - 400, CURRENT_DATE)'),
  batch: `SELECT md5(public.get_batch_year_end_summaries(ARRAY['${CUSTOMER}'::uuid], ${YEAR})::text);`,
  faa: digest('public.get_logbook_faa(CURRENT_DATE - 400, CURRENT_DATE)'),
  byField: digest(`public.get_logbook_by_field('${FIELD}', CURRENT_DATE - 400, CURRENT_DATE)`),
  byCustomer: digest(`public.get_logbook_by_customer('${CUSTOMER}', CURRENT_DATE - 400, CURRENT_DATE)`),
  byApplicator: digest(`public.get_logbook_by_applicator('${APPL}', CURRENT_DATE - 400, CURRENT_DATE)`),
};
const SALES = {
  summary: digest("public.get_sales_summary_report('customer')"),
  detail: digest('public.get_sales_detail_report()'),
};
const YEAR_END_ONE = `SELECT md5(public.get_customer_year_end_summary('${CUSTOMER}', ${YEAR})::text);`;

function seed() {
  const users = [[ADMIN, 'admin'], [REP, 'sales_rep'], [REP_DENIED, 'sales_rep'], [REP_SALES_ONLY, 'sales_rep'],
    [REP_INACTIVE, 'sales_rep'], [DRIVER, 'driver'], [APPL, 'applicator'], [ADMIN_STALE, 'admin'], [RECIPIENT, 'entity_recipient']];
  // Live has these; deactivating a profile bans the user and ends their sessions (the seed deactivates a rep).
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    GRANT ALL ON auth.sessions, auth.refresh_tokens TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ${users.map(([id, role], i) =>
    `('${id}', 'pal-${i}@example.invalid', '{"full_name":"[PROVER] PAL ${i}","role":"${role}"}'::jsonb)`).join(', ')};`);
  raw(`${users.map(([id, role]) => `UPDATE public.profiles SET role = '${role}', is_active = true, denied_pages = '{}' WHERE id = '${id}';`).join('\n')}
    UPDATE public.profiles SET denied_pages = ARRAY['reports', 'sales-reports', 'invoices'] WHERE id = '${REP_DENIED}';
    UPDATE public.profiles SET denied_pages = ARRAY['sales-reports'] WHERE id = '${REP_SALES_ONLY}';
    UPDATE public.profiles SET is_active = false WHERE id = '${REP_INACTIVE}';
    UPDATE public.profiles SET denied_pages = ARRAY['reports', 'sales-reports'] WHERE id = '${ADMIN_STALE}';
    INSERT INTO public.customers (id, farm_name, is_active, assigned_sales_rep) VALUES ('${CUSTOMER}', '[PROVER] Page Access Farm', true, '${REP}');
    -- One aerial application on a field, so every logbook returns a real row before and after (Sol r1).
    INSERT INTO public.fields (id, customer_id, field_name) VALUES ('${FIELD}', '${CUSTOMER}', '[PROVER] North 40');
    INSERT INTO public.vehicles (id, vehicle_name, vehicle_type) VALUES ('${PLANE}', '[PROVER] Plane', 'air');
    INSERT INTO public.application_records (record_number, source_type, source_id, customer_id, application_date,
      applicator_id, field_id, vehicle_id)
    VALUES ('PAL-1', 'job', gen_random_uuid(), '${CUSTOMER}', CURRENT_DATE - 1, '${APPL}', '${FIELD}', '${PLANE}');
    -- One pending commission each for the hidden rep, the sales-reports-only rep and the undenied rep (the Commissions tab reads the table).
    INSERT INTO public.orders (id, order_number, customer_id) VALUES ('${ORDER}', 'PAL-O1', '${CUSTOMER}');
    INSERT INTO public.commissions (customer_id, order_id, recipient_user_id, recipient, commission_amount, status)
    VALUES ('${CUSTOMER}', '${ORDER}', '${REP_DENIED}', '[PROVER] denied', 1.00, 'pending'),
           ('${CUSTOMER}', '${ORDER}', '${REP_SALES_ONLY}', '[PROVER] sales-only', 3.00, 'pending'),
           ('${CUSTOMER}', '${ORDER}', '${REP}', '[PROVER] rep', 2.00, 'pending');
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};`);
}

function chainOutcome(file) {
  stageText(file, lf(path.join(ROOT, 'scripts', 'smoke', file)));
  const r = apply(file);
  const line = r.output.split(/\r?\n/).find((l) => /ERROR:/.test(l)) ?? `(no error, status ${r.status})`;
  return line.replace(/^.*?ERROR:\s*/, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>').replace(/\b[0-9a-f]{8}\b/g, '<sfx>');
}
const results = (calls, uid) => Object.fromEntries(Object.entries(calls).map(([k, sql]) => [k, okProbe(sql, uid)]));
function anonProbe(sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\nSET LOCAL ROLE anon;\n${sql}\nROLLBACK;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

async function main() {
  if (REUSE) {
    assert.match(REUSE, /^crx-[a-z0-9-]+$/, 'CRX_PROVER_REUSE must name a kept prover container (crx-...)');
    assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', REUSE]).stdout.trim(), 'none', 'CRX_PROVER_REUSE must be a network-less prover container');
    assert.ok(/^[a-z0-9_]+$/.test(DB) && DB !== 'postgres', 'CRX_PROVER_REUSE needs CRX_PROVER_DB naming a copy (a bare database name), not postgres');
    // The copy must be the bare replay: no sign-ins and no customers yet, so it is neither a used proof copy nor a
    // database holding real data (#2122).
    assert.equal(scalar('SELECT (SELECT count(*) FROM auth.users) + (SELECT count(*) FROM public.profiles) + (SELECT count(*) FROM public.customers);'),
      '0', 'CRX_PROVER_DB must be a fresh copy of the replayed database (it already has users or customers)');
  } else buildContainer();
  seed();

  // 1. BEFORE: the gap is real.
  const all = { ...REPORTS, ...SALES };
  const deniedBefore = results(all, REP_DENIED);
  console.log(`[case] BEFORE: a rep with reports and sales-reports hidden runs all ${Object.keys(all).length} report functions`);
  // Signed-out callers hold EXECUTE on the logbooks; table grants (not the function) stop them reading rows.
  assert.equal(scalar("SELECT has_function_privilege('anon', 'public.get_logbook_faa(date,date)', 'EXECUTE');"), 't');
  assert.match(anonProbe(REPORTS.faa).output, /permission denied for table/);
  console.log('[case] BEFORE: a signed-out caller may execute the FAA logbook (stopped only at the table)');
  const adminBefore = results(all, ADMIN);
  const repBefore = results(all, REP);
  const yearEndBefore = okProbe(YEAR_END_ONE, REP_DENIED);
  // Sol r4: before the candidate, a rep with Reports AND Customers hidden still reads the one-customer summary.
  raw(`UPDATE public.profiles SET denied_pages = denied_pages || ARRAY['customers'] WHERE id = '${REP_DENIED}';`);
  assert.equal(okProbe(YEAR_END_ONE, REP_DENIED), yearEndBefore);
  raw(`UPDATE public.profiles SET denied_pages = ARRAY['reports', 'sales-reports', 'invoices'] WHERE id = '${REP_DENIED}';`);
  console.log("[case] BEFORE: a rep with Reports and Customers hidden reads one customer's year-end summary");
  assert.deepEqual(deniedBefore, repBefore, 'two reps should see the same report results before the candidate');
  const EMPTY = 'd41d8cd98f00b204e9800998ecf8427e';
  for (const k of ['faa', 'byField', 'byCustomer', 'byApplicator']) assert.notEqual(adminBefore[k], EMPTY, `${k} returned no rows: the seeded application is not exercised`);
  assert.equal(okProbe(OWN_COMMISSIONS, REP_DENIED), '1');
  assert.equal(okProbe(OWN_COMMISSIONS, REP), '1');
  assert.equal(okProbe(OWN_COMMISSIONS, REP_SALES_ONLY), '1');
  console.log('[case] BEFORE: every logbook returns the seeded aerial application; the hidden rep reads their own commission row');
  const before = Object.fromEntries(REGRESSION.map((f) => [f, chainOutcome(f)]));
  for (const [f, o] of Object.entries(before)) console.log(`[before] ${f}: ${o.slice(0, 160)}`);
  const chainBefore = chainOutcome(CHAIN);
  assert.match(chainBefore, /^SMOKE_FAIL: 20270201100000 is not applied/, chainBefore);
  console.log(`[before] ${CHAIN}: ${chainBefore}`);

  // 2. Apply, then a second apply is refused.
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /PREFLIGHT_PAGE_ACCESS_HELPER_EXISTS/);
  console.log('[case] the candidate applies; a second apply stops at its preflight');

  // 3. AFTER
  const chain = chainOutcome(CHAIN);
  assert.match(chain, /^SMOKE_PASS_ROLLBACK/, chain);
  console.log(`[case] AFTER: ${CHAIN}: ${chain}`);
  for (const sql of Object.values(REPORTS)) refusedProbe(sql, /PAGE_ACCESS_DENIED: reports/, REP_DENIED);
  for (const sql of Object.values(SALES)) refusedProbe(sql, /PAGE_ACCESS_DENIED: sales-reports/, REP_DENIED);
  console.log('[case] AFTER: the hidden rep is refused every report function, with the page named');
  assert.equal(okProbe(YEAR_END_ONE, REP_DENIED), yearEndBefore, "the hidden rep's one-customer year-end summary is unchanged");
  console.log("[case] AFTER: the hidden rep still reads one customer's year-end summary (Customer page)");
  // Sol r4 (Mason, 2026-11-21): Reports AND Customers hidden refuses it; Customers alone, or an admin, does not.
  raw(`UPDATE public.profiles SET denied_pages = denied_pages || ARRAY['customers'] WHERE id IN ('${REP_DENIED}', '${ADMIN_STALE}');
    UPDATE public.profiles SET denied_pages = ARRAY['customers'] WHERE id = '${REP}';`);
  refusedProbe(YEAR_END_ONE, /PAGE_ACCESS_DENIED: reports, customers/, REP_DENIED);
  assert.equal(okProbe(YEAR_END_ONE, ADMIN_STALE), yearEndBefore, 'an admin with both pages hidden keeps the summary');
  assert.equal(okProbe(YEAR_END_ONE, REP), yearEndBefore, 'a rep with only Customers hidden keeps the summary');
  raw(`UPDATE public.profiles SET denied_pages = ARRAY['reports', 'sales-reports', 'invoices'] WHERE id = '${REP_DENIED}';
    UPDATE public.profiles SET denied_pages = ARRAY['reports', 'sales-reports'] WHERE id = '${ADMIN_STALE}';
    UPDATE public.profiles SET denied_pages = '{}' WHERE id = '${REP}';`);
  console.log('[case] AFTER: Reports and Customers both hidden refuses the one-customer summary; Customers alone or an admin keeps it');
  for (const sql of Object.values(SALES)) refusedProbe(sql, /PAGE_ACCESS_DENIED: sales-reports/, REP_SALES_ONLY);
  assert.deepEqual(results(REPORTS, REP_SALES_ONLY), Object.fromEntries(Object.keys(REPORTS).map((k) => [k, repBefore[k]])));
  console.log('[case] AFTER: a rep with only sales-reports hidden is refused the sales reports and keeps the Reports Library');
  for (const uid of [DRIVER, APPL, REP_INACTIVE]) {
    for (const sql of Object.values(all)) refusedProbe(sql, /PAGE_ACCESS_DENIED: (reports|sales-reports)/, uid);
  }
  console.log('[case] AFTER: a driver, an applicator and an inactive rep are refused every report function');
  assert.deepEqual(results(all, ADMIN), adminBefore, "the admin's results changed");
  assert.deepEqual(results(all, ADMIN_STALE), adminBefore, 'an admin with a stale hidden list should see the same results');
  assert.deepEqual(results(all, REP), repBefore, "the undenied rep's results changed");
  console.log('[case] AFTER: an admin (even with a stale hidden list) and an undenied rep get exactly the BEFORE results');
  const anonAfter = anonProbe(REPORTS.faa);
  assert.notEqual(anonAfter.status, 0);
  assert.match(anonAfter.output, /permission denied for function get_logbook_faa/);
  const anonHelper = anonProbe("SELECT public._require_page_access('reports');");
  assert.match(anonHelper.output, /permission denied for function _require_page_access/);
  console.log('[case] AFTER: a signed-out caller is refused the logbooks and the helper');
  assert.equal(okProbe(OWN_COMMISSIONS, REP_DENIED), '0', 'the hidden rep still reads their commission rows');
  assert.equal(okProbe(OWN_COMMISSIONS, REP_SALES_ONLY), '1', 'hiding only sales-reports must not hide commission rows');
  assert.equal(okProbe(OWN_COMMISSIONS, REP), '1', "the undenied rep lost their commission row");
  assert.equal(okProbe(OWN_COMMISSIONS, ADMIN_STALE), '3', 'an admin with a stale hidden list should see every commission row');
  console.log('[case] AFTER: the hidden rep reads none of their commission rows; the undenied rep and admins are unchanged');
  // Undo: the admin clears the list; the next call goes through with the undenied rep's results.
  raw(`UPDATE public.profiles SET denied_pages = '{}' WHERE id = '${REP_DENIED}';`);
  assert.deepEqual(results(all, REP_DENIED), repBefore, 'after clearing the list the rep should see the reports again');
  assert.equal(okProbe(OWN_COMMISSIONS, REP_DENIED), '1', 'after clearing the list the rep should see their commission row again');
  console.log('[case] AFTER: clearing the hidden list lets the next call through (reports and commission rows)');
  const uncovered = [];
  for (const f of REGRESSION) {
    const after = chainOutcome(f);
    assert.equal(after, before[f], `${f} ends differently after the candidate`);
    // A chain that stops at its own setup on this container never reaches a report: it proves nothing here.
    if (!/^SMOKE_PASS_ROLLBACK/.test(before[f])) {
      // Only a stop at setup counts as uncovered; a chain that reached its assertions and failed them fails the proof.
      assert.doesNotMatch(before[f], /SMOKE_FAIL/, `${f} fails its own assertions on this container`);
      // An error raised by a guarded report function is not a setup stop: the chain reached the code under proof (#2122).
      assert.doesNotMatch(before[f], TOUCHED, `${f} stops in a function this proof covers, not at its own setup`);
      uncovered.push(f);
    }
  }
  console.log(`[case] AFTER: ${REGRESSION.length - uncovered.length} existing chains pass before and after`);
  if (uncovered.length) console.log(`[not covered] stop at their own setup on this container both times (live smoke run after apply covers them): ${uncovered.join(', ')}`);
  console.log('PAGE_ACCESS_LOCKS_REPORTS_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
