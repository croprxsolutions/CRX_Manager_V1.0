#!/usr/bin/env node
/**
 * Real-schema proof for 20261208100000 (KI-18 batch 3: statements use the AR Aging day ranges, and
 * get_ar_aging's fallback "as of" date is the Chicago date). Builds the checked-in schema baseline in a
 * network-disabled PostgreSQL container, replays every migration before the candidate, then:
 *  - seeds a customer with one posted invoice on each side of every range edge (29/30, 59/60, 89/90,
 *    119/120 days past due) and shows the statement's buckets differ from get_ar_aging's BEFORE and equal
 *    them AFTER (and the statement definition differs from its pre-image only in the five range lines);
 *  - seeds one posted invoice whose due date is 29 or 30 days before the Chicago date, so a one-day error
 *    moves it between the "current" and "30-59" buckets;
 *  - in a session zone whose date differs from Chicago's (the UTC-evening case) shows BEFORE that
 *    get_ar_aging() with no date ages it on the wrong day, while get_ar_aging(<Chicago date>) is right;
 *  - applies the candidate and checks the definition equals its pre-image with only the default changed
 *    (body md5, grants, owner and SECURITY DEFINER unchanged), and that get_ar_aging() now returns exactly
 *    what get_ar_aging(<Chicago date>) returns, in that zone and in UTC;
 *  - checks the bucket arithmetic at fixed 6 pm-midnight Central instants (both CST and CDT);
 *  - applies the candidate a second time (re-runnable).
 *
 * Run: node scripts/smoke/prove-ki18-batch3-aging-real-schema.mjs   (needs local Docker image)
 * Prints KI18_BATCH3_AGING_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki18-b3-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261208100000_ki18_batch3_aging_ranges_and_chicago_default.sql');
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
// The functions the candidate replaces: get_ar_aging's date default, and the statement's five bucket ranges.
export const TARGETS = ['get_ar_aging(date)', 'get_detailed_statement_data(uuid,date,text)'];
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
    // The stock-replay batch 2 preflight pins live's auth.uid() body, which live had when it was applied.
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

const ADMIN = '16000000-0000-4000-8000-000000000031';
const CHI = "(now() AT TIME ZONE 'America/Chicago')::date";
const CHI_ARG = "((now() AT TIME ZONE 'America/Chicago'::text))::date";
const [SIG, STMT] = TARGETS;
const definition = (sig = SIG) => docker([...psqlArgs(), '-A', '-t'], { input: `SELECT pg_get_functiondef('public.${sig}'::regprocedure);` }).stdout.replace(/\r/g, '');
const acl = (sig = SIG, withBody = true) => scalar(`SELECT coalesce(proacl::text, '-') || ' ' || pg_get_userbyid(proowner) || ' ' || prosecdef || ' ' || provolatile::text || ' ' || coalesce(array_to_string(proconfig, ';'), '')${withBody ? " || ' ' || md5(replace(prosrc, chr(13), ''))" : ''} FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;`);
// The statement's bucket lines, old ranges -> AR Aging ranges (Mason, 2026-11-07).
const AGE = 'p_as_of_date - COALESCE(i.due_date, i.invoice_date) ';
const RANGES = [['<= 30 ', '<= 29 '], ['BETWEEN 31 AND 60 ', 'BETWEEN 30 AND 59 '], ['BETWEEN 61 AND 90 ', 'BETWEEN 60 AND 89 '],
  ['BETWEEN 91 AND 120 ', 'BETWEEN 90 AND 119 '], ['> 120 ', '>= 120 ']];
// Both reports' buckets for one customer as of a date, in cents: current,30,60,90,120+.
function bothBuckets(date, customer) {
  const claims = `SET request.jwt.claims = '{"sub":"${ADMIN}","role":"authenticated"}';`;
  const ar = scalar(`${claims} SELECT concat_ws(',', (current_amount * 100)::bigint, (days_30 * 100)::bigint, (days_60 * 100)::bigint, (days_90 * 100)::bigint, (over_90 * 100)::bigint)
    FROM public.get_ar_aging('${date}'::date) WHERE customer_id = '${customer}';`);
  const stmt = scalar(`${claims} SELECT concat_ws(',', a->>'current_cents', a->>'days_30_cents', a->>'days_60_cents', a->>'days_90_cents', a->>'over_120_cents')
    FROM (SELECT public.get_detailed_statement_data('${customer}'::uuid, '${date}'::date, 'summary')->'aging' AS a) x;`);
  return { ar, stmt };
}
function postedInvoice(customer, number, dueDate, cents) {
  return `INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
      VALUES ('[PROVER]-${number}', '${customer}', 'chemical_sale', 'draft', ${dueDate}, ${dueDate}, ${cents}, '${ADMIN}', '${ADMIN}');
    UPDATE public.invoices SET status = 'posted', posted_at = (${dueDate})::timestamp AT TIME ZONE 'America/Chicago' WHERE invoice_number = '[PROVER]-${number}';`;
}
const today = () => scalar(`SELECT ${CHI};`);
// The seeded customer's buckets, in cents, from get_ar_aging(<args>) in the given session zone.
function buckets(zone, args, customer) {
  return scalar(`SET TimeZone = '${zone}'; SET request.jwt.claims = '{"sub":"${ADMIN}","role":"authenticated"}';
    SELECT concat_ws(',', (current_amount * 100)::bigint, (days_30 * 100)::bigint, (days_60 * 100)::bigint, (days_90 * 100)::bigint, (over_90 * 100)::bigint)
      FROM public.get_ar_aging(${args}) WHERE customer_id = '${customer}';`);
}

// 6 pm-midnight Central instants (UTC is already tomorrow): an invoice due 29 Chicago days earlier is
// "current" on the Chicago date and "30-59" on the UTC date. Same subtraction get_ar_aging does.
const EVENINGS = [
  ['2026-12-02 00:00:00+00', '6:00 pm CST'],
  ['2026-12-02 05:59:59+00', '11:59 pm CST'],
  ['2026-07-02 00:00:00+00', '7:00 pm CDT'],
  ['2026-07-02 04:59:59+00', '11:59 pm CDT'],
  ['2026-11-01 01:30:00+00', 'Oct 31 8:30 pm CDT (month end)'],
];

let startDay = null;
function main() {
  buildContainer();  // always a fresh sealed container: no reuse of any existing database
  const T = today();
  startDay = T;
  const zone = scalar(`SELECT CASE WHEN (now() AT TIME ZONE 'Pacific/Kiritimati')::date <> ${CHI} THEN 'Pacific/Kiritimati' ELSE 'Etc/GMT+12' END;`);
  const D = scalar(`SET TimeZone = '${zone}'; SELECT current_date::text;`);
  assert.notEqual(D, T, 'the test zone must put CURRENT_DATE on another day than Chicago');
  // Ahead (as UTC is every evening): due 29 days ago is current on Chicago's date, 30-59 a day later.
  // Behind: due 30 days ago is 30-59 on Chicago's date, current a day earlier.
  const ahead = D > T;
  const dueDays = ahead ? 29 : 30;
  const RIGHT = ahead ? '10000,0,0,0,0' : '0,10000,0,0,0';
  const WRONG = ahead ? '0,10000,0,0,0' : '10000,0,0,0,0';
  console.log(`[prover] Chicago date ${T}; session zone ${zone} gives CURRENT_DATE ${D}; invoice due ${dueDays} days before ${T}`);

  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${ADMIN}', 'ki18-b3-admin@example.invalid', '{"full_name":"[PROVER] Admin"}'::jsonb) ON CONFLICT DO NOTHING;
    SET session_replication_role = replica;
    INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES ('${ADMIN}', 'ki18-b3-admin@example.invalid', '[PROVER] Admin', 'admin', true)
    ON CONFLICT (id) DO UPDATE SET role = 'admin', is_active = true;`);
  const customer = randomUUID();
  psql(`INSERT INTO public.customers (id, farm_name, account_number, is_active) VALUES ('${customer}', '[PROVER] b3', '[PROVER]-b3', true);
    INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
      VALUES ('[PROVER]-B3', '${customer}', 'chemical_sale', 'draft', '${T}'::date - ${dueDays}, '${T}'::date - ${dueDays}, 10000, '${ADMIN}', '${ADMIN}');
    UPDATE public.invoices SET status = 'posted', posted_at = ('${T}'::date - ${dueDays})::timestamp AT TIME ZONE 'America/Chicago' WHERE invoice_number = '[PROVER]-B3';`);

  // One invoice on each side of every range edge; cents are powers of two so each bucket's sum names its invoices.
  const edges = randomUUID();
  const EDGE_DAYS = [29, 30, 59, 60, 89, 90, 119, 120];
  psql([`INSERT INTO public.customers (id, farm_name, account_number, is_active) VALUES ('${edges}', '[PROVER] b3 edges', '[PROVER]-b3e', true);`,
    ...EDGE_DAYS.map((d, k) => postedInvoice(edges, `B3E-${d}`, `'${T}'::date - ${d}`, 100 * 2 ** k))].join('\n'));
  const AR_RANGES = '100,600,2400,9600,12800';   // 29 | 30,59 | 60,89 | 90,119 | 120
  const OLD_STMT = '300,1200,4800,19200,0';      // 29,30 | 59,60 | 89,90 | 119,120 | none
  const preStmtDef = definition(STMT);
  const preStmtAcl = acl(STMT, false);
  const beforeEdges = bothBuckets(T, edges);
  assert.deepEqual(beforeEdges, { ar: AR_RANGES, stmt: OLD_STMT }, `BEFORE edges: ${JSON.stringify(beforeEdges)}`);
  console.log(`[prover] BEFORE edge invoices (due 29,30,59,60,89,90,119,120 days ago): AR Aging ${AR_RANGES}; statement ${OLD_STMT}`);

  const pre = definition();
  const preAcl = acl();
  assert.equal(buckets(zone, `'${T}'::date`, customer), RIGHT, 'fixture: the Chicago-dated report ages the invoice right');
  assert.equal(buckets(zone, '', customer), WRONG, 'BEFORE: get_ar_aging() with no date must age by the session (UTC-style) date');
  console.log(`[prover] BEFORE in zone ${zone}: get_ar_aging() ${WRONG}; get_ar_aging('${T}') ${RIGHT} (cents: current,30,60,90,120+)`);

  stageText('candidate.sql', lf(CANDIDATE));
  let r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log('[prover] candidate applied (preflight and postflight passed)');

  const post = definition();
  const header = (def) => def.split('\n')[0];
  assert.equal(header(pre), 'CREATE OR REPLACE FUNCTION public.get_ar_aging(p_as_of_date date DEFAULT CURRENT_DATE)');
  assert.equal(header(post), `CREATE OR REPLACE FUNCTION public.get_ar_aging(p_as_of_date date DEFAULT ${CHI_ARG})`);
  assert.equal(post.split('\n').slice(1).join('\n'), pre.split('\n').slice(1).join('\n'), 'only the header line may change');
  assert.equal(acl(), preAcl, 'body md5, grants, owner, SECURITY DEFINER or volatility changed');
  console.log('[prover] definition equals its pre-image except the date default; body md5, grants, owner, SECURITY DEFINER unchanged');

  let expectStmt = preStmtDef;
  for (const [from, to] of RANGES) {
    assert.equal(expectStmt.split(AGE + from).length - 1, 1, `statement pre-image must hold "${AGE + from}" once`);
    expectStmt = expectStmt.replace(AGE + from, AGE + to);
  }
  assert.equal(definition(STMT), expectStmt, 'the statement definition differs from its pre-image by more than the five range lines');
  assert.equal(acl(STMT, false), preStmtAcl, 'statement grants, owner, SECURITY DEFINER, volatility or settings changed');
  const afterEdges = bothBuckets(T, edges);
  assert.deepEqual(afterEdges, { ar: AR_RANGES, stmt: AR_RANGES }, `AFTER edges: ${JSON.stringify(afterEdges)}`);
  console.log(`[prover] AFTER: statement definition = pre-image with only the five range lines; edge invoices: statement ${afterEdges.stmt} = AR Aging ${afterEdges.ar}`);

  for (const z of [zone, 'UTC']) {
    assert.equal(buckets(z, '', customer), RIGHT, `AFTER in zone ${z}: get_ar_aging() must age by the Chicago date`);
    assert.equal(buckets(z, `'${T}'::date`, customer), RIGHT, `AFTER in zone ${z}: get_ar_aging('${T}') unchanged`);
  }
  console.log(`[prover] AFTER in zones ${zone} and UTC: get_ar_aging() = get_ar_aging('${T}') = ${RIGHT}`);

  for (const [at, label] of EVENINGS) {
    const got = scalar(`SELECT (('${at}'::timestamptz AT TIME ZONE 'America/Chicago')::date - (('${at}'::timestamptz AT TIME ZONE 'America/Chicago')::date - 29))
      || ' ' || ((('${at}'::timestamptz AT TIME ZONE 'UTC')::date) - (('${at}'::timestamptz AT TIME ZONE 'America/Chicago')::date - 29));`);
    assert.equal(got, '29 30', `${label}: Chicago age 29 (current), UTC age 30 (30-59)`);
    console.log(`[prover] ${label.padEnd(34)} due 29 Chicago days earlier: Chicago age 29 = current; old UTC age 30 = 30-59`);
  }

  r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log('[prover] a second apply passes (re-runnable)');
  console.log('KI18_BATCH3_AGING_PROOF_PASS');
}

try { main(); }
// Fixtures use the start date; a run that crosses Chicago midnight cannot judge the dates, so say so.
catch (e) {
  let endDay = startDay;
  try { if (startDay) endDay = today(); } catch { /* container gone: report the original error */ }
  if (endDay !== startDay) throw new Error(`the run crossed Chicago midnight (${startDay} -> ${endDay}); rerun the proof`, { cause: e });
  throw e;
}
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
