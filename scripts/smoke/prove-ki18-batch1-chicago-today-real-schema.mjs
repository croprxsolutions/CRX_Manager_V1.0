#!/usr/bin/env node
/**
 * Real-schema proof for 20261204100000 (KI-18 batch 1: money, compliance and stock decisions take
 * "today" from the Chicago date). Builds the checked-in schema baseline in a network-disabled PostgreSQL
 * container, replays every migration before the candidate, then:
 *  - runs in a session zone whose date differs from Chicago's (the UTC-evening case) and shows BEFORE that
 *    overdue marking, quote expiry and reminder day counts follow the wrong date;
 *  - applies the candidate and checks every replaced definition equals its pre-image with only CURRENT_DATE
 *    swapped for the Chicago date (grants unchanged), and that the same decisions now follow Chicago;
 *  - checks the four column defaults, then 16 fixed instants (6 pm CST / 7 pm CDT edges, midnight, month,
 *    season and year ends, both DST changes) including compute_season;
 *  - applies the candidate a second time (re-runnable).
 * `--dump <dir>` instead writes each target's pre-candidate definition (used to generate the candidate).
 *
 * Run: node scripts/smoke/prove-ki18-batch1-chicago-today-real-schema.mjs   (needs local Docker image)
 * Prints KI18_BATCH1_CHICAGO_TODAY_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki18-b1-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261204100000_ki18_batch1_chicago_today.sql');
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
// Every function the candidate replaces (regprocedure text). Each changes only its UTC "today".
// Left out (Mason 2026-11-06, Sol advice): the three overnight jobs run while the UTC and Chicago dates agree;
// _sync_job_holds' evening hold expiry is a follow-up, fixed with its actor and key hardening.
export const UNCHANGED = ['mark_overdue_invoices()', 'auto_expire_quotes()', 'run_morning_notification_checks()', '_sync_job_holds(uuid,uuid)'];
export const TARGETS = [
  '_reverse_credit_memo_application(uuid,uuid,text,text)',
  '_reverse_write_off_replay_impl_20261015(uuid,text,uuid,text)',
  'apply_credit_memo_to_invoice(uuid,uuid,bigint,uuid,text)',
  '_apply_prepay_to_invoice_replay_impl_20261015(uuid,uuid,bigint,uuid,text)',
  '_apply_write_off_replay_impl_20261015(uuid,bigint,text,uuid,text)',
  '_post_commission_payment_intent_impl_20260809(uuid,uuid,text)',
  '_void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)',
  '_void_payment_replay_impl_20261015(uuid,text,uuid,text)',
  '_create_commission_payment_intent_impl_20260809(uuid[],text,text,date,text,uuid,text)',
  '_save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)',
  'get_ar_reminder_candidates()',
  '_enforce_applicator_license()',
  '_dispatch_job_locations_replay_impl_20261015(jsonb,uuid,text,boolean)',
  'generate_rup_sales_records(uuid,text)',
  'get_dispatch_stock_status(uuid[])',
  'get_job_inventory_shortfalls(integer)',
  '_get_inventory_position_cost_impl_20261019()',
  '_create_inventory_hold_intent_impl_20260905(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)',
  '_transition_rebate_claim_replay_impl_20261015(uuid,text,bigint,text,text)',
  '_create_rush_order_below_cost_impl_20260810(uuid,jsonb,text,text,uuid,text)',
  '_create_followup_delivery_replay_impl_20261015(uuid,date,uuid,text)',
  '_create_job_from_quote_section_replay_impl_20261015(uuid,uuid,uuid,text)',
  '_batch_reschedule_deliveries_replay_impl_20261015(uuid[],date,uuid,text)',
  '_save_field_crop_history_replay_impl_20261015(uuid,integer,text,text,date,date,numeric,text,text,uuid,text)',
  '_save_field_app_split_invoice_impl(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text,text)',
  'snapshot_field_crop_history()',
  'create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)',
  'record_vendor_payment(uuid,bigint,date,text,text,text,text)',
  'create_order_from_blend_ticket(uuid,text,date,text,uuid,text)',
  'create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean)',
  // Reversals check the month of the row they undo on both the UTC and the Chicago date (Sol, PR 1579).
  'reverse_credit_memo_application(uuid,text,uuid,text)',
  '_unapply_return_credit_guard_impl_20260826(uuid,text,uuid,text)',
  '_void_invoice_split_provenance_impl_20260719(uuid,text,text)',
];
const fnName = (sig) => sig.slice(0, sig.indexOf('('));
const TARGET_RE = new RegExp(`FUNCTION\\s+(public\\.)?(${TARGETS.map(fnName).join('|')})\\s*\\(`, 'i');
const TOUCHED = TARGET_RE;
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
    // BLK-1a's preflight needs the count units live already has.
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql("INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Ea', 1, 'both'), ('Unit', 1, 'both') ON CONFLICT DO NOTHING;");
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const ADMIN = '16000000-0000-4000-8000-000000000018';
const SYSTEM_ACTOR = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f';  // mark_overdue_invoices' audit actor
const CHI = "(now() AT TIME ZONE 'America/Chicago')::date";

// The candidate's only edit: CURRENT_DATE (outside -- comments) becomes the Chicago date,
// get_ar_reminder_candidates counts calendar days, and generate_rup_sales_records records the invoice date as
// the sale date and takes its season from it (Mason, 2026-11-06). Applied to the pre-image, it must give the post-image.
// Postgres re-prints an argument default in normalized form, so the header line expects that form.
const CHI_ARG = "((now() AT TIME ZONE 'America/Chicago'::text))::date";
const REMIND_OLD = 'EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int';
const REMIND_NEW = `(${CHI} - COALESCE(i.due_date, i.invoice_date))`;
// Mason 2026-11-06: the sale date is the earlier of the invoice date and the posting day, so a backdated
// invoice records its own day and a future-dated one never records a future sale; the season follows it.
const RUP_SALE = 'LEAST(v_invoice.invoice_date, CURRENT_DATE)';
const RUP_SWAPS = [
  ['c.farm_name, i.created_at,', 'c.farm_name, i.invoice_date,'],
  ['v_invoice.created_at', RUP_SALE],
  ['CURRENT_DATE, v_item.product_name', `${RUP_SALE}, v_item.product_name`],
  ['SELECT al.license_number, al.license_type, al.expiry_date', 'SELECT al.license_number, al.license_type, al.expiry_date, al.issued_date'],
  // Prefer a license that covers the sale; fall back to the latest expiry only when none does (Codex App, PR 1579).
  ['ORDER BY al.expiry_date DESC NULLS LAST', `ORDER BY ((al.issued_date IS NOT NULL AND al.issued_date <= ${RUP_SALE})`
    + ' AND al.expiry_date >= GREATEST(v_invoice.invoice_date, CURRENT_DATE)) DESC, al.expiry_date DESC NULLS LAST'],
  // The license must be unexpired on the invoice date and today, and issued by the sale date.
  // Mason 2026-11-06: a license with no issue date on file warns ("issue date unknown").
  ['v_license.expiry_date < CURRENT_DATE', 'v_license.expiry_date < GREATEST(v_invoice.invoice_date, CURRENT_DATE)'],
  ["v_compliance_notes := 'Applicator license expired on ' || v_license.expiry_date::text;",
    "v_compliance_notes := 'Applicator license expired on ' || v_license.expiry_date::text;\n"
    + '    ELSIF v_license.issued_date IS NULL THEN\n'
    + "      v_compliance_status := 'warning';\n"
    + "      v_compliance_notes := 'Applicator license issue date unknown';\n"
    + `    ELSIF v_license.issued_date > ${RUP_SALE} THEN\n`
    + "      v_compliance_status := 'warning';\n"
    + "      v_compliance_notes := 'Applicator license issued on ' || v_license.issued_date::text || ', after the sale date';"],
];
// A reversal refuses when either the UTC or the Chicago date of the row it undoes is in a closed month
// (older rows were checked on the UTC date when made, newer ones on the Chicago date; _fix_delivery_plan does the same).
const PERIOD_FNS = ['_reverse_write_off_replay_impl_20261015(', 'reverse_credit_memo_application(',
  '_unapply_return_credit_guard_impl_20260826(', '_void_invoice_split_provenance_impl_20260719('];
const PERIOD_OLD = /check_period_open\((v_\w+)\.(applied_at|created_at)::date\);/;
// AT TIME ZONE 'UTC' so the UTC reading does not follow the session's time zone (Sol, PR 1579).
const PERIOD_NEW = "check_period_open(($1.$2 AT TIME ZONE 'UTC')::date); PERFORM check_period_open(($1.$2 AT TIME ZONE 'America/Chicago')::date);";
function swap(sig, def) {
  return def.split('\n').map((line) => {
    const c = line.indexOf('--');
    const code = c >= 0 ? line.slice(0, c) : line;
    let next = sig.startsWith('get_ar_reminder_candidates') ? code.split(REMIND_OLD).join(REMIND_NEW) : code;
    if (sig.startsWith('generate_rup_sales_records')) for (const [from, to] of RUP_SWAPS) next = next.split(from).join(to);
    if (PERIOD_FNS.some((p) => sig.startsWith(p))) next = next.replace(PERIOD_OLD, PERIOD_NEW);
    next = next.replace(/\bcurrent_date\b/gi, line.startsWith('CREATE OR REPLACE FUNCTION') ? CHI_ARG : CHI);
    return next + (c >= 0 ? line.slice(c) : '');
  }).join('\n');
}
const definition = (sig) => docker([...psqlArgs(), '-A', '-t'], { input: `SELECT pg_get_functiondef('public.${sig}'::regprocedure);` }).stdout.replace(/\r/g, '');
const acl = (sig) => scalar(`SELECT coalesce(proacl::text, '-') || ' ' || pg_get_userbyid(proowner) || ' ' || prosecdef FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;`);

// Insert one row into public.<table> with session_replication_role = replica (no triggers or FK checks),
// filling every NOT NULL column that has no default with a typed placeholder; `fields` override them.
function seedRow(table, fields) {
  const id = randomUUID();
  const overrides = JSON.stringify({ id, ...fields }).replaceAll("'", "''");
  psql(`SET session_replication_role = replica; SET request.jwt.claim.sub = '${ADMIN}';
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
const addDays = (date, n) => scalar(`SELECT ('${date}'::date + ${n})::text;`);

function seed(zone, early) {
  for (const [id, email] of [[ADMIN, 'ki18-b1-admin@example.invalid'], [SYSTEM_ACTOR, 'ki18-b1-system@example.invalid']]) {
    psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${id}', '${email}', '{"full_name":"[PROVER] ${email}"}'::jsonb) ON CONFLICT DO NOTHING;
      SET session_replication_role = replica;
      INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES ('${id}', '${email}', '[PROVER] ${email}', 'admin', true)
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active;`);
  }
  const customer = seedRow('customers', { email: 'ki18-b1-customer@example.invalid' });
  const invoice = (due) => seedRow('invoices', {
    customer_id: customer, status: 'posted', posted_at: new Date().toISOString(), invoice_type: 'chemical_sale',
    invoice_number: `PROVER-${randomUUID().slice(0, 8)}`, invoice_date: addDays(due, -30), due_date: due,
    total_amount_cents: 10000, paid_amount_cents: 0, prepay_applied_cents: 0,
  });
  const T = today();
  return {
    customer,
    boundary: invoice(early),                       // due on the earlier of the two "todays"
    late31: invoice(addDays(T, -31)), late30: invoice(addDays(T, -30)),
    quote: seedRow('quotes', { customer_id: customer, status: 'sent', expires_at: early, is_planned: false, quote_number: `PQ-${randomUUID().slice(0, 8)}` }),
    zone,
  };
}
const today = () => scalar(`SELECT ${CHI};`);

// In a session whose zone puts CURRENT_DATE one day off the Chicago date (as UTC does every evening),
// run each job in a rolled-back transaction and report what it decided.
function decisions(ids) {
  const inZone = (sql) => scalar(`SET TimeZone = '${ids.zone}'; SET request.jwt.claim.sub = '${ADMIN}'; BEGIN; ${sql} ROLLBACK;`);
  const remind = JSON.parse(inZone(`SELECT coalesce((SELECT jsonb_object_agg(x->>'invoice_id', (x->>'days_past_due')::int)
      FROM jsonb_array_elements(public.get_ar_reminder_candidates()) c, jsonb_array_elements(c->'invoices') x), '{}')::text;`));
  return { late31: remind[ids.late31] ?? null, late30: remind[ids.late30] ?? null };
}

// The Chicago date at fixed instants: 5:59/6:00 pm CST, 6:59/7:00 pm CDT, midnight Central, month,
// season and year ends, and both 2026 daylight-saving changes. The UTC date is what CURRENT_DATE was.
const BOUNDARIES = [
  ['2026-12-01 23:59:00+00', '5:59 pm CST', '2026-12-01', '2026-12-01'],
  ['2026-12-02 00:00:00+00', '6:00 pm CST', '2026-12-02', '2026-12-01'],
  ['2026-12-02 05:59:59+00', '11:59 pm CST', '2026-12-02', '2026-12-01'],
  ['2026-12-02 06:00:00+00', 'midnight CST', '2026-12-02', '2026-12-02'],
  ['2026-07-01 23:59:00+00', '6:59 pm CDT', '2026-07-01', '2026-07-01'],
  ['2026-07-02 00:00:00+00', '7:00 pm CDT', '2026-07-02', '2026-07-01'],
  ['2026-07-02 05:00:00+00', 'midnight CDT', '2026-07-02', '2026-07-02'],
  ['2026-11-01 00:30:00+00', 'Oct 31 7:30 pm CDT (month end)', '2026-11-01', '2026-10-31'],
  ['2026-10-01 00:30:00+00', 'Sep 30 7:30 pm CDT (season end)', '2026-10-01', '2026-09-30'],
  ['2027-01-01 05:59:00+00', 'Dec 31 11:59 pm CST (year end)', '2027-01-01', '2026-12-31'],
  ['2026-03-08 05:59:00+00', 'Mar 7 11:59 pm CST (spring forward night)', '2026-03-08', '2026-03-07'],
  ['2026-03-08 08:00:00+00', 'Mar 8 3:00 am CDT (after spring forward)', '2026-03-08', '2026-03-08'],
  ['2026-11-01 04:59:00+00', 'Oct 31 11:59 pm CDT (fall back night)', '2026-11-01', '2026-10-31'],
  ['2026-11-01 06:30:00+00', 'Nov 1 1:30 am CDT (first 1:30)', '2026-11-01', '2026-11-01'],
  ['2026-11-01 07:30:00+00', 'Nov 1 1:30 am CST (second 1:30)', '2026-11-01', '2026-11-01'],
  ['2026-11-02 00:00:00+00', 'Nov 1 6:00 pm CST (first evening after fall back)', '2026-11-02', '2026-11-01'],
];

let startDay = null;  // the Chicago date the run started on
function main() {
  buildContainer();  // always a fresh sealed container: no reuse of any existing database
  const T = today();
  startDay = T;
  const zone = scalar(`SELECT CASE WHEN (now() AT TIME ZONE 'Pacific/Kiritimati')::date <> ${CHI} THEN 'Pacific/Kiritimati' ELSE 'Etc/GMT+12' END;`);
  const D = scalar(`SET TimeZone = '${zone}'; SELECT current_date::text;`);
  assert.notEqual(D, T, 'the test zone must put CURRENT_DATE on another day than Chicago');
  const early = D < T ? D : T;
  const ids = seed(zone, early);
  // What the Chicago date says: overdue only once the due date is before Chicago today, and so on.
  const want = {
    late31: 31, late30: null,
  };
  console.log(`[prover] Chicago date ${T}; session zone ${zone} gives CURRENT_DATE ${D} (as UTC does after 6 pm Central)`);

  const preDefs = Object.fromEntries(TARGETS.map((sig) => [sig, definition(sig)]));
  const preAcl = Object.fromEntries(TARGETS.map((sig) => [sig, acl(sig)]));
  const before = decisions(ids);
  assert.notDeepEqual(before, want, `BEFORE AR reminder days already follow Chicago: ${JSON.stringify(before)}`);
  const preUnchanged = Object.fromEntries(UNCHANGED.map((sig) => [sig, definition(sig)]));
  console.log(`[prover] BEFORE (UTC-style date): ${JSON.stringify(before)}; Chicago answer ${JSON.stringify(want)}`);

  stageText('candidate.sql', lf(CANDIDATE));
  let r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log(`[prover] candidate applied (preflight and postflight passed) for ${TARGETS.length} functions`);

  // Every function equals its pre-image with only the date swapped; grants, owner and SECURITY DEFINER kept.
  for (const sig of TARGETS) {
    const post = definition(sig);
    assert.equal(post, swap(sig, preDefs[sig]), `${sig}: the new definition differs from the pre-image by more than the date swap`);
    assert.notEqual(post, preDefs[sig], `${sig}: nothing changed`);
    assert.equal(acl(sig), preAcl[sig], `${sig}: grants, owner or SECURITY DEFINER changed`);
  }
  for (const sig of UNCHANGED) assert.equal(definition(sig), preUnchanged[sig], `${sig}: must be left unchanged`);
  console.log(`[prover] all ${TARGETS.length} definitions equal their pre-image with only CURRENT_DATE swapped; grants unchanged`);

  const after = decisions(ids);
  assert.deepEqual(after, want, `AFTER ${JSON.stringify(after)} must follow the Chicago date ${JSON.stringify(want)}`);
  console.log(`[prover] AFTER (same session zone): ${JSON.stringify(after)} = the Chicago answer`);

  // Mason 2026-11-06: a RUP record carries the invoice date and its season. A Sep 30 invoice posted on
  // Oct 1 records Sep 30 in the 2026 season, whatever day the record is written.
  const rupOrder = seedRow('orders', { customer_id: ids.customer, order_number: `PO-${randomUUID().slice(0, 8)}` });
  const rupInvoice = seedRow('invoices', {
    customer_id: ids.customer, order_id: rupOrder, status: 'posted', posted_at: '2026-10-01T15:00:00Z',
    created_at: '2026-10-01T15:00:00Z', invoice_type: 'chemical_sale', invoice_number: `PROVER-${randomUUID().slice(0, 8)}`,
    invoice_date: '2026-09-30', due_date: '2026-10-30', total_amount_cents: 10000, paid_amount_cents: 0, prepay_applied_cents: 0,
  });
  const rupProduct = seedRow('products', { product_name: '[PROVER] RUP', sku: `RUP-${randomUUID().slice(0, 8)}`, is_rup: true, is_active: true });
  seedRow('invoice_items', { invoice_id: rupInvoice, product_id: rupProduct, quantity: 1, unit_size: 'gal', unit_price_cents: 10000, extended_cents: 10000 });
  const rup = scalar(`SET TimeZone = '${zone}'; SET request.jwt.claim.sub = '${ADMIN}'; BEGIN;
    SELECT public.generate_rup_sales_records('${rupInvoice}'::uuid);
    SELECT string_agg(sale_date::text || ' ' || season, ',') FROM public.rup_sales_records WHERE invoice_id = '${rupInvoice}'; ROLLBACK;`);
  assert.equal(rup, '2026-09-30 2026', `RUP record must carry the invoice date and its season, got ${rup}`);
  console.log(`[prover] RUP record for a Sep 30 invoice posted Oct 1: sale date and season ${rup}`);

  // Sol (PR 1579): a license valid today but expired before a future invoice date is a warning, not compliant.
  const plusDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const futureInvoice = seedRow('invoices', {
    customer_id: ids.customer, order_id: rupOrder, status: 'posted', posted_at: '2026-10-01T15:00:00Z',
    invoice_type: 'chemical_sale', invoice_number: `PROVER-${randomUUID().slice(0, 8)}`,
    invoice_date: plusDays(startDay, 30), due_date: plusDays(startDay, 60), total_amount_cents: 10000, paid_amount_cents: 0, prepay_applied_cents: 0,
  });
  seedRow('invoice_items', { invoice_id: futureInvoice, product_id: rupProduct, quantity: 1, unit_size: 'gal', unit_price_cents: 10000, extended_cents: 10000 });
  const license = (expiry, issued = '2026-01-01', invoice = futureInvoice) => scalar(`SET TimeZone = '${zone}'; SET request.jwt.claim.sub = '${ADMIN}'; BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.applicator_licenses (customer_id, license_number, license_type, holder_name, expiry_date, issued_date, is_active)
      VALUES ('${ids.customer}', 'PROVER-1', 'private', '[PROVER] holder', '${expiry}', ${issued ? `'${issued}'` : 'NULL'}, true);
    SET LOCAL session_replication_role = origin;
    SELECT public.generate_rup_sales_records('${invoice}'::uuid);
    SELECT string_agg(compliance_status || ' ' || sale_date::text, ',') FROM public.rup_sales_records WHERE invoice_id = '${invoice}'; ROLLBACK;`);
  assert.equal(license(plusDays(startDay, 5)), `warning ${startDay}`, 'a license that expires before the invoice date must warn');
  // Mason 2026-11-06 ("earlier of the two"): a future-dated invoice records the posting day, never a future sale.
  assert.equal(license(plusDays(startDay, 90)), `compliant ${startDay}`, 'a future-dated invoice records today, compliant when licensed');
  // Sol (PR 1579): a license issued after the sale date does not cover it.
  assert.equal(license('2027-12-31', '2026-10-01', rupInvoice), 'warning 2026-09-30', 'a license issued after the sale date must warn');
  assert.equal(license('2027-12-31', '2026-09-01', rupInvoice), 'compliant 2026-09-30', 'a license issued before the sale date is compliant');
  // Mason 2026-11-06: no issue date on file is a warning, never compliant.
  assert.equal(license('2027-12-31', null, rupInvoice), 'warning 2026-09-30', 'a license with no issue date must warn');
  // Two licenses: one covering the Sep 30 sale, one issued after it with a later expiry; the covering one wins.
  const two = scalar(`SET TimeZone = '${zone}'; SET request.jwt.claim.sub = '${ADMIN}'; BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.applicator_licenses (customer_id, license_number, license_type, holder_name, expiry_date, issued_date, is_active)
      VALUES ('${ids.customer}', 'PROVER-OLD', 'private', '[PROVER] holder', '${plusDays(startDay, 40)}', '2026-01-01', true),
             ('${ids.customer}', 'PROVER-NEW', 'private', '[PROVER] holder', '2028-12-31', '2026-10-01', true);
    SET LOCAL session_replication_role = origin;
    SELECT public.generate_rup_sales_records('${rupInvoice}'::uuid);
    SELECT string_agg(compliance_status || ' ' || buyer_certification_number, ',') FROM public.rup_sales_records WHERE invoice_id = '${rupInvoice}'; ROLLBACK;`);
  assert.equal(two, 'compliant PROVER-OLD', `the license covering the sale must be chosen, got ${two}`);
  console.log('[prover] RUP: future-dated invoice records today; license expiring before the invoice date or issued after the sale date warns');

  // Column defaults and argument defaults give the Chicago date in a session one day off.
  const defaults = scalar(`SET TimeZone = '${zone}'; SELECT string_agg(pg_get_expr(d.adbin, d.adrelid), '|' ORDER BY c.relname)
    FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE c.relnamespace = 'public'::regnamespace AND (c.relname, a.attname) IN (('payments','payment_date'),('commission_payments','payment_date'),('ar_reminder_tracking','sent_date'),('deliveries','scheduled_date'));`);
  assert.equal(defaults, Array(4).fill("((now() AT TIME ZONE 'America/Chicago'::text))::date").join('|'));
  const stamped = scalar(`SET TimeZone = '${zone}'; SELECT ((now() AT TIME ZONE 'America/Chicago'::text))::date::text;`);
  assert.equal(stamped, T);
  console.log(`[prover] four column defaults and the Chicago expression evaluate to ${T} in zone ${zone}`);

  for (const [at, label, utc, chicago] of BOUNDARIES) {
    const got = scalar(`SET TimeZone = 'UTC'; SELECT ('${at}'::timestamptz)::date::text || ' ' || ('${at}'::timestamptz AT TIME ZONE 'America/Chicago')::date::text
      || ' ' || public.compute_season(('${at}'::timestamptz AT TIME ZONE 'America/Chicago')::date);`);
    const [gotUtc, gotChicago, season] = got.split(' ');
    assert.equal(gotUtc, utc, `${label}: UTC date`); assert.equal(gotChicago, chicago, `${label}: Chicago date`);
    console.log(`[prover] ${label.padEnd(48)} old CURRENT_DATE ${gotUtc}  new ${gotChicago}  season ${season}`);
  }
  assert.equal(scalar(`SELECT public.compute_season('2026-09-30'::date) <> public.compute_season('2026-10-01'::date);`), 't', 'season changes on Oct 1');

  r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log('[prover] a second apply passes (re-runnable)');
  console.log('KI18_BATCH1_CHICAGO_TODAY_PROOF_PASS');
}

// --dump <dir>: write each target's pre-candidate definition (used to build the candidate).
function dump(dir) {
  buildContainer();
  mkdirSync(dir, { recursive: true });
  const md5 = {};
  for (const sig of TARGETS) {
    const def = docker([...psqlArgs(), '-A', '-t'], { input: `SELECT pg_get_functiondef('public.${sig}'::regprocedure);` }).stdout;
    writeFileSync(path.join(dir, `${fnName(sig)}.sql`), def.replace(/\n+$/, '\n'));
    md5[sig] = scalar(`SELECT md5(replace(prosrc, chr(13), '')) || ' ' || coalesce(array_to_string(proconfig, ';'), '') || ' ' || prosecdef FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;`);
  }
  writeFileSync(path.join(dir, 'md5.json'), JSON.stringify(md5, null, 1));
  console.log(`[prover] dumped ${TARGETS.length} definitions to ${dir}`);
}

const dumpAt = process.argv.indexOf('--dump');
try { if (dumpAt >= 0) dump(process.argv[dumpAt + 1]); else main(); }
// Fixtures use the start date; a run that crosses Chicago midnight cannot judge the dates, so say so.
catch (e) {
  let endDay = startDay;
  try { if (startDay) endDay = today(); } catch { /* container gone: report the original error */ }
  if (endDay !== startDay) throw new Error(`the run crossed Chicago midnight (${startDay} -> ${endDay}); rerun the proof`, { cause: e });
  throw e;
}
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
