#!/usr/bin/env node
/**
 * Real-schema proof for BLK-1a (20261117130000): fill a fertilizer tote from bulk, quantities only.
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays every
 * migration before the candidate (PAR-1 included), seeds invented rows, and checks the build sheet's
 * §6.3 cases: a 265-gal tote from 1,000 gal; a repeated key; two identical calls at once; a stale
 * preview after a concurrent fill and its fresh retry with the shortfall; a shortfall flagged for
 * review; unit refusals and a quart-stocked Bulk; a changed or invalid source; cost flags with no
 * cost written; undo before and after other movement, racing a stock writer, twice and unauthorized;
 * and the ledger check matching stock after fills and undos.
 *
 * Run: node scripts/smoke/prove-tote-fill-real-schema.mjs   (needs local Docker image)
 * Prints TOTE_FILL_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-totefill-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261117130000_tote_fill_from_bulk.sql');
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
const TOUCHED = /(tote_fill|inventory_transactions_transaction_type_check|product_parent_members|_product_parent_replay|_product_parent_require_admin|_product_parent_reason|FUNCTION\s+(public\.)?"?(is_admin|is_active_profile|check_idempotency|save_idempotency)\b)/i;
// A later file that rewrites, rather than only calls, what the candidate relies on. Later PAR-2 files
// call the _product_parent_* helpers and insert members; only a redefinition or a table change (alter, drop, create) can
// change what this proof proved.
const REDEFINED = /(tote_fill|inventory_transactions_transaction_type_check|(CREATE(\s+OR\s+REPLACE)?|ALTER|DROP)\s+FUNCTION\s+(IF\s+EXISTS\s+)?(public\.)?"?(_product_parent_replay|_product_parent_require_admin|_product_parent_reason|is_admin|is_active_profile|check_idempotency|save_idempotency)\b|(ALTER|DROP|CREATE)\s+TABLE\s+(IF\s+(NOT\s+)?EXISTS\s+)?(ONLY\s+)?(public\.)?"?(product_parent_members|product_parents|inventory|inventory_transactions)\b)/i;
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
  // Others' migrations may sort between the candidate and a follow-up (live applied them in between);
  // they are not replayed, so each must leave alone what this proof covers.
  let last = at;
  for (const file of FOLLOW_UPS) {
    const i = all.indexOf(file);
    assert.ok(i > last, `${path.basename(file)} must sort after the candidate and earlier follow-ups`);
    last = i;
  }
  for (const file of all.slice(at + 1).filter((f) => !FOLLOW_UPS.includes(f))) {
    assert.ok(!REDEFINED.test(lf(file)), `${path.basename(file)} sorts after the candidate and rewrites what it relies on; re-think this proof`);
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

const id = (n) => `7a7e2000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
// Parents and their sizes (invented).
const PF = id('f0'), BULK = id('f1'), TOTE = id('f2'), PKG = id('f3');
const PQ = id('e0'), BULKQ = id('e1'), TOTEQ = id('e2');
const PC = id('c0'), BULKC = id('c1'), TOTEC = id('c2');
const PG = id('b0'), BULKG = id('b1'), TOTEG = id('b2');
const PD = id('d0'), BULKD = id('d1'), TOTED = id('d2');
const UNG = id('99');
const ALL = [BULK, TOTE, PKG, BULKQ, TOTEQ, BULKC, TOTEC, BULKG, TOTEG, BULKD, TOTED, UNG];
const inv = (pid) => id(`9${pid.slice(-2)}`);

function asOwner(sql) { psql(`SET session_replication_role = replica;
${sql}
SET session_replication_role = origin;`, { user: 'supabase_admin' }); }
function txIn(uid, sql) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  return `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n`;
}
function as(uid, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: txIn(uid, sql) });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
// The same, in the background, so two sessions can race.
function bg(uid, sql) {
  return new Promise((resolve) => {
    const p = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (status) => resolve({ status, output: out, rows: out.trim().split(/\r?\n/).filter(Boolean) }));
    p.stdin.end(txIn(uid, sql));
  });
}
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(r.output, pattern);
}
const q = (v) => JSON.stringify(v).replaceAll("'", "''");
const J = (v) => `'${q(v)}'::jsonb`;
const previewSql = (tote, n) => `SELECT public.preview_tote_fill('${tote}', ${n});`;
const preview = (tote, n = 1) => JSON.parse(ok(ADMIN, previewSql(tote, n)));
const fillSql = (tote, n, p, key) => `SELECT public.fill_tote_from_bulk('${tote}', ${n}, ${J(p)}, '${key}');`;
const fill = (tote, n, p, key) => JSON.parse(ok(ADMIN, fillSql(tote, n, p, key)));
const undoSql = (fillId, key, reason = 'entered by mistake') => `SELECT public.reverse_tote_fill('${fillId}', ${reason === null ? 'NULL' : `'${reason}'`}, '${key}');`;
const undo = (fillId, key) => JSON.parse(ok(ADMIN, undoSql(fillId, key)));
const adjustSql = (pid, delta, key) => `SELECT public.adjust_inventory((SELECT id FROM public.inventory WHERE product_id = '${pid}' AND location = 'Main Warehouse'), ${delta}, 'count', '${ADMIN}', '${key}');`;
const stock = (pid) => Number(scalar(`SELECT COALESCE((SELECT quantity_available FROM public.inventory WHERE product_id = '${pid}' AND location = 'Main Warehouse'), -999999);`));
const fills = () => Number(scalar('SELECT count(*) FROM public.tote_fills;'));
const ledgerRows = () => Number(scalar("SELECT count(*) FROM public.inventory_transactions WHERE transaction_type LIKE 'tote_fill_%';"));
const PRICES = `SELECT string_agg(concat_ws('|', id, current_cost, tier1_price, tier2_price, tier3_price), ';' ORDER BY id) FROM public.products;`;
const owner = (sql) => { const r = psql(sql, { allowFailure: true }); return { status: r.status, output: `${r.stdout}\n${r.stderr}` }; };

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'tf-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'tf-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  const p = (pid, name, form, unit, size, sizeUnit, cost, t1) =>
    `('${pid}', '[PROVER] ${name}', '${name}', '${form}', '${unit}', ${size ?? 'NULL'}, ${sizeUnit ? `'${sizeUnit}'` : 'NULL'}, ${cost ?? 'NULL'}, ${t1}, true)`;
  asOwner(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Liquid Fertilizer', 80), ('Foliar Fertilizer', 81),
      ('Dry Water Soluble Fertilizer', 82), ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, container_size, container_unit, current_cost, tier1_price, is_active) VALUES
      ${p(BULK, 'UAN Bulk', 'liquid', 'Gal', null, null, 4.00, 5.00)}, ${p(TOTE, 'UAN 265 Tote', 'liquid', 'Ea', 265, 'Gal', 1060.00, 1400.00)},
      ${p(PKG, 'UAN 2.5 Gal', 'liquid', 'Ea', 2.5, 'Gal', 10.00, 14.00)},
      ${p(BULKQ, 'Foliar Bulk', 'liquid', 'Qt', null, null, 1.00, 1.50)}, ${p(TOTEQ, 'Foliar 265 Tote', 'liquid', 'Unit', 265, 'Gal', null, 1500.00)},
      ${p(BULKC, 'Gly Bulk', 'liquid', 'Gal', null, null, 20.00, 30.00)}, ${p(TOTEC, 'Gly 265 Tote', 'liquid', 'Ea', 265, 'Gal', 5300.00, 7950.00)},
      ${p(BULKG, 'Kelp Bulk', 'liquid', 'Gal', null, null, 3.00, 4.00)}, ${p(TOTEG, 'Kelp 265 Tote', 'liquid', 'Gal', 265, 'Gal', 3.00, 4.00)},
      ${p(BULKD, 'Soluble Bulk', 'dry', 'Lb', null, null, 1.00, 2.00)}, ${p(TOTED, 'Soluble Tote', 'dry', 'Ea', 265, 'Gal', 100.00, 200.00)},
      ${p(UNG, 'Loose Thing', 'liquid', 'Gal', null, null, 1.00, 2.00)};
    INSERT INTO public.product_parents (id, name, product_form, category, created_by, updated_by) VALUES
      ('${PF}', '[PROVER] UAN', 'liquid', 'Liquid Fertilizer', '${ADMIN}', '${ADMIN}'),
      ('${PQ}', '[PROVER] Foliar', 'liquid', 'Foliar Fertilizer', '${ADMIN}', '${ADMIN}'),
      ('${PC}', '[PROVER] Gly', 'liquid', 'Herbicide', '${ADMIN}', '${ADMIN}'),
      ('${PG}', '[PROVER] Kelp', 'liquid', 'Foliar Fertilizer', '${ADMIN}', '${ADMIN}'),
      ('${PD}', '[PROVER] Soluble', 'dry', 'Dry Water Soluble Fertilizer', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_members (product_id, parent_id, size_role, fill_source_product_id, added_by) VALUES
      ('${BULK}', '${PF}', 'bulk', NULL, '${ADMIN}'), ('${TOTE}', '${PF}', 'fixed_tote', '${BULK}', '${ADMIN}'), ('${PKG}', '${PF}', 'package', NULL, '${ADMIN}'),
      ('${BULKQ}', '${PQ}', 'bulk', NULL, '${ADMIN}'), ('${TOTEQ}', '${PQ}', 'fixed_tote', '${BULKQ}', '${ADMIN}'),
      ('${BULKC}', '${PC}', 'bulk', NULL, '${ADMIN}'), ('${TOTEC}', '${PC}', 'fixed_tote', '${BULKC}', '${ADMIN}'),
      ('${BULKG}', '${PG}', 'bulk', NULL, '${ADMIN}'), ('${TOTEG}', '${PG}', 'fixed_tote', '${BULKG}', '${ADMIN}'),
      ('${BULKD}', '${PD}', 'bulk', NULL, '${ADMIN}'), ('${TOTED}', '${PD}', 'fixed_tote', '${BULKD}', '${ADMIN}');
    -- Opening stock, each with its received ledger row; the UAN tote has no inventory row yet.
    INSERT INTO public.inventory (id, product_id, location, quantity_available) VALUES
      ${[[BULK, 1000], [BULKQ, 4000], [BULKC, 1000], [BULKG, 1000], [BULKD, 1000]].map(([pid, n]) => `('${inv(pid)}', '${pid}', 'Main Warehouse', ${n})`).join(', ')};
    INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, to_location, performed_by, notes)
      SELECT product_id, 'received', quantity_available, 'Main Warehouse', '${ADMIN}', '[PROVER] opening' FROM public.inventory
       WHERE product_id IN (${ALL.map((x) => `'${x}'`).join(', ')});`);
  console.log('[prover] seeded an admin, a rep, five invented parents with bulk and tote sizes, and opening stock');
}

// The app's ledger check (src/lib/reconciliation.ts checkInventoryLedger) for the types these rows use.
function ledgerMatchesStock() {
  const rows = scalar(`SELECT json_agg(json_build_object('p', product_id, 't', transaction_type, 'q', quantity)) FROM public.inventory_transactions
    WHERE product_id IN (${ALL.map((x) => `'${x}'`).join(', ')});`);
  const expected = new Map();
  for (const { p, t, q: qty } of JSON.parse(rows)) {
    const sign = { received: Math.abs(qty), adjusted: qty, tote_fill_out: qty, tote_fill_in: qty }[t];
    assert.notEqual(sign, undefined, `unexpected ledger type ${t}`);
    expected.set(p, (expected.get(p) ?? 0) + sign);
  }
  for (const [pid, want] of expected) assert.ok(Math.abs(stock(pid) - want) < 0.01, `ledger says ${want}, stock is ${stock(pid)} for ${pid}`);
}

async function main() {
  buildContainer();
  seed();
  stageText('cand.sql', lf(CANDIDATE));
  // The count-unit allow-list must name real units.
  let r = apply('cand.sql');
  assert.notEqual(r.status, 0, 'installed with no Ea or Unit rows');
  assert.match(r.output, /PREFLIGHT_COUNT_UNITS_MISSING/);
  // Live's factors (read 2026-11-05); the schema baseline carries no unit rows.
  asOwner(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Gal', 128, 'liquid'), ('Qt', 32, 'liquid'), ('qt', 32, 'liquid'),
    ('Pt', 16, 'liquid'), ('oz', 1, 'liquid'), ('Lb', 16, 'dry'), ('Ea', 1, 'both'), ('Unit', 1, 'both') ON CONFLICT DO NOTHING;`);
  const pricesAtStart = scalar(PRICES);
  r = apply('cand.sql');
  assert.equal(r.status, 0, r.output);
  ledger(path.basename(CANDIDATE, '.sql'));
  r = apply('cand.sql');
  assert.match(r.output, /PREFLIGHT_TOTE_FILLS_ALREADY_EXIST/);
  assert.match(owner(`INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, performed_by) VALUES ('${UNG}', 'bogus', 1, '${ADMIN}');`).output,
    /inventory_transactions_transaction_type_check/);
  console.log('[prover] installs only with Ea and Unit present, once; the type list is a superset and still refuses unknown types');

  // Who may call.
  for (const sql of [previewSql(TOTE, 1), fillSql(TOTE, 1, {}, 'k-anon'), undoSql(id('77'), 'k-anon')]) {
    refused(null, sql, /permission denied/);
    refused(REP, sql, /ADMIN_REQUIRED/);
  }
  refused(REP, `INSERT INTO public.tote_fills (tote_product_id) VALUES ('${TOTE}');`, /permission denied/);
  assert.equal(ok(REP, 'SELECT count(*) FROM public.tote_fills;'), '0');
  console.log('[prover] preview, fill and undo are admin-only; a rep reads fills but cannot write them; anon cannot call');

  // Refused by name.
  refused(ADMIN, previewSql(UNG, 1), /TOTE_FILL_NOT_A_TOTE/);
  refused(ADMIN, previewSql(PKG, 1), /TOTE_FILL_NOT_A_TOTE/);
  refused(ADMIN, previewSql(TOTEC, 1), /TOTE_FILL_NOT_FERTILIZER: .*Herbicide/);
  refused(ADMIN, previewSql(TOTEG, 1), /TOTE_FILL_TOTE_UNIT: .*stocked in Gal/);
  refused(ADMIN, previewSql(TOTED, 1), /TOTE_FILL_BULK_UNIT: .*stocked in Lb, not a volume/);
  refused(ADMIN, previewSql(TOTE, 0), /TOTE_FILL_TOTES_INVALID/);
  console.log('[prover] a non-tote, a chemical tote, a tote stocked in gallons, a Bulk stocked by weight and zero totes are refused by name');

  // One 265-gal tote from 1,000 gal.
  let p = preview(TOTE);
  assert.deepEqual([p.bulk_product_id, p.bulk_unit, p.bulk_quantity, p.bulk_before, p.bulk_after, p.tote_before, p.tote_after, p.shortfall, p.gallons],
    [BULK, 'Gal', 265, 1000, 735, 0, 1, 0, 265]);
  assert.deepEqual([p.bulk_cost_cents, p.tote_cost_cents, p.estimate_before_cents, p.estimate_after_cents, p.cost_check], [400, 106000, 400000, 400000, 'equal']);
  assert.equal(scalar(`SELECT count(*) FROM public.inventory WHERE product_id = '${TOTE}';`), '0', 'the preview wrote a row');
  const before = scalar(PRICES);
  const a = fill(TOTE, 1, p, 'k-a');
  assert.deepEqual([stock(BULK), stock(TOTE), a.shortfall, a.requires_review], [735, 1, 0, false]);
  assert.deepEqual(fill(TOTE, 1, p, 'k-a'), a);
  assert.deepEqual([stock(BULK), stock(TOTE), fills(), ledgerRows()], [735, 1, 1, 2]);
  refused(ADMIN, fillSql(TOTE, 2, p, 'k-a'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  refused(REP, fillSql(TOTE, 1, p, 'k-a'), /ADMIN_REQUIRED/);
  assert.equal(scalar(PRICES), before, 'a fill changed a cost or price');
  assert.equal(scalar(`SELECT concat_ws('|', quantity, requires_review) FROM public.inventory_transactions WHERE id = '${a.out_transaction_id}';`), '-265|f');
  assert.equal(scalar(`SELECT quantity FROM public.inventory_transactions WHERE id = '${a.in_transaction_id}';`), '1');
  ledgerMatchesStock();
  console.log('[prover] one tote from 1,000 gal leaves 735 and one more tote; the same key returns the first result and writes nothing; costs untouched');

  // Undo right after, then again.
  refused(ADMIN, undoSql(a.fill_id, 'k-u0', null), /REASON_REQUIRED/);
  const u = undo(a.fill_id, 'k-u1');
  assert.deepEqual([stock(BULK), stock(TOTE)], [1000, 0]);
  assert.deepEqual(undo(a.fill_id, 'k-u1'), u);
  refused(ADMIN, undoSql(a.fill_id, 'k-u2'), /TOTE_FILL_ALREADY_REVERSED/);
  refused(ADMIN, undoSql(u.undo_fill_id, 'k-u3'), /TOTE_FILL_IS_AN_UNDO/);
  assert.deepEqual([fills(), ledgerRows()], [2, 4]);
  ledgerMatchesStock();
  console.log('[prover] undo right after a fill restores both counts exactly; a second undo, an undo of an undo and no reason are refused');

  // Two identical calls at once with one key record one pair.
  p = preview(TOTE);
  const [b1, b2] = await Promise.all([bg(ADMIN, `${fillSql(TOTE, 1, p, 'k-b')} SELECT pg_sleep(1.5);`), pause(500).then(() => bg(ADMIN, fillSql(TOTE, 1, p, 'k-b')))]);
  assert.equal(b1.status, 0, b1.output);
  assert.equal(b2.status, 0, b2.output);
  assert.deepEqual(JSON.parse(b2.rows.at(-1)), JSON.parse(b1.rows.find((x) => x.includes('"fill_id"'))));
  assert.deepEqual([stock(BULK), stock(TOTE), fills(), ledgerRows()], [735, 1, 3, 6]);
  const bFill = JSON.parse(b2.rows.at(-1)).fill_id;
  console.log('[prover] two identical calls at once with one key record one pair');

  // Undo after a later movement.
  ok(ADMIN, adjustSql(BULK, 5, 'k-adj1'));
  refused(ADMIN, undoSql(bFill, 'k-u4'), /TOTE_FILL_STOCK_MOVED: .*adjust stock instead/);
  console.log('[prover] undo after any later movement is refused ("adjust stock instead")');

  // Stale preview: two fills confirmed on the same 300-gal preview.
  ok(ADMIN, adjustSql(BULK, -440, 'k-adj2'));
  p = preview(TOTE);
  assert.deepEqual([p.bulk_before, p.shortfall], [300, 0]);
  const [c1, c2] = await Promise.all([bg(ADMIN, `${fillSql(TOTE, 1, p, 'k-c1')} SELECT pg_sleep(1.5);`), pause(500).then(() => bg(ADMIN, fillSql(TOTE, 1, p, 'k-c2')))]);
  assert.equal(c1.status, 0, c1.output);
  assert.notEqual(c2.status, 0, 'the second fill on a stale preview recorded');
  assert.match(c2.output, /TOTE_FILL_PREVIEW_CHANGED/);
  assert.deepEqual([stock(BULK), stock(TOTE)], [35, 2]);
  p = preview(TOTE);
  assert.deepEqual([p.bulk_before, p.shortfall, p.bulk_after], [35, 230, -230]);
  const c3 = fill(TOTE, 1, p, 'k-c2');
  assert.deepEqual([c3.shortfall, c3.requires_review, stock(BULK), stock(TOTE)], [230, true, -230, 3]);
  assert.equal(scalar(`SELECT concat_ws('|', requires_review, notes LIKE '%SHORT STOCK 230 Gal%') FROM public.inventory_transactions WHERE id = '${c3.out_transaction_id}';`), 't|t');
  assert.equal(scalar(`SELECT shortfall_quantity FROM public.tote_fills WHERE id = '${c3.fill_id}';`), '230');
  console.log('[prover] of two fills on one 300-gal preview one records (35 left) and one is refused as stale; after a fresh preview it records the 230-gal shortfall');

  // A fill from 200 gal.
  ok(ADMIN, adjustSql(BULK, 430, 'k-adj3'));
  p = preview(TOTE);
  assert.deepEqual([p.bulk_before, p.shortfall], [200, 65]);
  const d = fill(TOTE, 1, p, 'k-d');
  assert.deepEqual([d.shortfall, d.requires_review, stock(BULK)], [65, true, -65]);
  console.log('[prover] a fill from 200 gal warns, goes ahead and records a 65-gal shortfall flagged for review');

  // Bulk stocked in quarts.
  p = preview(TOTEQ);
  assert.deepEqual([p.bulk_unit, p.bulk_quantity, p.bulk_after, p.cost_check, p.estimate_before_cents, p.tote_cost_cents], ['Qt', 1060, 2940, 'missing', null, null]);
  const e = fill(TOTEQ, 1, p, 'k-e');
  assert.equal(scalar(`SELECT quantity FROM public.inventory_transactions WHERE id = '${e.out_transaction_id}';`), '-1060');
  p = preview(TOTEQ, 3);
  assert.deepEqual([p.bulk_quantity, p.shortfall, p.gallons], [3180, 240, 795]);
  const e3 = fill(TOTEQ, 3, p, 'k-e3');
  assert.deepEqual([e3.shortfall, e3.bulk_unit, stock(BULKQ), stock(TOTEQ)], [240, 'Qt', -240, 4]);
  console.log('[prover] Bulk stocked in quarts loses 1,060 qt per 265-gal tote; its ledger row and shortfall are in quarts');
  // A unit factor cannot change while a fill is in flight.
  p = preview(TOTEQ);
  const held = bg(ADMIN, `${fillSql(TOTEQ, 1, p, 'k-e4')} SELECT pg_sleep(1.5);`);
  await pause(700);
  assert.match(owner("SET lock_timeout = '300ms'; UPDATE public.unit_conversions SET factor_oz = 16 WHERE unit = 'Qt';").output, /lock timeout/);
  const heldDone = await held;
  assert.equal(heldDone.status, 0, heldDone.output);
  assert.equal(scalar("SELECT factor_oz FROM public.unit_conversions WHERE unit = 'Qt';"), '32');
  // A tote too small to measure is refused by the preview, not by a table check at confirm.
  asOwner(`UPDATE public.products SET container_size = 0.00001 WHERE id = '${TOTEQ}';`);
  refused(ADMIN, previewSql(TOTEQ, 1), /TOTE_FILL_TOTE_SIZE: .*too small/);
  asOwner(`UPDATE public.products SET container_size = 265 WHERE id = '${TOTEQ}';`);
  console.log('[prover] a unit edit waits for an in-flight fill; a tote too small to measure is refused by the preview');

  // Cost flags; a cost-only change between preview and fill.
  asOwner(`UPDATE public.products SET current_cost = 1000.00 WHERE id = '${TOTE}';`);
  p = preview(TOTE);
  assert.equal(p.cost_check, 'differ');
  asOwner(`UPDATE public.products SET current_cost = 4.10 WHERE id = '${BULK}';`);
  refused(ADMIN, fillSql(TOTE, 1, p, 'k-f'), /TOTE_FILL_PREVIEW_CHANGED/);
  asOwner(`UPDATE public.products SET current_cost = 4 WHERE id = '${BULK}'; UPDATE public.products SET current_cost = 1060 WHERE id = '${TOTE}';`);
  console.log('[prover] the preview flags equal, differing and missing costs; a cost-only change after the preview refuses the fill');

  // Source changed or made invalid after approval; a category change. (Top the Bulk up first so the
  // later stock writer, which refuses to go below zero, can run.)
  ok(ADMIN, adjustSql(BULK, 2000, 'k-adj-top'));
  p = preview(TOTE);
  asOwner(`UPDATE public.product_parent_members SET fill_source_product_id = NULL WHERE product_id = '${TOTE}';`);
  refused(ADMIN, fillSql(TOTE, 1, p, 'k-g'), /TOTE_FILL_NO_SOURCE/);
  asOwner(`UPDATE public.product_parent_members SET fill_source_product_id = '${BULKQ}' WHERE product_id = '${TOTE}';`);
  refused(ADMIN, fillSql(TOTE, 1, p, 'k-g'), /TOTE_FILL_SOURCE_INVALID/);
  asOwner(`UPDATE public.product_parent_members SET fill_source_product_id = '${BULK}' WHERE product_id = '${TOTE}';
    UPDATE public.product_parents SET category = 'Herbicide' WHERE id = '${PF}';`);
  refused(ADMIN, fillSql(TOTE, 1, p, 'k-g'), /TOTE_FILL_NOT_FERTILIZER/);
  asOwner(`UPDATE public.product_parents SET category = 'Liquid Fertilizer' WHERE id = '${PF}';`);
  const g = fill(TOTE, 1, p, 'k-g');
  console.log('[prover] a tote whose source was removed or changed, or whose parent stopped being fertilizer, is refused until valid again');

  // Undo racing a stock writer: undo first, writer first, a writer that began before the fill, a new fill.
  const raceUndoFirst = await Promise.all([bg(ADMIN, `${undoSql(g.fill_id, 'k-h1')} SELECT pg_sleep(1.5);`), pause(500).then(() => bg(ADMIN, adjustSql(BULK, 1, 'k-adj4')))]);
  for (const x of raceUndoFirst) assert.equal(x.status, 0, x.output);
  p = preview(TOTE);
  const h2 = fill(TOTE, 1, p, 'k-h2');
  const raceWriterFirst = await Promise.all([bg(ADMIN, `${adjustSql(BULK, 1, 'k-adj5')} SELECT pg_sleep(1.5);`), pause(500).then(() => bg(ADMIN, undoSql(h2.fill_id, 'k-h3')))]);
  assert.equal(raceWriterFirst[0].status, 0, raceWriterFirst[0].output);
  assert.match(raceWriterFirst[1].output, /TOTE_FILL_STOCK_MOVED/);
  const early = bg(ADMIN, `SELECT pg_sleep(2); ${adjustSql(TOTE, 1, 'k-adj6')}`);
  await pause(500);
  p = preview(TOTE);
  const h4 = fill(TOTE, 1, p, 'k-h4');
  const earlyDone = await early;
  assert.equal(earlyDone.status, 0, earlyDone.output);
  assert.equal(scalar(`SELECT (SELECT created_at FROM public.inventory_transactions WHERE transaction_type = 'adjusted' AND product_id = '${TOTE}')
    < (SELECT created_at FROM public.tote_fills WHERE id = '${h4.fill_id}');`), 't', 'the early writer did not start before the fill');
  refused(ADMIN, undoSql(h4.fill_id, 'k-h5'), /TOTE_FILL_STOCK_MOVED/);
  p = preview(TOTE);
  const h6 = fill(TOTE, 1, p, 'k-h6');
  p = preview(TOTE);
  const raceFill = await Promise.all([bg(ADMIN, `${fillSql(TOTE, 1, p, 'k-h7')} SELECT pg_sleep(1.5);`), pause(500).then(() => bg(ADMIN, undoSql(h6.fill_id, 'k-h8')))]);
  assert.equal(raceFill[0].status, 0, raceFill[0].output);
  assert.match(raceFill[1].output, /TOTE_FILL_STOCK_MOVED/);
  // Two writers that began before a fill and cancel out (+1, -1) leave stock as the fill left it.
  const early2 = bg(ADMIN, `SELECT pg_sleep(2); ${adjustSql(TOTE, 1, 'k-adj7')} ${adjustSql(TOTE, -1, 'k-adj8')}`);
  await pause(500);
  p = preview(TOTE);
  const h9 = fill(TOTE, 1, p, 'k-h9');
  const early2Done = await early2;
  assert.equal(early2Done.status, 0, early2Done.output);
  assert.equal(stock(TOTE), p.tote_after, 'the offsetting writers did not cancel out');
  refused(ADMIN, undoSql(h9.fill_id, 'k-h10'), /TOTE_FILL_STOCK_MOVED/);
  ledgerMatchesStock();
  console.log('[prover] undo racing a stock writer or a new fill reverses before it or is refused after it, never across it (including a writer that began before the fill)');

  // Leftovers.
  assert.match(owner("UPDATE public.tote_fills SET totes = 9;").output, /TOTE_FILLS_ARE_APPEND_ONLY/);
  assert.match(owner('DELETE FROM public.tote_fills;').output, /TOTE_FILLS_ARE_APPEND_ONLY/);
  assert.equal(scalar(PRICES), pricesAtStart, 'a cost or price changed');
  assert.equal(scalar(`SELECT tier1_price FROM public.products WHERE id = '${BULKC}';`) * 265, Number(scalar(`SELECT tier1_price FROM public.products WHERE id = '${TOTEC}';`)));
  ledgerMatchesStock();
  console.log('[prover] fills are append-only; matching chemical and differing fertilizer prices stay as they were; the ledger check matches stock');
  console.log('TOTE_FILL_PROOF_PASS');
}
try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
