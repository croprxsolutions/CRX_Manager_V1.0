#!/usr/bin/env node
/**
 * Real-schema proof for 20261103210000_product_use_timings.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17
 * container and replays ordered post-baseline migrations up to this candidate. It exercises
 * transaction, legacy-row, check, category, role, replay and mutation checks against the real schema.
 *
 * Run: node scripts/smoke/prove-product-use-timings-real-schema.mjs   (needs Docker)
 * Prints PRODUCT_USE_TIMINGS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-product-use-timings-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261103210000_product_use_timings.sql');
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
const TOUCHED = /product_use_timing_options|use_timings|sync_product_use_timings/;
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
    // KI-85's postcondition needs live's active Main Warehouse row, which the empty baseline lacks.
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') psql(`INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse' AND is_active);`);
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
function session(sql, role = 'authenticated') {
  return psql(`BEGIN;
    SET LOCAL ROLE ${role};
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', '${role}')::text, true);
    ${sql}
    COMMIT;`);
}
function roleScalar(role, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;
    SET LOCAL ROLE ${role};
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', '${role}')::text, true);
    ${sql}
    ROLLBACK;` });
  return r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}
function refused(sql, pattern) {
  const r = psql(sql, { allowFailure: true });
  assert.notEqual(r.status, 0, `unexpectedly accepted: ${sql}`);
  assert.match(`${r.stdout}\n${r.stderr}`, pattern);
}
const product = (name) => `(SELECT id FROM public.products WHERE product_name = '${name}')`;

try {
  buildContainer();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'pm5-admin@example.invalid', '{"full_name":"PM5 Admin","role":"admin"}'::jsonb);`);
  psql(`INSERT INTO public.products(product_name, category, use_timing) VALUES
    ('PM5 Post', 'Herbicide', 'Post-Emergence'),
    ('PM5 Soy', 'Herbicide', 'Pre-Emerge Soybean'),
    ('PM5 Corn', 'Herbicide', 'Pre-Emerge Corn'),
    ('PM5 Range', 'Herbicide', 'Range/Pasture/Turf'),
    ('PM5 Volunteer', 'Herbicide', 'Volunteer Corn'),
    ('PM5 Foliar', 'Foliar Fertilizer', 'Foliar'),
    ('PM5 Empty', 'Insecticide', NULL);`);
  const before = scalar("SELECT count(*) FROM public.products WHERE use_timing IS NOT NULL;");
  const historyBefore = scalar("SELECT count(*) FROM public.product_change_history WHERE product_id IN (SELECT id FROM public.products WHERE product_name LIKE 'PM5 %');");
  const versionBefore = scalar("SELECT sum(pricing_version) FROM public.products WHERE product_name LIKE 'PM5 %';");
  stageText('candidate.sql', lf(CANDIDATE));
  stageText('null-category.sql', "INSERT INTO public.products(product_name, category, use_timing) VALUES ('PM5 Null Category', NULL, 'Foliar');\n\\i /tmp/candidate.sql\n");
  const nullCategoryCandidate = apply('null-category.sql');
  assert.notEqual(nullCategoryCandidate.status, 0, 'candidate accepted a timed product with NULL category');
  assert.match(nullCategoryCandidate.output, /PREFLIGHT_PRODUCT_USE_TIMING_UNKNOWN_OR_CATEGORY/);
  assert.equal(scalar("SELECT count(*) FROM public.products WHERE product_name = 'PM5 Null Category';"), '0');
  const candidate = apply('candidate.sql');
  assert.equal(candidate.status, 0, candidate.output);
  console.log(`[prover] BEFORE row triggers: ${scalar("SELECT string_agg(tgname::text, ', ' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.products'::regclass AND NOT tgisinternal AND tgenabled = 'O' AND (tgtype & 3) = 3;")}`);
  ledger(path.basename(CANDIDATE, '.sql'));
  assert.equal(scalar('SELECT count(*) FROM public.products WHERE cardinality(use_timings) > 0;'), before);
  assert.equal(scalar("SELECT sum(pricing_version) FROM public.products WHERE product_name LIKE 'PM5 %';"), versionBefore);
  assert.equal(scalar("SELECT count(*) FROM public.product_change_history WHERE product_id IN (SELECT id FROM public.products WHERE product_name LIKE 'PM5 %');"), historyBefore);
  assert.equal(scalar(`SELECT count(*) FROM public.products p
    WHERE p.product_name LIKE 'PM5 %' AND p.use_timing IS DISTINCT FROM
      (SELECT string_agg(o.label, '; ' ORDER BY o.sort_order, o.code)
       FROM public.product_use_timing_options o WHERE o.code = ANY(p.use_timings));`), '0');
  console.log('[prover] backfill: counts, joined labels, pricing versions and history unchanged');

  psql(`UPDATE public.products SET use_timings = ARRAY['pre_emerge_corn','post_emerge_soybeans'] WHERE id = ${product('PM5 Post')};`);
  assert.equal(scalar(`SELECT use_timing FROM public.products WHERE id = ${product('PM5 Post')};`), 'Pre-Emerge Corn; Post-Emerge Soybeans');
  // The stable option sort order is authoritative even when the input is reversed.
  psql(`UPDATE public.products SET use_timings = ARRAY['post_emerge_soybeans','pre_emerge_corn'] WHERE id = ${product('PM5 Post')};`);
  assert.equal(scalar(`SELECT array_to_string(use_timings, ',') FROM public.products WHERE id = ${product('PM5 Post')};`), 'pre_emerge_corn,post_emerge_soybeans');
  psql(`UPDATE public.products SET use_timing = 'Pre-Emerge; Post-Emergence' WHERE id = ${product('PM5 Corn')};`);
  assert.equal(scalar(`SELECT array_to_string(use_timings, ',') FROM public.products WHERE id = ${product('PM5 Corn')};`), 'pre_emerge,post_emergence');
  refused(`UPDATE public.products SET use_timing = 'Unknown' WHERE id = ${product('PM5 Corn')};`, /Unknown use timing "Unknown"/);
  refused(`UPDATE public.products SET use_timing = 'Pre-Emerge' WHERE id = ${product('PM5 Corn')};`, /several use timings/);
  refused(`UPDATE public.products SET use_timing = 'Pre-Emerge Corn' WHERE id = ${product('PM5 Corn')};`, /several use timings/);
  refused(`UPDATE public.products SET use_timing = 'Pre-Emerge; Pre-Emerge Corn' WHERE id = ${product('PM5 Corn')};`, /several use timings/);
  psql(`UPDATE public.products SET use_timing = 'Pre-Emerge; Post-Emergence; Pre-Emerge Corn' WHERE id = ${product('PM5 Corn')};`);
  assert.equal(scalar(`SELECT array_to_string(use_timings, ',') FROM public.products WHERE id = ${product('PM5 Corn')};`), 'pre_emerge,pre_emerge_corn,post_emergence');
  psql(`UPDATE public.products SET use_timings = ARRAY['pre_emerge','post_emergence'] WHERE id = ${product('PM5 Corn')};`);
  psql("UPDATE public.product_use_timing_options SET is_active = false WHERE code = 'pre_emerge';");
  psql(`UPDATE public.products SET notes = 'unrelated edit' WHERE id = ${product('PM5 Corn')};`);
  psql("UPDATE public.product_use_timing_options SET is_active = true WHERE code = 'pre_emerge';");
  psql(`UPDATE public.products SET use_timing = 'Pre-Emerge' WHERE id = ${product('PM5 Soy')};`);
  assert.equal(scalar(`SELECT use_timings[1] FROM public.products WHERE id = ${product('PM5 Soy')};`), 'pre_emerge');
  refused(`UPDATE public.products SET use_timings = ARRAY['foliar'] WHERE id = ${product('PM5 Post')};`, /unavailable for category/);
  refused(`UPDATE public.products SET category = 'Insecticide' WHERE id = ${product('PM5 Post')};`, /Clear the timings/);
  psql(`UPDATE public.products SET category = 'Insecticide', use_timings = '{}' WHERE id = ${product('PM5 Post')};`);
  assert.equal(scalar(`SELECT category || ':' || COALESCE(use_timing, 'NULL') FROM public.products WHERE id = ${product('PM5 Post')};`), 'Insecticide:NULL');
  psql("INSERT INTO public.products(product_name, category) VALUES ('PM5 Alias', 'Post Emergence');");
  assert.equal(scalar(`SELECT category || ':' || use_timings[1] FROM public.products WHERE id = ${product('PM5 Alias')};`), 'Herbicide:post_emergence');
  refused("INSERT INTO public.products(product_name, category, use_timings, use_timing) VALUES ('PM5 Conflicting Insert', 'Herbicide', ARRAY['pre_emerge'], 'Foliar');", /changed two ways at once/);
  refused(`UPDATE public.products SET use_timings = ARRAY['pre_emerge_corn'], use_timing = 'Foliar' WHERE id = ${product('PM5 Soy')};`, /changed two ways at once/);
  console.log('[prover] app, legacy, category, alias and conflict paths passed');

  assert.equal(roleScalar('authenticated', 'SELECT count(*) FROM public.product_use_timing_options;'), '9');
  refused('SET ROLE anon; SELECT count(*) FROM public.product_use_timing_options;', /permission denied/);
  refused('SET ROLE service_role; SELECT count(*) FROM public.product_use_timing_options;', /permission denied/);
  refused("SET ROLE authenticated; INSERT INTO public.product_use_timing_options(code,label,timing_code,category,sort_order) VALUES ('bad','Bad','bad','Herbicide',999);", /permission denied/);
  for (const role of ['anon', 'authenticated', 'service_role', 'metabase_ro']) {
    for (const privilege of ['SELECT', 'REFERENCES', 'INSERT', 'UPDATE']) {
      assert.equal(scalar(`SELECT has_column_privilege('${role}','public.products','use_timings','${privilege}') =
        has_column_privilege('${role}','public.products','use_timing','${privilege}');`), 't', `${role} ${privilege} differs`);
    }
  }
  console.log('[prover] roles, options RLS and mirrored column grants passed');

  // The workbook apply updates every pricing column even for an info-only change.
  // Give this fixture a real governed cost and prices first, as the Phase 2 smoke does.
  session(`DO $price_setup$
    DECLARE v_id uuid := ${product('PM5 Corn')}; v_version integer; v_preview jsonb;
    BEGIN
      SELECT pricing_version INTO v_version FROM public.products WHERE id = v_id;
      v_preview := public.preview_product_cost_basis_changes('product_page', NULL,
        jsonb_build_array(jsonb_build_object(
          'product_id', v_id, 'row_version', v_version, 'pricing_mode', 'price_driven',
          'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '11.00', 'tier3_price', '12.00',
          'change_reason', 'PM5 fixture price', 'price_source', 'PM5 local fixture',
          'basis_type', 'manual_override', 'basis_source', 'product_page',
          'basis_reason', 'PM5 fixture price', 'basis_selection', false)),
        '${ADMIN}', 'pm5-price-setup-preview');
      IF v_preview->>'status' <> 'previewed' THEN
        RAISE EXCEPTION 'PM5_PRICE_SETUP_PREVIEW_FAILED: %', v_preview;
      END IF;
      PERFORM public.approve_pricing_change_set((v_preview->>'change_set_id')::uuid,
        v_preview->>'request_fingerprint',
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'product_id', w->>'product_id', 'warning_codes', w->'warning_codes',
          'reason', 'PM5 local fixture'))
          FROM jsonb_array_elements(v_preview->'warnings') AS w), '[]'::jsonb),
        NULL, '${ADMIN}', 'pm5-price-setup-approve');
      PERFORM public.apply_product_cost_basis_change_set((v_preview->>'change_set_id')::uuid,
        v_preview->>'request_fingerprint', '${ADMIN}', 'pm5-price-setup-apply');
    END $price_setup$;`);

  // The Phase 2 public wrapper calls the real apply_product_pricing_change_set internally;
  // direct calls are deliberately blocked by PRODUCT_COST_BASIS_CONTEXT_REQUIRED.
  const workbookSql = (suffix, timing, note) => `DO $workbook$
    DECLARE v_export jsonb; v_row jsonb; v_preview jsonb; v_id uuid := ${product('PM5 Corn')};
    BEGIN
      v_export := public.create_pricing_workbook_export(ARRAY[v_id], '${ADMIN}', 'pm5-export-${suffix}');
      v_row := v_export->'rows'->0 || jsonb_build_object(
        'pricing_mode', '', 'new_cost', v_export->'rows'->0->>'current_cost',
        'tier1_margin_percent', v_export->'rows'->0->>'current_tier1_margin_percent',
        'tier1_price', v_export->'rows'->0->>'current_tier1_price',
        'tier2_margin_percent', v_export->'rows'->0->>'current_tier2_margin_percent',
        'tier2_price', v_export->'rows'->0->>'current_tier2_price',
        'tier3_margin_percent', v_export->'rows'->0->>'current_tier3_margin_percent',
        'tier3_price', v_export->'rows'->0->>'current_tier3_price',
        'change_reason', 'PM5 workbook timing proof', 'quoting_notes', '${note}',
        'use_timing', '${timing}', 'has_formula', false, 'formula_cells', '[]'::jsonb);
      v_preview := public.preview_product_cost_basis_changes('pricing_worksheet',
        (v_export->>'export_id')::uuid, jsonb_build_array(v_row), '${ADMIN}', 'pm5-preview-${suffix}');
      IF v_preview->>'status' <> 'previewed' THEN
        RAISE EXCEPTION 'PM5_WORKBOOK_PREVIEW_FAILED: %', v_preview;
      END IF;
      PERFORM public.approve_pricing_change_set((v_preview->>'change_set_id')::uuid,
        v_preview->>'request_fingerprint',
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'product_id', w->>'product_id', 'warning_codes', w->'warning_codes',
          'reason', 'PM5 local workbook proof'))
          FROM jsonb_array_elements(v_preview->'warnings') AS w), '[]'::jsonb),
        jsonb_build_object('name', 'PM5 local workbook.xlsx', 'sha256', repeat('0', 64)),
        '${ADMIN}', 'pm5-approve-${suffix}');
      PERFORM public.apply_product_cost_basis_change_set((v_preview->>'change_set_id')::uuid,
        v_preview->>'request_fingerprint', '${ADMIN}', 'pm5-apply-${suffix}');
    END $workbook$;`;
  const workbook = (suffix, timing, note) => session(workbookSql(suffix, timing, note));
  const pricingSnapshot = () => scalar(`SELECT row_to_json(x)::text FROM (
    SELECT trim_scale(current_cost)::text AS current_cost, cost_updated_date,
      trim_scale(tier1_price)::text AS tier1_price,
      trim_scale(tier2_price)::text AS tier2_price,
      trim_scale(tier3_price)::text AS tier3_price,
      trim_scale(tier1_margin)::text AS tier1_margin,
      trim_scale(tier2_margin)::text AS tier2_margin,
      trim_scale(tier3_margin)::text AS tier3_margin,
      trim_scale(tier1_gross_margin)::text AS tier1_gross_margin,
      trim_scale(tier2_gross_margin)::text AS tier2_gross_margin,
      trim_scale(tier3_gross_margin)::text AS tier3_gross_margin,
      trim_scale(tier1_price_per_acre)::text AS tier1_price_per_acre,
      trim_scale(tier2_price_per_acre)::text AS tier2_price_per_acre,
      trim_scale(tier3_price_per_acre)::text AS tier3_price_per_acre
    FROM public.products WHERE id = ${product('PM5 Corn')}) x;`);
  const pricesBefore = pricingSnapshot();
  const versionBeforeWorkbook = scalar(`SELECT pricing_version FROM public.products WHERE id = ${product('PM5 Corn')};`);
  workbook('unchanged', 'Pre-Emerge; Post-Emergence', 'PM5 workbook unchanged timing');
  assert.equal(scalar(`SELECT array_to_string(use_timings, ',') FROM public.products WHERE id = ${product('PM5 Corn')};`), 'pre_emerge,post_emergence');
  assert.equal(pricingSnapshot(), pricesBefore);
  const versionAfterWorkbook = scalar(`SELECT pricing_version FROM public.products WHERE id = ${product('PM5 Corn')};`);
  console.log(`[prover] unchanged workbook cell: pricing_version ${versionBeforeWorkbook} -> ${versionAfterWorkbook}; exact price/cost values unchanged`);
  workbook('remove', 'Pre-Emerge', 'PM5 workbook removed timing');
  assert.equal(scalar(`SELECT array_to_string(use_timings, ',') FROM public.products WHERE id = ${product('PM5 Corn')};`), 'pre_emerge');
  assert.equal(pricingSnapshot(), pricesBefore);
  workbook('restore', 'Pre-Emerge; Post-Emergence', 'PM5 workbook restored timing');
  assert.equal(scalar(`SELECT array_to_string(use_timings, ',') FROM public.products WHERE id = ${product('PM5 Corn')};`), 'pre_emerge,post_emergence');
  assert.equal(pricingSnapshot(), pricesBefore);
  const timingBeforeUnknown = scalar(`SELECT use_timing FROM public.products WHERE id = ${product('PM5 Corn')};`);
  const versionBeforeUnknown = scalar(`SELECT pricing_version FROM public.products WHERE id = ${product('PM5 Corn')};`);
  refused(`BEGIN; SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', 'authenticated')::text, true);
    ${workbookSql('unknown', 'Misspelled Timing', 'PM5 workbook unknown timing')}
    COMMIT;`, /Unknown use timing "Misspelled Timing"/);
  assert.equal(scalar(`SELECT use_timing FROM public.products WHERE id = ${product('PM5 Corn')};`), timingBeforeUnknown);
  assert.equal(scalar(`SELECT pricing_version FROM public.products WHERE id = ${product('PM5 Corn')};`), versionBeforeUnknown);
  assert.equal(pricingSnapshot(), pricesBefore);
  workbook('third', 'Pre-Emerge; Pre-Emerge Corn; Post-Emergence', 'PM5 workbook added timing');
  assert.equal(scalar(`SELECT array_to_string(use_timings, ',') FROM public.products WHERE id = ${product('PM5 Corn')};`), 'pre_emerge,pre_emerge_corn,post_emergence');
  assert.equal(pricingSnapshot(), pricesBefore);
  console.log('[prover] real workbook export, preview and guarded apply preserved prices and multiple timings');
  console.log('PRODUCT_USE_TIMINGS_PROOF_PASS');
} finally {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
  else console.log(`[prover] kept container ${NAME}`);
}

