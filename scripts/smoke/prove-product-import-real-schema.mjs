#!/usr/bin/env node
/**
 * Real-schema proof for WP-PM-10 (20261107090000): bulk product import through the setup save's insert
 * mode. Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays
 * migrations up to the candidate (including the rate lock 20261107060000 and the setup workbook
 * 20261107080000), seeds invented rows, and checks: the preview and the insert are admin-only; the
 * preview names every bad row of a test file with its reason and saves nothing; the confirmed rows
 * save all-or-nothing, retry-safe, with use timings, notes with a line break and rates (through
 * set_product_rates, with the per-acre prices the preview showed, checked to the cent); a re-import of
 * the same file is flagged and refused as duplicates while the same EPA number under another name is
 * allowed; a price that moved since the preview is refused; with the lock on a rated row is refused
 * and unrated rows still save; and the Setup tab's update save (11a-2) still works unchanged.
 *
 * Run: node scripts/smoke/prove-product-import-real-schema.mjs   (needs local Docker image)
 * Prints PRODUCT_IMPORT_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-import-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261107090000_product_import.sql');
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
const TOUCHED = /(preview_product_import|_apply_product_setup_update|apply_product_setup|FUNCTION\s+(public\.)?"?(set_product_rates|preview_product_rate_correction|_product_rate_value_ok|_product_rate_value|_product_rate_unit_ok|is_admin|check_idempotency|save_idempotency|product_price_per_acre)\b)/i;
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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}



const id = (n) => `7a7e1000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
const EXISTING = id('c1');
const OLD = id('c2');

function asOwner(sql) { psql(`SET session_replication_role = replica;
${sql}
SET session_replication_role = origin;`, { user: 'supabase_admin' }); }
function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'im-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'im-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  asOwner(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    -- Live's factors (read 2026-11-03); the schema baseline carries no unit rows.
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Gal', 128, 'liquid'), ('oz', 1, 'liquid'), ('Pt', 16, 'liquid'), ('Lb', 16, 'dry');
    INSERT INTO public.product_form_units (product_form, unit) VALUES ('seed', 'Lb');
    INSERT INTO public.products (id, product_name, sku, category, epa_registration, product_form, inventory_unit, is_active, tier1_price)
    VALUES ('${EXISTING}', '[PROVER] Existing Herb', 'EX-1', 'Herbicide', '524-475', 'liquid', 'Gal', true, 40.00),
           ('${OLD}', '[PROVER] Old Thing', 'EX-2', 'Herbicide', NULL, 'liquid', 'Gal', false, 10.00);`);
  console.log('[prover] seeded an admin, a sales rep, one active and one inactive invented product');
}
// One transaction as a signed-in browser session (role authenticated, live's JWT claims), or as a
// signed-out visitor (role anon) when uid is null.
function as(uid, sql) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true,
    input: `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(r.output, pattern);
}
const q = (v) => JSON.stringify(v).replaceAll("'", "''");
const preview = (rows, uid = ADMIN) => JSON.parse(ok(uid, `SELECT public.preview_product_import('${q(rows)}'::jsonb);`));
const save = (rows, key, actor = ADMIN) => `SELECT public.apply_product_setup('${q(rows)}'::jsonb, '${actor}', '${key}');`;
// What the screen sends: each confirmed row, with the preview's prices when it carries rates.
const fromPreview = (rows, p) => rows.map((r, i) => (r.rates ? { ...r, expected_prices: p.rows[i].expected_prices } : r));
const count = () => scalar('SELECT count(*) FROM public.products;');
const field = (name, cols) => scalar(`SELECT concat_ws('|', ${cols}) FROM public.products WHERE product_name = '${name.replaceAll("'", "''")}';`);
// The amount exactly as returned, refused unless whole cents.
const cents = (v) => { assert.match(String(v), /^[0-9]+([.][0-9]{1,2})?$/, `${v} is not whole cents`); return Number(v).toFixed(2); };
const TIERS = ['tier1_price_per_acre', 'tier2_price_per_acre', 'tier3_price_per_acre'];

// A test file: five good rows and ten known-bad rows, as the screen sends them after parsing.
const good = [
  { insert: { product_name: '[PROVER] New Liquid', sku: 'IM-1', category: 'Herbicide', product_form: 'liquid', inventory_unit: 'Gal',
    container_size: '2.5', container_type: 'Jug', epa_registration: '100-1234', is_rup: true, signal_word: 'Caution',
    rei_hours: 12, phi_days: 30, max_label_rate: '32', max_label_rate_unit: 'oz', use_timing: 'pre-emerge; Post-Emergence',
    vendor: 'Acme Supply', manufacturer: 'Acme', notes: '  line one\nline two, "quoted"\n' },
    rates: { rate_per_acre: '4', rate_unit: 'oz', suggested_rate: '4 oz/A' } },
  { insert: { product_name: '[PROVER] New Seed', sku: 'IM-2', category: 'Seed', product_form: 'seed', inventory_unit: 'Lb' },
    rates: { rate_per_acre: '2', rate_unit: null, suggested_rate: null } },
  { insert: { product_name: '[PROVER] New Dry', sku: 'IM-3', product_form: 'dry', inventory_unit: 'Lb', container_type: 'Bag' } },
  // Another size of the existing product: same EPA, its own name and SKU, allowed.
  { insert: { product_name: '[PROVER] Existing Herb 30 Gal', sku: 'EX-1-30', category: 'Herbicide', epa_registration: '524-475', product_form: 'liquid', inventory_unit: 'Gal' } },
  { insert: { product_name: '[PROVER] Plain', sku: 'IM-5' } },
];
const bad = [
  [{ insert: { product_name: '', sku: 'BAD-1' } }, /PRODUCT_SETUP_INVALID/],
  [{ insert: { product_name: '[PROVER] Zero Size', container_size: '0' } }, /PRODUCT_SETUP_INVALID/],
  [{ insert: { product_name: '[PROVER] Bad Category', category: 'Nope' } }, /PRODUCT_SETUP_ROW_REFUSED: \[PROVER\] Bad Category/],
  [{ insert: { product_name: '[PROVER] Bad EPA', epa_registration: 'abc' } }, /PRODUCT_SETUP_ROW_REFUSED: \[PROVER\] Bad EPA: .*EPA/],
  [{ insert: { product_name: '[PROVER] Bad Container', container_type: 'Bucket' } }, /PRODUCT_SETUP_ROW_REFUSED: \[PROVER\] Bad Container/],
  [{ insert: { product_name: '[PROVER] Bad Timing', category: 'Herbicide', use_timing: 'Sideways' } }, /Unknown use timing "Sideways"/],
  [{ insert: { product_name: '[PROVER] Bad Unit', product_form: 'liquid', inventory_unit: 'Gal' }, rates: { rate_per_acre: '3', rate_unit: 'furlongs', suggested_rate: null } }, /PRODUCT_RATE_UNIT_INVALID/],
  [{ insert: { product_name: '[PROVER] No Unit', product_form: 'liquid', inventory_unit: 'Gal' }, rates: { rate_per_acre: '3', rate_unit: null, suggested_rate: null } }, /PRODUCT_RATE_UNIT_INVALID/],
  [{ insert: { product_name: '[PROVER] Dup SKU', sku: 'ex-1 ' } }, /PRODUCT_SETUP_DUPLICATE: .*Dup SKU/],
  [{ insert: { product_name: '[proVER] existing herb' } }, /PRODUCT_SETUP_DUPLICATE/],
];

function main() {
  buildContainer();
  seed();
  stageText('cand.sql', lf(CANDIDATE));
  const installed = apply('cand.sql');
  assert.equal(installed.status, 0, installed.output);
  ledger(path.basename(CANDIDATE, '.sql'));
  console.log('[prover] installs on top of the rate lock (20261107060000) and the setup workbook (20261107080000)');

  // Admin only; the renamed Setup-tab body is not callable directly.
  refused(REP, `SELECT public.preview_product_import('${q(good)}'::jsonb);`, /ADMIN_REQUIRED/);
  refused(null, `SELECT public.preview_product_import('${q(good)}'::jsonb);`, /permission denied/);
  refused(REP, save(good, 'k-rep', REP), /ADMIN_REQUIRED/);
  refused(null, save(good, 'k-anon'), /permission denied/);
  refused(ADMIN, `SELECT public._apply_product_setup_update('[]'::jsonb, '${ADMIN}', 'k');`, /permission denied/);
  console.log('[prover] the import preview and insert are admin-only; the Setup-tab body is internal');

  // Preview: every bad row is named with its reason; nothing is saved.
  const before = count();
  // Everything a save writes besides products: retry receipts, change history, vendor links, cost history.
  const leftovers = () => scalar(`SELECT concat_ws('|', (SELECT count(*) FROM public.idempotency_keys),
    (SELECT count(*) FROM public.product_change_history), (SELECT count(*) FROM public.product_supplier_links),
    (SELECT count(*) FROM public.cost_history));`);
  const leftBefore = leftovers();
  const file = [...good, ...bad.map(([r]) => r)];
  const p = preview(file);
  assert.equal(p.rates_locked, false);
  good.forEach((g, i) => assert.equal(p.rows[i].status, 'ok', `${g.insert.product_name}: ${p.rows[i].error}`));
  bad.forEach(([, why], i) => {
    const r = p.rows[good.length + i];
    assert.equal(r.status, 'refused', `bad row ${i + 1} passed`);
    assert.match(r.error, why, `bad row ${i + 1}`);
  });
  assert.equal(p.rows[good.length + 8].sku_matches[0].product_name, '[PROVER] Existing Herb', 'the duplicate SKU names the product');
  assert.equal(p.rows[3].epa_matches[0].product_name, '[PROVER] Existing Herb', 'same EPA, another name: shown, allowed');
  assert.equal(count(), before, 'a preview saves nothing');
  assert.equal(leftovers(), leftBefore, 'a preview leaves no receipt, history, vendor link or cost history');  // Per-acre prices to the cent: a new product carries no price, so tier 1-3 per acre are $0.00 once a rate is set.
  for (const t of TIERS) {
    assert.equal(cents(p.rows[0].expected_prices[t]), '0.00');
    assert.equal(cents(p.rows[0].after[t]), '0.00');
  }
  assert.equal(p.rows[1].after.rate_unit, 'Lb', 'a seed rate takes its stock unit');
  console.log('[prover] preview: 10 known-bad rows each refused with its reason; 5 good rows previewed with per-acre prices; nothing saved');

  // A file with a bad row is refused whole, naming it.
  refused(ADMIN, save([good[4], { insert: { product_name: '[PROVER] Bad Category', category: 'Nope' } }], 'k-mixed'),
    /PRODUCT_SETUP_ROW_REFUSED: \[PROVER\] Bad Category/);
  assert.equal(count(), before, 'all or nothing');
  // Prices that moved since the preview are refused; rates must come with the preview's prices.
  refused(ADMIN, save([{ ...good[0], expected_prices: { tier1_price_per_acre: 1, tier2_price_per_acre: 1, tier3_price_per_acre: 1 } }], 'k-moved'), /PRODUCT_RATE_PREVIEW_CHANGED/);
  refused(ADMIN, save([good[0]], 'k-no-prices'), /PRODUCT_SETUP_ROW_SHAPE_INVALID/);
  refused(ADMIN, save([{ insert: { product_name: '[PROVER] Direct Rate', rate_per_acre: '1' } }], 'k-direct'), /PRODUCT_SETUP_ROW_SHAPE_INVALID/);
  refused(ADMIN, save([{ insert: { product_name: '[PROVER] Direct Price', tier1_price: '1' } }], 'k-price'), /PRODUCT_SETUP_ROW_SHAPE_INVALID/);
  refused(ADMIN, save([good[4], { product_id: EXISTING, setup_fingerprint: 'x', changes: { sku: 'Z' } }], 'k-mix'), /PRODUCT_SETUP_ROW_SHAPE_INVALID/);
  refused(ADMIN, `SELECT public.apply_product_setup('${q([good[4]])}'::jsonb, '${ADMIN}', NULL);`, /IDEMPOTENCY_KEY_REQUIRED/);
  refused(ADMIN, save([good[4], good[4]], 'k-twice'), /PRODUCT_SETUP_DUPLICATE/);
  assert.equal(count(), before);
  console.log('[prover] a bad row refuses the whole file by name; moved prices, missing prices, direct rate or price columns, mixed modes and in-file duplicates are refused');

  // Save the confirmed rows from the preview.
  const confirmed = fromPreview(good, p);
  const saved = JSON.parse(ok(ADMIN, save(confirmed, 'k-import-1')));
  assert.equal(saved.inserted_count, 5);
  assert.equal(count(), String(Number(before) + 5));
  assert.equal(field('[PROVER] New Liquid', "sku, category, product_form, inventory_unit, container_size, container_type, epa_registration, is_rup, signal_word, rei_hours, phi_days, max_label_rate, max_label_rate_unit, array_to_string(use_timings, ','), use_timing, vendor, manufacturer, rate_per_acre, rate_unit, suggested_rate, is_active"),
    'IM-1|Herbicide|liquid|Gal|2.5|Jug|100-1234|t|Caution|12|30|32|oz|pre_emerge,post_emergence|Pre-Emerge; Post-Emergence|Acme Supply|Acme|4|oz|4 oz/A|t');
  assert.equal(scalar("SELECT notes = E'  line one\\nline two, \"quoted\"\\n' FROM public.products WHERE product_name = '[PROVER] New Liquid';"), 't', 'a note keeps its spacing and line breaks');
  assert.equal(field('[PROVER] New Seed', 'rate_per_acre, rate_unit'), '2|Lb');
  assert.equal(field('[PROVER] New Dry', "coalesce(rate_per_acre::text, '-'), coalesce(rate_unit, '-')"), '-|-');
  for (const r of saved.rows.filter((x) => x.rate_per_acre !== null)) {
    for (const t of TIERS) assert.equal(cents(r[t]), '0.00');
  }
  assert.deepEqual(JSON.parse(ok(ADMIN, save(confirmed, 'k-import-1'))), saved, 'a same-key retry answers the same');
  assert.equal(count(), String(Number(before) + 5), 'a retry adds nothing');
  refused(ADMIN, save([good[4]], 'k-import-1'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  console.log('[prover] the confirmed rows save once, with use timings, a multi-line note and rates through set_product_rates; per-acre prices $0.00 to the cent; retry-safe');

  // Re-import of the same file: every row is flagged as a duplicate, and the save refuses it.
  const again = preview(good);
  again.rows.forEach((r) => {
    assert.equal(r.status, 'refused');
    assert.ok(r.sku_matches.length + r.name_matches.length > 0, `${r.product_name} not flagged as a duplicate`);
  });
  refused(ADMIN, save(confirmed, 'k-import-2'), /PRODUCT_SETUP_DUPLICATE/);
  // An inactive product's name may be reused (its SKU may not).
  assert.equal(preview([{ insert: { product_name: '[PROVER] Old Thing', sku: 'OLD-NEW' } }]).rows[0].status, 'ok');
  assert.equal(preview([{ insert: { product_name: '[PROVER] Old Thing 2', sku: 'EX-2' } }]).rows[0].status, 'refused');
  console.log('[prover] re-importing the same file flags every row as a duplicate and the save refuses it');

  // Lock on: a rated row is refused in preview and save; unrated rows still import.
  ok(ADMIN, `SELECT public.set_product_rate_lock(true, 'season set', '${ADMIN}', 'k-lock');`);
  const lockedFile = [
    { insert: { product_name: '[PROVER] Locked Rated', sku: 'LK-1', product_form: 'liquid', inventory_unit: 'Gal' }, rates: { rate_per_acre: '1', rate_unit: 'oz', suggested_rate: null } },
    { insert: { product_name: '[PROVER] Locked Plain', sku: 'LK-2', product_form: 'liquid', inventory_unit: 'Gal' } },
    { insert: { product_name: '[PROVER] Locked Seed', sku: 'LK-3', product_form: 'seed', inventory_unit: 'Lb' } },
  ];
  const lp = preview(lockedFile);
  assert.equal(lp.rates_locked, true);
  assert.match(lp.rows[0].error, /PRODUCT_RATES_LOCKED/);
  assert.deepEqual(lp.rows.slice(1).map((r) => r.status), ['ok', 'ok']);
  refused(ADMIN, save([{ ...lockedFile[0], expected_prices: { tier1_price_per_acre: 0, tier2_price_per_acre: 0, tier3_price_per_acre: 0 } }, lockedFile[1]], 'k-locked-rated'), /PRODUCT_RATES_LOCKED/);
  assert.equal(scalar("SELECT count(*) FROM public.products WHERE sku LIKE 'LK-%';"), '0', 'a locked rate refuses the whole file');
  assert.equal(JSON.parse(ok(ADMIN, save(lockedFile.slice(1), 'k-locked-plain'))).inserted_count, 2);
  ok(ADMIN, `SELECT public.set_product_rate_lock(false, 'done', '${ADMIN}', 'k-unlock');`);
  console.log('[prover] lock on: a rated row is refused in preview and save; unrated rows and a seed product still import');

  // The Setup tab's update save (11a-2) is unchanged behind the same name.
  const wb = JSON.parse(ok(ADMIN, 'SELECT public.get_product_setup_workbook();'));
  const ex = wb.rows.find((r) => r.product_id === EXISTING);
  const upd = [{ product_id: EXISTING, setup_fingerprint: ex.setup_fingerprint, changes: { manufacturer: 'Updated' } }];
  assert.equal(JSON.parse(ok(ADMIN, save(upd, 'k-setup'))).changed_count, 1);
  assert.equal(field('[PROVER] Existing Herb', 'manufacturer'), 'Updated');
  refused(ADMIN, save(upd, 'k-setup-stale'), /PRODUCT_SETUP_STALE/);
  refused(ADMIN, save(upd, 'k-import-1'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  console.log('[prover] the Setup tab update save still works, refuses stale rows, and shares the retry-key scope');
  console.log('PRODUCT_IMPORT_PROOF_PASS');
}
try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
