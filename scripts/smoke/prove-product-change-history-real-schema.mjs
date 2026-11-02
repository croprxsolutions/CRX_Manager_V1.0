#!/usr/bin/env node
/**
 * Real-schema proof for 20261102100000_product_change_history.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17
 * container and replays ordered post-baseline migrations up to this candidate. It exercises
 * transaction, actor, write-path, access, append-only and mutation checks against the real schema.
 *
 * Run: node scripts/smoke/prove-product-change-history-real-schema.mjs   (needs Docker)
 * Prints PRODUCT_CHANGE_HISTORY_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-product-history-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261102100000_product_change_history.sql');
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
const TOUCHED = /product_change_history|write_product_change_history/;
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
    ('${INACTIVE}', 'product-history-inactive@example.invalid', '{"full_name":"[PROVER] Inactive Rep","role":"sales_rep"}'::jsonb);`);
  psql(`BEGIN;
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    UPDATE public.profiles SET is_active = false WHERE id = '${INACTIVE}';
    COMMIT;`);
  assert.equal(scalar(`SELECT full_name FROM public.profiles WHERE id = '${ADMIN}';`), '[PROVER] Product Admin');
}

try {
  buildContainer();
  seedProfiles();
  const candidate = lf(CANDIDATE);
  stageText('candidate.sql', candidate);

  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'autocommit unexpectedly applied the migration');
  assert.match(`${auto.stdout}\n${auto.stderr}`, /PRODUCT_CHANGE_HISTORY_NOT_IN_TRANSACTION/);
  assert.equal(scalar("SELECT to_regclass('public.product_change_history') IS NULL;"), 't');
  console.log('[prover] AUTOCOMMIT: refused at the preflight');

  for (const [label, mutation, error] of [
    ['policy', 'ALTER POLICY product_change_history_select ON public.product_change_history USING (true);', 'active-profile SELECT policy'],
    ['grant', 'GRANT INSERT ON public.product_change_history TO authenticated;', 'table privileges'],
  ]) {
    assert.equal(candidate.split('DO $postflight$').length - 1, 1);
    stageText(`mutation-${label}.sql`, candidate.replace('DO $postflight$', `${mutation}\nDO $postflight$`));
    const result = apply(`mutation-${label}.sql`);
    assert.notEqual(result.status, 0, `${label} mutation was accepted`);
    assert.ok(result.output.includes(error), `${label} mutation failed for the wrong reason: ${result.output}`);
    assert.equal(scalar("SELECT to_regclass('public.product_change_history') IS NULL;"), 't');
  }
  console.log('[prover] MUTATIONS: weak policy and table-wide INSERT grant both caught and rolled back');

  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply succeeded');
  assert.match(again.output, /PREFLIGHT_PRODUCT_CHANGE_HISTORY_ALREADY_EXISTS/);

  session(ADMIN, `INSERT INTO public.products(product_name, product_form, signal_word)
    VALUES ('${PRODUCT_NAME}', 'liquid', 'Caution');`);
  const productId = scalar(`SELECT id FROM public.products WHERE product_name = '${PRODUCT_NAME}';`);
  assert.match(productId, /^[0-9a-f-]{36}$/);
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}' AND change_type = 'created' AND field_name IS NULL;`), '1');

  session(ADMIN, `UPDATE public.products SET signal_word = 'Warning' WHERE id = '${productId}';`);
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}'
    AND field_name = 'signal_word' AND old_value = 'Caution' AND new_value = 'Warning'
    AND changed_by = '${ADMIN}' AND changed_by_name = '[PROVER] Product Admin';`), '1');
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}';`), '2');
  console.log('[prover] DIRECT UPDATE: one signal-word row with session actor and name snapshot');

  const forged = psql(`UPDATE public.product_change_history SET changed_by = '${REP}' WHERE product_id = '${productId}';`, { allowFailure: true });
  assert.match(`${forged.stdout}\n${forged.stderr}`, /PRODUCT_CHANGE_HISTORY_IS_APPEND_ONLY/);
  denied('authenticated', ADMIN, `INSERT INTO public.product_change_history(product_id, change_type, changed_by)
    VALUES ('${productId}', 'created', '${REP}');`);
  denied('authenticated', ADMIN, `UPDATE public.product_change_history SET changed_by = '${REP}' WHERE product_id = '${productId}';`);
  denied('authenticated', ADMIN, `DELETE FROM public.product_change_history WHERE product_id = '${productId}';`);
  denied('authenticated', ADMIN, `SELECT public.write_product_change_history();`, /permission denied|trigger functions can only be called as triggers/);
  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public.write_product_change_history()', 'EXECUTE');"), 'f');

  // This existing admin RPC is executable by its owner, with the signed-in caller supplied only
  // through auth.uid(). Its product UPDATE must be observed by the same AFTER trigger.
  psql(`BEGIN;
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
    SELECT public.set_product_phase3_metadata('${productId}', product_family_id, return_policy,
      packaging_variant, is_full_tote_only, product_family_id, 'returnable', packaging_variant,
      is_full_tote_only, 'prover-product-history-phase3')
      FROM public.products WHERE id = '${productId}';
    COMMIT;`);
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}'
    AND field_name = 'return_policy' AND new_value = 'returnable' AND changed_by = '${ADMIN}';`), '1');
  console.log('[prover] RPC: phase-3 metadata change recorded with the session actor');

  psql(`INSERT INTO public.products(product_name, product_form) VALUES ('[PROVER] Bulk Import Product', 'liquid');`);
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history h JOIN public.products p ON p.id = h.product_id
    WHERE p.product_name = '[PROVER] Bulk Import Product' AND h.change_type = 'created' AND h.changed_by IS NULL;`), '1');
  const count = scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}';`);
  session(ADMIN, `UPDATE public.products SET notes = notes WHERE id = '${productId}';`);
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}';`), count);
  psql(`BEGIN;
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    UPDATE public.products SET signal_word = 'Danger' WHERE id = '${productId}';
    ROLLBACK;`);
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}';`), count);
  assert.equal(scalar(`SELECT signal_word FROM public.products WHERE id = '${productId}';`), 'Warning');

  session(ADMIN, `UPDATE public.products SET category = 'Post Emergence' WHERE id = '${productId}';`);
  assert.equal(scalar(`SELECT category FROM public.products WHERE id = '${productId}';`), 'Herbicide');
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}'
    AND field_name = 'category' AND old_value IS NULL AND new_value = 'Herbicide';`), '1');
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}'
    AND new_value = 'Post Emergence';`), '0');

  const countBeforeCost = scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}';`);
  psql(`BEGIN;
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    DO $cost_fixture$
    DECLARE v_change_set_id uuid;
    BEGIN
      INSERT INTO public.pricing_change_sets
        (created_by, source, request_fingerprint, preview_idempotency_key,
         submitted_row_count, row_count, status)
      VALUES ('${ADMIN}', 'product_page', 'product-history-proof',
              'product-history-proof-preview', 1, 1, 'previewed')
      RETURNING id INTO v_change_set_id;
      INSERT INTO public.pricing_change_set_rows
        (change_set_id, product_id, identity_fingerprint, expected_version, pricing_mode,
         input_cost_cents, input_tier1_margin, input_tier2_margin, input_tier3_margin,
         output_cost_cents, output_tier1_margin, output_tier2_margin, output_tier3_margin,
         output_tier1_price_cents, output_tier2_price_cents, output_tier3_price_cents,
         output_fingerprint)
      SELECT v_change_set_id, id, 'product-history-proof', pricing_version, 'margin_driven',
             100, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 'product-history-proof'
        FROM public.products WHERE id = '${productId}';
      PERFORM set_config('crx.pricing_actor', '${ADMIN}', true);
      PERFORM set_config('crx.pricing_change_set_id', v_change_set_id::text, true);
      PERFORM set_config('crx.pricing_source', 'product_page', true);
      PERFORM set_config('crx.pricing_reason', 'product history proof', true);
      PERFORM set_config('crx.pricing_authorized', 'phase1a', true);
    END;
    $cost_fixture$;
    UPDATE public.products SET current_cost = COALESCE(current_cost, 0) + 1 WHERE id = '${productId}';
    COMMIT;`);
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}';`), countBeforeCost);
  assert.equal(scalar(`SELECT count(*) FROM public.product_change_history WHERE field_name IS NOT NULL
    AND field_name <> ALL (ARRAY[${WATCHED.map((field) => `'${field}'`).join(',')}]);`), '0',
  'history contains a field outside the explicit setup allow-list');
  console.log('[prover] TRANSACTIONS: no-op and rollback leave no row; category records final value; cost excluded');

  assert.equal(roleScalar('authenticated', ADMIN, `SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}';`),
    scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}';`));
  assert.equal(roleScalar('authenticated', REP, `SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}';`),
    scalar(`SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}';`));
  assert.equal(roleScalar('authenticated', INACTIVE, `SELECT count(*) FROM public.product_change_history WHERE product_id = '${productId}';`), '0');
  denied('anon', ADMIN, 'SELECT count(*) FROM public.product_change_history;');
  denied('service_role', ADMIN, 'SELECT count(*) FROM public.product_change_history;');

  refusedAsOwner(`UPDATE public.product_change_history SET old_value = 'changed' WHERE product_id = '${productId}';`);
  refusedAsOwner(`DELETE FROM public.product_change_history WHERE product_id = '${productId}';`);
  refusedAsOwner('TRUNCATE public.product_change_history;');
  console.log('[prover] ACCESS: active staff read; inactive and non-staff cannot; all writes refused');
  console.log('PRODUCT_CHANGE_HISTORY_PROOF_PASS');
} finally {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
  else console.log(`[prover] kept container ${NAME}`);
}

