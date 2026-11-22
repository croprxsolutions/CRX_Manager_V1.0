#!/usr/bin/env node
/**
 * Real-schema proof for 20270207130000_job_transfer_bills_sent_quote_price (contract
 * docs/plans/2026-11-21-job-transfer-bills-sent-quote-price-CONTRACT.md). Container setup and replay copied from
 * prove-field-app-refuses-payer-change-real-schema.mjs. Completed spray jobs (10 Gal of a chemical listed at $50/Gal, typed
 * straight into Scheduling) go through transfer_job_to_invoice as a signed-in admin, each case rolled back:
 *   BEFORE (with 20270207125000 replayed): a field with a sent $42 quote still bills list price ($500.00).
 *   AFTER:  the sent quote bills ($420.00, price_source quoted; header = shares = lines); no quote, a draft or declined
 *           quote, or another grower's quote bills list ($500.00); a quote changed and not re-sent, or a job line in Lb
 *           against a per-Gal quote, stops with nothing billed; a paying grower other than the job's customer stops only
 *           when their quote sets the price (Q2); a customer-supplied line bills $0; a 60/40 two-owner job bills the
 *           quoted owner from their quote and the other from the job price; three equal owners split an exact half cent
 *           up; a dry product's oz converts to Lb; the below-cost check judges the quoted price; a completed job's typed
 *           marks can't change; quotes are locked before the job and the fields after it (two sessions); a repeated key
 *           returns one invoice. A second apply stops at "already applied"; the transfer keeps its grants.
 *
 * Run: node scripts/smoke/prove-job-transfer-sent-quote-price-real-schema.mjs   (needs Docker)
 * Prints JOB_TRANSFER_SENT_QUOTE_PRICE_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Iterating: CRX_PROVER_REUSE=<kept container> CRX_PROVER_DB=<a copy of its replayed database> skips the replay.
const REUSE = process.env.CRX_PROVER_REUSE;
const NAME = REUSE || `crx-jtq-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
// Shell commands below name the database; only a bare name is accepted (Sol r1).
if (!/^[a-z0-9_]+$/.test(DB)) throw new Error('CRX_PROVER_DB must be a bare database name (a-z, 0-9, _)');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270207130000_job_transfer_bills_sent_quote_price.sql');
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
const TOUCHED = /(_transfer_job_to_invoice_intent_impl_20260908|_field_app_sent_quote_price_cents|_field_app_quote_eligible|_assert_quote_prices_as_sent|_unit_matches_stock_unit|_job_transfer_quote_price_cents|_job_transfer_typed_price_warning|_save_job_cost_step2_impl|price_typed)/i;
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

const id = (s) => `a5a5a5a5-2207-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), A = id('c1'), B = id('c2'), C = id('c3'), G = id('f1'), F = id('f2'), P = id('d1');
const D = id('d2'), K = id('d3'), H1 = id('f3'), H2 = id('f4'), H3 = id('f5');
const IMPL = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)';
const WRAPPER = 'public.transfer_job_to_invoice(uuid,uuid,text)';
const HELPER = 'public._job_transfer_quote_price_cents_20270207(uuid,text,text,text,uuid[],uuid,date)';
const WARN = 'public._job_transfer_typed_price_warning_20270207(uuid,text,text,text,uuid[],uuid,date,bigint,text)';
const SAVE_IMPL = 'public._save_job_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,text)';
const OLD_BODY = 'd209538774abe0da783a5cb9c4dfd5a8';  // 20270207125000 (below-cost whole line)
const body = () => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${IMPL}'::regprocedure;`);
const grants = (sig) => scalar(`SELECT COALESCE(string_agg(g, ',' ORDER BY g), '-') FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
  FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${sig}'::regprocedure AND a.privilege_type = 'EXECUTE') x;`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'jtq-admin@example.invalid', '{"full_name":"[PROVER] JTQ Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active) VALUES ('${A}', '[PROVER] JTQ Farm A', 1, true), ('${B}', '[PROVER] JTQ Farm B', 1, true),
      ('${C}', '[PROVER] JTQ Farm C', 1, true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active) VALUES
      ('${P}', '[PROVER] JTQ chem', 'JTQ-1', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 30, 50, 50, 50, true),
      ('${D}', '[PROVER] JTQ dry', 'JTQ-2', 'dry', 'Lb', 'Lb', 'Lb', 'Lb', 10, 50, 50, 50, true),
      ('${K}', '[PROVER] JTQ cheap', 'JTQ-3', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 1, 2, 2, 2, true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
      ('${G}', '${A}', '[PROVER] JTQ field A', 100, true), ('${F}', '${A}', '[PROVER] JTQ field A+B', 100, true),
      ('${H1}', '${A}', '[PROVER] JTQ third A', 100, true), ('${H2}', '${B}', '[PROVER] JTQ third B', 100, true),
      ('${H3}', '${C}', '[PROVER] JTQ third C', 100, true);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES
      ('${G}', '${A}', 100, true, NULL), ('${F}', '${A}', 60, true, NULL), ('${F}', '${B}', 40, false, NULL),
      ('${H1}', '${A}', 100, true, NULL), ('${H2}', '${B}', 100, true, NULL), ('${H3}', '${C}', 100, true, NULL);`);
  // Test-only helpers (prover database only). jtq.quote writes a quote with one section on the field and one line in
  // Gal (and, when sent, a trusted V1 snapshot listing that line, its unit and its field), as a send leaves it.
  // jtq.job writes a completed job: 10 acres of the field, 10 of the chemical at $50 (cost $30) per unit.
  psql(`CREATE SCHEMA jtq AUTHORIZATION supabase_admin;
    CREATE FUNCTION jtq.quote(p_customer uuid, p_field uuid, p_price numeric, p_status text, p_sent boolean,
                              p_product uuid DEFAULT '${P}', p_unit text DEFAULT 'Gal')
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
    DECLARE v_q uuid := gen_random_uuid(); v_s uuid := gen_random_uuid(); v_i uuid := gen_random_uuid();
    BEGIN
      INSERT INTO quotes (id, quote_number, customer_id, created_by, status, expires_at, created_at)
      VALUES (v_q, 'JTQ-' || left(v_q::text, 8), p_customer, '${ADMIN}', p_status, NULL, now() - interval '30 days');
      INSERT INTO quote_sections (id, quote_id, section_name, sort_order, field_id) VALUES (v_s, v_q, 'JTQ', 0, p_field);
      INSERT INTO quote_items (id, quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit, unit_size)
      VALUES (v_i, v_q, v_s, p_product, 0, p_price, 10, 10, 1, p_unit, p_unit);
      IF p_sent THEN
        INSERT INTO quote_versions (quote_id, version_number, sent_by, snapshot_data, restore_trusted_at)
        VALUES (v_q, 1, '${ADMIN}', jsonb_build_object('quote', jsonb_build_object('customer_id', p_customer),
          'sections', jsonb_build_array(jsonb_build_object('field_id', p_field, 'items', jsonb_build_array(jsonb_build_object(
            'quote_item_id', v_i, 'product_id', p_product, 'price_per_unit', p_price, 'unit_size', p_unit))))), now());
      END IF;
      RETURN v_q;
    END $f$;
    -- A price change after the send with no resend.
    CREATE FUNCTION jtq.reprice(p_quote uuid, p_price numeric) RETURNS void LANGUAGE sql SECURITY DEFINER
      SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
      UPDATE quote_items SET price_per_unit = p_price WHERE quote_id = p_quote $f$;
    CREATE FUNCTION jtq.job(p_customer uuid, p_field uuid, p_unit text DEFAULT 'Gal', p_supplied boolean DEFAULT false,
                            p_total bigint DEFAULT 50000, p_qty numeric DEFAULT 10,
                            p_cost bigint DEFAULT 3000, p_price bigint DEFAULT 5000, p_product uuid DEFAULT '${P}')
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
    DECLARE v_j uuid := gen_random_uuid();
    BEGIN
      INSERT INTO jobs (id, job_number, customer_id, status, job_date, total_acres, total_cost_cents, total_price_cents)
      VALUES (v_j, 'JTQ-' || left(v_j::text, 8), p_customer, 'completed', (now() AT TIME ZONE 'America/Chicago')::date, 10,
              CASE WHEN p_supplied THEN 0 ELSE 30000 END, p_total);
      INSERT INTO job_fields (job_id, field_id, acres_to_treat) VALUES (v_j, p_field, 10);
      INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, cost_per_unit_cents, customer_supplied)
      VALUES (v_j, p_product, p_qty, p_unit, 1, p_unit, CASE WHEN p_supplied THEN 0 ELSE p_price END, CASE WHEN p_supplied THEN 0 ELSE p_cost END, p_supplied);
      RETURN v_j;
    END $f$;
    -- Every invoice the job made, as farm:total:share sum:line amounts/price sources, ordered by farm.
    CREATE FUNCTION jtq.billed(p_job uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT COALESCE(string_agg(format('%s:%s:%s:%s', right(c.farm_name, 1), i.total_amount_cents,
          (SELECT COALESCE(sum(s.amount_cents), 0) FROM invoice_shares s WHERE s.invoice_id = i.id),
          (SELECT string_agg(x.extended_cents || '/' || COALESCE(x.price_source, 'null'), ',' ORDER BY x.sort_order)
             FROM invoice_items x WHERE x.invoice_id = i.id)), ' ' ORDER BY c.farm_name), '-')
        FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.job_id = p_job AND i.deleted_at IS NULL $f$;
    -- Marks the job's line as typed by hand at p_cents per unit (plpgsql: the column exists only after the candidate).
    CREATE FUNCTION jtq.typed(p_job uuid, p_cents bigint) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
      BEGIN UPDATE job_chemicals SET price_typed = true, price_per_unit_cents = p_cents WHERE job_id = p_job; RETURN p_job; END $f$;
    -- Another treated field on a job.
    CREATE FUNCTION jtq.addfield(p_job uuid, p_field uuid, p_acres numeric) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
      BEGIN INSERT INTO job_fields (job_id, field_id, acres_to_treat) VALUES (p_job, p_field, p_acres); RETURN p_job; END $f$;
    GRANT USAGE ON SCHEMA jtq TO authenticated;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA jtq TO authenticated;`, { user: 'supabase_admin' });
  console.log('[prover] committed test rows: farms A and B; field A (A 100%), field A+B (A 60%, B 40%); a chemical sold by the Gal, list $50, cost $30');
}
// A rolled-back case, as the signed-in admin through the app's own transfer_job_to_invoice: optional setup (quotes),
// a job, then Create Invoice; returns what was billed.
const asAdmin = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;\n`;
const transfer = (job, setup = '') => `${asAdmin}${setup}
CREATE TEMP TABLE j AS SELECT ${job} AS id;
SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jtq-' || gen_random_uuid());
SELECT jtq.billed((SELECT id FROM j));`;
const q = (cust, field, price, status = 'sent', sent = true, product = P, unit = 'Gal') =>
  `SELECT jtq.quote('${cust}', '${field}', ${price}, '${status}', ${sent}, '${product}', '${unit}');\n`;
// Rule 2 (typed price): Create Invoice's own result carries price_warnings.
const typedTransfer = (job, setup = '') => `${asAdmin}${setup}
CREATE TEMP TABLE j AS SELECT ${job} AS id;
CREATE TEMP TABLE r AS SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jtq-' || gen_random_uuid()) AS res;
SELECT jtq.billed((SELECT id FROM j)) || ' | ' || COALESCE((SELECT res->'price_warnings' FROM r)::text, 'none');`;
const CASES = {
  quoted: transfer(`jtq.job('${A}', '${G}')`, q(A, G, 42)),
  noQuote: transfer(`jtq.job('${A}', '${G}')`),
  draft: transfer(`jtq.job('${A}', '${G}')`, q(A, G, 42, 'draft', false)),
  declined: transfer(`jtq.job('${A}', '${G}')`, q(A, G, 42, 'declined', true)),
  othersQuote: transfer(`jtq.job('${A}', '${G}')`, q(B, G, 42)),
  oddTotal: transfer(`jtq.job('${A}', '${G}', 'Gal', false, 55000)`, q(A, G, 42)),
  payerNotJobCustomer: transfer(`jtq.job('${B}', '${G}')`, q(A, G, 42)),
  // 20270207125000 kept (Sol round 1): a deleted job, and a deleted blend ticket whose invoice is live, are refused.
  deletedJob: `${asAdmin}${q(A, G, 42)}CREATE TEMP TABLE j AS SELECT jtq.job('${A}', '${G}') AS id;
RESET ROLE;
SET LOCAL session_replication_role = replica;
UPDATE jobs SET deleted_at = now() WHERE id = (SELECT id FROM j);
SET LOCAL session_replication_role = origin;
${asAdmin}SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jtq-' || gen_random_uuid());`,
  payerNoQuote: transfer(`jtq.job('${B}', '${G}')`),
  // A zero-acre field with no quote does not block the treated field's quote (Sol MED).
  zeroAcreField: transfer(`jtq.addfield(jtq.job('${A}', '${G}'), '${H1}', 0)`, q(A, G, 42)),
  // Sol #5: the below-cost check judges the billed (quoted) price on the whole quantity.
  smallQuoted: transfer(`jtq.job('${A}', '${G}', 'Gal', false, 3000, 0.6)`, q(A, G, 42)),
  quoteBelowCost: transfer(`jtq.job('${A}', '${G}')`, q(A, G, 20)),
  // Sol MED: a dry product's "oz" is a dry ounce: 32 oz = 2 Lb at a $40/Lb quote.
  dryOz: transfer(`jtq.job('${A}', '${G}', 'oz', false, 50000, 32, 63, 313, '${D}')`, q(A, G, 40, 'sent', true, D, 'Lb')),
  // Sol MED: three equal owners, 10.01 Gal at their own $1.50 quotes = exactly 500.5 cents each, rounded up once.
  thirds: transfer(`jtq.addfield(jtq.addfield(jtq.job('${A}', '${H1}', 'Gal', false, 2002, 10.01, 100, 200, '${K}'), '${H2}', 10), '${H3}', 10)`,
    q(A, H1, 1.5, 'sent', true, K) + q(B, H2, 1.5, 'sent', true, K) + q(C, H3, 1.5, 'sent', true, K)),
  split: transfer(`jtq.job('${A}', '${F}')`, q(A, F, 42)),
  supplied: transfer(`jtq.job('${A}', '${G}', 'Gal', true, 0)`, q(A, G, 42)),
  repriced: transfer(`jtq.job('${A}', '${G}')`, `CREATE TEMP TABLE qq AS SELECT jtq.quote('${A}', '${G}', 42, 'sent', true) AS id;\nSELECT jtq.reprice((SELECT id FROM qq), 40);\n`),
  // Rule 3 (convert units): the job line's quantity becomes Gal at the quote's price.
  qtLine: transfer(`jtq.job('${A}', '${G}', 'Qt')`, q(A, G, 42)),
  ptLine: transfer(`jtq.job('${A}', '${G}', 'Pt', false, 50000, 16, 375)`, q(A, G, 40)),
  flozLine: transfer(`jtq.job('${A}', '${G}', 'fl oz', false, 50000, 99, 23)`, q(A, G, 42)),
  ozLine: transfer(`jtq.job('${A}', '${G}', 'oz', false, 50000, 128, 23)`, q(A, G, 42)),
  // A real small line: 3 fl oz, cost 23c and list 39c per fl oz (job total $1.17), quote $42/Gal ($0.98).
  smallFloz: transfer(`jtq.job('${A}', '${G}', 'fl oz', false, 117, 3, 23, 39)`, q(A, G, 42)),
  lbLine: transfer(`jtq.job('${A}', '${G}', 'Lb')`, q(A, G, 42)),
  eaLine: transfer(`jtq.job('${A}', '${G}', 'Ea')`, q(A, G, 42)),
  splitPt: transfer(`jtq.job('${A}', '${F}', 'Pt', false, 50000, 80, 375)`, q(A, F, 42)),
  qtNoQuote: transfer(`jtq.job('${A}', '${G}', 'Qt')`),
  typedDiffers: typedTransfer(`jtq.typed(jtq.job('${A}', '${G}'), 5000)`, q(A, G, 42)),
  typedEqual: typedTransfer(`jtq.typed(jtq.job('${A}', '${G}', 'Gal', false, 42000), 4200)`, q(A, G, 42)),
  typedNoQuote: typedTransfer(`jtq.typed(jtq.job('${A}', '${G}'), 5000)`),
  typedResend: typedTransfer(`jtq.typed(jtq.job('${A}', '${G}'), 5000)`, `CREATE TEMP TABLE qq AS SELECT jtq.quote('${A}', '${G}', 42, 'sent', true) AS id;
SELECT jtq.reprice((SELECT id FROM qq), 40);
`),
  typedQtSame: typedTransfer(`jtq.typed(jtq.job('${A}', '${G}', 'Qt', false, 10500), 1050)`, q(A, G, 42)),
  typedQt: typedTransfer(`jtq.typed(jtq.job('${A}', '${G}', 'Qt'), 5000)`, q(A, G, 42)),
  typedSplit: typedTransfer(`jtq.typed(jtq.job('${A}', '${F}'), 5000)`, q(A, F, 42)),
  untypedResult: typedTransfer(`jtq.job('${A}', '${G}')`, q(A, G, 42)),
  sameKeyTwice: `${asAdmin}${q(A, G, 42)}CREATE TEMP TABLE j AS SELECT jtq.job('${A}', '${G}') AS id;
SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jtq-same-key');
SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jtq-same-key');
SELECT jtq.billed((SELECT id FROM j)) || ' | invoices=' || (SELECT count(*) FROM invoices WHERE job_id = (SELECT id FROM j));`,
};

// Two sessions (Sol #7 and #4), with committed rows: a holder session keeps a lock for a few seconds while a transfer
// runs in a second session; a third session then asks for the job row with NOWAIT.
function session(sql, user = 'postgres') {
  const child = spawn('docker', psqlArgs(user).concat(['-A', '-t']), { cwd: ROOT });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  child.stdin.end(sql);
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function lockOrder() {
  const committed = (sql) => scalar(sql);
  const transferSql = (job) => `BEGIN;
${asAdmin}SELECT public.transfer_job_to_invoice('${job}', '${ADMIN}', 'jtq-lock-' || gen_random_uuid())->>'success';
COMMIT;`;
  const jobFree = (job) => probe(`SELECT 1 FROM jobs WHERE id = '${job}' FOR UPDATE NOWAIT;`);
  // #7: the blend-ticket invoice holds the grower's quote (FOR UPDATE) and then wants the job; the transfer must wait on
  // the quote WITHOUT holding the job.
  const quote7 = committed(`SELECT jtq.quote('${A}', '${G}', 42, 'sent', true);`);
  const job7 = committed(`SELECT jtq.job('${A}', '${G}');`);
  const holder7 = session(`BEGIN; SELECT 1 FROM quotes WHERE id = '${quote7}' FOR UPDATE; SELECT pg_sleep(6); COMMIT;`);
  await pause(1500);
  const transfer7 = session(transferSql(job7));
  await pause(2500);
  const free7 = jobFree(job7);
  const [h7, t7] = await Promise.all([holder7, transfer7]);
  assert.equal(h7.code, 0, h7.out);
  assert.equal(free7.status, 0, `the transfer held the job while waiting for a quote (deadlock order):
${free7.output}`);
  assert.equal(t7.code, 0, t7.out); assert.match(t7.out, /^true$/m);
  console.log('[after] two sessions: while a quote is held, the waiting transfer does not hold the job (job free NOWAIT); it then bills');
  // #4: Field Setup updates the field row before its billing defaults; while it holds the field the transfer must wait
  // after taking the job (so it never reads who pays half-way through a Field Setup save).
  const job4 = committed(`SELECT jtq.job('${A}', '${G}');`);
  const holder4 = session(`BEGIN; UPDATE fields SET notes = 'jtq lock' WHERE id = '${G}'; SELECT pg_sleep(6); COMMIT;`);
  await pause(1500);
  const transfer4 = session(transferSql(job4));
  await pause(2500);
  const free4 = jobFree(job4);
  const [h4, t4] = await Promise.all([holder4, transfer4]);
  assert.equal(h4.code, 0, h4.out);
  assert.notEqual(free4.status, 0, 'the transfer should hold the job while it waits for the field');
  assert.match(free4.output, /could not obtain lock/);
  assert.equal(t4.code, 0, t4.out); assert.match(t4.out, /^true$/m);
  console.log('[after] two sessions: while a field is being saved, the transfer holds the job and waits for the field; it then bills');
}

async function main() {
  if (REUSE) {
    assert.match(REUSE, /^crx-[a-z0-9-]+$/, 'CRX_PROVER_REUSE must name a kept prover container (crx-...)');
    assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', REUSE]).stdout.trim(), 'none', 'CRX_PROVER_REUSE must be a network-less prover container');
    assert.match(DB, /^jtq_run_[a-z0-9_]+$/, 'CRX_PROVER_REUSE needs CRX_PROVER_DB naming a fresh copy called jtq_run_<n>');
  } else buildContainer();
  assert.equal(body(), OLD_BODY, 'the replayed transfer body is not the one the candidate expects');
  assert.equal(scalar(`SELECT (SELECT count(*) FROM auth.users WHERE id = '${ADMIN}') + (SELECT count(*) FROM pg_namespace WHERE nspname = 'jtq');`),
    '0', 'this database was already used by a proof run: make a fresh copy');
  const implGrants = grants(IMPL), wrapperGrants = grants(WRAPPER);
  seed();

  // BEFORE: 10 Gal at list $50 = $500.00, whatever the quote says.
  const before = Object.fromEntries(['quoted', 'noQuote', 'oddTotal', 'payerNotJobCustomer', 'payerNoQuote', 'split', 'qtNoQuote', 'smallFloz', 'supplied']
    .map((k) => [k, okProbe(CASES[k])]));
  for (const [k, v] of Object.entries(before)) console.log(`[before] ${k}: ${v}`);
  assert.equal(before.quoted, 'A:50000:50000:50000/null', 'before: a field with a sent $42 quote bills list $500');
  assert.equal(before.oddTotal, 'A:55000:55000:50000/null', 'before: the header follows the stored job total');
  // 20270207125000 (replayed before the candidate) judges a job line on its whole quantity: a 3 fl oz line and a
  // customer-supplied line already bill.
  assert.equal(before.smallFloz, 'A:117:117:117/null', 'before: 3 fl oz at list $1.17 bills (below-cost PR)');
  assert.equal(before.supplied, 'A:0:0:0/manual', 'before: a customer-supplied line bills $0 (below-cost PR)');

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.notEqual(body(), OLD_BODY);
  assert.equal(grants(IMPL), implGrants, 'the transfer body grants must not change');
  assert.equal(grants(WRAPPER), wrapperGrants, 'the public wrapper grants must not change');
  assert.equal(grants(HELPER), 'postgres', 'the new helper is executable by no API role');
  assert.equal(grants(WARN), 'postgres', 'the warning helper is executable by no API role');
  assert.equal(grants(SAVE_IMPL), 'postgres', 'the job save body stays postgres-only');
  assert.equal(scalar(`SELECT count(*) FROM job_chemicals WHERE price_typed`), '0', 'every existing line starts not typed');
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /JOB_QUOTE_PRICE_PREFLIGHT: already applied/);
  console.log(`[case] the candidate applies (transfer EXECUTE unchanged: ${implGrants}; wrapper: ${wrapperGrants}; helper: postgres only); a second apply stops at its preflight`);

  const after = (k, expected, why) => { const v = okProbe(CASES[k]); console.log(`[after] ${k}: ${v}`); assert.equal(v, expected, why); };
  after('quoted', 'A:42000:42000:42000/quoted', 'a sent $42 quote bills 10 Gal at $42 = $420; header = share = line');
  after('noQuote', before.noQuote, 'no quote: unchanged');
  after('draft', before.noQuote, 'a draft (never sent) quote: list');
  after('declined', before.noQuote, 'a declined quote: list');
  after('othersQuote', before.noQuote, "another grower's quote: list");
  after('oddTotal', 'A:42000:42000:42000/quoted', 'a quote-priced invoice bills its lines, not a stale stored job total');
  // Q2 (Mason, 2026-11-22): the invoice goes to the job's customer (B); A pays the field and A's quote would set
  // the price, so the transfer stops; with no quote it bills as before.
  refusedProbe(CASES.payerNotJobCustomer, /JOB_QUOTE_PAYER_MISMATCH: \[PROVER\] JTQ chem would be billed from the sent quote of \[PROVER\] JTQ Farm A, who pays for this job's fields, but this job is for \[PROVER\] JTQ Farm B\. Nothing was billed\./);
  console.log('[after] payerNotJobCustomer: refused JOB_QUOTE_PAYER_MISMATCH, nothing billed');
  refusedProbe(CASES.deletedJob, /JOB_DELETED/);
  console.log('[after] deletedJob: refused JOB_DELETED (kept from 20270207125000)');
  after('payerNoQuote', before.payerNoQuote, 'payer differs but no quote sets the price: as before');
  after('zeroAcreField', 'A:42000:42000:42000/quoted', 'a zero-acre unquoted field on the job does not block the quote');
  after('smallQuoted', 'A:2520:2520:2520/quoted', '0.6 Gal at a $42 quote = $25.20, above 0.6 Gal of $30 cost: bills');
  refusedProbe(CASES.quoteBelowCost, /JOB_LINE_BELOW_COST: \[PROVER\] JTQ chem is priced below its cost on this job\. Nothing was invoiced/);
  console.log('[after] quoteBelowCost: a $20 quote on 10 Gal costing $30/Gal is refused JOB_LINE_BELOW_COST');
  after('dryOz', 'A:8000:8000:8000/quoted', "a dry product's 32 oz = 2 Lb at a $40/Lb quote = $80.00");
  assert.equal(scalar("SELECT public.safe_cents_qty(150, 10.01 * (10 / 30.0 * 100) / 100);"), '500', 'the old formula rounded the half cent down');
  after('thirds', 'A:501:501:501/quoted B:501:501:501/quoted C:501:501:501/quoted', 'three equal owners: 500.5 cents each rounds up to 501 (old formula: 500)');
  after('split', 'A:25200:25200:25200/quoted B:20000:20000:20000/null', 'A pays 6 Gal at their $42 quote; B (no quote) keeps 40% of the job price');
  after('supplied', before.supplied, 'customer-supplied: $0, never quote-priced');
  after('qtNoQuote', before.qtNoQuote, 'a Qt line with no quote: as before');
  const twice = okProbe(CASES.sameKeyTwice);
  console.log(`[after] same key twice: ${twice}`);
  assert.equal(twice, 'A:42000:42000:42000/quoted | invoices=1');
  refusedProbe(CASES.repriced, /Nothing was billed|QUOTE_|sent/i);
  console.log('[after] repriced and not re-sent: refused, nothing billed');
  // Rule 3 (Mason, 2026-11-21, "Convert automatically"): field_app_priced_quantity, exact within the product's form.
  const conv = (a, b) => scalar(`SELECT public.field_app_priced_quantity(${a}, ${b});`);
  const pairs = [['16', "'Pt', 'Gal', 'liquid'", '2'], ['10', "'Qt', 'Gal', 'liquid'", '2.5'], ['64', "'fl oz', 'Gal', 'liquid'", '0.5'],
    ['128', "'oz', 'Gal', 'liquid'", '1'], ['3', "'Gal', 'Qt', 'liquid'", '12'], ['2', "'Qt', 'Pt', 'liquid'", '4'],
    ['32', "'Dry oz', 'Lb', 'dry'", '2'], ['32', "'oz', 'Lb', 'dry'", '2'], ['2', "'LB', 'Dry oz', 'dry'", '32'], ['5', "'gal', 'Gal', 'liquid'", '5']];
  for (const [qty, units, want] of pairs) assert.equal(Number(conv(qty, units)), Number(want), `${qty} ${units}`);
  for (const units of ["'Lb', 'Gal', 'liquid'", "'oz', 'Lb', 'liquid'", "'Ea', 'Gal', 'liquid'", "'g', 'Lb', 'dry'", "'MG', 'Dry oz', 'dry'",
    "'bushel', 'Gal', 'liquid'", "'Gal', 'Lb', 'dry'"]) {
    assert.equal(conv('1', units), '', `${units} must not convert`);
  }
  console.log("[after] unit pairs: Pt/Qt/fl oz/oz -> Gal, Gal -> Qt, Qt -> Pt, a dry oz <-> Lb convert exactly; Lb/Gal, a liquid oz to Lb, Ea, g, MG, unknown do not");
  after('qtLine', 'A:10500:10500:10500/quoted', '10 Qt = 2.5 Gal at the $42 quote = $105.00');
  after('ptLine', 'A:8000:8000:8000/quoted', '16 Pt = 2 Gal at a $40 quote = $80.00');
  // The same small line after the change: 3 fl oz = 0.0234375 Gal x $42 = 98.4375c, nearest cent 98c, above its
  // whole-quantity cost (70.3c), so it bills.
  after('smallFloz', 'A:98:98:98/quoted', '3 fl oz at a $42/Gal quote = 98c (98.4375 rounded)');
  after('flozLine', 'A:3248:3248:3248/quoted', '99 fl oz = 0.7734375 Gal at $42 = 3248.4375 cents, rounded to $32.48');
  after('ozLine', 'A:4200:4200:4200/quoted', '128 oz = 1 Gal at $42');
  const splitPt = okProbe(CASES.splitPt); console.log(`[after] splitPt: ${splitPt}`);
  assert.ok(splitPt.startsWith('A:25200:25200:25200/quoted B:') && splitPt.endsWith('/null'),
    'A pays 60% of 80 Pt = 48 Pt = 6 Gal at $42; B (no quote) keeps its acre share of the job line price');
  refusedProbe(CASES.lbLine, /JOB_QUOTE_UNIT_MISMATCH: \[PROVER\] JTQ chem is quoted per Gal but this job bills it per Lb, and those units can't be converted/);
  refusedProbe(CASES.eaLine, /JOB_QUOTE_UNIT_MISMATCH: \[PROVER\] JTQ chem is quoted per Gal but this job bills it per Ea/);
  console.log('[after] a Lb or Ea job line against a per-Gal quote: refused JOB_QUOTE_UNIT_MISMATCH');
  // A refusal leaves nothing behind (the whole transfer rolls back): the job stays completed and unbilled.
  const left = okProbe(`${asAdmin}${q(A, G, 42)}CREATE TEMP TABLE j AS SELECT jtq.job('${A}', '${G}', 'Lb') AS id;
DO $$ BEGIN PERFORM public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jtq-refused'); EXCEPTION WHEN others THEN NULL; END $$;
SELECT (SELECT status FROM jobs WHERE id = (SELECT id FROM j)) || ' | invoices=' || (SELECT count(*) FROM invoices WHERE job_id = (SELECT id FROM j));`);
  assert.equal(left, 'completed | invoices=0');
  console.log(`[after] after a refusal: ${left}`);
  // Rule 2 (Mason, 2026-11-21): a price typed by hand stays and is billed; a differing sent quote only warns.
  after('typedDiffers', 'A:50000:50000:50000/manual | ["[PROVER] JTQ chem: the typed price of $50.00 per Gal was billed; the sent quote is $42.00 per Gal."]',
    'a typed $50 bills $500 over a $42 quote, with a warning');
  after('typedEqual', 'A:42000:42000:42000/manual | []', 'a typed price equal to the quote: no warning');
  after('typedNoQuote', 'A:50000:50000:50000/manual | []', 'a typed price with no quote: no warning');
  const resend = okProbe(CASES.typedResend); console.log(`[after] typedResend: ${resend}`);
  assert.ok(resend.startsWith('A:50000:50000:50000/manual | ["[PROVER] JTQ chem: the typed price was billed, but it could not be checked against the sent quote: '),
    'a typed line still bills when its quote needs a resend, with a warning');
  after('typedQtSame', 'A:10500:10500:10500/manual | []', 'a typed $10.50 per Qt equals a $42.00 per Gal quote: no warning');
  after('typedQt', 'A:50000:50000:50000/manual | ["[PROVER] JTQ chem: the typed price of $50.00 per Qt was billed; the sent quote is $42.00 per Gal."]',
    'a typed Qt line is not refused for the unit; it warns');
  const tsplit = okProbe(CASES.typedSplit); console.log(`[after] typedSplit: ${tsplit}`);
  assert.equal(tsplit, 'A:30000:30000:30000/manual B:20000:20000:20000/manual | ["[PROVER] JTQ chem ([PROVER] JTQ Farm A): the typed price of $50.00 per Gal was billed; the sent quote is $42.00 per Gal."]',
    'split: each owner keeps the typed price; only A (who has a quote) is warned');
  after('untypedResult', 'A:42000:42000:42000/quoted | []', 'a quote-priced line returns an empty warning list');
  // The job save stores the mark the screen sends (and false when it sends none), as admin through public.save_job.
  const saved = okProbe(`${asAdmin}
CREATE TEMP TABLE s AS SELECT public.save_job(NULL, jsonb_build_object('customer_id', '${A}', 'job_date', current_date),
  '[{"field_id":"${G}","acres_to_treat":10,"sort_order":0}]'::jsonb,
  '[{"product_id":"${P}","quantity":10,"unit":"Gal","rate_per_acre":1,"rate_unit":"Gal","cost_per_unit_cents":3000,"price_per_unit_cents":5000,"customer_supplied":false,"sort_order":0,"price_typed":true},
    {"product_id":"${P}","quantity":5,"unit":"Gal","rate_per_acre":0.5,"rate_unit":"Gal","cost_per_unit_cents":3000,"price_per_unit_cents":5000,"customer_supplied":false,"sort_order":1},
    {"product_id":"${P}","quantity":5,"unit":"Gal","rate_per_acre":0.5,"rate_unit":"Gal","cost_per_unit_cents":3000,"price_per_unit_cents":5000,"customer_supplied":false,"sort_order":2,"price_typed":true},
    {"product_id":"${P}","quantity":5,"unit":"Gal","rate_per_acre":0.5,"rate_unit":"Gal","cost_per_unit_cents":3000,"price_per_unit_cents":5000,"customer_supplied":false,"sort_order":3,"price_typed":true}]'::jsonb,
  auth.uid(), 'jtq-save-' || gen_random_uuid()) AS res;
-- An older screen re-saves without price_typed: the typed line (same product, price and position) keeps the mark; the
-- untyped line at the same product and price stays untyped; an explicit false clears it; a new unit clears it
-- (Luna rounds 1, 2 and 4).
CREATE TEMP TABLE s2 AS SELECT public.save_job(((SELECT res FROM s)->>'job_id')::uuid,
  jsonb_build_object('customer_id', '${A}', 'job_date', current_date),
  '[{"field_id":"${G}","acres_to_treat":10,"sort_order":0}]'::jsonb,
  '[{"product_id":"${P}","quantity":10,"unit":"Gal","rate_per_acre":1,"rate_unit":"Gal","cost_per_unit_cents":3000,"price_per_unit_cents":5000,"customer_supplied":false,"sort_order":0},
    {"product_id":"${P}","quantity":5,"unit":"Gal","rate_per_acre":0.5,"rate_unit":"Gal","cost_per_unit_cents":3000,"price_per_unit_cents":5000,"customer_supplied":false,"sort_order":1},
    {"product_id":"${P}","quantity":5,"unit":"Gal","rate_per_acre":0.5,"rate_unit":"Gal","cost_per_unit_cents":3000,"price_per_unit_cents":5000,"customer_supplied":false,"sort_order":2,"price_typed":false},
    {"product_id":"${P}","quantity":20,"unit":"Qt","rate_per_acre":2,"rate_unit":"Qt","cost_per_unit_cents":3000,"price_per_unit_cents":5000,"customer_supplied":false,"sort_order":3}]'::jsonb,
  auth.uid(), 'jtq-save2-' || gen_random_uuid()) AS res;
RESET ROLE; -- read back as the owner (app roles read job lines through RLS screens, not needed here)
SELECT (SELECT res->>'success' FROM s) || ' | ' || (SELECT res->>'success' FROM s2) || ' | ' || (SELECT string_agg(jc.sort_order || '=' || jc.price_typed, ',' ORDER BY jc.sort_order)
  FROM job_chemicals jc WHERE jc.job_id = ((SELECT res FROM s)->>'job_id')::uuid);`);
  console.log(`[after] save_job: ${saved}`);
  assert.equal(saved, 'true | true | 0=true,1=false,2=false,3=false',
    'save_job stores price_typed; an omitted mark survives only on the same product, price, unit and position when the line repeats; explicit false clears it');
  // Sol MED: an older screen deletes the row above a unique typed line and saves without price_typed: the renumbered
  // line keeps its mark.
  const line = (o) => JSON.stringify({ product_id: P, quantity: 10, unit: 'Gal', rate_per_acre: 1, rate_unit: 'Gal',
    cost_per_unit_cents: 3000, customer_supplied: false, ...o });
  const saveJob = (jobSql, lines, tag) => `public.save_job(${jobSql}, jsonb_build_object('customer_id', '${A}', 'job_date', current_date),
  '[{"field_id":"${G}","acres_to_treat":10,"sort_order":0}]'::jsonb, '[${lines.map(line).join(',')}]'::jsonb, auth.uid(), '${tag}-' || gen_random_uuid())`;
  const marks = (job) => `(SELECT string_agg(jc.sort_order || '=' || jc.price_typed, ',' ORDER BY jc.sort_order) FROM job_chemicals jc WHERE jc.job_id = ${job})`;
  const renumbered = okProbe(`${asAdmin}
CREATE TEMP TABLE s AS SELECT ${saveJob('NULL', [{ price_per_unit_cents: 4000, sort_order: 0 }, { price_per_unit_cents: 5000, sort_order: 1, price_typed: true }], 'jtq-rn')} AS res;
CREATE TEMP TABLE s2 AS SELECT ${saveJob("((SELECT res FROM s)->>'job_id')::uuid", [{ price_per_unit_cents: 5000, sort_order: 0 }], 'jtq-rn2')} AS res;
RESET ROLE;
SELECT ${marks("((SELECT res FROM s)->>'job_id')::uuid")};`);
  console.log(`[after] save_job, row above a typed line deleted by an older screen: ${renumbered}`);
  assert.equal(renumbered, '0=true', 'a unique typed line keeps its mark when renumbered');
  // Q1 / Sol #2: a completed job's typed marks can't change through the save; an unchanged save still works.
  const completedJob = `jtq.job('${A}', '${G}')`;
  refusedProbe(`${asAdmin}CREATE TEMP TABLE j AS SELECT ${completedJob} AS id;
SELECT ${saveJob('(SELECT id FROM j)', [{ price_per_unit_cents: 5000, sort_order: 0, price_typed: true }], 'jtq-lock')};`,
  /JOB_PRICE_MARK_LOCKED: this job is completed/);
  const unchanged = okProbe(`${asAdmin}CREATE TEMP TABLE j AS SELECT ${completedJob} AS id;
SELECT (${saveJob('(SELECT id FROM j)', [{ price_per_unit_cents: 5000, sort_order: 0, price_typed: false }], 'jtq-lock2')})->>'success';`);
  assert.equal(unchanged, 'true');
  refusedProbe(`${asAdmin}CREATE TEMP TABLE j AS SELECT jtq.typed(${completedJob}, 5000) AS id;
SELECT ${saveJob('(SELECT id FROM j)', [{ price_per_unit_cents: 5000, sort_order: 0, price_typed: false }], 'jtq-lock3')};`,
  /JOB_PRICE_MARK_LOCKED/);
  const keptByOldTab = okProbe(`${asAdmin}CREATE TEMP TABLE j AS SELECT jtq.typed(${completedJob}, 5000) AS id;
SELECT (${saveJob('(SELECT id FROM j)', [{ price_per_unit_cents: 5000, sort_order: 0 }], 'jtq-lock4')})->>'success';`);
  assert.equal(keptByOldTab, 'true');
  console.log('[after] completed job: marking or unmarking a line is refused JOB_PRICE_MARK_LOCKED; an unchanged save (or an older screen that omits the mark) saves');
  await lockOrder();
  console.log('JOB_TRANSFER_SENT_QUOTE_PRICE_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
