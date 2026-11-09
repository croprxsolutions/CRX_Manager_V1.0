#!/usr/bin/env node
// DM-2 (product weights) real-schema proof: builds a throwaway PostgreSQL from the schema baseline,
// replays every post-baseline migration before 20261207100000_product_weights.sql, seeds invented rows,
// applies the candidate (and its refusals), then checks the database half of the build sheet's
// "Done when" list (docs/plans/2026-11-06-product-DM2-BUILD-SHEET.md section 6).
// Usage: node scripts/smoke/prove-product-weights-real-schema.mjs   (needs Docker; prints PRODUCT_WEIGHTS_PROOF_PASS)
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// CRX_DM2_CONTAINER=<name> reuses a kept container (built with CRX_PROVER_KEEP_CONTAINER=1) and runs the
// cases in a fresh copy of its pre-candidate database; for iterating on this proof only.
const REUSE = process.env.CRX_DM2_CONTAINER || '';
const NAME = REUSE || `crx-dm2-${process.pid}-${Date.now().toString(36)}`;
let DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
// Only a container this proof created carries the label; reuse refuses any other, so its drops never touch someone else's databases.
const OWNER_LABEL_VALUE = 'dm2-product-weights';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261207100000_product_weights.sql');
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
const TOUCHED = /(product_parent|blend_ticket|job_loader_worksheet|unit_conversions|product_weight|product_size)/i;
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
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
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
  docker(['run', '-d', '--name', NAME, '--label', `crx.prover=${OWNER_LABEL_VALUE}`, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
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

// ---------------------------------------------------------------------------------------------
// Seed (invented rows shaped like live ones; nothing from live is in the repo)
// ---------------------------------------------------------------------------------------------

const id = (n) => `d2d20000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = id('a1'), ADMIN2 = id('a2'), REP = id('a3'), OFFADMIN = id('a4'), APPLA = id('a5'), DISP = id('a6'),
  APPLB = id('a7'), DRIVER = id('a8'), OFFDRIVER = id('a9');
const CUST = id('c1'), FIELD = id('c2');
// Parents: three liquids, one liquid to move into, one dry.
const P1 = id('b1'), P2 = id('b2'), P3 = id('b3'), P4 = id('b4'), PDRY = id('b5');
// Sizes.
const L1 = id('11'), L2 = id('12'), L3 = id('13'), L4 = id('14'), LX = id('15'), LMOVE = id('16');
const DLB = id('21'), DMG = id('22'), DEA = id('23'), DEA2 = id('24'), DTST = id('25'), DNOINV = id('26'), DEA3 = id('27'),
  SEED = id('28'), DEA4 = id('29');
const JA = id('31'), JB = id('32'), JFA = id('33'), JFB = id('34');
const WPRE = id('41');

const OWNER = 'owner';  // runs as the table owner, no app role (the private draft helpers are owner-only)
function txIn(uid, sql) {
  if (uid === OWNER) return `BEGIN;
${sql}
COMMIT;
`;
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  return `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n`;
}
function as(uid, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: txIn(uid, sql) });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
function js(uid, sql) { return JSON.parse(ok(uid, sql)); }
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(r.output, pattern);
}
function owner(sql) { return scalar(sql); }
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
let keyN = 0;
const key = () => `dm2-key-${++keyN}`;

// Writers (each with a fresh key unless one is given).
const dVer = (pid) => Number(owner(`SELECT COALESCE((SELECT density_version FROM public.product_parent_density_state WHERE parent_id = '${pid}'), 0);`));
const nVer = (sid) => Number(owner(`SELECT COALESCE((SELECT net_weight_version FROM public.product_size_net_weight_state WHERE product_id = '${sid}'), 0);`));
const setD = (pid, value, unit = 'lb_per_gal', source = 'sds', k = key(), ver = dVer(pid)) =>
  `SELECT public.set_parent_density('${pid}', ${ver}, ${value}, ${q(unit)}, ${q(source)}, NULL, ${q(k)});`;
const corrD = (pid, value, source, reason, evidence, k = key(), ver = dVer(pid)) =>
  `SELECT public.correct_parent_density('${pid}', ${ver}, ${value}, 'lb_per_gal', ${q(source)}, NULL, ${q(reason)}, ${q(evidence)}, ${q(k)});`;
const setN = (sid, value, source = 'label', k = key(), ver = nVer(sid)) =>
  `SELECT public.set_size_net_weight('${sid}', ${ver}, ${value}, ${q(source)}, NULL, ${q(k)});`;
const corrN = (sid, value, source, reason, evidence, k = key(), ver = nVer(sid)) =>
  `SELECT public.correct_size_net_weight('${sid}', ${ver}, ${value}, ${q(source)}, NULL, ${q(reason)}, ${q(evidence)}, ${q(k)});`;
// The private draft helpers, called as the table owner (DM-1b wraps them in its own admin RPC).
const draftD = (pid, value, source, reason = null, evidence = null, ver = dVer(pid), unit = 'lb_per_gal') =>
  `SELECT public._save_parent_density_draft('${pid}', ${ver}, ${value}, ${q(unit)}, ${q(source)}, NULL, ${q(reason)}, ${q(evidence)});`;
const draftN = (sid, value, source, reason = null, evidence = null, ver = nVer(sid)) =>
  `SELECT public._save_size_net_weight_draft('${sid}', ${ver}, ${value}, ${q(source)}, NULL, ${q(reason)}, ${q(evidence)});`;
const draftId = (table, col, sid) => owner(`SELECT id FROM public.${table} WHERE ${col} = '${sid}' AND review_state = 'draft';`);
const dDraft = (pid) => draftId('product_parent_density_values', 'parent_id', pid);
const nDraft = (sid) => draftId('product_size_net_weight_values', 'product_id', sid);
const approveSql = (items, k = key()) => `SELECT public.approve_weights(${J(items)}, ${q(k)});`;
const dItem = (pid) => ({ kind: 'density', subject_id: pid, draft_id: dDraft(pid), expected_version: dVer(pid) });
const nItem = (sid) => ({ kind: 'net_weight', subject_id: sid, draft_id: nDraft(sid), expected_version: nVer(sid) });
// What the reader says about one size.
const weight = (sid, uid = REP) => js(uid, `SELECT public.get_product_weights(ARRAY['${sid}']::uuid[])->'products'->'${sid}'->'weight';`);
const events = (col, sid) => Number(owner(`SELECT count(*) FROM public.product_weight_events WHERE ${col} = '${sid}';`));

function seedBeforeCandidate() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'dm2-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${ADMIN2}', 'dm2-admin2@example.invalid', '{"full_name":"[PROVER] Admin Two","role":"admin"}'::jsonb),
    ('${REP}', 'dm2-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('${OFFADMIN}', 'dm2-offadmin@example.invalid', '{"full_name":"[PROVER] Off Admin","role":"admin"}'::jsonb),
    ('${APPLA}', 'dm2-appla@example.invalid', '{"full_name":"[PROVER] Applicator A","role":"applicator"}'::jsonb),
    ('${DISP}', 'dm2-disp@example.invalid', '{"full_name":"[PROVER] Dispatchee","role":"driver"}'::jsonb),
    ('${APPLB}', 'dm2-applb@example.invalid', '{"full_name":"[PROVER] Applicator B","role":"applicator"}'::jsonb),
    ('${DRIVER}', 'dm2-driver@example.invalid', '{"full_name":"[PROVER] Driver","role":"driver"}'::jsonb),
    ('${OFFDRIVER}', 'dm2-offdriver@example.invalid', '{"full_name":"[PROVER] Off Driver","role":"driver"}'::jsonb);`);
  const prod = (pid, name, form, inv, cs = null, cu = null, ct = null, us = null) =>
    `('${pid}', '[PROVER] ${name}', 'DM2-${name}', '${form}', ${q(inv)}, 'Herbicide', 10.00, 15.00, true, ${cs === null ? 'NULL' : cs}, ${q(cu)}, ${q(ct)}, ${q(us)})`;
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id IN ('${ADMIN}', '${ADMIN2}');
    UPDATE public.profiles SET role = 'admin', is_active = false WHERE id = '${OFFADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'applicator', is_active = true WHERE id IN ('${APPLA}', '${APPLB}');
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id IN ('${DISP}', '${DRIVER}');
    UPDATE public.profiles SET role = 'driver', is_active = false WHERE id = '${OFFDRIVER}';
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type)
    SELECT v.u, v.f, v.t FROM (VALUES ('Gal', 128::numeric, 'liquid'), ('Qt', 32, 'liquid'), ('qt', 32, 'liquid'),
      ('Lb', 16, 'dry'), ('LB', 16, 'dry'), ('oz', 1, 'dry'), ('Oz', 1, 'dry'), ('MG', 0.00003527396, 'dry'),
      ('g', 0.03527396, 'dry'), ('Tst', 1, 'dry'), ('tst', 2, 'dry'), ('Sam', 16, 'dry'), ('sam', 16, 'liquid')) v(u, f, t)
     WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions c WHERE c.unit = v.u);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, current_cost, tier1_price, is_active,
      container_size, container_unit, container_type, unit_size) VALUES
      ${prod(L1, 'L1', 'liquid', 'Gal', 2.5, 'Gal', 'Jug')}, ${prod(L2, 'L2', 'liquid', 'Gal', 2.5, 'Gal', 'Jug')},
      ${prod(L3, 'L3', 'liquid', 'Gal', 2.5, 'Gal', 'Jug')}, ${prod(L4, 'L4', 'liquid', 'Gal', 2.5, 'Gal', 'Jug')},
      ${prod(LX, 'LX', 'liquid', 'Gal')}, ${prod(LMOVE, 'LMOVE', 'liquid', 'Gal', 2.5, 'Gal', 'Jug')},
      ${prod(DLB, 'DLB', 'dry', 'Lb', 50, 'Lb', 'Bag')}, ${prod(DMG, 'DMG', 'dry', 'MG')},
      ${prod(DEA, 'DEA', 'dry', 'Ea', 2.5, 'Lb', 'Bag', '2')}, ${prod(DEA2, 'DEA2', 'dry', 'Ea', 5, null, 'Bag')},
      ${prod(DTST, 'DTST', 'dry', 'Tst')}, ${prod(DNOINV, 'DNOINV', 'dry', null, 10, 'Lb', 'Bag')},
      ${prod(DEA3, 'DEA3', 'dry', 'Ea', 5, 'Lb', 'Bag')}, ${prod(SEED, 'SEED', 'seed', 'Ea')},
      ${prod(DEA4, 'DEA4', 'dry', 'Ea', 5, 'Lb', 'Bag')};
    INSERT INTO public.product_parents (id, name, product_form, formulation_type, safener, category, created_by, updated_by) VALUES
      ('${P1}', '[PROVER] P1', 'liquid', 'EC', NULL, 'Herbicide', '${ADMIN}', '${ADMIN}'),
      ('${P2}', '[PROVER] P2', 'liquid', 'SC', NULL, 'Herbicide', '${ADMIN}', '${ADMIN}'),
      ('${P3}', '[PROVER] P3', 'liquid', 'SL', NULL, 'Herbicide', '${ADMIN}', '${ADMIN}'),
      ('${P4}', '[PROVER] P4', 'liquid', 'EC', NULL, 'Herbicide', '${ADMIN}', '${ADMIN}'),
      ('${PDRY}', '[PROVER] PDRY', 'dry', 'WG', NULL, 'Herbicide', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_members (product_id, parent_id, added_by) VALUES
      ('${L1}', '${P1}', '${ADMIN}'), ('${L2}', '${P2}', '${ADMIN}'), ('${L3}', '${P3}', '${ADMIN}'), ('${L4}', '${P4}', '${ADMIN}'),
      ('${LMOVE}', '${P1}', '${ADMIN}'), ('${DEA}', '${PDRY}', '${ADMIN}'), ('${DLB}', '${PDRY}', '${ADMIN}');
    INSERT INTO public.customers (id, farm_name) VALUES ('${CUST}', '[PROVER] Farm');
    INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${FIELD}', '${CUST}', '[PROVER] Field', 100);
    INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, created_by, applicator_id) VALUES
      ('${JA}', 'DM2-A', '${CUST}', 'scheduled', current_date, '${ADMIN}', '${APPLA}'),
      ('${JB}', 'DM2-B', '${CUST}', 'scheduled', current_date, '${ADMIN}', '${APPLB}');
    INSERT INTO public.job_fields (id, job_id, field_id, acres_to_treat, sort_order) VALUES
      ('${JFA}', '${JA}', '${FIELD}', 40, 0), ('${JFB}', '${JB}', '${FIELD}', 25, 0);
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, customer_supplied, sort_order) VALUES
      ('${JA}', '${L1}', 10, 'Gal', 0, true, 0), ('${JA}', '${DEA}', 4, 'Ea', 0, true, 1),
      ('${JA}', '${DLB}', 50, 'Lb', 0, true, 2), ('${JA}', '${L2}', 3, 'Qt', 0, true, 3),
      ('${JB}', '${L3}', 5, 'Gal', 0, true, 0);
    INSERT INTO public.job_location_dispatches (job_field_id, job_id, applicator_id, dispatch_status)
      VALUES ('${JFA}', '${JA}', '${DISP}', 'dispatched');
    INSERT INTO public.job_loader_worksheets (id, job_id, capacity_gal, is_selected, created_by)
      VALUES ('${WPRE}', '${JA}', 300, true, '${ADMIN}');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  console.log('[prover] seeded nine users (admins, rep, inactive admin, applicators, dispatchee, drivers), units, five parents, fifteen sizes, two jobs and a worksheet saved before the migration');
}

// Unit-factor change used by the factor cases (owner SQL; the app treats unit factors as fixed setup).
const setFactor = (unit, f) => psql(`UPDATE public.unit_conversions SET factor_oz = ${f} WHERE lower(unit) = lower('${unit}');`);

// A ticket through the real RPC, as the rep.
let ticketN = 0;
function createTicket(lines, header = {}) {
  const tid = id(`7${String(++ticketN).padStart(3, '0')}`);
  ok(REP, `SELECT public.create_blend_ticket('${tid}', ${J({ customer_id: CUST, ticket_date: '2026-11-07', ...header })},
    ${J(lines)}, '[]'::jsonb, false, auth.uid(), ${q(key())});`);
  return tid;
}
const ticketW = (tid) => js(ADMIN, `SELECT public.get_blend_ticket_weights('${tid}');`);
const snap = (tid, pid) => owner(`SELECT weight_kind || ':' || COALESCE(trim_scale(lb_per_unit)::text, none_reason) FROM public.blend_ticket_product_weights
  WHERE blend_ticket_id = '${tid}' AND product_id = '${pid}';`);
const ticketLines = (tid) => JSON.parse(owner(`SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'product_id', product_id,
  'product_name', product_name, 'quantity', quantity, 'unit', unit) ORDER BY sequence_order), '[]') FROM public.blend_ticket_products
  WHERE blend_ticket_id = '${tid}';`));
const ticketVer = (tid) => owner(`SELECT updated_at FROM public.blend_tickets WHERE id = '${tid}';`);
const saveTicket = (tid, lines, header = {}) => ok(REP, `SELECT public.save_blend_ticket('${tid}',
  ${J({ _expected_updated_at: ticketVer(tid), ...header })}, ${J(lines)}, auth.uid(), ${q(key())});`);
const wsRow = (ws, pid) => owner(`SELECT weight_kind || ':' || COALESCE(trim_scale(lb_per_unit)::text, none_reason) FROM public.job_loader_worksheet_weights
  WHERE worksheet_id = '${ws}' AND product_id = '${pid}';`);
const wsValid = (ws, pid) => owner(`SELECT public.worksheet_weight_is_valid(s) FROM public.job_loader_worksheet_weights s
  WHERE worksheet_id = '${ws}' AND product_id = '${pid}';`);
const wsGet = (ws, uid = ADMIN) => js(uid, `SELECT public.get_loader_worksheet_weights(ARRAY['${ws}']::uuid[], NULL)->'worksheets'->0->'weights';`);
const touchWs = (ws, uid = REP) => ok(uid, `UPDATE public.job_loader_worksheets SET loads_done = loads_done WHERE id = '${ws}' RETURNING id;`);

async function main() {
  if (REUSE) {
    const label = docker(['inspect', '--format', '{{index .Config.Labels "crx.prover"}}', NAME]).stdout.trim();
    if (label !== OWNER_LABEL_VALUE) throw new Error(`CRX_DM2_CONTAINER=${NAME} was not created by this proof (label crx.prover='${label}'); refusing to drop its databases.`);
    DB = 'template1';
    psql('DROP DATABASE IF EXISTS dm2work WITH (FORCE);', { user: 'supabase_admin' });
    psql('CREATE DATABASE dm2work TEMPLATE dm2base OWNER postgres;', { user: 'supabase_admin' });
    DB = 'dm2work';
  } else {
    buildContainer();
    if (KEEP) {
      // A copy of the replayed, unseeded database, so CRX_DM2_CONTAINER reruns skip the replay.
      DB = 'template1';
      psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres';", { user: 'supabase_admin' });
      psql('CREATE DATABASE dm2base TEMPLATE postgres OWNER postgres;', { user: 'supabase_admin' });
      DB = 'postgres';
      console.log(`[prover] kept container ${NAME} with a replayed copy dm2base (rerun with CRX_DM2_CONTAINER=${NAME})`);
    }
  }
  seedBeforeCandidate();
  stageText('cand.sql', lf(CANDIDATE));

  // ---- Preflight: refused while any ticket exists (header only, or header and line); writes nothing.
  ok(REP, `SELECT public.create_blend_ticket('${id('6001')}', ${J({ customer_id: CUST })}, '[]'::jsonb, '[]'::jsonb, false, auth.uid(), 'dm2-pre-1');`);
  let r = apply('cand.sql');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /PREFLIGHT_DM2_BLEND_TICKETS_EXIST/);
  assert.equal(owner("SELECT to_regclass('public.product_parent_density_values') IS NULL;"), 't', 'a refused apply leaves no object');
  ok(REP, `INSERT INTO public.blend_ticket_products (blend_ticket_id, product_name, quantity, unit) VALUES ('${id('6001')}', 'x', 1, 'Gal');`);
  r = apply('cand.sql');
  assert.match(r.output, /PREFLIGHT_DM2_BLEND_TICKETS_EXIST/);
  psql(`DELETE FROM public.blend_ticket_products; DELETE FROM public.blend_tickets;`);
  // An owner-SQL header and line committed while the apply waits on the lock make its preflight refuse.
  let bg = session(`BEGIN; INSERT INTO public.blend_tickets (id, ticket_number, status, review_status, source, uploaded_by)
      VALUES ('${id('6002')}', 'DM2-RACE', 'completed', 'unreviewed', 'manual', '${REP}');
    INSERT INTO public.blend_ticket_products (blend_ticket_id, product_name, quantity, unit) VALUES ('${id('6002')}', 'x', 1, 'Gal');
    SELECT 'JK_READY'; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  r = await waited(bg, () => apply('cand.sql'), 'the apply behind an open owner ticket');
  assert.match(r.output, /PREFLIGHT_DM2_BLEND_TICKETS_EXIST/);
  assert.equal(owner("SELECT to_regclass('public.blend_ticket_product_weights') IS NULL;"), 't');
  psql(`DELETE FROM public.blend_ticket_products; DELETE FROM public.blend_tickets;`);
  console.log('[prover] preflight: a header alone, a header with a line, and an owner ticket committed while the apply waited each refuse it, leaving nothing');

  // ---- The real apply, held open: a ticket creation started meanwhile waits for it, then gets its snapshot rows.
  bg = session(`BEGIN;\n${lf(CANDIDATE)}\nSELECT 'JK_READY';\n${HOLD_UNTIL_WAITER}\nCOMMIT;`);
  await bg.ready;
  const raceTicket = id('6003');
  await waited(bg, () => ok(REP, `SELECT public.create_blend_ticket('${raceTicket}', ${J({ customer_id: CUST, total_volume: 10, total_volume_unit: 'Gal' })},
    ${J([{ product_id: L1, product_name: 'L1', quantity: 1, unit: 'Gal' }])}, '[]'::jsonb, false, auth.uid(), 'dm2-race-create');`), 'a ticket creation during the apply');
  assert.equal(snap(raceTicket, L1), 'none:no_approved_weight', 'a ticket created behind the apply gets its snapshot row');
  assert.equal(owner(`SELECT count(*) FROM public.blend_ticket_weight_basis WHERE blend_ticket_id = '${raceTicket}';`), '1');
  ledger(path.basename(CANDIDATE, '.sql'));
  r = apply('cand.sql');
  assert.match(r.output, /PREFLIGHT_DM2_ALREADY_PRESENT|PREFLIGHT_DM2_BLEND_TICKETS_EXIST/, 'a second apply is refused');
  console.log('[prover] the apply took its locks first; a ticket created meanwhile waited and then got its snapshot and basis rows');

  // ---- Pre-existing worksheet: no rows after apply; the getter shows current weights only; its first update captures.
  assert.equal(owner(`SELECT count(*) FROM public.job_loader_worksheet_weights WHERE worksheet_id = '${WPRE}';`), '0');
  let w = wsGet(WPRE);
  assert.equal(w[L1].saved, null);
  assert.equal(w[L1].current.kind, 'none');

  // ---- Catalogue: grants, modes, owners (read back again here, beside the migration's own postflight).
  const fns = owner(`SELECT string_agg(p.proname || ':' || p.prosecdef || ':' || pg_get_userbyid(p.proowner) || ':' || array_to_string(p.proconfig, ';')
      || ':' || COALESCE((SELECT string_agg(a.grantee::regrole::text, ',' ORDER BY a.grantee::regrole::text) FROM aclexplode(p.proacl) a
         WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner), '-'), '|' ORDER BY p.proname)
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('_weight_unit_factors', '_product_weight',
      '_product_weight_trust_rank', '_product_weight_event', '_write_parent_density', '_write_size_net_weight', '_approve_weight_item_ok',
      '_approved_parent_lb_per_gal', 'get_product_weights', 'get_blend_ticket_weights', 'get_loader_worksheet_weights', 'worksheet_weight_is_valid',
      'set_parent_density', 'set_size_net_weight', 'correct_parent_density', 'correct_size_net_weight', 'approve_weights',
      '_save_parent_density_draft', '_save_size_net_weight_draft', 'capture_blend_ticket_product_weight', 'capture_blend_ticket_weight_basis',
      'delete_blend_ticket_weights', 'capture_loader_worksheet_weights', 'return_net_weight_to_draft', 'return_density_to_draft',
      'bump_member_generation', 'refuse_product_weight_event_mutation');`);
  const fnRows = fns.split('|');
  assert.equal(fnRows.length, 27, fns);
  const PUBLIC_RPCS = new Set(['get_product_weights', 'get_blend_ticket_weights', 'get_loader_worksheet_weights', 'worksheet_weight_is_valid',
    'set_parent_density', 'set_size_net_weight', 'correct_parent_density', 'correct_size_net_weight', 'approve_weights']);
  const INVOKER = new Set(['get_blend_ticket_weights', 'get_loader_worksheet_weights', 'worksheet_weight_is_valid', '_product_weight_trust_rank',
    '_approve_weight_item_ok', 'refuse_product_weight_event_mutation']);
  for (const row of fnRows) {
    const [name, secdef, own, config, grants] = row.split(':');
    assert.equal(own, 'postgres', row);
    assert.equal(config, 'search_path=public, pg_temp', row);
    assert.equal(secdef, INVOKER.has(name) ? 'false' : 'true', row);
    assert.equal(grants, PUBLIC_RPCS.has(name) ? 'authenticated' : '-', row);
  }
  for (const role of ['anon', 'service_role', 'metabase_ro']) {
    assert.equal(owner(`SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${fnRows.map((x) => q(x.split(':')[0])).join(',')})
      AND has_function_privilege('${role}', p.oid, 'EXECUTE');`), '0', `${role} can execute a DM-2 function`);
  }
  const TABLES = ['product_parent_density_values', 'product_size_net_weight_values', 'product_parent_density_state', 'product_size_net_weight_state',
    'product_weight_events', 'blend_ticket_product_weights', 'blend_ticket_weight_basis', 'job_loader_worksheet_weights'];
  for (const t of TABLES) {
    for (const role of ['anon', 'authenticated', 'service_role', 'metabase_ro']) {
      for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', ...(role === 'authenticated' ? [] : ['SELECT'])]) {
        assert.equal(owner(`SELECT has_table_privilege('${role}', 'public.${t}', '${priv}');`), 'f', `${role} ${priv} ${t}`);
      }
    }
    assert.equal(owner(`SELECT count(*) FROM pg_class, aclexplode(relacl) a WHERE oid = 'public.${t}'::regclass AND a.grantee = 0;`), '0');
    refused(ADMIN, `DELETE FROM public.${t};`, /permission denied/);
  }
  assert.equal(owner(`SELECT count(*) FROM pg_class, aclexplode(relacl) a WHERE oid = 'public.product_weight_events_id_seq'::regclass AND a.grantee <> relowner;`), '0');
  refused(ADMIN, `INSERT INTO public.blend_ticket_product_weights (blend_ticket_id, product_id, product_name, weight_kind, unit_factors, none_reason)
    VALUES ('${raceTicket}', '${L2}', 'x', 'none', '{}', 'unknown_form');`, /permission denied/);
  for (const helper of ['public._product_weight(NULL::uuid, NULL)', 'public._weight_unit_factors()', `public._save_parent_density_draft('${P1}', 0, 9, 'lb_per_gal', 'sds', NULL, NULL, NULL)`,
    'public._approved_parent_lb_per_gal(NULL)']) {
    refused(ADMIN, `SELECT ${helper};`, /permission denied/);
  }
  console.log('[prover] 27 functions: owner postgres, search_path pinned, security mode as designed; only the 9 public RPCs granted, to authenticated only; no app role writes any table or reads one but authenticated; the events sequence has no grant');

  // ---- Bad input, every writer: refused by name, nothing written.
  const before = owner('SELECT count(*) FROM public.product_weight_events;');
  for (const [v, pat] of [['0', /OUT_OF_RANGE/], ['-1', /OUT_OF_RANGE/], ["'NaN'", /BAD_VALUE/], ["'Infinity'", /BAD_VALUE/], ['20.00005', /OUT_OF_RANGE/],
    ['0.00004', /OUT_OF_RANGE/]]) {
    refused(ADMIN, setD(P1, v), pat);
    refused(ADMIN, corrD(P1, v, 'measured', 'r', 'e'), pat);
    refused(OWNER, draftD(P1, v, 'sds'), pat);
  }
  for (const [v, pat] of [['0', /OUT_OF_RANGE/], ['-5', /OUT_OF_RANGE/], ["'NaN'", /BAD_VALUE/], ["'-Infinity'", /BAD_VALUE/], ['4000.00005', /OUT_OF_RANGE/]]) {
    refused(ADMIN, setN(DEA, v), pat);
    refused(ADMIN, corrN(DEA, v, 'measured', 'r', 'e'), pat);
    refused(OWNER, draftN(DEA, v, 'label'), pat);
  }
  refused(ADMIN, setD(P1, 9, 'kg_per_l'), /BAD_UNIT/);
  refused(ADMIN, setD(P1, 9, 'lb_per_gal', 'guess'), /BAD_SOURCE/);
  refused(ADMIN, setN(DEA, 5, 'guess'), /BAD_SOURCE/);
  refused(ADMIN, setD(P1, 9, 'lb_per_gal', null), /BAD_SOURCE/);
  psql('SELECT 1;');
  assert.equal(owner('SELECT count(*) FROM public.product_weight_events;'), before, 'bad input wrote nothing');
  assert.equal(owner('SELECT count(*) FROM public.product_parent_density_values;'), '0');
  console.log('[prover] zero, negative, NaN, Infinity, over-limit and rounds-to-zero values, an unknown unit and an unknown source are refused by name on every writer; nothing written');

  // ---- Hand-checked weights.
  ok(ADMIN, setD(P1, 1.15, 'specific_gravity'));
  assert.equal(weight(L1).lb_per_unit, 9.5972, 'SG 1.15 x 8.345404 = 9.59721..., stored as 9.5972');
  let w1 = weight(L1);
  assert.equal(w1.kind, 'density'); assert.equal(w1.reviewed_by, ADMIN); assert.ok(w1.reviewed_at);
  ok(ADMIN, setD(P2, 10.1234, 'lb_per_gal', 'measured'));
  assert.equal(weight(L2).lb_per_unit, 10.1234, '4 decimals round-trip');
  ok(ADMIN, setD(P3, 8.12345, 'lb_per_gal', 'measured'));
  assert.equal(weight(L3).lb_per_unit, 8.1235, 'a fifth decimal rounds half-up');
  ok(ADMIN, setD(P4, 20, 'lb_per_gal', 'measured'));
  assert.equal(weight(L4).lb_per_unit, 20, 'the 20 lb/gal limit saves');
  ok(ADMIN, setN(DEA, 5, 'label'));
  assert.equal(weight(DEA).lb_per_unit, 5, 'a 2 x 2.5-lb pack stocked in Ea weighs 5 lb per Ea');
  ok(ADMIN, setN(DEA3, '4000.00004', 'measured'));
  assert.equal(weight(DEA3).lb_per_unit, 4000, '4000.00004 saves as 4000.0000');
  assert.equal(owner(`SELECT net_lb::text FROM public.product_size_net_weight_values WHERE product_id = '${DEA3}' AND review_state = 'approved';`), '4000.0000');
  refused(ADMIN, setN(DEA4, '4000.00005', 'measured'), /OUT_OF_RANGE/);
  ok(ADMIN, setN(DEA4, 4000, 'measured'));
  assert.deepEqual(weight(DLB), { kind: 'unit_weight', product_form: 'dry', lb_per_unit: 1, per_unit: 'Lb', source: 'unit' }, 'a bag stocked in Lb: 1 lb per Lb, no stored row');
  assert.equal(owner(`SELECT count(*) FROM public.product_size_net_weight_values WHERE product_id = '${DLB}';`), '0');
  assert.equal(weight(DMG).lb_per_unit, 0.0000022046225, 'MG: 0.0000022046225 lb per MG');
  refused(ADMIN, setN(DLB, 50), /PRODUCT_WEIGHT_FROM_UNIT/);
  refused(ADMIN, setN(L1, 50), /PRODUCT_WEIGHT_NOT_DRY/);
  refused(ADMIN, setN(SEED, 50), /PRODUCT_WEIGHT_NOT_DRY/);
  refused(ADMIN, setD(PDRY, 9), /PRODUCT_WEIGHT_NOT_LIQUID/);
  assert.deepEqual(weight(LX), { kind: 'none', none_reason: 'no_parent', product_form: 'liquid', member_generation: 0 });
  assert.equal(weight(SEED).none_reason, 'seed_or_each');
  // One blend: three liquids and one dry product against a pound total, by hand:
  //   L1 10 Gal x 9.5972 = 95.972; L2 2 Gal x 10.1234 = 20.2468; L3 4 Qt = 1 Gal x 8.1235 = 8.1235; DEA 3 Ea x 5 = 15
  //   total 139.3423 lb.
  const blend = createTicket([{ product_id: L1, product_name: 'L1', quantity: 10, unit: 'Gal' },
    { product_id: L2, product_name: 'L2', quantity: 2, unit: 'Gal' }, { product_id: L3, product_name: 'L3', quantity: 4, unit: 'Qt' },
    { product_id: DEA, product_name: 'DEA', quantity: 3, unit: 'Ea' }], { total_volume: 139.3423, total_volume_unit: 'Lb' });
  const bw = ticketW(blend);
  const f = bw.basis_unit_factors.factors;
  let total = 0;
  for (const l of bw.lines) {
    const u = f[l.line.unit.toLowerCase()];
    const per = l.weight.lb_per_unit;
    // a volume line converts to gallons first; a count line multiplies by the per-unit pounds
    const lb = u.kind === 'volume' ? l.line.quantity * u.factor * per : l.line.quantity * per;
    total += lb;
  }
  assert.equal(Math.round(total * 10000) / 10000, 139.3423, 'the line weights add to the hand total');
  assert.equal(f.qt.factor, 0.25);
  assert.equal(bw.ticket.total_volume, 139.3423);
  console.log('[prover] hand-checked: SG 1.15 -> 9.5972; 4-decimal round trip; fifth decimal half-up; limits save; 4000.00004 -> 4000.0000, 4000.00005 refused; Lb bag 1 lb/Lb with no row; MG exact; Ea pack 5 lb; a 3-liquid + 1-dry blend sums to the hand total 139.3423 lb');

  // ---- Typed values and the review gate.
  refused(OWNER, draftD(P1, 9.4, 'sds', null, null, dVer(P1) - 1), /PRODUCT_WEIGHT_STALE/);
  const p2DraftVer = dVer(P2);
  psql(draftD(P2, 10.2, 'measured'));
  assert.equal(weight(L2).lb_per_unit, 10.1234, 'a draft is never read');
  const firstDraft = dDraft(P2);
  psql(draftD(P2, 10.3, 'measured'));
  assert.notEqual(dDraft(P2), firstDraft, 'a second draft replaces the first');
  assert.equal(owner(`SELECT review_state FROM public.product_parent_density_values WHERE id = '${firstDraft}';`), 'superseded');
  assert.equal(dVer(P2), p2DraftVer + 2);
  // A draft beside no approved row reads none.
  const PNEW = P4; // reuse P4 after correcting it away? use a fresh parent instead:
  void PNEW;
  psql(`SET session_replication_role = replica;
    INSERT INTO public.product_parents (id, name, product_form, category, created_by, updated_by) VALUES ('${id('b6')}', '[PROVER] P6', 'liquid', 'Herbicide', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, current_cost, tier1_price, is_active) VALUES
      ('${id('17')}', '[PROVER] L6', 'DM2-L6', 'liquid', 'Gal', 'Herbicide', 1, 1, true);
    SET session_replication_role = origin;
    INSERT INTO public.product_parent_members (product_id, parent_id, added_by) VALUES ('${id('17')}', '${id('b6')}', '${ADMIN}');`, { user: 'supabase_admin' });
  const P6 = id('b6'), L6 = id('17');
  psql(draftD(P6, 9.9, 'label'));
  assert.equal(weight(L6).none_reason, 'no_approved_weight');
  // Stale batch: a valid item placed before a stale one; the whole batch is refused and the valid one stays a draft.
  const goodItem = dItem(P6);
  refused(ADMIN, approveSql([goodItem, { ...dItem(P2), expected_version: dVer(P2) - 1 }]), /PRODUCT_WEIGHT_STALE/);
  refused(ADMIN, approveSql([goodItem, { ...dItem(P2), draft_id: firstDraft }]), /PRODUCT_WEIGHT_STALE/);
  assert.equal(weight(L6).kind, 'none', 'the valid item before the failing one stays unapproved');
  // Duplicates and shape.
  const evBefore = owner('SELECT count(*) FROM public.product_weight_events;');
  refused(ADMIN, approveSql([goodItem, goodItem]), /PRODUCT_WEIGHT_DUPLICATE_ITEM/);
  assert.equal(owner('SELECT count(*) FROM public.product_weight_events;'), evBefore);
  refused(ADMIN, approveSql([goodItem, { ...goodItem, extra: 1 }]), /BAD_REQUEST: item 2/);
  refused(ADMIN, approveSql([{ ...goodItem, expected_version: 1.5 }]), /BAD_REQUEST: item 1/);
  refused(ADMIN, approveSql([{ ...goodItem, expected_version: '1' }]), /BAD_REQUEST: item 1/);
  refused(ADMIN, approveSql([{ ...goodItem, expected_version: 1e30 }]), /BAD_REQUEST: item 1/);
  refused(ADMIN, approveSql([]), /BAD_REQUEST/);
  ok(ADMIN, approveSql([goodItem, dItem(P2)]));
  assert.equal(weight(L6).lb_per_unit, 9.9, 'after approval it reads the value');
  assert.equal(weight(L6).reviewed_by, ADMIN);
  assert.equal(weight(L2).lb_per_unit, 10.3);
  // Trust re-check: a label draft beside an approved supplier value; the owner swaps the approved row for a measured
  // one without touching the draft; approval of the label draft without reason and evidence is refused.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.product_parents (id, name, product_form, category, created_by, updated_by) VALUES ('${id('b7')}', '[PROVER] P7', 'liquid', 'Herbicide', '${ADMIN}', '${ADMIN}');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  const P7 = id('b7');
  ok(ADMIN, setD(P7, 9, 'lb_per_gal', 'supplier'));
  psql(draftD(P7, 9.2, 'label'));
  psql(`UPDATE public.product_parent_density_values SET source = 'measured' WHERE parent_id = '${P7}' AND review_state = 'approved';`);
  refused(ADMIN, approveSql([dItem(P7)]), /PRODUCT_WEIGHT_LOWER_TRUST/);
  psql(`UPDATE public.product_parent_density_values SET source = 'label' WHERE parent_id = '${P7}' AND review_state = 'approved';`);
  ok(ADMIN, approveSql([dItem(P7)]));
  console.log('[prover] review gate: drafts never read; a second draft replaces the first; a stale or replaced item refuses the whole batch and the valid one before it stays a draft; duplicates and bad shapes refused naming the item; trust re-checked at approval');

  // ---- Trust order, both subjects.
  refused(ADMIN, setD(P1, 9.0, 'lb_per_gal', 'supplier'), /PRODUCT_WEIGHT_LOWER_TRUST/);
  refused(ADMIN, corrD(P1, 9.0, 'supplier', null, 'sheet'), /REASON_REQUIRED/);
  refused(ADMIN, corrD(P1, 9.0, 'supplier', 'typo', null), /EVIDENCE_REQUIRED/);
  ok(ADMIN, corrD(P1, 9.0, 'supplier', 'label misprint', 'supplier letter 11-07'));
  assert.equal(weight(L1).lb_per_unit, 9);
  assert.equal(owner(`SELECT reason FROM public.product_weight_events WHERE parent_id = '${P1}' AND event_type = 'corrected';`), 'label misprint');
  ok(ADMIN, setD(P1, 9.5972, 'lb_per_gal', 'measured'));
  refused(OWNER, draftD(P1, 8.9, 'supplier', 'r', null), /EVIDENCE_REQUIRED/);
  refused(OWNER, draftD(P1, 8.9, 'supplier', null, 'e'), /REASON_REQUIRED/);
  ok(ADMIN, setN(DEA2, 5, 'sds'));
  refused(ADMIN, setN(DEA2, 5.1, 'supplier'), /PRODUCT_WEIGHT_LOWER_TRUST/);
  refused(ADMIN, corrN(DEA2, 5.1, 'supplier', null, 'e'), /REASON_REQUIRED/);
  refused(ADMIN, corrN(DEA2, 5.1, 'supplier', 'r', null), /EVIDENCE_REQUIRED/);
  refused(OWNER, draftN(DEA2, 5.1, 'supplier', 'r', null), /EVIDENCE_REQUIRED/);
  refused(OWNER, draftN(DEA2, 5.1, 'supplier', null, 'e'), /REASON_REQUIRED/);
  ok(ADMIN, corrN(DEA2, 5.1, 'supplier', 'r', 'e'));
  ok(ADMIN, setN(DEA2, 5, 'measured'));
  assert.equal(weight(DEA2).lb_per_unit, 5);
  console.log('[prover] trust order: a lower-trust set refused; a correction needs both reason and evidence (reason logged); a lower-trust draft too; measured always saves; both subjects');

  // ---- Stale writes, every writer.
  for (const [sql, label] of [[setD(P1, 9.1, 'lb_per_gal', 'measured', key(), dVer(P1) - 1), 'set density'],
    [corrD(P1, 9.1, 'measured', 'r', 'e', key(), dVer(P1) - 1), 'correct density'],
    [setN(DEA2, 5, 'measured', key(), nVer(DEA2) - 1), 'set net'], [corrN(DEA2, 5, 'measured', 'r', 'e', key(), nVer(DEA2) - 1), 'correct net']]) {
    refused(ADMIN, sql, /PRODUCT_WEIGHT_STALE/);
    void label;
  }
  refused(OWNER, draftN(DEA2, 5, 'measured', null, null, nVer(DEA2) - 1), /PRODUCT_WEIGHT_STALE/);
  psql(draftN(DEA2, 5.2, 'measured'));
  const keepDraft = nDraft(DEA2);
  refused(ADMIN, setN(DEA2, 5.3, 'measured', key(), nVer(DEA2) - 1), /PRODUCT_WEIGHT_STALE/);
  assert.equal(nDraft(DEA2), keepDraft, 'a refused stale write leaves the current draft');
  refused(ADMIN, approveSql([{ ...nItem(DEA2), expected_version: nVer(DEA2) - 1 }]), /PRODUCT_WEIGHT_STALE/);
  console.log('[prover] every writer (both setters, both correctors, both draft helpers, approve_weights) refuses an older version with PRODUCT_WEIGHT_STALE and writes nothing');

  // ---- Every watched field returns a net weight to draft; the pack edit is recorded.
  const packCase = (sid, setSql) => {
    ok(ADMIN, setN(sid, 5, 'measured'));
    const v0 = nVer(sid), g0 = Number(owner(`SELECT pack_generation FROM public.product_size_net_weight_state WHERE product_id = '${sid}';`));
    psql(setSql);
    assert.equal(weight(sid).none_reason, 'no_approved_weight', `${setSql} left an approved row`);
    assert.equal(owner(`SELECT review_state FROM public.product_size_net_weight_values WHERE product_id = '${sid}' AND review_state <> 'superseded';`), 'draft');
    assert.equal(nVer(sid), v0 + 1);
    assert.equal(Number(owner(`SELECT pack_generation FROM public.product_size_net_weight_state WHERE product_id = '${sid}';`)), g0 + 1);
    assert.equal(owner(`SELECT event_type || ':' || actor_kind FROM public.product_weight_events WHERE product_id = '${sid}' ORDER BY id DESC LIMIT 1;`), 'returned_to_draft:system');
  };
  packCase(DEA4, `UPDATE public.products SET container_size = 6 WHERE id = '${DEA4}';`);
  packCase(DEA4, `UPDATE public.products SET container_type = 'Jar' WHERE id = '${DEA4}';`);
  packCase(DEA4, `UPDATE public.products SET unit_size = '3' WHERE id = '${DEA4}';`);
  ok(ADMIN, setN(DEA2, 5, 'measured'));
  packCase(DEA2, `UPDATE public.products SET container_unit = 'Lb' WHERE id = '${DEA2}';`);
  // No change, no effect.
  ok(ADMIN, setN(DEA4, 5, 'measured'));
  const v4 = nVer(DEA4);
  psql(`UPDATE public.products SET container_size = container_size, product_name = product_name || '' WHERE id = '${DEA4}';`);
  assert.equal(nVer(DEA4), v4); assert.equal(weight(DEA4).kind, 'net_weight');
  // Filling a blank inventory unit: version and pack generation move, no value row change.
  psql(`UPDATE public.products SET inventory_unit = 'Ea' WHERE id = '${DNOINV}';`);
  assert.equal(owner(`SELECT net_weight_version || ':' || pack_generation FROM public.product_size_net_weight_state WHERE product_id = '${DNOINV}';`), '1:1');
  assert.equal(events('product_id', DNOINV), 0);
  // With a signed-in admin the actor is the user.
  ok(ADMIN, `UPDATE public.products SET container_size = 7 WHERE id = '${DEA4}' RETURNING id;`);
  assert.equal(owner(`SELECT actor_kind || ':' || changed_by FROM public.product_weight_events WHERE product_id = '${DEA4}' ORDER BY id DESC LIMIT 1;`), `user:${ADMIN}`);
  // A size with only a draft: the draft is superseded.
  psql(draftN(DEA4, 7, 'measured'));
  const onlyDraft = nDraft(DEA4);
  psql(`UPDATE public.products SET container_size = 8 WHERE id = '${DEA4}';`);
  assert.equal(owner(`SELECT review_state FROM public.product_size_net_weight_values WHERE id = '${onlyDraft}';`), 'superseded');
  // An approve_weights holding the pre-change version is stale; the old draft is refused even when current
  // (BASIS_CHANGED), and a new entry carries the new pack in its basis.
  psql(draftN(DEA4, 8, 'measured'));
  const preChange = nItem(DEA4);
  psql(`UPDATE public.products SET container_size = 9 WHERE id = '${DEA4}';`);
  refused(ADMIN, approveSql([preChange]), /PRODUCT_WEIGHT_STALE/);
  ok(ADMIN, setN(DEA4, 9, 'measured'));
  assert.equal(owner(`SELECT basis->>'container_size' FROM public.product_size_net_weight_values WHERE product_id = '${DEA4}' AND review_state = 'approved';`), '9');
  psql(draftN(DEA4, 9.1, 'measured'));
  psql(`SET session_replication_role = replica; UPDATE public.products SET container_size = 10 WHERE id = '${DEA4}';`, { user: 'supabase_admin' });
  refused(ADMIN, approveSql([nItem(DEA4)]), /PRODUCT_WEIGHT_BASIS_CHANGED/);
  console.log('[prover] container_size, container_type, unit_size and a filled container_unit each return a net weight to draft (version and pack generation move, returned_to_draft logged, system or user actor); a no-op edit does nothing; a filled inventory unit moves version and generation only; a draft-only size loses its draft; a pre-change approval is stale; a draft for another pack is refused; a new entry carries the new pack');

  // Identity: formulation_type and safener through correct_product_parent_identity; product_form by owner UPDATE.
  const pv = (pid) => owner(`SELECT parent_version FROM public.product_parents WHERE id = '${pid}';`);
  const identityCase = (pid, sid, sql, viaApp) => {
    const v0 = dVer(pid);
    if (viaApp) ok(ADMIN, sql); else psql(sql);
    assert.equal(weight(sid).none_reason, 'no_approved_weight');
    assert.equal(dVer(pid), v0 + 1);
    assert.equal(owner(`SELECT event_type FROM public.product_weight_events WHERE parent_id = '${pid}' ORDER BY id DESC LIMIT 1;`), 'returned_to_draft');
  };
  identityCase(P3, L3, `SELECT public.correct_product_parent_identity('${P3}', ${pv(P3)}, '{"formulation_type":"SC"}', 'r', 'e', ${q(key())});`, true);
  refused(ADMIN, approveSql([dItem(P3)]), /PRODUCT_WEIGHT_BASIS_CHANGED/);  // the returned draft was for the old formulation
  refused(ADMIN, approveSql([{ kind: 'density', subject_id: P3, draft_id: P3, expected_version: dVer(P3) }]), /STALE/);
  ok(ADMIN, setD(P3, 8.1235, 'lb_per_gal', 'measured'));
  identityCase(P3, L3, `SELECT public.correct_product_parent_identity('${P3}', ${pv(P3)}, '{"safener":"cloquintocet"}', 'r', 'e', ${q(key())});`, true);
  ok(ADMIN, setD(P3, 8.1235, 'lb_per_gal', 'measured'));
  identityCase(P3, L3, `SET session_replication_role = replica; UPDATE public.product_parents SET product_form = 'dry' WHERE id = '${P3}';
    SET session_replication_role = origin; UPDATE public.product_parents SET product_form = 'liquid' WHERE id = '${P3}';`, false);
  ok(ADMIN, setD(P3, 8.1235, 'lb_per_gal', 'measured'));
  console.log('[prover] formulation_type and safener (through correct_product_parent_identity) and product_form (owner UPDATE) each return a density to draft');

  // ---- Saved tickets keep their weight.
  ok(ADMIN, setN(DEA2, 5, 'measured')); // the pack case above left it a draft
  const T = createTicket([{ product_id: L1, product_name: 'L1', quantity: 10, unit: 'Gal' }, { product_id: DEA2, product_name: 'DEA2', quantity: 1, unit: 'Ea' },
    { product_id: L6, product_name: 'L6', quantity: 1, unit: 'Gal' }, { product_name: 'Unlinked', quantity: 2, unit: 'Gal' }], { total_volume: 100, total_volume_unit: 'Lb' });
  assert.equal(snap(T, L1), 'density:9.5972');
  ok(ADMIN, corrD(P1, 9.4, 'measured', 'r', 'e'));
  let lines = ticketLines(T);
  saveTicket(T, lines);
  saveTicket(T, lines, { notes: 'header only' });
  saveTicket(T, lines.filter((l) => l.product_id !== L1));
  saveTicket(T, [...ticketLines(T), { id: id('9001'), product_id: L1, product_name: 'L1', quantity: 10, unit: 'Gal' }]);
  assert.equal(snap(T, L1), 'density:9.5972', 'unchanged lines, header edit, delete and re-add keep the first weight');
  lines = ticketLines(T);
  const dea2Line = lines.find((l) => l.product_id === DEA2);
  saveTicket(T, lines.map((l) => (l.id === dea2Line.id ? { ...l, product_id: L2, product_name: 'L2', unit: 'Gal' } : l)));
  assert.equal(snap(T, L2), 'density:10.3', 'a line changed to another product records today\'s weight');
  assert.equal(snap(T, DEA2), 'net_weight:5', 'the first product keeps its row');
  ok(REP, `INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit) VALUES ('${T}', '${L1}', 'L1 again', 1, 'Gal');`);
  assert.equal(snap(T, L1), 'density:9.5972', 'a direct API line insert keeps the first weight');
  let tw = ticketW(T);
  assert.equal(tw.lines.find((l) => l.product_id === null).weight.none_reason, 'unlinked');
  assert.ok(tw.retained[DEA2], 'a product no longer on the ticket is returned only under retained');
  assert.ok(!tw.lines.some((l) => l.product_id === DEA2), 'a deleted line\'s product is not a line');
  // A product with no weight keeps none after one is approved.
  const T2 = createTicket([{ product_id: LX, product_name: 'LX', quantity: 1, unit: 'Gal' }]);
  psql(`INSERT INTO public.product_parent_members (product_id, parent_id, added_by) VALUES ('${LX}', '${P1}', '${ADMIN}');`);
  saveTicket(T2, ticketLines(T2));
  assert.equal(snap(T2, LX), 'none:no_parent');
  // A line moved to another ticket records the weight on the destination.
  const lxLine = ticketLines(T2)[0].id;
  ok(REP, `UPDATE public.blend_ticket_products SET blend_ticket_id = '${T}' WHERE id = '${lxLine}' RETURNING id;`);
  assert.equal(snap(T, LX), 'density:9.4');
  // Name correction: same product, new name shown beside the saved weight.
  lines = ticketLines(T);
  saveTicket(T, lines.map((l) => (l.product_id === L2 ? { ...l, product_name: 'L2 corrected' } : l)));
  tw = ticketW(T);
  const l2 = tw.lines.find((l) => l.product_id === L2);
  assert.equal(l2.product_name, 'L2 corrected'); assert.equal(l2.weight.captured_name, '[PROVER] L2');
  // Qt factor change after capture: the basis keeps the first map.
  const TQ = createTicket([{ product_id: L1, product_name: 'L1', quantity: 4, unit: 'Qt' }], { total_volume: 1, total_volume_unit: 'g' });
  setFactor('Qt', 30);
  ok(REP, `INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit) VALUES ('${TQ}', '${L2}', 'L2', 1, 'Gal');`);
  const tq = ticketW(TQ);
  assert.equal(tq.basis_unit_factors.factors.qt.factor, 0.25, 'the ticket\'s basis keeps the first map');
  assert.equal(tq.current_unit_factors.factors.qt.factor, 0.234375);
  assert.equal(tq.lines.find((l) => l.product_id === L2).weight.unit_factors.factors.qt.factor, 0.234375, 'the second line\'s own map is today\'s; the checker uses the basis');
  assert.equal(tq.basis_unit_factors.factors.g.factor, 0.0022046225);
  setFactor('Qt', 32);
  // Header change replaces the basis; header-only edits that leave the total alone keep it.
  const basisAt = owner(`SELECT captured_at FROM public.blend_ticket_weight_basis WHERE blend_ticket_id = '${TQ}';`);
  saveTicket(TQ, ticketLines(TQ), { notes: 'n' });
  assert.equal(owner(`SELECT captured_at FROM public.blend_ticket_weight_basis WHERE blend_ticket_id = '${TQ}';`), basisAt);
  saveTicket(TQ, ticketLines(TQ), { total_volume: 2 });
  assert.notEqual(owner(`SELECT captured_at FROM public.blend_ticket_weight_basis WHERE blend_ticket_id = '${TQ}';`), basisAt);
  // Header with no linked line stores its basis; a later link keeps the first one.
  const TB = createTicket([]);
  setFactor('Qt', 30);
  ok(REP, `INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit) VALUES ('${TB}', '${L1}', 'L1', 1, 'Qt');`);
  assert.equal(ticketW(TB).basis_unit_factors.factors.qt.factor, 0.25);
  setFactor('Qt', 32);
  // Visibility: admin and rep read; anyone else gets no header, lines, basis or snapshot rows.
  assert.equal(js(REP, `SELECT public.get_blend_ticket_weights('${T}');`).ticket.id, T);
  for (const uid of [APPLA, DRIVER]) {
    const other = js(uid, `SELECT public.get_blend_ticket_weights('${T}');`);
    assert.equal(other.ticket, null); assert.deepEqual(other.lines, []); assert.equal(other.basis_unit_factors, null);
    assert.deepEqual(other.retained, {}); assert.ok(other.current_unit_factors.factors.gal);
    assert.equal(ok(uid, 'SELECT count(*) FROM public.blend_ticket_product_weights;'), '0');
    assert.equal(ok(uid, 'SELECT count(*) FROM public.blend_ticket_weight_basis;'), '0');
  }
  refused(OFFDRIVER, `SELECT public.get_blend_ticket_weights('${T}');`, /ACTIVE_PROFILE_REQUIRED/);
  // Soft delete keeps snapshot rows; a hard delete removes them.
  psql(`UPDATE public.blend_tickets SET deleted_at = now() WHERE id = '${T2}';`);
  assert.equal(owner(`SELECT count(*) FROM public.blend_ticket_product_weights WHERE blend_ticket_id = '${T2}';`), '1');
  psql(`DELETE FROM public.blend_ticket_products WHERE blend_ticket_id = '${TB}'; DELETE FROM public.blend_tickets WHERE id = '${TB}';`);
  assert.equal(owner(`SELECT count(*) FROM public.blend_ticket_product_weights WHERE blend_ticket_id = '${TB}';`), '0');
  assert.equal(owner(`SELECT count(*) FROM public.blend_ticket_weight_basis WHERE blend_ticket_id = '${TB}';`), '0');
  console.log('[prover] tickets: every re-save route, a direct insert and a product change keep the first weight; a new product gets today\'s; a moved line records on its destination; none stays none; unlinked lines say so; renamed lines show the new name; the basis map stays fixed until the header total changes; only office staff read; soft delete keeps, hard delete removes');

  // ---- Saved worksheets keep their weight.
  psql(`UPDATE public.product_parent_density_values SET review_state = 'superseded', superseded_at = now() WHERE parent_id = '${P2}' AND review_state <> 'superseded';`);
  const WA = owner(`INSERT INTO public.job_loader_worksheets (job_id, capacity_gal, is_selected, created_by) VALUES ('${JA}', 200, false, '${ADMIN}') RETURNING id;`);
  assert.equal(owner(`SELECT count(*) FROM public.job_loader_worksheet_weights WHERE worksheet_id = '${WA}';`), '4');
  assert.equal(wsRow(WA, L1), 'density:9.4'); assert.equal(wsRow(WA, DEA), 'net_weight:5');
  assert.equal(wsRow(WA, DLB), 'unit_weight:1'); assert.equal(wsRow(WA, L2), 'none:no_approved_weight');
  ok(ADMIN, corrD(P1, 9.3, 'measured', 'r', 'e'));
  ok(REP, `UPDATE public.job_loader_worksheets SET loads_done = '[0]' WHERE id = '${WA}' RETURNING id;`);
  assert.equal(wsRow(WA, L1), 'density:9.4', 'marking a load done keeps the saved weight');
  ok(ADMIN, setD(P2, 10.5, 'lb_per_gal', 'measured'));
  w = wsGet(WA);
  assert.equal(w[L2].saved.weight_kind, 'none'); assert.equal(w[L2].current.lb_per_unit, 10.5, 'the fourth shows today\'s weight, labelled current');
  touchWs(WA);
  assert.equal(wsRow(WA, L2), 'none:no_approved_weight', 'a later save does not lock it in');
  psql(`INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, customer_supplied, sort_order) VALUES ('${JA}', '${L4}', 1, 'Gal', 0, true, 4);`);
  touchWs(WA);
  assert.equal(wsRow(WA, L4), 'density:20', 'a product added to the job is captured at today\'s weight');
  // Qt line keeps its pounds after the factor changes (the row keeps its own map).
  setFactor('Qt', 30);
  assert.equal(JSON.parse(owner(`SELECT unit_factors->'factors'->'qt' FROM public.job_loader_worksheet_weights WHERE worksheet_id = '${WA}' AND product_id = '${L2}';`)).factor, 0.25);
  setFactor('Qt', 32);
  // Readers.
  for (const [uid, n] of [[ADMIN, 5], [REP, 5], [APPLA, 5], [DISP, 5], [APPLB, 0], [DRIVER, 0], [OFFDRIVER, 0]]) {
    assert.equal(Number(ok(uid, `SELECT count(*) FROM public.job_loader_worksheet_weights WHERE worksheet_id = '${WA}';`)), n, `reader ${uid}`);
  }
  // Pack change invalidates the stored row; it stays stored; the next save after re-approval replaces it; a ticket keeps it.
  const TP = createTicket([{ product_id: DEA, product_name: 'DEA', quantity: 1, unit: 'Ea' }]);
  psql(`UPDATE public.products SET container_size = 5 WHERE id = '${DEA}';`);
  assert.equal(wsValid(WA, DEA), 'f'); assert.equal(wsRow(WA, DEA), 'net_weight:5', 'still stored');
  assert.equal(ok(ADMIN, `SELECT count(*) FROM public.job_loader_worksheet_weights WHERE worksheet_id = '${WA}' AND product_id = '${DEA}';`), '0', 'invalid rows are not readable');
  assert.equal(wsGet(WA)[DEA].saved, null);
  assert.equal(wsGet(WA)[DEA].current.none_reason, 'no_approved_weight');
  ok(ADMIN, setN(DEA, 10, 'measured'));
  touchWs(WA);
  assert.equal(wsRow(WA, DEA), 'net_weight:10'); assert.equal(wsValid(WA, DEA), 't');
  assert.equal(snap(TP, DEA), 'net_weight:5', 'the ticket keeps its weight');
  // Generations never revive a row: pack A -> B -> A.
  psql(`UPDATE public.products SET container_size = 6 WHERE id = '${DEA}'; UPDATE public.products SET container_size = 5 WHERE id = '${DEA}';`);
  assert.equal(wsValid(WA, DEA), 'f', 'a pack changed and changed back stays invalid');
  ok(ADMIN, setN(DEA, 10, 'measured'));
  touchWs(WA);
  // Identity changed and back.
  psql(`UPDATE public.product_parents SET safener = 'x' WHERE id = '${P1}'; UPDATE public.product_parents SET safener = NULL WHERE id = '${P1}';`);
  assert.equal(wsValid(WA, L1), 'f', 'an identity changed and changed back stays invalid');
  assert.equal(wsValid(WA, DEA), 't', 'a parent identity change leaves a dry size\'s row valid');
  ok(ADMIN, setD(P1, 9.3, 'lb_per_gal', 'measured'));
  touchWs(WA);
  assert.equal(wsValid(WA, L1), 't');
  // Size moved to another parent and back: only the density row turns invalid.
  psql(`UPDATE public.product_parent_members SET parent_id = '${P2}' WHERE product_id = '${L1}'; UPDATE public.product_parent_members SET parent_id = '${P1}' WHERE product_id = '${L1}';
    UPDATE public.product_parent_members SET parent_id = '${P1}' WHERE product_id = '${DEA}';`);
  assert.equal(wsValid(WA, L1), 'f'); assert.equal(wsValid(WA, DEA), 't', 'a dry size moving parent keeps its net_weight row');
  assert.equal(wsGet(WA)[L1].saved, null); assert.ok(wsGet(WA)[DEA].saved);
  psql(`UPDATE public.product_parent_members SET parent_id = '${PDRY}' WHERE product_id = '${DEA}';`);
  touchWs(WA);
  assert.equal(wsValid(WA, L1), 't');
  // Moved to another job: old rows go, the new job's are captured.
  ok(REP, `UPDATE public.job_loader_worksheets SET job_id = '${JB}' WHERE id = '${WA}' RETURNING id;`);
  assert.equal(owner(`SELECT string_agg(product_id::text, ',') FROM public.job_loader_worksheet_weights WHERE worksheet_id = '${WA}';`), L3);
  // Pre-existing worksheet: its first update captures.
  touchWs(WPRE);
  assert.equal(owner(`SELECT count(*) FROM public.job_loader_worksheet_weights WHERE worksheet_id = '${WPRE}';`), '5');
  // Getter by job: lines, acres, settings, the selected worksheet and its saved rows.
  const byJob = js(DISP, `SELECT public.get_loader_worksheet_weights(NULL, ARRAY['${JA}', '${id('99')}']::uuid[]);`);
  assert.equal(byJob.jobs[0].acres, 40); assert.equal(byJob.jobs[0].worksheet.id, WPRE); assert.equal(byJob.jobs[0].worksheet.vehicle_name, 'Manual');
  assert.equal(Object.keys(byJob.jobs[0].worksheet.saved).length, 5); assert.equal(byJob.jobs[1].found, false);
  assert.ok(byJob.read_at);
  refused(ADMIN, `SELECT public.get_loader_worksheet_weights(NULL, NULL);`, /BAD_REQUEST/);
  refused(ADMIN, `SELECT public.get_loader_worksheet_weights(ARRAY[]::uuid[], ARRAY[]::uuid[]);`, /BAD_REQUEST/);
  // Deleting the worksheet removes its rows.
  ok(REP, `DELETE FROM public.job_loader_worksheets WHERE id = '${WA}' RETURNING id;`);
  assert.equal(owner(`SELECT count(*) FROM public.job_loader_worksheet_weights WHERE worksheet_id = '${WA}';`), '0');
  // worksheet_weight_is_valid trusts guard_product_setup_fields: a set form or unit cannot change.
  for (const sql of [`UPDATE public.products SET product_form = 'dry' WHERE id = '${L1}';`,
    `UPDATE public.products SET inventory_unit = 'Qt' WHERE id = '${L1}';`,
    `UPDATE public.products SET container_unit = 'oz' WHERE id = '${DEA}';`]) {
    const r = psql(sql, { allowFailure: true });
    assert.notEqual(r.status, 0, sql); assert.match(`${r.stdout}${r.stderr}`, /change on a saved product/);
  }
  console.log('[prover] worksheets: four rows captured (one none); load-done keeps them; a later approval shows current and is not locked in; an added product is captured; readers are admin, rep, the job\'s applicator and dispatchee only; pack, identity and member changes invalidate (never revived), a ticket keeps its weight; a job move recaptures; a pre-DM-2 worksheet captures on first update; delete cascades; a set form, stock unit or container unit cannot change');

  // ---- Moves: a size moved to a parent with a different density reads the new value; an old ticket keeps the old one.
  const TM = createTicket([{ product_id: LMOVE, product_name: 'LMOVE', quantity: 1, unit: 'Gal' }]);
  psql(`UPDATE public.product_parent_members SET parent_id = '${P2}' WHERE product_id = '${LMOVE}';`);
  assert.equal(weight(LMOVE).lb_per_unit, 10.5);
  assert.equal(snap(TM, LMOVE), 'density:9.3');
  console.log('[prover] a moved size reads its new parent\'s density; a ticket saved before the move keeps the old one');

  // ---- Unit map: colliding names left out; same factor but different type left out; live pairs stay in.
  const units = js(REP, 'SELECT public.get_product_weights(ARRAY[]::uuid[])->\'units\';');
  assert.ok(units.ambiguous.includes('tst') && units.ambiguous.includes('sam'));
  assert.ok(!units.factors.tst && !units.factors.sam);
  assert.ok(units.factors.lb && units.factors.qt && units.factors.oz && units.factors.ea);
  assert.equal(weight(DTST).none_reason, 'unit_not_convertible');
  console.log('[prover] unit map: Tst/tst (different factors) and Sam/sam (same factor, different type) are left out and listed; Lb/LB, Qt/qt, oz/Oz stay in; a size stocked in a colliding name reads unit_not_convertible');

  // ---- read_at is the statement's time, not later than a change committed after it.
  const readAt = js(REP, 'SELECT public.get_product_weights(ARRAY[]::uuid[])->\'read_at\';');
  ok(ADMIN, setD(P2, 10.6, 'lb_per_gal', 'measured'));
  const changedAt = owner(`SELECT reviewed_at FROM public.product_parent_density_values WHERE parent_id = '${P2}' AND review_state = 'approved';`);
  assert.equal(owner(`SELECT '${readAt}'::timestamptz < '${changedAt}'::timestamptz;`), 't');

  // ---- Security and retries, per writer.
  const writers = {
    set_parent_density: (k) => setD(P2, 10.6, 'lb_per_gal', 'measured', k),
    correct_parent_density: (k) => corrD(P2, 10.6, 'measured', 'r', 'e', k),
    set_size_net_weight: (k) => setN(DEA, 10, 'measured', k),
    correct_size_net_weight: (k) => corrN(DEA, 10, 'measured', 'r', 'e', k),
  };
  for (const [name, mk] of Object.entries(writers)) {
    const evs = owner('SELECT count(*) FROM public.product_weight_events;');
    refused(REP, mk(key()), /admin/i);
    refused(OFFADMIN, mk(key()), /admin/i);
    refused(ADMIN, mk(null), /IDEMPOTENCY|key/i);
    assert.equal(owner('SELECT count(*) FROM public.product_weight_events;'), evs, `${name}: refused calls wrote nothing`);
    const k = key();
    const sql = mk(k);
    const first = ok(ADMIN, sql);
    const evs2 = owner('SELECT count(*) FROM public.product_weight_events;');
    assert.equal(ok(ADMIN, sql), first, `${name}: the same key and request returns the first receipt`);
    assert.equal(owner('SELECT count(*) FROM public.product_weight_events;'), evs2, `${name}: written once`);
    refused(ADMIN, mk(k).replace(/, (10\.6|10), /, ', 11, '), /IDEMPOTENCY|fingerprint|different/i);
    refused(ADMIN2, sql, /IDEMPOTENCY|actor|different/i);
  }
  psql(draftN(DEA, 10, 'measured'));
  const aItem = [nItem(DEA)];
  refused(REP, approveSql(aItem), /admin/i);
  refused(OFFADMIN, approveSql(aItem), /admin/i);
  refused(ADMIN, approveSql(aItem, null), /IDEMPOTENCY|key/i);
  const ak = key();
  const aFirst = ok(ADMIN, approveSql(aItem, ak));
  assert.equal(ok(ADMIN, approveSql(aItem, ak)), aFirst);
  refused(ADMIN, approveSql([{ ...aItem[0], expected_version: aItem[0].expected_version + 1 }], ak), /IDEMPOTENCY|fingerprint|different/i);
  refused(ADMIN2, approveSql(aItem, ak), /IDEMPOTENCY|actor|different/i);
  console.log('[prover] each of the five writers: rep and inactive admin refused, a NULL key refused, a replay returns the first receipt and writes once, a changed request or another admin on the same key refused');

  // Catalog reads: active vs inactive.
  for (const t of TABLES.slice(0, 5)) {
    assert.notEqual(ok(DRIVER, `SELECT count(*) FROM public.${t};`), '0', `active user reads ${t}`);
    assert.equal(ok(OFFDRIVER, `SELECT count(*) FROM public.${t};`), '0', `inactive user reads nothing from ${t}`);
  }
  refused(OFFDRIVER, `SELECT public.get_product_weights(ARRAY['${L1}']::uuid[]);`, /ACTIVE_PROFILE_REQUIRED/);
  refused(null, `SELECT public.get_product_weights(ARRAY['${L1}']::uuid[]);`, /permission denied/);

  // ---- Append-only events.
  for (const sql of ['UPDATE public.product_weight_events SET reason = \'x\';', 'DELETE FROM public.product_weight_events;', 'TRUNCATE public.product_weight_events;']) {
    const rr = psql(sql, { allowFailure: true });
    assert.notEqual(rr.status, 0); assert.match(`${rr.stdout}${rr.stderr}`, /APPEND_ONLY/);
  }
  console.log('[prover] catalog tables readable by active users only; events refuse UPDATE, DELETE and TRUNCATE even from the owner');

  // ---- Hard delete (owner SQL, inside a rolled-back transaction): refused by a value row, and separately by
  // a state row alone, naming the DM-2 table.
  for (const [pid, pat] of [[DEA, /product_size_net_weight_values/], [DNOINV, /product_size_net_weight_state/]]) {
    const rr = psql(`BEGIN; DELETE FROM public.job_chemicals WHERE product_id = '${pid}';
      DELETE FROM public.products WHERE id = '${pid}'; ROLLBACK;`, { allowFailure: true });
    assert.notEqual(rr.status, 0, `${pid} was hard-deleted`);
    assert.match(`${rr.stdout}${rr.stderr}`, /foreign key/);
    // shortcut: other tables may refuse first; the named table must at least hold a row for this size.
    assert.notEqual(owner(`SELECT count(*) FROM public.${pat.source} WHERE product_id = '${pid}';`), '0');
  }
  console.log('[prover] a size with a value row or only a state row cannot be hard-deleted');

  // ---- Races (two sessions, a held lock seen in pg_locks).
  // A pack edit in flight: set_size_net_weight read at the old version waits on the size row, then is stale.
  ok(ADMIN, setN(DEA3, 100, 'measured'));
  const v3 = nVer(DEA3);
  bg = session(`BEGIN; UPDATE public.products SET container_size = 11 WHERE id = '${DEA3}'; SELECT 'JK_READY'; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  const racing = await waited(bg, () => as(ADMIN, setN(DEA3, 101, 'measured', key(), v3)), 'set_size_net_weight behind a pack edit');
  assert.notEqual(racing.status, 0); assert.match(racing.output, /PRODUCT_WEIGHT_STALE/);
  assert.equal(owner(`SELECT count(*) FROM public.product_size_net_weight_values WHERE product_id = '${DEA3}' AND review_state = 'approved';`), '0',
    'no approved value for the old pack survives');
  console.log('[prover] a pack edit racing set_size_net_weight never leaves an approved value for the old pack');

  // Accepted snapshot-key deadlock: two sessions moving two lines of one ticket to one product.
  const TD = createTicket([{ product_id: L1, product_name: 'L1', quantity: 1, unit: 'Gal' }, { product_id: L2, product_name: 'L2', quantity: 1, unit: 'Gal' },
    { product_id: L3, product_name: 'L3', quantity: 1, unit: 'Gal' }]);
  const [ln1, ln2, ln3] = ticketLines(TD).map((l) => l.id);
  void ln1;
  bg = session(`BEGIN; UPDATE public.blend_ticket_products SET product_id = '${DEA2}' WHERE id = '${ln2}'; SELECT 'JK_READY';
    ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  await waited(bg, () => psql(`UPDATE public.blend_ticket_products SET product_id = '${DEA2}' WHERE id = '${ln3}';`), 'the second line move to the same product');
  assert.equal(owner(`SELECT count(*) FROM public.blend_ticket_product_weights WHERE blend_ticket_id = '${TD}' AND product_id = '${DEA2}';`), '1', 'exactly one (T, A) snapshot');
  console.log('[prover] two sessions moving two lines of one ticket to the same product: the second waits on the (T, A) key and finishes; exactly one snapshot row');

  // ---- Rollback block (sheet 3.7): existing tables and readers still answer.
  psql(`BEGIN;
    REVOKE ALL ON TABLE ${TABLES.map((t) => `public.${t}`).join(', ')} FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
    DROP POLICY job_loader_worksheet_weights_select ON public.job_loader_worksheet_weights;
    DROP TRIGGER trigger_capture_blend_ticket_weight_basis ON public.blend_tickets;
    DROP TRIGGER trigger_delete_blend_ticket_weights ON public.blend_tickets;
    DROP TRIGGER trigger_capture_blend_ticket_product_weight ON public.blend_ticket_products;
    DROP TRIGGER trigger_capture_loader_worksheet_weights ON public.job_loader_worksheets;
    DROP TRIGGER trigger_return_net_weight_to_draft ON public.products;
    DROP TRIGGER trigger_return_density_to_draft ON public.product_parents;
    DROP TRIGGER trigger_bump_member_generation ON public.product_parent_members;
    DROP FUNCTION public.get_product_weights(uuid[]), public.get_blend_ticket_weights(uuid), public.get_loader_worksheet_weights(uuid[], uuid[]),
      public.set_parent_density(uuid, bigint, numeric, text, text, text, text), public.correct_parent_density(uuid, bigint, numeric, text, text, text, text, text, text),
      public.set_size_net_weight(uuid, bigint, numeric, text, text, text), public.correct_size_net_weight(uuid, bigint, numeric, text, text, text, text, text),
      public.approve_weights(jsonb, text), public._save_parent_density_draft(uuid, bigint, numeric, text, text, text, text, text),
      public._save_size_net_weight_draft(uuid, bigint, numeric, text, text, text, text), public._approve_weight_item_ok(jsonb),
      public._write_parent_density(text, uuid, bigint, numeric, text, text, text, text, text), public._write_size_net_weight(text, uuid, bigint, numeric, text, text, text, text),
      public._product_weight_event(text, uuid, uuid, text, uuid, jsonb, jsonb, text, text), public._product_weight_trust_rank(text),
      public.capture_blend_ticket_product_weight(), public.capture_blend_ticket_weight_basis(), public.delete_blend_ticket_weights(),
      public.capture_loader_worksheet_weights(), public.return_net_weight_to_draft(), public.return_density_to_draft(), public.bump_member_generation(),
      public._approved_parent_lb_per_gal(uuid), public._product_weight(uuid, jsonb), public._weight_unit_factors();
    DROP FUNCTION public.worksheet_weight_is_valid(public.job_loader_worksheet_weights);
    COMMIT;`);
  const TR = createTicket([{ product_id: L1, product_name: 'L1', quantity: 1, unit: 'Gal' }]);
  saveTicket(TR, ticketLines(TR), { total_volume: 3 });
  ok(REP, `INSERT INTO public.job_loader_worksheets (job_id, capacity_gal, created_by) VALUES ('${JB}', 100, auth.uid()) RETURNING id;`);
  psql(`UPDATE public.products SET container_size = 12 WHERE id = '${DEA}';`);
  assert.equal(ok(ADMIN, `SELECT count(*) FROM public.blend_ticket_products WHERE blend_ticket_id = '${TR}';`), '1');
  for (const t of TABLES) {
    refused(ADMIN, `SELECT count(*) FROM public.${t};`, /permission denied/);
    for (const role of ['PUBLIC', 'anon', 'authenticated', 'service_role', 'metabase_ro']) {
      const grantee = role === 'PUBLIC' ? 0 : `'${role}'::regrole`;
      assert.equal(owner(`SELECT count(*) FROM pg_class, aclexplode(relacl) a WHERE oid = 'public.${t}'::regclass AND a.grantee = ${grantee};`), '0', `${role} keeps a privilege on ${t}`);
    }
  }
  console.log('[prover] after the rollback block: tickets, worksheets and pack edits work as before; DM-2 tables are kept but unreadable');

  console.log('PRODUCT_WEIGHTS_PROOF_PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true });
});
