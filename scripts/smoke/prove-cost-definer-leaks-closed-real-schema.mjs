#!/usr/bin/env node
/**
 * Real-schema proof for 20261102120000_cost_definer_leaks_closed (KI-02 / KI-74, To-Do 11.3):
 * four owner-rights functions stop handing cost to non-admins.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17
 * container, replays every ordered post-baseline migration up to the candidate, checks the four
 * replaced bodies match the candidate's live md5 pins, seeds one costed job, product and blend
 * ticket, then runs one matrix of calls BEFORE and AFTER the candidate as each role. Every call is
 * one transaction that always rolls back.
 *   1. get_dispatch_board_jobs: BEFORE every caller's rows carry total_cost_cents; AFTER none do,
 *      and total_price_cents still does.
 *   2. manual_inventory_add with a unit cost: BEFORE the stock note says "(purchased @ $X/unit)";
 *      AFTER the note is the plain one.
 *   3. complete_job whose automatic draft invoice fails (transfer_job_to_invoice stubbed inside the
 *      probe to raise a below-cost refusal carrying a cost, as an admin's does): BEFORE the
 *      activity_feed row repeats the cost; AFTER it names the code only. A non-below-cost failure
 *      is logged in full both times.
 *   4. create_order_from_blend_ticket with the order-header trigger switched off inside the probe:
 *      BEFORE a rep's error carries total cost, profit and margin; AFTER only an admin's does.
 *   5. The preflight refuses a drifted body; the postflight refuses a candidate with fix 1 undone.
 *
 * Run: node scripts/smoke/prove-cost-definer-leaks-closed-real-schema.mjs   (needs Docker)
 * Prints COST_DEFINER_LEAKS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container;
 * CRX_PROVER_REUSE_CONTAINER=<name> reuses a kept one that has not had the candidate applied.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-cost-definer-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261102120000_cost_definer_leaks_closed.sql');
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
]);
const TOUCHED = /(FUNCTION|ROUTINE|PROCEDURE)\s+(IF\s+EXISTS\s+)?("?public"?\s*\.\s*)?"?(get_dispatch_board_jobs|manual_inventory_add|_manual_inventory_add_replay_impl_20261015|complete_job|_complete_job_replay_impl_20261015|create_order_from_blend_ticket|_create_order_from_blend_ticket_replay_impl_20261015)\b/i;
const SCHEMA_WIDE = /ALL\s+(FUNCTIONS|ROUTINES|PROCEDURES)\s+IN\s+SCHEMA/i;
function touches(file) {
  const sql = lf(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  return SCHEMA_WIDE.test(sql) || TOUCHED.test(sql);
}
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

const id = (n) => `7c620000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), REP: id('b1'), APPLICATOR: id('e1'), DRIVER: id('d1') };
const CUST = id('c1');
const PROD = id('f1');
const PROD_NEW = id('f2');
const JOB = id('1b1');
const TICKET = id('2b1');

// ------------------------------------------------------------------------------------------------
// Container plumbing (the shared real-schema harness).
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
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  for (const file of all.slice(at + 1)) {
    assert.ok(!touches(file), `${path.basename(file)} sorts after the candidate and touches what it changes; re-think this proof`);
  }
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!touches(file), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
  const recorded = new Set();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    // Each ledger-only migration is recorded once, at its place in the order.
    for (const only of LEDGER_ONLY) {
      if (only < base && !recorded.has(only)) { ledger(path.basename(only, '.sql')); recorded.add(only); }
    }
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  assert.equal(recorded.size, LEDGER_ONLY.size, 'a ledger-only migration was never recorded');
  installLiveAuthUid();
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    GRANT DELETE ON auth.sessions TO postgres;`, { user: 'supabase_admin' });
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

// ------------------------------------------------------------------------------------------------
// FIDELITY: every md5 pin in the candidate's preflight matches the replayed body.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const pins = [...sql.matchAll(/\('([a-z_0-9]+)', '([0-9a-f]{32})',\s*'([a-z, ]+)'\)/g)].map((m) => [m[1], m[2], m[3]]);
  assert.equal(pins.length, 4, 'the preflight pins the four replaced bodies');
  for (const [fn, pin, args] of pins) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) || '|' || oidvectortypes(proargtypes) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '${fn}';`),
      `${pin}|${args}`, `${fn} replayed with a body or argument list that differs from the live pin`);
  }
  console.log('[prover] FIDELITY: all 4 pinned bodies and argument lists match the live pins of 2026-11-02');
}

// ------------------------------------------------------------------------------------------------
// Seed (committed once; every probe rolls back).
function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.APPLICATOR, 'applicator', 'Applicator', 7], [U.DRIVER, 'driver', 'Driver', 6]];
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'cost-definer-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    INSERT INTO public.customers (id, farm_name, is_active, email) VALUES ('${CUST}', '[PROVER] Cost Farm', true, 'c1@example.invalid');
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, is_active) VALUES
      ('${PROD}', '[PROVER] Costed Product', 'GL', 6.00, 10.00, 'liquid', true),
      ('${PROD_NEW}', '[PROVER] Unstocked Product', 'GL', 6.00, 10.00, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.inventory (product_id, quantity_available, unit_size) VALUES ('${PROD}', 50, 'GL');
    INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, applicator_id, total_price_cents, total_cost_cents)
      VALUES ('${JOB}', 'PROVER-JOB-1', '${CUST}', 'in_progress', CURRENT_DATE, '${U.APPLICATOR}', 2000, 1234);
    INSERT INTO public.blend_tickets (id, ticket_number, uploaded_by, customer_id)
      VALUES ('${TICKET}', 'PROVER-BT-1', '${U.ADMIN}', '${CUST}');
    INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit)
      VALUES ('${TICKET}', '${PROD}', '[PROVER] Costed Product', 2, 'GL');
    COMMIT;`);
  assert.equal(scalar(`SELECT total_cost_cents FROM public.jobs WHERE id = '${JOB}';`), '1234', 'the seeded job has no cost');
}

// ------------------------------------------------------------------------------------------------
// Probes.
/**
 * Run `call` (an expression) or `stmt` (PL/pgSQL that assigns v) as `uid` after `fixture` (owner),
 * in one rolled-back transaction. ok|<value> or <sqlstate>|<message>.
 */
function attempt(uid, { call, stmt, fixture = '' }) {
  const sql = `BEGIN;
${fixture}
RESET ROLE;
${claims(uid)}
SET LOCAL ROLE authenticated;
DO $probe$
DECLARE v text;
BEGIN
  ${stmt ?? `v := (${call})::text;`}
  RAISE NOTICE 'RESULT|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|%|%', SQLSTATE, SQLERRM;
END
$probe$;
ROLLBACK;
`;
  const r = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: true });
  assert.equal(r.status, 0, `probe failed to run:\n${r.stderr}\n--- SQL ---\n${sql}`);
  const m = /RESULT\|([^\n]*)/.exec(r.stderr);
  assert.ok(m, `probe printed no RESULT:\n${r.stderr}`);
  return m[1].trimEnd();
}

// "<rows>:<rows with total_cost_cents>:<rows with total_price_cents>"
const DISPATCH = { call: `(SELECT count(*) || ':' || count(*) FILTER (WHERE r ? 'total_cost_cents') || ':' || count(*) FILTER (WHERE r ? 'total_price_cents') FROM public.get_dispatch_board_jobs('${U.APPLICATOR}') r)` };
const manualAdd = (uid) => ({
  stmt: `PERFORM public.manual_inventory_add('${PROD_NEW}', NULL, 5, 'GL', '${uid}'::uuid, NULL, 4.25, 'prover-' || gen_random_uuid(), NULL, NULL);
  v := (SELECT string_agg(notes, '|') FROM public.inventory_transactions WHERE product_id = '${PROD_NEW}');`,
});
// The automatic draft is switched on and transfer_job_to_invoice stubbed to fail with `message`.
const complete = (uid, message) => ({
  fixture: `INSERT INTO public.app_settings (setting_key, setting_value) VALUES ('auto_draft_invoice_on_job_completion', 'true')
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = 'true';
  CREATE OR REPLACE FUNCTION public.transfer_job_to_invoice(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
    RETURNS jsonb LANGUAGE plpgsql AS $stub$ BEGIN RAISE EXCEPTION '%', ${`'${message.replaceAll("'", "''")}'`}; END $stub$;`,
  stmt: `PERFORM public.complete_job('${JOB}', '{}'::jsonb, '${uid}'::uuid, 'prover-' || gen_random_uuid());
  v := (SELECT description FROM public.activity_feed WHERE event_type = 'auto_draft_failed' AND related_entity_id = '${JOB}' ORDER BY created_at DESC LIMIT 1);`,
});
// _enforce_below_cost_line's real shape: the code, a colon, then the jsonb detail with no space.
const BELOW_MSG = 'BELOW_COST_REASON_REQUIRED:{"locked_unit_cost_cents": 600, "unit_price_cents": 1}';
const OTHER_MSG = 'INVOICE_CUSTOMER_ON_HOLD: credit hold';
// The ticket is completed and approved inside the probe; `header: false` switches off the trigger
// that keeps the order totals current, so the function's totals check fails.
const blend = (uid, header) => ({
  fixture: `UPDATE public.blend_tickets SET status = 'completed', review_status = 'approved' WHERE id = '${TICKET}';
  ${header ? '' : 'ALTER TABLE public.order_items DISABLE TRIGGER after_order_items_change;'}`,
  call: `public.create_order_from_blend_ticket('${TICKET}', 'PROVER-BT-ORD', CURRENT_DATE, NULL, '${uid}'::uuid, 'prover-' || gen_random_uuid())`,
});
const WITH_FIGURES = /^P0001\|ORDER_HEADER_NOT_RECALCULATED: observed total_price=0, total_cost=0.*expected total_price=20\.00, total_cost=12\.00, total_profit=8\.00/;

/** [label, uid, probe, before, after]; 'same' means identical before and after. */
const CASES = [
  ['admin: dispatch board', U.ADMIN, DISPATCH, /^ok\|1:1:1$/, /^ok\|1:0:1$/],
  ['rep: dispatch board', U.REP, DISPATCH, /^ok\|1:1:1$/, /^ok\|1:0:1$/],
  ['applicator: dispatch board', U.APPLICATOR, DISPATCH, /^ok\|1:1:1$/, /^ok\|1:0:1$/],
  ['driver: dispatch board', U.DRIVER, DISPATCH, /^ok\|0:0:0$/, 'same'],

  ['rep: manual add with cost', U.REP, manualAdd(U.REP), /^ok\|Initial inventory record created with 5 units \(purchased @ \$4\.25\/unit\)$/, /^ok\|Initial inventory record created with 5 units$/],
  ['admin: manual add with cost', U.ADMIN, manualAdd(U.ADMIN), /^ok\|Initial inventory record created with 5 units \(purchased @ \$4\.25\/unit\)$/, /^ok\|Initial inventory record created with 5 units$/],
  ['driver: manual add', U.DRIVER, manualAdd(U.DRIVER), /^P0001\|INSUFFICIENT_ROLE$/, 'same'],

  ['admin: auto-draft fails below cost', U.ADMIN, complete(U.ADMIN, BELOW_MSG), /Reason: BELOW_COST_REASON_REQUIRED:\{"locked_unit_cost_cents": 600/, /^ok\|.*Reason: BELOW_COST_REASON_REQUIRED$/],
  ['rep: auto-draft fails below cost', U.REP, complete(U.REP, BELOW_MSG), /Reason: BELOW_COST_REASON_REQUIRED:\{"locked_unit_cost_cents": 600/, /^ok\|.*Reason: BELOW_COST_REASON_REQUIRED$/],
  ['admin: auto-draft fails otherwise', U.ADMIN, complete(U.ADMIN, OTHER_MSG), /^ok\|.*Reason: INVOICE_CUSTOMER_ON_HOLD: credit hold$/, 'same'],

  ['rep: blend order, header stale', U.REP, blend(U.REP, false), WITH_FIGURES, /^P0001\|ORDER_HEADER_NOT_RECALCULATED$/],
  ['admin: blend order, header stale', U.ADMIN, blend(U.ADMIN, false), WITH_FIGURES, 'same'],
  ['rep: blend order, header fine', U.REP, blend(U.REP, true), /^ok\|\{/, /^ok\|\{/],
];

function runMatrix(phase) {
  const out = {};
  for (const [label, uid, probe] of CASES) out[label] = attempt(uid, probe);
  console.log(`[prover] ${phase}: ${CASES.length} cases run`);
  return out;
}
function check(phase, results, baseline = null) {
  const failures = [];
  for (const [label, , , before, after] of CASES) {
    const want = phase === 'before' ? before : after;
    const got = results[label];
    if (want === 'same') {
      if (got !== baseline[label]) failures.push(`${label}: changed from "${baseline[label]}" to "${got}"`);
    } else if (!want.test(got)) {
      failures.push(`${label}: got "${got}", expected ${want}`);
    }
  }
  assert.deepEqual(failures, [], `${phase.toUpperCase()} failed:\n  ${failures.join('\n  ')}`);
  console.log(`[prover] ${phase.toUpperCase()}: all ${CASES.length} cases as expected`);
}

function preflightRefusesDrift() {
  stageText('cand.sql', lf(CANDIDATE));
  const setup = `CREATE OR REPLACE FUNCTION public.get_dispatch_board_jobs(p_applicator_id uuid, p_status text DEFAULT NULL::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
    RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT '{}'::jsonb $$;`;
  const d = docker([...psqlArgs()], { input: `BEGIN;\n${setup}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
  assert.notEqual(d.status, 0, 'the candidate applied over a drifted dispatch board');
  assert.match(d.stderr, /COST_DEFINER_LEAKS_PREFLIGHT: .*get_dispatch_board_jobs/, `wrong refusal:\n${d.stderr}`);
  // same body, one extra optional argument: CREATE OR REPLACE would add a second function, not replace this one
  const resign = `DO $r$ DECLARE d text := pg_get_functiondef('public.get_dispatch_board_jobs(uuid,text,date,date)'::regprocedure);
    BEGIN DROP FUNCTION public.get_dispatch_board_jobs(uuid,text,date,date);
      EXECUTE replace(d, 'p_end_date date DEFAULT NULL::date)', 'p_end_date date DEFAULT NULL::date, p_extra boolean DEFAULT NULL::boolean)'); END $r$;`;
  const s = docker([...psqlArgs()], { input: `BEGIN;\n${resign}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
  assert.notEqual(s.status, 0, 'the candidate applied over a dispatch board with a changed argument list');
  assert.match(s.stderr, /COST_DEFINER_LEAKS_PREFLIGHT: .*get_dispatch_board_jobs/, `wrong refusal:\n${s.stderr}`);
  console.log('[prover] PREFLIGHT: a drifted body or argument list aborts the candidate');
}
// Each mutant reverts one fix to its pre-fix live text; the postflight must refuse every one.
const MUTANTS = [
  ['fix 1', "(to_jsonb(m) - 'total_cost_cents')", 'to_jsonb(m)', /dispatch board still returns job cost/],
  ['fix 2', "  v_note := COALESCE(p_notes, 'Initial inventory record created with ' || p_quantity || ' units');\n",
    "  v_note := COALESCE(p_notes, 'Initial inventory record created with ' || p_quantity || ' units');\n"
    + "  IF p_unit_cost IS NOT NULL AND p_unit_cost > 0 THEN\n"
    + "    v_note := v_note || ' (purchased @ $' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM p_unit_cost::text)) || '/unit)';\n"
    + "  END IF;\n",
    /manual inventory add still writes cost into notes/],
  ['fix 3', "|| CASE WHEN SQLERRM LIKE 'BELOW\\_COST\\_%' THEN split_part(SQLERRM, ':', 1) ELSE SQLERRM END,", '|| SQLERRM,',
    /complete_job still logs a below-cost detail/],
  ['fix 4', "    IF NOT public.is_admin() THEN\n      RAISE EXCEPTION 'ORDER_HEADER_NOT_RECALCULATED';\n    END IF;\n", '',
    /blend-ticket header check still shows cost to non-admins/],
  // a fixed copy created beside the leaking one (new argument list) must not pass as a fix
  ['single version', 'p_end_date date DEFAULT NULL::date)', 'p_end_date date DEFAULT NULL::date, p_extra boolean DEFAULT NULL::boolean)',
    /get_dispatch_board_jobs now has 2 overloads/],
];
function postflightRefusesMissingFix() {
  const text = lf(CANDIDATE);
  for (const [fix, fixed, reverted, refusal] of MUTANTS) {
    // fix 2's anchor line is the one the original body also had; it must appear once, in the inventory body
    assert.equal(text.split(fixed).length - 1, 1, `${fix} anchor appears once in the candidate`);
    stageText('mutant.sql', text.replace(fixed, () => reverted));
    const d = docker([...psqlArgs()], { input: 'BEGIN;\n\\i /tmp/mutant.sql\nROLLBACK;', allowFailure: true });
    assert.notEqual(d.status, 0, `a candidate without ${fix} applied`);
    assert.match(d.stderr, new RegExp(`COST_DEFINER_LEAKS_POSTFLIGHT: .*${refusal.source}`), `${fix}: wrong refusal:\n${d.stderr}`);
  }
  console.log('[prover] MUTATION: the postflight refuses a candidate missing any one of the four fixes, or that adds a second version');
}

function main() {
  if (!REUSE) buildContainer();
  else assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname = 'get_dispatch_board_jobs' AND prosrc LIKE '%- ''total_cost_cents''%';"), '0',
    'the reused container already has the candidate applied (it is in the AFTER state); rebuild it');
  fidelity();
  if (scalar(`SELECT count(*) FROM public.jobs WHERE id = '${JOB}';`) === '0') seed();

  const before = runMatrix('before');
  check('before', before);
  preflightRefusesDrift();
  postflightRefusesMissingFix();

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  check('after', runMatrix('after'), before);
  console.log('COST_DEFINER_LEAKS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
