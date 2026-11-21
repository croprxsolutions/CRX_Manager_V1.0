#!/usr/bin/env node
/**
 * Real-schema proof for 20270129200000_grower_share_rep_needs_price_to_cover_cost (#1990 Sol HIGH, 20270120150000:1000).
 * Container setup and replay copied from prove-field-app-no-sold-unit-real-schema.mjs. Grower A owns field G (100 ac, 100%)
 * with a grower-share per-acre price; chemicals P and Q cost $5.00/Gal. 1 Gal/ac of P on 100 ac costs $500.00.
 *   BEFORE: a sales rep at $0.01/ac ($1.00 billed) saves $500.00 of P as a $0 grower-share line, approval under the rep.
 *   AFTER (Mason, 2026-11-20, "Reps if price covers cost"):
 *     - the rep at $0.01/ac is refused FIELD_APP_GROWER_SHARE_BELOW_COST, nothing saved, and the message carries no cost;
 *     - the rep at $5.00/ac ($500.00, exactly the cost) saves, one approval row under the rep; at $4.99/ac is refused;
 *     - P and Q at 0.6 Gal/ac each ($300.00 each) under $5.00/ac: each covered alone, $600.00 together: refused;
 *     - the rep re-saves a covered invoice (old approval rows point at deleted lines): still saves;
 *     - an admin at $0.01/ac saves, approval under the admin (unchanged).
 * Then a second apply stops at the preflight, the reverse restores the old body (the rep's $1 save works again), and
 * the candidate re-applies.
 *
 * Run: node scripts/smoke/prove-grower-share-rep-cover-real-schema.mjs   (needs Docker)
 * Prints GROWER_SHARE_REP_COVER_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
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
const NAME = REUSE || `crx-gsrc-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
// Shell commands below name the database; only a bare name is accepted (Sol r1).
if (!/^[a-z0-9_]+$/.test(DB)) throw new Error('CRX_PROVER_DB must be a bare database name (a-z, 0-9, _)');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270129200000_grower_share_rep_needs_price_to_cover_cost.sql');
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
// Also what the proof relies on: the field-app single save and the approval log.
const TOUCHED = /(_enforce_below_cost_line|_save_field_app_invoice_impl_20260714|below_cost_approvals)/i;
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




const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'grower-share-rep-cover-reverse.sql');
const id = (s) => `a6a6a6a6-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), REP = id('a2'), A = id('c1'), G = id('f1'), P = id('d1'), Q = id('d2');
const GUARD = 'public._enforce_below_cost_line()';
const body = () => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${GUARD}'::regprocedure;`);
const grants = () => scalar(`SELECT COALESCE(string_agg(g, ',' ORDER BY g), '-') FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
  FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${GUARD}'::regprocedure AND a.privilege_type = 'EXECUTE') x;`);
const OLD_BODY = '1069cd1451454030627b250db7b729d1';
const NEW_BODY = '0173da0b7f61a15353d4295edd4e9b13';

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'gsrc-admin@example.invalid', '{"full_name":"[PROVER] GSRC Admin","role":"admin"}'::jsonb),
    ('${REP}', 'gsrc-rep@example.invalid', '{"full_name":"[PROVER] GSRC Rep","role":"sales_rep"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active, assigned_sales_rep) VALUES ('${A}', '[PROVER] GSRC Farm A', 1, true, '${REP}');
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active) VALUES
      ('${P}', '[PROVER] GSRC chem P', 'GSRC-P', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 5, 30, 30, 30, true),
      ('${Q}', '[PROVER] GSRC chem Q', 'GSRC-Q', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 5, 30, 30, 30, true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES ('${G}', '${A}', '[PROVER] GSRC field G', 100, true);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES ('${G}', '${A}', 100, true, 1);`);
  // Test-only helper (prover database only): saves field G (100 ac applied) with the given chemicals as p_by through the
  // public RPC; returns invoice id | approvals (actor:cents) of the invoice's current $0 lines | billed per-acre cents.
  psql(`CREATE SCHEMA gsrc AUTHORIZATION postgres;
    CREATE FUNCTION gsrc.save(p_by uuid, p_chems jsonb, p_invoice uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$
    DECLARE v_res jsonb; v_inv uuid;
    BEGIN
      v_res := public.save_field_app_invoice(p_invoice,
        jsonb_build_object('invoice_date', ((now() AT TIME ZONE 'America/Chicago')::date)::text, 'salesman_id', p_by),
        jsonb_build_array(jsonb_build_object('field_id', '${G}', 'map_number', 1, 'total_acres', 100, 'planted_acres', 100,
          'applied_acres', 100, 'sort_order', 0)),
        (SELECT jsonb_agg(jsonb_build_object('description', 'GSRC ' || c.k, 'rate_per_acre', c.rate, 'rate_unit', 'Gal', 'unit_size', 'Gal',
           'cost_cents', 500, 'sort_order', c.n, 'manual_override', false, 'product_id', c.pid))
           FROM jsonb_to_recordset(p_chems) AS c(k text, rate numeric, n int, pid uuid)),
        p_by, NULL, 'gsrc-' || gen_random_uuid());
      v_inv := (v_res->'invoice_ids'->>0)::uuid;
      RETURN v_inv || '|' || COALESCE((SELECT string_agg(a.actor_user_id::text || ':' || a.total_shortfall_cents, ',' ORDER BY a.total_shortfall_cents)
          FROM below_cost_approvals a JOIN invoice_items ii ON ii.id = a.line_id
         WHERE a.operation = 'field_app_grower_share' AND ii.invoice_id = v_inv), '-')
        || '|' || (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_inv AND acres IS NOT NULL AND NOT is_application_fee);
    END $f$;`);
  console.log('[prover] committed test rows: an admin, a sales rep (assigned to grower A), field G (100 ac, A 100%,'
    + ' grower-share price $0.01/ac), chemicals P and Q at $5.00/Gal cost');
}
const as = (uid) => `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\n`;
const rate = (cents) => `UPDATE public.field_billing_defaults SET price_override_cents = ${cents} WHERE field_id = '${G}';\n`;
const ONE = `'[{"k":"P","rate":1,"n":0,"pid":"${P}"}]'::jsonb`;
const TWO = `'[{"k":"P","rate":0.6,"n":0,"pid":"${P}"},{"k":"Q","rate":0.6,"n":1,"pid":"${Q}"}]'::jsonb`;
// #2068 Sol round 2: 100 lines of 0.0029 Gal at $5.00 cost $0.0145 each ($1.45 together) but round to $0.01 each.
const SPLIT = `'${JSON.stringify(Array.from({ length: 100 }, (_, n) => ({ k: `S${n}`, rate: 0.000029, n, pid: P })))}'::jsonb`;
const save = (uid, cents, chems) => `${rate(cents)}${as(uid)}SELECT gsrc.save('${uid}', ${chems});`;
const BELOW = /FIELD_APP_GROWER_SHARE_BELOW_COST: the grower's per-acre price on this invoice does not cover the cost/;
const parts = (out) => out.split('|');
// The rep's covered invoice is saved, then re-saved by the rep at <cents>/ac with the same chemical.
const resave = (cents) => `${rate(500)}${as(REP)}SELECT split_part(gsrc.save('${REP}', ${ONE}), '|', 1) AS inv \\gset
${rate(cents)}SELECT gsrc.save('${REP}', ${ONE}, :'inv'::uuid);
SELECT count(*) FROM below_cost_approvals WHERE operation = 'field_app_grower_share';`;

async function main() {
  if (REUSE) {
    assert.match(REUSE, /^crx-[a-z0-9-]+$/, 'CRX_PROVER_REUSE must name a kept prover container (crx-...)');
    assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', REUSE]).stdout.trim(), 'none', 'CRX_PROVER_REUSE must be a network-less prover container');
    assert.match(DB, /^gsrc_run_[a-z0-9_]+$/, 'CRX_PROVER_REUSE needs CRX_PROVER_DB naming a fresh copy called gsrc_run_<n>');
  } else buildContainer();
  assert.equal(body(), OLD_BODY, 'the replayed guard is not the body the candidate expects');
  assert.equal(scalar(`SELECT count(*) FROM pg_namespace WHERE nspname = 'gsrc';`), '0', 'this database was already used by a proof run: make a fresh copy');
  const guardGrants = grants();
  seed();

  // BEFORE: the hole.
  const before = parts(okProbe(save(REP, 1, ONE)));
  assert.equal(before[1], `${REP}:50000`, `before: the rep's $1.00 save should log $500.00 under the rep (got ${before.join('|')})`);
  assert.equal(before[2], '100');
  console.log(`[before] a sales rep at $0.01/ac bills $1.00 and saves $500.00 of chemical P as a $0 grower-share line; approval logged under the rep (${before[1]})`);

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.equal(body(), NEW_BODY);
  assert.equal(grants(), guardGrants, 'the guard grants must not change');
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /GROWER_SHARE_REP_COVER_PREFLIGHT/);
  console.log(`[case] the candidate applies (EXECUTE unchanged: ${guardGrants}); a second apply stops at its preflight`);

  // AFTER.
  const refused = probe(save(REP, 1, ONE));
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, BELOW);
  const errorLine = refused.output.split(/\r?\n/).find((l) => l.includes('FIELD_APP_GROWER_SHARE_BELOW_COST')) ?? '';
  assert.doesNotMatch(errorLine, /\d|\$|locked_unit_cost/, 'the refusal must not carry the cost');
  refusedProbe(save(REP, 499, ONE), BELOW);
  const covered = parts(okProbe(save(REP, 500, ONE)));
  assert.equal(covered[1], `${REP}:50000`);
  assert.equal(covered[2], '50000');
  console.log('[after] the rep at $0.01/ac and at $4.99/ac is refused FIELD_APP_GROWER_SHARE_BELOW_COST (no cost in the message);'
    + ` at $5.00/ac ($500.00 = the cost) it saves, approval under the rep (${covered[1]})`);

  refusedProbe(save(REP, 500, TWO), BELOW);
  const twoAdmin = parts(okProbe(save(ADMIN, 500, TWO)));
  assert.equal(twoAdmin[1], `${ADMIN}:30000,${ADMIN}:30000`);
  console.log('[after] P and Q at $300.00 each under $5.00/ac ($500.00): the rep is refused ($600.00 together); an admin saves both');

  refusedProbe(save(REP, 1, SPLIT), BELOW);
  assert.equal(parts(okProbe(save(REP, 2, SPLIT)))[1].split(',').length, 100);
  console.log('[after] one chemical split into 100 lines of $0.0145 ($1.45, each rounding to $0.01): the rep at $0.01/ac ($1.00) is refused; at $0.02/ac ($2.00) it saves');

  assert.equal(okProbe(resave(500)), '2', 'the first save and the re-save each log one row');
  refusedProbe(resave(1), BELOW);
  console.log('[after] the rep re-saves a covered invoice (old approvals point at deleted lines): saves; re-saving it at $0.01/ac: refused');

  const admin = parts(okProbe(save(ADMIN, 1, ONE)));
  assert.equal(admin[1], `${ADMIN}:50000`);
  console.log(`[after] an admin at $0.01/ac still saves, approval under the admin (${admin[1]})`);

  stageText('reverse.sql', lf(REVERSE));
  const rev = apply('reverse.sql');
  assert.equal(rev.status, 0, rev.output);
  assert.equal(body(), OLD_BODY, 'the reverse must restore the old body');
  assert.equal(grants(), guardGrants);
  assert.equal(parts(okProbe(save(REP, 1, ONE)))[1], `${REP}:50000`, 'after the reverse the old behaviour returns');
  const again = apply('candidate.sql');
  assert.equal(again.status, 0, again.output);
  assert.equal(body(), NEW_BODY);
  refusedProbe(save(REP, 1, ONE), BELOW);
  console.log("[case] the reverse restores the old body (the rep's $1.00 save works again); the candidate re-applies and refuses it");
  console.log('GROWER_SHARE_REP_COVER_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
