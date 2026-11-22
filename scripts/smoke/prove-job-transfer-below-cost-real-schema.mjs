#!/usr/bin/env node
/**
 * Real-schema proof for 20270207125000_job_transfer_below_cost_whole_line (contract
 * docs/plans/2026-11-21-job-transfer-below-cost-CONTRACT.md). Container setup and replay copied from
 * prove-field-app-refuses-payer-change-real-schema.mjs. Completed spray jobs go through transfer_job_to_invoice as a
 * signed-in admin, each case rolled back. A chemical stocked by the Gal costs $30; a dry one by the Lb costs $16:
 *   BEFORE: 3 fl oz, half a gallon (64 fl oz, or 0.5 Gal at cost), 8 oz dry, a customer-supplied line and a split small
 *           line are refused; 10 Gal sold for $250 total passes.
 *   AFTER:  those lines bill at the same cents with no approval row; one Gal at $25, 10 Gal at $250, 64 fl oz at $14.72
 *           and 8 oz dry at $4.80 stop (JOB_LINE_BELOW_COST, no cost shown, job stays completed); a unit that does not
 *           convert is judged as before; a below-cost line written outside the transfer is still refused. A second
 *           apply stops at the preflight; grants unchanged; the rollback script restores both bodies.
 *
 * Run: node scripts/smoke/prove-job-transfer-below-cost-real-schema.mjs   (needs Docker)
 * Prints JOB_TRANSFER_BELOW_COST_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
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
const NAME = REUSE || `crx-jbc-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
// Shell commands below name the database; only a bare name is accepted (Sol r1).
if (!/^[a-z0-9_]+$/.test(DB)) throw new Error('CRX_PROVER_DB must be a bare database name (a-z, 0-9, _)');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270207125000_job_transfer_below_cost_whole_line.sql');
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
const TOUCHED = /(_transfer_job_to_invoice_intent_impl_20260908|_enforce_below_cost_line|_job_transfer_line_clears_cost|field_app_priced_quantity|safe_cents_qty|crx_below_cost_operation)/i;
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

const id = (s) => `b5b5b5b5-2207-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), A = id('c1'), B = id('c2'), G = id('f1'), F = id('f2'), P = id('d1'), NC = id('d2'), DRY = id('d3');
const IMPL = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)';
const WRAPPER = 'public.transfer_job_to_invoice(uuid,uuid,text)';
const WALL = 'public._enforce_below_cost_line()';
const HELPER = 'public._job_transfer_line_clears_cost_20270207(uuid,text,numeric,text,bigint,boolean)';
const OLD_BODY = 'a54e3e6a3a2b920e9bcd1a350cd92423';
const OLD_WALL = '5fa0a5f975dc2a84b3c6599a84b8cc55';
const md5Of = (sig) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
const acl = (sig) => scalar(`SELECT coalesce(proacl::text, '-') FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
const grants = (sig) => scalar(`SELECT COALESCE(string_agg(g, ',' ORDER BY g), '-') FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
  FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${sig}'::regprocedure AND a.privilege_type = 'EXECUTE') x;`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'jbc-admin@example.invalid', '{"full_name":"[PROVER] JBC Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active) VALUES ('${A}', '[PROVER] JBC Farm A', 1, true), ('${B}', '[PROVER] JBC Farm B', 1, true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active) VALUES
      ('${P}', '[PROVER] JBC chem', 'JBC-1', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 30, 50, 50, 50, true),
      ('${NC}', '[PROVER] JBC grower chem', 'JBC-2', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', NULL, 0, 0, 0, true),
      ('${DRY}', '[PROVER] JBC dry', 'JBC-3', 'dry', 'Lb', 'Lb', 'Lb', 'Lb', 16, 20, 20, 20, true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
      ('${G}', '${A}', '[PROVER] JBC field A', 100, true), ('${F}', '${A}', '[PROVER] JBC field A+B', 100, true);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES
      ('${G}', '${A}', 100, true, NULL), ('${F}', '${A}', 60, true, NULL), ('${F}', '${B}', 40, false, NULL);`);
  // Test-only helpers (prover database only). jbc.job writes a completed job: 10 acres of the field and one chemical
  // line of p_qty p_unit at p_price (cost p_cost) per p_unit; the stored job total is that line's total.
  psql(`CREATE SCHEMA jbc AUTHORIZATION supabase_admin;
    CREATE FUNCTION jbc.job(p_customer uuid, p_field uuid, p_unit text, p_qty numeric, p_price bigint, p_cost bigint,
                            p_supplied boolean DEFAULT false, p_product uuid DEFAULT '${P}')
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
    DECLARE v_j uuid := gen_random_uuid();
    BEGIN
      INSERT INTO jobs (id, job_number, customer_id, status, job_date, total_acres, total_cost_cents, total_price_cents)
      VALUES (v_j, 'JBC-' || left(v_j::text, 8), p_customer, 'completed', (now() AT TIME ZONE 'America/Chicago')::date, 10,
              CASE WHEN p_supplied THEN 0 ELSE safe_cents_qty(p_cost, p_qty) END,
              CASE WHEN p_supplied THEN 0 ELSE safe_cents_qty(p_price, p_qty) END);
      INSERT INTO job_fields (job_id, field_id, acres_to_treat) VALUES (v_j, p_field, 10);
      INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, cost_per_unit_cents, customer_supplied)
      VALUES (v_j, p_product, p_qty, p_unit, p_qty / 10, p_unit, CASE WHEN p_supplied THEN 0 ELSE p_price END,
              CASE WHEN p_supplied THEN 0 ELSE p_cost END, p_supplied);
      RETURN v_j;
    END $f$;
    -- Every invoice the job made, as farm:total:share sum:line amount/cost/price source, ordered by farm.
    CREATE FUNCTION jbc.billed(p_job uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT COALESCE(string_agg(format('%s:%s:%s:%s', right(c.farm_name, 1), i.total_amount_cents,
          (SELECT COALESCE(sum(s.amount_cents), 0) FROM invoice_shares s WHERE s.invoice_id = i.id),
          (SELECT string_agg(x.extended_cents || '/' || x.cost_cents || '/' || COALESCE(x.price_source, 'null'), ',' ORDER BY x.sort_order)
             FROM invoice_items x WHERE x.invoice_id = i.id)), ' ' ORDER BY c.farm_name), '-')
        FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.job_id = p_job AND i.deleted_at IS NULL $f$;
    CREATE FUNCTION jbc.approvals() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT count(*) FROM below_cost_approvals $f$;
    GRANT USAGE ON SCHEMA jbc TO authenticated;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA jbc TO authenticated;`, { user: 'supabase_admin' });
  console.log('[prover] committed test rows: farms A and B; field A (A 100%), field A+B (A 60%, B 40%); a chemical stocked by the Gal at cost $30; a grower product with no cost; a dry product by the Lb at $16');
}
// A rolled-back case, as the signed-in admin through the app's own transfer_job_to_invoice.
const asAdmin = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;\n`;
const transfer = (job) => `${asAdmin}
CREATE TEMP TABLE j AS SELECT ${job} AS id;
SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jbc-' || gen_random_uuid());
SELECT jbc.billed((SELECT id FROM j)) || ' | approvals=' || jbc.approvals() || ' | ' || (SELECT status FROM jobs WHERE id = (SELECT id FROM j));`;
const job = (unit, qty, price, cost = 3000, field = G, supplied = false, product = P) =>
  `jbc.job('${A}', '${field}', '${unit}', ${qty}, ${price}, ${cost}, ${supplied}, '${product}')`;
const CASES = {
  // 3 fl oz at 39c/fl oz = $1.17; cost of 3 fl oz = 3/128 Gal x $30 = 70.3c.
  small3floz: transfer(job('fl oz', 3, 39, 23)),
  // Half a gallon: 64 fl oz at 30c ($19.20); 0.5 Gal at $30 ($15.00, exactly the cost); 64 fl oz at 23c ($14.72, under $15).
  half64floz: transfer(job('fl oz', 64, 30, 23)),
  halfGalAtCost: transfer(job('Gal', 0.5, 3000)),
  half64flozBelow: transfer(job('fl oz', 64, 23, 23)),
  supplied: transfer(job('Gal', 10, 0, 0, G, true)),
  suppliedNoCost: transfer(job('Gal', 10, 0, 0, G, true, NC)),
  // One Gal at $25 against $30 cost; ten Gal at $25 ($250) against $300 of cost.
  fullBelow: transfer(job('Gal', 1, 2500)),
  tenBelow: transfer(job('Gal', 10, 2500)),
  normal: transfer(job('Gal', 10, 5000)),
  splitSmall: transfer(job('fl oz', 3, 39, 23, F)),
  // Dry: 8 oz of a $16/Lb product costs $8.00; at $1.10/oz ($8.80) it bills, at 60c/oz ($4.80) it stops.
  dryOk: transfer(job('oz', 8, 110, 100, G, false, DRY)),
  dryBelow: transfer(job('oz', 8, 60, 100, G, false, DRY)),
  // Ea does not convert to Gal: judged by the wall exactly as before.
  eaLarge: transfer(job('Ea', 10, 5000)),
  eaSmall: transfer(job('Ea', 1, 100)),
};
// The wall itself, outside the transfer: a below-cost line written straight into a transfer-made draft invoice.
const directLine = (ctx, product, qty) => `${asAdmin}
CREATE TEMP TABLE j AS SELECT ${job('Gal', 10, 5000)} AS id;
SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jbc-' || gen_random_uuid());
RESET ROLE;
SELECT set_config('app.crx_below_cost_operation', '${ctx}', true), set_config('crx.job_transfer_product', '${product}', true);
INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, cost_cents, sort_order, is_application_fee)
SELECT i.id, '${P}', 'direct', ${qty}, 'Gal', 100, ${qty} * 100, 0, 99, false FROM invoices i WHERE i.job_id = (SELECT id FROM j);
SELECT 'written';`;

async function main() {
  if (REUSE) {
    assert.match(REUSE, /^crx-[a-z0-9-]+$/, 'CRX_PROVER_REUSE must name a kept prover container (crx-...)');
    assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', REUSE]).stdout.trim(), 'none', 'CRX_PROVER_REUSE must be a network-less prover container');
    assert.match(DB, /^jbc_run_[a-z0-9_]+$/, 'CRX_PROVER_REUSE needs CRX_PROVER_DB naming a fresh copy called jbc_run_<n>');
  } else buildContainer();
  assert.equal(md5Of(IMPL), OLD_BODY, 'the replayed transfer body is not the one the candidate expects');
  assert.equal(md5Of(WALL), OLD_WALL, 'the replayed wall body is not the one the candidate expects');
  assert.equal(scalar(`SELECT (SELECT count(*) FROM auth.users WHERE id = '${ADMIN}') + (SELECT count(*) FROM pg_namespace WHERE nspname = 'jbc');`),
    '0', 'this database was already used by a proof run: make a fresh copy');
  const implGrants = grants(IMPL), wrapperGrants = grants(WRAPPER), wallAcl = acl(WALL);
  seed();

  // BEFORE: every small line is refused; ten Gal below cost passes.
  const refusedBefore = { small3floz: /BELOW_COST_CONTEXT_REQUIRED/, half64floz: /BELOW_COST_CONTEXT_REQUIRED/,
    halfGalAtCost: /BELOW_COST_CONTEXT_REQUIRED/, supplied: /BELOW_COST_CONTEXT_REQUIRED/, suppliedNoCost: /COST_BASIS_REQUIRED/,
    fullBelow: /BELOW_COST_CONTEXT_REQUIRED/, splitSmall: /BELOW_COST_CONTEXT_REQUIRED/, dryOk: /BELOW_COST_CONTEXT_REQUIRED/,
    eaSmall: /BELOW_COST_CONTEXT_REQUIRED/ };
  for (const [k, re] of Object.entries(refusedBefore)) { refusedProbe(CASES[k], re); console.log(`[before] ${k}: refused ${re.source}`); }
  const before = Object.fromEntries(['tenBelow', 'normal', 'eaLarge'].map((k) => [k, okProbe(CASES[k])]));
  for (const [k, v] of Object.entries(before)) console.log(`[before] ${k}: ${v}`);
  assert.equal(before.tenBelow, 'A:25000:25000:25000/30000/null | approvals=0 | invoiced', 'before: 10 Gal sold for $250 against $300 of cost passed the wall');
  refusedProbe(directLine('', '', 1), /BELOW_COST_CONTEXT_REQUIRED/);

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.notEqual(md5Of(IMPL), OLD_BODY);
  assert.notEqual(md5Of(WALL), OLD_WALL);
  assert.equal(grants(IMPL), implGrants, 'the transfer body grants must not change');
  assert.equal(grants(WRAPPER), wrapperGrants, 'the public wrapper grants must not change');
  assert.equal(acl(WALL), wallAcl, 'the wall ACL must not change');
  assert.equal(grants(HELPER), 'postgres', 'the new helper is executable by no API role');
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /JOB_BELOW_COST_PREFLIGHT/);
  console.log(`[case] the candidate applies (transfer EXECUTE unchanged: ${implGrants}; wrapper: ${wrapperGrants}; wall ACL unchanged; helper: postgres only); a second apply stops at its preflight`);

  const ok = ' | approvals=0 | invoiced';
  const after = (k, expected, why) => { const v = okProbe(CASES[k]); console.log(`[after] ${k}: ${v}`); assert.equal(v, expected + ok, why); };
  after('small3floz', 'A:117:117:117/69/null', '3 fl oz at $1.17 bills (cost of 3 fl oz is 70.3c)');
  after('half64floz', 'A:1920:1920:1920/1472/null', '64 fl oz (half a gallon) at $19.20 bills');
  after('halfGalAtCost', 'A:1500:1500:1500/1500/null', 'half a gallon exactly at cost bills');
  after('supplied', 'A:0:0:0/0/manual', 'a customer-supplied line bills at $0');
  after('suppliedNoCost', 'A:0:0:0/0/manual', 'a customer-supplied product with no cost bills at $0');
  after('dryOk', 'A:880:880:880/800/null', '8 oz of a dry product at $8.80 bills');
  after('normal', before.normal.replace(ok, ''), 'a normal line: unchanged');
  after('eaLarge', before.eaLarge.replace(ok, ''), 'a unit that does not convert: judged by the wall as before');
  const split = okProbe(CASES.splitSmall);
  console.log(`[after] splitSmall: ${split}`);
  assert.match(split, /^A:(\d+):\1:\1\/\d+\/null B:(\d+):\2:\2\/\d+\/null \| approvals=0 \| invoiced$/, 'each owner: header = share = their line');
  const [, a, b] = /^A:(\d+).* B:(\d+)/.exec(split);
  assert.equal(Number(a) + Number(b), 117, 'the owner shares add up to the whole line');
  assert.deepEqual([Number(a), Number(b)], [70, 47], 'A carries 60%, B 40% of $1.17');
  for (const k of ['fullBelow', 'tenBelow', 'half64flozBelow']) {
    refusedProbe(CASES[k], /JOB_LINE_BELOW_COST: \[PROVER\] JBC chem is priced below its cost on this job\. Nothing was invoiced/);
    assert.doesNotMatch(probe(CASES[k]).output, /\b(3000|1500|30\.00|15\.00)\b/, 'the refusal never states the cost');
    console.log(`[after] ${k}: refused JOB_LINE_BELOW_COST, nothing billed`);
  }
  refusedProbe(CASES.dryBelow, /JOB_LINE_BELOW_COST: \[PROVER\] JBC dry/);
  console.log('[after] dryBelow: refused JOB_LINE_BELOW_COST');
  refusedProbe(CASES.eaSmall, /BELOW_COST_CONTEXT_REQUIRED/);
  console.log('[after] eaSmall: refused BELOW_COST_CONTEXT_REQUIRED, as before');
  // The new context gives nothing outside the transfer's own line: no context, a quantity-2 line, or another product.
  refusedProbe(directLine('', '', 1), /BELOW_COST_CONTEXT_REQUIRED/);
  refusedProbe(directLine('field_app_job_transfer', P, 2), /BELOW_COST_CONTEXT_REQUIRED/);
  refusedProbe(directLine('field_app_job_transfer', DRY, 1), /BELOW_COST_CONTEXT_REQUIRED/);
  console.log('[after] a below-cost invoice line written outside the transfer: refused with no context, and with the new context at quantity 2 or for another product');

  // Rollback restores both bodies and drops the helper; the old refusals come back.
  stageText('reverse.sql', lf(path.join(ROOT, 'scripts', 'smoke', 'job-transfer-below-cost-reverse.sql')));
  const back = apply('reverse.sql');
  assert.equal(back.status, 0, back.output);
  assert.equal(md5Of(IMPL), OLD_BODY);
  assert.equal(md5Of(WALL), OLD_WALL);
  assert.equal(acl(WALL), wallAcl);
  assert.equal(grants(IMPL), implGrants);
  assert.equal(scalar(`SELECT to_regprocedure('${HELPER}') IS NULL;`), 't');
  refusedProbe(CASES.small3floz, /BELOW_COST_CONTEXT_REQUIRED/);
  console.log('[rollback] both bodies and grants restored, helper dropped; 3 fl oz is refused again');
  console.log('JOB_TRANSFER_BELOW_COST_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
