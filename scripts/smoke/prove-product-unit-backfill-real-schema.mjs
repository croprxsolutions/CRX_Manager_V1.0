#!/usr/bin/env node
/**
 * Real-schema proof for 20261104170000_product_unit_backfill (WP-PM-6a).
 *
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container and replays
 * every migration before the candidate. Then it proves:
 *   1. FRESH: on a database without the approved products the file changes nothing.
 *   2. DRIFT: if any approved row no longer holds its approved unit (or its inventory unit moved),
 *      the file refuses and changes nothing.
 *   3. MUTATION: a variant that also moves a per-acre price is refused, so the price check is live.
 *   4. APPLY: the nine rows take their inventory unit as their Unit; every other product column,
 *      every other product, and every other table (order, quote, invoice and job lines included)
 *      is byte-identical; one change-history row per product; re-applying is refused.
 * The fixture uses the approved ids with each live row's units, form and category (read
 * 2026-11-03); names and prices are made up.
 *
 * Run: node scripts/smoke/prove-product-unit-backfill-real-schema.mjs   (needs Docker)
 * Prints PRODUCT_UNIT_BACKFILL_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-unit-backfill-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
let started = false;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261104170000_product_unit_backfill.sql');
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
// A later or parked file that changes what the back-fill touches or relies on.
const TOUCHED = /unit_size|product_price_per_acre|write_product_change_history|recalc_product_price_per_acre/i;
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
  started = true; // only now is the container ours to remove
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

// The nine approved ids with each live row's units, form, category and rate unit (2026-11-03).
// [id, unit_size, inventory_unit, product_form, container_unit, category, rate_unit, use_timings]
const APPROVED = [
  ['0294faa8-ab0b-488e-9efe-868071738625', 'LB', 'Lb', 'dry', 'Lb', 'Herbicide', 'LB', '{}'],
  ['8b9c7b32-3257-4609-9a01-59e9413cd983', '', 'Gal', 'liquid', 'Gal', 'Other', 'oz', '{}'],
  ['47d6e393-a133-425a-8706-8807f1657425', '', 'Gal', 'liquid', 'Gal', 'Herbicide', '', '{}'],
  ['9a1716a2-8ac3-42e6-887b-64795fca3a57', '', 'MG', 'dry', 'MG', 'Foliar Fertilizer', 'MG', '{foliar}'],
  ['4ea8df3a-66cf-4eed-8171-c36e88a00b7d', '', 'Gal', 'liquid', 'Gal', 'Other', 'oz', '{}'],
  ['4983d7c2-45cc-4acd-b915-45e92184c563', '', 'Gal', 'liquid', null, 'Other', 'Gal', '{}'],
  ['0c4d06e2-7cdb-4d75-855a-155199e23b8b', '', 'Gal', 'liquid', 'Gal', 'Herbicide', '', '{}'],
  ['3ba6df61-b644-4f25-97a9-33a9dfda88b5', '', 'Gal', 'liquid', 'Gal', 'Herbicide', 'oz', '{}'],
  ['7ff61807-b0f9-4983-a7a8-3c2d0b2876b2', '', 'Gal', 'liquid', 'Gal', 'Herbicide', 'oz', '{}'],
];
const IDS = APPROVED.map(([id]) => `'${id}'`).join(',');
const [LB, BLANK1, NO_LINES, , BLANK4] = APPROVED.map(([id]) => id);
const BYSTANDER = '7c6a0000-0000-4000-8000-0000000000f1'; // also blank, but not approved
const q = (v) => (v === null ? 'NULL' : `'${v}'`);

function seedProducts() {
  const rows = APPROVED.map(([id, unit, inv, form, container, category, rateUnit, timings], i) => `('${id}', '[PROVER] Unit ${i + 1}',
      ${q(unit)}, ${q(inv)}, ${q(form)}, ${q(container)}, ${q(category)}, ${q(rateUnit)}, '${timings}',
      ${rateUnit ? 1.5 + i : 'NULL'}, ${10 + i}.00, ${12 + i}.00, ${11 + i}.50, NULL, true)`);
  rows.push(`('${BYSTANDER}', '[PROVER] Unapproved blank', '', 'Gal', 'liquid', 'Gal', 'Other', 'oz', '{}', 2, 5.00, 6.00, 5.50, 5.25, true)`);
  psql(`BEGIN;
    -- Live has these exact spellings (read 2026-11-03); the replayed baseline lacks some.
    INSERT INTO public.unit_conversions (unit, unit_type, factor_oz)
      SELECT v.unit, v.unit_type, v.factor_oz FROM (VALUES ('Lb', 'dry', 16::numeric), ('LB', 'dry', 16), ('MG', 'dry', 0.00003527396), ('Gal', 'liquid', 128))
        AS v(unit, unit_type, factor_oz)
       WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions u WHERE u.unit = v.unit);
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, inventory_unit, product_form, container_unit,
        category, rate_unit, use_timings, rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, is_active)
      VALUES ${rows.join(',\n      ')};
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    COMMIT;`);
  // Old billed lines with their own stored units, blanks included, as live has for these ids.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.order_items (order_id, product_id, unit_size, price_per_unit) VALUES
      (gen_random_uuid(), '${BLANK1}', NULL, 12.00), (gen_random_uuid(), '${BLANK4}', '', 14.00),
      (gen_random_uuid(), '${BLANK1}', 'Gal', 12.00);
    INSERT INTO public.quote_items (quote_id, section_id, product_id, unit_size, price_per_unit) VALUES
      (gen_random_uuid(), gen_random_uuid(), '${BLANK1}', 'Gal', 12.00);
    INSERT INTO public.invoice_items (invoice_id, product_id, unit_size, unit_price_cents) VALUES
      (gen_random_uuid(), '${BLANK4}', '', 1400), (gen_random_uuid(), '${BLANK1}', NULL, 1200);
    INSERT INTO public.job_chemicals (job_id, product_id, unit) VALUES (gen_random_uuid(), '${BLANK1}', 'Pt');
    INSERT INTO public.purchase_order_items (purchase_order_id, product_id, unit_size) VALUES (gen_random_uuid(), '${LB}', 'LB');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  assert.equal(scalar(`SELECT count(*) FROM public.products WHERE id IN (${IDS}) AND unit_size IS DISTINCT FROM inventory_unit;`), '9');
  assert.equal(scalar(`SELECT count(*) FROM public.products WHERE id IN (${IDS}) AND tier1_price_per_acre IS NOT NULL;`), '7',
    'the per-acre check needs real per-acre prices to compare');
  console.log('[prover] seeded the nine approved ids (live units, made-up prices), one unapproved blank, and old billed lines');
}

// One hash of every public table except products and its change history, plus every product
// column except unit_size and updated_at, so "nothing else changed" is checked byte for byte.
function fingerprint() {
  return scalar(`DO $fp$ DECLARE t text; h text := ''; x text; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      AND tablename NOT IN ('products', 'product_change_history') ORDER BY 1 LOOP
      EXECUTE format('SELECT COALESCE(md5(string_agg(md5(r::text), '''' ORDER BY md5(r::text))), ''-'') FROM public.%I r', t) INTO x;
      h := md5(h || t || x);
    END LOOP;
    SELECT md5(string_agg(md5((to_jsonb(p) - 'unit_size' - 'updated_at')::text), '' ORDER BY p.id)) INTO x FROM public.products p;
    PERFORM set_config('crx.fp', md5(h || x), false);
  END $fp$; SELECT current_setting('crx.fp');`);
}
const units = () => scalar(`SELECT string_agg(id || '=' || COALESCE(unit_size, '<null>'), ',' ORDER BY id) FROM public.products WHERE id IN (${IDS}, '${BYSTANDER}');`);
const historyRows = () => scalar("SELECT count(*) FROM public.product_change_history WHERE field_name = 'unit_size';");

function refused(label, sql, pattern, before) {
  stageText(`${label}.sql`, sql);
  const r = apply(`${label}.sql`);
  assert.notEqual(r.status, 0, `${label}: the file applied`);
  assert.match(r.output, pattern, `${label} failed for the wrong reason:\n${r.output}`);
  assert.equal(units(), before.units, `${label}: a Unit changed`);
  assert.equal(fingerprint(), before.fp, `${label}: other data changed`);
}

try {
  buildContainer();
  const candidate = lf(CANDIDATE);
  stageText('candidate.sql', candidate);

  // 1. Fresh rebuild: none of the ids exist.
  assert.equal(scalar(`SELECT count(*) FROM public.products WHERE id IN (${IDS});`), '0');
  const fresh = apply('candidate.sql');
  assert.equal(fresh.status, 0, `fresh apply failed:\n${fresh.output}`);
  assert.match(fresh.output, /none of the approved products exist here/);
  assert.equal(historyRows(), '0');
  assert.equal(scalar("SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'trg_keep_product_unit' AND tgrelid = 'public.products'::regclass;"), 'O');
  console.log('[prover] FRESH: no approved products, nothing changed; the guard installs');
  // Back to the pre-candidate schema so the real apply below runs on the same base as live.
  psql('DROP TRIGGER trg_keep_product_unit ON public.products; DROP FUNCTION public.guard_product_unit_matches_inventory_unit();');

  seedProducts();
  const before = { units: units(), fp: fingerprint() };
  const historyBefore = historyRows();

  // 2. Drift: a row fixed by hand, an inventory unit no longer the approved one, or a missing row.
  refused('drift-unit', `UPDATE public.products SET unit_size = 'Gal' WHERE id = '${BLANK1}';\n${candidate}`,
    /PRODUCT_UNIT_BACKFILL_DRIFT: 9 of 9 approved products present, 8 still held/, before);
  refused('drift-inventory', `ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_setup_fields;
    UPDATE public.products SET inventory_unit = 'LB' WHERE id = '${LB}';
    ALTER TABLE public.products ENABLE TRIGGER trg_validate_product_setup_fields;\n${candidate}`,
    /PRODUCT_UNIT_BACKFILL_DRIFT: 9 of 9 approved products present, 8 still held/, before);
  // A missing row: the same file naming an id this database does not have in place of one approved id.
  assert.equal(candidate.split(NO_LINES).length - 1, 1);
  refused('drift-missing', candidate.replace(NO_LINES, '7c6a0000-0000-4000-8000-0000000000ff'),
    /PRODUCT_UNIT_BACKFILL_DRIFT: 8 of 9 approved products present/, before);
  console.log('[prover] DRIFT: a hand-fixed row, a moved inventory unit, or a missing row each refuse with nothing changed');

  // 3. Mutation: the same update that also moves a per-acre price must be refused.
  const set = 'SET unit_size = a.new_unit';
  assert.equal(candidate.split(set).length - 1, 1);
  refused('mutation-price', candidate.replace(set, `${set}, rate_per_acre = p.rate_per_acre + 1`),
    /PRODUCT_UNIT_BACKFILL_OTHER_COLUMN_MOVED: 7 products/, before);
  refused('mutation-other', candidate.replace(set, `${set}, notes = 'moved'`),
    /PRODUCT_UNIT_BACKFILL_OTHER_COLUMN_MOVED: 9 products/, before);
  console.log('[prover] MUTATION: a per-acre price move, or any other column moving, is caught and rolled back');

  // 4. The real apply.
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);
  assert.equal(scalar(`SELECT count(*) FROM public.products WHERE id IN (${IDS}) AND unit_size = inventory_unit;`), '9');
  assert.equal(scalar(`SELECT unit_size FROM public.products WHERE id = '${LB}';`), 'Lb');
  assert.equal(scalar(`SELECT unit_size = '' FROM public.products WHERE id = '${BYSTANDER}';`), 't', 'an unapproved row changed');
  assert.equal(fingerprint(), before.fp, 'something other than the nine Units changed (prices, versions, lines, other tables)');
  assert.equal(Number(historyRows()), Number(historyBefore) + 9);
  assert.equal(scalar(`SELECT string_agg(COALESCE(old_value, '<blank>') || '>' || new_value, ',' ORDER BY new_value, old_value)
    FROM public.product_change_history WHERE field_name = 'unit_size' AND product_id IN (${IDS});`),
  '<blank>>Gal,<blank>>Gal,<blank>>Gal,<blank>>Gal,<blank>>Gal,<blank>>Gal,<blank>>Gal,LB>Lb,<blank>>MG');
  assert.equal(scalar(`SELECT count(*) FROM public.products WHERE id IN (${IDS}) AND updated_at > now() - interval '5 minutes';`), '9');
  console.log('[prover] APPLY: nine Units set; prices, versions, lines and other tables byte-identical; nine history rows');

  // 5. Stale product page: re-sending the old blank (or old spelling) with another edit is refused;
  //    a save that keeps the Unit, and the first fix of an unmatched Unit, still go through.
  const save = (id, unit) => psql(`UPDATE public.products SET unit_size = ${q(unit)}, notes = 'stale page save' WHERE id = '${id}';`, { allowFailure: true });
  for (const [id, old] of [[BLANK1, ''], [LB, 'LB'], [BLANK1, null]]) {
    const r = save(id, old);
    assert.notEqual(r.status, 0, `a stale save wrote ${old} back`);
    assert.match(`${r.stdout}
${r.stderr}`, /PRODUCT_UNIT_STALE/);
  }
  assert.equal(save(BLANK1, 'Gal').status, 0, 'a save keeping the Unit was refused');
  assert.equal(save(BYSTANDER, '').status, 0, 'an unmatched product could not be saved');
  assert.equal(save(BYSTANDER, 'Gal').status, 0, 'an unmatched Unit could not be fixed');
  assert.notEqual(save(BYSTANDER, '').status, 0, 'a fixed Unit could be blanked');
  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public.guard_product_unit_matches_inventory_unit()', 'EXECUTE');"), 'f');
  console.log('[prover] GUARD: stale saves refused; same-Unit saves and first fixes allowed; no API role can call it');

  const after = { units: units(), fp: fingerprint() };
  refused('reapply', candidate, /PRODUCT_UNIT_BACKFILL_DRIFT: 9 of 9 approved products present, 0 still held/, after);
  console.log('[prover] RE-APPLY: refused, nothing changed');
  console.log('PRODUCT_UNIT_BACKFILL_PROOF_PASS');
} finally {
  if (KEEP && started) console.log(`[prover] kept container ${NAME}`);
  else if (started) docker(['rm', '-f', NAME], { allowFailure: true });
}
