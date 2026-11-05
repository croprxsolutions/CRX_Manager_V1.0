#!/usr/bin/env node
/**
 * Real-schema proof for PAR-1 (20261108120000): a parent record per formulation. Builds the checked-in
 * schema baseline in a network-disabled PostgreSQL container, replays migrations up to the candidate
 * (including the rate lock, the setup workbook and the PM-10 insert path), seeds invented rows, and
 * checks the build sheet's database cases: installing changes no existing product or open download;
 * the writers are admin-only and retry-safe; a new product and an added size take the parent's
 * category, use timings, EPA number and rates; the guards refuse changing those on one size (Setup
 * tab, a direct write, an alias resend) and let unchanged resends through; parent rates are
 * previewed, saved to every size at the previewed per-acre prices, refused while locked, and
 * corrected while locked with a reason and one rate event per size; a parent category change copies
 * to every size and asks to clear timings; a misgrouped size moves (stale downloads refused; a
 * locked rate, form and fill-source problems refused; an emptied parent goes inactive); the
 * identity correction changes formulation type and refuses the EPA number; reads show no cost or
 * price; the event log is append-only; and every size entry a parent write causes is 'parent_copy'.
 *
 * Run: node scripts/smoke/prove-product-parents-real-schema.mjs   (needs local Docker image)
 * Prints PRODUCT_PARENTS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-parents-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261108120000_product_parents.sql');
// PAR-1's own follow-ups, installed right after the candidate.
const FOLLOW_UPS = [path.join(MIGRATIONS, '20261110150000_product_parent_stock_units.sql')];
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
const TOUCHED = /(product_parent|_normalized_category_timing|normalize_product_category|write_product_change_history|_product_setup_fingerprint|apply_product_setup|product_change_history|FUNCTION\s+(public\.)?"?(preview_product_rate_correction|_product_rate_value_ok|_product_rate_value|_product_rate_unit_ok|is_admin|check_idempotency|save_idempotency|sync_product_use_timings|guard_product_rate_lock|product_price_per_acre)\b)/i;
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
  for (const [i, file] of FOLLOW_UPS.entries()) assert.equal(all[at + 1 + i], file, `${path.basename(file)} must follow the candidate`);
  for (const file of all.slice(at + 1 + FOLLOW_UPS.length)) {
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
    ('${ADMIN}', 'pp-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'pp-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  asOwner(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    -- Live's factors (read 2026-11-03); the schema baseline carries no unit rows.
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Gal', 128, 'liquid'), ('oz', 1, 'liquid'), ('Pt', 16, 'liquid'), ('Lb', 16, 'dry');
    INSERT INTO public.product_form_units (product_form, unit) VALUES ('seed', 'Lb'), ('seed', 'Unit');
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
const preview = (rows, uid = ADMIN) => JSON.parse(ok(uid, `SELECT public.preview_product_import('${q(rows)}'::jsonb);`), exactPrices);
const save = (rows, key, actor = ADMIN) => `SELECT public.apply_product_setup('${q(rows)}'::jsonb, '${actor}', '${key}');`;
// What the screen sends: each confirmed row, with the preview's prices when it carries rates.
const fromPreview = (rows, p) => rows.map((r, i) => (r.rates ? { ...r, expected_prices: p.rows[i].expected_prices } : r));
const count = () => scalar('SELECT count(*) FROM public.products;');
const field = (name, cols) => scalar(`SELECT concat_ws('|', ${cols}) FROM public.products WHERE product_name = '${name.replaceAll("'", "''")}';`);
// The amount exactly as returned, refused unless whole cents.
// String padding, not Number: a large amount keeps its exact cents.
// Prices keep their exact JSON text (JSON.rawJSON re-serializes it unchanged), never a JS number.
const exactPrices = (k, v, ctx) => (typeof v === 'number' && /price/.test(k) ? JSON.rawJSON(ctx.source) : v);
const cents = (raw) => { const v = raw && typeof raw === 'object' && 'rawJSON' in raw ? raw.rawJSON : raw; assert.match(String(v),/^[0-9]+([.][0-9]{1,2})?$/, `${v} is not whole cents`); const [i, f = ''] = String(v).split('.'); return `${i}.${f.padEnd(2, '0')}`; };
const TIERS = ['tier1_price_per_acre', 'tier2_price_per_acre', 'tier3_price_per_acre'];

const PA_NAME = '[PROVER] Alpha 4L';
const J = (v) => `'${q(v)}'::jsonb`;
const call = (uid, sql) => JSON.parse(ok(uid, sql), exactPrices);
const owner = (sql) => { const r = psql(sql, { allowFailure: true }); return { status: r.status, output: `${r.stdout}\n${r.stderr}` }; };
const ownerRefused = (sql, pattern) => { const r = owner(sql); assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`); assert.match(r.output, pattern); };
const ownerOk = (sql) => { const r = owner(sql); assert.equal(r.status, 0, r.output); };
const prod = (pid, cols) => scalar(`SELECT concat_ws('|', ${cols}) FROM public.products WHERE id = '${pid}';`);
const version = (parent) => Number(scalar(`SELECT parent_version FROM public.product_parents WHERE id = '${parent}';`));
const setupFp = (pid) => JSON.parse(ok(ADMIN, 'SELECT public.get_product_setup_workbook();')).rows.find((r) => r.product_id === pid).setup_fingerprint;
const setupSave = (pid, fp, changes, key) => save([{ product_id: pid, setup_fingerprint: fp, changes }], key);
const prices = (pid) => scalar(`SELECT concat_ws('|', tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre) FROM public.products WHERE id = '${pid}';`).split('|').map(cents).join('|');
const previewed = (s) => TIERS.map((t) => cents(s.prices[t])).join('|');
const create = (parent, size, key) => `SELECT public.create_product_with_parent(${J(parent)}, ${J(size)}, '${key}');`;
const addSize = (parent, v, size, key) => `SELECT public.add_product_size('${parent}', ${v}, ${J(size)}, '${key}');`;
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
const previewRates = (parent, rate, unit, sugg) => call(ADMIN, `SELECT public.preview_parent_rates('${parent}', ${rate ?? 'NULL'}, ${lit(unit)}, ${lit(sugg)});`);
const PRODUCTS_MD5 = "SELECT md5(string_agg(to_jsonb(p)::text, '|' ORDER BY id)) FROM public.products p;";

function main() {
  buildContainer();
  seed();
  const fpBefore = scalar(`SELECT public._product_setup_fingerprint(p) FROM public.products p WHERE id = '${EXISTING}';`);
  const productsBefore = scalar(PRODUCTS_MD5);
  stageText('cand.sql', lf(CANDIDATE));
  const installed = apply('cand.sql');
  assert.equal(installed.status, 0, installed.output);
  ledger(path.basename(CANDIDATE, '.sql'));
  // The stock-unit follow-up refuses to install over a seed parent that already mixes units.
  const [mixP, mixLb, mixUnit] = [id('d1'), id('d2'), id('d3')];
  asOwner(`INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, is_active)
      VALUES ('${mixLb}', '[PROVER] Mix Lb', 'MX-LB', 'seed', 'Lb', true), ('${mixUnit}', '[PROVER] Mix Unit', 'MX-U', 'seed', 'Unit', true);
    INSERT INTO public.product_parents (id, name, product_form, created_by, updated_by) VALUES ('${mixP}', '[PROVER] Mix', 'seed', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_members (product_id, parent_id, added_by) VALUES ('${mixLb}', '${mixP}', '${ADMIN}'), ('${mixUnit}', '${mixP}', '${ADMIN}');`);
  stageText('follow.sql', lf(FOLLOW_UPS[0]));
  const mixed = apply('follow.sql');
  assert.notEqual(mixed.status, 0, 'the follow-up installed over a mixed-unit seed parent');
  assert.match(mixed.output, /PREFLIGHT_PRODUCT_PARENT_MIXED_UNITS/);
  asOwner(`DELETE FROM public.product_parent_members WHERE parent_id = '${mixP}'; DELETE FROM public.product_parents WHERE id = '${mixP}';
    DELETE FROM public.products WHERE id IN ('${mixLb}', '${mixUnit}');`);
  console.log('[prover] the stock-unit follow-up refuses to install over a seed parent that already mixes units');
  for (const file of FOLLOW_UPS) {
    stageText('follow.sql', lf(file));
    const followed = apply('follow.sql');
    assert.equal(followed.status, 0, followed.output);
    ledger(path.basename(file, '.sql'));
  }
  assert.equal(scalar(`SELECT public._product_setup_fingerprint(p) FROM public.products p WHERE id = '${EXISTING}';`), fpBefore,
    "an ungrouped product's Setup-tab fingerprint must not change");
  assert.equal(scalar(PRODUCTS_MD5), productsBefore, 'install changed a product');
  console.log('[prover] installs with its preflight and postflight; no product row or ungrouped download fingerprint changes');

  // Category aliases behave as before through the shared table.
  ownerOk(`UPDATE public.products SET category = 'Post Emergence' WHERE id = '${EXISTING}';`);
  assert.equal(prod(EXISTING, 'category, use_timing'), 'Herbicide|Post-Emergence');
  ownerOk(`UPDATE public.products SET category = 'Utility', use_timings = '{}' WHERE id = '${EXISTING}';`);
  assert.equal(prod(EXISTING, 'category'), 'Other');
  ownerOk(`UPDATE public.products SET category = 'Herbicide' WHERE id = '${EXISTING}';`);
  // The alias trigger runs as the signed-in user: an admin's direct product save and insert (the
  // product form, bulk import) must still pass through it.
  ok(ADMIN, `UPDATE public.products SET category = 'Post Emergence' WHERE id = '${EXISTING}';`);
  assert.equal(prod(EXISTING, 'category, use_timing'), 'Herbicide|Post-Emergence');
  ok(ADMIN, `INSERT INTO public.products (product_name, sku, category, product_form, inventory_unit, is_active)
    VALUES ('[PROVER] Direct Insert', 'EX-3', 'Utility', 'liquid', 'Gal', true);`);
  assert.equal(field('[PROVER] Direct Insert', 'category'), 'Other');
  console.log('[prover] an admin browser session still saves and inserts products through the alias trigger');
  console.log('[prover] the category alias trigger still maps old names and their timing');

  // Access.
  const parentA = { name: PA_NAME, nickname: 'Alpha', product_form: 'liquid', formulation_type: 'SC',
    generic_epa_registration: '100-1', category: 'Herbicide', use_timings: ['post_emergence', 'pre_emerge'] };
  const sizeA1 = { product_name: '[PROVER] Alpha 2.5 Gal', sku: 'AL-25', inventory_unit: 'Gal', container_size: '2.5', container_type: 'Jug' };
  refused(REP, create(parentA, sizeA1, 'k-rep'), /ADMIN_REQUIRED/);
  refused(null, create(parentA, sizeA1, 'k-anon'), /permission denied/);
  refused(ADMIN, `SELECT public.create_product_with_parent(${J(parentA)}, ${J(sizeA1)});`, /IDEMPOTENCY_KEY_REQUIRED/);
  refused(REP, `INSERT INTO public.product_parents (name, product_form, created_by, updated_by) VALUES ('x', 'liquid', '${REP}', '${REP}');`, /permission denied/);
  refused(REP, 'SELECT count(*) FROM public.product_parent_copy_passes;', /permission denied/);
  refused(null, 'SELECT count(*) FROM public.product_parents;', /permission denied/);
  refused(null, 'SELECT public.get_product_parents();', /permission denied/);
  console.log('[prover] writers are admin-only with a retry key; tables are read-only to users and closed to visitors; passes are hidden');

  // New product: refusals first, each leaving nothing behind.
  refused(ADMIN, create(parentA, { ...sizeA1, category: 'Fungicide' }, 'k-bad-1'), /PRODUCT_PARENT_SIZE_COPIED_VALUE/);
  refused(ADMIN, create(parentA, { ...sizeA1, rates: { rate_per_acre: '1' } }, 'k-bad-2'), /PRODUCT_PARENT_SIZE_COPIED_VALUE/);
  refused(ADMIN, create(parentA, { ...sizeA1, product_form: 'dry' }, 'k-bad-3'), /PRODUCT_PARENT_FORM_MISMATCH/);
  refused(ADMIN, create(parentA, { ...sizeA1, epa_registration: '999-9' }, 'k-bad-4'), /PRODUCT_PARENT_EPA_MISMATCH/);
  refused(ADMIN, create({ ...parentA, category: 'Fungicide' }, sizeA1, 'k-bad-5'), /PRODUCT_PARENT_TIMING_CATEGORY: Fungicide does not take use timing Pre-Emerge, Post-Emergence/);
  refused(ADMIN, create({ ...parentA, use_timings: ['sideways'] }, sizeA1, 'k-bad-6'), /unknown use timing/);
  refused(ADMIN, create({ ...parentA, rate_per_acre: '4' }, sizeA1, 'k-bad-7'), /PRODUCT_PARENT_INVALID/);
  assert.equal(scalar('SELECT count(*) FROM public.product_parents;'), '0');
  assert.equal(scalar("SELECT count(*) FROM public.products WHERE sku = 'AL-25';"), '0');

  const created = call(ADMIN, create(parentA, sizeA1, 'k-create-a'));
  const PA = created.parent_id; const A1 = created.product_id;
  assert.equal(prod(A1, 'category, use_timings, use_timing, epa_registration, product_form'),
    'Herbicide|{pre_emerge,post_emergence}|Pre-Emerge; Post-Emergence|100-1|liquid');
  assert.equal(scalar(`SELECT size_role FROM public.product_parent_members WHERE product_id = '${A1}' AND parent_id = '${PA}';`), 'package');
  assert.deepEqual(call(ADMIN, create(parentA, sizeA1, 'k-create-a')), created, 'a retry returns the first receipt');
  refused(ADMIN, create({ ...parentA, nickname: 'Other' }, sizeA1, 'k-create-a'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  refused(ADMIN, create({ ...parentA, name: '[prover] alpha 4l' }, { ...sizeA1, product_name: 'Another', sku: 'AN-1' }, 'k-bad-8'), /PRODUCT_PARENT_NAME_TAKEN/);
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${A1}' AND change_type = 'parent_copy' AND field_name = 'use_timing' AND parent_event_id = ${created.event_id};`), '1');
  assert.equal(scalar(`SELECT jsonb_array_length(affected) FROM public.product_parent_events WHERE id = ${created.event_id} AND event_type = 'created';`), '1');
  console.log('[prover] a new product creates its parent and first size in one step, retry-safe; bad requests leave nothing behind');

  // Guards on a grouped size.
  const fpA1 = setupFp(A1);
  refused(ADMIN, setupSave(A1, fpA1, { category: 'Fungicide' }, 'k-g1'), /PRODUCT_PARENT_VALUE: category belongs to parent "\[PROVER\] Alpha 4L".*reload the app/);
  refused(ADMIN, setupSave(A1, fpA1, { use_timings: ['pre_emerge'] }, 'k-g2'), /PRODUCT_PARENT_VALUE: use timing belongs to parent/);
  refused(ADMIN, setupSave(A1, fpA1, { epa_registration: '100-2' }, 'k-g3'), /PRODUCT_PARENT_VALUE: EPA number belongs to parent/);
  assert.equal(JSON.parse(ok(ADMIN, setupSave(A1, fpA1, { manufacturer: 'Acme' }, 'k-g4'))).changed_count, 1);
  ownerRefused(`UPDATE public.products SET rate_per_acre = 1, rate_unit = 'oz' WHERE id = '${A1}';`, /PRODUCT_PARENT_VALUE: rate per acre/);
  ownerRefused(`UPDATE public.products SET suggested_rate = '1 qt' WHERE id = '${A1}';`, /PRODUCT_PARENT_VALUE: suggested rate/);
  ownerRefused(`UPDATE public.products SET use_timing = 'Pre-Emerge' WHERE id = '${A1}';`, /PRODUCT_PARENT_VALUE: use timing/);
  ownerRefused(`UPDATE public.products SET category = 'Post Emergence' WHERE id = '${A1}';`, /PRODUCT_PARENT_VALUE: use timing/);
  ownerRefused(`UPDATE public.products SET epa_registration = '100-3' WHERE id = '${A1}';`, /PRODUCT_PARENT_VALUE: EPA number/);
  // A saved size's form is already fixed by the unit guard, so a size always keeps its parent's form.
  ownerRefused(`UPDATE public.products SET product_form = 'dry' WHERE id = '${A1}';`, /can't change on a saved product/);
  ownerOk(`UPDATE public.products SET category = category, use_timings = use_timings, use_timing = use_timing, rate_per_acre = rate_per_acre,
    suggested_rate = suggested_rate, epa_registration = '100-1', notes = 'resent' WHERE id = '${A1}';`);
  console.log('[prover] a grouped size refuses its own category, timings, EPA number and rates, naming the parent; unchanged resends pass');

  // Parent rates (unlocked).
  asOwner(`UPDATE public.products SET tier1_price = 40.00, tier2_price = 38.00, tier3_price = 36.00 WHERE id = '${A1}';`);
  let pv = previewRates(PA, 4, 'oz', '4 oz/A');
  assert.equal(pv.sizes.length, 1);
  assert.equal(cents(pv.sizes[0].prices.tier1_price_per_acre), '1.25');
  const rateRow = (p, rate, unit, sugg) => ({ parent_id: PA, expected_parent_version: p.parent_version, rate_per_acre: rate, rate_unit: unit, suggested_rate: sugg, sizes: p.sizes });
  const setRates = (rows, key, uid = ADMIN) => `SELECT public.set_parent_rates(${J(rows)}, '${key}');`;
  refused(REP, setRates([rateRow(pv, '4', 'oz', '4 oz/A')], 'k-r0'), /ADMIN_REQUIRED/);
  refused(ADMIN, setRates([rateRow({ ...pv, sizes: [] }, '4', 'oz', '4 oz/A')], 'k-r1'), /PRODUCT_PARENT_RATES_STALE/);
  refused(ADMIN, setRates([rateRow(pv, '4', 'furlongs', null)], 'k-r2'), /PRODUCT_RATE_UNIT_INVALID/);
  call(ADMIN, setRates([rateRow(pv, '4', 'oz', '4 oz/A')], 'k-r3'));
  assert.equal(prod(A1, 'rate_per_acre, rate_unit, suggested_rate'), '4|oz|4 oz/A');
  assert.equal(scalar(`SELECT concat_ws('|', rate_per_acre, rate_unit, suggested_rate) FROM public.product_parents WHERE id = '${PA}';`), '4|oz|4 oz/A');
  assert.equal(prices(A1), previewed(pv.sizes[0]));
  // An upload that resends a parent's current rates skips that parent instead of refusing the batch (20261110150000).
  const vSame = version(PA);
  const same = call(ADMIN, setRates([rateRow(previewRates(PA, 4, 'oz', '4 oz/A'), '4', 'oz', '4 oz/A')], 'k-r3b'));
  assert.equal(same.changed_count, 0, JSON.stringify(same));
  assert.equal(version(PA), vSame);
  refused(ADMIN, setRates([rateRow(pv, '5', 'oz', null)], 'k-r4'), /PRODUCT_PARENT_STALE/);
  console.log('[prover] parent rates: previewed, saved to every size at the previewed per-acre prices, stale snapshots refused');

  // Add a size: takes everything from the parent.
  const sizeBulk = { product_name: '[PROVER] Alpha Bulk', sku: 'AL-BULK', inventory_unit: 'Gal', size_role: 'bulk' };
  refused(ADMIN, addSize(PA, version(PA) - 1, sizeBulk, 'k-a0'), /PRODUCT_PARENT_STALE/);
  refused(ADMIN, addSize(PA, version(PA), { ...sizeBulk, suggested_rate: '1' }, 'k-a1'), /PRODUCT_PARENT_SIZE_COPIED_VALUE/);
  const A2 = call(ADMIN, addSize(PA, version(PA), sizeBulk, 'k-a2')).product_id;
  assert.equal(prod(A2, 'category, use_timings, rate_per_acre, rate_unit, suggested_rate, epa_registration'), 'Herbicide|{pre_emerge,post_emergence}|4|oz|4 oz/A|100-1');
  refused(ADMIN, addSize(PA, version(PA), { ...sizeBulk, product_name: '[PROVER] Alpha Bulk 2', sku: 'AL-BULK2' }, 'k-a3'), /PRODUCT_PARENT_ONE_BULK/);
  console.log('[prover] an added size takes the parent category, timings, EPA number and rates; one bulk size per parent');

  // Lock on: plain rate set refused; adding a size still copies the rate; a correction needs a reason.
  ok(ADMIN, `SELECT public.set_product_rate_lock(true, 'season set', '${ADMIN}', 'k-lock');`);
  pv = previewRates(PA, 5, 'oz', null);
  refused(ADMIN, setRates([rateRow(pv, '5', 'oz', null)], 'k-r5'), /PRODUCT_RATES_LOCKED/);
  const A3 = call(ADMIN, addSize(PA, version(PA), { product_name: '[PROVER] Alpha 1 Gal', sku: 'AL-1', inventory_unit: 'Gal' }, 'k-a4')).product_id;
  assert.equal(prod(A3, 'rate_per_acre, rate_unit'), '4|oz');
  asOwner(`UPDATE public.products SET tier1_price = 41.00 WHERE id IN ('${A2}', '${A3}');`);
  pv = previewRates(PA, 5, 'oz', null);
  assert.equal(pv.sizes.length, 3);
  const correct = (p, reason, key) => `SELECT public.correct_parent_rates('${PA}', 5, 'oz', NULL, ${p.parent_version}, ${J(p.sizes)}, ${lit(reason)}, '${key}');`;
  refused(ADMIN, correct(pv, null, 'k-c0'), /REASON_REQUIRED/);
  asOwner(`UPDATE public.products SET tier1_price = 44.00 WHERE id = '${A1}';`);
  refused(ADMIN, correct(pv, 'label says 5', 'k-c1'), /PRODUCT_RATE_PREVIEW_CHANGED/);
  assert.equal(prod(A1, 'rate_per_acre'), '4', 'a refused correction changes nothing');
  pv = previewRates(PA, 5, 'oz', null);
  call(ADMIN, correct(pv, 'label says 5', 'k-c2'));
  for (const s of pv.sizes) {
    assert.equal(prod(s.product_id, 'rate_per_acre, rate_unit'), '5|oz');
    assert.equal(prices(s.product_id), previewed(s));
  }
  assert.equal(scalar("SELECT count(*) FROM public.product_rate_events WHERE event_type = 'corrected' AND reason = 'label says 5';"), '3');
  console.log('[prover] lock on: a plain rate set is refused, an added size still takes the rate, a correction needs a reason, refuses moved prices, and logs every size');

  // Parent edit: name, nickname, category with the timing clear.
  const upd = (changes, reason, key) => `SELECT public.update_product_parent('${PA}', ${version(PA)}, ${J(changes)}, ${lit(reason)}, '${key}');`;
  refused(ADMIN, upd({ category: 'Fungicide' }, 'regroup', 'k-u0'), /PRODUCT_PARENT_TIMINGS_MUST_CLEAR/);
  refused(ADMIN, upd({ generic_epa_registration: '100-9' }, 'x', 'k-u1'), /PRODUCT_PARENT_IDENTITY/);
  refused(ADMIN, upd({ rate_per_acre: '1' }, 'x', 'k-u2'), /PRODUCT_PARENT_RATES/);
  refused(ADMIN, upd({ name: 'x' }, null, 'k-u3'), /REASON_REQUIRED/);
  const ed = call(ADMIN, upd({ category: 'Fungicide', use_timings: [], nickname: 'Alfa' }, 'is a fungicide', 'k-u4'));
  assert.equal(ed.sizes.length, 3);
  for (const pid of [A1, A2, A3]) assert.equal(prod(pid, "category, use_timings, coalesce(use_timing, '-')"), 'Fungicide|{}|-');
  const vNoop = version(PA);
  refused(ADMIN, upd({ nickname: ' Alfa ', category: 'Fungicide' }, 'same again', 'k-u5'), /PRODUCT_PARENT_NO_CHANGE/);
  assert.equal(version(PA), vNoop, 'a no-change edit keeps the version');
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE change_type = 'parent_copy' AND field_name = 'category' AND parent_event_id = ${ed.event_id};`), '3');
  console.log('[prover] a parent category change asks to clear timings, then copies to every size with one parent_copy entry each');

  // Move a misgrouped size.
  const B = call(ADMIN, create({ name: '[PROVER] Beta', product_form: 'liquid', category: 'Fungicide', generic_epa_registration: '100-1' },
    { product_name: '[PROVER] Beta 2.5', sku: 'BE-25', inventory_unit: 'Gal' }, 'k-create-b'));
  const D = call(ADMIN, create({ name: '[PROVER] Delta Dry', product_form: 'dry', category: 'Fungicide' },
    { product_name: '[PROVER] Delta 50 Lb', sku: 'DE-50', inventory_unit: 'Lb' }, 'k-create-d'));
  const mp = (pid, to) => call(ADMIN, `SELECT public.preview_move_product_size('${pid}', '${to}');`);
  assert.match(mp(A1, B.parent_id).refusal, /PRODUCT_RATES_LOCKED/);
  assert.match(mp(A1, D.parent_id).refusal, /PRODUCT_PARENT_FORM_MISMATCH/);
  ok(ADMIN, `SELECT public.set_product_rate_lock(false, 'done', '${ADMIN}', 'k-unlock');`);
  ownerOk(`UPDATE public.product_parent_members SET size_role = 'fixed_tote', fill_source_product_id = '${A2}' WHERE product_id = '${A3}';`);
  assert.match(mp(A2, B.parent_id).refusal, /PRODUCT_PARENT_FILL_SOURCE_IN_USE/);
  assert.match(mp(A3, B.parent_id).refusal, /PRODUCT_PARENT_FILL_SOURCE_STAYS/);
  ownerRefused(`UPDATE public.product_parent_members SET fill_source_product_id = '${B.product_id}' WHERE product_id = '${A3}';`, /PRODUCT_PARENT_FILL_SOURCE_INVALID/);
  ownerRefused(`DELETE FROM public.product_parent_members WHERE product_id = '${A2}';`, /PRODUCT_PARENT_FILL_SOURCE_IN_USE/);
  ownerOk(`UPDATE public.product_parent_members SET size_role = 'package', fill_source_product_id = NULL WHERE product_id = '${A3}';`);
  const fpBeforeMove = setupFp(A1);
  const m = mp(A1, B.parent_id);
  assert.equal(m.refusal, null);
  const move = (pid, to, p, key, evidence = 'label photo') => `SELECT public.move_product_size('${pid}', '${to}', ${p.from_parent_version}, ${p.to_parent_version}, ${lit(p.size_fingerprint)}, 'wrong group', ${lit(evidence)}, ${J(p.prices)}, '${key}');`;
  refused(ADMIN, move(A1, B.parent_id, m, 'k-m0', null), /EVIDENCE_REQUIRED/);
  // The move saves only the per-acre prices the preview showed.
  refused(ADMIN, move(A1, B.parent_id, { ...m, prices: { ...m.prices, tier1_price_per_acre: '999.99' } }, 'k-m0p'), /PRODUCT_RATE_PREVIEW_CHANGED/);
  refused(ADMIN, move(A1, B.parent_id, { ...m, size_fingerprint: 'x' }, 'k-m1'), /PRODUCT_PARENT_SIZE_STALE/);
  const moved = call(ADMIN, move(A1, B.parent_id, m, 'k-m2'));
  assert.equal(moved.from_parent_inactive, false);
  assert.equal(scalar(`SELECT parent_id FROM public.product_parent_members WHERE product_id = '${A1}';`), B.parent_id);
  assert.equal(prod(A1, "category, coalesce(rate_per_acre::text, '-'), coalesce(rate_unit, '-')"), 'Fungicide|-|-');
  refused(ADMIN, setupSave(A1, fpBeforeMove, { manufacturer: 'Late' }, 'k-g5'), /PRODUCT_SETUP_STALE/);
  const C = call(ADMIN, create({ name: '[PROVER] Gamma', product_form: 'liquid', category: 'Fungicide' },
    { product_name: '[PROVER] Gamma 1', sku: 'GA-1', inventory_unit: 'Gal' }, 'k-create-c'));
  const mc = mp(C.product_id, B.parent_id);
  assert.equal(mc.refusal, null);
  assert.equal(call(ADMIN, move(C.product_id, B.parent_id, mc, 'k-m3')).from_parent_inactive, true);
  assert.equal(scalar(`SELECT is_active FROM public.product_parents WHERE id = '${C.parent_id}';`), 'f');
  assert.equal(scalar(`SELECT count(*) FROM public.product_parent_events WHERE event_type = 'size_moved' AND parent_id IN ('${C.parent_id}', '${B.parent_id}') AND evidence = 'label photo';`), '3');
  // A size with no EPA number takes the new parent's; the preview shows it and the per-acre prices.
  const E = call(ADMIN, create({ name: '[PROVER] Epsilon', product_form: 'liquid', category: 'Fungicide', generic_epa_registration: '200-1' },
    { product_name: '[PROVER] Epsilon 1', sku: 'EP-1', inventory_unit: 'Gal' }, 'k-create-e'));
  const F = call(ADMIN, create({ name: '[PROVER] Phi', product_form: 'liquid', category: 'Fungicide' },
    { product_name: '[PROVER] Phi 1', sku: 'PH-1', inventory_unit: 'Gal' }, 'k-create-f'));
  const mf = mp(F.product_id, E.parent_id);
  assert.equal(mf.refusal, null);
  assert.equal(mf.after.epa_registration, '200-1');
  assert.ok(mf.prices && typeof mf.prices === 'object' && 'tier1_price_per_acre' in mf.prices, JSON.stringify(mf));
  assert.equal(mp(A1, D.parent_id).prices, null);
  call(ADMIN, move(F.product_id, E.parent_id, mf, 'k-m4'));
  assert.equal(prod(F.product_id, 'epa_registration'), '200-1');
  // A size typed with a spaced EPA number stores the parent's normalized one.
  const E2 = call(ADMIN, addSize(E.parent_id, version(E.parent_id), { product_name: '[PROVER] Epsilon 2', sku: 'EP-2', inventory_unit: 'Gal',
    epa_registration: '200 - 1' }, 'k-e-add')).product_id;
  assert.equal(prod(E2, 'epa_registration'), '200-1');
  // A size moved in with a spaced spelling of the parent's EPA number stores the normalized one too (20261110150000).
  const P = call(ADMIN, create({ name: '[PROVER] Psi', product_form: 'liquid', category: 'Fungicide' },
    { product_name: '[PROVER] Psi 1', sku: 'PS-1', inventory_unit: 'Gal' }, 'k-create-p'));
  asOwner(`UPDATE public.products SET epa_registration = '200 - 1' WHERE id = '${P.product_id}';`);
  const mpsi = mp(P.product_id, E.parent_id);
  assert.equal(mpsi.refusal, null);
  call(ADMIN, move(P.product_id, E.parent_id, mpsi, 'k-m5'));
  assert.equal(prod(P.product_id, 'epa_registration'), '200-1');
  // A seed parent's rates preview and save in each size's stock unit.
  const S = call(ADMIN, create({ name: '[PROVER] Sigma Seed', product_form: 'seed', category: 'Seed' },
    { product_name: '[PROVER] Sigma 50 Lb', sku: 'SG-50', inventory_unit: 'Lb', unit_size: '50' }, 'k-create-s'));
  asOwner(`UPDATE public.products SET tier1_price = 100.00, tier2_price = 90.00, tier3_price = 80.00 WHERE id = '${S.product_id}';`);
  const ps = previewRates(S.parent_id, 30, null, null);
  assert.notEqual(ps.sizes[0].prices.tier1_price_per_acre, null, 'the seed preview prices in the stock unit');
  call(ADMIN, setRates([{ parent_id: S.parent_id, expected_parent_version: ps.parent_version, rate_per_acre: '30', rate_unit: null,
    suggested_rate: null, sizes: ps.sizes }], 'k-r-seed'));
  assert.equal(prod(S.product_id, 'rate_per_acre, rate_unit'), '30|Lb');
  assert.equal(prices(S.product_id), previewed(ps.sizes[0]));
  // A seed parent's sizes share one stock unit: its one rate is per stock unit.
  refused(ADMIN, addSize(S.parent_id, version(S.parent_id), { product_name: '[PROVER] Sigma 80K', sku: 'SG-80K', inventory_unit: 'Unit' }, 'k-s-unit'),
    /PRODUCT_PARENT_UNIT_MISMATCH: every size of "\[PROVER\] Sigma Seed" is stocked in Lb/);
  const S2 = call(ADMIN, addSize(S.parent_id, version(S.parent_id), { product_name: '[PROVER] Sigma 25 Lb', sku: 'SG-25', inventory_unit: 'Lb', unit_size: '25' }, 'k-s-lb')).product_id;
  assert.equal(prod(S2, 'rate_per_acre'), '30', 'a same-unit size takes the parent rate');
  const T = call(ADMIN, create({ name: '[PROVER] Tau Seed', product_form: 'seed', category: 'Seed' },
    { product_name: '[PROVER] Tau 80K', sku: 'TA-80K', inventory_unit: 'Unit' }, 'k-create-t'));
  assert.match(mp(S2, T.parent_id).refusal, /PRODUCT_PARENT_UNIT_MISMATCH: every size of "\[PROVER\] Tau Seed" is stocked in Unit/);
  console.log('[prover] a seed parent refuses adding or moving in a size stocked in a different unit');
  // Every size carries its parent's EPA number, or none does.
  const G = call(ADMIN, create({ name: '[PROVER] Gnoepa', product_form: 'liquid', category: 'Fungicide' },
    { product_name: '[PROVER] Gnoepa 1', sku: 'GN-1', inventory_unit: 'Gal' }, 'k-create-g'));
  // A setup receipt saved under '<key>:insert' with the same fields never hands back that product.
  const colFields = { product_name: '[PROVER] Col 1', sku: 'CO-1', inventory_unit: 'Gal', product_form: 'liquid', category: 'Fungicide' };
  const colX = JSON.parse(ok(ADMIN, save([{ insert: colFields }], 'k-col:insert'))).rows[0].product_id;
  refused(ADMIN, create({ name: '[PROVER] Col', product_form: 'liquid', category: 'Fungicide' },
    { product_name: '[PROVER] Col 1', sku: 'CO-1', inventory_unit: 'Gal' }, 'k-col'), /PRODUCT_SETUP_DUPLICATE/);
  assert.equal(scalar("SELECT count(*) FROM public.product_parents WHERE name = '[PROVER] Col';"), '0');
  assert.equal(scalar(`SELECT count(*) FROM public.product_parent_members WHERE product_id = '${colX}';`), '0');
  // The emptied parent's log entry records it going inactive.
  assert.equal(scalar(`SELECT count(*) FROM public.product_parent_events WHERE parent_id = '${C.parent_id}' AND event_type = 'size_moved' AND (after_values->>'is_active')::boolean = false;`), '1');
  assert.match(mp(A2, G.parent_id).refusal, /PRODUCT_PARENT_EPA_MISMATCH: .*no EPA number/);
  refused(ADMIN, addSize(G.parent_id, G.parent_version, { product_name: '[PROVER] Gnoepa 2', sku: 'GN-2', inventory_unit: 'Gal',
    epa_registration: '300-1' }, 'k-g-add'), /PRODUCT_PARENT_EPA_MISMATCH: .*no EPA number/);
  refused(ADMIN, create({ name: '[PROVER] Zeta', product_form: 'liquid' },
    { product_name: '[PROVER] Zeta 1', sku: 'ZE-1', inventory_unit: 'Gal', epa_registration: '300-1' }, 'k-create-z'), /PRODUCT_PARENT_EPA_MISMATCH/);
  console.log('[prover] a moved size with no EPA number takes the new parent\'s; the move preview shows the EPA number and per-acre prices');
  console.log('[prover] a size moves with reason and evidence; locked rate, form and fill-source problems refused; stale downloads refused; an emptied parent goes inactive');

  // Identity correction.
  const idp = call(ADMIN, `SELECT public.preview_product_parent_identity_correction('${PA}', ${J({ formulation_type: 'EC' })});`);
  assert.equal(idp.after.formulation_type, 'EC');
  const idc = (changes, evidence, key) => `SELECT public.correct_product_parent_identity('${PA}', ${version(PA)}, ${J(changes)}, 'label check', ${lit(evidence)}, '${key}');`;
  refused(ADMIN, idc({ generic_epa_registration: '100-9' }, 'label', 'k-i0'), /PRODUCT_PARENT_EPA_CORRECTION_OFF/);
  refused(ADMIN, idc({ formulation_type: 'EC' }, null, 'k-i1'), /EVIDENCE_REQUIRED/);
  call(ADMIN, idc({ formulation_type: 'EC' }, 'label', 'k-i2'));
  assert.equal(scalar(`SELECT formulation_type FROM public.product_parents WHERE id = '${PA}';`), 'EC');
  console.log('[prover] the identity correction changes formulation type with reason and evidence; the EPA number is switched off');

  // Reads: any active user, no cost or price.
  const found = call(REP, "SELECT public.search_product_parents('alfa');");
  assert.equal(found.length, 1);
  assert.equal(found[0].id, PA);
  assert.equal(found[0].sizes.length, 2);
  const byProduct = call(REP, `SELECT public.get_product_parents(ARRAY['${A1}']::uuid[]);`);
  assert.equal(byProduct[0].id, B.parent_id);
  assert.doesNotMatch(JSON.stringify([found, byProduct]), /price|cost|margin/i);
  console.log('[prover] a sales rep finds a parent by nickname and by size, with no cost or price');

  // Log and leftovers.
  ownerRefused("UPDATE public.product_parent_events SET reason = 'x';", /PRODUCT_PARENT_EVENTS_ARE_APPEND_ONLY/);
  ownerRefused('DELETE FROM public.product_parent_events;', /PRODUCT_PARENT_EVENTS_ARE_APPEND_ONLY/);
  assert.equal(scalar('SELECT count(*) FROM public.product_parent_copy_passes;'), '0');
  assert.equal(scalar('SELECT count(*) FROM public.product_rate_correction_passes;'), '0');
  assert.equal(scalar("SELECT count(*) FROM public.product_change_history WHERE change_type = 'updated' AND product_id IN (SELECT product_id FROM public.product_parent_members) AND field_name IN ('category', 'use_timing', 'rate_per_acre', 'rate_unit', 'suggested_rate', 'epa_registration');"), '0',
    'every copied-value change on a grouped size came from a parent write');
  console.log('[prover] the event log is append-only, no pass outlives its write, and every copied change is a parent_copy entry');
  console.log('PRODUCT_PARENTS_PROOF_PASS');
}
try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
