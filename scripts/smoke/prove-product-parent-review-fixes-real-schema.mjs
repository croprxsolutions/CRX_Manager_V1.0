#!/usr/bin/env node
/**
 * Real-schema proof for the PAR-2 review fixes (20261201110000, Taha's review of PR #1555). Builds the checked-in
 * schema baseline in a network-disabled PostgreSQL container, replays every migration before the candidate (PAR-1,
 * its stock-unit follow-up and PAR-2 included), seeds invented rows, installs the candidate and checks each of
 * Taha's examples as a named case (each prints "[case] ..."). Ends by re-issuing the old bodies (the header's
 * rollback) and proving they are byte-for-byte the live ones the preflight pins.
 *
 * Run: node scripts/smoke/prove-product-parent-review-fixes-real-schema.mjs   (needs local Docker image)
 * Prints PRODUCT_PARENT_REVIEW_FIXES_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-par2fix-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261201110000_product_parent_review_fixes.sql');
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
const TOUCHED = /(product_parent|product_brand|_copy_parent_to_size|_product_size_values|_normalize_epa_registration|product_rate_lock|guard_product_category|FUNCTION\s+(public\.)?"?(preview_product_rate_correction|product_price_per_acre|validate_product_units|is_admin|is_active_profile|check_idempotency|save_idempotency)\b)/i;
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
  // A later file would run after the candidate on live; none may touch what this proof covers.
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

function asOwner(sql) { psql(`SET session_replication_role = replica;
${sql}
SET session_replication_role = origin;`, { user: 'supabase_admin' }); }
// One transaction as a signed-in browser session (role authenticated, live's JWT claims), or as a
// signed-out visitor (role anon) when uid is null. `pre` runs first as the owner, inside the same transaction.
function as(uid, sql, pre = '') {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true,
    input: `BEGIN;\n${claims}\n${pre}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
function refused(uid, sql, pattern, pre = '') {
  const r = as(uid, sql, pre);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(r.output, pattern);
}
const q = (v) => JSON.stringify(v).replaceAll("'", "''");
const J = (v) => `'${q(v)}'::jsonb`;
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
// Prices keep their exact JSON text (JSON.rawJSON re-serializes it unchanged), never a JS number.
const exactPrices = (k, v, ctx) => (typeof v === 'number' && /price/.test(k) ? JSON.rawJSON(ctx.source) : v);
const call = (uid, sql) => JSON.parse(ok(uid, sql), exactPrices);

const id = (n) => `7a7e3000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
const [U1, U2, I1, I2, T1, T2, S1, S2] = ['11', '12', '13', '14', '15', '16', '17', '18'].map(id);
const [N1, N2, R1, R2, Z1, Z2, K1, K2, X1, X2] = ['21', '22', '23', '24', '25', '26', '27', '28', '29', '2a'].map(id);
// Each pair Taha named, as it would be keyed by the old rule: they must never share a base name or a group.
const TAHA = [[U1, U2], [I1, I2], [T1, T2], [S1, S2]];
// Strengths the base name still loses (written "lb./gal", "lb ai/gal", "oz ai/gal", or with the size's own number):
// each pair shares a base name, and the numbers check must hold it.
const [A1, A2, L1, L2, O1, O2, W1, W2, R3, ZD] = ['31', '32', '33', '34', '35', '36', '37', '38', '39', '3a'].map(id);
const [M1, M2, B1, B2, E1, E2, F1, F2] = ['3c', '3d', '3e', '3f', '40', '41', '42', '43'].map(id);
// E: no size in the name, and the container size equals the strength's number (Luna round 7).
// F: the container size's number and unit written as a ratio before the real size (Sol).
const STRENGTH_PAIRS = [[A1, A2], [L1, L2], [O1, O2], [W1, W2], [M1, M2], [B1, B2], [E1, E2], [F1, F2]];

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'pp2fix-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'pp2fix-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  asOwner(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Gal', 128, 'liquid'), ('oz', 1, 'liquid'), ('Lb', 16, 'dry') ON CONFLICT DO NOTHING;`);
  const p = (pid, name, sku, cat, epa, form, unit, size, sizeUnit) =>
    `('${pid}', ${lit(name)}, '${sku}', ${lit(cat)}, ${lit(epa)}, '${form}', '${unit}', true, ${size ?? 'NULL'}, ${lit(sizeUnit)})`;
  psql(`INSERT INTO public.products (id, product_name, sku, category, epa_registration, product_form, inventory_unit, is_active, container_size, container_unit) VALUES
    ${[
    p(U1, '[PROVER] UAN 28/0/0 Tote', 'UA-28', 'Liquid Fertilizer', null, 'liquid', 'Gal', 275, 'Gal'),
    p(U2, '[PROVER] UAN 32/0/0 Tote', 'UA-32', 'Liquid Fertilizer', null, 'liquid', 'Gal', 275, 'Gal'),
    p(I1, '[PROVER] Imidacloprid 2 lb/gal 2.5 gal', 'IM-2', 'Herbicide', null, 'liquid', 'Gal', 2.5, 'Gal'),
    p(I2, '[PROVER] Imidacloprid 4 lb/gal 2.5 gal', 'IM-4', 'Herbicide', null, 'liquid', 'Gal', 2.5, 'Gal'),
    p(T1, '[PROVER] Talstar 2 G 25 lb', 'TA-2', 'Herbicide', null, 'dry', 'Lb', 25, 'Lb'),
    p(T2, '[PROVER] Talstar 0.2 G 25 lb', 'TA-02', 'Herbicide', null, 'dry', 'Lb', 25, 'Lb'),
    p(S1, '[PROVER] Starter 6/24/6 2.5 gal', 'ST-6', 'Liquid Fertilizer', null, 'liquid', 'Gal', 2.5, 'Gal'),
    p(S2, '[PROVER] Starter 3/24/6 2.5 gal', 'ST-3', 'Liquid Fertilizer', null, 'liquid', 'Gal', 2.5, 'Gal'),
    // Same recorded container, different numbers in the name: a removed number was not the size.
    p(N1, '[PROVER] Numo 2.5 gal', 'NU-25', 'Herbicide', '600-1', 'liquid', 'Gal', 2.5, 'Gal'),
    p(N2, '[PROVER] Numo 1 gal', 'NU-1', 'Herbicide', '600-1', 'liquid', 'Gal', 2.5, 'Gal'),
    p(R1, '[PROVER] Rho 2.5 gal', 'RH-25', 'Herbicide', '600-2', 'liquid', 'Gal', 2.5, 'Gal'),
    p(R2, '[PROVER] Rho 30 gal', 'RH-30', 'Herbicide', '600-2', 'liquid', 'Gal', 30, 'Gal'),
    p(Z1, '[PROVER] Zeta 2.5 gal', 'ZE-25', 'Herbicide', '300-1', 'liquid', 'Gal', 2.5, 'Gal'),
    p(Z2, '[PROVER] Zeta Pro 2.5 gal', 'ZP-25', 'Herbicide', '300-1', 'liquid', 'Gal', 2.5, 'Gal'),
    p(K1, '[PROVER] Kappa 2.5 gal', 'KA-25', 'Herbicide', '400-1', 'liquid', 'Gal', 2.5, 'Gal'),
    p(K2, '[PROVER] Kappa 30 gal', 'KA-30', 'Herbicide', '400-1', 'liquid', 'Gal', 30, 'Gal'),
    p(X1, '[PROVER] Xeno 1 gal', 'XE-1', 'Herbicide', '900-1', 'liquid', 'Gal', 1, 'Gal'),
    p(X2, '[PROVER] Xeno 2.5 gal', 'XE-25', 'Herbicide', '900-1', 'liquid', 'Gal', 2.5, 'Gal'),
    p(A1, '[PROVER] Imida 2 lb./gal 2.5 gal', 'IA-2', 'Herbicide', null, 'liquid', 'Gal', 2.5, 'Gal'),
    p(A2, '[PROVER] Imida 4 lb./gal 30 gal', 'IA-4', 'Herbicide', null, 'liquid', 'Gal', 30, 'Gal'),
    p(L1, '[PROVER] Lam 2 lb ai/gal 2.5 gal', 'LA-2', 'Herbicide', null, 'liquid', 'Gal', 2.5, 'Gal'),
    p(L2, '[PROVER] Lam 4 lb ai/gal 2.5 gal', 'LA-4', 'Herbicide', null, 'liquid', 'Gal', 2.5, 'Gal'),
    p(O1, '[PROVER] Oza 22 oz ai/gal 1 gal', 'OZ-22', 'Herbicide', null, 'liquid', 'Gal', 1, 'Gal'),
    p(O2, '[PROVER] Oza 11 oz ai/gal 2.5 gal', 'OZ-11', 'Herbicide', null, 'liquid', 'Gal', 2.5, 'Gal'),
    p(W1, '[PROVER] Wex 2 lb./gal 2 gal', 'WE-2', 'Herbicide', null, 'liquid', 'Gal', 2, 'Gal'),
    p(W2, '[PROVER] Wex 4 lb./gal 4 gal', 'WE-4', 'Herbicide', null, 'liquid', 'Gal', 4, 'Gal'),
    p(M1, '[PROVER] Mox 2 lb./gal 4 x 2 gal', 'MO-2', 'Herbicide', null, 'liquid', 'Gal', 2, 'Gal'),
    p(M2, '[PROVER] Mox 4 lb./gal 2 x 4 gal', 'MO-4', 'Herbicide', null, 'liquid', 'Gal', 4, 'Gal'),
    // One number, another unit (Luna round 6).
    p(B1, '[PROVER] Lom 2 lb ai/gal 2.5 gal', 'LO-LB', 'Herbicide', null, 'liquid', 'Gal', 2.5, 'Gal'),
    p(B2, '[PROVER] Lom 2 oz ai/gal 2.5 gal', 'LO-OZ', 'Herbicide', null, 'liquid', 'Gal', 2.5, 'Gal'),
    // No container unit: the stock unit (Gal) is the product's unit.
    p(E1, '[PROVER] Emo 2 lb ai/gal', 'EM-2', 'Herbicide', null, 'liquid', 'Gal', 2, null),
    p(E2, '[PROVER] Emo 4 lb ai/gal', 'EM-4', 'Herbicide', null, 'liquid', 'Gal', 4, null),
    p(F1, '[PROVER] Blend 2 gal concentrate per 10 gal', 'BL-2', 'Herbicide', null, 'liquid', 'Gal', 2, 'Gal'),
    p(F2, '[PROVER] Blend 4 gal concentrate per 10 gal', 'BL-4', 'Herbicide', null, 'liquid', 'Gal', 4, 'Gal'),
    // 1.0 and 1 are one number: Rho 1.0 gal joins Rho.
    p(R3, '[PROVER] Rho 1.0 gal', 'RH-1', 'Herbicide', '600-2', 'liquid', 'Gal', 1, 'Gal'),
    // Zeta's EPA number and name, but dry: another product, never held as a second Zeta.
    p(ZD, '[PROVER] Zeta 25 lb', 'ZE-D', 'Herbicide', '300-1', 'dry', 'Lb', 25, 'Lb'),
  ].join(',\n    ')};`);
  console.log('[prover] seeded an admin, a sales rep and 36 invented products');
}

const PINS = {
  'public._product_parent_base_name(text)': 'a3fbf24aeb7c63ef3595121045bec5a6',
  'public.build_product_parent_proposal(text)': '3b3431538e9b27d9368a3169cfeaa992',
  'public.approve_product_parent_groups(uuid,bigint,jsonb,text)': '2e2dc773cacc2d0fcc6cd335a6555697',
  'public._product_size_move_refusal(uuid,uuid)': 'e48d50e9cc61855fbd7d9bcd4e471387',
  'public.move_product_size(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)': 'e869af2cf434eab03057f0e69766c259',
};
const bodyMd5 = (sig) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
const aclOf = (sig) => scalar(`SELECT concat_ws('|', proacl::text, proconfig::text, proowner::regrole::text, prosecdef) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
// The header's rollback: each old body re-issued from the file that made it live.
function rollbackSql() {
  const take = (file, head) => {
    const text = lf(path.join(MIGRATIONS, file));
    assert.equal(text.split(head).length - 1, 1, `${head} is not defined exactly once in ${file}`);
    const start = text.indexOf(head);
    const end = text.indexOf('$function$;', text.indexOf('$function$', start) + 10) + '$function$;'.length;
    return text.slice(start, end).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  };
  const par2 = '20261123120000_product_parent_proposals.sql';
  const units = '20261110150000_product_parent_stock_units.sql';
  return [
    take(par2, 'CREATE FUNCTION public._product_parent_base_name('),
    take(par2, 'CREATE FUNCTION public.build_product_parent_proposal('),
    take(par2, 'CREATE FUNCTION public.approve_product_parent_groups('),
    take(units, 'CREATE OR REPLACE FUNCTION public._product_size_move_refusal('),
    take(units, 'CREATE OR REPLACE FUNCTION public.move_product_size('),
    'DROP FUNCTION public._product_parent_identity_name(text); DROP FUNCTION public._product_name_strength_tokens(text, numeric, text);',
  ].join('\n\n');
}

const create = (parent, size, key) => call(ADMIN, `SELECT public.create_product_with_parent(${J(parent)}, ${J(size)}, '${key}');`);
const build = (key) => call(ADMIN, `SELECT public.build_product_parent_proposal('${key}');`);
const groups = (proposalId) => JSON.parse(scalar(`SELECT jsonb_agg(to_jsonb(g) ORDER BY g.suggested_name) FROM public.product_parent_proposal_groups g WHERE proposal_id = '${proposalId}';`));
const groupOf = (gs, pid) => { const g = gs.find((x) => x.members.some((m) => m.product_id === pid)); assert.ok(g, `no group holds ${pid}`); return g; };
const ids = (g) => g.members.map((m) => m.product_id).sort();
const entry = (g, extra = {}) => ({ group_id: g.id, group_fingerprint: g.group_fingerprint, name: g.suggested_name, ...extra });
const approve = (P, entries, key) => `SELECT public.approve_product_parent_groups('${P.proposal_id}', ${P.proposal_version}, ${J(entries)}, '${key}');`;
const decide = (fn, g, version, reason, key) => `SELECT public.${fn}_product_parent_group('${g.id}', ${version}, '${g.group_fingerprint}', ${lit(reason)}, '${key}');`;
const brand = (parent, name, maker, rup, signal, key, opts = {}) => `SELECT public.upsert_parent_brand('${parent}', ${lit(name)}, NULL, ${lit(maker)}, true, ${rup}, ${lit(signal)},
  ${opts.id ? `'${opts.id}'` : 'NULL'}, ${opts.version ?? 'NULL'}, ${opts.retire ? 'true' : 'false'}, ${lit(opts.reason ?? null)}, '${key}');`;
const preview = (pid, to) => call(ADMIN, `SELECT public.preview_move_product_size('${pid}', '${to}');`);
const move = (pid, to, m, key) => `SELECT public.move_product_size('${pid}', '${to}', ${m.from_parent_version}, ${m.to_parent_version}, ${lit(m.size_fingerprint)}, 'wrong group', 'label photo', ${J(m.prices ?? {})}, '${key}');`;
const setSwitch = (on) => psql(`CREATE OR REPLACE FUNCTION public._product_parent_grouping_open() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $f$ SELECT ${on}; $f$;`);

async function main() {
  buildContainer();
  seed();
  // The old rule, on the seeded rows: it gives each of Taha's pairs one base name (the bug this fixes).
  for (const [a, b] of TAHA) {
    assert.equal(scalar(`SELECT count(DISTINCT lower(public._product_parent_base_name(product_name))) FROM public.products WHERE id IN ('${a}', '${b}');`), '1',
      'the old rule no longer merges this pair; the case proves nothing');
  }
  for (const [sig, want] of Object.entries(PINS)) assert.equal(bodyMd5(sig), want, `${sig}: the replayed body is not the live body the preflight pins`);
  const aclBefore = Object.fromEntries(Object.keys(PINS).map((s) => [s, aclOf(s)]));
  // A parent PAR-1 already made for Zeta (EPA 300-1): a build after it must not propose a second one.
  const zeta = create({ name: '[PROVER] Zeta', product_form: 'liquid', generic_epa_registration: '300-1', category: 'Herbicide' },
    { product_name: '[PROVER] Zeta 1 gal', sku: 'ZE-1', inventory_unit: 'Gal' }, 'k-zeta');

  // [case] install
  stageText('cand.sql', lf(CANDIDATE));
  const installed = apply('cand.sql');
  assert.equal(installed.status, 0, installed.output);
  ledger(path.basename(CANDIDATE, '.sql'));
  for (const s of Object.keys(PINS)) assert.equal(aclOf(s), aclBefore[s], `${s}: grants, settings, owner or security changed`);
  assert.equal(scalar('SELECT public._product_parent_grouping_open();'), 'f');
  const again = apply('cand.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /PREFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_HELPERS_CHANGED/);
  console.log('[case] install: preflight pins match the replayed live bodies; grants, owner and settings unchanged; switch still off; a second run is refused');

  // [case] base-name rule (Taha finding 1)
  const BASES = [
    // Taha's examples and live's strength names: kept whole.
    ['UAN 28/0/0 Tote', 'UAN 28/0/0'], ['UAN 32/0/0 Tote', 'UAN 32/0/0'],
    ['Imidacloprid 2 lb/gal', 'Imidacloprid 2 lb/gal'], ['Imidacloprid 4 lb/gal 2.5 gal', 'Imidacloprid 4 lb/gal'],
    ['Talstar 2 G', 'Talstar 2 G'], ['Talstar 0.2 G', 'Talstar 0.2 G'],
    ['Starter 6/24/6', 'Starter 6/24/6'], ['Starter 3/24/6 2.5 gal', 'Starter 3/24/6'],
    ['Goldstart 6-24-6 (80/20)', 'Goldstart 6-24-6 (80/20)'], ['Aztec 4.67 G - 50# Bag', 'Aztec 4.67 G - 50#'],
    ['Counter 20 G 40 lb', 'Counter 20 G'], ['Seed Mix 500 g', 'Seed Mix 500 g'],
    // Sizes and packs still come off (PAR-2's own list).
    ['[PROVER] Gen Liberty 2.5 gal', '[PROVER] Gen Liberty'], ['Rho 2 x 2.5 gal', 'Rho'], ['Rho 4/1 gal', 'Rho'], ['Rho 2/2.5 gal', 'Rho'],
    ['Atra 4L 2.5 gal', 'Atra 4L'], ['Ester 6% 30 gal', 'Ester 6%'], ['Rho (2.5 gal)', 'Rho'], ['Soy 50 lb bag', 'Soy'],
    ['Rho Bulk', 'Rho'], ['Rho Tote', 'Rho'], ['Rho 12 ct case', 'Rho'], ['#2 Mix 2.5gal', '#2 Mix'],
    ['Corn Mix Safened 2.5 gal', 'Corn Mix Safened'], ['Gen Liberty: Higher Quality 2.5 gal', 'Gen Liberty: Higher Quality'],
    ['2.5 gal', ''], ['Mix 1 Pt', 'Mix'], ['Mix 32 fl oz', 'Mix'], ['Mix 1.5 Qts.', 'Mix'], ['Galaxy 2.5 gal', 'Galaxy'],
    ['Atra 4G 2.5 gal', 'Atra 4G'], ['Atra 4g', 'Atra 4g'],
    // A concentration written with spaces around the slash is still a strength (Luna round 4).
    ['Imidacloprid 2 lb / gal 2.5 gal', 'Imidacloprid 2 lb / gal'], ['Mix 4 lb /gal', 'Mix 4 lb /gal'],
  ];
  // The numbers check: every number in the name, by value with the word after it and in order, less the last one
  // equal to the recorded container size whose unit word is the product's own unit.
  for (const [name, size, unit, want] of [['Imida 2 lb./gal 2.5 gal', 2.5, 'Gal', '{"2 lb"}'], ['Wex 2 lb./gal 2 gal', 2, 'Gal', '{"2 lb"}'],
    ['Rho 1.0 gal', 1, 'Gal', '{}'], ['Rho 2 x 2.5 gal', 2.5, 'Gal', '{"2 x"}'], ['UAN 28/0/0 Tote', 275, 'Gal', '{28,0,"0 tote"}'],
    ['Lam 2 oz ai/gal 2.5 gal', 2.5, 'Gal', '{"2 oz"}'],
    // Order kept, last match removed: a strength and a pack count cannot trade places (Luna round 5).
    ['Mix 2 lb./gal 4 x 2 gal', 2, 'Gal', '{"2 lb","4 x"}'], ['Mix 4 lb./gal 2 x 4 gal', 4, 'Gal', '{"4 lb","2 x"}'],
    // The unit word decides which number is the size (Luna round 7).
    ['Imida 2 lb ai/gal', 2, 'Gal', '{"2 lb"}'], ['Acc 18 oz', 18, 'Dry oz', '{}'],
    // Only the last number written with a unit is the size (Sol): a ratio or a size written first stays.
    ['Blend 2 gal concentrate per 10 gal', 2, 'Gal', '{"2 gal","10 gal"}'], ['Mix 2 gal 2 lb/gal', 2, 'Gal', '{"2 gal","2 lb"}'],
    ['Gen 1LB: 1 Gal', 1, 'Gal', '{"1 lb"}'], ['Sack 50 lbs', 50, 'Lb', '{}'], ['Rho 2.5 gallons', 2.5, 'GAL', '{}'],
    // No size or no usable unit: nothing is removed, so the group is held, never merged.
    ['Rho 1 gal', null, 'Gal', '{"1 gal"}'], ['Rho 2.5 gal', 2.5, null, '{"2.5 gal"}'], ['Rho 2.5 gal', 2.5, 'Ea', '{"2.5 gal"}'],
    ['Mix .5 gal', 0.5, 'Gal', '{}']]) {
    assert.equal(scalar(`SELECT public._product_name_strength_tokens(${lit(name)}, ${size ?? 'NULL'}, ${unit === null ? 'NULL' : lit(unit)})::text;`), want, `numbers of ${name}`);
  }
  for (const [input, want] of BASES) assert.equal(scalar(`SELECT '>' || public._product_parent_base_name(${lit(input)}) || '<';`), `>${want}<`, `base name of ${input}`);
  for (const [a, b] of [['UAN 28/0/0 Tote', 'UAN 32/0/0 Tote'], ['Imidacloprid 2 lb/gal', 'Imidacloprid 4 lb/gal'], ['Talstar 2 G', 'Talstar 0.2 G'], ['Starter 6/24/6', 'Starter 3/24/6']]) {
    assert.equal(scalar(`SELECT lower(public._product_parent_base_name(${lit(a)})) = lower(public._product_parent_base_name(${lit(b)}));`), 'f', `${a} / ${b} share a base name`);
  }
  console.log(`[case] base-name rule: Taha's four pairs (UAN 28/0/0 vs 32/0/0, Imidacloprid 2 vs 4 lb/gal, Talstar 2 G vs 0.2 G, Starter 6/24/6 vs 3/24/6) never share a base name; ${BASES.length} names checked`);

  // [case] build (Taha findings 1 and 3)
  setSwitch(true);
  const P1 = build('k-build-1');
  assert.deepEqual(build('k-build-1'), P1, 'a retry returns the first receipt');
  const G = groups(P1.proposal_id);
  for (const [a, b] of TAHA) assert.notEqual(groupOf(G, a).id, groupOf(G, b).id, `${a} and ${b} were grouped`);
  const numo = groupOf(G, N1);
  assert.deepEqual(ids(numo), [N1, N2].sort());
  assert.equal(numo.status, 'held'); assert.ok(numo.flags.includes('size_numbers_differ')); assert.equal(numo.identity_basis, null);
  assert.match(numo.reason, /carry different numbers in their names besides their container size/);
  for (const [a, b] of STRENGTH_PAIRS) {
    const g = groupOf(G, a);
    assert.deepEqual(ids(g), [a, b].sort(), 'the pair should share a base name, or the case proves nothing');
    assert.equal(g.status, 'held'); assert.ok(g.flags.includes('size_numbers_differ'));
  }
  const rho = groupOf(G, R1);
  assert.deepEqual(ids(rho), [R1, R2, R3].sort()); assert.equal(rho.status, 'proposed');
  assert.ok(!rho.flags.includes('size_numbers_differ'));
  const z1 = groupOf(G, Z1);
  assert.deepEqual(ids(z1), [Z1]);
  assert.equal(z1.status, 'held'); assert.ok(z1.flags.includes('epa_has_parent'));
  assert.equal(z1.reason, 'parent "[PROVER] Zeta" already has EPA number 300-1, this form and this name; a second parent is never made for one product');
  const zd = groupOf(G, ZD);
  assert.deepEqual(ids(zd), [ZD]); assert.equal(zd.status, 'proposed', 'a dry product is not a second parent for the liquid one');
  assert.ok(zd.flags.includes('epa_has_parent'));
  assert.deepEqual(P1.duplicate_parents, []);
  const z2 = groupOf(G, Z2);
  assert.equal(z2.status, 'proposed', 'a different name with the same EPA number is a flag, never a hold');
  assert.ok(z2.flags.includes('epa_has_parent')); assert.ok(z2.flags.includes('same_epa_different_name'));
  assert.ok(!G.some((g) => g.members.some((m) => m.product_id === zeta.product_id)), 'a grouped size was proposed');
  assert.equal(P1.held_count, G.filter((g) => g.status === 'held').length);
  assert.equal(P1.rejected_count, 0);
  console.log("[case] build: Taha's pairs land in separate groups; a group whose names carry different numbers besides their container size is held size_numbers_differ (Numo, and strengths written lb./gal, lb ai/gal, oz ai/gal, with the size's own number, or traded with a pack count, or one number in another unit); Rho 1.0 gal joins Rho; Zeta (EPA 300-1, liquid parent exists) is held, Zeta Pro (same EPA, other name) and Zeta dry are proposed with epa_has_parent");

  // [case] approval after a parent appeared (Taha finding 3)
  const kappa = groupOf(G, K1);
  assert.deepEqual(ids(kappa), [K1, K2].sort()); assert.equal(kappa.status, 'proposed');
  const madeAfter = `SELECT public.create_product_with_parent(${J({ name: '[PROVER] Kappa', product_form: 'liquid', generic_epa_registration: '400-1', category: 'Herbicide' })},
    ${J({ product_name: '[PROVER] Kappa 1 gal', sku: 'KA-1', inventory_unit: 'Gal' })}, 'k-kappa');`;
  // The parent is made and the approval refused in one transaction, so nothing stays.
  const raced = as(ADMIN, `${madeAfter}\n${approve(P1, [entry(kappa)], 'k-kappa-approve')}`);
  assert.notEqual(raced.status, 0);
  assert.match(raced.output, /PRODUCT_PARENT_EPA_HAS_PARENT: parent "\[PROVER\] Kappa" already has EPA number 400-1 and this name/);
  // The name submitted at approval counts too (Sol): a parent "Foo" with Rho's EPA number refuses Rho approved as "Foo (EPA ...)".
  const rhoG = groupOf(G, R1);
  const fooFirst = `SELECT public.create_product_with_parent(${J({ name: '[PROVER] Foo', product_form: 'liquid', generic_epa_registration: rhoG.generic_epa_registration, category: 'Herbicide' })},
    ${J({ product_name: '[PROVER] Foo 1 gal', sku: 'FO-1', inventory_unit: 'Gal' })}, 'k-foo');`;
  const renamed = as(ADMIN, `${fooFirst}\n${approve(P1, [entry(rhoG, { name: `[PROVER] Foo (EPA ${rhoG.generic_epa_registration})` })], 'k-rho-foo')}`);
  assert.notEqual(renamed.status, 0);
  assert.match(renamed.output, /PRODUCT_PARENT_EPA_HAS_PARENT: parent "\[PROVER\] Foo" already has EPA number 600-2 and this name/);
  // One call cannot make two parents for one product (Sol): no EPA number, one form, one name after approval's suffixes.
  const [u1g, u2g] = [groupOf(G, I1), groupOf(G, I2)];
  assert.equal(u1g.status, 'proposed'); assert.equal(u2g.status, 'proposed');
  refused(ADMIN, approve(P1, [entry(u1g, { name: '[PROVER] Dup', owner_confirmed: true }),
    entry(u2g, { name: '[PROVER] Dup (liquid)', owner_confirmed: true })], 'k-dup-batch'),
  /PRODUCT_PARENT_EPA_HAS_PARENT: parent "\[PROVER\] Dup[^"]*" already has EPA number none and this name/);
  const kappaDone = call(ADMIN, approve(P1, [entry(kappa)], 'k-kappa-ok'));
  assert.equal(scalar(`SELECT count(*) FROM public.product_parent_members WHERE parent_id = '${kappaDone.groups[0].parent_id}';`), '2');
  console.log('[case] approval: a group whose EPA number and name match a parent made after the build is refused PRODUCT_PARENT_EPA_HAS_PARENT; without that parent it is approved; the name submitted at approval is checked too, and one call cannot make two parents for one product, with or without an EPA number');

  // [case] rejection carried (Taha finding 4)
  const xeno = groupOf(G, X1);
  assert.deepEqual(ids(xeno), [X1, X2].sort());
  call(ADMIN, decide('reject', xeno, 1, 'not one product', 'k-x-reject'));
  const decided = scalar(`SELECT decided_by || '|' || decided_at FROM public.product_parent_proposal_groups WHERE id = '${xeno.id}';`);
  const P2 = build('k-build-2');
  assert.equal(P2.rejected_count, 1);
  let x = groupOf(groups(P2.proposal_id), X1);
  assert.equal(x.status, 'rejected'); assert.equal(x.reason, 'not one product');
  assert.ok(x.flags.includes('rejected_before'));
  assert.equal(scalar(`SELECT decided_by || '|' || decided_at FROM public.product_parent_proposal_groups WHERE id = '${x.id}';`), decided);
  refused(ADMIN, approve(P2, [entry(x)], 'k-x-approve'), /PRODUCT_PARENT_GROUP_NOT_PROPOSED/);
  // A held group stays held, never carried as rejected: Numo is held again.
  assert.equal(groupOf(groups(P2.proposal_id), N1).status, 'held');
  // One of its sizes changes: the group is proposed again, with the earlier rejection in its reason.
  psql(`BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true), set_config('app.product_active_rpc', 'on', true); UPDATE public.products SET is_active = false WHERE id = '${X2}'; COMMIT;`);
  const P3 = build('k-build-3');
  x = groupOf(groups(P3.proposal_id), X1);
  assert.equal(P3.rejected_count, 0);
  assert.equal(x.status, 'proposed'); assert.ok(x.flags.includes('rejected_before'));
  assert.match(x.reason, /^rejected on \d{4}-\d{2}-\d{2} \(not one product\); a size changed since, so it is proposed again$/);
  call(ADMIN, decide('reject', x, 3, 'still not one product', 'k-x-reject-2'));
  x = groupOf(groups(build('k-build-4').proposal_id), X1);
  assert.equal(x.status, 'rejected'); assert.equal(x.reason, 'still not one product');
  // A different set of sizes is a new group: no carry.
  psql(`INSERT INTO public.products (id, product_name, sku, category, epa_registration, product_form, inventory_unit, is_active, container_size, container_unit)
    VALUES ('${id('2b')}', '[PROVER] Xeno 30 gal', 'XE-30', 'Herbicide', '900-1', 'liquid', 'Gal', true, 30, 'Gal');`);
  x = groupOf(groups(build('k-build-5').proposal_id), X1);
  assert.equal(x.status, 'proposed'); assert.ok(!x.flags.includes('rejected_before'));
  // Rejected, then held for another reason (a parent with its EPA number, form and name appears): the rejection stays named.
  call(ADMIN, decide('reject', x, 5, 'xeno again', 'k-x-reject-3'));
  create({ name: '[PROVER] Xeno', product_form: 'liquid', generic_epa_registration: '900-1', category: 'Herbicide' },
    { product_name: '[PROVER] Xeno Pail 5 gal', sku: 'XE-P', inventory_unit: 'Gal' }, 'k-xeno-parent');
  x = groupOf(groups(build('k-build-6').proposal_id), X1);
  assert.equal(x.status, 'held'); assert.ok(x.flags.includes('rejected_before'));
  assert.match(x.reason, /already has EPA number 900-1.*; rejected on \d{4}-\d{2}-\d{2} \(xeno again\)$/);
  console.log('[case] rejection carried: a rebuild keeps a rejection (reason, who, when) while its sizes are unchanged; a changed size proposes it again with the earlier rejection named; a different set of sizes starts fresh; a rejected group later held keeps the rejection in its reason');

  // [case] duplicate parents are warned, not blocked (Mason, 2026-11-06)
  // A hand-made parent with Kappa's EPA number, form and base name (also one carrying approval's "(EPA ...)"
  // suffix) is allowed by the database; the next build lists them and holds a matching group.
  create({ name: '[PROVER] Kappa Bulk', product_form: 'liquid', generic_epa_registration: '400-1', category: 'Herbicide' },
    { product_name: '[PROVER] Kappa Bulk 30 gal', sku: 'KA-B', inventory_unit: 'Gal' }, 'k-kappa-bulk');
  create({ name: '[PROVER] Kappa (EPA 400-1)', product_form: 'liquid', generic_epa_registration: '400-1', category: 'Herbicide' },
    { product_name: '[PROVER] Kappa X 1 gal', sku: 'KA-X', inventory_unit: 'Gal' }, 'k-kappa-suffix');
  for (const [a, b] of [['Base (EPA 600-1)', 'Base 2.5 gal'], ['Base (liquid) #3', 'base'], ['Base (EPA 600-1) (liquid) #2', 'Base Tote']]) {
    assert.equal(scalar(`SELECT public._product_parent_identity_name(${lit(a)}) = public._product_parent_identity_name(${lit(b)});`), 't', `${a} / ${b}`);
  }
  assert.equal(scalar(`SELECT public._product_parent_identity_name('Mix #2') = public._product_parent_identity_name('Mix');`), 'f', 'a "#2" in a real name was stripped');
  // Same EPA number under another name is not a duplicate (the build sheet's same-EPA-different-name rule).
  create({ name: '[PROVER] Kappa Max', product_form: 'liquid', generic_epa_registration: '400-1', category: 'Herbicide' },
    { product_name: '[PROVER] Kappa Max 1 gal', sku: 'KA-M', inventory_unit: 'Gal' }, 'k-kappa-max');
  psql(`INSERT INTO public.products (id, product_name, sku, category, epa_registration, product_form, inventory_unit, is_active, container_size, container_unit)
    VALUES ('${id('3b')}', '[PROVER] Kappa 5 gal', 'KA-5', 'Herbicide', '400-1', 'liquid', 'Gal', true, 5, 'Gal');`);
  // Without an EPA number (Sol): two hand-made "Nu" parents are listed, and an unparented Nu size is held.
  create({ name: '[PROVER] Nu', product_form: 'liquid', category: 'Adjuvant' }, { product_name: '[PROVER] Nu 1 gal', sku: 'NV-1', inventory_unit: 'Gal' }, 'k-nu');
  create({ name: '[PROVER] Nu (liquid)', product_form: 'liquid', category: 'Adjuvant' }, { product_name: '[PROVER] Nu X 1 gal', sku: 'NV-X', inventory_unit: 'Gal' }, 'k-nu-2');
  psql(`INSERT INTO public.products (id, product_name, sku, category, epa_registration, product_form, inventory_unit, is_active, container_size, container_unit)
    VALUES ('${id('44')}', '[PROVER] Nu 5 gal', 'NV-5', 'Adjuvant', null, 'liquid', 'Gal', true, 5, 'Gal');`);
  const PD = build('k-build-dup');
  assert.deepEqual(PD.duplicate_parents, [{ generic_epa_registration: '400-1', product_form: 'liquid',
    names: ['[PROVER] Kappa', '[PROVER] Kappa (EPA 400-1)', '[PROVER] Kappa Bulk'] },
  { generic_epa_registration: null, product_form: 'liquid', names: ['[PROVER] Nu', '[PROVER] Nu (liquid)'] }]);
  const k5 = groupOf(groups(PD.proposal_id), id('3b'));
  assert.equal(k5.status, 'held'); assert.ok(k5.flags.includes('epa_has_parent'));
  const nu5 = groupOf(groups(PD.proposal_id), id('44'));
  assert.equal(nu5.status, 'held'); assert.ok(nu5.flags.includes('epa_has_parent'));
  assert.match(nu5.reason, /already has EPA number none, this form and this name/);
  console.log('[case] duplicate parents warned: hand-made parents with one EPA number, form and base name are allowed, the next build lists them in duplicate_parents and holds a matching group, with or without an EPA number; another name with the same EPA number is not listed');

  // [case] moving a size between parents with different brand lists (Taha finding 2)
  const mu = create({ name: '[PROVER] Mu', product_form: 'liquid', category: 'Herbicide' },
    { product_name: '[PROVER] Mu 1 gal', sku: 'MU-1', inventory_unit: 'Gal' }, 'k-mu');
  const mu2 = create({ name: '[PROVER] Mu Two', product_form: 'liquid', category: 'Herbicide' },
    { product_name: '[PROVER] Mu Two 1 gal', sku: 'MU2-1', inventory_unit: 'Gal' }, 'k-mu2');
  const acme = call(ADMIN, brand(mu.parent_id, 'Acme', 'Acme Co', true, 'Danger', 'k-b-acme'));
  call(ADMIN, brand(mu2.parent_id, 'Other', 'Other Co', false, 'Caution', 'k-b-other'));
  const differ = /PRODUCT_PARENT_BRANDS_DIFFER: "\[PROVER\] Mu" and "\[PROVER\] Mu Two" list different brands/;
  let m = preview(mu.product_id, mu2.parent_id);
  assert.match(m.refusal, differ);
  refused(ADMIN, move(mu.product_id, mu2.parent_id, m, 'k-move-1'), differ);
  // Same brand name, different RUP flag: still a different list.
  call(ADMIN, brand(mu.parent_id, 'Acme', 'Acme Co', true, 'Danger', 'k-b-acme-r', { id: acme.id, version: 1, retire: true, reason: 'not carried' }));
  const otherRup = call(ADMIN, brand(mu.parent_id, 'Other', 'Other Co', true, 'Caution', 'k-b-other-rup'));
  assert.match(preview(mu.product_id, mu2.parent_id).refusal, differ);
  call(ADMIN, brand(mu.parent_id, 'Other', 'Other Co', false, 'Caution', 'k-b-other-fix', { id: otherRup.id, version: 1 }));
  m = preview(mu.product_id, mu2.parent_id);
  assert.equal(m.refusal, null, 'equal brand lists must allow the move');
  // A whole-transaction snapshot could compare stale brand lists after the locks: refused before anything moves.
  const rrMove = psql(`BEGIN ISOLATION LEVEL REPEATABLE READ;
    SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
    SET LOCAL ROLE authenticated;
    ${move(mu.product_id, mu2.parent_id, m, 'k-move-rr')}
    COMMIT;`, { allowFailure: true });
  assert.notEqual(rrMove.status, 0);
  assert.match(`${rrMove.stdout}\n${rrMove.stderr}`, /PRODUCT_PARENT_READ_COMMITTED_REQUIRED/);
  const moved = call(ADMIN, move(mu.product_id, mu2.parent_id, m, 'k-move-2'));
  assert.equal(moved.from_parent_inactive, true);
  assert.equal(moved.from_parent_brands_retired, 1);
  assert.equal(scalar(`SELECT is_active FROM public.product_parents WHERE id = '${mu.parent_id}';`), 'f');
  assert.equal(scalar(`SELECT string_agg(concat_ws('|', brand_name, status, row_version), ',' ORDER BY brand_name) FROM public.product_parent_brands WHERE parent_id = '${mu.parent_id}';`),
    'Acme|retired|2,Other|retired|3');
  assert.equal(scalar(`SELECT concat_ws('|', event_type, reason, before_values->>'status', after_values->>'status') FROM public.product_parent_brand_events WHERE parent_brand_id = '${otherRup.id}' ORDER BY id DESC LIMIT 1;`),
    'retired|the parent has no sizes left after its last size moved: wrong group|active|retired');
  assert.equal(scalar(`SELECT string_agg(brand_name || ':' || status, ',') FROM public.product_parent_brands WHERE parent_id = '${mu2.parent_id}';`), 'Other:active');
  assert.deepEqual(call(REP, `SELECT public.get_product_brands('${mu.product_id}');`).brands.map((b) => b.brand_name), ['Other']);
  console.log("[case] move: a different brand list (another brand, or the same name with another RUP flag) is refused PRODUCT_PARENT_BRANDS_DIFFER in the preview and the move; with equal lists the move runs (refused under REPEATABLE READ), and the emptied parent's brands are retired with a logged event");

  // [case] live smoke chains: the post-apply chains run here first, with one active profile per probed role.
  const others = [['a3', 'driver'], ['a4', 'applicator'], ['a5', 'entity_recipient']];
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ${others.map(([n, r]) =>
    `('${id(n)}', 'pp2fix-${r}@example.invalid', '{"full_name":"[PROVER] ${r}","role":"${r}"}'::jsonb)`).join(', ')};`);
  asOwner(others.map(([n, r]) => `UPDATE public.profiles SET role = '${r}', is_active = true WHERE id = '${id(n)}';`).join('\n'));
  setSwitch(false); // as live is
  for (const chainFile of ['smoke-product_parent_proposals.sql', 'smoke-product_parents.sql', 'smoke-upsert-product-brand.sql']) {
    const chain = docker([...psqlArgs(), '-f', '-'], { input: lf(path.join(ROOT, 'scripts/smoke', chainFile)), allowFailure: true });
    assert.match(`${chain.stdout}\n${chain.stderr}`, /SMOKE_PASS_ROLLBACK/, `${chainFile}:\n${chain.stdout}\n${chain.stderr}`);
  }
  assert.equal(scalar('SELECT public._product_parent_grouping_open();'), 'f', 'a smoke chain left grouping on');
  console.log('[case] live smoke chains: smoke-product_parent_proposals.sql, smoke-product_parents.sql and smoke-upsert-product-brand.sql pass on the post-apply schema');
  const costRows = docker([...psqlArgs(), '-A', '-t', '-f', '-'], { input: lf(path.join(ROOT, 'scripts/db-invariant-sweeps/predicates/cost-exposure-review.sql')) })
    .stdout.split(/\r?\n/).filter((l) => /parent|brand|move_product_size/i.test(l));
  for (const row of costRows) console.log(`[cost-exposure] ${row}`);

  // [case] rollback
  stageText('rollback.sql', rollbackSql());
  const rolled = apply('rollback.sql');
  assert.equal(rolled.status, 0, rolled.output);
  assert.equal(scalar(`SELECT to_regprocedure('public._product_name_strength_tokens(text,numeric,text)') IS NULL;`), 't');
  assert.equal(scalar(`SELECT to_regprocedure('public._product_parent_identity_name(text)') IS NULL;`), 't');
  for (const [sig, want] of Object.entries(PINS)) assert.equal(bodyMd5(sig), want, `${sig}: the rollback did not restore the live body`);
  for (const s of Object.keys(PINS)) assert.equal(aclOf(s), aclBefore[s], `${s}: the rollback changed grants, settings, owner or security`);
  // An open proposal built by the old rules refuses the install; once superseded, the candidate installs again.
  assert.ok(Number(scalar(`SELECT count(*) FROM public.product_parent_proposals WHERE status = 'open';`)) > 0, 'no open proposal to refuse on');
  const blocked = apply('cand.sql');
  assert.notEqual(blocked.status, 0); assert.match(blocked.output, /PREFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_OPEN_PROPOSAL/);
  asOwner(`UPDATE public.product_parent_proposals SET status = 'superseded' WHERE status = 'open';`);
  const reinstalled = apply('cand.sql');
  assert.equal(reinstalled.status, 0, reinstalled.output);
  console.log('[case] rollback: re-issuing the five old bodies and dropping the two new helpers restores exactly the bodies the preflight pins (and their grants); an open proposal refuses the install, and once superseded the candidate installs again on top');

  console.log('PRODUCT_PARENT_REVIEW_FIXES_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
