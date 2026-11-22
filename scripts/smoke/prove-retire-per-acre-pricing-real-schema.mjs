#!/usr/bin/env node
/**
 * Real-schema proof for 20270207142500_retire_per_acre_field_pricing (Mason, 2026-11-22: always bill line by line).
 * Container setup and replay copied from prove-field-app-refuses-payer-change-real-schema.mjs. Field S is split
 * farm A 60% / farm B 40%; each case is rolled back:
 *   BEFORE: with a per-acre price on A's split, A's invoice bills a per-acre line and its chemical at $0.
 *   APPLY:  refused PER_ACRE_PRICING_IN_USE while any split has a per-acre price or a note (blank too), and while a saved
 *           draft's invoice share still carries a per-acre rate after its split was cleared (Sol r1); applies on clean
 *           rows (both constraints validated, no row changes); a second apply stops at its preflight.
 *   AFTER:  save_field as an admin with a per-acre price or a note is refused (check_violation) and the splits stay as
 *           they were; a plain 70/30 save works; a saved draft's invoice share refuses a per-acre rate; the same
 *           invoice bills both farms line by line (60/40 of $300.00).
 *   REVERSE: scripts/smoke/retire-per-acre-pricing-reverse.sql drops both constraints; a second run refuses.
 *
 * Run: node scripts/smoke/prove-retire-per-acre-pricing-real-schema.mjs   (needs Docker)
 * Prints RETIRE_PER_ACRE_PRICING_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a fresh container and database (no reuse: Sol r1 on this prover).
const NAME = `crx-rpa-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270207142500_retire_per_acre_field_pricing.sql');
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
const TOUCHED = /(field_billing_defaults|invoice_shares|invoice_items|_save_field_app_invoice_impl_20260714|derive_customer_shares_from_fields|_save_field_replay_impl_20261015|save_field\()/i;
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
  // A private new directory, so no existing file or link in the shared temp folder is ever written (Sol r1).
  const dir = mkdtempSync(path.join(tmpdir(), 'crx-rpa-'));
  const staged = path.join(dir, name);
  try {
    writeFileSync(staged, text, { encoding: 'utf8', flag: 'wx' });
    docker(['cp', staged, `${NAME}:/tmp/${name}`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

const id = (s) => `a5a5a5a5-0ac4-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), A = id('c1'), B = id('c2'), GS = id('f1'), N = id('d1');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'retire-per-acre-pricing-reverse.sql');
const CONSTRAINT = 'field_billing_defaults_no_per_acre_price';
const SHARE_CONSTRAINT = 'invoice_shares_no_per_acre_price';
const asAdmin = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;\n`;
const splits = () => scalar(`SELECT string_agg(format('%s:%s:%s:%s', right(c.farm_name, 1), d.split_pct::numeric(5,2), COALESCE(d.price_override_cents::text, '-'), COALESCE(d.pricing_note, '-')), ' ' ORDER BY c.farm_name)
  FROM field_billing_defaults d JOIN customers c ON c.id = d.customer_id WHERE d.field_id = '${GS}';`);
const constraintState = () => scalar(`SELECT COALESCE((SELECT string_agg(conname || '=' || convalidated::text || ':' || pg_get_constraintdef(oid), ' ' ORDER BY conname)
  FROM pg_constraint WHERE conname IN ('${CONSTRAINT}', '${SHARE_CONSTRAINT}')), 'absent');`);
const fingerprint = () => scalar(`SELECT md5(COALESCE((SELECT string_agg(to_jsonb(d)::text, '|' ORDER BY d.id) FROM field_billing_defaults d), '')
  || '#' || COALESCE((SELECT string_agg(to_jsonb(s)::text, '|' ORDER BY s.id) FROM invoice_shares s), ''));`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'rpa-admin@example.invalid', '{"full_name":"[PROVER] RPA Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active) VALUES ('${A}', '[PROVER] RPA Farm A', 1, true), ('${B}', '[PROVER] RPA Farm B', 1, true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active) VALUES
      ('${N}', '[PROVER] RPA chem', 'RPA-1', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 5, 30, 30, 30, true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES ('${GS}', '${A}', '[PROVER] RPA field S', 100, true);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES
      ('${GS}', '${A}', 60, true), ('${GS}', '${B}', 40, false);`);
  // Test-only helper (prover database only). rpa.invoice() saves 128 oz/ac of the chemical on field S (10 applied
  // acres = 10 Gal at $30 = $300.00) through save_field_app_invoice as the admin, then lists each [PROVER] invoice as
  // farm:total=[description@unit cents x quantity = extended cents; ...], ordered by farm.
  psql(`CREATE SCHEMA rpa AUTHORIZATION postgres;
    CREATE FUNCTION rpa.invoice() RETURNS text LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$
    BEGIN
      PERFORM public.save_field_app_invoice(NULL,
        jsonb_build_object('invoice_date', ((now() AT TIME ZONE 'America/Chicago')::date)::text, 'salesman_id', '${ADMIN}'::uuid),
        jsonb_build_array(jsonb_build_object('field_id', '${GS}', 'map_number', 1, 'total_acres', 100, 'planted_acres', 100,
          'applied_acres', 10, 'sort_order', 1)),
        jsonb_build_array(jsonb_build_object('description', 'RPA chem', 'rate_per_acre', 128, 'rate_unit', 'oz', 'unit_size', 'Gal',
          'cost_cents', 500, 'sort_order', 0, 'manual_override', false, 'product_id', '${N}')),
        '${ADMIN}'::uuid, NULL, 'rpa-' || gen_random_uuid());
      RETURN (SELECT string_agg(format('%s:%s=[%s]', right(c.farm_name, 1), i.total_amount_cents,
          (SELECT string_agg(format('%s@%s x %s = %s', x.description, x.unit_price_cents, x.quantity::numeric(12,4), x.extended_cents), '; ' ORDER BY x.sort_order, x.description)
             FROM invoice_items x WHERE x.invoice_id = i.id)), ' ' ORDER BY c.farm_name)
        FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE c.farm_name LIKE '[PROVER] RPA%' AND i.deleted_at IS NULL);
    END $f$;`);
  console.log('[prover] committed test rows: field S of farm A, split A 60% / B 40%; a liquid chemical sold by the Gal at $30');
}
const asAdminClaims = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);\n`;
// save_field as the signed-in admin (authenticated role, the app's own grants) with the given split rows.
const saveField = (rows, key) => `${asAdmin}SELECT public.save_field('${GS}',
  '{"customer_id":"${A}","field_name":"[PROVER] RPA field S renamed","total_acres":100,"is_active":true}'::jsonb,
  '${JSON.stringify(rows)}'::jsonb, NULL, '${key}');`;
const row = (cust, pct, primary, extra = {}) => ({ customer_id: cust, split_pct: pct, is_primary: primary, notes: null, price_override_cents: null, pricing_note: null, ...extra });

async function main() {
  buildContainer();
  assert.equal(constraintState(), 'absent');
  assert.equal(scalar(`SELECT (SELECT count(*) FROM auth.users WHERE id = '${ADMIN}') + (SELECT count(*) FROM pg_namespace WHERE nspname = 'rpa');`),
    '0', 'this database was already used by a proof run: make a fresh copy');
  seed();

  // BEFORE (rolled back): plain 60/40 bills line by line; a $20/ac price on A's split bills A per acre with the chemical at $0.
  const plainBefore = okProbe(`${asAdminClaims}SELECT rpa.invoice();`);
  console.log(`[before] 60/40 field, no per-acre price: ${plainBefore}`);
  const perAcreBefore = okProbe(`${asAdminClaims}UPDATE field_billing_defaults SET price_override_cents = 2000, pricing_note = 'Prepaid' WHERE field_id = '${GS}' AND customer_id = '${A}';
    SELECT rpa.invoice();`);
  console.log(`[before] 60/40 field, A at $20.00/ac: ${perAcreBefore}`);
  assert.equal(perAcreBefore, 'A:12000=[[PROVER] RPA field S — grower share @ $20.00/ac (Prepaid)@2000 x 6.0000 = 12000; '
    + 'RPA chem — included in grower share@0 x 6.0000 = 0] B:12000=[RPA chem@3000 x 4.0000 = 12000]',
    'before: A is billed 6 acres at $20.00/ac and its chemical at $0');
  assert.notEqual(perAcreBefore, plainBefore, 'before: the per-acre price changes what A is billed');

  // APPLY refused while any split carries a per-acre price or a note (a blank note too); nothing changes.
  for (const [label, set] of [['a per-acre price', 'price_override_cents = 2000'], ['a blank pricing note', "pricing_note = ''"], ['a pricing note', "pricing_note = 'Prepaid'"]]) {
    stageText('dirty.sql', `UPDATE public.field_billing_defaults SET ${set} WHERE field_id = '${GS}' AND customer_id = '${A}';\n${lf(CANDIDATE)}`);
    const r = apply('dirty.sql');
    assert.notEqual(r.status, 0, `${label}: the apply must be refused`);
    assert.match(r.output, /PER_ACRE_PRICING_IN_USE: 1 field billing split\(s\) and 0 invoice share\(s\) still carry per-acre pricing/);
    console.log(`[apply] with ${label} on a split: refused PER_ACRE_PRICING_IN_USE (rolled back)`);
  }
  // Sol r1: a draft saved at $20/ac whose split was then cleared still carries the rate on its invoice share.
  stageText('dirty-draft.sql', `${asAdminClaims}UPDATE public.field_billing_defaults SET price_override_cents = 2000 WHERE field_id = '${GS}' AND customer_id = '${A}';
SELECT rpa.invoice();
UPDATE public.field_billing_defaults SET price_override_cents = NULL WHERE field_id = '${GS}' AND customer_id = '${A}';
${lf(CANDIDATE)}`);
  const draft = apply('dirty-draft.sql');
  assert.notEqual(draft.status, 0, 'a saved per-acre draft must refuse the apply');
  assert.match(draft.output, /PER_ACRE_PRICING_IN_USE: 0 field billing split\(s\) and 1 invoice share\(s\) still carry per-acre pricing/);
  console.log('[apply] with a saved $20/ac draft whose split was cleared: refused PER_ACRE_PRICING_IN_USE (rolled back)');
  assert.equal(constraintState(), 'absent');
  assert.equal(splits(), 'A:60.00:-:- B:40.00:-:-', 'refused applies leave every split as it was');

  stageText('candidate.sql', lf(CANDIDATE));
  const rowsBefore = fingerprint();
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.equal(constraintState(), `${CONSTRAINT}=true:CHECK (((price_override_cents IS NULL) AND (pricing_note IS NULL))) `
    + `${SHARE_CONSTRAINT}=true:CHECK (((price_per_acre_cents IS NULL) AND (pricing_note IS NULL)))`);
  assert.equal(fingerprint(), rowsBefore, 'the migration changes no row');
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /PER_ACRE_PRICING_PREFLIGHT: a no_per_acre_price constraint already exists/);
  console.log('[apply] clean rows: applies, constraint validated, no row changed; a second apply stops at its preflight');

  // AFTER: save_field as the signed-in admin, fresh keys.
  const refused = (rows, key, label) => {
    refusedProbe(saveField(rows, key), new RegExp(`violates check constraint "${CONSTRAINT}"`));
    console.log(`[after] save_field with ${label}: refused by ${CONSTRAINT}`);
  };
  refused([row(A, 60, true, { price_override_cents: 2000 }), row(B, 40, false)], 'rpa-k1', 'a $20.00/ac price on A');
  refused([row(A, 60, true, { pricing_note: 'Prepaid' }), row(B, 40, false)], 'rpa-k2', 'a pricing note on A');
  refused([row(A, 60, true, { pricing_note: '' }), row(B, 40, false)], 'rpa-k3', 'a blank pricing note on A');
  // A direct write by the table owner is refused too.
  refusedProbe(`UPDATE field_billing_defaults SET price_override_cents = 2000 WHERE field_id = '${GS}';`, new RegExp(CONSTRAINT));
  assert.equal(splits(), 'A:60.00:-:- B:40.00:-:-', 'the refused saves leave the splits as they were');
  const plain = okProbe(`${saveField([row(A, 70, true), row(B, 30, false)], 'rpa-k4')}
    RESET ROLE;
    SELECT string_agg(format('%s:%s', right(c.farm_name, 1), d.split_pct::numeric(5,2)), ' ' ORDER BY c.farm_name)
      FROM field_billing_defaults d JOIN customers c ON c.id = d.customer_id WHERE d.field_id = '${GS}';`);
  assert.equal(plain, 'A:70.00 B:30.00', 'a plain percent split still saves');
  console.log(`[after] save_field with a plain 70/30 split: saved (${plain})`);

  // AFTER: a saved draft's invoice share refuses a per-acre rate or a note, even from the table owner.
  for (const [label, set] of [['a $20.00/ac rate', 'price_per_acre_cents = 2000'], ['a pricing note', "pricing_note = 'Prepaid'"]]) {
    refusedProbe(`${asAdminClaims}UPDATE field_billing_defaults SET split_pct = CASE WHEN customer_id = '${A}' THEN 60 ELSE 40 END WHERE field_id = '${GS}';
      SELECT rpa.invoice();
      UPDATE invoice_shares s SET ${set} FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE s.invoice_id = i.id AND c.farm_name LIKE '[PROVER] RPA%';`, new RegExp(SHARE_CONSTRAINT));
    console.log(`[after] a saved draft's invoice share with ${label}: refused by ${SHARE_CONSTRAINT}`);
  }

  // AFTER: the 60/40 invoice bills both farms line by line, exactly as before (60/40 of $300.00).
  const plainAfter = okProbe(`${asAdminClaims}SELECT rpa.invoice();`);
  console.log(`[after] 60/40 field invoice: ${plainAfter}`);
  assert.equal(plainAfter, plainBefore, 'line-by-line billing on a split field is unchanged');
  assert.match(plainAfter, /^A:18000=\[[^\]]*@3000 x 6\.0000 = 18000[^\]]*\] B:12000=\[[^\]]*@3000 x 4\.0000 = 12000[^\]]*\]$/,
    'A pays 60% (6 Gal at $30) and B 40% (4 Gal at $30), each on a priced chemical line');

  // REVERSE (prover only): drops the constraint and changes no row; a second run refuses.
  stageText('reverse.sql', lf(REVERSE));
  const back = apply('reverse.sql');
  assert.equal(back.status, 0, back.output);
  assert.equal(constraintState(), 'absent');
  assert.equal(fingerprint(), rowsBefore);
  const again = apply('reverse.sql');
  assert.notEqual(again.status, 0);
  assert.match(again.output, /does not exist/);
  console.log('[reverse] drops both constraints, no row changed; a second run refuses');
  console.log('RETIRE_PER_ACRE_PRICING_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
