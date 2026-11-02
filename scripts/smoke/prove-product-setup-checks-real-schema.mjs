#!/usr/bin/env node
/**
 * Real-schema proof for 20261102102000_product_setup_checks.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17
 * container and replays ordered post-baseline migrations up to this candidate. It exercises
 * transaction, legacy-row, check, category, role, replay and mutation checks against the real schema.
 *
 * Run: node scripts/smoke/prove-product-setup-checks-real-schema.mjs   (needs Docker)
 * Prints PRODUCT_SETUP_CHECKS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-product-setup-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261102102000_product_setup_checks.sql');
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
const TOUCHED = /product_categories|upsert_product_category|product_setup_/;
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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  // The checked-in database baseline predates these Auth service objects. Current profile
  // deactivation updates banned_until and deletes sessions; restore their local shape only.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    GRANT DELETE ON auth.sessions TO postgres;`, { user: 'supabase_admin' });
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const ADMIN = '7c610000-0000-4000-8000-0000000000a1';
const REP = '7c610000-0000-4000-8000-0000000000b1';
const INACTIVE = '7c610000-0000-4000-8000-0000000000c1';
const DRIVER = '7c610000-0000-4000-8000-0000000000d1';
const APPLICATOR = '7c610000-0000-4000-8000-0000000000e1';
const PRODUCT_NAME = '[PROVER] Product History Chem';
const WATCHED = [
  'product_name', 'sku', 'category', 'vendor', 'manufacturer', 'container_size', 'container_unit',
  'container_type', 'unit_size', 'inventory_unit', 'product_form', 'suggested_rate', 'rate_per_acre',
  'rate_unit', 'notes', 'internal_notes', 'quoting_notes', 'is_active', 'epa_registration', 'is_rup',
  'signal_word', 'rei_hours', 'phi_days', 'max_label_rate', 'max_label_rate_unit', 'use_timing',
  'product_family_id', 'return_policy', 'packaging_variant', 'is_full_tote_only',
];

function session(actor, sql, role = 'authenticated') {
  return psql(`BEGIN;
    SET LOCAL ROLE ${role};
    SELECT set_config('request.jwt.claim.sub', '${actor}', true);
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${actor}', 'role', '${role}')::text, true);
    ${sql}
    COMMIT;`);
}
// Inner pricing functions are deliberately revoked from API roles; the public wrapper owns
// browser access. Exercise their real apply path as the owner with an admin JWT, as other provers do.
function ownerWithAdminClaim(sql) {
  return psql(`BEGIN;
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', 'authenticated')::text, true);
    ${sql}
    COMMIT;`);
}
function roleScalar(role, actor, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;
    SET LOCAL ROLE ${role};
    SELECT set_config('request.jwt.claim.sub', '${actor}', true);
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${actor}', 'role', '${role}')::text, true);
    ${sql}
    ROLLBACK;` });
  return r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}
function denied(role, actor, sql, pattern = /permission denied/) {
  const r = psql(`BEGIN;
    SET LOCAL ROLE ${role};
    SELECT set_config('request.jwt.claim.sub', '${actor}', true);
    ${sql}`, { allowFailure: true });
  assert.notEqual(r.status, 0, `${role} unexpectedly ran ${sql}`);
  assert.match(`${r.stdout}\n${r.stderr}`, pattern, `${role} failed for the wrong reason`);
}
function refusedAsOwner(sql) {
  const r = psql(sql, { allowFailure: true });
  assert.notEqual(r.status, 0, `postgres unexpectedly ran ${sql}`);
  assert.match(`${r.stdout}\n${r.stderr}`, /PRODUCT_CHANGE_HISTORY_IS_APPEND_ONLY/);
}
function seedProfiles() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'product-history-admin@example.invalid', '{"full_name":"[PROVER] Product Admin","role":"admin"}'::jsonb),
    ('${REP}', 'product-history-rep@example.invalid', '{"full_name":"[PROVER] Product Rep","role":"sales_rep"}'::jsonb),
    ('${INACTIVE}', 'product-history-inactive@example.invalid', '{"full_name":"[PROVER] Inactive Rep","role":"sales_rep"}'::jsonb),
    ('${DRIVER}', 'product-history-driver@example.invalid', '{"full_name":"[PROVER] Driver","role":"driver"}'::jsonb),
    ('${APPLICATOR}', 'product-history-applicator@example.invalid', '{"full_name":"[PROVER] Applicator","role":"applicator"}'::jsonb);`);
  psql(`BEGIN;
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    UPDATE public.profiles SET is_active = false WHERE id = '${INACTIVE}';
    COMMIT;`);
  assert.equal(scalar(`SELECT full_name FROM public.profiles WHERE id = '${ADMIN}';`), '[PROVER] Product Admin');
}

function refused(sql, pattern) {
  const r = psql(sql, { allowFailure: true });
  assert.notEqual(r.status, 0, `unexpectedly accepted: ${sql}`);
  assert.match(`${r.stdout}\n${r.stderr}`, pattern, `wrong refusal for: ${sql}`);
}

try {
  buildContainer(); // Replays 20261102100000_product_change_history before this candidate.
  seedProfiles();
  psql(`INSERT INTO public.products(product_name, category, sku, epa_registration) VALUES
    ('  Legacy padded  ', 'Herbicide', NULL, NULL),
    ('Legacy empty SKU', 'Herbicide', '', NULL),
    ('Legacy bad EPA', 'Herbicide', NULL, 'bad-epa'),
    ('Legacy empty EPA', 'Herbicide', NULL, '');`);
  const legacyCount = scalar("SELECT count(*) FROM public.products WHERE product_name LIKE 'Legacy %' OR product_name = '  Legacy padded  '; ");
  assert.equal(legacyCount, '4');
  const candidate = lf(CANDIDATE);
  stageText('candidate.sql', candidate);
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'autocommit unexpectedly applied the migration');
  assert.match(`${auto.stdout}\n${auto.stderr}`, /PRODUCT_SETUP_CHECKS_NOT_IN_TRANSACTION/);
  assert.equal(scalar("SELECT to_regclass('public.product_categories') IS NULL;"), 't');
  psql("INSERT INTO public.products(product_name, category) VALUES ('Unknown before migration', 'Not Listed');");
  const unknown = apply('candidate.sql');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.output, /PREFLIGHT_PRODUCT_CATEGORY_UNKNOWN/);
  psql("UPDATE public.products SET category = 'Herbicide' WHERE product_name = 'Unknown before migration';");

  for (const [label, mutation, error] of [
    ['policy', 'ALTER POLICY product_categories_select ON public.product_categories USING (true);', 'active-profile SELECT policy'],
    ['fk', 'ALTER TABLE public.products DROP CONSTRAINT product_setup_category_fk;', 'FK or category index'],
  ]) {
    assert.equal(candidate.split('DO $postflight$').length - 1, 1);
    stageText(`mutation-${label}.sql`, candidate.replace('DO $postflight$', `${mutation}\nDO $postflight$`));
    const result = apply(`mutation-${label}.sql`);
    assert.notEqual(result.status, 0, `${label} mutation was accepted`);
    assert.ok(result.output.includes(error), `${label} mutation failed for the wrong reason: ${result.output}`);
    assert.equal(scalar("SELECT to_regclass('public.product_categories') IS NULL;"), 't');
  }
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'second apply succeeded');
  assert.match(again.output, /PREFLIGHT_PRODUCT_SETUP_CHECKS_ALREADY_EXISTS/);
  assert.equal(scalar("SELECT count(*) FROM public.products WHERE product_name LIKE 'Legacy %' OR product_name = '  Legacy padded  ';"), '4');
  assert.equal(scalar("SELECT count(*) FROM public.product_categories;"), '12');
  console.log('[prover] TRANSACTION: autocommit and second apply refused; four legacy bad rows survived');

  const checks = [
    ['product_name', "''", 'PRODUCT_SETUP_INVALID: product name'],
    ['product_name', "' padded '", 'PRODUCT_SETUP_INVALID: product name'],
    ['sku', "''", 'PRODUCT_SETUP_INVALID: SKU'],
    ['sku', "' padded '", 'PRODUCT_SETUP_INVALID: SKU'],
    ['rate_per_acre', '-1', 'PRODUCT_SETUP_INVALID: rate per acre'],
    ['rate_per_acre', "'NaN'::numeric", 'PRODUCT_SETUP_INVALID: rate per acre'],
    ['epa_registration', "''", 'PRODUCT_SETUP_INVALID: EPA number'],
    ['epa_registration', "'bad-epa'", 'PRODUCT_SETUP_INVALID: EPA number'],
    ['rei_hours', '-1', 'PRODUCT_SETUP_INVALID: REI hours'],
    ['phi_days', '-1', 'PRODUCT_SETUP_INVALID: PHI days'],
  ];
  psql("INSERT INTO public.products(product_name, category) VALUES ('Valid setup row', 'Herbicide');");
  for (const [field, value, constraint] of checks) {
    const insert = field === 'product_name'
      ? `INSERT INTO public.products(product_name, category) VALUES (${value}, 'Seed');`
      : `INSERT INTO public.products(product_name, category, ${field}) VALUES ('New bad row', 'Seed', ${value});`;
    refused(insert, new RegExp(constraint));
    refused(`UPDATE public.products SET ${field} = ${value} WHERE product_name = 'Valid setup row';`, new RegExp(constraint));
  }
  psql("UPDATE public.products SET notes = 'other field' WHERE product_name IN ('  Legacy padded  ', 'Legacy empty SKU', 'Legacy bad EPA', 'Legacy empty EPA');");
  session(ADMIN, "UPDATE public.products SET notes = 'admin edit' WHERE product_name = 'Legacy empty SKU';");
  ownerWithAdminClaim(`DO $pricing$ DECLARE v_admin uuid := '${ADMIN}'; v_product uuid; v_pricing jsonb;
    BEGIN SELECT id INTO v_product FROM public.products WHERE product_name = 'Legacy empty SKU';
    v_pricing := public.preview_product_pricing_changes('product_page', NULL,
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'row_version', 1,
        'pricing_mode', 'price_driven', 'new_cost', '6.00', 'tier1_price', '10.00',
        'tier2_price', '10.00', 'tier3_price', '10.00')), v_admin, 'setup-legacy-price-preview');
    PERFORM public.apply_product_pricing_change_set((v_pricing->>'change_set_id')::uuid,
      v_pricing->>'request_fingerprint', v_admin, 'setup-legacy-price-apply'); END $pricing$;`);
  assert.equal(scalar("SELECT tier1_price = 10 FROM public.products WHERE product_name = 'Legacy empty SKU';"), 't');
  session(ADMIN, "UPDATE public.products SET is_active = false WHERE product_name = 'Legacy empty SKU';");
  assert.equal(scalar("SELECT is_active FROM public.products WHERE product_name = 'Legacy empty SKU';"), 'f');
  refused("UPDATE public.products SET sku = '  ' WHERE product_name = 'Legacy empty SKU';", /PRODUCT_SETUP_INVALID: SKU/);
  psql("UPDATE public.products SET product_name = btrim(product_name), notes = 'repaired' WHERE product_name = '  Legacy padded  ';");
  psql("UPDATE public.products SET sku = NULL, notes = 'repaired' WHERE product_name = 'Legacy empty SKU';");
  psql("UPDATE public.products SET epa_registration = NULL, notes = 'repaired' WHERE product_name IN ('Legacy bad EPA', 'Legacy empty EPA');");
  psql("UPDATE public.products SET notes = 'later edit' WHERE product_name IN ('Legacy padded', 'Legacy empty SKU', 'Legacy bad EPA', 'Legacy empty EPA');");
  console.log('[prover] CHECKS: bad changed fields refused; legacy price, notes and active writes worked');

  // The schema baseline carries no unit rows, so seed the one liquid unit this case uses.
  psql("INSERT INTO public.unit_conversions(unit, factor_oz, unit_type) VALUES ('fl oz', 1, 'liquid') ON CONFLICT (unit) DO UPDATE SET unit_type = 'liquid';");
  psql("INSERT INTO public.products(product_name, category, unit_size) VALUES ('First unit choice', 'Seed', 'GL');");
  psql("UPDATE public.products SET product_form = 'liquid', container_unit = 'fl oz', inventory_unit = 'fl oz' WHERE product_name = 'First unit choice';");
  for (const field of ['product_form', 'container_unit', 'inventory_unit']) {
    const value = field === 'product_form' ? 'dry' : 'Lb';
    refused(`UPDATE public.products SET ${field} = '${value}' WHERE product_name = 'First unit choice';`, /This can't change on a saved product yet/);
  }
  assert.equal(scalar("SELECT product_form || ':' || container_unit || ':' || inventory_unit FROM public.products WHERE product_name = 'First unit choice';"), 'liquid:fl oz:fl oz');
  ownerWithAdminClaim(`DO $pricing$ DECLARE v_admin uuid := '${ADMIN}'; v_product uuid; v_pricing jsonb;
    BEGIN SELECT id INTO v_product FROM public.products WHERE product_name = 'First unit choice';
    v_pricing := public.preview_product_pricing_changes('product_page', NULL,
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'row_version', 1,
        'pricing_mode', 'price_driven', 'new_cost', '7.00', 'tier1_price', '11.00',
        'tier2_price', '11.00', 'tier3_price', '11.00')), v_admin, 'setup-unit-price-preview');
    PERFORM public.apply_product_pricing_change_set((v_pricing->>'change_set_id')::uuid,
      v_pricing->>'request_fingerprint', v_admin, 'setup-unit-price-apply'); END $pricing$;`);
  assert.equal(scalar("SELECT product_form || ':' || container_unit || ':' || inventory_unit FROM public.products WHERE product_name = 'First unit choice';"), 'liquid:fl oz:fl oz');

  refused("INSERT INTO public.products(product_name, category) VALUES ('Unknown category', 'Syngnta');", /product_setup_category_fk/);
  psql("INSERT INTO public.products(product_name, category) VALUES ('Alias row', 'Post Emergence'), ('Seed row', 'Seed');");
  assert.equal(scalar("SELECT category FROM public.products WHERE product_name = 'Alias row';"), 'Herbicide');
  assert.equal(scalar("SELECT category FROM public.products WHERE product_name = 'Seed row';"), 'Seed');
  refused("SELECT public.upsert_product_category('seed', true, 121, 'proof-case-duplicate');", /AUTH_REQUIRED/);
  denied('authenticated', ADMIN, "SELECT public.upsert_product_category('seed', true, 121, 'proof-case-duplicate');", /PRODUCT_CATEGORY_ALREADY_EXISTS/);
  denied('authenticated', ADMIN, `SELECT public.upsert_product_category('${'x'.repeat(101)}', true, 121, 'proof-too-long');`, /PRODUCT_CATEGORY_NAME_TOO_LONG/);
  const rpc = `SELECT public.upsert_product_category(' Seed ', false, 120, 'proof-retire-seed');`;
  const result = session(ADMIN, rpc).stdout;
  assert.match(result, /"is_active": false/);
  assert.equal(session(ADMIN, rpc).stdout, result, 'same request did not replay the saved result');
  denied('authenticated', ADMIN,
    "SELECT public.upsert_product_category('Seed', true, 120, 'proof-retire-seed');",
    /IDEMPOTENCY_INTENT_MISMATCH/);
  denied('authenticated', REP, "SELECT public.upsert_product_category('Rep category', true, 130, 'proof-rep');", /NOT_AUTHORIZED/);
  denied('anon', ADMIN, "SELECT public.upsert_product_category('Anon category', true, 130, 'proof-anon');");
  denied('authenticated', ADMIN,
    "INSERT INTO public.product_categories(name, sort_order) VALUES ('Direct write', 130);");
  assert.equal(roleScalar('authenticated', REP, "SELECT count(*) FROM public.product_categories WHERE name = 'Seed';"), '1');
  assert.equal(roleScalar('authenticated', INACTIVE, "SELECT count(*) FROM public.product_categories;"), '0');
  session(ADMIN, "SELECT public.upsert_product_category(' New   Category ', true, 140, 'proof-inner-space');");
  assert.equal(scalar("SELECT count(*) FROM public.product_categories WHERE name = 'New Category';"), '1');
  refused("INSERT INTO public.products(product_name, category) VALUES ('Retired category', 'Seed');", /PRODUCT_CATEGORY_RETIRED/);
  refused("UPDATE public.products SET category = 'Seed' WHERE product_name = 'Valid setup row';", /PRODUCT_CATEGORY_RETIRED/);
  psql("UPDATE public.products SET notes = 'still valid' WHERE product_name = 'Seed row';");
  assert.equal(scalar("SELECT category FROM public.products WHERE product_name = 'Seed row';"), 'Seed');
  console.log('[prover] CATEGORIES: FK, alias, Seed, retired assignment, admin RPC, idempotency, role access');
  console.log('[prover] MUTATIONS: weakened policy and missing FK caught');
  console.log('PRODUCT_SETUP_CHECKS_PROOF_PASS');
} finally {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
  else console.log(`[prover] kept container ${NAME}`);
}

