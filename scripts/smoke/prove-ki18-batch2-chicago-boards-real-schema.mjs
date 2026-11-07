#!/usr/bin/env node
/**
 * Real-schema proof for 20261204110000 (KI-18 batch 2: boards, dashboards and reports take "today" from
 * the Chicago date). Builds the checked-in schema baseline in a network-disabled PostgreSQL container,
 * replays every migration before the candidate, then:
 *  - runs in a session zone whose date differs from Chicago's (the UTC-evening case) and shows BEFORE that
 *    the Team Board workload and the morning delivery recap count the wrong day;
 *  - applies the candidate and checks every replaced definition equals its pre-image with only the planned
 *    edits (grants unchanged), and that the same counts now follow Chicago;
 *  - runs the customer summary and receiving summary in a UTC session against a delivery and a receipt made
 *    at 7:30 pm CDT on the last evening of a season (counted in the new season before, the old one after),
 *    and checks two office-only feeds refuse a driver;
 *  - checks the statement date-range defaults, then that the Chicago date expression itself is right at 16
 *    fixed instants (6 pm CST / 7 pm CDT edges, midnight, month, season and year ends, both DST changes),
 *    including compute_season (an expression check: the functions are exercised in the steps above);
 *  - applies the candidate a second time (re-runnable).
 * `--dump <dir>` instead writes each target's pre-candidate definition (used to generate the candidate).
 *
 * Run: node scripts/smoke/prove-ki18-batch2-chicago-boards-real-schema.mjs   (needs local Docker image)
 * Prints KI18_BATCH2_CHICAGO_BOARDS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki18-b2-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261204110000_ki18_batch2_chicago_boards.sql');
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
export const TARGETS = [
  'operational_dashboard_summary()',
  'get_customer_summary(uuid)',
  'get_receiving_summary()',
  'get_call_list_stale_quotes(uuid,integer)',
  'get_dispatch_board_jobs(uuid,text,date,date)',
  'get_dispatched_list(uuid,uuid)',
  'get_expiring_planned_holds(integer,text)',
  'get_inventory_forecast(integer)',
  'get_team_board_deliveries()',
  'get_team_workload()',
  'get_yesterday_delivery_recap()',
  'get_customer_statement(uuid,date,date)',
  '_get_customer_statement_scoped_impl(uuid,date,date)',
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
const DRIVER = '16000000-0000-4000-8000-000000000019';
const CHI = "(now() AT TIME ZONE 'America/Chicago')::date";

// The candidate's edits: CURRENT_DATE (outside -- comments) becomes the Chicago date, the dashboard's NOW()
// the Chicago wall clock, two timestamps compared with that date are read on the Chicago calendar, and two
// office-only feeds gain the admin/sales-rep check (Mason, 2026-11-06). Applied to the pre-image, it must give
// the post-image. Postgres re-prints an argument default in normalized form, so the header line expects that form.
const CHI_ARG = "((now() AT TIME ZONE 'America/Chicago'::text))::date";
const EXTRA = {
  operational_dashboard_summary: [
    ['created_at::date', "(created_at AT TIME ZONE 'America/Chicago')::date"],
    ["DATE_TRUNC('month', completed_at)", "DATE_TRUNC('month', (completed_at AT TIME ZONE 'America/Chicago'))"],
    ['AND completed_at >= _season_start', "AND (completed_at AT TIME ZONE 'America/Chicago')::date >= _season_start"],
    ["TO_CHAR(completed_at, 'YYYY-MM')", "TO_CHAR(completed_at AT TIME ZONE 'America/Chicago', 'YYYY-MM')"],
    ["TO_CHAR(received_at, 'YYYY-MM')", "TO_CHAR(received_at AT TIME ZONE 'America/Chicago', 'YYYY-MM')"],
  ],
  get_receiving_summary: [['rr.received_at::date', "(rr.received_at AT TIME ZONE 'America/Chicago')::date"]],
  get_call_list_stale_quotes: [['q.updated_at::date', "(q.updated_at AT TIME ZONE 'America/Chicago')::date"]],
  get_customer_summary: [
    ['AND completed_at >= v_season_start', "AND (completed_at AT TIME ZONE 'America/Chicago')::date >= v_season_start"],
    ['AND completed_at <= v_season_end', "AND (completed_at AT TIME ZONE 'America/Chicago')::date <= v_season_end"],
  ],
};
const GATED = ['get_expiring_planned_holds', 'get_inventory_forecast'];
const GATE = `  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = auth.uid()
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required' USING ERRCODE = '42501';
  END IF;

`;
function swap(sig, def) {
  const name = sig.slice(0, sig.indexOf('('));
  const src = GATED.includes(name) ? def.replace('AS $function$\nBEGIN\n', `AS $function$\nBEGIN\n${GATE}`) : def;
  return src.split('\n').map((line) => {
    const c = line.indexOf('--');
    let next = c >= 0 ? line.slice(0, c) : line;
    // The dashboard's accounting-period name and days left read the Chicago wall clock instead of UTC NOW().
    if (name === 'operational_dashboard_summary') next = next.split('NOW()').join("(now() AT TIME ZONE 'America/Chicago')");
    for (const [from, to] of EXTRA[name] || []) next = next.split(from).join(to);
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

function seed(zone) {
  for (const [id, email, role] of [[ADMIN, 'ki18-b2-admin@example.invalid', 'admin'], [DRIVER, 'ki18-b2-driver@example.invalid', 'driver']]) {
    psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${id}', '${email}', '{"full_name":"[PROVER] ${role}"}'::jsonb) ON CONFLICT DO NOTHING;
      SET session_replication_role = replica;
      INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES ('${id}', '${email}', '[PROVER] ${role}', '${role}', true)
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active;`);
  }
  const customer = seedRow('customers', { email: 'ki18-b2-customer@example.invalid' });
  const T = today();
  const delivery = (date, status) => seedRow('deliveries', {
    customer_id: customer, assigned_driver: ADMIN, scheduled_date: date, status,
    delivery_number: `PD-${randomUUID().slice(0, 8)}`,
  });
  const seasonStart = scalar(`SELECT make_date(extract(year FROM ${CHI})::int - CASE WHEN extract(month FROM ${CHI}) >= 10 THEN 0 ELSE 1 END, 10, 1)::text;`);
  const lateCustomer = seedRow('customers', { email: 'ki18-b2-late@example.invalid' });
  seedRow('deliveries', {
    customer_id: lateCustomer, assigned_driver: ADMIN, scheduled_date: addDays(seasonStart, -1), status: 'completed',
    completed_at: `${seasonStart} 00:30:00+00`, delivery_number: `PD-${randomUUID().slice(0, 8)}`,
  });
  seedRow('receiving_records', { received_at: `${seasonStart} 00:30:00+00`, quantity_received: 5, condition: 'good' });
  return { customer, lateCustomer, today: delivery(T, 'scheduled'), yesterday: delivery(addDays(T, -1), 'completed'), zone };
}
const today = () => scalar(`SELECT ${CHI};`);

// In a session whose zone puts CURRENT_DATE one day off the Chicago date (as UTC does every evening),
// ask the Team Board workload and the morning delivery recap what they count for the seeded driver.
function decisions(ids) {
  const inZone = (sql) => scalar(`SET TimeZone = '${ids.zone}'; SET request.jwt.claim.sub = '${ADMIN}'; ${sql}`);
  const today = Number(inZone(`SELECT (x->>'today_deliveries')::int FROM jsonb_array_elements(public.get_team_workload()) x WHERE x->>'id' = '${ADMIN}';`));
  const yesterday = Number(inZone("SELECT (public.get_yesterday_delivery_recap()->'summary'->>'total_completed')::int;"));
  return { today, yesterday };
}
// Who may read the two office-only feeds: 'allowed', 'denied' (the role check), or the unexpected error.
function access(user) {
  return ['get_expiring_planned_holds(7)', 'get_inventory_forecast(6)'].map((call) => {
    const r = docker([...psqlArgs(), '-A', '-t'], { input: `SET request.jwt.claim.sub = '${user}'; SELECT public.${call} IS NOT NULL;`, allowFailure: true });
    if (r.status === 0) return 'allowed';
    return /Access denied: admin or sales_rep role required/.test(r.stderr) ? 'denied' : `error: ${r.stderr.trim()}`;
  }).join(',');
}
// Season deliveries for a customer whose only completed delivery finished at 7:30 pm CDT on the last
// evening of the previous season (00:30 UTC on the season's first day): the UTC session counted it.
function seasonDeliveries(customer) {
  return Number(scalar(`SET TimeZone = 'UTC'; SET request.jwt.claim.sub = '${ADMIN}';
    SELECT (public.get_customer_summary('${customer}'::uuid)->>'delivery_count')::int;`));
}
// Season-to-date items received; the only receipt is that same last-evening one (5 units).
function receivedYtd() {
  return Number(scalar(`SET TimeZone = 'UTC'; SET request.jwt.claim.sub = '${ADMIN}';
    SELECT (public.get_receiving_summary()->>'items_received_ytd')::numeric;`));
}
// The owner dashboard's season day count and accounting-period name in the same off-by-one session.
function dashboard(zone) {
  const d = JSON.parse(scalar(`SET TimeZone = '${zone}'; SET request.jwt.claim.sub = '${ADMIN}';
    SELECT jsonb_build_object('elapsed', (s->>'season_days_elapsed')::int, 'period', s->>'period_name')::text
      FROM (SELECT public.operational_dashboard_summary() AS s) x;`));
  assert.ok(Number.isInteger(d.elapsed) && d.period, `operational_dashboard_summary returned ${JSON.stringify(d)}`);
  return d;
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
  const ids = seed(zone);
  // Chicago says: one delivery scheduled today, one completed yesterday.
  const want = { today: 1, yesterday: 1 };
  console.log(`[prover] Chicago date ${T}; session zone ${zone} gives CURRENT_DATE ${D} (as UTC does after 6 pm Central)`);

  const preDefs = Object.fromEntries(TARGETS.map((sig) => [sig, definition(sig)]));
  const preAcl = Object.fromEntries(TARGETS.map((sig) => [sig, acl(sig)]));
  const before = decisions(ids);
  const dashBefore = dashboard(zone);
  assert.deepEqual(before, { today: 0, yesterday: 0 }, `BEFORE the boards already follow Chicago: ${JSON.stringify(before)}`);
  assert.equal(access(DRIVER), 'allowed,allowed', 'BEFORE: a driver could read both office-only feeds');
  assert.equal(seasonDeliveries(ids.lateCustomer), 1, 'BEFORE: the UTC session counts the Sep 30 evening delivery in the new season');
  assert.equal(receivedYtd(), 5, 'BEFORE: the UTC session counts the Sep 30 evening receipt in the new season');
  console.log('[prover] BEFORE: a driver reads both office-only feeds; a Sep 30 7:30 pm CDT delivery and receipt count in the new season');
  console.log(`[prover] BEFORE (UTC-style date): ${JSON.stringify(before)}; Chicago answer ${JSON.stringify(want)}`);

  stageText('candidate.sql', lf(CANDIDATE));
  let r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log(`[prover] candidate applied (preflight and postflight passed) for ${TARGETS.length} functions`);

  // Every function equals its pre-image with only the date swapped; grants, owner and SECURITY DEFINER kept.
  for (const sig of TARGETS) {
    const post = definition(sig);
    assert.equal(post, swap(sig, preDefs[sig]), `${sig}: the new definition differs from the pre-image by more than the planned edits`);
    assert.notEqual(post, preDefs[sig], `${sig}: nothing changed`);
    assert.equal(acl(sig), preAcl[sig], `${sig}: grants, owner or SECURITY DEFINER changed`);
  }
  console.log(`[prover] all ${TARGETS.length} definitions equal their pre-image with only the planned edits; grants unchanged`);

  const after = decisions(ids);
  assert.deepEqual(after, want, `AFTER ${JSON.stringify(after)} must follow the Chicago date ${JSON.stringify(want)}`);
  console.log(`[prover] AFTER (same session zone): ${JSON.stringify(after)} = the Chicago answer`);
  assert.equal(access(DRIVER), 'denied,denied', 'AFTER: a driver is refused both office-only feeds');
  assert.equal(access(ADMIN), 'allowed,allowed', 'AFTER: an admin still reads both feeds');
  assert.equal(seasonDeliveries(ids.lateCustomer), 0, 'AFTER: the Sep 30 evening delivery stays in its own season');
  assert.equal(receivedYtd(), 0, 'AFTER: the Sep 30 evening receipt stays in its own season');
  console.log('[prover] AFTER: driver refused, admin allowed on both office-only feeds; the Sep 30 evening delivery and receipt stay in the old season');

  // The dashboard runs with the new clock expressions; its season day count moves by the one day the session
  // zone was off, and with no open accounting period its period name is the Chicago month.
  const dashAfter = dashboard(zone);
  assert.equal(dashAfter.elapsed, dashBefore.elapsed + (D > T ? -1 : 1), `season_days_elapsed ${JSON.stringify({ dashBefore, dashAfter })}`);
  assert.equal(dashAfter.period, scalar(`SELECT to_char(${CHI}, 'Mon YYYY');`), `period_name ${dashAfter.period}`);
  console.log(`[prover] dashboard BEFORE ${JSON.stringify(dashBefore)} AFTER ${JSON.stringify(dashAfter)} (Chicago)`);

  // The two statement functions' date-range defaults now name the Chicago date, which is T in a session one day off.
  for (const sig of ['get_customer_statement(uuid,date,date)', '_get_customer_statement_scoped_impl(uuid,date,date)']) {
    const args = scalar(`SELECT pg_get_function_arguments('public.${sig}'::regprocedure);`);
    assert.ok(args.includes(CHI_ARG) && !/\bcurrent_date\b/i.test(args), `${sig}: argument defaults are ${args}`);
  }
  const stamped = scalar(`SET TimeZone = '${zone}'; SELECT ${CHI_ARG}::text;`);
  assert.equal(stamped, T);
  console.log(`[prover] statement argument defaults name the Chicago date, which evaluates to ${T} in zone ${zone}`);

  for (const [at, label, utc, chicago] of BOUNDARIES) {
    const got = scalar(`SET TimeZone = 'UTC'; SELECT ('${at}'::timestamptz)::date::text || ' ' || ('${at}'::timestamptz AT TIME ZONE 'America/Chicago')::date::text
      || ' ' || public.compute_season(('${at}'::timestamptz AT TIME ZONE 'America/Chicago')::date)
      || ' ' || (public.compute_season(('${at}'::timestamptz AT TIME ZONE 'America/Chicago')::date) <> public.compute_season(('${at}'::timestamptz)::date))::text;`);
    const [gotUtc, gotChicago, season, seasonsDiffer] = got.split(' ');
    assert.equal(gotUtc, utc, `${label}: UTC date`); assert.equal(gotChicago, chicago, `${label}: Chicago date`);
    // Seasons run Oct 1 - Sep 30, so the UTC and Chicago seasons differ exactly when Oct 1 falls between the two dates.
    const seasonYear = (d) => Number(d.slice(0, 4)) + (d.slice(5) >= '10-01' ? 1 : 0);
    assert.equal(seasonsDiffer === 'true', seasonYear(utc) !== seasonYear(chicago), `${label}: compute_season differs only across Oct 1`);
    console.log(`[prover] ${label.padEnd(48)} old CURRENT_DATE ${gotUtc}  new ${gotChicago}  season ${season}`);
  }
  assert.equal(scalar(`SELECT public.compute_season('2026-09-30'::date) <> public.compute_season('2026-10-01'::date);`), 't', 'season changes on Oct 1');

  r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log('[prover] a second apply passes (re-runnable)');
  console.log('KI18_BATCH2_CHICAGO_BOARDS_PROOF_PASS');
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
