#!/usr/bin/env node
/**
 * Real-schema proof for 20261204120000_job_lines_keep_epa_number: once a job is sprayed or finished,
 * every product on it keeps the EPA number the job recorded (job_product_epa), through re-saves,
 * remove + re-add, duplicate positions, and a spray record deleted and re-entered; a job not sprayed
 * yet keeps reading the product's current number; app roles cannot write job lines or the locks.
 *
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays every
 * migration before the candidate, seeds invented rows and checks each case.
 *
 * Run: node scripts/smoke/prove-job-lines-keep-epa-real-schema.mjs   (needs local Docker image)
 * Prints JOB_LINES_KEEP_EPA_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-jobepa-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261204120000_job_lines_keep_epa_number.sql');
const FOLLOW_UPS = [];
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
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(job_chemicals|job_applied_records|job_product_epa|job_epa_sprayed|_job_epa_freeze|_epa_norm|save_job)/i;
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
// A second session held open in the background, for the race cases.
function session(sql) {
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const done = new Promise((resolve, reject) => {
    const child = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('JK_READY')) markReady(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`background session failed:\n${out}`))));
    child.stdin.end(sql);
  });
  done.catch(() => markReady());
  return { ready, done };
}
// Held by a background transaction after JK_READY: it commits only once another session is seen waiting
// on a lock (or after 8 s, printing JK_NO_WAITER), so a wait is observed in pg_locks, not inferred from time.
const HOLD_UNTIL_WAITER = `DO $w$ BEGIN
  FOR i IN 1..80 LOOP
    EXIT WHEN EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid());
    PERFORM pg_sleep(0.1);
  END LOOP; END $w$;
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid())
  THEN 'JK_SAW_WAITER' ELSE 'JK_NO_WAITER' END;`;
// Runs fn while bg holds its lock and asserts fn really waited on a lock behind it.
async function waited(bg, fn, what) {
  const r = fn();
  const out = await bg.done;
  assert.match(out, /JK_SAW_WAITER/, `${what} did not wait for the transaction in flight`);
  return r;
}
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
  // Others' migrations may sort between the candidate and a follow-up (live applied them in between);
  // they are not replayed, so each must leave alone what this proof covers.
  let last = at;
  for (const file of FOLLOW_UPS) {
    const i = all.indexOf(file);
    assert.ok(i > last, `${path.basename(file)} must sort after the candidate and earlier follow-ups`);
    last = i;
  }
  for (const file of all.slice(at + 1).filter((f) => !FOLLOW_UPS.includes(f))) {
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
    // BLK-1a's preflight needs live's count units (live has Ea and Unit, factor 1, both).
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
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


const id = (n) => `7a7e4000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
const STRANGER = id('a9');  // signed in, no profile: sees no job lines
const CUST = id('c1');
const FIELD = id('d1');
const PA = id('f1'), PB = id('f2'), PC = id('f3'), PD = id('f4'), PE = id('f5'), PF = id('f6'), PG = id('f7');
const JOLD = id('10'), JOTHER = id('11'), JSPRAYED = id('12'), JOPEN = id('13');
const OLD = '524-475', NEW = '524-476', B_EPA = '100-1070';

function txIn(uid, sql) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  return `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n`;
}
function as(uid, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: txIn(uid, sql) });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(r.output, pattern);
}
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
// A customer-supplied line at zero: passes every money and unit refusal, so only the EPA behaviour is tested.
const chem = (pid, sort, extra = {}) => ({ product_id: pid, quantity: 0, unit: 'Gal', rate_per_acre: null, rate_unit: null,
  cost_per_unit_cents: 0, price_per_unit_cents: 0, customer_supplied: true, sort_order: sort, ...extra });
const saveSql = (job, chems, key = null) => `SELECT public.save_job(${job ? `'${job}'` : 'NULL'},
  jsonb_build_object('customer_id', '${CUST}', 'job_date', current_date::text),
  ${J([{ field_id: FIELD, acres_to_treat: 10, sort_order: 0 }])}, ${J(chems)}, auth.uid(), ${key ? `'${key}'` : 'NULL'})->>'job_id';`;
const save = (uid, job, chems, key = null) => ok(uid, saveSql(job, chems, key));
// What a job shows for each line: the kept number when its product is locked, else the product's current one.
const shown = (job) => scalar(`SELECT COALESCE(string_agg(jc.sort_order || ':' || COALESCE(
    CASE WHEN l.product_id IS NOT NULL THEN l.epa_registration ELSE public._epa_norm(p.epa_registration) END, '<null>'),
    ',' ORDER BY jc.sort_order, p.product_name), '<none>')
  FROM public.job_chemicals jc JOIN public.products p ON p.id = jc.product_id
  LEFT JOIN public.job_product_epa l ON l.job_id = jc.job_id AND l.product_id = jc.product_id
 WHERE jc.job_id = '${job}';`);
const locks = (job) => scalar(`SELECT COALESCE(string_agg(COALESCE(p.sku, '<deleted>') || '=' || COALESCE(l.epa_registration, '<null>'), ',' ORDER BY p.sku), '<none>')
  FROM public.job_product_epa l LEFT JOIN public.products p ON p.id = l.product_id WHERE l.job_id = '${job}';`);
const backfilled = (job) => scalar(`SELECT string_agg(DISTINCT not_recorded::text, ',') FROM (
  SELECT not_recorded FROM public.job_product_epa WHERE job_id = '${job}' UNION ALL
  SELECT not_recorded FROM public.job_epa_sprayed WHERE job_id = '${job}') x;`);
const marked = (job) => scalar(`SELECT count(*) FROM public.job_epa_sprayed WHERE job_id = '${job}';`);
const setProductEpa = (pid, epa) => psql(`UPDATE public.products SET epa_registration = ${epa === null ? 'NULL' : `'${epa}'`} WHERE id = '${pid}';`);
// Legacy-shaped numbers (blank, padded): the product setup guard refuses them on new writes, so write them the
// way old rows hold them, below the triggers. products has no trigger from this file, so nothing is skipped here.
const legacyEpa = (pid, literal) => psql(`SET session_replication_role = replica;
  UPDATE public.products SET epa_registration = ${literal} WHERE id = '${pid}';`, { user: 'supabase_admin' });
const spray = (job) => psql(`INSERT INTO public.job_applied_records (job_id, application_date, applied_acres) VALUES ('${job}', current_date, 10);`);
const line = (job, pid, sort) => `INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, customer_supplied, sort_order)
  VALUES ('${job}', '${pid}', 0, 'Gal', 0, true, ${sort});`;
const quick = (fn, what) => { const t = Date.now(); const r = fn(); assert.ok(Date.now() - t < 2000, `${what} waited`); return r; };

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'jk-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'jk-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  const p = (pid, name, epa) => `('${pid}', '[PROVER] ${name}', '${name}', 'liquid', 'Gal', 'Herbicide', '${epa}', 10.00, 15.00, true)`;
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, current_cost, tier1_price, is_active) VALUES
      ${p(PA, 'A', OLD)}, ${p(PB, 'B', B_EPA)}, ${p(PC, 'C', '300-1')}, ${p(PD, 'D', '400-1')}, ${p(PE, 'E', '500-1')},
      ${p(PF, 'F', '600-1')}, ${p(PG, 'G', '700-1')};
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT 'Gal', 128, 'liquid' WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = 'Gal');
    INSERT INTO public.customers (id, farm_name) VALUES ('${CUST}', '[PROVER] Farm');
    INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${FIELD}', '${CUST}', '[PROVER] Field', 100);
    INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, created_by) VALUES
      ('${JOLD}', 'JK-OLD', '${CUST}', 'completed', current_date, '${ADMIN}'),
      ('${JOTHER}', 'JK-OTHER', '${CUST}', 'invoiced', current_date, '${ADMIN}'),
      ('${JSPRAYED}', 'JK-SPRAYED', '${CUST}', 'in_progress', current_date, '${ADMIN}'),
      ('${JOPEN}', 'JK-OPEN', '${CUST}', 'scheduled', current_date, '${ADMIN}');
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, customer_supplied, sort_order) VALUES
      ('${JOLD}', '${PA}', 0, 'Gal', 0, true, 0), ('${JOLD}', '${PB}', 0, 'Gal', 0, true, 1),
      ('${JOTHER}', '${PA}', 0, 'Gal', 0, true, 0), ('${JSPRAYED}', '${PB}', 0, 'Gal', 0, true, 0),
      ('${JOPEN}', '${PA}', 0, 'Gal', 0, true, 0);
    INSERT INTO public.job_applied_records (job_id, application_date, applied_acres) VALUES ('${JSPRAYED}', current_date, 10);
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  console.log('[prover] seeded an admin, a rep, a customer and field, seven products, two finished jobs, a sprayed job and an open job');
}

async function main() {
  buildContainer();
  seed();
  stageText('cand.sql', lf(CANDIDATE));

  // One transaction only, once only.
  let r = docker([...psqlArgs(), '-f', '/tmp/cand.sql'], { allowFailure: true });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}\n${r.stderr}`, /JOB_LINES_KEEP_EPA_NOT_IN_TRANSACTION/);
  assert.equal(scalar("SELECT to_regclass('public.job_product_epa') IS NULL;"), 't');
  r = apply('cand.sql');
  assert.equal(r.status, 0, r.output);
  r = apply('cand.sql');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /already exists/);
  console.log('[prover] the file applies once, as one transaction');

  // Backfill: finished and sprayed jobs are marked and lock their products as Not recorded (NULL); open jobs are not.
  assert.equal(locks(JOLD), 'A=<null>,B=<null>', 'never filled from the current number');
  assert.equal(locks(JOTHER), 'A=<null>');
  assert.equal(locks(JSPRAYED), 'B=<null>');
  assert.equal(locks(JOPEN), '<none>');
  assert.deepEqual([JOLD, JOTHER, JSPRAYED, JOPEN].map(marked), ['1', '1', '1', '0']);
  assert.deepEqual([JOLD, JOTHER, JSPRAYED].map(backfilled), ['true', 'true', 'true'], 'backfilled rows are flagged');
  console.log('[prover] backfill: finished and sprayed jobs locked as Not recorded, never at the current number; the open job is not');

  // Permissions: no direct job line writes; the lock tables are not writable; the marker is not readable.
  for (const uid of [ADMIN, REP]) {
    refused(uid, `DELETE FROM public.job_chemicals WHERE job_id = '${JOLD}';`, /permission denied/);
    refused(uid, line(JOLD, PC, 5), /permission denied/);
    refused(uid, `UPDATE public.job_chemicals SET product_id = '${PB}' WHERE job_id = '${JOLD}';`, /permission denied/);
    refused(uid, `UPDATE public.job_chemicals SET quantity = 1 WHERE job_id = '${JOLD}';`, /permission denied/);
    refused(uid, 'TRUNCATE public.job_chemicals;', /permission denied/);
    refused(uid, `INSERT INTO public.job_product_epa (job_id, product_id, epa_registration) VALUES ('${JOPEN}', '${PA}', '1-1');`, /permission denied/);
    refused(uid, `UPDATE public.job_product_epa SET epa_registration = '1-1';`, /permission denied/);
    refused(uid, `DELETE FROM public.job_product_epa;`, /permission denied/);
    refused(uid, `SELECT count(*) FROM public.job_epa_sprayed;`, /permission denied/);
    refused(uid, `DELETE FROM public.job_epa_sprayed;`, /permission denied/);
    assert.equal(ok(uid, `SELECT count(*) FROM public.job_chemicals WHERE job_id = '${JOLD}';`), '2', 'line reads still work');
  }
  assert.equal(ok(ADMIN, `SELECT count(*) FROM public.job_product_epa WHERE job_id = '${JOLD}';`), '2', 'staff read the locks of jobs they can see');
  assert.equal(ok(STRANGER, `SELECT count(*) FROM public.job_chemicals;`), '0', 'the stranger sees no job lines');
  assert.equal(ok(STRANGER, `SELECT count(*) FROM public.job_product_epa;`), '0', 'so the stranger sees no locks');
  refused(null, `SELECT count(*) FROM public.job_product_epa;`, /permission denied/);
  refused(ADMIN, 'SELECT public._job_epa_freeze(NULL::uuid);', /permission denied/);
  assert.equal(ok(REP, "SELECT public._epa_norm(E' \t 1-2 \n');"), '1-2', 'signed-in users may call the normalizer to read');
  refused(null, "SELECT public._epa_norm('x');", /permission denied/);
  console.log('[prover] signed-in users cannot write job lines or locks, cannot read the marker, read locks only for jobs they can see; anon reads nothing; helpers are not callable');

  // An unsprayed job follows a product edit; a sprayed one keeps its number.
  const open = save(ADMIN, null, [chem(PA, 0), chem(PB, 1)]);
  const sprayed = save(ADMIN, null, [chem(PA, 0), chem(PB, 1)]);
  assert.equal(locks(open), '<none>');
  spray(sprayed);
  assert.equal(locks(sprayed), `A=${OLD},B=${B_EPA}`);
  assert.equal(backfilled(sprayed), 'false', 'locks recorded after the file are not flagged as backfill');
  setProductEpa(PA, NEW);
  assert.equal(shown(open), `0:${NEW},1:${B_EPA}`, 'an unsprayed job follows the product edit');
  assert.equal(shown(sprayed), `0:${OLD},1:${B_EPA}`, 'a sprayed job keeps its number');
  assert.equal(shown(JOLD), '0:<null>,1:<null>', 'a job finished before the file shows Not recorded, not the edit');
  console.log('[prover] a product EPA edit reaches only jobs not sprayed yet');

  // Re-saves (admin and rep, delete-and-rewrite) keep the locks; a keyed replay changes nothing.
  save(ADMIN, sprayed, [chem(PA, 0), chem(PB, 1)]);
  save(REP, sprayed, [chem(PB, 0), chem(PA, 1)]);
  assert.equal(shown(sprayed), `0:${B_EPA},1:${OLD}`);
  save(ADMIN, sprayed, [chem(PA, 0), chem(PB, 1)], 'jk-replay-1');
  save(ADMIN, sprayed, [chem(PA, 0), chem(PB, 1)], 'jk-replay-1');
  assert.equal(locks(sprayed), `A=${OLD},B=${B_EPA}`);
  console.log('[prover] re-saving a sprayed job (admin, rep, reordered, replayed) keeps every number');

  // Remove a product, save, then re-add it: it keeps the number the job recorded.
  save(ADMIN, sprayed, [chem(PB, 0)]);
  assert.equal(shown(sprayed), `0:${B_EPA}`);
  setProductEpa(PA, '524-477');
  save(ADMIN, sprayed, [chem(PB, 0), chem(PA, 1)]);
  assert.equal(shown(sprayed), `0:${B_EPA},1:${OLD}`, 're-added product keeps its recorded number');
  // Two lines of one product at one position: both show the one kept number.
  save(ADMIN, sprayed, [chem(PA, 0), chem(PA, 0), chem(PB, 1)]);
  assert.equal(shown(sprayed), `0:${OLD},0:${OLD},1:${B_EPA}`);
  assert.equal(locks(sprayed), `A=${OLD},B=${B_EPA}`, 'still one lock per product');
  // A product never on the job, added after the spray: locked at its number when added.
  save(ADMIN, sprayed, [chem(PA, 0), chem(PB, 1), chem(PC, 2)]);
  setProductEpa(PC, '300-2');
  assert.equal(shown(sprayed), `0:${OLD},1:${B_EPA},2:300-1`);
  console.log('[prover] remove + re-add keeps the number; two lines at one position share it; a new product locks at its add-time number');

  // Delete the spray record: the job stays locked. Edit, save, add a never-seen product, edit it,
  // re-enter the spray record: every number stays as first recorded.
  psql(`DELETE FROM public.job_applied_records WHERE job_id = '${sprayed}';`);
  assert.equal(marked(sprayed), '1', 'the marker survives');
  setProductEpa(PA, '524-478');
  setProductEpa(PB, '100-1071');
  save(ADMIN, sprayed, [chem(PA, 0), chem(PB, 1), chem(PC, 2)]);
  save(ADMIN, sprayed, [chem(PA, 0), chem(PB, 1), chem(PC, 2), chem(PD, 3)]);
  setProductEpa(PD, '400-2');
  spray(sprayed);
  assert.equal(shown(sprayed), `0:${OLD},1:${B_EPA},2:300-1,3:400-1`);
  console.log('[prover] deleting and re-entering a spray record changes no number');

  // Finished without a spray record: completed and invoiced both lock. A spray record moved to
  // another job makes that job "Not recorded" (Mason, 2026-11-06), never today's number; a job already
  // sprayed keeps its own numbers when one is moved onto it.
  const done = save(ADMIN, null, [chem(PE, 0)]);
  // Each step separately: the app allows scheduled -> in_progress -> completed -> invoiced only.
  for (const st of ['in_progress', 'completed']) psql(`UPDATE public.jobs SET status = '${st}' WHERE id = '${done}';`);
  assert.equal(locks(done), 'E=500-1');
  const billed = save(ADMIN, null, [chem(PE, 0)]);
  for (const st of ['in_progress', 'completed', 'invoiced']) psql(`UPDATE public.jobs SET status = '${st}' WHERE id = '${billed}';`);
  assert.equal(locks(billed), 'E=500-1');
  const moveTo = save(ADMIN, null, [chem(PF, 0)]);
  const moveFrom = save(ADMIN, null, [chem(PE, 0)]);
  spray(moveFrom);
  psql(`UPDATE public.job_applied_records SET job_id = '${moveTo}' WHERE job_id = '${moveFrom}';`);
  assert.equal(locks(moveTo), 'F=<null>', 'a moved spray record never records the current number');
  assert.equal(backfilled(moveTo), 'true');
  assert.equal(locks(moveFrom), 'E=500-1', 'the job it came from keeps its numbers');
  save(ADMIN, moveTo, [chem(PF, 0), chem(PA, 1)]);
  assert.equal(locks(moveTo), 'A=<null>,F=<null>', 'a product added later to that job is Not recorded too');
  const keepTo = save(ADMIN, null, [chem(PF, 0)]);
  spray(keepTo);
  psql(`UPDATE public.job_applied_records SET job_id = '${keepTo}' WHERE job_id = '${moveTo}';`);
  assert.equal(locks(keepTo), 'F=600-1', 'a sprayed job keeps its numbers when a record is moved onto it');
  assert.equal(backfilled(keepTo), 'false');
  setProductEpa(PE, '500-2');
  setProductEpa(PF, '600-2');
  assert.equal(shown(done), '0:500-1');
  assert.equal(shown(moveTo), '0:<null>,1:<null>');
  assert.equal(shown(keepTo), '0:600-1');
  // A job created already completed, then given lines (below the app roles): its products lock.
  const born = scalar(`INSERT INTO public.jobs (job_number, customer_id, status, job_date, created_by)
    VALUES ('JK-BORN', '${CUST}', 'completed', current_date, '${ADMIN}') RETURNING id;`);
  assert.equal(marked(born), '1', 'a job created completed is marked');
  psql(line(born, PF, 0));
  assert.equal(locks(born), 'F=600-2');
  console.log('[prover] completed, invoiced and a job created completed lock the job; a moved spray record makes its new job Not recorded');

  // A job finished before the file: a product added later may have been on it then (no history), so it is
  // "Not recorded" too, never its current number. A new spray record on it changes nothing either.
  psql(line(JOLD, PC, 2));
  spray(JOLD);
  assert.equal(locks(JOLD), 'A=<null>,B=<null>,C=<null>');
  assert.equal(backfilled(JOLD), 'true');
  console.log('[prover] a product added later to a job finished before the file is Not recorded too');

  // Visibility follows the job, not its current lines: with every line removed staff still read the
  // kept numbers. Deleting the job keeps them (owner-only once the job is gone).
  psql(`DELETE FROM public.job_chemicals WHERE job_id = '${born}';`);
  assert.equal(ok(ADMIN, `SELECT count(*) FROM public.job_product_epa WHERE job_id = '${born}';`), '1', 'kept numbers stay visible with no lines');
  assert.equal(ok(STRANGER, `SELECT count(*) FROM public.job_product_epa WHERE job_id = '${born}';`), '0');
  psql(`DELETE FROM public.jobs WHERE id = '${born}';`);
  assert.equal(locks(born), 'F=600-2', 'deleting a job never erases its kept numbers');
  assert.equal(marked(born), '1');
  assert.equal(ok(ADMIN, `SELECT count(*) FROM public.job_product_epa WHERE job_id = '${born}';`), '0', 'a deleted job shows to no one in the app');
  // A deleted job's ID can never be taken by a new job (its history would attach to it), by an admin
  // through the API or below it; and a job with history never changes its ID.
  refused(ADMIN, `INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, created_by)
    VALUES ('${born}', 'JK-REUSE', '${CUST}', 'scheduled', current_date, auth.uid());`, /JOB_EPA_HISTORY_ID/);
  let reuse = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, created_by)
    VALUES ('${born}', 'JK-REUSE', '${CUST}', 'scheduled', current_date, '${ADMIN}');` });
  assert.notEqual(reuse.status, 0);
  assert.match(`${reuse.stdout}
${reuse.stderr}`, /JOB_EPA_HISTORY_ID/);
  const bare = scalar(`INSERT INTO public.jobs (job_number, customer_id, status, job_date, created_by)
    VALUES ('JK-BARE', '${CUST}', 'completed', current_date, '${ADMIN}') RETURNING id;`);
  reuse = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `UPDATE public.jobs SET id = gen_random_uuid() WHERE id = '${bare}';` });
  assert.notEqual(reuse.status, 0);
  assert.match(`${reuse.stdout}
${reuse.stderr}`, /JOB_EPA_HISTORY_ID/);
  console.log('[prover] kept numbers stay visible with every line removed, survive deleting the job, and its ID can never be reused');

  // A blank or missing number is kept as blank; spaces count as blank.
  legacyEpa(PG, "'   '");
  const blank = save(ADMIN, null, [chem(PG, 0)]);
  spray(blank);
  assert.equal(locks(blank), 'G=<null>');
  setProductEpa(PG, '700-2');
  assert.equal(shown(blank), '0:<null>', 'a kept blank stays blank');
  legacyEpa(PG, "' 700-3 '");
  const trimmed = save(ADMIN, null, [chem(PG, 0)]);
  spray(trimmed);
  assert.equal(locks(trimmed), 'G=700-3', 'the kept number is trimmed');
  legacyEpa(PG, "E'\t700-4\r\n'");
  const tabbed = save(ADMIN, null, [chem(PG, 0)]);
  spray(tabbed);
  assert.equal(locks(tabbed), 'G=700-4', 'tabs and line breaks are trimmed too');
  console.log('[prover] blank and spaces-only numbers are kept as blank; spaces, tabs and line breaks are trimmed');

  // A product deleted after a job locked it: the job's kept number stays (no foreign key to products).
  const gone = '7a7a7a7a-0000-4000-8000-00000000002a';
  psql(`SET session_replication_role = replica;
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, current_cost, tier1_price, is_active)
    VALUES ('${gone}', '[PROVER] Gone', 'Z', 'liquid', 'Gal', 'Herbicide', '900-1', 10.00, 15.00, true);`, { user: 'supabase_admin' });
  const goneJob = save(ADMIN, null, [chem(gone, 0), chem(PE, 1)]);
  spray(goneJob);
  save(ADMIN, goneJob, [chem(PE, 0)]);
  const idChange = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `UPDATE public.products SET id = gen_random_uuid() WHERE id = '${gone}';` });
  assert.notEqual(idChange.status, 0);
  assert.match(`${idChange.stdout}
${idChange.stderr}`, /PRODUCT_EPA_HISTORY_ID/, 'a product with kept numbers never changes its ID');
  psql(`DELETE FROM public.products WHERE id = '${gone}';`);
  assert.equal(locks(goneJob), 'E=500-2,<deleted>=900-1', 'a deleted product keeps its kept number on the job');
  // Its ID can never be taken by a new product (a pricing-free shell, as the app creates products).
  const reuseProduct = (id) => docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `INSERT INTO public.products
    (id, product_name, sku, product_form, inventory_unit, category, is_active)
    VALUES ('${id}', '[PROVER] Reuse', 'Z-${id.slice(-4)}', 'liquid', 'Gal', 'Herbicide', true);` });
  const reused = reuseProduct(gone);
  assert.notEqual(reused.status, 0);
  assert.match(`${reused.stdout}
${reused.stderr}`, /PRODUCT_EPA_HISTORY_ID/);
  console.log('[prover] deleting a product never deletes the kept number of a job, and its ID can never be reused');

  // Below the app roles: a line changed in place to another product on a sprayed job locks that product.
  const lineId = scalar(`SELECT id FROM public.job_chemicals WHERE job_id = '${trimmed}';`);
  psql(`UPDATE public.job_chemicals SET product_id = '${PF}' WHERE id = '${lineId}';`);
  assert.equal(locks(trimmed), 'F=600-2,G=700-3');
  // A definer function an app role calls (how save_job, the quote path and recipes write lines) records locks too.
  psql(`CREATE FUNCTION public.jk_definer_line(p_job uuid, p_product uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
      SET search_path = public, pg_temp AS $$
      INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, customer_supplied, sort_order)
      VALUES (p_job, p_product, 0, 'Gal', 0, true, 9) $$;
    GRANT EXECUTE ON FUNCTION public.jk_definer_line(uuid, uuid) TO authenticated;`);
  ok(REP, `SELECT public.jk_definer_line('${trimmed}', '${PE}');`);
  assert.equal(locks(trimmed), 'E=500-2,F=600-2,G=700-3');
  psql('DROP FUNCTION public.jk_definer_line(uuid, uuid);');
  console.log('[prover] a server-side product change and a definer writer called by a signed-in user both record locks');

  // Races. A spray in flight: a save adding a new product waits, then its product is locked.
  setProductEpa(PC, '300-3');
  const raceA = save(ADMIN, null, [chem(PA, 0)]);
  let bg = session(`BEGIN;
    INSERT INTO public.job_applied_records (job_id, application_date, applied_acres) VALUES ('${raceA}', current_date, 10);
    SELECT 'JK_READY'; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  await waited(bg, () => save(ADMIN, raceA, [chem(PA, 0), chem(PC, 1)]), 'the save');
  assert.equal(locks(raceA), `A=524-478,C=300-3`, 'a product saved during a spray is locked');
  // A save in flight adding a new product: a spray waits, then the new product is locked.
  const raceB = save(ADMIN, null, [chem(PA, 0)]);
  bg = session(txIn(ADMIN, `${saveSql(raceB, [chem(PA, 0), chem(PC, 1)])}\nSELECT 'JK_READY';\n${HOLD_UNTIL_WAITER}`));
  await bg.ready;
  await waited(bg, () => spray(raceB), 'the spray');
  assert.equal(locks(raceB), `A=524-478,C=300-3`, 'a spray recorded while a save was in flight sees its lines');
  // A line written by another path (no job lock of its own) in flight: the freeze waits on the line's
  // job lock and then sees it. And the reverse.
  const raceC = save(ADMIN, null, [chem(PA, 0)]);
  bg = session(`BEGIN; ${line(raceC, PC, 1)} SELECT 'JK_READY'; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  await waited(bg, () => spray(raceC), 'the spray');
  assert.equal(locks(raceC), `A=524-478,C=300-3`, 'a freeze waits for a line write in flight and sees it');
  const raceD = save(ADMIN, null, [chem(PA, 0)]);
  bg = session(`BEGIN;
    INSERT INTO public.job_applied_records (job_id, application_date, applied_acres) VALUES ('${raceD}', current_date, 10);
    SELECT 'JK_READY'; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  await waited(bg, () => psql(line(raceD, PC, 1)), 'the line write');
  assert.equal(locks(raceD), `A=524-478,C=300-3`, 'a line written while a freeze was in flight is locked');
  // Two spray records on one job at once: the second waits, neither fails.
  bg = session(`BEGIN;
    INSERT INTO public.job_applied_records (job_id, application_date, applied_acres) VALUES ('${raceD}', current_date, 1);
    SELECT 'JK_READY'; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  await waited(bg, () => spray(raceD), 'the second spray');
  // A product EPA edit never waits on a spray in flight (no product lock is taken).
  bg = session(`BEGIN;
    INSERT INTO public.job_applied_records (job_id, application_date, applied_acres) VALUES ('${raceD}', current_date, 1);
    SELECT 'JK_READY'; SELECT pg_sleep(4); COMMIT;`);
  await bg.ready;
  quick(() => setProductEpa(PA, '524-479'), 'the EPA edit');
  await bg.done;
  assert.equal(locks(raceD), `A=524-478,C=300-3`);
  console.log('[prover] a spray and a save or line write on one job run one after the other and the later sees the earlier; two sprays queue; an EPA edit never waits');

  // ID reuse racing the transaction that writes the history and deletes the row: the reuse waits on the
  // primary key, then the guard (an AFTER trigger) sees the committed history and refuses it.
  const racer = '7a7a7a7a-0000-4000-8000-00000000003b';
  psql(`SET session_replication_role = replica;
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, current_cost, tier1_price, is_active)
    VALUES ('${racer}', '[PROVER] Racer', 'Z3', 'liquid', 'Gal', 'Herbicide', '901-1', 10.00, 15.00, true);`, { user: 'supabase_admin' });
  const racerJob = save(ADMIN, null, [chem(racer, 0)]);
  bg = session(`BEGIN;
    INSERT INTO public.job_applied_records (job_id, application_date, applied_acres) VALUES ('${racerJob}', current_date, 1);
    DELETE FROM public.job_chemicals WHERE job_id = '${racerJob}';
    DELETE FROM public.products WHERE id = '${racer}';
    SELECT 'JK_READY'; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  const raced = await waited(bg, () => reuseProduct(racer), 'the product ID reuse');
  assert.notEqual(raced.status, 0, 'a product ID reused while its history commits is refused');
  assert.match(`${raced.stdout}
${raced.stderr}`, /PRODUCT_EPA_HISTORY_ID/);
  const racerJobId = '7a7a7a7a-0000-4000-8000-00000000003c';
  bg = session(`BEGIN;
    INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, created_by)
      VALUES ('${racerJobId}', 'JK-RACE', '${CUST}', 'completed', current_date, '${ADMIN}');
    DELETE FROM public.jobs WHERE id = '${racerJobId}';
    SELECT 'JK_READY'; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  const racedJob = await waited(bg, () => docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `INSERT INTO public.jobs
    (id, job_number, customer_id, status, job_date, created_by)
    VALUES ('${racerJobId}', 'JK-RACE2', '${CUST}', 'scheduled', current_date, '${ADMIN}');` }), 'the job ID reuse');
  assert.notEqual(racedJob.status, 0, 'a job ID reused while its history commits is refused');
  assert.match(`${racedJob.stdout}
${racedJob.stderr}`, /JOB_EPA_HISTORY_ID/);
  // The reverse order: a spray in flight on a job with product R; deleting R waits for it (the freeze holds
  // KEY SHARE on R), so a later reuse of R's ID sees the committed history and is refused.
  const racer2 = '7a7a7a7a-0000-4000-8000-00000000003d';
  psql(`SET session_replication_role = replica;
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, current_cost, tier1_price, is_active)
    VALUES ('${racer2}', '[PROVER] Racer 2', 'Z4', 'liquid', 'Gal', 'Herbicide', '902-1', 10.00, 15.00, true);`, { user: 'supabase_admin' });
  const racer2Job = save(ADMIN, null, [chem(racer2, 0)]);
  bg = session(`BEGIN;
    INSERT INTO public.job_applied_records (job_id, application_date, applied_acres) VALUES ('${racer2Job}', current_date, 1);
    SELECT 'JK_READY'; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  await waited(bg, () => psql(`DELETE FROM public.job_chemicals WHERE job_id = '${racer2Job}';
    DELETE FROM public.products WHERE id = '${racer2}';`), 'the product delete');
  assert.equal(locks(racer2Job), '<deleted>=902-1');
  const reused2 = reuseProduct(racer2);
  assert.notEqual(reused2.status, 0, 'a product deleted while its history was being written cannot be reused');
  assert.match(`${reused2.stdout}
${reused2.stderr}`, /PRODUCT_EPA_HISTORY_ID/);
  console.log('[prover] an ID reused while another transaction writes its history and deletes the row is still refused, in either order');

  console.log('JOB_LINES_KEEP_EPA_PROOF_PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
});
