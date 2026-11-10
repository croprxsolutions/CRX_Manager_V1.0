#!/usr/bin/env node
/**
 * Real-schema proof for 20261121090000 (KI-18: the last database dates that followed UTC). Builds the
 * checked-in schema baseline in a network-disabled PostgreSQL container, replays every migration before
 * the candidate, then checks BEFORE and AFTER:
 *  - financial_dashboard_summary's AR-aging strip: BEFORE an invoice 30 days past due sits in "current"
 *    (<= 30); AFTER it sits in the 30-59 bucket, matching get_ar_aging on the same Chicago date, at every
 *    edge (29/30, 59/60, 89/90).
 *  - generate_ticket_number returns BT-<Chicago year>-NNNN and keeps its grants.
 *  - invoices.invoice_date: today + 365 is accepted, today + 366 is refused on insert and update; an old row
 *    already past the limit can still have other columns changed.
 *  - the preflight refuses while any invoice is already past the limit; a second apply passes (re-runnable).
 *
 * Run: node scripts/smoke/prove-ki18-db-dates-real-schema.mjs   (needs local Docker image)
 * Prints KI18_DB_DATES_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki18-dates-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261121090000_ki18_chicago_ticket_year_dashboard_aging_invoice_date_limit.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations and DATA-11 rewrite live rows this disposable database does not have
// (DATA-11 also needs a live admin approver); they are recorded in the ledger (as live has them)
// instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /generate_ticket_number|financial_dashboard_summary|refuse_far_future_invoice_date/i;
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

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
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  for (const file of all.slice(at + 1)) {
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
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
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
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


const ADMIN = '16000000-0000-4000-8000-000000000006';

// Insert one row into public.<table> with session_replication_role = replica (no triggers or FK checks),
// filling every NOT NULL column that has no default with a typed placeholder; `fields` override them.
function seedRow(table, fields) {
  const id = randomUUID();
  const overrides = JSON.stringify({ id, ...fields }).replaceAll("'", "''");
  psql(`SET session_replication_role = replica; SET request.jwt.claim.sub = '${ADMIN}';  -- auth.uid() defaults (created_by)
DO $seed$
DECLARE v_o jsonb := '${overrides}'::jsonb; v_cols text := ''; v_vals text := ''; c record;
BEGIN
  FOR c IN SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
             FROM pg_attribute a
            WHERE a.attrelid = 'public.${table}'::regclass AND a.attnum > 0 AND NOT a.attisdropped
              AND a.attgenerated = ''
              AND (v_o ? a.attname OR (a.attnotnull AND NOT a.atthasdef))
  LOOP
    v_cols := v_cols || CASE WHEN v_cols = '' THEN '' ELSE ', ' END || quote_ident(c.attname);
    v_vals := v_vals || CASE WHEN v_vals = '' THEN '' ELSE ', ' END || CASE
      WHEN v_o ? c.attname THEN quote_nullable(v_o ->> c.attname) || '::' || c.typ
      WHEN c.typ = 'uuid' THEN 'gen_random_uuid()'
      WHEN c.typ IN ('integer','bigint','smallint') OR c.typ LIKE 'numeric%' THEN '0'
      WHEN c.typ = 'boolean' THEN 'false'
      WHEN c.typ = 'date' THEN 'current_date'
      WHEN c.typ LIKE 'timestamp%' THEN 'now()'
      WHEN c.typ = 'jsonb' THEN '''{}''::jsonb'
      ELSE quote_literal('[PROVER]') || '::' || c.typ END;
  END LOOP;
  EXECUTE format('INSERT INTO public.${table} (%s) VALUES (%s)', v_cols, v_vals);
END $seed$;`);
  return id;
}
// Run SQL in its own session (committed unless it fails); returns the status and combined output.
const run = (sql) => { const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: sql }); return { status: r.status, output: `${r.stdout}\n${r.stderr}` }; };

const today = () => scalar("SELECT (now() AT TIME ZONE 'America/Chicago')::date;");
const plus = (days) => scalar(`SELECT ((now() AT TIME ZONE 'America/Chicago')::date + ${days})::text;`);
const AGES = [0, 29, 30, 59, 60, 89, 90, 120];

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${ADMIN}', 'ki18-admin@example.invalid', '{"full_name":"[PROVER] admin"}'::jsonb) ON CONFLICT DO NOTHING;
    SET session_replication_role = replica;
    INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES ('${ADMIN}', 'ki18-admin@example.invalid', '[PROVER] admin', 'admin', true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active;`);
  const customer = seedRow('customers', {});
  // One posted invoice per age, balance = age + 1 dollars, so every bucket total names its invoices.
  const aged = {};
  for (const age of AGES) {
    aged[age] = seedRow('invoices', {
      customer_id: customer, status: 'posted', posted_at: new Date().toISOString(),
      invoice_number: `PROVER-${randomUUID().slice(0, 8)}`, invoice_date: plus(-age - 30), due_date: plus(-age),
      total_amount_cents: (age + 1) * 100, paid_amount_cents: 0, prepay_applied_cents: 0,
    });
  }
  const draft = seedRow('invoices', { customer_id: customer, status: 'draft', invoice_number: `PROVER-${randomUUID().slice(0, 8)}`, invoice_date: today() });
  // An old row already past the limit (as if typed before the trigger existed).
  const farOld = seedRow('invoices', { customer_id: customer, status: 'draft', invoice_number: `PROVER-${randomUUID().slice(0, 8)}`, invoice_date: plus(400) });
  return { customer, aged, draft, farOld };
}
const dollars = (...ages) => ages.reduce((s, a) => s + a + 1, 0);
function dashboardBuckets() {
  const out = scalar(`SET request.jwt.claim.sub = '${ADMIN}'; SELECT (public.financial_dashboard_summary() -> 'ar_aging_buckets')::text;`);
  return Object.fromEntries(Object.entries(JSON.parse(out)).map(([k, v]) => [k, Number(v)]));
}

function main() {
  buildContainer();  // always a fresh sealed container: no reuse of any existing database
  const ids = seed();

  // BEFORE: the old strip puts a 30-day-old invoice in "current" (<= 30) and 90 in 61-90.
  const before = dashboardBuckets();
  assert.deepEqual(before, { current: dollars(0, 29, 30), days_31_60: dollars(59, 60), days_61_90: dollars(89, 90), days_90_plus: dollars(120) }, JSON.stringify(before));
  console.log(`[prover] BEFORE: dashboard aging ${JSON.stringify(before)} (30 days counted as current)`);

  // The preflight refuses while any invoice is already past the limit, and the refusal changes nothing.
  stageText('candidate.sql', lf(CANDIDATE));
  let r = apply('candidate.sql');
  assert.notEqual(r.status, 0); assert.match(r.output, /PREFLIGHT_FAIL: an invoice is already dated more than 365 days ahead/, r.output);
  assert.equal(scalar("SELECT count(*) FROM pg_trigger WHERE tgname = 'zz_refuse_far_future_invoice_date';"), '0');
  console.log('[prover] preflight refuses while an invoice is already more than 365 days ahead');
  const setDateRaw = (id, date) => psql(`SET session_replication_role = replica; UPDATE public.invoices SET invoice_date = '${date}' WHERE id = '${id}';`);
  setDateRaw(ids.farOld, plus(300));

  r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log('[prover] candidate applied (preflight and postflight passed)');

  // AFTER: the same ranges as get_ar_aging (0-29, 30-59, 60-89, 90+).
  const after = dashboardBuckets();
  assert.deepEqual(after, { current: dollars(0, 29), days_31_60: dollars(30, 59), days_61_90: dollars(60, 89), days_90_plus: dollars(90, 120) }, JSON.stringify(after));
  const ar = JSON.parse(scalar(`SET request.jwt.claim.sub = '${ADMIN}';
    SELECT jsonb_build_object('current', current_amount, 'd30', days_30, 'd60', days_60, 'd90', days_90 + over_90)::text
      FROM public.get_ar_aging((now() AT TIME ZONE 'America/Chicago')::date) WHERE customer_id = '${ids.customer}';`));
  assert.deepEqual([after.current, after.days_31_60, after.days_61_90, after.days_90_plus], [ar.current, ar.d30, ar.d60, ar.d90].map(Number),
    `dashboard ${JSON.stringify(after)} must equal get_ar_aging ${JSON.stringify(ar)}`);
  console.log(`[prover] AFTER: dashboard aging ${JSON.stringify(after)} equals get_ar_aging on the same Chicago date`);
  const period = JSON.parse(scalar(`SET request.jwt.claim.sub = '${ADMIN}'; SELECT (public.financial_dashboard_summary() -> 'current_period')::text;`));
  assert.ok(Number(period.days_remaining) >= 0, JSON.stringify(period));
  r = run('SET ROLE anon; SELECT public.financial_dashboard_summary();');
  assert.notEqual(r.status, 0); assert.match(r.output, /permission denied/);

  // Ticket numbers: the Chicago year, same format; only postgres may call it.
  const year = scalar("SELECT extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::int;");
  const ticket = scalar("SET TimeZone = 'Asia/Tokyo'; SELECT public.generate_ticket_number();");
  assert.match(ticket, new RegExp(`^BT-${year}-\\d{4,}$`), ticket);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.generate_ticket_number()', 'EXECUTE');`), 'f', `${role} must not execute generate_ticket_number`);
    assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.refuse_far_future_invoice_date()', 'EXECUTE');`), 'f', `${role} must not execute the trigger function`);
  }
  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public.financial_dashboard_summary()', 'EXECUTE');"), 't');
  console.log(`[prover] generate_ticket_number -> ${ticket} (Chicago year ${year}, session in Tokyo); grants unchanged`);

  // Invoice date limit.
  r = run(`UPDATE public.invoices SET invoice_date = '${plus(365)}' WHERE id = '${ids.draft}';`);
  assert.equal(r.status, 0, r.output);
  r = run(`UPDATE public.invoices SET invoice_date = '${plus(366)}' WHERE id = '${ids.draft}';`);
  assert.notEqual(r.status, 0); assert.match(r.output, /INVOICE_DATE_TOO_FAR_AHEAD/, r.output);
  assert.equal(scalar(`SELECT invoice_date FROM public.invoices WHERE id = '${ids.draft}';`), plus(365));
  r = run(`SET request.jwt.claim.sub = '${ADMIN}';
    INSERT INTO public.invoices (customer_id, status, invoice_number, invoice_date)
    VALUES ('${ids.customer}', 'draft', 'PROVER-FAR-${randomUUID().slice(0, 6)}', '${plus(366)}');`);
  assert.notEqual(r.status, 0); assert.match(r.output, /INVOICE_DATE_TOO_FAR_AHEAD/, r.output);
  // An earlier BEFORE UPDATE trigger that moves the date while another column is updated is caught too.
  r = run(`BEGIN;
    CREATE FUNCTION pg_temp.prover_bump_date() RETURNS trigger LANGUAGE plpgsql AS $b$
      BEGIN NEW.invoice_date := (now() AT TIME ZONE 'America/Chicago')::date + 400; RETURN NEW; END $b$;
    CREATE TRIGGER aa_prover_bump_date BEFORE UPDATE OF due_date ON public.invoices
      FOR EACH ROW EXECUTE FUNCTION pg_temp.prover_bump_date();
    UPDATE public.invoices SET due_date = '${plus(5)}' WHERE id = '${ids.draft}';
    COMMIT;`);
  assert.notEqual(r.status, 0); assert.match(r.output, /INVOICE_DATE_TOO_FAR_AHEAD/, r.output);
  assert.equal(scalar("SELECT count(*) FROM pg_trigger WHERE tgname = 'aa_prover_bump_date';"), '0', 'the test trigger rolled back');

  // Re-running the file passes its preflight (the new bodies are accepted) and changes nothing.
  r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  assert.equal(scalar("SELECT count(*) FROM pg_trigger WHERE tgname = 'zz_refuse_far_future_invoice_date';"), '1');
  console.log('[prover] a second apply passes and leaves one trigger');

  // A row that is already far ahead (as the clock passes, or written with triggers off) still edits.
  setDateRaw(ids.farOld, plus(400));
  r = run(`UPDATE public.invoices SET due_date = '${plus(10)}' WHERE id = '${ids.farOld}';`);
  assert.equal(r.status, 0, r.output);
  r = run(`UPDATE public.invoices SET invoice_date = invoice_date WHERE id = '${ids.farOld}';`);
  assert.equal(r.status, 0, r.output);
  console.log('[prover] invoice date: +365 accepted; +366 refused on insert, update, and when another trigger moves the date; an old far-dated row still edits');
  console.log('KI18_DB_DATES_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
