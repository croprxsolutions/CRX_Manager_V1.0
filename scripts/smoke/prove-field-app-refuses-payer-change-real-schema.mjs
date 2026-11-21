#!/usr/bin/env node
/**
 * Real-schema proof for 20270204100000_field_app_refuses_payer_change (#2058).
 * Container setup and replay copied from prove-field-app-no-sold-unit-real-schema.mjs. A standalone draft for farm A
 * (field A1) is edited through save_field_app_invoice, each case rolled back:
 *   BEFORE: moved to B's field, A stays the customer and is billed for B's work; split over A's and B's fields, the
 *           original stays a live draft with no lines; a second A field is a normal edit.
 *   AFTER:  moved or split, the save is refused FIELD_APP_PAYER_CHANGED with a sentence naming only the farm(s) the fields
 *           now bill (a job-made invoice is told to re-invoice from its job), and nothing changes (Mason, 2026-11-21: refuse and explain);
 *           the normal edit and a grouped edit end exactly as before. A second apply stops at the preflight.
 *
 * Run: node scripts/smoke/prove-field-app-refuses-payer-change-real-schema.mjs   (needs Docker)
 * Prints FIELD_APP_PAYER_CHANGE_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Iterating: CRX_PROVER_REUSE=<kept container> CRX_PROVER_DB=<a copy of its replayed database> skips the replay.
const REUSE = process.env.CRX_PROVER_REUSE;
const NAME = REUSE || `crx-sdf-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
// Shell commands below name the database; only a bare name is accepted (Sol r1).
if (!/^[a-z0-9_]+$/.test(DB)) throw new Error('CRX_PROVER_DB must be a bare database name (a-z, 0-9, _)');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270204100000_field_app_refuses_payer_change.sql');
const FOLLOW_UPS = [];
const LATER_READ_ONLY = new Set([]);
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
  // Need live's storage.objects policies, which this database does not have; neither touches units or stock.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate changes or relies on.
const TOUCHED = /(_save_field_app_invoice_impl_20260714|derive_customer_shares_from_fields|resolve_field_app_chemical_price|field_app_priced_quantity)/i;
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const LIVE_UNIT_ROWS = "('3f5c3827-8523-4b42-9913-ad479588ff95'::uuid, 'Dry oz', 1, 'dry', '1 dry ounce'), ('5ed18e4b-c4d9-42fc-b85e-22babd3fc098'::uuid, 'Ea', 1, 'both', 'Each / unit'), ('f9e10e66-5027-464e-bb9e-ed9800875256'::uuid, 'fl oz', 1, 'liquid', '1 fluid ounce'), ('4406cacd-a7fe-42db-8c84-694e61bb937b'::uuid, 'g', 0.03527396, 'dry', '1 gram = 0.03527396 dry ounces (1000 mg)'), ('29d05e43-cb40-461b-a969-88ee299faca8'::uuid, 'Gal', 128, 'liquid', '1 gallon = 128 fluid ounces'), ('53997e31-d152-4ab6-b768-d1aa81b657bf'::uuid, 'Lb', 16, 'dry', '1 pound = 16 dry ounces'), ('fc5d349f-b58c-48f1-991d-fa0161fd3d01'::uuid, 'LB', 16, 'dry', '1 pound (capitalized alias)'), ('ddde7daf-8090-492b-aed9-c0b7f8ecfd34'::uuid, 'MG', 0.00003527396, 'dry', '1 milligram = 0.00003527396 dry ounces'), ('438d5f7b-f015-4319-b2b7-4f9a672cb350'::uuid, 'oz', 1, 'liquid', '1 fluid ounce (alias for fl oz)'), ('b69ddac6-68ed-4f1d-8e09-e63a7fa6635a'::uuid, 'Oz', 1, 'liquid', '1 fluid ounce (capitalized alias)'), ('a31f95a0-df80-4025-977f-f1fb4e5c8d53'::uuid, 'Pt', 16, 'liquid', '1 pint = 16 fluid ounces'), ('35532f45-2fd0-4400-87d8-3509a58377c0'::uuid, 'qt', 32, 'liquid', '1 quart lowercase (alias for Qt)'), ('915f25ff-8876-4a49-a375-940047e38313'::uuid, 'Qt', 32, 'liquid', '1 quart = 32 fluid ounces'), ('722e8d86-8e68-47d8-a940-209fad38c70e'::uuid, 'Unit', 1, 'both', 'Each / unit (alias for Ea)')";

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
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
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs', '--include-one-shot'], { cwd: ROOT, encoding: 'utf8' });
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
  for (const file of all.slice(at + 1).filter((f) => !FOLLOW_UPS.includes(f) && !LATER_READ_ONLY.has(path.basename(f)))) {
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, created_at timestamptz DEFAULT now(), UNIQUE (bucket_id, name));
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
    // Other one-shot data migrations rewrite live rows this database does not have: ledger only, as live has them.
    if (ONE_SHOT.has(base.slice(0, -4))) { ledger(base.slice(0, -4)); continue; }
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    // BLK-1a's preflight needs live's count units (live has Ea and Unit, factor 1, both).
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
    }
    // RT-1's preflight pins live's unit factors; give it live's 14 unit rows (read live 2026-11-10).
    if (base === '20261229110000_product_rates_draft.sql') {
      raw(`DELETE FROM public.unit_conversions;
        INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};`);
    }
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    if (base === '20270106110000_invoice_brands_rup.sql') {
      // Live ran REG-1's one-time seed before this file; its preflight refuses without the seed row.
      raw(`INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint)
        SELECT '00000000-0000-4000-8000-000000000000', 'unknown', 'units-proof' WHERE NOT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);`);
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
// A rolled-back probe: as postgres with triggers on (uid null) or as a signed-in user. Returns the last row.
function probe(sql, uid = null) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${claims}\n${sql}\nROLLBACK;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '' };
}
function okProbe(sql, uid) { const r = probe(sql, uid); assert.equal(r.status, 0, r.output); return r.last; }
function refusedProbe(sql, pattern, uid) {
  const r = probe(sql, uid);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}\n${r.output}`);
  assert.match(r.output, pattern);
}

const id = (s) => `a5a5a5a5-2058-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), A = id('c1'), B = id('c2'), GA = id('f1'), GA2 = id('f3'), GB = id('f2'), N = id('d1');
const SAVE_IMPL = 'public._save_field_app_invoice_impl_20260714(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)';
const OLD_BODY = '1a4a2655e43392d867b195289df9b9a1';
const body = () => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${SAVE_IMPL}'::regprocedure;`);
const grants = (sig) => scalar(`SELECT COALESCE(string_agg(g, ',' ORDER BY g), '-') FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
  FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${sig}'::regprocedure AND a.privilege_type = 'EXECUTE') x;`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'sdf-admin@example.invalid', '{"full_name":"[PROVER] SDF Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active) VALUES ('${A}', '[PROVER] SDF Farm A', 1, true), ('${B}', '[PROVER] SDF Farm B', 1, true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active) VALUES
      ('${N}', '[PROVER] SDF chem', 'SDF-1', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 5, 30, 30, 30, true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
      ('${GA}', '${A}', '[PROVER] SDF field A', 100, true), ('${GA2}', '${A}', '[PROVER] SDF field A2', 100, true),
      ('${GB}', '${B}', '[PROVER] SDF field B', 100, true);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES
      ('${GA}', '${A}', 100, true, NULL), ('${GA2}', '${A}', 100, true, NULL), ('${GB}', '${B}', 100, true, NULL);`);
  // Test-only helpers (prover database only). sdf.save(invoice, fields) saves 128 oz/ac of the chemical on each field
  // (10 applied acres) and returns its invoice_ids. sdf.state() lists every [PROVER] field-app invoice as
  // farm:status:total:line count:group?, ordered by farm and status.
  psql(`CREATE SCHEMA sdf AUTHORIZATION postgres;
    CREATE FUNCTION sdf.save(p_invoice uuid, p_fields uuid[], p_key text) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$
    BEGIN
      RETURN public.save_field_app_invoice(p_invoice,
        jsonb_build_object('invoice_date', ((now() AT TIME ZONE 'America/Chicago')::date)::text, 'salesman_id', '${ADMIN}'),
        (SELECT jsonb_agg(jsonb_build_object('field_id', f, 'map_number', o, 'total_acres', 100, 'planted_acres', 100,
          'applied_acres', 10, 'sort_order', o)) FROM unnest(p_fields) WITH ORDINALITY u(f, o)),
        jsonb_build_array(jsonb_build_object('description', 'SDF chem', 'rate_per_acre', 128, 'rate_unit', 'oz', 'unit_size', 'Gal',
          'cost_cents', 500, 'sort_order', 0, 'manual_override', false, 'product_id', '${N}')),
        '${ADMIN}', NULL, p_key);
    END $f$;
    CREATE FUNCTION sdf.state() RETURNS text LANGUAGE sql SET search_path = public, pg_temp AS $f$
      SELECT COALESCE(string_agg(format('%s:%s:%s:%s:%s', right(c.farm_name, 1), i.status, i.total_amount_cents,
          (SELECT count(*) FROM invoice_items x WHERE x.invoice_id = i.id), CASE WHEN i.invoice_group_id IS NULL THEN 'solo' ELSE 'group' END),
          ' ' ORDER BY c.farm_name, i.status), '-')
        FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE c.farm_name LIKE '[PROVER] SDF%' AND i.deleted_at IS NULL;
    $f$;`);
  console.log('[prover] committed test rows: farms A and B; fields A1, A2 (A) and B (B); a liquid chemical sold by the Gal at $30');
}
const asAdmin = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);\n`;
// Create a draft for A on field A1 (or the given fields), run the optional setup, then edit it with the given fields
// in a later statement; returns the state and whether the original id is among the returned ids.
const scenario = (fields, start = `'${GA}'`, setup = '') => `${asAdmin}CREATE TEMP TABLE t AS SELECT (sdf.save(NULL, ARRAY[${start}]::uuid[], 'sdf-new-' || gen_random_uuid())->'invoice_ids'->>0)::uuid AS inv;
  ${setup}
  CREATE TEMP TABLE r AS SELECT sdf.save(t.inv, ARRAY[${fields}]::uuid[], 'sdf-edit-' || gen_random_uuid()) AS r FROM t;
  SELECT sdf.state() || ' | ' || (SELECT CASE WHEN r.r->'invoice_ids' @> to_jsonb(ARRAY[t.inv]) THEN 'kept' ELSE 'replaced' END
    || ' | orphan-rows=' || (SELECT count(*) FROM activity_feed a WHERE a.related_entity_id = t.inv AND a.event_type = 'invoice_orphan_cancelled')
    || ' | original=' || (SELECT right(c.farm_name, 1) || ':' || i.status FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = t.inv)
    FROM t, r);`;
const TO_B = scenario(`'${GB}'`), SPLIT = scenario(`'${GA}','${GB}'`), SAME = scenario(`'${GA}','${GA2}'`);
// A grouped A+B draft (opened from its first member) edited down to A's field: the existing grouped rule, unchanged.
const GROUPED = scenario(`'${GA}'`, `'${GA}','${GB}'`);
// Test-only shortcuts (rolled back with the case; triggers and foreign keys skipped): an invoice that was posted once,
// and (a real job row) one made from a job. Moving or splitting either is refused after the candidate, like a plain draft.
const viaReplica = (set) => `SET LOCAL session_replication_role = replica; UPDATE invoices SET ${set} FROM t WHERE invoices.id = t.inv; SET LOCAL session_replication_role = origin;`;
const UNPOSTED = scenario(`'${GB}'`, `'${GA}'`, viaReplica(`status = 'unposted'`));
const FROM_JOB = scenario(`'${GB}'`, `'${GA}'`, `WITH j AS (INSERT INTO jobs (job_number, customer_id, job_date) VALUES ('SDF-J1', '${A}', CURRENT_DATE) RETURNING id)
    UPDATE invoices SET job_id = j.id FROM j, t WHERE invoices.id = t.inv;`);
const UNPOSTED_SPLIT = scenario(`'${GA}','${GB}'`, `'${GA}'`, viaReplica(`status = 'unposted'`));
const FROM_JOB_SPLIT = scenario(`'${GA}','${GB}'`, `'${GA}'`, `WITH j AS (INSERT INTO jobs (job_number, customer_id, job_date) VALUES ('SDF-J2', '${A}', CURRENT_DATE) RETURNING id)
    UPDATE invoices SET job_id = j.id FROM j, t WHERE invoices.id = t.inv;`);
// A deleted standalone draft is refused (by the lock wrapper before, and by the impl too after).
const DELETED = `${asAdmin}CREATE TEMP TABLE t AS SELECT (sdf.save(NULL, ARRAY['${GA}']::uuid[], 'sdf-new-' || gen_random_uuid())->'invoice_ids'->>0)::uuid AS inv;
  UPDATE invoices SET deleted_at = now() FROM t WHERE invoices.id = t.inv;
  SELECT sdf.save(t.inv, ARRAY['${GA}']::uuid[], 'sdf-edit-' || gen_random_uuid()) FROM t;`;

async function main() {
  if (REUSE) {
    assert.match(REUSE, /^crx-[a-z0-9-]+$/, 'CRX_PROVER_REUSE must name a kept prover container (crx-...)');
    assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', REUSE]).stdout.trim(), 'none', 'CRX_PROVER_REUSE must be a network-less prover container');
    assert.match(DB, /^sdf_run_[a-z0-9_]+$/, 'CRX_PROVER_REUSE needs CRX_PROVER_DB naming a fresh copy called sdf_run_<n>');
  } else buildContainer();
  assert.equal(body(), OLD_BODY, 'the replayed body is not the one the candidate expects');
  assert.equal(scalar(`SELECT (SELECT count(*) FROM auth.users WHERE id = '${ADMIN}') + (SELECT count(*) FROM pg_namespace WHERE nspname = 'sdf');`),
    '0', 'this database was already used by a proof run: make a fresh copy');
  const saveGrants = grants(SAVE_IMPL);
  seed();

  // BEFORE (each case rolled back): 128 oz/ac x 10 ac = 10 Gal x $30 = $300.00 a field.
  const toBBefore = okProbe(TO_B), splitBefore = okProbe(SPLIT), sameBefore = okProbe(SAME), groupedBefore = okProbe(GROUPED);
  console.log(`[before] a grouped A+B draft edited to A's field: ${groupedBefore}`);
  const deletedBefore = probe(DELETED);
  console.log(`[before] a deleted standalone draft re-saved: status ${deletedBefore.status}`);
  console.log(`[before] A's draft moved to B's field: ${toBBefore}`);
  console.log(`[before] A's draft split over A's and B's fields: ${splitBefore}`);
  console.log(`[before] A's draft given a second A field: ${sameBefore}`);
  const unpostedBefore = okProbe(UNPOSTED), jobBefore = okProbe(FROM_JOB), jobSplitBefore = okProbe(FROM_JOB_SPLIT);
  console.log(`[before] A's job-made draft split over A's and B's fields: ${jobSplitBefore}`);
  console.log(`[before] A's once-posted (unposted) invoice moved to B's field: ${unpostedBefore}`);
  console.log(`[before] A's job-made draft moved to B's field: ${jobBefore}`);
  assert.equal(toBBefore, 'A:draft:30000:1:solo | kept | orphan-rows=0 | original=A:draft', 'before: farm A is billed for B\'s field');
  assert.ok(splitBefore.includes('A:draft:30000:0:solo') && splitBefore.endsWith('| replaced | orphan-rows=0 | original=A:draft'),
    'before: the original draft stays live with its old total and no lines');
  assert.equal(sameBefore, 'A:draft:60000:1:solo | kept | orphan-rows=0 | original=A:draft');
  assert.notEqual(deletedBefore.status, 0, 'before: the lock wrapper already refuses a deleted draft');
  assert.match(deletedBefore.output, /not found/i);

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.notEqual(body(), OLD_BODY);
  assert.equal(grants(SAVE_IMPL), saveGrants, 'the save helper grants must not change');
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /FIELD_APP_STANDALONE_DRAFT_PREFLIGHT/);
  console.log(`[case] the candidate applies (EXECUTE unchanged: ${saveGrants}); a second apply stops at its preflight`);

  // Refused, with the sentence the office reads (the farm names come from the derived payers and the invoice's farm).
  const lit = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const STANDALONE_END = 'Put back the original fields, or have an admin delete this invoice (void it if it was posted) first, then make a new field application invoice for these fields.';
  const JOB_END = 'Put back the original fields, or, if the job itself is wrong, have an admin delete this invoice (void it if it was posted), correct the job, and invoice it again from Scheduling.';
  // Names only the farm(s) of the fields sent; never this invoice's own number or farm (Sol r3).
  const sentence = (now, end = STANDALONE_END) => new RegExp(lit(`FIELD_APP_PAYER_CHANGED: Nothing was saved. These fields bill ${now}, which does not match the one farm this invoice bills, and an invoice cannot change which farm it bills. ${end}`));
  const B_ONLY = '[PROVER] SDF Farm B', BOTH = '[PROVER] SDF Farm A and [PROVER] SDF Farm B';
  refusedProbe(TO_B, sentence(B_ONLY));
  refusedProbe(SPLIT, sentence(BOTH));
  console.log("[after] A's draft moved to B's field, or split over A's and B's: refused FIELD_APP_PAYER_CHANGED naming the farms (whole save rolled back)");
  refusedProbe(UNPOSTED, sentence(B_ONLY));
  refusedProbe(FROM_JOB, sentence(B_ONLY, JOB_END));
  refusedProbe(UNPOSTED_SPLIT, sentence(BOTH));
  refusedProbe(FROM_JOB_SPLIT, sentence(BOTH, JOB_END));
  console.log('[after] an unposted invoice or a job-made draft, moved or split: refused the same way');
  const same = okProbe(SAME);
  console.log(`[after] A's draft given a second A field: ${same}`);
  assert.equal(same, sameBefore, 'a normal edit is unchanged');
  assert.equal(okProbe(GROUPED), groupedBefore, 'a grouped edit is unchanged');
  refusedProbe(DELETED, /Invoice not found/);
  console.log(`[after] the grouped edit ends as before (${groupedBefore}); a deleted standalone draft is refused 'Invoice not found'`);
  console.log('FIELD_APP_PAYER_CHANGE_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
