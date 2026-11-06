#!/usr/bin/env node
/**
 * Real-schema proof for PAR-2 (20261123120000): grouping existing products into parents. Builds the checked-in
 * schema baseline in a network-disabled PostgreSQL container, replays every migration before the candidate
 * (PAR-1 and its stock-unit follow-up included), seeds invented rows that copy the real shapes, installs the
 * candidate and checks the build sheet's §5.4 cases as named cases (each prints "[case] ..."). Ends by running
 * the migration header's rollback block and proving the old brand route works again.
 *
 * Run: node scripts/smoke/prove-product-parent-proposals-real-schema.mjs   (needs local Docker image)
 * Prints PRODUCT_PARENT_PROPOSALS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-par2-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261123120000_product_parent_proposals.sql');
const ORIGINAL_BRANDS = path.join(MIGRATIONS, '20261022086500_product_brands.sql');
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

const id = (n) => `7a7e2000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
const EXISTING = id('c1');
const OLD = id('c2');
const [L1, L2, LH, SF, SU] = [id('11'), id('12'), id('13'), id('14'), id('15')];
const [R1, R2, R3, R4] = [id('21'), id('22'), id('23'), id('24')];
const [M1, M2, A1, A2] = [id('31'), id('32'), id('33'), id('34')];
const [S1, S2, N1, N2, N3] = [id('41'), id('42'), id('51'), id('52'), id('53')];
const [D1, D2, Y1, Y2, X1, X2, Q1, F1] = [id('61'), id('62'), id('71'), id('72'), id('81'), id('82'), id('91'), id('92')];
const [BA1, BA2, BB1, BB2, BR1, BS1, BS2, BN1] = [id('b1'), id('b2'), id('b3'), id('b4'), id('b5'), id('b6'), id('b7'), id('b8')];

function asOwner(sql) { psql(`SET session_replication_role = replica;
${sql}
SET session_replication_role = origin;`, { user: 'supabase_admin' }); }
// Invented rows that copy the real shapes (no live row is read). Products go in with their triggers on, so
// per-acre prices and the timing text are what the app would store.
function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'pp2-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'pp2-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  asOwner(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Gal', 128, 'liquid'), ('oz', 1, 'liquid'), ('Pt', 16, 'liquid'), ('Lb', 16, 'dry');
    INSERT INTO public.product_form_units (product_form, unit) VALUES ('seed', 'Lb'), ('seed', 'Unit');`);
  // Rows go in as pricing-free shells; prices then go on through the governed-path flag, as live requires.
  const prices = [];
  const p = (pid, name, sku, cat, epa, form, unit, active, t1, rate, rateUnit, timings) => (prices.push(`('${pid}'::uuid, ${t1})`),
    `('${pid}', ${lit(name)}, '${sku}', ${lit(cat)}, ${lit(epa)}, ${lit(form)}, ${lit(unit)}, ${active}, NULL, ${rate ?? 'NULL'}, ${lit(rateUnit)}, '${timings}')`);
  psql(`INSERT INTO public.products (id, product_name, sku, category, epa_registration, product_form, inventory_unit, is_active, tier1_price, rate_per_acre, rate_unit, use_timings) VALUES
    ${[
    p(EXISTING, '[PROVER] Existing Herb', 'EX-1', 'Herbicide', '524-475', 'liquid', 'Gal', true, 40, null, null, '{}'),
    p(OLD, '[PROVER] Old Thing', 'EX-2', 'Herbicide', null, 'liquid', 'Gal', false, 10, null, null, '{}'),
    p(L1, '[PROVER] Gen Liberty 2.5 gal', 'GL-25', 'Herbicide', '264-829', 'liquid', 'Gal', true, 100, 32, 'oz', '{post_emergence}'),
    p(L2, '[PROVER] Gen Liberty 30 gal', 'GL-30', 'Herbicide', '264-829', 'liquid', 'Gal', false, 95, 32, 'oz', '{post_emergence}'),
    p(LH, '[PROVER] Gen Liberty: Higher Quality 2.5 gal', 'GLH-25', 'Herbicide', '264-829', 'liquid', 'Gal', true, 110, 32, 'oz', '{post_emergence}'),
    p(SF, '[PROVER] Corn Mix Safened 2.5 gal', 'CMS-25', 'Herbicide', null, 'liquid', 'Gal', true, 50, null, null, '{}'),
    p(SU, '[PROVER] Corn Mix 2.5 gal', 'CM-25', 'Herbicide', null, 'liquid', 'Gal', true, 45, null, null, '{}'),
    p(R1, '[PROVER] Rho 2.5 gal', 'RH-25', 'Herbicide', '500-5', 'liquid', 'Gal', true, 100, 32, 'oz', '{pre_emerge}'),
    p(R2, '[PROVER] Rho 30 gal', 'RH-30', 'Herbicide', '500-5', 'liquid', 'Gal', true, 90, 24, 'oz', '{post_emergence}'),
    p(R3, '[PROVER] Rho Bulk', 'RH-BULK', 'Herbicide', '500-5', 'liquid', 'Gal', true, 80, 32, 'oz', '{pre_emerge}'),
    p(R4, '[PROVER] Rho Tote', 'RH-TOTE', 'Herbicide', '500-5', 'liquid', 'Gal', true, 85, 32, 'oz', '{pre_emerge}'),
    p(M1, '[PROVER] Mixy 2.5 gal', 'MI-25', 'Herbicide', '600-6', 'liquid', 'Gal', true, 10, null, null, '{}'),
    p(M2, '[PROVER] Mixy 30 gal', 'MI-30', 'Herbicide', null, 'liquid', 'Gal', true, 10, null, null, '{}'),
    p(A1, '[PROVER] Atra 4L 2.5 gal', 'AT4-25', 'Herbicide', '700-1', 'liquid', 'Gal', true, 10, null, null, '{}'),
    p(A2, '[PROVER] Atra 2.5 gal', 'AT-25', 'Herbicide', '700-1', 'liquid', 'Gal', true, 10, null, null, '{}'),
    p(S1, '[PROVER] Spreader 1 gal', 'SP-1', 'Other', null, 'liquid', 'Gal', true, 20, null, null, '{}'),
    p(S2, '[PROVER] Spreader 2.5 gal', 'SP-25', 'Other', null, 'liquid', 'Gal', true, 18, null, null, '{}'),
    p(N1, '[PROVER] Nitro 2.5 gal', 'NI-25', 'Liquid Fertilizer', null, 'liquid', 'Gal', true, 5, null, null, '{}'),
    p(N2, '[PROVER] Nitro Bulk', 'NI-BULK', 'Liquid Fertilizer', null, 'liquid', 'Gal', true, 4, null, null, '{}'),
    p(N3, '[PROVER] Nitro Tote', 'NI-TOTE', 'Liquid Fertilizer', null, 'liquid', 'Gal', true, 4, null, null, '{}'),
    p(D1, '[PROVER] Duo Bulk 30 gal', 'DU-30', 'Herbicide', '800-8', 'liquid', 'Gal', true, 10, null, null, '{}'),
    p(D2, '[PROVER] Duo Bulk', 'DU-BULK', 'Herbicide', '800-8', 'liquid', 'Gal', true, 9, null, null, '{}'),
    p(Y1, '[PROVER] Soy 50 lb', 'SO-50', 'Seed', null, 'seed', 'Lb', true, 2, null, null, '{}'),
    p(Y2, '[PROVER] Soy', 'SO-U', 'Seed', null, 'seed', 'Unit', true, 300, null, null, '{}'),
    p(X1, '[PROVER] Xeno 1 gal', 'XE-1', 'Herbicide', '900-1', 'liquid', 'Gal', true, 10, null, null, '{}'),
    p(X2, '[PROVER] Xylo 1 gal', 'XY-1', 'Herbicide', '900-2', 'liquid', 'Gal', true, 10, null, null, '{}'),
    p(Q1, '2.5 gal', 'Q-25', 'Herbicide', null, 'liquid', 'Gal', true, 10, null, null, '{}'),
    p(F1, '[PROVER] Formless 1 gal', 'FO-1', 'Herbicide', null, null, 'Gal', true, 10, null, null, '{}'),
  ].join(',\n    ')};
    INSERT INTO public.product_brands (id, product_id, brand_name, epa_registration, manufacturer, is_currently_sourced, is_rup, signal_word, created_by, updated_by) VALUES
    ('${BA1}', '${L1}', 'Brandy A', '264-829', 'Maker One', true, false, 'Caution', '${ADMIN}', '${ADMIN}'),
    ('${BA2}', '${L2}', 'Brandy A', '264-829', 'Maker One', true, false, 'Caution', '${ADMIN}', '${ADMIN}'),
    ('${BB1}', '${L1}', 'Brandy B', NULL, 'Maker Two', false, NULL, NULL, '${ADMIN}', '${ADMIN}'),
    ('${BB2}', '${L2}', 'Brandy B', NULL, 'Maker Two', false, NULL, NULL, '${ADMIN}', '${ADMIN}'),
    ('${BR1}', '${R1}', 'Rhoda', '500-5', 'Maker Three', true, false, 'Warning', '${ADMIN}', '${ADMIN}'),
    ('${BS1}', '${S1}', 'Spready', '700-7', 'Maker Four', true, false, NULL, '${ADMIN}', '${ADMIN}'),
    ('${BS2}', '${S2}', 'Spready', '700-8', 'Maker Four', true, false, NULL, '${ADMIN}', '${ADMIN}'),
    ('${BN1}', '${N1}', 'Nitrogen Co', NULL, 'Maker Five', true, NULL, NULL, '${ADMIN}', '${ADMIN}');`);
  // Starting prices skip only the two worksheet guards (the per-acre trigger still runs), then the guards come back.
  psql(`ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing, DISABLE TRIGGER trigger_z_guard_version_product_pricing;
    UPDATE public.products pr SET tier1_price = v.t FROM (VALUES ${prices.join(', ')}) v(id, t) WHERE pr.id = v.id;
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing, ENABLE TRIGGER trigger_z_guard_version_product_pricing;`, { user: 'supabase_admin' });
  console.log('[prover] seeded an admin, a sales rep, 28 invented products and 8 invented brand rows');
}
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
const raw = (v) => String(v && typeof v === 'object' && 'rawJSON' in v ? v.rawJSON : v);
const call = (uid, sql) => JSON.parse(ok(uid, sql), exactPrices);
const ownerRefused = (sql, pattern) => {
  const r = psql(sql, { allowFailure: true }); assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`); assert.match(`${r.stdout}\n${r.stderr}`, pattern);
};
const prod = (pid, cols) => scalar(`SELECT concat_ws('|', ${cols}) FROM public.products WHERE id = '${pid}';`);
const TIERS = ['tier1_price_per_acre', 'tier2_price_per_acre', 'tier3_price_per_acre'];
const PRODUCTS_MD5 = "SELECT md5(string_agg(to_jsonb(p)::text, '|' ORDER BY id)) FROM public.products p;";
const BRANDS_MD5 = "SELECT md5(string_agg(to_jsonb(b)::text, '|' ORDER BY id)) FROM public.product_brands b;";
// Label facts and identity: approval never writes any of these.
const LABEL_COLS = 'product_name, sku, epa_registration, manufacturer, is_rup, signal_word, rei_hours, phi_days, max_label_rate, max_label_rate_unit, tier1_price, tier2_price, tier3_price, container_size, inventory_unit, product_form, is_active';
const labelMd5 = () => scalar(`SELECT md5(string_agg(concat_ws('|', id, ${LABEL_COLS})::text, '#' ORDER BY id)) FROM public.products;`);
const perAcre = () => Object.fromEntries(scalar(`SELECT string_agg(id || '=' || concat_ws('|', ${TIERS.join(', ')}), ',' ORDER BY id) FROM public.products;`).split(',').map((x) => x.split('=')));

const build = (key, uid = ADMIN) => call(uid, `SELECT public.build_product_parent_proposal('${key}');`);
const groups = (proposalId) => JSON.parse(scalar(`SELECT jsonb_agg(to_jsonb(g) ORDER BY g.suggested_name) FROM public.product_parent_proposal_groups g WHERE proposal_id = '${proposalId}';`));
const groupOf = (gs, pid) => { const g = gs.find((x) => x.members.some((m) => m.product_id === pid)); assert.ok(g, `no group holds ${pid}`); return g; };
const ids = (g) => g.members.map((m) => m.product_id).sort();
const approve = (P, entries, key) => `SELECT public.approve_product_parent_groups('${P.proposal_id}', ${P.proposal_version}, ${J(entries)}, '${key}');`;
const entry = (g, extra = {}) => ({ group_id: g.id, group_fingerprint: g.group_fingerprint, name: g.suggested_name, ...extra });
const decide = (fn, g, version, reason, key) => `SELECT public.${fn}_product_parent_group('${g.id}', ${version}, '${g.group_fingerprint}', ${lit(reason)}, '${key}');`;
const brandUpsert = (pid, name, epa, brandId, version, key, maker = 'Maker One') =>
  `SELECT public.upsert_product_brand('${pid}', ${lit(name)}, ${lit(epa)}, ${lit(maker)}, true, false, 'Caution', ${brandId ? `'${brandId}'` : 'NULL'}, ${version ?? 'NULL'}, '${key}');`;
const parentBrand = (parent, name, opts, key) => `SELECT public.upsert_parent_brand('${parent}', ${lit(name)}, ${lit(opts.epa ?? null)}, 'Maker One', true, false, NULL,
  ${opts.id ? `'${opts.id}'` : 'NULL'}, ${opts.version ?? 'NULL'}, ${opts.retire ? 'true' : 'false'}, ${lit(opts.reason ?? null)}, '${key}');`;
const parentOf = (pid) => scalar(`SELECT parent_id FROM public.product_parent_members WHERE product_id = '${pid}';`);
const memberCount = () => Number(scalar('SELECT count(*) FROM public.product_parent_members;'));
// The rollback block exactly as the migration header holds it.
function rollbackSql() {
  const text = lf(CANDIDATE);
  const head = '-- ROLLBACK-SQL-BEGIN\n';
  const block = text.slice(text.indexOf(head) + head.length, text.indexOf('-- ROLLBACK-SQL-END'));
  return block.split('\n').filter(Boolean).map((l) => { assert.ok(l.startsWith('--'), l); return l.replace(/^-- ?/, ''); }).join('\n');
}
function originalBrandWriter() {
  const text = lf(ORIGINAL_BRANDS);
  const start = text.indexOf('CREATE OR REPLACE FUNCTION public.upsert_product_brand(');
  const grant = 'GRANT EXECUTE ON FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text) TO authenticated;';
  assert.ok(start >= 0 && text.indexOf(grant) > start, 'the original brand writer moved');
  return text.slice(start, text.indexOf(grant) + grant.length);
}
// A brand edit held open in another session (it sleeps after writing, before commit).
function background(uid, sql) {
  const tx = `BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true); SET LOCAL ROLE authenticated; ${sql} SELECT pg_sleep(4); COMMIT;`;
  const child = spawn('docker', [...psqlArgs(), '-A', '-t', '-c', tx], { cwd: ROOT });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, output: out })));
}

async function main() {
  buildContainer();
  seed();
  assert.equal(scalar("SELECT count(*) FROM public.product_categories WHERE name IN ('Herbicide', 'Other', 'Liquid Fertilizer', 'Seed') AND is_active;"), '4', 'test categories missing');
  assert.notEqual(prod(R1, 'tier1_price_per_acre'), '', 'per-acre prices must be computed for the price checks to mean anything');
  // A parent that already exists (PAR-1's New product): its size is never proposed; its name is taken.
  const already = call(ADMIN, `SELECT public.create_product_with_parent(${J({ name: '[PROVER] Gen Liberty', product_form: 'liquid', generic_epa_registration: '264-829', category: 'Herbicide', use_timings: ['post_emergence'] })},
    ${J({ product_name: '[PROVER] Gen Liberty 1 gal', sku: 'GL-1', inventory_unit: 'Gal' })}, 'k-already');`);

  // [case] install
  const productsBefore = scalar(PRODUCTS_MD5);
  const brandsBefore = scalar(BRANDS_MD5);
  stageText('cand.sql', lf(CANDIDATE));
  const installed = apply('cand.sql');
  assert.equal(installed.status, 0, installed.output);
  ledger(path.basename(CANDIDATE, '.sql'));
  assert.equal(scalar(PRODUCTS_MD5), productsBefore, 'install changed a product');
  assert.equal(scalar(BRANDS_MD5), brandsBefore, 'install changed a brand row');
  assert.equal(scalar('SELECT count(*) FROM public.product_parent_proposals;'), '0');
  const again = apply('cand.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /PREFLIGHT_PRODUCT_PARENT_PROPOSALS_ALREADY_EXIST/);
  console.log('[case] install: preflight and postflight pass; no product or brand row changes; a second run is refused');

  // [case] base-name rule
  const BASES = [
    ['[PROVER] Gen Liberty 2.5 gal', '[PROVER] Gen Liberty'], ['Rho 2 x 2.5 gal', 'Rho'], ['Rho 4/1 gal', 'Rho'],
    ['Atra 4L 2.5 gal', 'Atra 4L'], ['Ester 6% 30 gal', 'Ester 6%'], ['Rho (2.5 gal)', 'Rho'], ['Soy 50 lb bag', 'Soy'],
    ['Rho Bulk', 'Rho'], ['Rho Tote', 'Rho'], ['Rho 12 ct case', 'Rho'], ['#2 Mix 2.5gal', '#2 Mix'],
    ['Corn Mix Safened 2.5 gal', 'Corn Mix Safened'], ['Gen Liberty: Higher Quality 2.5 gal', 'Gen Liberty: Higher Quality'],
    ['2.5 gal', ''], ['Mix 1 Pt', 'Mix'], ['Mix 32 fl oz', 'Mix'], ['Mix 1.5 Qts.', 'Mix'], ['Galaxy 2.5 gal', 'Galaxy'],
    ['Atra 4G 2.5 gal', 'Atra 4G'], ['Atra 4g', 'Atra 4g'], ['Seed Mix 500 g', 'Seed Mix'],
  ];
  for (const [input, want] of BASES) assert.equal(scalar(`SELECT '>' || public._product_parent_base_name(${lit(input)}) || '<';`), `>${want}<`, `base name of ${input}`);
  assert.equal(scalar("SELECT public._product_parent_loose_key('[PROVER] Atra 4L') = public._product_parent_loose_key('[PROVER] Atra');"), 't');
  assert.equal(scalar("SELECT public._product_parent_loose_key('[PROVER] Atra 4G') = public._product_parent_loose_key('[PROVER] Atra');"), 't');
  console.log(`[case] base-name rule: ${BASES.length} names; sizes, packs and containers removed, strength and quality words kept`);

  // [case] access
  refused(REP, "SELECT public.build_product_parent_proposal('k-rep');", /ADMIN_REQUIRED/);
  refused(null, "SELECT public.build_product_parent_proposal('k-anon');", /permission denied/);
  refused(ADMIN, 'SELECT public.build_product_parent_proposal();', /IDEMPOTENCY_KEY_REQUIRED/);
  refused(REP, `SELECT public.upsert_parent_brand('${already.parent_id}', 'X', NULL, NULL, true, NULL, NULL, NULL, NULL, false, NULL, 'k-rep-b');`, /ADMIN_REQUIRED/);
  refused(ADMIN, `INSERT INTO public.product_parent_proposals (proposal_version, built_by) VALUES (1, '${ADMIN}');`, /permission denied/);
  refused(ADMIN, `INSERT INTO public.product_parent_brands (parent_id, brand_name, created_by, updated_by) VALUES ('${already.parent_id}', 'X', '${ADMIN}', '${ADMIN}');`, /permission denied/);
  refused(ADMIN, 'DELETE FROM public.product_parent_brand_sources;', /permission denied/);
  refused(null, 'SELECT count(*) FROM public.product_parent_brands;', /permission denied/);
  refused(null, `SELECT public.get_product_brands('${L1}');`, /permission denied/);
  for (const helper of ['_product_parent_group_shape(ARRAY[]::uuid[])', "_product_parent_base_name('x')", `_close_product_parent_proposal_if_done('${L1}')`]) {
    refused(ADMIN, `SELECT public.${helper};`, /permission denied/);
  }
  console.log('[case] access: writers are admin-only with a retry key; tables have no write grant; visitors see nothing; helpers are private');

  // [case] switch off (as shipped): approval and parent-brand edits refuse; a PAR-1 grouped size keeps its own
  // brand list, read and written as before (made and read in one transaction that is then rolled back).
  assert.equal(scalar('SELECT public._product_parent_grouping_open();'), 'f');
  refused(ADMIN, approve({ proposal_id: id('ee'), proposal_version: 1 }, [], 'k-closed-a'), /PRODUCT_PARENT_GROUPING_NOT_OPEN/);
  refused(ADMIN, parentBrand(already.parent_id, 'Closed Brand', {}, 'k-closed-b'), /PRODUCT_PARENT_GROUPING_NOT_OPEN/);
  const closedSize = as(ADMIN, `${brandUpsert(already.product_id, 'Closed Size Brand', null, null, null, 'k-closed-c')}
SELECT public.get_product_brands('${already.product_id}');
DO $x$ BEGIN RAISE EXCEPTION 'PROVER_ROLLBACK'; END $x$;`);
  assert.match(closedSize.output, /PROVER_ROLLBACK/);
  assert.match(closedSize.output, /"brands": \[\{[^\n]*Closed Size Brand[^\n]*"source": "product"/);
  assert.equal(scalar(`SELECT count(*) FROM public.product_brands WHERE product_id = '${already.product_id}';`), '0');
  const setSwitch = (on) => psql(`CREATE OR REPLACE FUNCTION public._product_parent_grouping_open() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $f$ SELECT ${on}; $f$;`);
  setSwitch(true);
  assert.equal(scalar('SELECT public._product_parent_grouping_open();'), 't');
  console.log('[case] switch off: approval and parent-brand edits refuse PRODUCT_PARENT_GROUPING_NOT_OPEN; a PAR-1 grouped size keeps its own brand list; the rest of this proof runs with it on');

  // [case] build
  const membersBefore = memberCount();
  const labelBefore = labelMd5();
  const acreBefore = perAcre();
  const P1 = build('k-build-1');
  assert.deepEqual(build('k-build-1'), P1, 'a retry returns the first receipt');
  assert.equal(P1.proposal_version, 1);
  assert.equal(memberCount(), membersBefore, 'building a proposal grouped something');
  assert.equal(scalar(PRODUCTS_MD5), productsBefore, 'building a proposal changed a product');
  let G = groups(P1.proposal_id);
  assert.equal(G.length, P1.group_count);
  assert.ok(!G.some((g) => g.members.some((m) => m.product_id === already.product_id)), 'an already-grouped size was proposed');
  const gl = groupOf(G, L1);
  assert.deepEqual(ids(gl), [L1, L2].sort());
  assert.equal(gl.suggested_name, '[PROVER] Gen Liberty (EPA 264-829)', 'a taken parent name gets the EPA number');
  // Both suffixed names taken too: the build numbers the name until it is free (made and read, then rolled back).
  const mk = (name, n) => `SELECT public.create_product_with_parent(${J({ name, product_form: 'liquid', generic_epa_registration: '264-829', category: 'Herbicide', use_timings: ['post_emergence'] })},
    ${J({ product_name: `${name} 1 gal`, sku: `GL-N${n}`, inventory_unit: 'Gal' })}, 'k-name-${n}');`;
  const numbered = as(ADMIN, `${mk('[PROVER] Gen Liberty (EPA 264-829)', 1)}
${mk('[PROVER] Gen Liberty (EPA 264-829) (liquid)', 2)}
SELECT public.build_product_parent_proposal('k-name-build') IS NOT NULL AS built;
SELECT 'NAME=' || g.suggested_name FROM public.product_parent_proposal_groups g
 JOIN public.product_parent_proposals p ON p.id = g.proposal_id AND p.status = 'open'
 WHERE g.members @> '[{"product_id": "${L1}"}]'::jsonb;
DO $x$ BEGIN RAISE EXCEPTION 'PROVER_ROLLBACK'; END $x$;`);
  assert.match(numbered.output, /PROVER_ROLLBACK/);
  assert.match(numbered.output, /NAME=\[PROVER\] Gen Liberty \(EPA 264-829\) \(liquid\) #2\n/, numbered.output);
  assert.equal(gl.identity_basis, 'epa_number'); assert.equal(gl.status, 'proposed');
  assert.deepEqual(gl.conflicts, {});
  assert.deepEqual([...gl.flags].sort(), ['inactive_member', 'same_epa_different_name']);
  const lh = groupOf(G, LH);
  assert.deepEqual(ids(lh), [LH]); assert.ok(lh.flags.includes('same_epa_different_name'));
  assert.notEqual(groupOf(G, SF).id, groupOf(G, SU).id, 'a safened name merged with the plain one');
  assert.equal(groupOf(G, SF).identity_basis, 'owner_confirmed'); assert.ok(groupOf(G, SF).flags.includes('owner_confirmation_needed'));
  const rho = groupOf(G, R1);
  assert.deepEqual(ids(rho), [R1, R2, R3, R4].sort());
  assert.deepEqual(Object.keys(rho.conflicts).sort(), ['rates', 'use_timings']);
  assert.ok(rho.flags.includes('brand_lists_differ'));
  const mixy = groupOf(G, M1);
  assert.deepEqual(ids(mixy), [M1, M2].sort()); assert.equal(mixy.status, 'held'); assert.ok(mixy.flags.includes('fill_missing_epa'));
  assert.equal(mixy.identity_basis, null);
  for (const pid of [A1, A2]) { const g = groupOf(G, pid); assert.equal(g.status, 'held'); assert.ok(g.flags.includes('ambiguous_strength_token')); }
  assert.notEqual(groupOf(G, A1).id, groupOf(G, A2).id);
  assert.equal(groupOf(G, Q1).status, 'held'); assert.ok(groupOf(G, Q1).flags.includes('name_missing'));
  assert.equal(groupOf(G, F1).status, 'held'); assert.ok(groupOf(G, F1).flags.includes('form_missing'));
  const duo = groupOf(G, D1);
  assert.deepEqual(ids(duo), [D1, D2].sort()); assert.ok(duo.flags.includes('two_bulk_candidates'));
  assert.notEqual(groupOf(G, Y1).id, groupOf(G, Y2).id, 'seed sizes with different stock units merged');
  const nitro = groupOf(G, N1);
  assert.deepEqual(ids(nitro), [N1, N2, N3].sort());
  assert.deepEqual(nitro.members.map((m) => m.suggested_size_role).sort(), ['bulk', 'fixed_tote', 'package']);
  const spread = groupOf(G, S1);
  assert.deepEqual(ids(spread), [S1, S2].sort()); assert.ok(spread.flags.includes('brand_lists_differ'));
  assert.equal(P1.held_count, G.filter((g) => g.status === 'held').length);
  console.log(`[case] build: ${G.length} groups (${P1.held_count} held); nothing grouped; same EPA under another name is a flag; blank-with-EPA, strength-token, nameless and formless groups are held; seed stock units split`);

  // [case] members allow-list
  const ALLOWED = ['brands', 'category', 'container_size', 'container_unit', 'epa_registration', 'inventory_unit', 'is_active', 'manufacturer',
    'product_form', 'product_id', 'product_name', 'rate_per_acre', 'rate_unit', 'sku', 'suggested_rate', 'suggested_size_role', 'use_timings'];
  for (const g of G) for (const m of g.members) assert.deepEqual(Object.keys(m).sort(), ALLOWED);
  assert.doesNotMatch(scalar("SELECT string_agg(members::text, '') FROM public.product_parent_proposal_groups;"), /price|cost|stock|on_hand|quantity/i);
  assert.equal(ok(REP, 'SELECT count(*) FROM public.product_parent_proposals;'), '0');
  assert.equal(ok(REP, 'SELECT count(*) FROM public.product_parent_proposal_groups;'), '0');
  console.log('[case] members allow-list: no price, cost or stock field is stored; a sales rep reads no proposal');

  // [case] changed after download (each change is made and refused in one transaction, so nothing stays)
  const glEntry = entry(gl);
  for (const [what, pre] of [
    ['rate', `UPDATE public.products SET rate_per_acre = 30 WHERE id = '${L1}';`],
    ['epa', `UPDATE public.products SET epa_registration = '264-830' WHERE id = '${L2}';`],
    ['brand', `UPDATE public.product_brands SET signal_word = 'Warning', row_version = row_version + 1 WHERE id = '${BA1}';`],
    ['active', `SELECT set_config('app.product_active_rpc', 'on', true); UPDATE public.products SET is_active = true WHERE id = '${L2}';`],
  ]) {
    refused(ADMIN, approve(P1, [glEntry], `k-chg-${what}`), /PRODUCT_PARENT_GROUP_CHANGED/, pre);
  }
  refused(ADMIN, approve(P1, [{ ...glEntry, group_fingerprint: 'stale' }], 'k-chg-fp'), /PRODUCT_PARENT_GROUP_CHANGED/);
  refused(ADMIN, approve(P1, [entry(groupOf(G, SF))], 'k-owner'), /PRODUCT_PARENT_OWNER_CONFIRMATION_REQUIRED/);
  refused(ADMIN, approve(P1, [entry(mixy)], 'k-held'), /PRODUCT_PARENT_GROUP_NOT_PROPOSED/);
  refused(ADMIN, approve(P1, [{ ...glEntry, name: ' ' }], 'k-noname'), /PRODUCT_PARENT_NAME_REQUIRED/);
  refused(ADMIN, approve(P1, [{ ...glEntry, name: '[prover] gen liberty' }], 'k-taken'), /PRODUCT_PARENT_NAME_TAKEN/);
  refused(ADMIN, approve(P1, [{ ...glEntry, choices: { category: 'Herbicide' } }], 'k-badchoice'), /PRODUCT_PARENT_APPROVAL_INVALID/);
  refused(ADMIN, approve(P1, [{ ...glEntry, extra: 1 }], 'k-badkey'), /PRODUCT_PARENT_APPROVAL_INVALID/);
  refused(ADMIN, approve(P1, [glEntry, glEntry], 'k-dup'), /PRODUCT_PARENT_APPROVAL_INVALID/);
  refused(ADMIN, approve(P1, [glEntry, { ...glEntry, group_id: glEntry.group_id.toUpperCase() }], 'k-dup-case'), /PRODUCT_PARENT_APPROVAL_INVALID/);
  refused(ADMIN, approve({ ...P1, proposal_version: 9 }, [glEntry], 'k-ver'), /PRODUCT_PARENT_PROPOSAL_STALE/);
  refused(REP, approve(P1, [glEntry], 'k-rep-approve'), /ADMIN_REQUIRED/);
  assert.equal(memberCount(), membersBefore);
  console.log('[case] changed after download: a rate, EPA number, brand or active-flag change since the build refuses the approval; owner tick, name and shape are checked');

  // [case] locked
  call(ADMIN, `SELECT public.set_product_rate_lock(true, 'season set', '${ADMIN}', 'k-lock');`);
  const glDone = call(ADMIN, approve(P1, [glEntry], 'k-gl'));
  assert.deepEqual(call(ADMIN, approve(P1, [glEntry], 'k-gl')), glDone, 'a retry returns the first receipt');
  refused(ADMIN, approve(P1, [{ ...glEntry, name: 'Other' }], 'k-gl'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  const GL = glDone.groups[0].parent_id;
  assert.equal(parentOf(L1), GL); assert.equal(parentOf(L2), GL);
  assert.equal(scalar(`SELECT concat_ws('|', name, generic_epa_registration, category, use_timings, rate_per_acre, rate_unit) FROM public.product_parents WHERE id = '${GL}';`),
    '[PROVER] Gen Liberty (EPA 264-829)|264-829|Herbicide|{post_emergence}|32|oz');
  assert.equal(scalar(`SELECT concat_ws('|', reason, evidence) FROM public.product_parent_events WHERE parent_id = '${GL}' AND event_type = 'created';`),
    'Grouped from proposal 1|Same EPA number 264-829');
  refused(ADMIN, approve(P1, [entry(rho, { choices: { use_timings: rho.conflicts.use_timings[0], rates: rho.conflicts.rates[0] } })], 'k-rho-locked'),
    /PRODUCT_RATES_LOCKED/);
  call(ADMIN, `SELECT public.set_product_rate_lock(false, 'grouping', '${ADMIN}', 'k-unlock');`);
  console.log('[case] locked: a group whose rates already agree is approved while locked (retry returns the receipt; a changed retry is refused); one that changes a rate is refused whole');

  // [case] brands moved
  assert.equal(scalar(`SELECT string_agg(concat_ws('|', brand_name, status, row_version, array_length(legacy_brand_ids, 1)), ',' ORDER BY brand_name) FROM public.product_parent_brands WHERE parent_id = '${GL}';`),
    'Brandy A|active|2|2,Brandy B|active|2|2');
  assert.equal(scalar(`SELECT count(*) FROM public.product_parent_brand_sources WHERE legacy_brand_id IN ('${BA1}', '${BA2}', '${BB1}', '${BB2}');`), '4');
  assert.equal(scalar(`SELECT count(*) FROM public.product_parent_brand_events WHERE parent_id = '${GL}' AND event_type = 'created';`), '2');
  refused(ADMIN, brandUpsert(L1, 'New', null, null, null, 'k-old-1'), /PRODUCT_BRANDS_BELONG_TO_PARENT: this product's brands are kept on parent "\[PROVER\] Gen Liberty \(EPA 264-829\)"/);
  refused(ADMIN, brandUpsert(EXISTING, 'Brandy A', '264-829', BA1, 1, 'k-old-2'), /PRODUCT_BRANDS_BELONG_TO_PARENT/);
  const gb = call(REP, `SELECT public.get_product_brands('${L2}');`);
  assert.equal(gb.source, 'parent'); assert.equal(gb.parent_id, GL); assert.deepEqual(gb.brands.map((b) => b.brand_name), ['Brandy A', 'Brandy B']);
  const ub = call(ADMIN, brandUpsert(EXISTING, 'Ungrouped Brand', null, null, null, 'k-ungrouped'));
  const own = call(REP, `SELECT public.get_product_brands('${EXISTING}');`);
  assert.equal(own.source, 'product'); assert.equal(own.brands[0].id, ub.id);
  console.log('[case] brands moved: one parent brand per identical set, every legacy row mapped; the old route refuses a grouped size (even by another product ID) and still edits an ungrouped one');

  // [case] Rho: every refusal, then the approval with previewed prices
  const timingPick = rho.conflicts.use_timings.find((t) => JSON.stringify(t) === '["pre_emerge"]');
  const ratePick = rho.conflicts.rates.find((r) => r.rate_per_acre === '32');
  assert.ok(timingPick && ratePick, JSON.stringify(rho.conflicts));
  const pv = call(ADMIN, `SELECT public.preview_product_rate_correction('${R2}', 32, 'oz');`);
  const r2Prices = Object.fromEntries(TIERS.map((t) => [t, pv.after[t]]));
  const vendorTote = { [R4]: { shop_filled: false } };
  const rhoBase = { choices: { use_timings: timingPick, rates: ratePick }, totes: vendorTote, prices: { [R2]: r2Prices }, brands: { rhoda: { keep: true } } };
  const tryRho = (over, key, pattern) => refused(ADMIN, approve(P1, [entry(rho, { ...rhoBase, ...over })], key), pattern);
  tryRho({ choices: {} }, 'k-r1', /PRODUCT_PARENT_CONFLICT_PICK_REQUIRED/);
  tryRho({ choices: { use_timings: ['pre_emerge', 'post_emergence'], rates: ratePick } }, 'k-r2', /PRODUCT_PARENT_CONFLICT_PICK_REQUIRED: .* use timings/);
  tryRho({ choices: { use_timings: timingPick, rates: { rate_per_acre: '32' } } }, 'k-r3', /PRODUCT_PARENT_CONFLICT_PICK_REQUIRED: .* rates/);
  tryRho({ choices: { use_timings: timingPick, rates: { ...ratePick, rate_per_acre: '33' } } }, 'k-r3b', /PRODUCT_PARENT_CONFLICT_PICK_REQUIRED/);
  tryRho({ totes: {} }, 'k-r4', /PRODUCT_PARENT_TOTE_ANSWER_REQUIRED/);
  tryRho({ totes: { [R4]: { shop_filled: true, fill_source_product_id: R3 } } }, 'k-r5', /PRODUCT_PARENT_TOTE_NOT_FERTILIZER/);
  tryRho({ totes: { [R4]: { shop_filled: false, fill_source_product_id: R3 } } }, 'k-r5b', /PRODUCT_PARENT_APPROVAL_INVALID: a vendor-filled tote/);
  tryRho({ totes: { [R1]: { shop_filled: false }, ...vendorTote } }, 'k-r5c', /PRODUCT_PARENT_APPROVAL_INVALID: tote answers/);
  tryRho({ prices: {} }, 'k-r6', /PRODUCT_PARENT_PRICES_REQUIRED/);
  // One cent more, in exact decimal text (never a binary float).
  const plusCent = (v) => { const [i, f = ''] = raw(v).split('.'); const c = BigInt(i + f.padEnd(2, '0').slice(0, 2)) + 1n; return `${c / 100n}.${String(c % 100n).padStart(2, '0')}`; };
  tryRho({ prices: { [R2]: { ...r2Prices, tier1_price_per_acre: plusCent(r2Prices.tier1_price_per_acre) } } }, 'k-r7', /PRODUCT_RATE_PREVIEW_CHANGED/);
  tryRho({ prices: { [R2]: { tier1_price_per_acre: r2Prices.tier1_price_per_acre } } }, 'k-r7b', /PRODUCT_RATE_PREVIEW_CHANGED/);
  tryRho({ prices: { [R2]: r2Prices, [EXISTING]: r2Prices } }, 'k-r7c', /PRODUCT_PARENT_APPROVAL_INVALID/);
  tryRho({ brands: undefined }, 'k-r8', /PRODUCT_PARENT_BRANDS_PICK_REQUIRED/);
  tryRho({ brands: { nobody: { keep: true } } }, 'k-r8b', /PRODUCT_PARENT_BRANDS_INVALID/);
  tryRho({ size_roles: { [R1]: 'bulk' } }, 'k-r9', /PRODUCT_PARENT_TWO_BULK/);
  assert.equal(memberCount(), membersBefore + 2, 'a refused approval left something behind');
  const r1Before = prod(R1, TIERS.join(', '));
  const rhoDone = call(ADMIN, approve(P1, [entry(rho, rhoBase)], 'k-rho'));
  const RHO = rhoDone.groups[0].parent_id;
  for (const pid of [R1, R2, R3, R4]) assert.equal(prod(pid, 'rate_per_acre, rate_unit, use_timings, use_timing'), '32|oz|{pre_emerge}|Pre-Emerge');
  assert.equal(prod(R2, TIERS.join(', ')), TIERS.map((t) => raw(r2Prices[t])).join('|'), 'R2 per-acre prices are not the previewed ones');
  assert.equal(prod(R1, TIERS.join(', ')), r1Before);
  assert.equal(scalar(`SELECT string_agg(product_id || ':' || size_role || ':' || coalesce(fill_source_product_id::text, '-'), ',' ORDER BY product_id) FROM public.product_parent_members WHERE parent_id = '${RHO}';`),
    `${R1}:package:-,${R2}:package:-,${R3}:bulk:-,${R4}:fixed_tote:-`);
  assert.ok(Number(scalar(`SELECT count(*) FROM public.product_change_history WHERE change_type = 'parent_copy' AND product_id = '${R2}' AND parent_event_id = ${rhoDone.groups[0].event_id};`)) >= 2,
    'R2 has no parent_copy history for its rate and timing change');
  assert.equal(scalar(`SELECT count(*) FROM public.product_parent_brands WHERE parent_id = '${RHO}' AND status = 'active';`), '1');
  console.log('[case] Rho: partial or missing picks, tote answers, chemical shop-filled tote, missing or moved prices, brand pick and two bulk sizes are each refused with nothing left; the approval copies the picks with the previewed prices');

  // [case] two bulk candidates
  refused(ADMIN, approve(P1, [entry(duo)], 'k-duo-1'), /PRODUCT_PARENT_TWO_BULK/);
  const duoDone = call(ADMIN, approve(P1, [entry(duo, { size_roles: { [D1]: 'package' } })], 'k-duo-2'));
  assert.equal(scalar(`SELECT string_agg(size_role, ',' ORDER BY product_id) FROM public.product_parent_members WHERE parent_id = '${duoDone.groups[0].parent_id}';`), 'package,bulk');
  console.log('[case] two bulk candidates: refused until one is set to package');

  // [case] brand race: a brand edit in flight blocks the approval, which then sees the change and refuses
  const race = background(ADMIN, brandUpsert(N1, 'Nitrogen Co', null, BN1, 1, 'k-race', 'Maker Six'));
  const inFlight = "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND state = 'active' AND pid <> pg_backend_pid();";
  for (let i = 0; i < 40 && scalar(inFlight) !== '1'; i += 1) wait(250);
  assert.equal(scalar(inFlight), '1', 'the background brand edit did not start');
  const nitroEntry = (g) => entry(g, { owner_confirmed: true, totes: { [N3]: { shop_filled: true, fill_source_product_id: N2 } }, brands: { 'nitrogen co': { keep: true } } });
  // An uppercase group ID is refused up front (canonical form only), so it can never skip the member locks.
  refused(ADMIN, approve(P1, [{ ...nitroEntry(nitro), group_id: nitro.id.toUpperCase() }], 'k-n-upper'), /PRODUCT_PARENT_APPROVAL_INVALID/);
  const t0 = Date.now();
  refused(ADMIN, approve(P1, [nitroEntry(nitro)], 'k-n-race'), /PRODUCT_PARENT_GROUP_CHANGED/);
  const waited = Date.now() - t0;
  const raced = await race;
  assert.equal(raced.status, 0, raced.output);
  assert.ok(waited > 1500, `the approval did not wait for the brand edit (${waited} ms)`);
  console.log(`[case] brand race: the approval waited ${waited} ms for the in-flight brand edit, then refused with GROUP_CHANGED`);

  // [case] rebuild
  const P2 = build('k-build-2');
  assert.equal(P2.proposal_version, 2);
  assert.equal(scalar(`SELECT status FROM public.product_parent_proposals WHERE id = '${P1.proposal_id}';`), 'superseded');
  refused(ADMIN, approve(P1, [nitroEntry(nitro)], 'k-n-stale'), /PRODUCT_PARENT_PROPOSAL_STALE/);
  refused(ADMIN, decide('hold', groupOf(G, X1), 1, 'later', 'k-hold-stale'), /PRODUCT_PARENT_PROPOSAL_STALE/);
  G = groups(P2.proposal_id);
  for (const pid of [L1, R1, D1, already.product_id]) assert.ok(!G.some((g) => g.members.some((m) => m.product_id === pid)), 'a grouped size was proposed again');
  const nitroDone = call(ADMIN, approve(P2, [nitroEntry(groupOf(G, N1))], 'k-n'));
  const NI = nitroDone.groups[0].parent_id;
  assert.equal(scalar(`SELECT fill_source_product_id FROM public.product_parent_members WHERE product_id = '${N3}';`), N2);
  assert.equal(scalar(`SELECT generic_epa_registration IS NULL FROM public.product_parents WHERE id = '${NI}';`), 't');
  assert.equal(scalar(`SELECT manufacturer FROM public.product_parent_brands WHERE parent_id = '${NI}';`), 'Maker Six');
  assert.equal(scalar(`SELECT evidence FROM public.product_parent_events WHERE parent_id = '${NI}' AND event_type = 'created';`), 'Owner confirmed the same product');
  console.log('[case] rebuild: the old proposal is superseded and refused; the new one leaves grouped sizes out; a fertilizer tote is shop-filled from its own bulk');

  // [case] Spreader: retired variant
  const sp2 = groupOf(G, S1);
  refused(ADMIN, approve(P2, [entry(sp2, { owner_confirmed: true, brands: { spready: { keep: true } } })], 'k-s0'), /PRODUCT_PARENT_BRANDS_PICK_REQUIRED: brand spready differs/);
  refused(ADMIN, approve(P2, [entry(sp2, { owner_confirmed: true, brands: { spready: { keep: true, source_brand_id: BB1 } } })], 'k-s0b'), /PRODUCT_PARENT_BRANDS_INVALID/);
  const spDone = call(ADMIN, approve(P2, [entry(sp2, { owner_confirmed: true, brands: { spready: { keep: true, source_brand_id: BS1 } } })], 'k-s'));
  const SP = spDone.groups[0].parent_id;
  assert.equal(scalar(`SELECT string_agg(concat_ws('|', epa_registration, status), ',' ORDER BY epa_registration) FROM public.product_parent_brands WHERE parent_id = '${SP}';`), '700-7|active,700-8|retired');
  assert.equal(scalar(`SELECT count(*) FROM public.product_parent_brand_sources s JOIN public.product_parent_brands b ON b.id = s.parent_brand_id WHERE b.parent_id = '${SP}';`), '2');
  assert.deepEqual(call(REP, `SELECT public.get_product_brands('${S2}');`).brands.map((b) => b.epa_registration), ['700-7']);
  console.log('[case] Spreader: a brand whose facts differ needs a source pick; the other variant is kept as retired and never shown');

  // [case] hold and reject
  const x1 = groupOf(G, X1); const x2 = groupOf(G, X2);
  refused(ADMIN, decide('hold', x1, 2, ' ', 'k-h0'), /REASON_REQUIRED/);
  const held = call(ADMIN, decide('hold', x1, 2, 'check the label', 'k-h1'));
  assert.deepEqual(call(ADMIN, decide('hold', x1, 2, 'check the label', 'k-h1')), held);
  refused(ADMIN, decide('reject', x1, 2, 'no', 'k-h2'), /PRODUCT_PARENT_GROUP_NOT_PROPOSED/);
  refused(REP, decide('reject', x2, 2, 'no', 'k-h3'), /ADMIN_REQUIRED/);
  refused(ADMIN, decide('reject', x2, 2, 'not one product', 'k-h4'), /PRODUCT_PARENT_GROUP_CHANGED/, `SELECT set_config('app.product_active_rpc', 'on', true); UPDATE public.products SET is_active = false WHERE id = '${X2}';`);
  call(ADMIN, decide('reject', x2, 2, 'not one product', 'k-h5'));
  assert.equal(scalar(`SELECT string_agg(status || ':' || reason, ',' ORDER BY status) FROM public.product_parent_proposal_groups WHERE id IN ('${x1.id}', '${x2.id}');`), 'held:check the label,rejected:not one product');
  const P3 = build('k-build-3');
  const G3 = groups(P3.proposal_id);
  assert.equal(groupOf(G3, X1).status, 'proposed'); assert.equal(groupOf(G3, X2).status, 'proposed');
  console.log('[case] hold and reject: need a reason, replay, refuse a second decision or a changed group; the sizes stay ungrouped and are proposed again on the next build');

  // [case] parent brand list
  const added = call(ADMIN, parentBrand(GL, 'Brandy C', {}, 'k-pb1'));
  refused(ADMIN, parentBrand(GL, 'brandy c', {}, 'k-pb2'), /BRAND_NAME_TAKEN/);
  refused(ADMIN, parentBrand(GL, 'Brandy C', { id: added.id, version: 9 }, 'k-pb3'), /BRAND_CHANGED/);
  refused(ADMIN, parentBrand(RHO, 'Brandy C', { id: added.id, version: 1 }, 'k-pb3b'), /BRAND_PRODUCT_MISMATCH/);
  const edited = call(ADMIN, parentBrand(GL, 'Brandy C', { id: added.id, version: 1, epa: '264-829' }, 'k-pb4'));
  assert.equal(edited.row_version, 2);
  const bb = scalar(`SELECT id FROM public.product_parent_brands WHERE parent_id = '${GL}' AND brand_name = 'Brandy B';`);
  refused(ADMIN, parentBrand(GL, 'Brandy B', { id: bb, version: 2, retire: true }, 'k-pb5'), /REASON_REQUIRED/);
  call(ADMIN, parentBrand(GL, 'Brandy B', { id: bb, version: 2, retire: true, reason: 'no longer sold' }, 'k-pb6'));
  refused(ADMIN, parentBrand(GL, 'Brandy B', { id: bb, version: 3 }, 'k-pb7'), /BRAND_RETIRED/);
  refused(REP, parentBrand(GL, 'Brandy D', {}, 'k-pb8'), /ADMIN_REQUIRED/);
  // An inactive parent (made inactive inside the refused call's own transaction, so nothing stays).
  refused(ADMIN, parentBrand(GL, 'Brandy D', {}, 'k-pb8b'), /PRODUCT_PARENT_INACTIVE/,
    `UPDATE public.product_parents SET is_active = false WHERE id = '${GL}';`);
  assert.equal(scalar(`SELECT is_active FROM public.product_parents WHERE id = '${GL}';`), 't');
  assert.deepEqual(call(REP, `SELECT public.get_product_brands('${L1}');`).brands.map((b) => b.brand_name), ['Brandy A', 'Brandy C']);
  assert.equal(scalar(`SELECT string_agg(event_type, ',' ORDER BY id) FROM public.product_parent_brand_events WHERE parent_brand_id IN ('${added.id}', '${bb}');`), 'created,created,updated,retired');
  ownerRefused("UPDATE public.product_parent_brand_events SET reason = 'x';", /PRODUCT_PARENT_BRAND_EVENTS_ARE_APPEND_ONLY/);
  ownerRefused('DELETE FROM public.product_parent_brand_events;', /PRODUCT_PARENT_BRAND_EVENTS_ARE_APPEND_ONLY/);
  ownerRefused('TRUNCATE public.product_parent_brand_events CASCADE;', /PRODUCT_PARENT_BRAND_EVENTS_ARE_APPEND_ONLY/);
  console.log('[case] parent brand list: add, duplicate, stale edit, other parent, retire (with a reason, final) and inactive-parent and sales-rep refusals; events are append-only');

  // [case] label facts and prices
  assert.equal(labelMd5(), labelBefore, 'an EPA number, label fact, list price, name or active flag changed');
  const acreAfter = perAcre();
  for (const [pid, v] of Object.entries(acreBefore)) {
    if (pid === R2) assert.notEqual(acreAfter[pid], v, 'R2 per-acre prices did not change');
    else assert.equal(acreAfter[pid], v, `per-acre prices of ${pid} changed`);
  }
  console.log('[case] label facts and prices: no EPA number, label fact, list price, name or active flag changed; only the re-rated size has new per-acre prices');

  // [case] build race: an EPA edit in flight blocks the build, which then groups and snapshots the new value
  const epaEdit = new Promise((resolve) => {
    const child = spawn('docker', [...psqlArgs(), '-A', '-t', '-c', `BEGIN; UPDATE public.products SET epa_registration = '900-7' WHERE id = '${X1}'; SELECT pg_sleep(4); COMMIT;`], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, output: out }));
  });
  for (let i = 0; i < 40 && scalar(inFlight) !== '1'; i += 1) wait(250);
  assert.equal(scalar(inFlight), '1', 'the background EPA edit did not start');
  const tb = Date.now();
  const PR = build('k-build-race');
  const builtAfter = Date.now() - tb;
  const epaDone = await epaEdit;
  assert.equal(epaDone.status, 0, epaDone.output);
  assert.ok(builtAfter > 1500, `the build did not wait for the EPA edit (${builtAfter} ms)`);
  const GR = groups(PR.proposal_id);
  const xr = groupOf(GR, X1);
  assert.equal(xr.generic_epa_registration, '900-7', 'the grouping used the EPA number from before the edit');
  for (const g of GR.filter((x) => x.status === 'proposed')) {
    for (const m of g.members) assert.equal(scalar(`SELECT public._normalize_epa_registration(${lit(m.epa_registration)});`) || null, g.generic_epa_registration, `group "${g.suggested_name}" stored a member EPA number its grouping did not use`);
  }
  // Approval re-checks the grouping rule itself, not only the fingerprint: a group whose EPA number no longer
  // matches its sizes is refused even when the stored snapshot is unchanged.
  refused(ADMIN, approve(PR, [entry(xr)], 'k-x-epa'), /PRODUCT_PARENT_GROUP_CHANGED/,
    `UPDATE public.product_parent_proposal_groups SET generic_epa_registration = '900-9' WHERE id = '${xr.id}';`);
  psql(`UPDATE public.products SET epa_registration = '900-1' WHERE id = '${X1}';`);
  console.log(`[case] build race: the build waited ${builtAfter} ms for an in-flight EPA edit and grouped the new number; approval refuses a group whose EPA number no longer matches its sizes`);

  // [case] live smoke chain: the post-apply chain runs here first, with one active profile per probed role.
  const others = [['a3', 'driver'], ['a4', 'applicator'], ['a5', 'entity_recipient']];
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ${others.map(([n, r]) =>
    `('${id(n)}', 'pp2-${r}@example.invalid', '{"full_name":"[PROVER] ${r}","role":"${r}"}'::jsonb)`).join(', ')};`);
  asOwner(others.map(([n, r]) => `UPDATE public.profiles SET role = '${r}', is_active = true WHERE id = '${id(n)}';`).join('\n'));
  setSwitch(false); // as live will be: the chain proves the refusals, then turns it on inside its own rollback
  const chain = docker([...psqlArgs(), '-f', '-'], { input: lf(path.join(ROOT, 'scripts/smoke/smoke-product_parent_proposals.sql')), allowFailure: true });
  assert.match(`${chain.stdout}\n${chain.stderr}`, /SMOKE_PASS_ROLLBACK/, `${chain.stdout}\n${chain.stderr}`);
  assert.equal(scalar('SELECT public._product_parent_grouping_open();'), 'f', 'the smoke chain left grouping on');
  // The brand chain still runs when every active size is grouped (it invents an ungrouped one): every
  // ungrouped size is made inactive in the same transaction, which the chain's final raise rolls back.
  const activeBefore = scalar('SELECT count(*) FROM public.products WHERE is_active;');
  const brandChain = docker([...psqlArgs('supabase_admin'), '-f', '-'], { allowFailure: true, input: `BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.products p SET is_active = false WHERE p.is_active
   AND NOT EXISTS (SELECT 1 FROM public.product_parent_members m WHERE m.product_id = p.id);
SET LOCAL session_replication_role = origin;
${lf(path.join(ROOT, 'scripts/smoke/smoke-upsert-product-brand.sql'))}
ROLLBACK;` });
  assert.match(`${brandChain.stdout}\n${brandChain.stderr}`, /SMOKE_PASS_ROLLBACK/, `${brandChain.stdout}\n${brandChain.stderr}`);
  assert.equal(scalar('SELECT count(*) FROM public.products WHERE is_active;'), activeBefore);
  setSwitch(true);
  console.log('[case] live smoke chain: smoke-product_parent_proposals.sql passes on the post-apply schema, and the brand chain passes with every active size grouped');
  // Cost-exposure keys after the apply, for the allowlist re-key (ship.md step 5): printed, not asserted.
  const costRows = docker([...psqlArgs(), '-A', '-t', '-f', '-'], { input: lf(path.join(ROOT, 'scripts/db-invariant-sweeps/predicates/cost-exposure-review.sql')) })
    .stdout.split(/\r?\n/).filter((l) => /parent|brand/i.test(l));
  for (const row of costRows) console.log(`[cost-exposure] ${row}`);

  // [case] rollback
  // The active "Brandy A" takes the retired variant's name after the move: each size keeps its own mapped row,
  // so the frozen "Brandy B" row there has to be archived and renamed aside, not collided with.
  const ba = scalar(`SELECT id || ':' || row_version FROM public.product_parent_brands WHERE parent_id = '${GL}' AND brand_name = 'Brandy A' AND status = 'active';`).split(':');
  // A 200-character name (the limit): the renamed-aside row must still fit, so its name is cut before the suffix.
  const LONG = `Brandy B${'x'.repeat(192)}`;
  asOwner(`UPDATE public.product_brands SET brand_name = '${LONG}' WHERE id IN ('${BB1}', '${BB2}');`);
  call(ADMIN, parentBrand(GL, LONG, { id: ba[0], version: Number(ba[1]), epa: '264-829' }, 'k-pb9'));
  // A size moved to another parent (PAR-1 move_product_size; set directly here, its checks are PAR-1's) keeps its
  // legacy row mapped to the old parent's brand: after rollback that row must not show as current.
  asOwner(`UPDATE public.product_parent_members SET parent_id = '${GL}' WHERE product_id = '${R1}';`);
  stageText('rollback.sql', `${rollbackSql()}\n${originalBrandWriter()}\n`);
  const rolled = apply('rollback.sql');
  assert.equal(rolled.status, 0, rolled.output);
  assert.equal(scalar("SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.upsert_product_brand(uuid,text,text,text,boolean,boolean,text,uuid,integer,text)'::regprocedure;"),
    '16a6d86bb6d935cdce42f9fa618a22d0');
  for (const fn of ['build_product_parent_proposal(text)', 'get_product_brands(uuid)', '_product_parent_base_name(text)']) assert.equal(scalar(`SELECT to_regprocedure('public.${fn}') IS NULL;`), 't');
  const legacy = (pid) => scalar(`SELECT string_agg(concat_ws('|', brand_name, epa_registration, manufacturer), ',' ORDER BY brand_name) FROM public.product_brands WHERE product_id = '${pid}';`);
  const archiveId = (bid) => scalar(`SELECT id FROM public.product_brand_rollback_archive WHERE legacy_brand_id = '${bid}';`);
  for (const [pid, bid] of [[L1, BB1], [L2, BB2]]) {
    const suffix = ` (archived ${archiveId(bid)})`;
    assert.deepEqual(legacy(pid).split(',').sort(), [`${LONG}|264-829|Maker One`, `${LONG.slice(0, 200 - suffix.length)}${suffix}|Maker Two`, 'Brandy C|264-829|Maker One'].sort());
  }
  assert.equal(scalar(`SELECT string_agg(legacy_row->>'brand_name', ',') FROM public.product_brand_rollback_archive WHERE legacy_brand_id IN ('${BB1}', '${BB2}');`), `${LONG},${LONG}`);
  assert.equal(scalar("SELECT count(*) FROM public.product_brands WHERE brand_name LIKE '~rollback %';"), '0');
  assert.equal(legacy(S2), 'Spready|700-7|Maker Four');
  assert.equal(scalar(`SELECT count(*) || ':' || min(legacy_row->>'epa_registration') FROM public.product_brand_rollback_archive WHERE legacy_brand_id = '${BS2}';`), '1:700-8');
  assert.equal(ok(REP, 'SELECT count(*) FROM public.product_brand_rollback_archive;'), '0');
  assert.equal(scalar(`SELECT brand_name || ':' || is_currently_sourced FROM public.product_brands WHERE id = '${BR1}';`), 'Rhoda:false');
  assert.equal(scalar(`SELECT count(*) FROM public.product_brand_rollback_archive WHERE legacy_brand_id = '${BR1}' AND reason LIKE '%size moved%' AND (legacy_row->>'is_currently_sourced')::boolean;`), '1');
  assert.equal(scalar(`SELECT string_agg(brand_name, ',' ORDER BY brand_name) FROM public.product_brands WHERE product_id = '${R1}' AND is_currently_sourced;`),
    scalar(`SELECT string_agg(brand_name, ',' ORDER BY brand_name) FROM public.product_parent_brands WHERE parent_id = '${GL}' AND status = 'active' AND is_currently_sourced;`));
  for (const pid of [R2, R3, R4]) assert.equal(scalar(`SELECT count(*) FROM public.product_brands WHERE product_id = '${pid}' AND brand_name = 'Rhoda' AND is_currently_sourced;`), '1');
  const back = call(ADMIN, brandUpsert(L1, 'After Rollback', null, null, null, 'k-after-rollback'));
  assert.equal(back.brand_name, 'After Rollback');
  console.log('[case] rollback: every active parent brand is back on each size, a blocking variant is archived whole (renamed aside when an active brand took its name), a size moved to another parent keeps only the new parent brands as current, the original brand writer is re-issued and edits grouped sizes again');

  console.log('PRODUCT_PARENT_PROPOSALS_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
