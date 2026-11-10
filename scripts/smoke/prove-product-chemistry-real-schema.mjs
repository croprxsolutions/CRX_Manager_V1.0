#!/usr/bin/env node
// DM-1 (product chemistry) real-schema proof: builds a throwaway PostgreSQL from the schema baseline,
// replays every post-baseline migration before 20261209100000_product_chemistry.sql, seeds invented rows,
// applies the candidate (and its refusals), then checks the database half of the build sheet's
// "Done when" list (docs/plans/2026-11-06-product-DM1-BUILD-SHEET.md section 7).
// Usage: node scripts/smoke/prove-product-chemistry-real-schema.mjs   (needs Docker; prints PRODUCT_CHEMISTRY_PROOF_PASS)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// CRX_DM1_CONTAINER=<name> reuses a kept container (built with CRX_PROVER_KEEP_CONTAINER=1) and runs the
// cases in a fresh copy of its pre-candidate database; for iterating on this proof only.
const REUSE = process.env.CRX_DM1_CONTAINER || '';
const NAME = REUSE || `crx-dm1-${process.pid}-${Date.now().toString(36)}`;
let DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
// Only a container this proof created carries the label; reuse refuses any other, so its drops never touch someone else's databases.
const OWNER_LABEL_VALUE = 'dm1-product-chemistry';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261209100000_product_chemistry.sql');
// Landing fixes (Mason 2026-11-07: a swap states its values, nothing is copied).
const FOLLOW_UPS = [path.join(MIGRATIONS, '20261211100000_product_chemistry_confirmed_swaps.sql')];
// Later migrations that only name what this proof covers (they call _product_parent_require_admin() and list
// product tables in a CHECK) and redefine none of it; pinned by sha256 of their LF text, so any edit re-asks.
const LATER_NAME_ONLY = new Map([
  ['20261210100000_epa_registrations.sql', 'cac5e17d8503922f33dca9ac3ea1859937fab7173a52e0d7de4bcf37f6f4a9f3'],
]);
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
const TOUCHED = /(product_parent|product_brands|ingredient_map|active_ingredient|unit_conversions|product_chemistry|_approved_parent_lb_per_gal)/i;
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
    const pin = LATER_NAME_ONLY.get(path.basename(file));
    if (pin && createHash('sha256').update(lf(file)).digest('hex') === pin) continue;
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
// ---------------------------------------------------------------------------------------------
// Seed (invented rows shaped like live ones; nothing from live is in the repo)
// ---------------------------------------------------------------------------------------------

const id = (n) => `d1d10000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = id('a1'), ADMIN2 = id('a2'), REP = id('a3'), OFFREP = id('a4');
// Parents.
const PGLY = id('b01'), PPRE = id('b02'), PPCT = id('b03'), PDRY = id('b04'), PHALF = id('b05'), PFERT = id('b06'),
  PFDRY = id('b07'), PMET = id('b08'), PSEED = id('b09'), PUNIT = id('b10'), PAE = id('b11'), PBIG = id('b12'),
  PEPA1 = id('b21'), PEPA2 = id('b22'), PEPA3 = id('b23'), PEPA4 = id('b24'), PEPA5 = id('b25'), PINACT = id('b26'),
  PNOSIZE = id('b27'), PREF = id('b28'), PDUP1 = id('b31'), PDUP2 = id('b32'), PRACE = id('b33'), PSTALE = id('b34'),
  PSWITCH = id('b35'), PDM4 = id('b36');
// Sizes.
const GBULK = id('101'), GQT = id('102'), GOZ = id('103'), PREG = id('104'), PCTG = id('105'), DLB = id('106'), DOZ = id('107'),
  HALFLB = id('108'), FERTG = id('109'), FDLB = id('110'), METG = id('111'), SEEDEA = id('112'), UG = id('113'), UMG = id('114'),
  UEA = id('115'), UZZ = id('116'), UNULL = id('117'), UZERO = id('118'), AEG = id('119'), BIGG = id('120'),
  E2G = id('121'), E4G = id('122'), INACTG = id('123'), REFBULK = id('124'), REFA = id('125'), REFB = id('126'),
  DUP1G = id('127'), DUP2G = id('128'), STALEG = id('129'), STALEJOIN = id('130'), SWITCHG = id('131'), DM4G = id('132'),
  E1G = id('133'), E3G = id('134'), E5G = id('135'), UKG = id('136');

const OWNER = 'owner';
function txIn(uid, sql) {
  if (uid === OWNER) return `BEGIN;\n${sql}\nCOMMIT;\n`;
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
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}\n${r.output}`);
  assert.match(r.output, pattern);
}
function owner(sql) { return scalar(sql); }
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
let keyN = 0;
const key = () => `dm1-key-${++keyN}`;

// Exact hand arithmetic: cents = half-up(num / den) on BigInt fractions written from decimal strings.
function frac(s) { const [w, f = ''] = String(s).split('.'); return [BigInt(w + f), 10n ** BigInt(f.length)]; }
function mul(...xs) { return xs.reduce(([an, ad], [bn, bd]) => [an * bn, ad * bd], [1n, 1n]); }
function div([an, ad], [bn, bd]) { return [an * bd, ad * bn]; }
function halfUp([n, d]) { const qt = n / d; return String(2n * (n - qt * d) >= d ? qt + 1n : qt); }
const F = (...parts) => mul(...parts.map(frac));

// Writers and reads.
const ver = (pid) => Number(owner(`SELECT COALESCE((SELECT chemistry_version FROM public.product_parent_chemistry_state WHERE parent_id = '${pid}'), 0);`));
const setC = (pid, changes, k = key(), v = ver(pid)) => `SELECT public.set_parent_chemistry('${pid}', ${v}, ${J(changes)}, ${q(k)});`;
const prevC = (pid, changes) => js(ADMIN, `SELECT public.preview_parent_chemistry_correction('${pid}', ${J(changes)});`);
const corrC = (pid, changes, reason = 'label reread', evidence = 'label page 2', o = {}) => {
  // A refused preview gives no fingerprint; save-side refusals are still tested with the real one.
  const fp = 'fp' in o ? o.fp : (prevC(pid, changes).preview_fingerprint
    ?? owner(`SELECT public._chemistry_preview_fingerprint('${pid}', ${J(changes)});`));
  return `SELECT public.correct_parent_chemistry('${pid}', ${o.v ?? ver(pid)}, ${q(fp)}, ${J(changes)}, ${q(reason)}, ${q(evidence)}, ${q(o.k ?? key())});`;
};
const chem = (pid, uid = REP) => js(uid, `SELECT public.get_parent_chemistry('${pid}');`);
const costs = (pid) => js(ADMIN, `SELECT public.get_parent_active_costs('${pid}');`);
const ingId = (name) => owner(`SELECT id FROM public.active_ingredients WHERE name = ${q(name)} ORDER BY created_at, id LIMIT 1;`);
const ingVer = (iid) => Number(owner(`SELECT row_version FROM public.active_ingredients WHERE id = '${iid}';`));
const rowId = (pid, iid) => owner(`SELECT id FROM public.product_parent_ingredients WHERE parent_id = '${pid}' AND ingredient_id = '${iid}' AND status = 'active';`);
const fig = (figures, name, basis) => {
  const f = figures.find((x) => x.name === name);
  assert.ok(f, `no figure for ${name}`);
  return basis && f.figure.basis !== basis ? f.converted : f.figure;
};
const sizeFigs = (c, sid) => c.sizes.find((s) => s.product_id === sid).figures;
const prevI = (iid, fields) => js(ADMIN, `SELECT public.preview_active_ingredient_change('${iid}', ${J(fields)});`);
const saveI = (iid, fields, reason = null, evidence = null, o = {}) => {
  const fp = o.fp ?? prevI(iid, fields).usage_fingerprint;
  return `SELECT public.save_active_ingredient('${iid}', ${o.v ?? ingVer(iid)}, ${q(fp)}, ${J(fields)}, ${q(reason)}, ${q(evidence)}, ${q(o.k ?? key())});`;
};
const createI = (fields, k = key()) => `SELECT public.save_active_ingredient(NULL, NULL, NULL, ${J(fields)}, NULL, NULL, ${q(k)});`;
const ing = (name, value, extra = {}) => ({ kind: 'ingredient', name, strength_value: value, strength_unit: 'lb_per_gal',
  strength_basis: 'active_ingredient', source: 'label', ...extra });
const DM1_FUNCTIONS = [...new Set([...[CANDIDATE, ...FOLLOW_UPS].map(lf).join('\n').matchAll(/^CREATE FUNCTION public\.(\w+)\(/gm)].map((m) => m[1]))];
const DM1_TABLES = ['active_ingredients', 'active_ingredient_events', 'product_parent_ingredients', 'product_parent_modes_of_action',
  'product_parent_fertilizer_analysis', 'product_parent_chemistry_state', 'product_chemistry_events', 'product_parent_cost_reference'];
const dm1FunctionsMd5 = () => owner(`SELECT md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc), ',' ORDER BY p.oid::regprocedure::text))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> '_approved_parent_lb_per_gal'
   AND (p.proname ~ '(chemistry|active_ingredient|ingredient_|cost_reference|_active_cost|_unit_factor_oz|_cents_half_up|_size_cost_per_base|_oxide_factor|_ingredient_cas_valid|ingredient_map)');`);
const fixture = (sql) => psql(`SET session_replication_role = replica;
${sql}
SET session_replication_role = origin;`, { user: 'supabase_admin' });
const STANDIN = `CREATE OR REPLACE FUNCTION public._approved_parent_lb_per_gal(p_parent_id uuid, OUT lb_per_gal numeric, OUT weight_row_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $standin$
    SELECT s.lb_per_gal, s.weight_row_id FROM public.dm1_standin_density s WHERE s.parent_id = p_parent_id $standin$;
  ALTER FUNCTION public._approved_parent_lb_per_gal(uuid) OWNER TO postgres;
  REVOKE ALL ON FUNCTION public._approved_parent_lb_per_gal(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;`;
const density = (pid, lb, rid = id('d' + pid.slice(-3))) => psql(`INSERT INTO public.dm1_standin_density VALUES ('${pid}', ${lb}, ${rid === null ? 'NULL' : `'${rid}'`})
  ON CONFLICT (parent_id) DO UPDATE SET lb_per_gal = EXCLUDED.lb_per_gal, weight_row_id = EXCLUDED.weight_row_id;`);
function noExecute(signature) {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(owner(`SELECT has_function_privilege('${role}', '${signature}'::regprocedure, 'EXECUTE');`), 'f', `${role} can run ${signature}`);
  }
  assert.equal(owner(`SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${signature}'::regprocedure AND a.grantee = 0;`), '0');
}

function seedBeforeCandidate() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'dm1-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${ADMIN2}', 'dm1-admin2@example.invalid', '{"full_name":"[PROVER] Admin Two","role":"admin"}'::jsonb),
    ('${REP}', 'dm1-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('${OFFREP}', 'dm1-offrep@example.invalid', '{"full_name":"[PROVER] Off Rep","role":"sales_rep"}'::jsonb);`);
  const prod = (pid, name, form, inv, cost, active = true, epa = null) =>
    `('${pid}', '[PROVER] ${name}', 'DM1-${name}', '${form}', ${q(inv)}, 'Herbicide', ${cost === null ? 'NULL' : cost}, 99.00, ${active}, ${q(epa)})`;
  const parent = (pid, name, form, epa = null, active = true) =>
    `('${pid}', '[PROVER] ${name}', '${form}', 'SL', 'Herbicide', ${q(epa)}, ${active}, '${ADMIN}', '${ADMIN}')`;
  const member = (sid, pid, role = 'package') => `('${sid}', '${pid}', '${role}', '${ADMIN}')`;
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id IN ('${ADMIN}', '${ADMIN2}');
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = false WHERE id = '${OFFREP}';
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type)
    SELECT v.u, v.f, v.t FROM (VALUES ('Gal', 128::numeric, 'liquid'), ('Qt', 32, 'liquid'), ('Oz', 1, 'liquid'),
      ('Lb', 16, 'dry'), ('Dry oz', 1, 'dry'), ('g', 0.03527396, 'dry'), ('MG', 0.00003527396, 'dry'), ('kg', 35.27396, 'dry')) v(u, f, t)
     WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions c WHERE lower(c.unit) = lower(v.u) AND c.unit_type = v.t);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, current_cost, tier1_price, is_active, epa_registration) VALUES
      ${prod(GBULK, 'GBULK', 'liquid', 'Gal', 20.00)}, ${prod(GQT, 'GQT', 'liquid', 'Qt', 6.00)}, ${prod(GOZ, 'GOZ', 'liquid', 'Oz', 0.50)},
      ${prod(PREG, 'PREG', 'liquid', 'Gal', 45.00)}, ${prod(PCTG, 'PCTG', 'liquid', 'Gal', 30.00)},
      ${prod(DLB, 'DLB', 'dry', 'Lb', 8.00)}, ${prod(DOZ, 'DOZ', 'dry', 'Dry oz', 0.75)}, ${prod(HALFLB, 'HALFLB', 'dry', 'Lb', 0.05)},
      ${prod(FERTG, 'FERTG', 'liquid', 'Gal', 11.00)}, ${prod(FDLB, 'FDLB', 'dry', 'Lb', 100.00)}, ${prod(METG, 'METG', 'liquid', 'Gal', 40.00)},
      ${prod(SEEDEA, 'SEEDEA', 'seed', 'Ea', 300.00)}, ${prod(UG, 'UG', 'dry', 'g', 1.00)}, ${prod(UMG, 'UMG', 'dry', 'MG', 1.00)}, ${prod(UKG, 'UKG', 'dry', 'kg', 1.00)},
      ${prod(UEA, 'UEA', 'dry', 'Ea', 5.00)}, ${prod(UZZ, 'UZZ', 'dry', 'Zz', 5.00)}, ${prod(UNULL, 'UNULL', 'dry', 'Lb', null)},
      ${prod(UZERO, 'UZERO', 'dry', 'Lb', 0)}, ${prod(AEG, 'AEG', 'liquid', 'Gal', 30.00)}, ${prod(BIGG, 'BIGG', 'liquid', 'Gal', 200.00)},
      ${prod(E1G, 'E1G', 'liquid', 'Gal', 10.00)}, ${prod(E2G, 'E2G', 'liquid', 'Gal', 10.00, true, '100-55')},
      ${prod(E3G, 'E3G', 'liquid', 'Gal', 10.00)}, ${prod(E4G, 'E4G', 'liquid', 'Gal', 10.00)}, ${prod(E5G, 'E5G', 'liquid', 'Gal', 10.00)},
      ${prod(INACTG, 'INACTG', 'liquid', 'Gal', 10.00)}, ${prod(REFBULK, 'REFBULK', 'liquid', 'Gal', 10.00, false)},
      ${prod(REFA, 'REFA', 'liquid', 'Gal', 10.00)}, ${prod(REFB, 'REFB', 'liquid', 'Gal', 12.00)},
      ${prod(DUP1G, 'DUP1G', 'liquid', 'Gal', 10.00)}, ${prod(DUP2G, 'DUP2G', 'liquid', 'Gal', 10.00)},
      ${prod(STALEG, 'STALEG', 'liquid', 'Gal', 10.00)}, ${prod(STALEJOIN, 'STALEJOIN', 'liquid', 'Gal', 10.00)},
      ${prod(SWITCHG, 'SWITCHG', 'liquid', 'Gal', 10.00)}, ${prod(DM4G, 'DM4G', 'liquid', 'Gal', 10.00)};
    INSERT INTO public.product_parents (id, name, product_form, formulation_type, category, generic_epa_registration, is_active, created_by, updated_by) VALUES
      ${parent(PGLY, 'PGLY', 'liquid')}, ${parent(PPRE, 'PPRE', 'liquid')}, ${parent(PPCT, 'PPCT', 'liquid')}, ${parent(PDRY, 'PDRY', 'dry')},
      ${parent(PHALF, 'PHALF', 'dry')}, ${parent(PFERT, 'PFERT', 'liquid')}, ${parent(PFDRY, 'PFDRY', 'dry')}, ${parent(PMET, 'PMET', 'liquid')},
      ${parent(PSEED, 'PSEED', 'seed')}, ${parent(PUNIT, 'PUNIT', 'dry')}, ${parent(PAE, 'PAE', 'liquid')}, ${parent(PBIG, 'PBIG', 'liquid')},
      ${parent(PEPA1, 'PEPA1', 'liquid', '100-44')}, ${parent(PEPA2, 'PEPA2', 'liquid')}, ${parent(PEPA3, 'PEPA3', 'liquid')},
      ${parent(PEPA4, 'PEPA4', 'liquid')}, ${parent(PEPA5, 'PEPA5', 'liquid')}, ${parent(PINACT, 'PINACT', 'liquid', null, false)},
      ${parent(PNOSIZE, 'PNOSIZE', 'liquid')}, ${parent(PREF, 'PREF', 'liquid')}, ${parent(PDUP1, 'PDUP1', 'liquid')},
      ${parent(PDUP2, 'PDUP2', 'liquid')}, ${parent(PRACE, 'PRACE', 'liquid')}, ${parent(PSTALE, 'PSTALE', 'liquid')},
      ${parent(PSWITCH, 'PSWITCH', 'liquid')}, ${parent(PDM4, 'PDM4', 'liquid', '100-66')};
    INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by) VALUES
      ${member(GBULK, PGLY, 'bulk')}, ${member(GQT, PGLY)}, ${member(GOZ, PGLY)}, ${member(PREG, PPRE, 'bulk')}, ${member(PCTG, PPCT, 'bulk')},
      ${member(DLB, PDRY)}, ${member(DOZ, PDRY)}, ${member(HALFLB, PHALF, 'bulk')}, ${member(FERTG, PFERT, 'bulk')}, ${member(FDLB, PFDRY, 'bulk')},
      ${member(METG, PMET, 'bulk')}, ${member(SEEDEA, PSEED)}, ${member(UG, PUNIT)}, ${member(UMG, PUNIT)}, ${member(UKG, PUNIT)}, ${member(UEA, PUNIT)},
      ${member(UZZ, PUNIT)}, ${member(UNULL, PUNIT)}, ${member(UZERO, PUNIT)}, ${member(AEG, PAE, 'bulk')}, ${member(BIGG, PBIG, 'bulk')},
      ${member(E1G, PEPA1)}, ${member(E2G, PEPA2)}, ${member(E3G, PEPA3)}, ${member(E4G, PEPA4)}, ${member(E5G, PEPA5)},
      ${member(INACTG, PINACT)}, ${member(REFBULK, PREF, 'bulk')}, ${member(REFA, PREF)}, ${member(REFB, PREF)},
      ${member(DUP1G, PDUP1)}, ${member(DUP2G, PDUP2)}, ${member(STALEG, PSTALE)}, ${member(SWITCHG, PSWITCH)}, ${member(DM4G, PDM4)};
    INSERT INTO public.product_parent_brands (parent_id, brand_name, epa_registration, status, created_by, updated_by) VALUES
      ('${PEPA3}', '[PROVER] Brand3', '100-77', 'active', '${ADMIN}', '${ADMIN}'),
      ('${PEPA5}', '[PROVER] Brand5', '100-88', 'retired', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_brands (product_id, brand_name, epa_registration, created_by, updated_by) VALUES ('${E4G}', '[PROVER] Legacy4', '100-99', '${ADMIN}', '${ADMIN}');
    CREATE TABLE public.dm1_standin_density (parent_id uuid PRIMARY KEY, lb_per_gal numeric, weight_row_id uuid);
    ALTER TABLE public.dm1_standin_density OWNER TO postgres;
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  console.log('[prover] seeded four users, units, 26 parents (cost, gate, reference, duplicate and race cases) and 35 sizes');
}

async function main() {
  if (REUSE) {
    const label = docker(['inspect', '--format', '{{index .Config.Labels "crx.prover"}}', NAME]).stdout.trim();
    if (label !== OWNER_LABEL_VALUE) throw new Error(`CRX_DM1_CONTAINER=${NAME} was not created by this proof (label crx.prover='${label}'); refusing to drop its databases.`);
    DB = 'template1';
    psql('DROP DATABASE IF EXISTS dm1work WITH (FORCE);', { user: 'supabase_admin' });
    psql('DROP DATABASE IF EXISTS dm1stub WITH (FORCE);', { user: 'supabase_admin' });
    psql('CREATE DATABASE dm1work TEMPLATE dm1base OWNER postgres;', { user: 'supabase_admin' });
    DB = 'dm1work';
  } else {
    buildContainer();
    if (KEEP) {
      DB = 'template1';
      psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres';", { user: 'supabase_admin' });
      psql('CREATE DATABASE dm1base TEMPLATE postgres OWNER postgres;', { user: 'supabase_admin' });
      DB = 'postgres';
      console.log(`[prover] kept container ${NAME} with a replayed copy dm1base (rerun with CRX_DM1_CONTAINER=${NAME})`);
    }
  }
  seedBeforeCandidate();
  const CAND = lf(CANDIDATE);
  stageText('cand.sql', CAND);
  const WORK = DB;

  // ---- Preflight refusals (each rolls back whole).
  psql(`ALTER TABLE public.ingredient_map DISABLE TRIGGER USER;`);
  const imCols = owner(`SELECT string_agg(column_name || ':' || is_nullable || ':' || COALESCE(column_default, ''), ',' ORDER BY ordinal_position)
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ingredient_map';`);
  assert.ok(imCols.length > 0, 'ingredient_map exists');
  const imAclBefore = owner(`SELECT COALESCE(relacl::text, '') || '|' || COALESCE((SELECT string_agg(polname || ':' || pg_get_expr(polqual, polrelid), ',' ORDER BY polname)
    FROM pg_policy WHERE polrelid = 'public.ingredient_map'::regclass), '') FROM pg_class WHERE oid = 'public.ingredient_map'::regclass;`);
  stageText('pre-wrong.sql', `DROP FUNCTION public._approved_parent_lb_per_gal(uuid);
    CREATE FUNCTION public._approved_parent_lb_per_gal(p_parent_id uuid, OUT lb_per_gal numeric, OUT weight_row_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $x$ SELECT NULL::numeric, NULL::uuid $x$;
    GRANT EXECUTE ON FUNCTION public._approved_parent_lb_per_gal(uuid) TO authenticated;
    \\i /tmp/cand.sql`);
  let r = apply('pre-wrong.sql');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /PREFLIGHT_DM1_DENSITY_INTERFACE_CHANGED/, r.output);
  stageText('pre-volatile.sql', `ALTER FUNCTION public._approved_parent_lb_per_gal(uuid) VOLATILE;\n\\i /tmp/cand.sql`);
  r = apply('pre-volatile.sql');
  assert.match(r.output, /PREFLIGHT_DM1_DENSITY_INTERFACE_CHANGED/, r.output);
  assert.equal(owner(`SELECT provolatile FROM pg_proc WHERE oid = 'public._approved_parent_lb_per_gal(uuid)'::regprocedure;`), 's', 'the refused apply rolled back');
  const imSample = owner(`SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ingredient_map' AND is_nullable = 'NO' AND column_default IS NULL;`);
  console.log(`[prover] ingredient_map required columns: ${imSample || '(none)'}`);
  const imFill = imSample ? imSample.split(',') : [];
  const imSeed = imFill.length === 0 ? 'INSERT INTO public.ingredient_map DEFAULT VALUES;'
    : `INSERT INTO public.ingredient_map (${imFill.join(',')}) VALUES (${imFill.map((c) => owner(`SELECT CASE data_type WHEN 'uuid' THEN 'gen_random_uuid()' WHEN 'numeric' THEN '1' WHEN 'integer' THEN '1'
      WHEN 'boolean' THEN 'false' ELSE '''x''' END FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ingredient_map' AND column_name = '${c}';`)).join(',')});`;
  stageText('pre-map.sql', `${imSeed}\n\\i /tmp/cand.sql`);
  r = apply('pre-map.sql');
  assert.match(r.output, /PREFLIGHT_DM1_INGREDIENT_MAP_NOT_EMPTY/, r.output);
  assert.equal(owner('SELECT count(*) FROM public.ingredient_map;'), '0');
  assert.equal(owner("SELECT to_regclass('public.active_ingredients') IS NULL;"), 't', 'a refused apply leaves no object');
  console.log('[prover] preflight: a wrong-shaped or volatile DM-2 weight function, and a row in ingredient_map, each refuse the apply and leave nothing');

  // ---- DM-1 first (DM-2's function absent): the stub is created, refuses % w/w liquids, and a replacement leaves DM-1 alone.
  DB = 'template1';
  psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${WORK}' AND pid <> pg_backend_pid();`, { user: 'supabase_admin' });
  psql(`DROP DATABASE IF EXISTS dm1stub WITH (FORCE); CREATE DATABASE dm1stub TEMPLATE ${WORK} OWNER postgres;`.split('; ').join(';\n'), { user: 'supabase_admin' });
  DB = 'dm1stub';
  stageText('stub.sql', `DROP FUNCTION public._approved_parent_lb_per_gal(uuid);\n\\i /tmp/cand.sql`);
  r = apply('stub.sql');
  assert.equal(r.status, 0, r.output);
  noExecute('public._approved_parent_lb_per_gal(uuid)');
  assert.equal(owner(`SELECT prosecdef::text || provolatile::text || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public._approved_parent_lb_per_gal(uuid)'::regprocedure;`),
    'trues' + 'search_path=public, pg_temp');
  ok(ADMIN, setC(PPCT, [{ kind: 'ingredient', name: 'Stub active', strength_value: 25, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'label' }]));
  assert.equal(fig(costs(PPCT).parent_figures, 'Stub active').reason, 'DENSITY_NOT_APPROVED');
  const before = dm1FunctionsMd5();
  psql(STANDIN);
  noExecute('public._approved_parent_lb_per_gal(uuid)');
  assert.equal(dm1FunctionsMd5(), before, 'replacing the weight function changes no DM-1 function');
  density(PPCT, 10);
  assert.equal(fig(costs(PPCT).parent_figures, 'Stub active').cents, '1200', '$30.00/gal at 25% w/w of 10 lb/gal = 1200 cents per lb');
  DB = 'template1';
  psql('DROP DATABASE dm1stub WITH (FORCE);', { user: 'supabase_admin' });
  DB = WORK;
  console.log('[prover] DM-1 first: the stub is created private, refuses % w/w liquids (DENSITY_NOT_APPROVED); a stand-in replacement works and changes no DM-1 function');

  // ---- The real apply after DM-2 (its function is checked and left alone).
  const dm2Before = owner(`SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._approved_parent_lb_per_gal(uuid)'::regprocedure;`);
  stageText('fix.sql', lf(FOLLOW_UPS[0]));
  r = apply('fix.sql');
  assert.match(r.output, /PREFLIGHT_DM1_MISSING/, 'the landing fixes refuse to run before DM-1');
  r = apply('cand.sql');
  assert.equal(r.status, 0, r.output);
  ledger(path.basename(CANDIDATE, '.sql'));
  assert.equal(owner(`SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._approved_parent_lb_per_gal(uuid)'::regprocedure;`), dm2Before, 'DM-2 function left alone');
  r = apply('cand.sql');
  assert.match(r.output, /PREFLIGHT_DM1_ALREADY_PRESENT/, 'a second apply is refused');
  noExecute('public._approved_parent_lb_per_gal(uuid)');
  console.log('[prover] applied after DM-2: its weight function is kept unchanged and still private; a second apply is refused');

  // ---- Landing fixes on top, as live gets them: a row written before keeps its values and reads as typed.
  ok(ADMIN, setC(PSEED, [{ kind: 'ingredient', name: 'Pre-fix active', strength_value: 1, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'label', ref: 'p' },
    { kind: 'mode_of_action', ingredient_ref: 'p', scheme: 'FRAC', group_code: '4' }]));
  const preFix = () => owner(`SELECT string_agg(to_jsonb(m)::text, ',') FROM (SELECT id, ingredient_id, scheme, group_code, status, row_version
    FROM public.product_parent_modes_of_action WHERE parent_id = '${PSEED}') m;`);
  const preFixRows = preFix();
  r = apply('fix.sql');
  assert.equal(r.status, 0, r.output);
  ledger(path.basename(FOLLOW_UPS[0], '.sql'));
  assert.equal(preFix(), preFixRows, 'the fixes changed no existing row');
  assert.equal(owner(`SELECT string_agg(source, ',') FROM public.product_parent_modes_of_action WHERE parent_id = '${PSEED}';`), 'typed');
  r = apply('fix.sql');
  assert.match(r.output, /PREFLIGHT_DM1_FIXES_ALREADY_PRESENT/, 'a second apply of the fixes is refused');
  noExecute('public._chemistry_kept_modes(jsonb,uuid,uuid)');
  console.log('[prover] landing fixes: refused before DM-1, applied after it with no existing row changed (old modes of action read typed), a second apply refused');

  // ---- Catalogue: RLS, grants, owners, function security.
  for (const t of DM1_TABLES) {
    assert.equal(owner(`SELECT relrowsecurity::text || pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.${t}'::regclass;`), 'truepostgres', t);
    for (const role of ['anon', 'service_role', 'metabase_ro']) {
      assert.equal(owner(`SELECT count(*) FROM pg_class, aclexplode(relacl) a WHERE oid = 'public.${t}'::regclass AND a.grantee = '${role}'::regrole;`), '0', `${role} on ${t}`);
    }
    assert.equal(owner(`SELECT string_agg(a.privilege_type, ',') FROM pg_class, aclexplode(relacl) a WHERE oid = 'public.${t}'::regclass AND a.grantee = 'authenticated'::regrole;`), 'SELECT', t);
  }
  const fnRows = owner(`SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
    AND (p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] OR pg_get_userbyid(p.proowner) <> 'postgres')
    AND p.proname = ANY(${q('{' + DM1_FUNCTIONS.join(',') + '}')}::text[]);`);
  assert.equal(fnRows, '0', 'every DM-1 definer function is owned by postgres with the pinned search_path');
  assert.ok(DM1_FUNCTIONS.length >= 39, 'the candidate function list was read');
  const PUBLIC_RPCS = ['set_parent_chemistry(uuid,bigint,jsonb,text)', 'preview_parent_chemistry_correction(uuid,jsonb)',
    'correct_parent_chemistry(uuid,bigint,text,jsonb,text,text,text)', 'preview_active_ingredient_change(uuid,jsonb)',
    'save_active_ingredient(uuid,integer,text,jsonb,text,text,text)', 'retire_active_ingredient(uuid,integer,text,text)',
    'reactivate_active_ingredient(uuid,integer,text,text)', 'set_parent_cost_reference(uuid,uuid,integer,text)',
    'get_parent_chemistry(uuid)', 'search_active_ingredients(text,integer)', 'get_active_ingredient_worklist()', 'get_parent_active_costs(uuid)'];
  for (const s of PUBLIC_RPCS) {
    assert.equal(owner(`SELECT prosecdef::text || array_to_string(proconfig, ',') || pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'public.${s}'::regprocedure;`),
      'truesearch_path=public, pg_temppostgres', s);
    assert.equal(owner(`SELECT has_function_privilege('authenticated', 'public.${s}'::regprocedure, 'EXECUTE')::text
      || has_function_privilege('anon', 'public.${s}'::regprocedure, 'EXECUTE')::text
      || has_function_privilege('service_role', 'public.${s}'::regprocedure, 'EXECUTE')::text;`), 'truefalsefalse', s);
  }
  const PRIVATE = owner(`SELECT string_agg(p.oid::regprocedure::text, ' ') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('_resolve_active_ingredient', '_ingredient_cas_valid', '_parent_chemistry_epa_refusal', '_lock_parent_chemistry',
      '_parent_chemistry_values', '_apply_parent_chemistry', '_unit_factor_oz', '_chemistry_convert', '_parent_active_cost_rows',
      '_cents_half_up', '_size_cost_per_base', '_oxide_factor', '_chemistry_form_mass', '_active_ingredient_values',
      '_active_ingredient_event', '_chemistry_uuid', '_check_parent_chemistry', '_chemistry_strength', '_chemistry_nutrient',
      '_ingredient_usage_parents', '_ingredient_users', '_chemistry_preview_fingerprint', '_ingredient_usage_fingerprint',
      '_lock_ingredient_parents', '_edit_active_ingredient', '_chemistry_kept_modes');`).split(' ');
  assert.equal(PRIVATE.length, 26, `private helpers: ${PRIVATE.join(' ')}`);
  for (const s of PRIVATE) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(owner(`SELECT has_function_privilege('${role}', '${s}'::regprocedure, 'EXECUTE');`), 'f', `${role} can run ${s}`);
    }
  }
  console.log('[prover] catalogue: 8 tables RLS on, owned by postgres, SELECT only for authenticated; 12 RPCs and 26 helpers definer-safe, helpers private');

  // ---- ingredient_map is frozen; its grants and policies are unchanged.
  assert.equal(owner(`SELECT COALESCE(relacl::text, '') || '|' || COALESCE((SELECT string_agg(polname || ':' || pg_get_expr(polqual, polrelid), ',' ORDER BY polname)
    FROM pg_policy WHERE polrelid = 'public.ingredient_map'::regclass), '') FROM pg_class WHERE oid = 'public.ingredient_map'::regclass;`), imAclBefore);
  refused(OWNER, 'INSERT INTO public.ingredient_map DEFAULT VALUES;', /INGREDIENT_MAP_RETIRED/);
  // UPDATE/DELETE on an empty table fire no row trigger; seed a row with the trigger off, then try each.
  psql(`ALTER TABLE public.ingredient_map DISABLE TRIGGER ingredient_map_read_only;
    ${imSeed}
    ALTER TABLE public.ingredient_map ENABLE TRIGGER ingredient_map_read_only;`);
  assert.equal(owner('SELECT count(*) FROM public.ingredient_map;'), '1');
  {
    const col = owner(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ingredient_map' ORDER BY ordinal_position LIMIT 1;`);
    refused(OWNER, `UPDATE public.ingredient_map SET ${col} = ${col};`, /INGREDIENT_MAP_RETIRED/);
    refused(OWNER, 'DELETE FROM public.ingredient_map;', /INGREDIENT_MAP_RETIRED/);
  }
  const tr = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
    { allowFailure: true, input: 'BEGIN; SET LOCAL ROLE service_role; TRUNCATE public.ingredient_map; COMMIT;' });
  assert.notEqual(tr.status, 0);
  assert.match(`${tr.stdout}${tr.stderr}`, /INGREDIENT_MAP_RETIRED|permission denied/);
  refused(OWNER, 'TRUNCATE public.ingredient_map;', /INGREDIENT_MAP_RETIRED/);
  console.log('[prover] ingredient_map: insert, update, delete and truncate are refused with the retired message; grants and policies unchanged');

  // ---- Stand-in weight per gallon for the rest of the proof (DM-2's real draft-only case first).
  psql(`SELECT public._save_parent_density_draft('${PPCT}', 0, 10, 'lb_per_gal', 'sds', NULL, NULL, NULL);`);
  ok(ADMIN, setC(PPCT, [{ kind: 'ingredient', name: 'Pct active', strength_value: 25, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'label' }]));
  assert.equal(fig(costs(PPCT).parent_figures, 'Pct active').reason, 'DENSITY_NOT_APPROVED', 'a DM-2 draft weight never counts');
  psql(STANDIN);
  noExecute('public._approved_parent_lb_per_gal(uuid)');
  density(PPCT, 10);
  assert.equal(fig(costs(PPCT).parent_figures, 'Pct active').cents, halfUp(div(F('3000'), F('0.25', '10'))));
  assert.equal(fig(costs(PPCT).parent_figures, 'Pct active').cents, '1200');
  assert.equal(costs(PPCT).parent_figures[0].weight_row_id, id('d' + PPCT.slice(-3)), 'each figure carries the weight row it used');
  for (const [lb, rid, reason] of [[0, 'x', 'DENSITY_INVALID'], ["'NaN'", 'x', 'DENSITY_INVALID'], [21, 'x', 'DENSITY_INVALID'], [10, null, 'DENSITY_INVALID']]) {
    density(PPCT, lb, rid === 'x' ? undefined : rid);
    assert.equal(fig(costs(PPCT).parent_figures, 'Pct active').reason, reason, `weight ${lb}`);
  }
  density(PPCT, 10);
  // Actives heavier than the product (2.5 + 12 lb in a 10 lb gallon) refuse every figure, fertilizer included (Codex App).
  // Saving them is refused while the weight is approved (Sol round 8); saved while it is unusable, the read still refuses.
  const heavyIn = [ing('Heavy active', 12), { kind: 'fertilizer', nutrient: 'N', basis: 'elemental', percent: 10, source: 'label' }];
  refused(ADMIN, setC(PPCT, heavyIn), /CHEMISTRY_TOTAL_IMPOSSIBLE: the ingredients weigh more than the product's approved 10 lb\/gal/);
  density(PPCT, 0);
  ok(ADMIN, setC(PPCT, heavyIn));
  density(PPCT, 10);
  const heavy = costs(PPCT).parent_figures;
  assert.equal(heavy.length, 3, JSON.stringify(heavy));
  for (const f of heavy) assert.equal(f.figure.reason, 'STRENGTH_EXCEEDS_DENSITY', JSON.stringify(f));
  ok(ADMIN, corrC(PPCT, [{ kind: 'ingredient', action: 'retire', row_id: rowId(PPCT, ingId('Heavy active')) }]));
  assert.equal(fig(costs(PPCT).parent_figures, 'N').cents !== undefined, true, 'with the heavy row gone the fertilizer figure computes');
  // Exactly the product's weight saves (2.5 lb from 25% w/w + 7.5 lb/gal = 10); 7.6 is refused.
  refused(ADMIN, setC(PPCT, [ing('Fit active', 7.6)]), /CHEMISTRY_TOTAL_IMPOSSIBLE: the ingredients weigh more/);
  ok(ADMIN, setC(PPCT, [ing('Fit active', 7.5)]));
  console.log('[prover] DM-2 live: a draft weight gives DENSITY_NOT_APPROVED; stand-in 10 lb/gal gives 1200 cents; 0, NaN, 21 and a missing row ID give DENSITY_INVALID; actives heavier than an approved weight are refused at save (exactly the weight saves), and saved under an unusable weight they refuse every figure, fertilizer included');

  // ---- Hand-checked cost cases.
  const glyAcid = js(ADMIN, createI({ name: 'Glyphosate', cas: '1071-83-6', is_parent_form: true })).ingredient.id;
  ok(ADMIN, setC(PGLY, [ing('Glyphosate IPA salt', 4, { cas: '38641-94-0', canonical_ingredient_id: glyAcid, canonical_fraction: 0.741, fraction_basis: 'acid_equivalent' })]));
  let c = costs(PGLY);
  assert.equal(c.reference.source, 'bulk');
  const gly = (sid, cost) => {
    const f = sizeFigs(c, sid).find((x) => x.name === 'Glyphosate IPA salt');
    assert.equal(f.figure.cents, halfUp(div(cost, F('4'))), `${sid} ai`);
    assert.equal(f.converted.cents, halfUp(div(cost, F('4', '0.741'))), `${sid} ae`);
    return [f.figure.cents, f.converted.cents];
  };
  assert.deepEqual(gly(GBULK, F('2000')), ['500', '675']);           // $20.00/gal; 2000/4; 2000/2.964 = 674.76
  assert.deepEqual(gly(GQT, div(F('600', '128'), F('32'))), ['600', '810']);  // $6.00/qt = $24/gal
  assert.deepEqual(gly(GOZ, F('50', '128')), ['1600', '2159']);      // $0.50/oz = $64/gal; 6400/2.964 = 2159.24
  assert.equal(fig(c.parent_figures, 'Glyphosate IPA salt').cents, '500', 'parent figures are the bulk size');
  assert.equal(c.parent_figures[0].label, 'from catalog cost');

  ok(ADMIN, setC(PPRE, [ing('Premix A', 2), ing('Premix B', 1), ing('Premix C', 0.5)]));
  c = costs(PPRE);
  assert.deepEqual(['Premix A', 'Premix B', 'Premix C'].map((n) => fig(c.parent_figures, n).cents), ['2250', '4500', '9000']);
  assert.equal(c.parent_figures.length, 3, 'three actives, three figures, never summed');

  const pct = (name, v) => ({ kind: 'ingredient', name, strength_value: v, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'label' });
  ok(ADMIN, setC(PDRY, [pct('Dry active', 75)]));
  ok(ADMIN, `SELECT public.set_parent_cost_reference('${PDRY}', '${DLB}', 0, ${q(key())});`);
  c = costs(PDRY);
  assert.equal(fig(sizeFigs(c, DLB), 'Dry active').cents, halfUp(div(F('800'), F('0.75'))));
  assert.equal(fig(sizeFigs(c, DLB), 'Dry active').cents, '1067');                       // $8.00/lb / 0.75 = 1066.67
  assert.equal(fig(sizeFigs(c, DOZ), 'Dry active').cents, '1600');                       // $0.75/dry oz = $12/lb / 0.75
  assert.equal(fig(c.parent_figures, 'Dry active').cents, '1067', 'picked reference');

  ok(ADMIN, setC(PHALF, [pct('Half active', 40)]));
  assert.equal(fig(costs(PHALF).parent_figures, 'Half active').cents, '13', '$0.05/lb at 40% = 12.5 cents, half-up to 13');

  ok(ADMIN, setC(PAE, [ing('Glyphosate DMA salt', 3, { strength_basis: 'acid_equivalent', canonical_ingredient_id: glyAcid })]));
  c = costs(PAE);
  assert.equal(c.parent_figures.length, 1);
  assert.equal(c.parent_figures[0].figure.basis, 'acid_equivalent');
  assert.equal(c.parent_figures[0].figure.cents, '1000');
  assert.equal(c.parent_figures[0].converted, null, 'an ae-stated strength produces no ai figure');

  const nut = (nutrient, basis, percent) => ({ kind: 'fertilizer', nutrient, basis, percent, source: 'label' });
  ok(ADMIN, setC(PFERT, [nut('N', 'elemental', 10), nut('P', 'oxide', 10), nut('K', 'oxide', 20)]));
  density(PFERT, 11);
  c = costs(PFERT);
  const K_RATIO = div(F('78.1966'), F('94.1956'));
  const PR = div(F('61.947524'), F('141.942524'));
  assert.equal(fig(c.parent_figures, 'P').cents, '1000');                                 // $11/gal / (0.10 x 11 lb/gal)
  assert.equal(fig(c.parent_figures, 'P', 'elemental').cents, halfUp(div(F('1100'), mul(F('0.10', '11'), PR))));
  assert.equal(fig(c.parent_figures, 'K').cents, '500');
  assert.equal(fig(c.parent_figures, 'K', 'elemental').cents, halfUp(div(F('1100'), mul(F('0.20', '11'), K_RATIO))));
  assert.equal(fig(c.parent_figures, 'N').cents, '1000');
  assert.equal(fig(c.parent_figures, 'N').basis, 'elemental');
  ok(ADMIN, setC(PFDRY, [nut('P', 'oxide', 100)]));
  c = costs(PFDRY);
  assert.equal(fig(c.parent_figures, 'P').cents, '10000');
  // 100% P2O5 at $100/lb: 10000 x 141.942524 / 61.947524 = 22913.35..., so 22913, not 10000 / 0.4364 = 22914.76 -> 22915.
  assert.equal(fig(c.parent_figures, 'P', 'elemental').cents, '22913');
  assert.equal(halfUp(div(F('10000'), F('0.4364'))), '22915', 'the rounded decimal would give another cent');

  ok(ADMIN, setC(PMET, [ing('S-metolachlor', 7.64, { cas: '87392-12-9' }), ing('Metolachlor', 1, { cas: '51218-45-2' })]));
  c = costs(PMET);
  assert.equal(fig(c.parent_figures, 'S-metolachlor').cents, halfUp(div(F('4000'), F('7.64'))));
  assert.equal(fig(c.parent_figures, 'Metolachlor').cents, '4000');
  assert.ok(c.parent_figures.every((f) => f.converted === null), 'no conversion between isomer and racemate');

  ok(ADMIN, setC(PBIG, [ing('Tiny active', 0.0001)]));
  assert.equal(fig(costs(PBIG).parent_figures, 'Tiny active').cents, '200000000', '$2,000,000.00 per lb as an exact string');
  console.log('[prover] hand-checked: glyphosate bulk/Qt/Oz ai and ae (0.741), three-active premix, % w/w liquid, dry Lb and Dry oz, half-cent rounding, ae-stated, fertilizer oxide/elemental liquid and dry (exact ratio), isomers apart, $2M/lb exact');

  // ---- Refusals by name.
  ok(ADMIN, setC(PUNIT, [pct('Unit active', 50)]));
  c = costs(PUNIT);
  const reasonOf = (sid) => sizeFigs(c, sid)[0].figure.reason;
  assert.deepEqual([UG, UMG, UKG, UEA, UZZ, UNULL, UZERO].map(reasonOf),
    ['UNIT_NOT_SUPPORTED', 'UNIT_NOT_SUPPORTED', 'UNIT_NOT_SUPPORTED', 'UNIT_IS_COUNT', 'UNIT_UNKNOWN', 'COST_MISSING', 'COST_MISSING']);
  assert.equal(c.reference.reason, 'REFERENCE_UNSET');
  assert.equal(c.parent_figures, null);
  ok(ADMIN, setC(PSEED, [pct('Seed treatment', 1)]));
  assert.equal(sizeFigs(costs(PSEED), SEEDEA)[0].figure.reason, 'FORM_NOT_COSTED');
  refused(ADMIN, setC(PDRY, [ing('Dry lbgal', 1)]), /CHEMISTRY_UNIT_NOT_FOR_FORM/);
  refused(ADMIN, setC(PDRY, [pct('Zero active', 0)]), /strength|STRENGTH|CHEMISTRY/);
  ok(ADMIN, setC(PMET, [{ kind: 'ingredient', name: 'Unknown strength active', strength_value: null, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label' }]));
  assert.equal(fig(costs(PMET).parent_figures, 'Unknown strength active').reason, 'STRENGTH_UNKNOWN');
  const cpb = (cost, unit, t) => JSON.parse(owner(`SELECT public._size_cost_per_base(${cost}, ${q(unit)}, ${q(t)});`));
  assert.equal(cpb("'NaN'", 'Gal', 'liquid').reason, 'COST_INVALID');
  assert.equal(cpb("'Infinity'", 'Gal', 'liquid').reason, 'COST_INVALID');
  assert.equal(cpb(-1, 'Gal', 'liquid').reason, 'COST_INVALID');
  assert.equal(cpb(1.001, 'Gal', 'liquid').reason, 'COST_NOT_CENTS');
  assert.equal(cpb(0, 'Gal', 'liquid').reason, 'COST_MISSING');
  assert.equal(cpb(1, 'Unit', 'dry').reason, 'UNIT_IS_COUNT');
  assert.equal(cpb(6, 'qt', 'liquid').cents, '2400');
  // A unit with one unusable spelling is refused, not costed from the other (Sol round 8); a disagreeing one too.
  for (const bad of ['-1', "'NaN'", '2']) {  // factor_oz is NOT NULL
    fixture(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('QT', ${bad}, 'liquid');`);
    assert.equal(cpb(6, 'qt', 'liquid').reason, 'UNIT_UNKNOWN', `a QT spelling with factor ${bad}`);
    fixture(`DELETE FROM public.unit_conversions WHERE unit = 'QT';`);
  }
  assert.equal(cpb(6, 'qt', 'liquid').cents, '2400');
  console.log('[prover] refusals by name: g, MG and kg (UNIT_NOT_SUPPORTED), Ea, unknown unit, a unit with a bad or disagreeing second spelling, missing and zero cost, seed parent, lb/gal on dry, zero strength, unknown strength, unset reference, bad prices');

  // ---- Mutation: removing the salt's fraction makes the ae figure a refusal, never the ai number.
  const salt = ingId('Glyphosate IPA salt');
  const saltFields = { canonical_fraction: null, fraction_basis: null };
  refused(ADMIN, saveI(salt, saltFields), /REASON_REQUIRED/);
  ok(ADMIN, saveI(salt, saltFields, 'fraction disputed', 'supplier email'));
  c = costs(PGLY);
  assert.equal(fig(c.parent_figures, 'Glyphosate IPA salt', 'acid_equivalent').reason, 'FRACTION_UNKNOWN');
  assert.equal(fig(c.parent_figures, 'Glyphosate IPA salt').cents, '500');
  assert.equal(owner(`SELECT count(*) FROM public.product_chemistry_events WHERE parent_id = '${PGLY}' AND event_type = 'corrected'
    AND after_values->>'source_path' = 'ingredient_edit';`), '1', 'the ingredient edit bumped the using parent');
  ok(ADMIN, saveI(salt, { canonical_fraction: 0.741, fraction_basis: 'acid_equivalent' }, 'fraction restored', 'label'));
  assert.equal(fig(costs(PGLY).parent_figures, 'Glyphosate IPA salt', 'acid_equivalent').cents, '675');
  console.log('[prover] mutation: clearing the IPA salt fraction turns its ae figure into FRACTION_UNKNOWN (ai stays 500); restoring it gives 675 again');

  // ---- Gate (D-Z).
  const add = (n) => [ing(`Gate ${n}`, 1)];
  for (const p of [PEPA1, PEPA2, PEPA3, PEPA4]) {
    refused(ADMIN, setC(p, add(p)), /CHEMISTRY_FROM_EPA_ONLY/);
    // A refused preview hands back no fingerprint (Sol round 2); the save's own gate is checked with the real one.
    const gch = [{ kind: 'ingredient', action: 'retire', row_id: id('fff') }];
    assert.equal(prevC(p, gch).preview_fingerprint, null, 'a refused preview gives no fingerprint');
    refused(ADMIN, corrC(p, gch, undefined, undefined, { fp: null }), /CHEMISTRY_PREVIEW_CHANGED/);
    const gfp = owner(`SELECT public._chemistry_preview_fingerprint('${p}', ${J(gch)});`);
    refused(ADMIN, corrC(p, gch, undefined, undefined, { fp: gfp }), /CHEMISTRY_FROM_EPA_ONLY|CHEMISTRY_ROW|NOT_FOUND|ROW/);
  }
  ok(ADMIN, setC(PEPA5, add('5')));
  assert.equal(owner(`SELECT count(*) FROM public.product_parent_ingredients WHERE parent_id IN ('${PEPA1}', '${PEPA2}', '${PEPA3}', '${PEPA4}');`), '0');
  // DM-4 stand-in: the private writer on an EPA-numbered parent works (owner, with a session uid), set does not.
  refused(ADMIN, setC(PDM4, add('dm4')), /CHEMISTRY_FROM_EPA_ONLY/);
  const dm4 = ok(OWNER, `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
    SELECT public._lock_parent_chemistry('${PDM4}', 0);
    SELECT public._apply_parent_chemistry('${PDM4}', ${J([{ kind: 'ingredient', name: 'EPA active', strength_value: 2, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'epa_lookup' }])}, 'epa', NULL, NULL)->>'changed';`);
  assert.equal(dm4, 'true');
  // EPA-confirmed modes of action (Sol round 8). Typed rows from before the number arrived, then the EPA lookup
  // confirms one existing mode (it becomes epa_lookup) and adds one: retiring that typed row is refused; a typed
  // row with no confirmed mode still retires. Swaps and mode-of-action retires stay refused on a gated parent.
  fixture(`UPDATE public.product_parents SET generic_epa_registration = NULL WHERE id = '${PDM4}';`);
  ok(ADMIN, setC(PDM4, [ing('Typed then EPA', 1, { ref: 't' }), ing('Typed only', 1), { kind: 'mode_of_action', ingredient_ref: 't', scheme: 'HRAC', group_code: '2' },
    { kind: 'mode_of_action', ingredient_ref: 't', scheme: 'HRAC', group_code: '3' }]));
  fixture(`UPDATE public.product_parents SET generic_epa_registration = '100-66' WHERE id = '${PDM4}';`);
  const tte = ingId('Typed then EPA');
  const epaWrite = (changes) => ok(OWNER, `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
    SELECT public._lock_parent_chemistry('${PDM4}', ${ver(PDM4)});
    SELECT public._apply_parent_chemistry('${PDM4}', ${J(changes)}, 'epa', NULL, NULL)->>'changed';`);
  assert.equal(epaWrite([{ kind: 'mode_of_action', ingredient_id: tte, scheme: 'HRAC', group_code: '2' },
    { kind: 'mode_of_action', ingredient_id: tte, scheme: 'HRAC', group_code: '4' }]), 'true');
  const dm4Moa = () => owner(`SELECT string_agg(group_code || ':' || source, ',' ORDER BY group_code) FROM public.product_parent_modes_of_action
    WHERE parent_id = '${PDM4}' AND ingredient_id = '${tte}' AND status = 'active';`);
  assert.equal(dm4Moa(), '2:epa_lookup,3:typed,4:epa_lookup', 'the lookup confirmed 2 and added 4; 3 stays typed');
  assert.equal(epaWrite([{ kind: 'mode_of_action', ingredient_id: tte, scheme: 'HRAC', group_code: '2' }]), 'false', 'confirming again changes nothing');
  refused(ADMIN, setC(PDM4, [{ kind: 'mode_of_action', ingredient_id: tte, scheme: 'HRAC', group_code: '3' }]), /CHEMISTRY_FROM_EPA_ONLY|CHEMISTRY_ROW_EXISTS/);
  refused(ADMIN, corrC(PDM4, [{ kind: 'ingredient', action: 'retire', row_id: rowId(PDM4, tte) }]), /CHEMISTRY_EPA_ROW_KEPT/);
  refused(ADMIN, corrC(PDM4, [{ kind: 'ingredient', action: 'swap', row_id: rowId(PDM4, tte), ingredient_id: glyAcid, strength_value: 1,
    strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label', modes_of_action: [] }]), /CHEMISTRY_FROM_EPA_ONLY/);
  const confirmed = owner(`SELECT id FROM public.product_parent_modes_of_action WHERE parent_id = '${PDM4}' AND ingredient_id = '${tte}' AND group_code = '2' AND status = 'active';`);
  refused(ADMIN, corrC(PDM4, [{ kind: 'mode_of_action', action: 'retire', row_id: confirmed }]), /CHEMISTRY_FROM_EPA_ONLY/);
  assert.equal(dm4Moa(), '2:epa_lookup,3:typed,4:epa_lookup', 'the refusals changed nothing');
  refused(ADMIN, corrC(PDM4, [{ kind: 'ingredient', action: 'swap', row_id: rowId(PDM4, ingId('Typed only')), ingredient_id: glyAcid, strength_value: 1,
    strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label', modes_of_action: [] }]), /CHEMISTRY_FROM_EPA_ONLY/);
  ok(ADMIN, corrC(PDM4, [{ kind: 'ingredient', action: 'retire', row_id: rowId(PDM4, ingId('Typed only')) }]));
  // A swap made while the number is away records the moved modes as typed (the lookup confirmed the old ingredient, not this one);
  // back under the gate the lookup confirms the new one again, and then it cannot be retired.
  fixture(`UPDATE public.product_parents SET generic_epa_registration = NULL WHERE id = '${PDM4}';`);
  ok(ADMIN, corrC(PDM4, [{ kind: 'ingredient', action: 'swap', row_id: rowId(PDM4, tte), ingredient_id: glyAcid, strength_value: 1,
    strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label', modes_of_action: [{ scheme: 'HRAC', group_code: '2' }, { scheme: 'HRAC', group_code: '3' }] }]));
  assert.equal(owner(`SELECT string_agg(group_code || ':' || source, ',' ORDER BY group_code) FROM public.product_parent_modes_of_action
    WHERE parent_id = '${PDM4}' AND ingredient_id = '${glyAcid}' AND status = 'active';`), '2:typed,3:typed', 'a moved mode of action is typed until the lookup confirms the new ingredient');
  fixture(`UPDATE public.product_parents SET generic_epa_registration = '100-66' WHERE id = '${PDM4}';`);
  assert.equal(epaWrite([{ kind: 'mode_of_action', ingredient_id: glyAcid, scheme: 'HRAC', group_code: '2' }]), 'true', 'the lookup confirms the new ingredient');
  refused(ADMIN, corrC(PDM4, [{ kind: 'ingredient', action: 'retire', row_id: rowId(PDM4, glyAcid) }]), /CHEMISTRY_EPA_ROW_KEPT/);
  refused(ADMIN, setC(PEPA5, [ing('Gate typed epa', 1, { source: 'epa_lookup' })]), /epa_lookup|SOURCE/);
  console.log('[prover] gate: generic, size, parent-brand and legacy-brand numbers refuse set and correct; a retired brand only is allowed; DM-4 stand-in writes epa_lookup rows on a gated parent; typed epa_lookup refused; a typed row whose mode of action the EPA lookup confirmed cannot be retired (CHEMISTRY_EPA_ROW_KEPT), one without can; a swap records moved modes of action as typed until the lookup confirms them');

  // ---- Gate race: a legacy brand number added while a chemistry write holds its locks.
  let bg = session(`BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
    SET LOCAL ROLE authenticated;
    ${setC(PEPA5, add('race1'))}
    SELECT 'JK_READY'; RESET ROLE; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  // App roles can only SELECT product_brands; the one write path is upsert_product_brand.
  const lateBrand = await waited(bg, () => as(ADMIN2, `SELECT public.upsert_product_brand('${E5G}', '[PROVER] Late', '100-12', NULL, true, NULL, NULL, NULL, NULL, ${q(key())});`),
    'a legacy brand save behind the chemistry write');
  assert.equal(lateBrand.status, 0, lateBrand.output);
  assert.equal(owner(`SELECT count(*) FROM public.product_parent_ingredients r JOIN public.active_ingredients a ON a.id = r.ingredient_id
    WHERE r.parent_id = '${PEPA5}' AND a.name = 'Gate race1';`), '1', 'the write that held the locks succeeded, then the brand saved');
  refused(ADMIN, setC(PEPA5, add('race2')), /CHEMISTRY_FROM_EPA_ONLY/);
  // A parent brand number on a parent with no sizes, committed first, refuses the chemistry write that waited.
  bg = session(`BEGIN; INSERT INTO public.product_parent_brands (parent_id, brand_name, epa_registration, created_by, updated_by)
    SELECT '${PNOSIZE}', '[PROVER] NoSize', '100-13', '${ADMIN}', '${ADMIN}' FROM public.product_parents WHERE id = '${PNOSIZE}' FOR SHARE;
    SELECT 'JK_READY'; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  const late = await waited(bg, () => as(ADMIN, setC(PNOSIZE, add('nosize'), key(), 0)), 'a chemistry write behind a parent brand insert');
  assert.notEqual(late.status, 0);
  assert.match(late.output, /CHEMISTRY_FROM_EPA_ONLY/);
  console.log('[prover] gate race: a legacy brand insert waited for the chemistry write; a parent brand committed first refused the chemistry write that waited');

  // ---- Add versus correct.
  const pid = PSWITCH;
  ok(ADMIN, setC(pid, [{ kind: 'ingredient', name: 'Fill me', strength_value: null, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label' }]));
  const fillId = ingId('Fill me');
  // Filling an unknown sets the value only: a different unit, basis or source is a correction (Sol round 1).
  for (const diff of [{ strength_unit: 'pct_ww' }, { strength_basis: 'acid_equivalent' }, { source: 'other' }]) {
    refused(ADMIN, setC(pid, [{ kind: 'ingredient', ingredient_id: fillId, strength_value: 2, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label', ...diff }]), /CHEMISTRY_CHANGE_NEEDS_CORRECTION/);
  }
  ok(ADMIN, setC(pid, [{ kind: 'fertilizer', nutrient: 'P', basis: 'elemental', percent: null, source: 'label' }]));
  refused(ADMIN, setC(pid, [{ kind: 'fertilizer', nutrient: 'P', basis: 'oxide', percent: 10, source: 'label' }]), /CHEMISTRY_CHANGE_NEEDS_CORRECTION/);
  refused(ADMIN, setC(pid, [{ kind: 'fertilizer', nutrient: 'P', basis: 'elemental', percent: 10, source: 'supplier' }]), /CHEMISTRY_CHANGE_NEEDS_CORRECTION/);
  // A fill cannot add a note where none was (Sol round 2): that is a correction too.
  refused(ADMIN, setC(pid, [{ kind: 'fertilizer', nutrient: 'P', basis: 'elemental', percent: 10, source: 'label', source_note: 'new note' }]), /CHEMISTRY_CHANGE_NEEDS_CORRECTION/);
  refused(ADMIN, setC(pid, [{ kind: 'ingredient', ingredient_id: fillId, strength_value: 2, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label', source_note: 'new note' }]), /CHEMISTRY_CHANGE_NEEDS_CORRECTION/);
  ok(ADMIN, setC(pid, [{ kind: 'fertilizer', nutrient: 'P', basis: 'elemental', percent: 10, source: 'label' }]));
  ok(ADMIN, setC(pid, [{ kind: 'ingredient', ingredient_id: fillId, strength_value: 2, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label' }]));
  refused(ADMIN, setC(pid, [{ kind: 'ingredient', ingredient_id: fillId, strength_value: 3, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label' }]), /CHEMISTRY_CHANGE_NEEDS_CORRECTION|CHEMISTRY_/);
  for (const action of ['change', 'retire']) {
    refused(ADMIN, setC(pid, [{ kind: 'ingredient', action, row_id: rowId(pid, fillId), strength_value: 3, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'sds' }]), /CHEMISTRY_CHANGE_NEEDS_CORRECTION/);
  }
  const change = [{ kind: 'ingredient', action: 'change', row_id: rowId(pid, fillId), strength_value: 3, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'sds' }];
  refused(ADMIN, corrC(pid, change, null), /REASON_REQUIRED/);
  refused(ADMIN, corrC(pid, change, 'why', null), /EVIDENCE_REQUIRED/);
  let p = prevC(pid, change);
  assert.equal(p.refusal, null, JSON.stringify(p));
  assert.equal(p.after.ingredients.find((x) => x.name === 'Fill me').strength_value, 3);
  assert.equal(p.sizes.length, 1);
  assert.equal(chem(pid).chemistry.ingredients.find((x) => x.name === 'Fill me').strength_value, 2, 'the preview wrote nothing');
  // A parent change after the preview (an EPA correction moves parent_version) voids it (Sol round 2).
  owner(`UPDATE public.product_parents SET parent_version = parent_version + 1 WHERE id = '${pid}';`);
  refused(ADMIN, corrC(pid, change, undefined, undefined, { fp: p.preview_fingerprint }), /CHEMISTRY_PREVIEW_CHANGED/);
  ok(ADMIN, corrC(pid, change));
  const oldRow = rowId(pid, fillId);
  ok(ADMIN, corrC(pid, [{ kind: 'ingredient', action: 'retire', row_id: oldRow }]));
  assert.equal(chem(pid).chemistry.ingredients.length, 0, 'a retired row is excluded from reads');
  assert.equal(owner(`SELECT status FROM public.product_parent_ingredients WHERE id = '${oldRow}';`), 'retired', 'and kept with its history');
  assert.equal(js(REP, `SELECT count(*) FROM public.product_parent_ingredients WHERE id = '${oldRow}';`), 0, 'a rep cannot see retired rows');
  assert.equal(js(ADMIN, `SELECT count(*) FROM public.product_parent_ingredients WHERE id = '${oldRow}';`), 1, 'an admin can');
  console.log('[prover] add vs correct: add and fill through set; change/retire refused there and done through correct with reason and evidence; preview writes nothing; a refused or outdated preview cannot save; retired rows hidden but kept');

  // ---- Identity (D-AA).
  const r1 = js(ADMIN, createI({ name: 'Atrazine', cas: '1912-24-9' }));
  const r2 = js(ADMIN, createI({ name: 'AAtrex technical', cas: '1912-24-9' }));
  assert.equal(r2.ingredient.id, r1.ingredient.id);
  assert.equal(r2.reused, true);
  assert.equal(r2.ingredient.name, 'Atrazine', 'no resolve renames a row');
  js(ADMIN, createI({ name: 'Mystery  Active' }));
  js(ADMIN, createI({ name: 'mystery active' }));
  assert.equal(owner(`SELECT count(*) FROM public.active_ingredients WHERE name_key = 'mystery active';`), '2');
  const wl = js(ADMIN, 'SELECT public.get_active_ingredient_worklist();');
  assert.ok(wl.possible_duplicates.some((d) => d.provisional.name_key === undefined || /mystery/i.test(d.provisional.name)), 'listed as possible duplicates');
  const nIng = owner('SELECT count(*) FROM public.active_ingredients;');
  const glyAcid2 = js(ADMIN, createI({ name: 'Other acid', is_parent_form: true })).ingredient.id;
  refused(ADMIN, createI({ name: 'Glyphosate IPA salt', cas: '38641-94-0', canonical_ingredient_id: glyAcid2 }), /INGREDIENT_PARENT_CONFLICT/);
  refused(ADMIN, createI({ name: 'Glyphosate IPA salt', canonical_ingredient_id: glyAcid2 }), /INGREDIENT_PARENT_CONFLICT/);
  refused(ADMIN, createI({ name: 'x', cas: '38641-94-0', canonical_ingredient_id: glyAcid, canonical_fraction: 0.5, fraction_basis: 'acid_equivalent' }), /INGREDIENT_FRACTION_CONFLICT/);
  assert.equal(owner('SELECT count(*) FROM public.active_ingredients;'), String(Number(nIng) + 1), 'refused entries wrote nothing');
  const mystery = ingId('Mystery  Active');
  refused(ADMIN, saveI(mystery, { cas: '1912-24-9' }), /INGREDIENT_CAS_TAKEN: this CAS belongs to Atrazine/);
  refused(ADMIN, saveI(mystery, { name: 'Renamed' }), /INGREDIENT_NAME_FIXED/);
  refused(ADMIN, createI({ name: 'Bad cas', cas: '1912-24-8' }), /INGREDIENT_CAS_INVALID/);
  refused(ADMIN, createI({ name: 'Not acid parent', canonical_ingredient_id: r1.ingredient.id }), /INGREDIENT_CANONICAL_INVALID/);
  refused(ADMIN, saveI(glyAcid, { canonical_ingredient_id: glyAcid2 }), /INGREDIENT_FRACTION_INVALID|INGREDIENT_IN_USE/);
  refused(ADMIN, createI({ name: 'Frac no parent', canonical_fraction: 0.5, fraction_basis: 'acid_equivalent' }), /INGREDIENT_FRACTION_INVALID/);
  refused(OWNER, `INSERT INTO public.active_ingredients (name, canonical_fraction, fraction_basis, created_by, updated_by) VALUES ('t', 0.5, 'acid_equivalent', '${ADMIN}', '${ADMIN}');`, /violates check constraint/);
  for (const bad of ["'NaN'", "'Infinity'", '1.5', '0']) {
    refused(OWNER, `INSERT INTO public.active_ingredients (name, canonical_ingredient_id, canonical_fraction, fraction_basis, created_by, updated_by) VALUES ('t', '${glyAcid}', ${bad}, 'acid_equivalent', '${ADMIN}', '${ADMIN}');`, /violates check constraint/);
  }
  // Luna round 1: wrongly typed input is refused by name, never dropped; an edit obeys D-AA-3; at most 10 decimals.
  refused(ADMIN, createI({ name: 'Acid typo', cas: '1071-83-6', is_parent_fom: true }), /INGREDIENT_ENTRY_INVALID: is_parent_fom is not an ingredient field/);
  refused(ADMIN, createI({ name: 'Typed canon', canonical_ingredient_id: 42 }), /CHEMISTRY_CHANGE_INVALID: canonical_ingredient_id must be an ID/);
  refused(ADMIN, setC(PDUP1, [ing('Note test', 1, { source_note: 5 })]), /CHEMISTRY_SOURCE_INVALID: the source note must be text/);
  const editConflict = prevI(mystery, { canonical_ingredient_id: glyAcid });
  assert.match(String(editConflict.refusal), /INGREDIENT_PARENT_CONFLICT: mystery active already exists with a different acid/i, 'an edit naming an acid while a same-name row names none is refused (D-AA-3)');
  refused(OWNER, `INSERT INTO public.active_ingredients (name, canonical_ingredient_id, canonical_fraction, fraction_basis, created_by, updated_by) VALUES ('t', '${glyAcid}', 0.12345678901, 'acid_equivalent', '${ADMIN}', '${ADMIN}');`, /violates check constraint/);
  assert.equal(owner('SELECT count(*) FROM public.active_ingredients;'), String(Number(nIng) + 1), 'the new refusals wrote nothing');
  console.log('[prover] identity: one CAS under two names is one ingredient (never renamed); two name-only entries stay two and are listed; conflicting acid or fraction refused with zero writes; CAS taken, rename, bad CAS, non-acid parent and orphan fraction refused');

  // Swap and consolidate copy nothing (Mason, 2026-11-07): the request states the new strength and lists the
  // modes of action that stay; the screen pre-fills both. A swap onto an ingredient already on the parent is refused.
  ok(ADMIN, setC(PDUP1, [ing('Dup A', 1, { ref: 'a' }), { kind: 'mode_of_action', ingredient_ref: 'a', scheme: 'HRAC', group_code: '5' },
    { kind: 'mode_of_action', ingredient_ref: 'a', scheme: 'HRAC', group_code: '6' }]));
  const dupA = ingId('Dup A');
  const keepB = js(ADMIN, createI({ name: 'Dup B', cas: '87392-12-9' })).ingredient.id; // reuses S-metolachlor by CAS
  assert.equal(keepB, ingId('S-metolachlor'));
  const STATED = { strength_value: 1.2, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'sds' };
  const swap = (pid, from, to, modes, extra = {}) => [{ kind: 'ingredient', action: 'swap', row_id: rowId(pid, from), ingredient_id: to,
    ...STATED, modes_of_action: modes, ...extra }];
  const hrac = (...codes) => codes.map((c) => ({ scheme: 'HRAC', group_code: c }));
  const bare = [{ kind: 'ingredient', action: 'swap', row_id: rowId(PDUP1, dupA), ingredient_id: keepB }];
  assert.match(String(prevC(PDUP1, bare).refusal), /CHEMISTRY_STRENGTH_INVALID/, 'a swap must state the strength');
  refused(ADMIN, corrC(PDUP1, bare), /CHEMISTRY_STRENGTH_INVALID/);
  refused(ADMIN, corrC(PDUP1, [{ ...bare[0], ...STATED }]), /CHEMISTRY_MODES_REQUIRED/);
  refused(ADMIN, corrC(PDUP1, swap(PDUP1, dupA, keepB, hrac('9'))), /CHEMISTRY_MODES_INVALID: HRAC:9 is not a mode of action of the row being replaced/);
  refused(ADMIN, corrC(PDUP1, swap(PDUP1, dupA, keepB, hrac('5', '5'))), /CHEMISTRY_MODES_INVALID: HRAC:5 is listed twice/);
  refused(ADMIN, corrC(PDUP1, swap(PDUP1, dupA, keepB, [{ scheme: 'HRAC', group_code: '5', ingredient_id: keepB }])), /CHEMISTRY_MODES_INVALID: each/);
  refused(ADMIN, corrC(PDUP1, swap(PDUP1, dupA, keepB, { scheme: 'HRAC', group_code: '5' })), /CHEMISTRY_MODES_REQUIRED/);
  p = prevC(PDUP1, swap(PDUP1, dupA, keepB, hrac('5')));
  assert.equal(p.refusal, null, JSON.stringify(p));
  ok(ADMIN, corrC(PDUP1, swap(PDUP1, dupA, keepB, hrac(' 5 '))));
  const swapped = chem(PDUP1).chemistry;
  assert.deepEqual(swapped.ingredients.map((x) => [x.ingredient_id, x.strength_value, x.source]), [[keepB, 1.2, 'sds']], 'the stated strength and source, not the old 1 lb/gal label row');
  let moa = swapped.modes_of_action;
  assert.deepEqual(moa.map((m) => `${m.ingredient_id === keepB}:${m.group_code}`), ['true:5'], 'the listed mode of action moved; the unlisted one was dropped');
  assert.equal(owner(`SELECT string_agg(DISTINCT source, ',') FROM public.product_parent_modes_of_action WHERE parent_id = '${PDUP1}' AND status = 'active';`), 'typed');
  ok(ADMIN, setC(PDUP1, [ing('Dup A', 0.5, { ingredient_id: dupA, name: undefined, cas: undefined }), { kind: 'mode_of_action', ingredient_id: dupA, scheme: 'HRAC', group_code: '15' },
    { kind: 'mode_of_action', ingredient_id: dupA, scheme: 'HRAC', group_code: '5' }]));
  refused(ADMIN, corrC(PDUP1, swap(PDUP1, dupA, keepB, hrac('15'))), /INGREDIENT_ALREADY_ON_PARENT/);
  const cons = (modes) => [{ kind: 'ingredient', action: 'consolidate', row_id: rowId(PDUP1, dupA), into_row_id: rowId(PDUP1, keepB),
    strength_value: 1.5, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label', ...(modes ? { modes_of_action: modes } : {}) }];
  refused(ADMIN, corrC(PDUP1, cons(null)), /CHEMISTRY_MODES_REQUIRED/);
  refused(ADMIN, corrC(PDUP1, cons(hrac('6'))), /CHEMISTRY_MODES_INVALID: HRAC:6 is not a mode of action/);
  ok(ADMIN, corrC(PDUP1, cons(hrac('15', '5'))));
  moa = chem(PDUP1).chemistry.modes_of_action;
  assert.deepEqual(moa.map((m) => `${m.ingredient_id === keepB}:${m.group_code}`).sort(), ['true:15', 'true:5'], 'consolidate moved the listed modes; one already on the kept row is not doubled');
  assert.equal(chem(PDUP1).chemistry.ingredients.length, 1);
  assert.equal(chem(PDUP1).chemistry.ingredients[0].strength_value, 1.5, 'the kept row takes the stated strength');
  // Retire: refused while used, allowed once unused, then unpickable; reactivated, its CAS re-resolves to it.
  ok(ADMIN, setC(PDUP2, [ing('Dup A', 1, { ingredient_id: dupA, name: undefined })]));
  refused(ADMIN, `SELECT public.retire_active_ingredient('${dupA}', ${ingVer(dupA)}, 'duplicate', ${q(key())});`, /INGREDIENT_IN_USE/);
  refused(ADMIN, `SELECT public.retire_active_ingredient('${glyAcid}', ${ingVer(glyAcid)}, 'x', ${q(key())});`, /INGREDIENT_IN_USE/);
  ok(ADMIN, corrC(PDUP2, swap(PDUP2, dupA, keepB, [])));
  refused(ADMIN, `SELECT public.retire_active_ingredient('${dupA}', ${ingVer(dupA)}, NULL, ${q(key())});`, /REASON_REQUIRED/);
  refused(ADMIN, `SELECT public.retire_active_ingredient('${dupA}', ${ingVer(dupA) - 1}, 'dup', ${q(key())});`, /INGREDIENT_STALE/);
  ok(ADMIN, `SELECT public.retire_active_ingredient('${dupA}', ${ingVer(dupA)}, 'duplicate of Dup B', ${q(key())});`);
  refused(ADMIN, setC(PDUP2, [{ kind: 'ingredient', ingredient_id: dupA, strength_value: 1, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label' }]), /INGREDIENT_RETIRED/);
  assert.ok(js(ADMIN, 'SELECT public.get_active_ingredient_worklist();').retired.some((x) => x.id === dupA && x.retire_reason));
  assert.ok(!js(REP, `SELECT public.search_active_ingredients('dup a');`).some((x) => x.id === dupA), 'a retired ingredient cannot be picked');
  ok(ADMIN, `SELECT public.retire_active_ingredient('${r1.ingredient.id}', ${ingVer(r1.ingredient.id)}, 'test', ${q(key())});`);
  refused(ADMIN, createI({ name: 'Atrazine again', cas: '1912-24-9' }), /INGREDIENT_RETIRED: Atrazine was retired/);
  ok(ADMIN, `SELECT public.reactivate_active_ingredient('${r1.ingredient.id}', ${ingVer(r1.ingredient.id)}, 'needed again', ${q(key())});`);
  assert.equal(js(ADMIN, createI({ name: 'Atrazine again', cas: '1912-24-9' })).ingredient.id, r1.ingredient.id, 'its CAS re-resolves to it');
  console.log('[prover] replace: swap and consolidate refuse without a stated strength and a listed set of modes of action (missing, unknown, repeated or malformed); the stated values are saved and only listed modes move; swap onto an existing target refused; retire refused while used, then allowed and unpickable; reactivate re-resolves its CAS');

  // ---- Astra round.
  ok(ADMIN, setC(PAE, [{ kind: 'mode_of_action', ingredient_id: ingId('Glyphosate DMA salt'), scheme: 'HRAC', group_code: '9' }]));
  refused(ADMIN, saveI(glyAcid, { is_parent_form: false }, 'x', 'y'), /INGREDIENT_IN_USE/);
  const dma = ingId('Glyphosate DMA salt');
  refused(ADMIN, saveI(dma, { canonical_ingredient_id: null }, 'x', 'y'), /INGREDIENT_IN_USE/);
  // A correction previewed before a size joined is refused.
  ok(ADMIN, setC(PSTALE, [ing('Stale active', 1)]));
  const staleCh = [{ kind: 'ingredient', action: 'change', row_id: rowId(PSTALE, ingId('Stale active')), strength_value: 2, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label' }];
  const staleFp = prevC(PSTALE, staleCh).preview_fingerprint;
  fixture(`INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by) VALUES ('${STALEJOIN}', '${PSTALE}', 'package', '${ADMIN}');`);
  refused(ADMIN, corrC(PSTALE, staleCh, 'r', 'e', { fp: staleFp }), /CHEMISTRY_PREVIEW_CHANGED/);
  ok(ADMIN, corrC(PSTALE, staleCh));
  refused(ADMIN, setC(PSTALE, [ing('Sixty one', 60, { strength_unit: 'pct_ww' }), ing('Sixty two', 60, { strength_unit: 'pct_ww' })]), /CHEMISTRY_TOTAL_IMPOSSIBLE/);
  refused(ADMIN, setC(PSTALE, [ing('Over twenty', 21)]), /CHEMISTRY|violates|strength/i);
  refused(ADMIN, setC(PSTALE, [ing('Pct over', 101, { strength_unit: 'pct_ww' })]), /CHEMISTRY|violates|strength/i);
  // A lb/gal row on a size that is now dry is refused at read time.
  ok(ADMIN, setC(PREF, [ing('Ref active', 1)]));
  fixture(`UPDATE public.products SET product_form = 'dry', inventory_unit = 'Lb' WHERE id = '${REFB}';`);
  c = costs(PREF);
  assert.equal(fig(sizeFigs(c, REFB), 'Ref active').reason, 'STRENGTH_UNIT_MISMATCH');
  // New ingredient and its mode of action in one call by ref; a repeated or unknown ref refused.
  ok(ADMIN, setC(PREF, [ing('Ref new', 0.5, { ref: 'n' }), { kind: 'mode_of_action', ingredient_ref: 'n', scheme: 'FRAC', group_code: '3' }]));
  refused(ADMIN, setC(PREF, [ing('R1', 0.1, { ref: 'x' }), ing('R2', 0.1, { ref: 'x' })]), /CHEMISTRY_REF_DUPLICATE/);
  refused(ADMIN, setC(PREF, [{ kind: 'mode_of_action', ingredient_ref: 'zz', scheme: 'FRAC', group_code: '3' }]), /CHEMISTRY_REF_UNKNOWN/);
  // Inactive parent: a swap succeeds, an add is refused.
  fixture(`UPDATE public.product_parents SET is_active = true WHERE id = '${PINACT}';`);
  ok(ADMIN, setC(PINACT, [ing('Inact old', 1)]));
  fixture(`UPDATE public.product_parents SET is_active = false WHERE id = '${PINACT}';`);
  refused(ADMIN, setC(PINACT, [ing('Inact add', 1)]), /INACTIVE|inactive/);
  ok(ADMIN, corrC(PINACT, swap(PINACT, ingId('Inact old'), keepB, [])));
  // An ae strength on a salt with no acid and not itself the acid is refused.
  refused(ADMIN, setC(PREF, [ing('Orphan salt', 1, { strength_basis: 'acid_equivalent' })]), /CHEMISTRY_AE_NEEDS_CANONICAL/);
  // A second analysis row for one nutrient on another basis is refused.
  refused(ADMIN, setC(PFERT, [nut('P', 'elemental', 1)]), /CHEMISTRY_|duplicate|unique/i);
  refused(ADMIN, setC(PFERT, [nut('N', 'oxide', 1)]), /CHEMISTRY_|oxide/i);
  // Retiring an ingredient row retires its mode-of-action rows.
  ok(ADMIN, corrC(PAE, [{ kind: 'ingredient', action: 'retire', row_id: rowId(PAE, dma) }]));
  assert.equal(owner(`SELECT count(*) FROM public.product_parent_modes_of_action WHERE parent_id = '${PAE}' AND status = 'active';`), '0');
  console.log('[prover] Astra round: acid flag and canonical clears refused while used; stale preview refused; 60%+60%, >20 lb/gal and >100% refused; now-dry size refused at read; ref in one call; inactive parent swap ok, add refused; orphan ae refused; one row per nutrient; retire cascades MoA');

  // ---- Stale ingredient preview.
  ok(ADMIN, setC(PDUP2, [ing('Shared salt', 1, { canonical_ingredient_id: glyAcid, canonical_fraction: 0.8, fraction_basis: 'acid_equivalent' })]));
  const shared = ingId('Shared salt');
  const sf = prevI(shared, { canonical_fraction: 0.7 }).usage_fingerprint;
  ok(ADMIN2, setC(PREF, [{ kind: 'ingredient', ingredient_id: shared, strength_value: 1, strength_unit: 'lb_per_gal', strength_basis: 'active_ingredient', source: 'label' }]));
  refused(ADMIN, saveI(shared, { canonical_fraction: 0.7 }, 'r', 'e', { fp: sf }), /INGREDIENT_USAGE_CHANGED/);
  ok(ADMIN, saveI(shared, { canonical_fraction: 0.7 }, 'r', 'e'));
  assert.equal(owner(`SELECT count(*) FROM public.product_chemistry_events WHERE after_values->>'ingredient_id' = '${shared}';`), '2', 'both parents bumped');
  // Gate on an identity edit: a parent using it gains a number.
  const edit = prevI(shared, { canonical_fraction: 0.75 });
  assert.equal(edit.refusal, null, JSON.stringify(edit));
  fixture(`UPDATE public.product_parents SET generic_epa_registration = '100-14' WHERE id = '${PREF}';`);
  refused(ADMIN, saveI(shared, { canonical_fraction: 0.75 }, 'r', 'e'), /CHEMISTRY_FROM_EPA_ONLY/);
  fixture(`UPDATE public.product_parents SET generic_epa_registration = NULL WHERE id = '${PREF}';`);
  console.log('[prover] stale ingredient preview refused (INGREDIENT_USAGE_CHANGED) after another admin added it to parent B; an edit on an ingredient a gated parent uses is refused');

  // ---- Reads: active users only; cost admin-only.
  refused(OFFREP, `SELECT public.get_parent_chemistry('${PGLY}');`, /ACTIVE_USER_REQUIRED/);
  refused(OFFREP, `SELECT public.search_active_ingredients('gly');`, /ACTIVE_USER_REQUIRED/);
  refused(null, `SELECT public.get_parent_chemistry('${PGLY}');`, /permission denied/);
  assert.equal(chem(PGLY).chemistry.ingredients.length, 1);
  assert.ok(js(REP, `SELECT public.search_active_ingredients('glyphosate');`).length >= 2);
  assert.equal(js(REP, `SELECT public.search_active_ingredients('%');`).length, 0, 'a % is matched literally');
  refused(REP, `SELECT public.get_parent_active_costs('${PGLY}');`, /ADMIN_REQUIRED/);
  refused(REP, 'SELECT public.get_active_ingredient_worklist();', /ADMIN_REQUIRED/);
  refused(REP, `SELECT public.preview_parent_chemistry_correction('${PGLY}', '[]'::jsonb);`, /ADMIN_REQUIRED/);
  refused(REP, `SELECT public.preview_active_ingredient_change('${glyAcid}', '{}'::jsonb);`, /ADMIN_REQUIRED/);
  assert.equal(ok(REP, 'SELECT count(*) FROM public.product_parent_cost_reference;'), '0');
  assert.equal(ok(OFFREP, 'SELECT count(*) FROM public.active_ingredients;'), '0', 'an inactive user sees no rows directly either');
  console.log('[prover] reads: inactive users and anon refused; reps read chemistry and search (wildcards literal); cost, worklist, previews and the reference table are admin-only');

  // ---- Every writer: non-admin, direct table writes, keys, stale versions.
  const writers = [
    setC(PREF, [ing('W1', 0.1)], 'w-set'),
    `SELECT public.correct_parent_chemistry('${PREF}', ${ver(PREF)}, 'x', '[]'::jsonb, 'r', 'e', 'w-corr');`,
    createI({ name: 'W2' }, 'w-save'),
    `SELECT public.retire_active_ingredient('${glyAcid2}', 1, 'r', 'w-ret');`,
    `SELECT public.reactivate_active_ingredient('${dupA}', ${ingVer(dupA)}, 'r', 'w-react');`,
    `SELECT public.set_parent_cost_reference('${PUNIT}', '${UG}', 0, 'w-ref');`,
  ];
  const snapshot = () => owner(`SELECT ${DM1_TABLES.map((t) => `(SELECT count(*) FROM public.${t})`).join(" || ',' || ")};`);
  const s0 = snapshot();
  for (const w of writers) refused(REP, w, /ADMIN_REQUIRED/);
  assert.equal(snapshot(), s0, 'non-admin calls wrote nothing');
  for (const w of writers) refused(ADMIN, w.replace(/'w-[a-z]+'\);$/, 'NULL);'), /IDEMPOTENCY_KEY_REQUIRED/);
  for (const t of DM1_TABLES) {
    refused(ADMIN, `INSERT INTO public.${t} DEFAULT VALUES;`, /permission denied/);
    refused(ADMIN, `UPDATE public.${t} SET ${t === 'product_parent_chemistry_state' || t === 'product_parent_cost_reference' ? 'parent_id = parent_id' : t.endsWith('_events') ? 'reason = reason' : 'id = id'};`, /permission denied/);
    refused(ADMIN, `DELETE FROM public.${t};`, /permission denied/);
  }
  const once = setC(PREF, [ing('Once', 0.1)], 'k-once');
  const a1 = ok(ADMIN, once);
  const a2 = ok(ADMIN, setC(PREF, [ing('Once', 0.1)], 'k-once', ver(PREF) - 1));
  assert.equal(a2.length > 0, true);
  void a1;
  assert.equal(owner(`SELECT count(*) FROM public.product_parent_ingredients r JOIN public.active_ingredients a ON a.id = r.ingredient_id WHERE a.name = 'Once';`), '1', 'one key twice writes once');
  refused(ADMIN, setC(PREF, [ing('Once changed', 0.1)], 'k-once', ver(PREF) - 1), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  refused(ADMIN2, setC(PREF, [ing('Once', 0.1)], 'k-once', ver(PREF) - 1), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  refused(ADMIN, setC(PREF, [ing('Stale', 0.1)], key(), ver(PREF) - 1), /CHEMISTRY_STALE/);
  refused(ADMIN, `SELECT public.set_parent_cost_reference('${PUNIT}', '${UG}', 5, ${q(key())});`, /COST_REFERENCE_STALE/);
  refused(ADMIN, saveI(glyAcid, { cas: null }, 'r', 'e', { v: ingVer(glyAcid) + 1 }), /INGREDIENT_STALE/);
  // Append-only events.
  for (const t of ['active_ingredient_events', 'product_chemistry_events']) {
    refused(OWNER, `UPDATE public.${t} SET reason = 'x';`, /append-only|refused|CHEMISTRY_EVENT/i);
    refused(OWNER, `DELETE FROM public.${t};`, /append-only|refused|CHEMISTRY_EVENT/i);
    refused(OWNER, `TRUNCATE public.${t} CASCADE;`, /append-only|refused|CHEMISTRY_EVENT/i);
  }
  console.log('[prover] every writer: non-admin writes nothing, NULL key refused, direct table writes refused, one key twice writes once, changed request or other caller refused, stale versions refused by name, events append-only');

  // ---- Cost reference.
  refused(ADMIN, `SELECT public.set_parent_cost_reference('${PGLY}', '${GQT}', 0, ${q(key())});`, /COST_REFERENCE_BULK_WINS/);
  refused(ADMIN, `SELECT public.set_parent_cost_reference('${PREF}', '${GQT}', 0, ${q(key())});`, /COST_REFERENCE_NOT_MEMBER/);
  ok(ADMIN, `SELECT public.set_parent_cost_reference('${PREF}', '${REFA}', 0, ${q(key())});`);
  assert.equal(costs(PREF).reference.source, 'picked', 'an inactive bulk size lets an admin pick');
  const refStamp = () => owner(`SELECT updated_at::text || '|' || (updated_at = set_at)::text FROM public.product_parent_cost_reference WHERE parent_id = '${PREF}';`);
  const firstStamp = refStamp();
  ok(ADMIN, `SELECT public.set_parent_cost_reference('${PREF}', '${REFB}', 1, ${q(key())});`);
  assert.notEqual(refStamp(), firstStamp, 'a changed reference moves updated_at (Sol round 8)');
  assert.match(refStamp(), /\|true$/);
  ok(ADMIN, `SELECT public.set_parent_cost_reference('${PREF}', '${REFA}', 2, ${q(key())});`);
  fixture(`UPDATE public.products SET is_active = false WHERE id = '${REFA}';`);
  assert.equal(costs(PREF).reference.reason, 'REFERENCE_INACTIVE');
  refused(ADMIN, `SELECT public.set_parent_cost_reference('${PREF}', '${REFA}', 3, ${q(key())});`, /COST_REFERENCE_INACTIVE/);
  fixture(`UPDATE public.products SET is_active = true WHERE id = '${REFA}';
    UPDATE public.product_parent_members SET parent_id = '${PDUP1}' WHERE product_id = '${REFA}';`);
  assert.equal(costs(PREF).reference.reason, 'REFERENCE_NOT_MEMBER');
  ok(ADMIN, `SELECT public.set_parent_cost_reference('${PREF}', NULL, 3, ${q(key())});`);
  assert.equal(costs(PREF).reference.reason, 'REFERENCE_UNSET');
  console.log('[prover] reference: active bulk wins; non-member refused; inactive bulk lets an admin pick; an inactive or moved reference stops the parent figure by name; NULL clears it');

  // ---- Concurrency.
  // Two first chemistry writes on one parent: one wins, the other gets CHEMISTRY_STALE.
  bg = session(`BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
    SET LOCAL ROLE authenticated; ${setC(PRACE, [ing('Race one', 1)], 'race-1', 0)}
    SELECT 'JK_READY'; RESET ROLE; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  const second = await waited(bg, () => as(ADMIN2, setC(PRACE, [ing('Race two', 1)], 'race-2', 0)), 'a second first write');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /CHEMISTRY_STALE/);
  assert.doesNotMatch(second.output, /duplicate key/);
  // Two concurrent first entries of one new CAS create one ingredient.
  bg = session(`BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
    SET LOCAL ROLE authenticated; ${createI({ name: 'Mesotrione', cas: '104206-82-8' }, 'cas-1')}
    SELECT 'JK_READY'; RESET ROLE; ${HOLD_UNTIL_WAITER} COMMIT;`);
  await bg.ready;
  const meso = await waited(bg, () => js(ADMIN2, createI({ name: 'Callisto technical', cas: '104206-82-8' }, 'cas-2')), 'a second entry of one CAS');
  assert.equal(meso.reused, true);
  assert.equal(owner(`SELECT count(*) FROM public.active_ingredients WHERE cas = '104206-82-8';`), '1');
  console.log('[prover] concurrency: two first writes give one success and CHEMISTRY_STALE (no duplicate key); two first entries of one CAS give one ingredient');

  // ---- cost-exposure-review keys for the DM-1 functions (the sweep allowlist needs one reviewed entry each).
  const sweep = docker([...psqlArgs(), '-A', '-t'], { input: lf(path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'cost-exposure-review.sql')) })
    .stdout.split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => /chemistry|active_ingredient|active_cost|cost_reference/.test(l));
  console.log(`[prover] cost-exposure-review flags these DM-1 functions: ${JSON.stringify(sweep)}`);

  // ---- Rollback block: drop the public functions; the freeze, constraints and append-only triggers stay.
  const counts = snapshot();
  psql(`BEGIN;
    DROP FUNCTION ${PUBLIC_RPCS.map((s) => `public.${s}`).join(', ')};
    DROP FUNCTION public._apply_parent_chemistry(uuid, jsonb, text, text, text), public._resolve_active_ingredient(jsonb),
      public._edit_active_ingredient(uuid, jsonb, text, text, boolean), public._parent_active_cost_rows(uuid);
    COMMIT;`);
  assert.equal(snapshot(), counts, 'no table rows changed');
  refused(OWNER, 'TRUNCATE public.ingredient_map;', /INGREDIENT_MAP_RETIRED/);
  refused(OWNER, `UPDATE public.product_chemistry_events SET reason = 'x';`, /append-only|refused|CHEMISTRY_EVENT/i);
  refused(OWNER, `UPDATE public.active_ingredients SET cas = '1912-24-8';`, /violates check constraint/);
  console.log('[prover] rollback: after dropping the public functions, ingredient_map stays frozen, constraints and append-only triggers hold, and no rows changed');

  console.log('PRODUCT_CHEMISTRY_PROOF_PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true });
});
