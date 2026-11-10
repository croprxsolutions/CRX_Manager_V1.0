#!/usr/bin/env node
/**
 * Real-schema proof for 20261206110000 (KI-18 leftovers). Builds the checked-in schema baseline in a
 * network-disabled PostgreSQL container, replays every migration before the candidate, then shows BEFORE
 * and AFTER the candidate:
 *  - _sync_job_holds, in a session whose date is one day off Chicago's (as UTC is every Central evening),
 *    counts a manual hold against free stock by the session date before and by the Chicago date after; a
 *    signed-in caller passing another user as the actor is accepted before and refused after, while its
 *    own id, a NULL actor and a system call with no signed-in user still sync;
 *  - a write-off and a credit application made at 7:30 pm CDT on Oct 31 (Nov 1 in UTC): with November
 *    closed, reversing is refused before and passes the period gate after (the write-off reverses); with
 *    October closed, both are refused before and after;
 *  - the 3-day stale-quote call list holds a quote of Chicago age 3 (under 72 hours) only after, and a
 *    quote of age 2 neither time;
 * and checks every replaced definition equals its pre-image with only the planned edits (grants, owner,
 * SECURITY DEFINER and volatility unchanged), and that a second apply passes.
 *
 * Run: node scripts/smoke/prove-ki18-leftovers-real-schema.mjs   (needs local Docker image)
 * Prints KI18_LEFTOVERS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki18-lo-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261206110000_ki18_leftovers_hold_expiry_reversal_month_stale_quotes.sql');
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
  '_sync_job_holds(uuid,uuid)',
  'reverse_credit_memo_application(uuid,text,uuid,text)',
  '_unapply_return_credit_guard_impl_20260826(uuid,text,uuid,text)',
  '_void_invoice_split_provenance_impl_20260719(uuid,text,text)',
  '_reverse_write_off_replay_impl_20261015(uuid,text,uuid,text)',
  'get_call_list_stale_quotes(uuid,integer)',
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


const ADMIN = '16000000-0000-4000-8000-000000000021';
const OTHER = '16000000-0000-4000-8000-000000000022';
const CHI = "(now() AT TIME ZONE 'America/Chicago')::date";

// The candidate's planned edits, applied to the pre-image text, must give the post-image exactly.
const BOTH = (v) => `PERFORM check_period_open((${v} AT TIME ZONE 'UTC')::date); PERFORM check_period_open((${v} AT TIME ZONE 'America/Chicago')::date);`;
const ONE = (v, pad) => `-- KI-18 (Mason, 2026-11-07): the Chicago day the row was booked under, as its apply checked.\n${pad}PERFORM check_period_open((${v} AT TIME ZONE 'America/Chicago')::date);`;
const EDITS = {
  _sync_job_holds: [
    ['BEGIN\n  v_actor := COALESCE(p_actor, auth.uid());\n',
      "BEGIN\n  -- idempotency-body-check: exempt\n  -- Internal engine (EXECUTE: postgres, service_role): it rebuilds a job's holds from scratch, so a\n  -- repeat call writes nothing new; reserve_job_inventory documents the same exemption.\n  v_actor := COALESCE(p_actor, auth.uid());\n  -- A signed-in caller can only act as itself; every caller passes auth.uid(), and system calls (no\n  -- auth.uid()) keep their explicit actor. Same rule as _sync_quote_job_reservations.\n  IF p_actor IS NOT NULL AND auth.uid() IS NOT NULL AND p_actor IS DISTINCT FROM auth.uid() THEN\n    RAISE EXCEPTION 'ACTOR_MISMATCH' USING ERRCODE = '42501';\n  END IF;\n"],
    ['AND (h.expires_at IS NULL OR h.expires_at >= CURRENT_DATE)', `AND (h.expires_at IS NULL OR h.expires_at >= ${CHI})`],
  ],
  reverse_credit_memo_application: [
    ['-- checks CURRENT_DATE, so an application', '-- checks the Chicago date, so an application'],
    [BOTH('v_app.applied_at'), ONE('v_app.applied_at', '  ')],
  ],
  _unapply_return_credit_guard_impl_20260826: [[BOTH('v_capp.applied_at'), ONE('v_capp.applied_at', '    ')]],
  _void_invoice_split_provenance_impl_20260719: [[BOTH('v_capp.applied_at'), ONE('v_capp.applied_at', '    ')]],
  _reverse_write_off_replay_impl_20261015: [[BOTH('v_wo.created_at'), ONE('v_wo.created_at', '  ')]],
  get_call_list_stale_quotes: [['AND q.updated_at < now() - make_interval(days => p_days)',
    `-- KI-18: the same Chicago calendar-day age the row shows, not whole 24-hour periods.\n        AND (${CHI} - (q.updated_at AT TIME ZONE 'America/Chicago')::date) >= p_days`]],
};
function planned(sig, def) {
  let out = def;
  for (const [from, to] of EDITS[fnName(sig)]) {
    assert.equal(out.split(from).length - 1, 1, `${sig}: planned edit target not found exactly once: ${from.slice(0, 70)}`);
    out = out.replace(from, () => to);
  }
  return out;
}
const definition = (sig) => docker([...psqlArgs(), '-A', '-t'], { input: `SELECT pg_get_functiondef('public.${sig}'::regprocedure);` }).stdout.replace(/\r/g, '');
const acl = (sig) => scalar(`SELECT coalesce(proacl::text, '-') || ' ' || pg_get_userbyid(proowner) || ' ' || prosecdef::text || ' ' || provolatile::text FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;`);

// Insert one row into public.<table> with session_replication_role = replica (no triggers or FK checks),
// filling every NOT NULL column that has no default (or defaults to auth.uid(), NULL here) with a typed
// placeholder; `fields` override them.
function seedRow(table, fields) {
  const id = fields.id ?? randomUUID();
  const overrides = JSON.stringify({ id, ...fields }).replaceAll("'", "''");
  psql(`SET session_replication_role = replica;
DO $seed$
DECLARE v_o jsonb := '${overrides}'::jsonb; v_cols text := ''; v_vals text := ''; c record;
BEGIN
  FOR c IN SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ,
                  coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE '%auth.uid()%' AS uid_default
             FROM pg_attribute a
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = 'public.${table}'::regclass AND a.attnum > 0 AND NOT a.attisdropped
              AND a.attgenerated = ''
              AND (v_o ? a.attname OR (a.attnotnull AND (NOT a.atthasdef OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE '%auth.uid()%')))
  LOOP
    v_cols := v_cols || CASE WHEN v_cols = '' THEN '' ELSE ', ' END || quote_ident(c.attname);
    v_vals := v_vals || CASE WHEN v_vals = '' THEN '' ELSE ', ' END || CASE
      WHEN v_o ? c.attname THEN quote_nullable(v_o ->> c.attname) || '::' || c.typ
      WHEN c.uid_default THEN quote_literal('${ADMIN}') || '::uuid'
      WHEN c.typ = 'uuid' THEN 'gen_random_uuid()'
      WHEN c.typ IN ('integer','bigint','smallint') OR c.typ LIKE 'numeric%' THEN '0'
      WHEN c.typ = 'boolean' THEN 'false'
      WHEN c.typ = 'date' THEN 'current_date'
      WHEN c.typ LIKE 'timestamp%' THEN 'now()'
      WHEN c.typ = 'jsonb' THEN '''{}''::jsonb'
      ELSE quote_literal('[PROVER] ' || substr(md5(random()::text), 1, 8)) || '::' || c.typ END;
  END LOOP;
  EXECUTE format('INSERT INTO public.${table} (%s) VALUES (%s)', v_cols, v_vals);
END $seed$;`);
  return id;
}
const today = () => scalar(`SELECT ${CHI};`);

function seed(holdExpires) {
  for (const [id, email, name] of [[ADMIN, 'ki18-lo-admin@example.invalid', '[PROVER] KI18 admin'], [OTHER, 'ki18-lo-other@example.invalid', '[PROVER] KI18 other']]) {
    psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${id}', '${email}', '{"full_name":"${name}"}'::jsonb) ON CONFLICT DO NOTHING;
      SET session_replication_role = replica;
      INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES ('${id}', '${email}', '${name}', 'admin', true)
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active;`);
  }
  const customer = seedRow('customers', { email: 'ki18-lo-customer@example.invalid', is_active: true, assigned_sales_rep: ADMIN });
  // Hold scenario: 10 Gal on hand, a scheduled quote-less job needing 6 Gal, a manual 5 Gal hold.
  const product = seedRow('products', { product_name: '[PROVER] KI18 hold product', inventory_unit: 'Gal', product_form: 'liquid' });
  seedRow('inventory', { product_id: product, location: 'Main Warehouse', quantity_available: 10, quantity_prebooked: 0 });
  const job = seedRow('jobs', { customer_id: customer, status: 'scheduled', quote_id: null, deleted_at: null, job_number: 'JOB-KI18-LO' });
  seedRow('job_chemicals', { job_id: job, product_id: product, quantity: 6, unit: 'Gal', customer_supplied: false, price_per_unit_cents: 100 });
  seedRow('inventory_holds', { product_id: product, customer_id: customer, quantity: 5, hold_type: 'manual', expires_at: holdExpires, is_active: true, created_by: ADMIN });
  // Reversal scenario: a write-off and a credit application made Oct 31 7:30 pm CDT (Nov 1 00:30 UTC).
  const invoice = seedRow('invoices', { customer_id: customer, status: 'posted', invoice_date: '2026-10-20', due_date: '2099-01-01', posted_at: '2026-10-20 15:00:00+00', posted_by: ADMIN, invoice_type: 'chemical_sale', total_amount_cents: 10000, write_off_cents: 1000, credit_applied_cents: 500, invoice_number: 'INV-KI18-LO' });
  const memo = seedRow('invoices', { customer_id: customer, status: 'posted', invoice_date: '2026-10-20', due_date: '2099-01-01', posted_at: '2026-10-20 15:00:00+00', posted_by: ADMIN, invoice_type: 'credit_memo', total_amount_cents: -500, credit_applied_cents: 500, invoice_number: 'CM-KI18-LO' });
  const writeOff = seedRow('write_offs', { invoice_id: invoice, customer_id: customer, amount_cents: 1000, reason: '[PROVER]', created_by: ADMIN, created_at: '2026-11-01 00:30:00+00', reversed_at: null });
  const application = seedRow('credit_memo_applications', { credit_memo_id: memo, target_invoice_id: invoice, amount_cents: 500, applied_by: ADMIN, applied_at: '2026-11-01 00:30:00+00', reversed_at: null });
  // Stale-quote scenario: one quote last touched at 11:59:59 pm Chicago three days ago (Chicago age 3, under
  // 72 hours), and one touched just after midnight Chicago two days ago (age 2).
  const at = (n, clock) => scalar(`SELECT ((${CHI} - ${n})::timestamp + '${clock}'::time) AT TIME ZONE 'America/Chicago';`);
  seedRow('quotes', { customer_id: customer, status: 'sent', quote_number: 'Q-KI18-LO-3', total_price: 12.34, updated_at: at(3, '23:59:59'), deleted_at: null });
  seedRow('quotes', { customer_id: customer, status: 'sent', quote_number: 'Q-KI18-LO-2', total_price: 5, updated_at: at(2, '00:00:01'), deleted_at: null });
  return { job, writeOff, application };
}

// Run one statement as a signed-in user (or none) in the given session zone inside a rolled-back
// transaction; returns { ok, out, err }.
function run(sql, { user = ADMIN, zone = 'UTC' } = {}) {
  const who = user ? `SET request.jwt.claim.sub = '${user}';` : 'RESET request.jwt.claim.sub;';
  const r = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN; SET TimeZone = '${zone}'; ${who}\n${sql};\nROLLBACK;`, allowFailure: true });
  return { ok: r.status === 0, out: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '', err: r.stderr.trim() };
}
// Shortfall reported for the job, in a session whose CURRENT_DATE is `zone`'s date.
function shortfall(ids, zone) {
  const r = run(`SELECT coalesce((public._sync_job_holds('${ids.job}', '${ADMIN}')->'shortfalls'->0->>'short'), '0')`, { zone });
  assert.ok(r.ok, r.err);
  return Number(r.out);
}
function actorChecks(ids) {
  const sync = (user, actor) => run(`SELECT public._sync_job_holds('${ids.job}', ${actor ? `'${actor}'` : 'NULL'}) IS NOT NULL`, { user });
  const forged = sync(ADMIN, OTHER);
  return {
    forged: forged.ok ? 'accepted' : (/ACTOR_MISMATCH/.test(forged.err) ? 'refused' : forged.err),
    own: sync(ADMIN, ADMIN).ok, system: sync(null, ADMIN).ok, nullActor: sync(ADMIN, null).ok,
  };
}
function setClosed(month) {
  psql(`SET session_replication_role = replica;
    DELETE FROM public.accounting_periods WHERE period_start IN ('2026-10-01', '2026-11-01');
    INSERT INTO public.accounting_periods (period_start, period_end, status, closed_at, closed_by)
    VALUES ('${month}', ('${month}'::date + interval '1 month' - interval '1 day')::date, 'closed', now(), '${ADMIN}');`);
}
// 'closed' when the period gate refuses, 'ok' when the call succeeds, else the error past the gate.
function reversals(ids) {
  const outcome = (r) => (r.ok ? 'ok' : /falls in closed accounting period/.test(r.err) ? 'closed' : `past-gate: ${r.err.split('\n')[0]}`);
  return {
    writeOff: outcome(run(`SELECT public._reverse_write_off_replay_impl_20261015('${ids.writeOff}', '[PROVER] reverse', '${ADMIN}', NULL)`)),
    application: outcome(run(`SELECT public.reverse_credit_memo_application('${ids.application}', '[PROVER] reverse', '${ADMIN}', NULL)`)),
  };
}
function staleList() {
  const r = run("SELECT coalesce(string_agg((x->>'quote_number') || ':' || (x->>'quote_age_days'), ',' ORDER BY x->>'quote_number'), '-') FROM jsonb_array_elements(public.get_call_list_stale_quotes(NULL, 3)->'rows') x");
  assert.ok(r.ok, r.err);
  return r.out;
}

let startDay = null;  // the Chicago date the run started on
function main() {
  buildContainer();  // always a fresh sealed container: no reuse of any existing database
  const T = today();
  startDay = T;
  const zone = scalar(`SELECT CASE WHEN (now() AT TIME ZONE 'Pacific/Kiritimati')::date <> ${CHI} THEN 'Pacific/Kiritimati' ELSE 'Etc/GMT+12' END;`);
  const D = scalar(`SET TimeZone = '${zone}'; SELECT current_date::text;`);
  assert.notEqual(D, T, 'the test zone must put CURRENT_DATE on another day than Chicago');
  const evening = D > T;  // the session is a day ahead, as UTC is every Central evening
  // The hold ends on the earlier of the two days: Chicago today when the session is ahead (it must still
  // count), the session's date (Chicago yesterday) when it is behind (it must not count any more).
  const ids = seed(evening ? T : D);
  console.log(`[prover] Chicago date ${T}; session zone ${zone} gives CURRENT_DATE ${D}; the manual hold ends ${evening ? T : D}`);

  const preDefs = Object.fromEntries(TARGETS.map((sig) => [sig, definition(sig)]));
  const preAcl = Object.fromEntries(TARGETS.map((sig) => [sig, acl(sig)]));
  // Chicago answer: when the hold still counts, free = 10 - 6 (job) - 5 (hold) = -1, so 1 Gal short; else none.
  const wantShort = evening ? 1 : 0;
  const shortBefore = shortfall(ids, zone);
  assert.equal(shortBefore, 1 - wantShort, `BEFORE: the shortfall already follows Chicago (${shortBefore})`);
  const actorBefore = actorChecks(ids);
  assert.deepEqual(actorBefore, { forged: 'accepted', own: true, system: true, nullActor: true }, `BEFORE actor checks ${JSON.stringify(actorBefore)}`);
  setClosed('2026-11-01');
  const novBefore = reversals(ids);
  assert.deepEqual(novBefore, { writeOff: 'closed', application: 'closed' }, `BEFORE, November closed: ${JSON.stringify(novBefore)}`);
  setClosed('2026-10-01');
  const octBefore = reversals(ids);
  assert.deepEqual(octBefore, { writeOff: 'closed', application: 'closed' }, `BEFORE, October closed: ${JSON.stringify(octBefore)}`);
  const staleBefore = staleList();
  assert.equal(staleBefore, '-', `BEFORE: the 3-day list already holds ${staleBefore}`);
  console.log(`[prover] BEFORE: shortfall ${shortBefore} (Chicago answer ${wantShort}); forged actor accepted; the Oct 31 7:30 pm CDT write-off and credit application are refused with November closed and with October closed; 3-day stale list empty`);

  stageText('candidate.sql', lf(CANDIDATE));
  let r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log(`[prover] candidate applied (preflight and postflight passed) for ${TARGETS.length} functions`);
  for (const sig of TARGETS) {
    assert.equal(definition(sig), planned(sig, preDefs[sig]), `${sig}: the new definition differs from the pre-image by more than the planned edits`);
    assert.equal(acl(sig), preAcl[sig], `${sig}: grants, owner, SECURITY DEFINER or volatility changed`);
  }
  console.log(`[prover] all ${TARGETS.length} definitions equal their pre-image with only the planned edits; grants unchanged`);

  const shortAfter = shortfall(ids, zone);
  assert.equal(shortAfter, wantShort, `AFTER: shortfall ${shortAfter}, Chicago answer ${wantShort}`);
  const actorAfter = actorChecks(ids);
  assert.deepEqual(actorAfter, { forged: 'refused', own: true, system: true, nullActor: true }, `AFTER actor checks ${JSON.stringify(actorAfter)}`);
  setClosed('2026-11-01');
  const novAfter = reversals(ids);
  assert.deepEqual(novAfter, { writeOff: 'ok', application: 'ok' }, `AFTER, November closed: ${JSON.stringify(novAfter)}`);
  setClosed('2026-10-01');
  const octAfter = reversals(ids);
  assert.deepEqual(octAfter, { writeOff: 'closed', application: 'closed' }, `AFTER, October closed: ${JSON.stringify(octAfter)}`);
  const staleAfter = staleList();
  assert.equal(staleAfter, 'Q-KI18-LO-3:3', `AFTER: the 3-day list holds ${staleAfter}`);
  console.log(`[prover] AFTER: shortfall ${shortAfter}; forged actor refused, own id, system call and NULL actor sync; November closed: write-off reversal ${novAfter.writeOff}, credit application ${novAfter.application}; October closed: both refused; 3-day stale list ${staleAfter}`);

  r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log('[prover] a second apply passes (re-runnable)');
  console.log('KI18_LEFTOVERS_PROOF_PASS');
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
