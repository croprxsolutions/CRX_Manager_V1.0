#!/usr/bin/env node
/**
 * Real-schema proof for M9 (refunds paid outside CRX, prepay balance check, returned checks).
 * Design: docs/plans/2026-11-23-m9-refunds-returned-checks-DESIGN.md. STAGE 1: written before the migration, so today
 * every case FAILS (the three functions do not exist); setup must still pass, so a failure is never a setup error.
 *
 * Container setup and replay copied from prove-month-close-payments-recheck-real-schema.mjs, replaying EVERY
 * post-baseline migration (no candidate yet; when the M9 migration lands it is simply the last file replayed).
 * Setup (real writers, committed): an admin, a rep, one customer per case; $500.00 Prepayment Manager checks
 * (create_prepay_check_splits); a $1,237.00 invoice dated 2026-10-05 paid by a $1,537.00 Record Payment dated
 * 2026-10-15 (allocate_payment, $300.00 kept as prepay); October 2026 closed through close_accounting_period.
 * Cases (each rolled back, so they never see each other):
 *   1) refund $300 of a $500 prepay check: prepay $200, a refund record, stored balance = credits = $200, the check's
 *      original amount (Month-End's figure) unchanged, the balance check agrees.
 *   2) refund $600 of $500: refused, nothing changed.
 *   3) refund dated 2026-10-20 (October closed): refused with the closed-period error.
 *   4) balance check: clean -> ok; +100 cents planted in customers.prepay_balance_cents -> ok=false, difference 100;
 *      the check changes nothing.
 *   5) returned check (dated today) for the October payment: invoice back to $1,237.00 unpaid, prepay -$300.00,
 *      October still closed, the October payment rows and October's Month-End payments unchanged, November's
 *      payments show the -$1,537.00 reversal, a returned-check entry dated today.
 *   6) a rep is refused each function; same-key replay returns the same result once; an edited retry is refused.
 *
 * Run: node scripts/smoke/prove-m9-refunds-returned-checks-real-schema.mjs   (needs Docker)
 * Prints M9_REFUNDS_RETURNED_CHECKS_PROOF_PASS when every case passes; otherwise lists each failing case and why and
 * exits 1. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-m9-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
  // Need live's storage.objects policies, which this database does not have; neither touches money.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// Parked/ledger-only files must not touch what M9 relies on.
const TOUCHED = /(prepay_credits|prepay_applications|allocation_sets|invoice_line_allocations|prepay_balance_cents|_month_payments_received|close_accounting_period|check_period_open)/i;
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
  const validate = bodyFrom('20260211000000_unit_tracking_pricing_overhaul.sql',
    /CREATE OR REPLACE FUNCTION validate_product_units\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)
    .replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
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
      expected, `${signature} is not the pinned live body`);
  }
}
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs', '--include-one-shot'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  for (const name of [...PARKED, ...LEDGER_ONLY]) {
    const file = all.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED / LEDGER_ONLY lists)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return all;
}
function installLiveAuthUid() {
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
}
const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
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
    if (ONE_SHOT.has(base.slice(0, -4))) { ledger(base.slice(0, -4)); continue; }
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
    }
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
      raw(`INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint)
        SELECT '00000000-0000-4000-8000-000000000000', 'unknown', 'units-proof' WHERE NOT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);`);
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations, last ${path.basename(files.at(-1))}`);
}

// ---------------------------------------------------------------------------------------------------------------
const id = (n) => `e9090000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1'); const REP = id('b1');
const C = { c1: id('c1'), c2: id('c2'), c3: id('c3'), c4: id('c4'), c5: id('c5'), c6: id('c6') };
const INV5 = id('e5');
const TODAY = "(now() AT TIME ZONE 'America/Chicago')::date";
const as = (uid) => `RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);
SET LOCAL ROLE authenticated;`;
const OWNER = 'RESET ROLE;';
/** One psql session: BEGIN; sql; COMMIT|ROLLBACK. Returns status, output, the last stdout row and NOTICE lines. */
function session(sql, end = 'ROLLBACK') {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${sql}\n${end};\n` });
  const output = `${r.stdout}\n${r.stderr}`;
  return {
    status: r.status, output,
    last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '',
    error: /ERROR:\s+([^\n]*)/.exec(r.stderr)?.[1] ?? null,
    refused: [...r.stderr.matchAll(/REFUSED\|([^\n]*)/g)].map((m) => m[1]),
  };
}
function mustCommit(label, sql) {
  const r = session(sql, 'COMMIT');
  if (r.status !== 0) throw new Error(`SETUP FAILED (${label}): ${r.output}`);
  return r.last;
}
/** A call that must be refused. A missing function is NOT a refusal: it is re-raised and fails the case. */
const refusal = (call) => `DO $m9$ BEGIN
  PERFORM ${call};
  RAISE EXCEPTION 'M9_NOT_REFUSED';
EXCEPTION WHEN undefined_function THEN RAISE;
  WHEN OTHERS THEN IF SQLERRM = 'M9_NOT_REFUSED' THEN RAISE; END IF; RAISE NOTICE 'REFUSED|%', SQLERRM;
END $m9$;`;
const refund = (cust, cents, key, { date = TODAY, credit = 'NULL', by = ADMIN, ref = 'QuickBooks check 1042' } = {}) =>
  `public.record_outside_refund('${cust}', ${cents}, ${date}, '${ref}', 'customer asked for the rest back', ${credit}, '${by}', '${key}')`;
const returned = (setSql, key, { by = ADMIN, reason = 'NSF: returned by the bank' } = {}) =>
  `public.record_returned_check(${setSql}, ${TODAY}, '${reason}', '${by}', '${key}')`;
const check = (cust) => `public.get_prepay_balance_check('${cust}')`;
const prepayState = (cust) => `json_build_object(
  'stored', (SELECT prepay_balance_cents FROM public.customers WHERE id = '${cust}'),
  'credits', (SELECT COALESCE(sum(balance_cents), 0) FROM public.prepay_credits WHERE customer_id = '${cust}'),
  'originals', (SELECT COALESCE(sum(original_amount_cents), 0) FROM public.prepay_credits WHERE customer_id = '${cust}'),
  'credit_rows', (SELECT md5(COALESCE(string_agg(row_to_json(pc)::text, ',' ORDER BY pc.id), '')) FROM public.prepay_credits pc WHERE customer_id = '${cust}'))`;
const SET5 = `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c5}' AND entity_type = 'payment')`;
const SET6 = `(SELECT id FROM public.allocation_sets WHERE customer_id = '${C.c6}' AND entity_type = 'payment')`;

function seed() {
  psql('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;', { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'm9-a@example.invalid', '{"full_name":"[PROVER] M9 admin","role":"admin"}'::jsonb),
    ('${REP}', 'm9-r@example.invalid', '{"full_name":"[PROVER] M9 rep","role":"sales_rep"}'::jsonb);`);
  raw(`BEGIN;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES
      ${Object.entries(C).map(([k, v]) => `('${v}', '[PROVER] M9 ${k} Farm', true)`).join(',\n      ')};
    -- Case 5: a $1,237.00 invoice dated 2026-10-05, already posted.
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, posted_by, posted_at)
      VALUES ('${INV5}', 'M9-RC-INV', '${C.c5}', 'misc_charge', 'posted', DATE '2026-10-05', DATE '2027-01-31', 123700, '${ADMIN}', '${ADMIN}', '2026-10-05 15:00Z');
    COMMIT;`);
  // $500.00 Prepayment Manager checks through the real writer (cases 1, 2, 3, 4, 6).
  for (const k of ['c1', 'c2', 'c3', 'c4', 'c6']) {
    mustCommit(`prepay check ${k}`, `${as(ADMIN)}
      SELECT public.create_prepay_check_splits('${C[k]}', 'M9-${k}', '[{"label":"A","amount_cents":50000}]'::jsonb, '${ADMIN}', 'm9-setup-check-${k}')::text;`);
  }
  // Case 6: a $200.00 Record Payment dated today, all kept as prepay (a returned check in the open month).
  mustCommit('payment c6', `${as(ADMIN)}
    SELECT public.allocate_payment('${C.c6}', 20000, 'check', 'M9-C6-PAY', '2002', ${TODAY}, 'm9', '[]'::jsonb, '${ADMIN}', 'm9-setup-pay-c6')::text;`);
  // Case 5: a $1,537.00 check dated 2026-10-15 pays the invoice; $300.00 becomes prepay.
  const pay5 = JSON.parse(mustCommit('payment c5', `${as(ADMIN)}
    SELECT public.allocate_payment('${C.c5}', 153700, 'check', 'M9-RC-PAY', '1001', DATE '2026-10-15', 'm9',
      jsonb_build_array(jsonb_build_object('invoice_id', '${INV5}', 'amount_cents', 123700)), '${ADMIN}', 'm9-setup-pay-c5')::text;`));
  assert.equal(pay5.prepay_created_cents, 30000);
  // Close October through the real close (reviewed token, payments reviewed).
  mustCommit('close October', `${as(ADMIN)}
    SELECT public.close_accounting_period(DATE '2026-10-31', '${ADMIN}', 'm9-setup-close-oct',
      public.get_monthly_summary(DATE '2026-10-01', DATE '2026-10-31') ->> 'review_token', true, true)::text;`);
  const state = JSON.parse(scalar(`SELECT json_build_object(
    'c1', ${prepayState(C.c1)}, 'c5', ${prepayState(C.c5)}, 'c6', ${prepayState(C.c6)},
    'inv5', (SELECT status || ':' || balance_cents FROM public.invoices WHERE id = '${INV5}'),
    'oct', (SELECT status FROM public.accounting_periods WHERE period_end = DATE '2026-10-31'))::text;`));
  assert.deepEqual([state.c1.stored, state.c1.credits], [50000, 50000], 'setup: c1 holds $500 prepay');
  assert.deepEqual([state.c5.stored, state.c5.credits], [30000, 30000], 'setup: c5 holds $300 prepay from the October payment');
  assert.deepEqual([state.c6.stored, state.c6.credits], [70000, 70000], 'setup: c6 holds $500 check + $200 payment');
  assert.equal(state.inv5, 'paid:0', 'setup: the October invoice is paid');
  assert.equal(state.oct, 'closed', 'setup: October 2026 is closed');
  console.log('[setup] admin, rep, six customers; $500 prepay checks; Oct 15 $1,537 payment paid the $1,237 Oct 5 invoice (+$300 prepay); October 2026 closed');
}

// ---------------------------------------------------------------------------------------------------------------
const CASES = [];
const kase = (name, fn) => CASES.push([name, fn]);
/** Fails the case with the database's own error when the session did not run to the end. */
function ran(r) { if (r.status !== 0) throw new Error(r.error ?? r.output.trim().split('\n').at(-1)); return r; }

kase('1) refund $300 of a $500 prepay check', () => {
  const r = ran(session(`${as(ADMIN)}
    SELECT ${refund(C.c1, 30000, 'm9-c1-refund')}::text AS res \\gset
    SELECT ${check(C.c1)}::text AS chk \\gset
    ${OWNER}
    SELECT json_build_object('res', :'res'::jsonb, 'chk', :'chk'::jsonb, 'state', ${prepayState(C.c1)},
      'records', (SELECT json_agg(json_build_object('kind', kind, 'amount', amount_cents, 'date', entry_date = ${TODAY},
          'by', performed_by, 'reference', reference, 'reason', reason,
          'lines', (SELECT json_agg(json_build_object('credit', l.prepay_credit_id IS NOT NULL, 'amount', l.amount_cents))
                      FROM public.money_reversal_lines l WHERE l.reversal_id = mr.id)))
        FROM public.money_reversals mr WHERE mr.customer_id = '${C.c1}'))::text;`));
  const o = JSON.parse(r.last);
  assert.equal(o.state.credits, 20000, 'credits = $200');
  assert.equal(o.state.stored, 20000, 'stored balance = $200');
  assert.equal(o.state.originals, 50000, "the check's original amount (Month-End's figure) is unchanged");
  assert.equal(o.records?.length, 1, 'one refund record');
  const rec = o.records[0];
  assert.deepEqual([rec.kind, rec.amount, rec.date, rec.by, rec.reference], ['outside_refund', 30000, true, ADMIN, 'QuickBooks check 1042']);
  assert.deepEqual(rec.lines, [{ credit: true, amount: 30000 }], 'one line: $300 from the one credit');
  const row = o.chk.find((x) => x.customer_id === C.c1);
  assert.deepEqual([row.received_cents, row.refunded_cents, row.expected_cents, row.stored_cents, row.credits_cents, row.ok],
    [50000, 30000, 20000, 20000, 20000, true], 'the balance check agrees after the refund');
});

kase('2) refund $600 of $500 is refused', () => {
  const r = ran(session(`${OWNER} SELECT ${prepayState(C.c2)}::text AS before \\gset
    ${as(ADMIN)}
    ${refusal(refund(C.c2, 60000, 'm9-c2-over'))}
    ${OWNER}
    SELECT json_build_object('before', :'before'::jsonb, 'after', ${prepayState(C.c2)},
      'records', (SELECT count(*) FROM public.money_reversals WHERE customer_id = '${C.c2}'))::text;`));
  assert.equal(r.refused.length, 1, 'refused');
  assert.match(r.refused[0], /exceed|more than|available|insufficient/i, `refusal names the over-refund: ${r.refused[0]}`);
  const o = JSON.parse(r.last);
  assert.deepEqual(o.after, o.before, 'prepay unchanged');
  assert.equal(o.records, 0, 'no refund record');
});

kase('3) refund dated 2026-10-20 (October closed) is refused', () => {
  const r = ran(session(`${as(ADMIN)}
    ${refusal(refund(C.c3, 10000, 'm9-c3-closed', { date: "DATE '2026-10-20'" }))}
    ${OWNER} SELECT 'done';`));
  assert.equal(r.refused.length, 1, 'refused');
  assert.match(r.refused[0], /closed accounting period/i, `closed-period error: ${r.refused[0]}`);
});

kase('4) balance check: clean -> ok; planted +100 drift -> ok=false, difference 100; read-only', () => {
  const r = ran(session(`${as(ADMIN)}
    SELECT ${check(C.c4)}::text AS clean \\gset
    ${OWNER}
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 100 WHERE id = '${C.c4}';
    SELECT ${prepayState(C.c4)}::text AS planted \\gset
    ${as(ADMIN)}
    SELECT ${check(C.c4)}::text AS drift \\gset
    SELECT public.get_prepay_balance_check(NULL)::text AS everyone \\gset
    ${OWNER}
    SELECT json_build_object('clean', :'clean'::jsonb, 'drift', :'drift'::jsonb, 'everyone', :'everyone'::jsonb,
      'planted', :'planted'::jsonb, 'after', ${prepayState(C.c4)})::text;`));
  const o = JSON.parse(r.last);
  assert.equal(o.clean.length, 1, 'one row for one customer');
  assert.deepEqual(o.clean[0], {
    customer_id: C.c4, farm_name: '[PROVER] M9 c4 Farm', received_cents: 50000, applied_cents: 0, refunded_cents: 0,
    voided_cents: 0, expected_cents: 50000, stored_cents: 50000, credits_cents: 50000, difference_cents: 0, ok: true,
  });
  assert.deepEqual([o.drift[0].ok, o.drift[0].difference_cents, o.drift[0].stored_cents, o.drift[0].expected_cents], [false, 100, 50100, 50000]);
  assert.equal(o.everyone.find((x) => x.customer_id === C.c4)?.ok, false, 'the all-customers check flags it too');
  assert.equal(o.everyone.find((x) => x.customer_id === C.c1)?.ok, true, 'and leaves a clean customer ok');
  assert.deepEqual(o.after, o.planted, 'the check changed nothing (no silent fix)');
});

kase('5) returned check from closed October, recorded today', () => {
  const OCT_ROWS = `(SELECT md5(row_to_json(a)::text || COALESCE((SELECT string_agg(row_to_json(l)::text, ',' ORDER BY l.id)
      FROM public.invoice_line_allocations l WHERE l.allocation_set_id = a.id), '')) FROM public.allocation_sets a WHERE a.id = ${SET5})`;
  const months = `json_build_object('oct', public.get_monthly_summary(DATE '2026-10-01', DATE '2026-10-31') -> 'payments',
      'now', public.get_monthly_summary(date_trunc('month', ${TODAY})::date, ${TODAY}) -> 'payments')`;
  const r = ran(session(`${OWNER} SELECT ${OCT_ROWS} AS oct_rows \\gset
    ${as(ADMIN)}
    SELECT ${months}::text AS months_before \\gset
    SELECT ${returned(SET5, 'm9-c5-returned')}::text AS res \\gset
    SELECT ${months}::text AS months_after \\gset
    ${OWNER}
    SELECT json_build_object('res', :'res'::jsonb, 'before', :'months_before'::jsonb, 'after', :'months_after'::jsonb,
      'oct_rows_same', ${OCT_ROWS} = :'oct_rows',
      'inv', (SELECT json_build_object('status', status, 'balance', balance_cents, 'paid', paid_amount_cents) FROM public.invoices WHERE id = '${INV5}'),
      'state', ${prepayState(C.c5)},
      'oct', (SELECT status FROM public.accounting_periods WHERE period_end = DATE '2026-10-31'),
      'entry', (SELECT json_agg(json_build_object('kind', kind, 'amount', amount_cents, 'today', entry_date = ${TODAY}))
                  FROM public.money_reversals WHERE allocation_set_id = ${SET5}))::text;`));
  const o = JSON.parse(r.last);
  assert.equal(o.inv.balance, 123700, 'invoice balance back to $1,237.00');
  assert.ok(['posted', 'overdue'].includes(o.inv.status), `invoice unpaid again (status ${o.inv.status})`);
  assert.equal(o.state.stored, 0, 'customer stored prepay -$300.00');
  assert.equal(o.state.credits, 0, 'the $300.00 credit is gone');
  assert.equal(o.oct, 'closed', 'October still closed');
  assert.equal(o.oct_rows_same, true, 'the October payment rows (allocation set + allocation lines) are unchanged');
  assert.deepEqual(o.after.oct, o.before.oct, "October's Month-End payments received unchanged");
  assert.equal(o.after.now.total_cents, o.before.now.total_cents - 153700, "this month's payments show the -$1,537.00 reversal");
  assert.deepEqual(o.entry, [{ kind: 'returned_check', amount: 153700, today: true }], 'a returned-check entry dated today');
});

kase('6) rep refused; same-key replay returns the same result once; edited retry refused', () => {
  const rep = ran(session(`${as(REP)}
    ${refusal(refund(C.c6, 100, 'm9-c6-rep', { by: REP }))}
    ${refusal(check(C.c6))}
    ${refusal(returned(SET6, 'm9-c6-rep-rc', { by: REP }))}
    ${OWNER} SELECT 'done';`));
  assert.equal(rep.refused.length, 3, 'all three refused');
  for (const m of rep.refused) assert.match(m, /INSUFFICIENT_ROLE|admin/i, `rep refusal: ${m}`);

  const replay = ran(session(`${as(ADMIN)}
    SELECT ${refund(C.c6, 10000, 'm9-c6-key')}::text AS r1 \\gset
    SELECT ${refund(C.c6, 10000, 'm9-c6-key')}::text AS r2 \\gset
    SELECT ${returned(SET6, 'm9-c6-rc-key')}::text AS q1 \\gset
    SELECT ${returned(SET6, 'm9-c6-rc-key')}::text AS q2 \\gset
    ${OWNER}
    SELECT json_build_object('refund_same', :'r1'::jsonb = :'r2'::jsonb, 'returned_same', :'q1'::jsonb = :'q2'::jsonb,
      'refunds', (SELECT count(*) FROM public.money_reversals WHERE customer_id = '${C.c6}' AND kind = 'outside_refund'),
      'returns', (SELECT count(*) FROM public.money_reversals WHERE customer_id = '${C.c6}' AND kind = 'returned_check'),
      'state', ${prepayState(C.c6)})::text;`));
  const o = JSON.parse(replay.last);
  assert.deepEqual([o.refund_same, o.returned_same, o.refunds, o.returns], [true, true, 1, 1], 'replays return the same result and save once');
  assert.deepEqual([o.state.stored, o.state.credits], [40000, 40000], '$700 - $100 refund - $200 returned check = $400');

  const edited = ran(session(`${as(ADMIN)}
    SELECT ${refund(C.c6, 10000, 'm9-c6-edit')}::text AS r1 \\gset
    ${refusal(refund(C.c6, 12000, 'm9-c6-edit'))}
    SELECT ${returned(SET6, 'm9-c6-rc-edit')}::text AS q1 \\gset
    ${refusal(returned(SET6, 'm9-c6-rc-edit', { reason: 'a different reason' }))}
    ${OWNER} SELECT 'done';`));
  assert.equal(edited.refused.length, 2, 'both edited retries refused');
  for (const m of edited.refused) assert.match(m, /IDEMPOTENCY_INTENT_MISMATCH/, `edited retry: ${m}`);
});

async function main() {
  buildContainer();
  seed();
  const failed = [];
  for (const [name, fn] of CASES) {
    try { fn(); console.log(`[PASS] ${name}`); } catch (e) {
      const why = (e.message ?? String(e)).split('\n')[0];
      failed.push([name, why]);
      console.log(`[FAIL] ${name}\n       ${why}`);
    }
  }
  if (failed.length) {
    console.log(`M9_REFUNDS_RETURNED_CHECKS_PROOF_FAIL: ${failed.length} of ${CASES.length} case(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('M9_REFUNDS_RETURNED_CHECKS_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
