#!/usr/bin/env node
/**
 * Real-schema proof for WP-PM-11a-2 (20261107080000): the setup workbook's database half. Builds the
 * checked-in schema baseline in a network-disabled PostgreSQL container, replays migrations up to the
 * candidate (including WP-PM-11a-1's rate lock), seeds invented rows, and checks: the download, rate
 * preview and setup save are admin-only; with the lock off a Rates-tab upload changes 20 rates after
 * the preview, per-acre prices equal a hand calculation to the cent; stale, invalid and unknown rows
 * are named; the Setup tab saves every setup field all-or-nothing, logged and retry-safe, refuses stale
 * rows and bad values by product name, and never writes vendor, rates, prices, cost, active status,
 * form or units; with the lock on the Rates upload is refused and the Setup tab still saves.
 *
 * Run: node scripts/smoke/prove-product-setup-workbook-real-schema.mjs   (needs local Docker image)
 * Prints PRODUCT_SETUP_WORKBOOK_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-setup-wb-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261107080000_product_setup_workbook.sql');
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
const TOUCHED = /(get_product_setup_workbook|preview_product_rates|apply_product_setup|_product_setup_fingerprint|FUNCTION\s+(public\.)?"?(set_product_rates|preview_product_rate_correction|_product_rate_value_ok|_product_rate_value|_product_rate_unit_ok|is_admin|check_idempotency|save_idempotency|product_price_per_acre)\b)/i;
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
// The smoke chain probes one active profile of each other staff role.
const OTHER_ROLES = [[id('a3'), 'driver'], [id('a4'), 'applicator'], [id('a5'), 'entity_recipient']];
const P = { GAL: id('c1'), OTHER: id('c2'), DRY: id('c3') };

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'rl-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'rl-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ${OTHER_ROLES.map(([u, role]) => `('${u}', 'rl-${role}@example.invalid', '{"full_name":"[PROVER] ${role}","role":"${role}"}'::jsonb)`).join(', ')};`);
  // Invented products priced per gallon; their per-acre prices are filled once a rate is set.
  asOwner(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    ${OTHER_ROLES.map(([u, role]) => `UPDATE public.profiles SET role = '${role}', is_active = true WHERE id = '${u}';`).join(' ')}
    -- Live's factors (read 2026-11-03); the schema baseline carries no unit rows.
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Gal', 128, 'liquid'), ('oz', 1, 'liquid'), ('Pt', 16, 'liquid'), ('Lb', 16, 'dry');
    INSERT INTO public.product_form_units (product_form, unit) VALUES ('seed', 'Lb');
    INSERT INTO public.products (id, product_name, sku, inventory_unit, is_active, tier1_price, tier2_price, tier3_price)
    VALUES ('${P.GAL}', '[PROVER] Gal', 'RL-1', 'gal', true, 40.00, 36.00, 32.00),
           ('${P.OTHER}', '[PROVER] Other', 'RL-2', 'gal', true, 40.00, 36.00, 32.00),
           ('${P.DRY}', '[PROVER] Dry', 'RL-7', 'Lb', true, 16.00, 16.00, 16.00);`);
  console.log('[prover] seeded an admin, a sales rep, one of each other staff role and two products priced per gallon and one per pound, all with no rate yet');
}
function asOwner(sql) { psql(`SET session_replication_role = replica;
${sql}
SET session_replication_role = origin;`, { user: 'supabase_admin' }); }
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
function ownerRefused(sql, pattern) {
  const r = psql(sql, { allowFailure: true });
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(`${r.stdout}${r.stderr}`, pattern);
}
const rates = (p) => scalar(`SELECT concat_ws('|', rate_per_acre, rate_unit, suggested_rate, tier1_price_per_acre,
  tier2_price_per_acre, tier3_price_per_acre) FROM public.products WHERE id = '${p}';`);
const versionOf = (p) => scalar(`SELECT pricing_version FROM public.products WHERE id = '${p}';`);
// Like a fresh export: the per-acre inputs other than the rates are read from the product as it is now.
const facts = (p) => JSON.parse(scalar(`SELECT json_build_object('pricing_version', pricing_version, 'unit_size', unit_size,
  'inventory_unit', inventory_unit, 'product_form', product_form) FROM public.products WHERE id = '${p}';`));
// The prices the export's preview shows now; a row the preview refuses gets none (the writer refuses it first).
const prices = (p, rate, unit) => {
  const r = as(ADMIN, `SELECT public.preview_product_rate_correction('${p}', ${rate === '' || rate === null ? 'NULL' : rate}, ${unit === null ? 'NULL' : `'${unit}'`})->'after';`);
  return r.status === 0 ? JSON.parse(r.rows.at(-1)) : {};
};
const row = (p, rate, unit, suggested, expected) => ({ product_id: p, rate_per_acre: rate, rate_unit: unit,
  suggested_rate: suggested, expected: { rate_per_acre: expected[0], rate_unit: expected[1], suggested_rate: expected[2], ...facts(p),
    prices: prices(p, rate, unit) } });
const setRates = (rows, key, actor = ADMIN) =>
  `SELECT public.set_product_rates('${JSON.stringify(rows)}'::jsonb, '${actor}', '${key}');`;
const lock = (on, reason, key, actor = ADMIN) =>
  `SELECT public.set_product_rate_lock(${on}, ${reason === null ? 'NULL' : `'${reason}'`}, '${actor}', '${key}');`;
// The confirmed prices default to a fresh preview; pass them to test what was shown.
const correct = (p, rate, unit, suggested, version, reason, key, actor = ADMIN,
  prices = `(public.preview_product_rate_correction('${p}', ${rate}, '${unit}')->'after')`,
  // The rates the admin started from: the row as it is now, unless a test passes an older view.
  current = `(SELECT jsonb_build_object('rate_per_acre', rate_per_acre::text, 'rate_unit', rate_unit, 'suggested_rate', suggested_rate) FROM public.products WHERE id = '${p}')`) =>
  `SELECT public.correct_product_rates('${p}', ${rate}, '${unit}', '${suggested}', ${version}, ${prices === 'NULL' ? 'NULL' : `${current} || jsonb_build_object('prices', ${prices})`}, '${reason}', '${actor}', '${key}');`;
const events = () => scalar(`SELECT coalesce(string_agg(event_type, ',' ORDER BY id), '-') FROM public.product_rate_events;`);

// 20 more invented products priced per gallon for the Rates-tab upload, with varied tier prices.
const BATCH = Array.from({ length: 20 }, (_, i) => ({
  id: id(`d${String(i + 1).padStart(2, '0')}`),
  t1: 2000 + i * 137, t2: 1900 + i * 111, t3: 1800 + i * 97, // cents
  rate10: 5 + i * 7, // tenths of an ounce per acre: 0.5 oz .. 13.8 oz
}));
const SEED = id('e1');
const cents = (c) => (c / 100).toFixed(2);
// The amount exactly as returned, refused unless whole cents (a fractional cent must not round its way to a pass).
const exactCents = (v) => { assert.match(String(v), /^[0-9]+([.][0-9]{1,2})?$/, `${v} is not whole cents`); return Number(v).toFixed(2); };
// Hand calculation, in whole cents: price per gallon x (rate oz / 128 oz), half away from zero.
const perAcre = (priceCents, rate10) => {
  const num = priceCents * rate10; const den = 1280;
  return Math.floor(num / den) + ((num % den) * 2 >= den ? 1 : 0);
};

function seedBatch() {
  asOwner(`INSERT INTO public.products (id, product_name, sku, category, inventory_unit, is_active, tier1_price, tier2_price, tier3_price)
    VALUES ${BATCH.map((b, i) => `('${b.id}', '[PROVER] Batch ${i + 1}', 'SW-${i + 1}', 'Herbicide', 'gal', true, ${cents(b.t1)}, ${cents(b.t2)}, ${cents(b.t3)})`).join(',\n')};
    -- A seed product stocked in Lb, and a unit of type both, which the rate writers' unit check accepts for seed.
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Unit', 1, 'both');
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, rate_unit, is_active, tier1_price)
    VALUES ('${SEED}', '[PROVER] Seed', 'SW-S', 'seed', 'Lb', 'Lb', true, 3.00);`);
}
const exportRows = (uid = ADMIN) => JSON.parse(ok(uid, 'SELECT public.get_product_setup_workbook();'));
const byId = (exp, p) => exp.rows.find((r) => r.product_id === p);
// A Rates-tab row as the screen sends it: new values plus the download's values as `expected`.
const rateRow = (e, rate, unit, suggested) => ({ product_id: e.product_id, rate_per_acre: rate, rate_unit: unit,
  suggested_rate: suggested, expected: { rate_per_acre: e.rate_per_acre, rate_unit: e.rate_unit,
    suggested_rate: e.suggested_rate, pricing_version: e.pricing_version, unit_size: e.unit_size,
    inventory_unit: e.inventory_unit, product_form: e.product_form } });
const previewRates = (rows, uid = ADMIN) =>
  JSON.parse(ok(uid, `SELECT public.preview_product_rates('${JSON.stringify(rows).replaceAll("'", "''")}'::jsonb);`));
// The save: the previewed after-prices become each row's expected.prices, as the screen does.
const saveFromPreview = (rows, preview) => rows.map((r) => {
  const p = preview.rows.find((x) => x.product_id === r.product_id);
  return { ...r, expected: { ...r.expected, prices: {
    tier1_price_per_acre: p.after.tier1_price_per_acre, tier2_price_per_acre: p.after.tier2_price_per_acre,
    tier3_price_per_acre: p.after.tier3_price_per_acre } } };
}).filter((r) => preview.rows.find((x) => x.product_id === r.product_id).status === 'change');
const setup = (rows, key, actor = ADMIN) =>
  `SELECT public.apply_product_setup('${JSON.stringify(rows).replaceAll("'", "''")}'::jsonb, '${actor}', '${key}');`;
const field = (p, col) => scalar(`SELECT ${col} FROM public.products WHERE id = '${p}';`);
const history = (p) => scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${p}';`);

function main() {
  buildContainer();
  seed();
  seedBatch();
  stageText('cand.sql', lf(CANDIDATE));
  const installed = apply('cand.sql');
  assert.equal(installed.status, 0, installed.output);
  ledger(path.basename(CANDIDATE, '.sql'));
  console.log('[prover] installs on top of the rate lock (20261107060000)');

  // The download: admins only.
  const exp = exportRows();
  assert.equal(exp.rates_locked, false);
  assert.ok(exp.rows.length >= 23);
  assert.match(byId(exp, P.GAL).setup_fingerprint, /^[0-9a-f]{32}$/);
  assert.equal(byId(exp, P.GAL).vendor, undefined, 'the setup download never carries vendor');
  refused(REP, 'SELECT public.get_product_setup_workbook();', /ADMIN_REQUIRED/);
  refused(null, 'SELECT public.get_product_setup_workbook();', /permission denied/);
  refused(REP, `SELECT public.preview_product_rates('[]'::jsonb);`, /ADMIN_REQUIRED/);
  refused(REP, setup([{ product_id: P.GAL, setup_fingerprint: 'x', changes: { sku: 'X' } }], 'k-rep', REP), /ADMIN_REQUIRED/);
  refused(null, setup([{ product_id: P.GAL, setup_fingerprint: 'x', changes: { sku: 'X' } }], 'k-anon'), /permission denied/);
  console.log('[prover] the download, rate preview and setup save are admin-only');

  // Rates tab, lock off: 20 rates change after the preview; per-acre prices match a hand calculation to the cent.
  const rows = BATCH.map((b) => rateRow(byId(exp, b.id), (b.rate10 / 10).toString(), 'oz', `${b.rate10 / 10} oz/A`));
  const preview = previewRates(rows);
  assert.equal(preview.rows.filter((r) => r.status === 'change').length, 20);
  for (const b of BATCH) {
    const p = preview.rows.find((r) => r.product_id === b.id);
    assert.equal(p.before.tier1_price_per_acre, null);
    assert.equal(exactCents(p.after.tier1_price_per_acre), cents(perAcre(b.t1, b.rate10)), `tier 1 preview for ${b.id}`);
    assert.equal(exactCents(p.after.tier2_price_per_acre), cents(perAcre(b.t2, b.rate10)), `tier 2 preview for ${b.id}`);
    assert.equal(exactCents(p.after.tier3_price_per_acre), cents(perAcre(b.t3, b.rate10)), `tier 3 preview for ${b.id}`);
  }
  assert.equal(scalar(`SELECT count(*) FROM public.products WHERE rate_per_acre IS NOT NULL AND id IN (${BATCH.map((b) => `'${b.id}'`).join(',')});`), '0', 'a preview saves nothing');
  const saved = JSON.parse(ok(ADMIN, setRates(saveFromPreview(rows, preview), 'k-rates-20')));
  assert.equal(saved.changed_count, 20);
  for (const b of BATCH) {
    assert.equal(scalar(`SELECT concat_ws('|', rate_per_acre, rate_unit, tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre) FROM public.products WHERE id = '${b.id}';`),
      `${b.rate10 / 10}|oz|${cents(perAcre(b.t1, b.rate10))}|${cents(perAcre(b.t2, b.rate10))}|${cents(perAcre(b.t3, b.rate10))}`);
  }
  console.log('[prover] lock off: a Rates-tab upload changes 20 rates after the preview, per-acre prices equal the hand calculation to the cent');

  // The same file again: every row is unchanged? No: the file still expects blank rates, so every row is stale, by name.
  const again = previewRates(rows);
  assert.equal(again.rows.filter((r) => r.status === 'stale').length, 20);
  assert.equal(again.rows[0].product_name, '[PROVER] Batch 1');
  // A fresh download with the same values is unchanged; a bad rate, a bad unit and an unknown product are named.
  const fresh = exportRows();
  const f1 = byId(fresh, BATCH[0].id);
  const checks = previewRates([
    rateRow(f1, f1.rate_per_acre, f1.rate_unit, f1.suggested_rate),
    rateRow(byId(fresh, BATCH[1].id), '-1', 'oz', ''),
    rateRow(byId(fresh, BATCH[2].id), '3', 'furlongs', ''),
    { ...rateRow(f1, '1', 'oz', ''), product_id: id('dead') },
  ]);
  assert.deepEqual(checks.rows.map((r) => r.status), ['unchanged', 'invalid_rate', 'invalid_unit', 'not_found']);
  // A seed product: only its stock unit is a rate unit; the preview names any other and shows the unit it stores.
  const seedRow = byId(fresh, SEED);
  assert.equal(previewRates([rateRow(seedRow, '2', 'Unit', '')]).rows[0].status, 'invalid_unit');
  const seedOk = previewRates([rateRow(seedRow, '2', 'Lb', '')]);
  assert.equal(seedOk.rows[0].status, 'change');
  assert.equal(seedOk.rows[0].after.rate_unit, 'Lb');
  // A blank seed unit becomes the stock unit before the rate-lock trigger judges it, so the preview judges that too:
  // with its spellings disagreeing, the preview names it and the save is refused.
  psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('LB', 15, 'dry');`);
  assert.equal(previewRates([rateRow(seedRow, '2', '', '')]).rows[0].status, 'invalid_unit');
  refused(ADMIN, setRates(saveFromPreview([rateRow(seedRow, '2', '', '')], seedOk), 'k-seed-blank'), /PRODUCT_RATE_UNIT_INVALID/);
  psql(`DELETE FROM public.unit_conversions WHERE unit = 'LB';`);
  assert.equal(previewRates([rateRow(seedRow, '2', '', '')]).rows[0].status, 'change');
  ok(ADMIN, setRates(saveFromPreview([rateRow(seedRow, '2', 'Lb', '')], seedOk), 'k-seed-rate'));
  assert.equal(field(SEED, 'rate_per_acre'), '2');
  refused(ADMIN, `SELECT public.preview_product_rates('${JSON.stringify([rateRow(f1, '1', 'oz', ''), rateRow(f1, '2', 'oz', '')])}'::jsonb);`, /PRODUCT_RATE_DUPLICATE_PRODUCT/);
  refused(ADMIN, `SELECT public.preview_product_rates('[{"product_id":"${P.GAL}"}]'::jsonb);`, /PRODUCT_RATE_ROW_SHAPE_INVALID/);
  console.log('[prover] the rate preview names stale, invalid and unknown rows, and refuses duplicates and bad shapes');

  // Setup tab: a change saves only after confirm, all-or-nothing, logged, retry-safe.
  const g = byId(fresh, BATCH[0].id);
  const h = byId(fresh, BATCH[1].id);
  const hist = history(g.product_id);
  const change = [
    { product_id: g.product_id, setup_fingerprint: g.setup_fingerprint, changes: { product_name: '[PROVER] Batch 1 renamed',
      sku: 'SW-1A', epa_registration: '524-475', rei_hours: 12, phi_days: 30, is_rup: true, signal_word: 'Caution',
      container_size: '2.5', container_type: 'Jug', max_label_rate: '32', max_label_rate_unit: 'oz',
      use_timings: ['pre_emerge', 'post_emergence'], manufacturer: 'Acme', notes: 'n', internal_notes: 'i', quoting_notes: 'q' } },
    { product_id: h.product_id, setup_fingerprint: h.setup_fingerprint, changes: { category: 'Fungicide' } },
  ];
  const applied = JSON.parse(ok(ADMIN, setup(change, 'k-setup-1')));
  assert.equal(applied.changed_count, 2);
  assert.equal(scalar(`SELECT concat_ws('|', product_name, sku, epa_registration, rei_hours, phi_days, is_rup, signal_word, container_size, container_type, max_label_rate, max_label_rate_unit, array_to_string(use_timings, ','), manufacturer, notes, internal_notes, quoting_notes) FROM public.products WHERE id = '${g.product_id}';`),
    '[PROVER] Batch 1 renamed|SW-1A|524-475|12|30|t|Caution|2.5|Jug|32|oz|pre_emerge,post_emergence|Acme|n|i|q');
  assert.equal(field(h.product_id, 'category'), 'Fungicide');
  assert.equal(field(g.product_id, 'rate_per_acre'), String(BATCH[0].rate10 / 10), 'setup never touches rates');
  assert.ok(Number(history(g.product_id)) > Number(hist), 'the change history records the setup change');
  assert.deepEqual(JSON.parse(ok(ADMIN, setup(change, 'k-setup-1'))), applied, 'a same-key replay answers the same');
  refused(ADMIN, setup([{ ...change[1], changes: { category: 'Herbicide' } }], 'k-setup-1'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  console.log('[prover] Setup tab: every setup field saves, logged in change history, retry-safe');

  // Stale: the old file's fingerprint is refused by product name; nothing from that upload saves.
  refused(ADMIN, setup([{ ...change[1], changes: { manufacturer: 'Late' } }], 'k-setup-stale'), /PRODUCT_SETUP_STALE: .*\[PROVER\] Batch 2/);
  assert.equal(field(h.product_id, 'manufacturer'), '');
  // A value the table refuses (bad EPA format) names the product and rolls back the good row with it.
  const f2 = exportRows();
  const k = byId(f2, BATCH[3].id); const m = byId(f2, BATCH[4].id);
  refused(ADMIN, setup([
    { product_id: k.product_id, setup_fingerprint: k.setup_fingerprint, changes: { manufacturer: 'Good' } },
    { product_id: m.product_id, setup_fingerprint: m.setup_fingerprint, changes: { epa_registration: 'not-an-epa' } },
  ], 'k-setup-bad'), /PRODUCT_SETUP_ROW_REFUSED: \[PROVER\] Batch 5: PRODUCT_SETUP_INVALID: EPA number/);
  assert.equal(field(k.product_id, 'manufacturer'), '', 'all or nothing');
  refused(ADMIN, setup([{ product_id: m.product_id, setup_fingerprint: m.setup_fingerprint, changes: { category: 'Nope' } }], 'k-setup-cat'), /PRODUCT_SETUP_ROW_REFUSED: \[PROVER\] Batch 5/);
  refused(ADMIN, setup([{ product_id: m.product_id, setup_fingerprint: m.setup_fingerprint, changes: { use_timings: ['no_such_code'] } }], 'k-setup-ut'), /PRODUCT_SETUP_ROW_REFUSED/);
  refused(ADMIN, setup([{ product_id: m.product_id, setup_fingerprint: m.setup_fingerprint, changes: { use_timings: 'bad' } }], 'k-setup-ut-scalar'), /PRODUCT_SETUP_INVALID/);
  refused(ADMIN, setup([{ product_id: m.product_id, setup_fingerprint: m.setup_fingerprint, changes: { container_size: '0' } }], 'k-setup-cs'), /PRODUCT_SETUP_INVALID: .*Batch 5/);
  refused(ADMIN, setup([{ product_id: m.product_id, setup_fingerprint: m.setup_fingerprint, changes: { rei_hours: 'twelve' } }], 'k-setup-rei'), /PRODUCT_SETUP_INVALID/);
  // Fields the Setup tab never writes: vendor, rates, prices, cost, active, form, stock unit, pack size.
  for (const forbidden of ['vendor', 'rate_per_acre', 'rate_unit', 'suggested_rate', 'tier1_price', 'current_cost', 'is_active', 'product_form', 'inventory_unit', 'unit_size', 'container_unit']) {
    refused(ADMIN, setup([{ product_id: m.product_id, setup_fingerprint: m.setup_fingerprint, changes: { [forbidden]: 'x' } }], `k-forbid-${forbidden}`), /PRODUCT_SETUP_ROW_SHAPE_INVALID/);
  }
  refused(ADMIN, setup([{ product_id: m.product_id, setup_fingerprint: m.setup_fingerprint, changes: {} }], 'k-empty'), /PRODUCT_SETUP_ROW_SHAPE_INVALID/);
  refused(ADMIN, setup([{ product_id: m.product_id, setup_fingerprint: m.setup_fingerprint, changes: 'bad' }], 'k-scalar'), /PRODUCT_SETUP_ROW_SHAPE_INVALID/);
  refused(ADMIN, setup([{ product_id: m.product_id, setup_fingerprint: m.setup_fingerprint, changes: { sku: 'A' } }], 'k-actor', REP), /ACTOR_MISMATCH|ADMIN_REQUIRED/);
  refused(ADMIN, `SELECT public.apply_product_setup('[{"product_id":"${m.product_id}","setup_fingerprint":"${m.setup_fingerprint}","changes":{"sku":"A"}}]'::jsonb, '${ADMIN}', NULL);`, /IDEMPOTENCY_KEY_REQUIRED/);
  console.log('[prover] Setup tab refuses stale rows and bad values by product name, all-or-nothing, and never writes vendor, rates, prices, cost, active, form or units');

  // One file, Setup saved first: a notes change moves pricing_version, so the screen moves the Rates row's
  // expected version only where this save moved it from the downloaded one (rebaseRateRowsAfterSetup).
  const f3 = exportRows();
  const own = byId(f3, BATCH[6].id); const other = byId(f3, BATCH[7].id);
  asOwner(`UPDATE public.products SET pricing_version = pricing_version + 1 WHERE id = '${other.product_id}';`); // someone else's price change
  const ownSave = JSON.parse(ok(ADMIN, setup([own, other].map((e) => ({ product_id: e.product_id, setup_fingerprint: e.setup_fingerprint,
    changes: { quoting_notes: 'from the workbook' } })), 'k-setup-then-rates')));
  const versions = Object.fromEntries(ownSave.rows.map((r) => [r.product_id, r]));
  assert.equal(versions[own.product_id].pricing_version_after, own.pricing_version + 1, 'a notes change moves pricing_version');
  const rebased = [own, other].map((e) => {
    const r = rateRow(e, '2', 'oz', ''); const v = versions[e.product_id];
    return v.pricing_version_before === r.expected.pricing_version ? { ...r, expected: { ...r.expected, pricing_version: v.pricing_version_after } } : r;
  });
  const afterSetup = previewRates(rebased);
  assert.deepEqual(afterSetup.rows.map((r) => r.status), ['change', 'stale'], 'only our own version move is carried over');
  ok(ADMIN, setRates(saveFromPreview([rebased[0]], afterSetup), 'k-rates-after-setup'));
  assert.equal(field(own.product_id, 'rate_per_acre'), '2');
  console.log('[prover] Setup then Rates from one file: our own version move is carried over, someone else\'s still refuses the row');

  // Lock on: the same Rates upload is refused; the Setup tab still saves.
  ok(ADMIN, lock(true, 'season set', 'k-lock'));
  const locked = exportRows();
  const lockedRows = BATCH.map((b) => rateRow(byId(locked, b.id), '1', 'oz', ''));
  const lockedPreview = previewRates(lockedRows);
  assert.equal(lockedPreview.rates_locked, true);
  refused(ADMIN, setRates(saveFromPreview(lockedRows, lockedPreview), 'k-rates-locked'), /PRODUCT_RATES_LOCKED/);
  const n = byId(locked, BATCH[5].id);
  ok(ADMIN, setup([{ product_id: n.product_id, setup_fingerprint: n.setup_fingerprint, changes: { quoting_notes: 'while locked' } }], 'k-setup-locked'));
  assert.equal(field(n.product_id, 'quoting_notes'), 'while locked');
  console.log('[prover] lock on: the Rates upload is refused; the Setup tab still saves');
  console.log('PRODUCT_SETUP_WORKBOOK_PROOF_PASS');
}
try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
