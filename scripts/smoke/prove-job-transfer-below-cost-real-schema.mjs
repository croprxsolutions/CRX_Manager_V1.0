#!/usr/bin/env node
/**
 * Real-schema proof for 20270225160000_job_transfer_below_cost_whole_line (contract
 * docs/plans/2026-11-21-job-transfer-below-cost-CONTRACT.md, "Redesign: real quantities"). Container setup and replay
 * copied from prove-field-app-refuses-payer-change-real-schema.mjs. Completed spray jobs go through
 * transfer_job_to_invoice as a signed-in admin, each case rolled back. A chemical stocked by the Gal costs $30:
 *   BEFORE: 3 fl oz, half a gallon, 8 oz dry, a customer-supplied line and a split small line are refused; 10 Gal sold
 *           for $250 total passes, written as quantity 1.
 *   AFTER:  each line carries its real quantity in the sold unit at a price per sold unit (3 fl oz = 0.0234 Gal at
 *           $49.92 = $1.17); a grower's own product is a $0 information line with no catalog link; two owners split the
 *           quantity by acre share; below-cost lines stop (JOB_LINE_BELOW_COST, no cost shown), as do units that can't
 *           convert, a missing cost and rounding over 50 cents; an admin's and a sales rep's ordinary re-save keeps the
 *           lines; the below-cost wall is unchanged. A second apply stops at the preflight; grants unchanged; the
 *           rollback script restores the transfer body and drops the helpers.
 *   #2283:  save_job refuses any change to a completed job's chemical lines (quantity, unit, product, supplied, added,
 *           removed) for an admin and a sales rep; unchanged lines and other edits save; scheduled and in-progress jobs
 *           save as before; a replayed key returns its first result; the rollback restores the old save_job.
 *
 * Run: node scripts/smoke/prove-job-transfer-below-cost-real-schema.mjs   (needs Docker)
 * Prints JOB_TRANSFER_BELOW_COST_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
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
const NAME = REUSE || `crx-jbc-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
// Shell commands below name the database; only a bare name is accepted (Sol r1).
if (!/^[a-z0-9_]+$/.test(DB)) throw new Error('CRX_PROVER_DB must be a bare database name (a-z, 0-9, _)');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270225160000_job_transfer_below_cost_whole_line.sql');
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
const TOUCHED = /(_transfer_job_to_invoice_intent_impl_20260908|save_job|_save_job_cost_step2_impl|_cost_step2_job_chemicals|check_idempotency_intent|_enforce_below_cost_line|_job_transfer_line_price|_job_transfer_split_qty|normalize_rate_unit|field_app_priced_quantity|safe_cents_qty|crx_below_cost_operation)/i;
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
const ADMIN = id('a1'), REP = id('a2'), APP = id('a3'), A = id('c1'), B = id('c2'), G = id('f1'), F = id('f2'), P = id('d1'), NC = id('d2'), DRY = id('d3'), RUP = id('d4'), QT = id('d5'), MGP = id('d6'), O = id('f3'), OS = id('f4'), N = id('f5'), X = id('f6'), Y = id('f7'), Z = id('f8'), SVC = id('e1');
const IMPL = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)';
const WRAPPER = 'public.transfer_job_to_invoice(uuid,uuid,text)';
const WALL = 'public._enforce_below_cost_line()';
const PRICE = 'public._job_transfer_line_price_20270207(uuid,text,numeric,text,bigint)';
const SPLIT = 'public._job_transfer_split_qty_20270207(numeric,numeric[])';
const SHARES = 'public._job_transfer_shares_20270207(uuid)';
const LOCK = 'public._job_lines_lock_when_invoiced_20270207()';
const SAVE = 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)';
const OLD_SAVE = 'bd60e8f74deba4b769f9a448ad64acb9';
const OLD_BODY = 'a54e3e6a3a2b920e9bcd1a350cd92423';
const OLD_WALL = '5fa0a5f975dc2a84b3c6599a84b8cc55';
const md5Of = (sig) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
const acl = (sig) => scalar(`SELECT coalesce(proacl::text, '-') FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
const grants = (sig) => scalar(`SELECT COALESCE(string_agg(g, ',' ORDER BY g), '-') FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
  FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${sig}'::regprocedure AND a.privilege_type = 'EXECUTE') x;`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'jbc-admin@example.invalid', '{"full_name":"[PROVER] JBC Admin","role":"admin"}'::jsonb),
    ('${REP}', 'jbc-rep@example.invalid', '{"full_name":"[PROVER] JBC Rep","role":"sales_rep"}'::jsonb),
    ('${APP}', 'jbc-app@example.invalid', '{"full_name":"[PROVER] JBC Applicator","role":"applicator"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'applicator', is_active = true WHERE id = '${APP}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active) VALUES ('${A}', '[PROVER] JBC Farm A', 1, true), ('${B}', '[PROVER] JBC Farm B', 1, true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active) VALUES
      ('${P}', '[PROVER] JBC chem', 'JBC-1', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 30, 50, 50, 50, true),
      ('${NC}', '[PROVER] JBC grower chem', 'JBC-2', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', NULL, 0, 0, 0, true),
      ('${DRY}', '[PROVER] JBC dry', 'JBC-3', 'dry', 'Lb', 'Lb', 'Lb', 'Lb', 16, 20, 20, 20, true),
      ('${QT}', '[PROVER] JBC quart chem', 'JBC-5', 'liquid', 'Qt', 'Qt', 'Qt', 'Qt', 8, 10, 10, 10, true),
      ('${MGP}', '[PROVER] JBC milligram dry', 'JBC-6', 'dry', 'MG', 'MG', 'MG', 'MG', 0.01, 0.02, 0.02, 0.02, true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active, is_rup) VALUES
      ('${RUP}', '[PROVER] JBC restricted chem', 'JBC-4', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 30, 50, 50, 50, true, true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
      ('${G}', '${A}', '[PROVER] JBC field A', 100, true), ('${F}', '${A}', '[PROVER] JBC field A+B', 100, true),
      ('${O}', '${A}', '[PROVER] JBC field A per-acre', 100, true), ('${OS}', '${A}', '[PROVER] JBC field A+B per-acre', 100, true),
      ('${N}', '${A}', '[PROVER] JBC field A 99.99%', 100, true),
      ('${X}', '${A}', '[PROVER] JBC field A, no billing defaults', 100, true),
      ('${Y}', '${A}', '[PROVER] JBC field A extra', 100, true),
      ('${Z}', '${A}', '[PROVER] JBC field A billed to B', 100, true);
    INSERT INTO public.application_services (id, name, is_active, default_rate_per_acre_cents, cost_per_acre_cents) VALUES
      ('${SVC}', '[PROVER] JBC spraying', true, 1000, 400);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES
      ('${G}', '${A}', 100, true, NULL), ('${F}', '${A}', 60, true, NULL), ('${F}', '${B}', 40, false, NULL),
      ('${O}', '${A}', 100, true, NULL), ('${OS}', '${A}', 60, true, NULL), ('${OS}', '${B}', 40, false, NULL), -- 20270224110000 (#2240) forbids a per-acre price; these fields keep their names and cases
      ('${N}', '${A}', 99.99, true, NULL), ('${Y}', '${A}', 100, true, NULL),
      ('${Z}', '${B}', 100, true, NULL);`);
  // Test-only helpers (prover database only). jbc.job writes a completed job: 10 acres of the field and one chemical
  // line of p_qty p_unit at p_price (job cost p_cost) per p_unit; the stored job total is that line's total.
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
    -- jbc.job plus the spraying service ($10/acre, $4 cost) and 90 more acres on another field of A's (A 100%).
    CREATE FUNCTION jbc.feejob(p_field uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
      SET session_replication_role = replica AS $f$
    DECLARE v_j uuid := jbc.job('${A}', p_field, 'Gal', 10, 5000, 3000);
    BEGIN
      UPDATE jobs SET application_service_id = '${SVC}', total_acres = 100 WHERE id = v_j;
      INSERT INTO job_fields (job_id, field_id, acres_to_treat) VALUES (v_j, '${Y}', 90);
      RETURN v_j;
    END $f$;
    -- A two-line job: the grower's own "JBC chem" (10 Gal) first, then 8 Qt of the quart chem at $10 ($8 cost).
    CREATE FUNCTION jbc.twoline(p_field uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
      SET session_replication_role = replica AS $f$
    DECLARE v_j uuid := jbc.job('${A}', p_field, 'Qt', 8, 1000, 800, false, '${QT}');
    BEGIN
      INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, cost_per_unit_cents, customer_supplied)
      VALUES (v_j, '${P}', 10, 'Gal', 1, 'Gal', 0, 0, true);
      RETURN v_j;
    END $f$;
    -- Every invoice the job made, as farm:total:share sum:booked cost:lines (quantity unit @price=amount/cost per unit/
    -- catalog link/price source), ordered by farm.
    CREATE FUNCTION jbc.billed(p_job uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT COALESCE(string_agg(format('%s:%s:%s:%s:%s', right(c.farm_name, 1), i.total_amount_cents,
          (SELECT COALESCE(sum(s.amount_cents), 0) FROM invoice_shares s WHERE s.invoice_id = i.id), i.total_cost_cents,
          (SELECT string_agg(format('%s %s @%s=%s/c%s/%s/%s', x.quantity, x.unit_size, x.unit_price_cents, x.extended_cents,
                    x.cost_cents, CASE WHEN x.product_id IS NULL THEN 'none' ELSE 'product' END, COALESCE(x.price_source, 'null')), ',' ORDER BY x.sort_order)
             FROM invoice_items x WHERE x.invoice_id = i.id)), ' ' ORDER BY c.farm_name), '-')
        FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.job_id = p_job AND i.deleted_at IS NULL $f$;
    CREATE FUNCTION jbc.approvals() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT count(*) FROM below_cost_approvals $f$;
    -- The job's invoice lines as the invoice editor sends them back on a save.
    CREATE FUNCTION jbc.items(p_invoice uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', x.id, 'product_id', x.product_id, 'description', x.description,
          'quantity', x.quantity, 'unit_size', x.unit_size, 'unit_price_cents', x.unit_price_cents,
          'extended_cents', x.extended_cents, 'cost_cents', x.cost_cents, 'sort_order', x.sort_order, 'acres', x.acres,
          'rate_per_acre', x.rate_per_acre, 'rate_unit', x.rate_unit, 'epa_registration', x.epa_registration,
          'product_form', x.product_form, 'is_application_fee', x.is_application_fee, 'price_source', x.price_source)
          ORDER BY x.sort_order), '[]'::jsonb)
        FROM invoice_items x WHERE x.invoice_id = p_invoice $f$;
    -- What the job screen sends back on a save: the job's header, fields and chemical lines as stored (#2283).
    CREATE FUNCTION jbc.hdr(p_job uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT jsonb_strip_nulls(to_jsonb(j)) FROM jobs j WHERE j.id = p_job $f$;
    CREATE FUNCTION jbc.flds(p_job uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.sort_order, f.id), '[]'::jsonb) FROM job_fields f WHERE f.job_id = p_job $f$;
    CREATE FUNCTION jbc.chems(p_job uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.sort_order, c.id), '[]'::jsonb) FROM job_chemicals c WHERE c.job_id = p_job $f$;
    -- The job's lines as product:quantity:unit:supplied, and its note.
    CREATE FUNCTION jbc.lines(p_job uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT COALESCE(string_agg(format('%s:%s:%s:%s', right(p.sku, 1), trim_scale(c.quantity), c.unit, c.customer_supplied), ',' ORDER BY p.sku, c.quantity), '-')
             || ' note=' || COALESCE((SELECT notes FROM jobs WHERE id = p_job), '-')
        FROM job_chemicals c JOIN products p ON p.id = c.product_id WHERE c.job_id = p_job $f$;
    CREATE FUNCTION jbc.set_status(p_job uuid, p_status text) RETURNS void LANGUAGE sql SECURITY DEFINER
      SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
      UPDATE jobs SET status = p_status WHERE id = p_job $f$;
    GRANT USAGE ON SCHEMA jbc TO authenticated;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA jbc TO authenticated;`, { user: 'supabase_admin' });
  console.log('[prover] committed test rows: an admin and a sales rep; farms A and B; field A (A 100%), field A+B (A 60%, B 40%), a per-acre-priced field; chemicals stocked by the Gal at $30 (one restricted-use), by the Qt at $8 and by the Lb at $16 (dry); a grower product with no cost');
}
const as = (uid) => `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;\n`;
const asAdmin = as(ADMIN);
const transferOnly = (job) => `${asAdmin}
CREATE TEMP TABLE j AS SELECT ${job} AS id;
SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jbc-' || gen_random_uuid());`;
// A rolled-back case, as the signed-in admin through the app's own transfer_job_to_invoice.
const transfer = (job) => `${transferOnly(job)}
SELECT jbc.billed((SELECT id FROM j)) || ' | approvals=' || jbc.approvals() || ' | ' || (SELECT status FROM jobs WHERE id = (SELECT id FROM j));`;
const job = (unit, qty, price, cost = 3000, field = G, supplied = false, product = P) =>
  `jbc.job('${A}', '${field}', '${unit}', ${qty}, ${price}, ${cost}, ${supplied}, '${product}')`;
// The invoice editor's ordinary save of a transfer-made invoice, unchanged, by uid.
const resave = (jobSql, uid) => `${transferOnly(jobSql)}
${as(uid)}SELECT public.save_invoice(jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type),
  jbc.items(i.id), 'jbc-' || gen_random_uuid()) FROM invoices i WHERE i.job_id = (SELECT id FROM j);
SELECT jbc.billed((SELECT id FROM j)) || ' | approvals=' || jbc.approvals();`;
// The job, with a billing split saved on it (rows of field, payer, percent, primary), sent to Create Invoice.
const savedShares = (jobSql, rows) => `${asAdmin}
CREATE TEMP TABLE j AS SELECT ${jobSql} AS id;
RESET ROLE;
INSERT INTO job_field_shares (job_id, field_id, customer_id, split_pct, is_primary)
  SELECT (SELECT id FROM j), v.f, v.c, v.p, v.pr FROM (VALUES ${rows}) v(f, c, p, pr);
${asAdmin}SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jbc-' || gen_random_uuid());
SELECT jbc.billed((SELECT id FROM j)) || ' | approvals=' || jbc.approvals() || ' | ' || (SELECT status FROM jobs WHERE id = (SELECT id FROM j));`;
// A change to the job's own rows, as the table owner, after Create Invoice.
const afterInvoice = (stmt) => `${transferOnly(job('Gal', 10, 5000))}
RESET ROLE;
${stmt}
SELECT 'changed';`;
const CASES = {
  // 3 fl oz at 39c/fl oz = $1.17 is 0.0234 Gal at $49.92 ($1.17); its cost is 3/128 Gal x $30 = 70.3c.
  small3floz: transfer(job('fl oz', 3, 39, 23)),
  // Half a gallon: 64 fl oz at 30c ($19.20); 0.5 Gal at $30 (exactly the cost); 64 fl oz at 23c ($14.72, under $15).
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
  splitNormal: transfer(job('Gal', 10, 5000, 3000, F)),
  // Dry: 8 oz of a $16/Lb product is 0.5 Lb ($8.00 of cost); at $1.10/oz ($8.80) it bills, at 60c/oz ($4.80) it stops.
  dryOk: transfer(job('oz', 8, 110, 100, G, false, DRY)),
  dryBelow: transfer(job('oz', 8, 60, 100, G, false, DRY)),
  // A product sold by the quart, recorded in gallons: 2 Gal at $40 = 8 Qt at $10.
  galOnQt: transfer(job('Gal', 2, 4000, 3200, G, false, QT)),
  galOnQtFraction: transfer(job('Gal', 40, 4150, 3200, G, false, QT)),
  // Units that can't be converted to the sold unit stop and name it (Mason, 2026-11-22).
  eaUnit: transfer(job('Ea', 10, 5000)),
  perAcreUnit: transfer(job('Gal/ac', 10, 5000)),
  noCost: transfer(job('Gal', 10, 5000, 0, G, false, NC)),
  // Rounding (Mason, 2026-11-22, "Allow up to 50c"): 1 fl oz at $1,000 rounds to 0.0078 Gal and moves $1.60;
  // 0.001 fl oz rounds to no quantity at all.
  roundingBig: transfer(job('fl oz', 1, 100000)),
  roundingZero: transfer(job('fl oz', 0.001, 39)),
  // Sol round 1: a dotted fluid ounce is judged on its whole quantity (1,280 fl. oz = 10 Gal; $256 against $300).
  dottedBelow: transfer(job('fl. oz', 1280, 20, 23)),
  // Sol round 2 #1: a dotted fluid-ounce line books the cost of what was used, not a gallon per ounce.
  dottedSmall: transfer(job('fl. oz', 3, 39, 23)),
  spelledBelow: transfer(job('gallons', 10, 2500)),
  // Sol round 2 #3: a restricted-use product's line carries its real quantity (the register copies the line's).
  rupSmall: transfer(job('fl oz', 3, 39, 23, G, false, RUP)),
  rupSupplied: transfer(job('Gal', 10, 0, 0, G, true, RUP)),
  // Luna round 4: a grower's own product with a not-a-number quantity is refused (the job's line read stops), one owner or two.
  suppliedNaN: transfer(job('Gal', "'NaN'::numeric", 0, 0, G, true, NC)),
  suppliedNaNSplit: transfer(job('Gal', "'NaN'::numeric", 0, 0, F, true, NC)),
  overrideSmall: transfer(job('fl oz', 3, 39, 23, O)),
  overrideNormal: transfer(job('Gal', 10, 5000, 3000, O)),
  overrideSplit: transfer(job('Gal', 10, 5000, 3000, OS)),
  // Luna round 2: a field whose split totals 99.99% (allowed) still bills every cent of its lines.
  nearHundred: transfer(job('Gal', 10, 5000, 3000, N)),
  // Sol round 3 #2: the one owner's spraying fee covers every treated acre (10 on a field with defaults + 90 without).
  feeMixed: transfer(`jbc.feejob('${G}')`),
  feeMixedOverride: transfer(`jbc.feejob('${O}')`),
  // Sol round 3 MED: a rate written in words is not a quantity unit.
  perWordUnit: transfer(job('Gal per acre', 10, 5000)),
  // Luna round 5: a job line with no saved cost books today's catalog cost ($30/Gal), never $0.
  nullJobCost: transfer(job('Gal', 10, 5000, 'NULL')),
  // Sol round 5 #1 (Mason, 2026-11-22: every field has a billing split): a field with none stops Create Invoice by name.
  noSplitField: transfer(job('Gal', 10, 5000, 3000, X)),
  // Sol round 6: a metric unit is used only when it is the sold unit (500 mg of a product stocked by the MG); any other
  // stops by name, since job completion deducts it from stock unconverted. Sol round 5 MED: a soft hyphen cannot hide "per".
  gramsDry: transfer(job('g', 1000, 4, 2, G, false, DRY)),
  mgOnMg: transfer(job('mg', 500, 2, 1, G, false, MGP)),
  mlLiquid: transfer(job('mL', 1000, 15, 1, G)),
  gramsOnLiquid: transfer(job('g', 100, 50)),
  // Sol round 6 #1 (Mason, 2026-11-22: each owner is billed for their own fields' acres): A's job on a field billed
  // 100% to B is invoiced to B.
  payerB: transfer(job('Gal', 10, 5000, 3000, Z)),
  perSoftHyphen: transfer(job('Gal p­er acre', 10, 5000)),
  // Sol round 4 #1: a per-Gal job cost saved against "fl. oz", or a $0 job cost, still books the catalog cost.
  dottedGalCost: transfer(job('fl. oz', 3, 39, 3000)),
  zeroJobCost: transfer(job('Gal', 0.5, 3000, 0)),
  // Sol round 4 #2: a two-owner job whose first line (by name) is the grower's own product.
  suppliedFirstSplit: transfer(`jbc.twoline('${F}')`),
  // Sol round 2 #4: the editor's ordinary save keeps the lines, for an admin and a sales rep.
  resaveSmallAdmin: resave(job('fl oz', 3, 39, 23), ADMIN),
  resaveSmallRep: resave(job('fl oz', 3, 39, 23), REP),
  resaveSuppliedAdmin: resave(job('Gal', 10, 0, 0, G, true, NC), ADMIN),
  resaveSuppliedRep: resave(job('Gal', 10, 0, 0, G, true, NC), REP),
  // Sol round 1: a soft-deleted blend ticket whose invoice is still live blocks; a deleted job is never invoiced.
  deletedTicket: `${asAdmin}
CREATE TEMP TABLE j AS SELECT ${job('Gal', 10, 5000)} AS id;
RESET ROLE;
SET LOCAL session_replication_role = replica;
INSERT INTO blend_tickets (id, ticket_number, uploaded_by, customer_id, status, job_id, deleted_at)
  SELECT '${id('b1')}', 'JBC-BT-1', '${ADMIN}', '${A}', 'completed', (SELECT id FROM j), now();
INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, blend_ticket_id, season)
  VALUES ('JBC-BT-INV-1', '${A}', 'misc_charge', 'draft', CURRENT_DATE, CURRENT_DATE + 30, 117, '${ADMIN}', '${id('b1')}', 2027);
SET LOCAL session_replication_role = origin;
${asAdmin}SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jbc-' || gen_random_uuid());`,
  deletedJob: `${asAdmin}
CREATE TEMP TABLE j AS SELECT ${job('Gal', 10, 5000)} AS id;
RESET ROLE;
SET LOCAL session_replication_role = replica;
UPDATE jobs SET deleted_at = now() WHERE id = (SELECT id FROM j);
SET LOCAL session_replication_role = origin;
${asAdmin}SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jbc-' || gen_random_uuid());`,
  // Sol round 8 #2 (Mason, 2026-11-22: invoices bill the payer saved on the job): the split saved on the job wins over
  // Field Setup's. Field Z is set to B 100% in Field Setup, but the job saved A 100%; field A (A 100%) saved A 60/B 40.
  savedPayer: savedShares(job('Gal', 10, 5000, 3000, Z), `('${Z}'::uuid, '${A}'::uuid, 100::numeric, true)`),
  savedSplit: savedShares(job('Gal', 10, 5000, 3000, G), `('${G}'::uuid, '${A}'::uuid, 60::numeric, true), ('${G}'::uuid, '${B}'::uuid, 40::numeric, false)`),
  // Sol r9 #4 (Mason, 2026-11-22): job notes print only on the job customer's (A's) own invoice, never on another payer's.
  notesOtherPayer: `${asAdmin}
CREATE TEMP TABLE j AS SELECT ${job('Gal', 10, 5000)} AS id;
RESET ROLE;
UPDATE jobs SET notes = 'JBC private note' WHERE id = (SELECT id FROM j);
INSERT INTO job_field_shares (job_id, field_id, customer_id, split_pct, is_primary)
  SELECT (SELECT id FROM j), v.f, v.c, v.p, v.pr FROM (VALUES ('${G}'::uuid, '${A}'::uuid, 60::numeric, true), ('${G}'::uuid, '${B}'::uuid, 40::numeric, false)) v(f, c, p, pr);
${asAdmin}SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jbc-' || gen_random_uuid());
RESET ROLE;
SELECT string_agg(CASE WHEN customer_id = '${A}' THEN 'A' ELSE 'B' END || '=' || COALESCE(header_notes, 'none'), ' ' ORDER BY customer_id = '${A}' DESC) FROM invoices WHERE job_id = (SELECT id FROM j);`,
  notesSoleOtherPayer: `${asAdmin}
CREATE TEMP TABLE j AS SELECT ${job('Gal', 10, 5000)} AS id;
RESET ROLE;
UPDATE jobs SET notes = 'JBC private note' WHERE id = (SELECT id FROM j);
INSERT INTO job_field_shares (job_id, field_id, customer_id, split_pct, is_primary) SELECT id, '${G}', '${B}', 100, true FROM j;
${asAdmin}SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jbc-' || gen_random_uuid());
RESET ROLE;
SELECT string_agg(CASE WHEN customer_id = '${A}' THEN 'A' ELSE 'B' END || '=' || COALESCE(header_notes, 'none'), ' ') FROM invoices WHERE job_id = (SELECT id FROM j);`,
  // Sol round 8 #4 (the round-7 check is withdrawn): 5 Gal from company stock and 5 Gal of the grower's own of one product.
  sameProductTwoLines: `${asAdmin}
CREATE TEMP TABLE j AS SELECT ${job('Gal', 5, 5000)} AS id;
RESET ROLE;
INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, cost_per_unit_cents, customer_supplied)
  SELECT id, '${P}', 5, 'Gal', 0.5, 'Gal', 0, 0, true FROM j;
SET LOCAL session_replication_role = replica;
INSERT INTO inventory_transactions (product_id, transaction_type, quantity, from_location, performed_by, notes, job_id)
  SELECT '${P}', 'job_applied', 5, 'Main Warehouse', '${ADMIN}', 'JBC completion', (SELECT id FROM j);
SET LOCAL session_replication_role = origin;
${asAdmin}SELECT public.transfer_job_to_invoice((SELECT id FROM j), '${ADMIN}', 'jbc-' || gen_random_uuid());
SELECT jbc.billed((SELECT id FROM j)) || ' | approvals=' || jbc.approvals() || ' | ' || (SELECT status FROM jobs WHERE id = (SELECT id FROM j));`,
  // Mason, 2026-11-22 ("lock it when rep or admin says it is posted"): an invoiced job's lines, fields and saved split
  // can't change; a completed job's can.
  lockedFields: afterInvoice('DELETE FROM job_fields WHERE job_id = (SELECT id FROM j);'),
  lockedChem: afterInvoice('UPDATE job_chemicals SET quantity = quantity WHERE job_id = (SELECT id FROM j);'),
  lockedShares: afterInvoice(`INSERT INTO job_field_shares (job_id, field_id, customer_id, split_pct, is_primary) SELECT id, '${G}', '${B}', 100, true FROM j;`),
  editCompleted: `${asAdmin}
CREATE TEMP TABLE j AS SELECT ${job('Gal', 10, 5000)} AS id;
RESET ROLE;
UPDATE job_chemicals SET quantity = quantity WHERE job_id = (SELECT id FROM j);
INSERT INTO job_field_shares (job_id, field_id, customer_id, split_pct, is_primary) SELECT id, '${G}', '${A}', 100, true FROM j;
DELETE FROM job_fields WHERE job_id = (SELECT id FROM j);
SELECT 'changed';`,
};
// #2283 (Mason, 2026-11-22: "Refuse now, build later"): save_job, as uid, on a job (status set first), sending back
// its header, fields and lines with <chem> applied to the lines (c = the stored lines) and <hdr> to the header (h).
const saveJob = (uid, { status = 'completed', chem = 'c', hdr = 'h', key = "'jbc-' || gen_random_uuid()", jobSql = job('Gal', 10, 5000) } = {}) => `${as(uid)}
CREATE TEMP TABLE j AS SELECT ${jobSql} AS id;
SELECT jbc.set_status((SELECT id FROM j), '${status}');
SELECT public.save_job((SELECT id FROM j), ${hdr.replace(/\bh\b/g, 'jbc.hdr((SELECT id FROM j))')}, jbc.flds((SELECT id FROM j)),
  ${chem.replace(/\bc\b/g, 'jbc.chems((SELECT id FROM j))')}, '${uid}', ${key});
SELECT jbc.lines((SELECT id FROM j));`;
const SAVES = {
  qty: "jsonb_set(jsonb_set(c, '{0,quantity}', '12'), '{0,rate_per_acre}', '1.2')",
  unit: `c #- '{0}' || jsonb_build_array((c -> 0) || '{"unit": "Qt", "rate_unit": "Qt", "quantity": 40, "rate_per_acre": 4}'::jsonb)`,
  product: `jsonb_set(c, '{0,product_id}', '"${RUP}"')`,
  supplied: "jsonb_set(c, '{0,customer_supplied}', 'true')",
  added: "c || jsonb_build_array(c -> 0)",
  removed: "'[]'::jsonb",
};
// The wall itself, outside the transfer: a below-cost line written straight into a transfer-made draft invoice.
const directLine = `${transferOnly(job('Gal', 10, 5000))}
RESET ROLE;
INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, cost_cents, sort_order, is_application_fee)
SELECT i.id, '${P}', 'direct', 1, 'Gal', 100, 100, 0, 99, false FROM invoices i WHERE i.job_id = (SELECT id FROM j);
SELECT 'written';`;

// Sol round 8 #3: a change to a job's fields made while Create Invoice runs on it waits for it, then is refused.
async function concurrentLock() {
  const jobId = scalar(`SELECT ${job('Gal', 10, 5000)};`);
  const first = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT });
  let firstOut = '';
  first.stdout.on('data', (d) => { firstOut += d; });
  first.stderr.on('data', (d) => { firstOut += d; });
  const firstDone = new Promise((resolve) => first.on('close', resolve));
  first.stdin.end(`BEGIN;
${asAdmin}SELECT public.transfer_job_to_invoice('${jobId}', '${ADMIN}', 'jbc-' || gen_random_uuid());
RESET ROLE;
SELECT pg_sleep(4);
COMMIT;
`);
  // Wait until the first session has invoiced the job (it then holds the job row while it sleeps).
  const sleeping = () => scalar("SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'PgSleep';") !== '0';
  for (let i = 0; i < 300 && !sleeping(); i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.ok(sleeping(), `Create Invoice did not finish in the first session:
${firstOut}`);
  const started = Date.now();
  const second = probe(`DELETE FROM job_fields WHERE job_id = '${jobId}';
SELECT 'changed';`);
  const waited = Date.now() - started;
  assert.equal(await firstDone, 0, firstOut);
  assert.notEqual(second.status, 0, second.output);
  assert.match(second.output, /JOB_INVOICED_LOCKED/);
  assert.ok(waited >= 1000, `the change waited for Create Invoice (${waited} ms)`);
  assert.equal(scalar(`SELECT count(*) FROM job_fields WHERE job_id = '${jobId}';`), '1');
  console.log(`[after] concurrentLock: a field change sent while Create Invoice ran waited ${waited} ms, then was refused JOB_INVOICED_LOCKED; the field is still on the job`);
}

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
  assert.equal(md5Of(SAVE), OLD_SAVE, 'the replayed save_job body is not the one the candidate expects');
  const implGrants = grants(IMPL), wrapperGrants = grants(WRAPPER), wallAcl = acl(WALL), saveGrants = grants(SAVE);
  seed();

  // BEFORE: every small line is refused; ten Gal below cost passes, as quantity 1.
  const refusedBefore = { small3floz: /BELOW_COST_CONTEXT_REQUIRED/, half64floz: /BELOW_COST_CONTEXT_REQUIRED/,
    halfGalAtCost: /BELOW_COST_CONTEXT_REQUIRED/, supplied: /BELOW_COST_CONTEXT_REQUIRED/, suppliedNoCost: /COST_BASIS_REQUIRED/,
    fullBelow: /BELOW_COST_CONTEXT_REQUIRED/, splitSmall: /BELOW_COST_CONTEXT_REQUIRED/, dryOk: /BELOW_COST_CONTEXT_REQUIRED/,
    rupSmall: /BELOW_COST_CONTEXT_REQUIRED/, overrideSmall: /BELOW_COST_CONTEXT_REQUIRED/ }; // overrideSplit's old refusal needs a per-acre price, which 20270224110000 (#2240) forbids
  for (const [k, re] of Object.entries(refusedBefore)) { refusedProbe(CASES[k], re); console.log(`[before] ${k}: refused ${re.source}`); }
  const tenBefore = okProbe(CASES.tenBelow);
  console.log(`[before] tenBelow: ${tenBefore}`);
  assert.match(tenBefore, /^A:25000:25000:\d+:1\.0000 \S+ @25000=25000\/c\d+\/product\/null \| approvals=0 \| invoiced$/,
    'before: 10 Gal sold for $250 against $300 of cost passed the wall, written as quantity 1');
  refusedProbe(directLine, /BELOW_COST_CONTEXT_REQUIRED/);
  for (const k of ['feeMixed', 'feeMixedOverride']) console.log(`[before] ${k}: ${okProbe(CASES[k])}`);
  const nearBefore = okProbe(CASES.nearHundred);
  console.log(`[before] nearHundred: ${nearBefore}`);
  assert.match(nearBefore, /^A:49995:49995:/, 'before: a 99.99% split billed $499.95 of a $500.00 job');
  const payerBefore = okProbe(CASES.payerB);
  console.log(`[before] payerB: ${payerBefore}`);
  assert.match(payerBefore, /^A:/, "before: A's job on a field billed 100% to B was invoiced to A");
  assert.equal(okProbe(CASES.lockedFields), 'changed', "before: an invoiced job's fields could still be removed");
  assert.equal(okProbe(saveJob(ADMIN, { chem: SAVES.qty })), '1:12:Gal:f note=-', "before: a completed job's quantity could be changed through save_job");
  console.log("[before] a completed job's chemical quantity changed through save_job (stock unchanged)");
  console.log("[before] lockedFields: an invoiced job's field could still be removed");

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.notEqual(md5Of(IMPL), OLD_BODY);
  assert.equal(md5Of(WALL), OLD_WALL, 'the below-cost wall is unchanged');
  assert.equal(grants(IMPL), implGrants, 'the transfer body grants must not change');
  assert.equal(grants(WRAPPER), wrapperGrants, 'the public wrapper grants must not change');
  assert.equal(acl(WALL), wallAcl, 'the wall ACL must not change');
  assert.equal(grants(PRICE), 'postgres', 'the line-price helper is executable by no API role');
  assert.equal(grants(SPLIT), 'postgres', 'the split helper is executable by no API role');
  assert.equal(grants(SHARES), 'postgres', 'the saved-split helper is executable by no API role');
  assert.equal(grants(LOCK), 'postgres', 'the lock trigger function is executable by no API role');
  assert.equal(grants(SAVE), saveGrants, 'save_job grants must not change');
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /JOB_BELOW_COST_PREFLIGHT/);
  console.log(`[case] the candidate applies (transfer EXECUTE unchanged: ${implGrants}; wrapper: ${wrapperGrants}; wall body and ACL unchanged; helpers: postgres only); a second apply stops at its preflight`);

  const ok = ' | approvals=0 | invoiced';
  const after = (k, expected, why) => { const v = okProbe(CASES[k]); console.log(`[after] ${k}: ${v}`); assert.equal(v, expected + ok, why); };
  // Sol round 3 #1: a line books the job's own saved cost (23c/fl oz = $29.44/Gal), not today's catalog cost ($30).
  after('small3floz', 'A:117:117:70:0.0234 Gal @4992=117/c3000/product/manual', '3 fl oz bills $1.17 as 0.0234 Gal at $49.92');
  after('half64floz', 'A:1920:1920:1500:0.5000 Gal @3840=1920/c3000/product/manual', '64 fl oz bills $19.20 as half a gallon');
  after('halfGalAtCost', 'A:1500:1500:1500:0.5000 Gal @3000=1500/c3000/product/manual', 'half a gallon exactly at cost bills');
  after('supplied', 'A:0:0:0:10.0000 Gal @0=0/c0/none/manual', "the grower's own product is a $0 information line with no catalog link");
  after('suppliedNoCost', 'A:0:0:0:10.0000 Gal @0=0/c0/none/manual', 'a grower product with no cost is a $0 information line');
  after('normal', 'A:50000:50000:30000:10.0000 Gal @5000=50000/c3000/product/manual', '10 Gal at $50 bills $500 as 10 Gal');
  after('dryOk', 'A:880:880:800:0.5000 Lb @1760=880/c1600/product/manual', '8 oz of a dry product bills $8.80 as half a pound');
  after('galOnQt', 'A:8000:8000:6400:8.0000 Qt @1000=8000/c800/product/manual', '2 Gal of a quart product bills as 8 Qt');
  after('dottedSmall', 'A:117:117:70:0.0234 Gal @4992=117/c3000/product/manual', '3 fl. oz books the cost of 3 fl oz (70c at $30/Gal), not of 3 gallons');
  after('rupSmall', 'A:117:117:70:0.0234 Gal @4992=117/c3000/product/manual', 'a restricted-use line carries its real 0.0234 Gal');
  after('rupSupplied', 'A:0:0:0:10.0000 Gal @0=0/c0/none/manual', "the grower's own restricted-use product has no catalog link, so no sales record");
  // Mason, 2026-11-22 ("we never bill flat per acre"): a field's per-acre price is not billed; the lines are.
  after('overrideSmall', 'A:117:117:70:0.0234 Gal @4992=117/c3000/product/manual', 'a per-acre-priced field bills its lines, not $10/acre');
  after('overrideNormal', 'A:50000:50000:30000:10.0000 Gal @5000=50000/c3000/product/manual', 'a per-acre-priced field with a normal line bills its lines');
  // Two owners (60/40): the quantity is allocated by acre share at one price; header = share = lines per owner.
  after('splitSmall', 'A:70:70:42:0.0140 Gal @4992=70/c3000/product/manual B:47:47:28:0.0094 Gal @4992=47/c3000/product/manual',
    'the owners split 0.0234 Gal 0.0140/0.0094, $0.70 + $0.47 = $1.17');
  after('splitNormal', 'A:30000:30000:18000:6.0000 Gal @5000=30000/c3000/product/manual B:20000:20000:12000:4.0000 Gal @5000=20000/c3000/product/manual',
    'the owners split 10 Gal 6/4');
  after('overrideSplit', 'A:30000:30000:18000:6.0000 Gal @5000=30000/c3000/product/manual B:20000:20000:12000:4.0000 Gal @5000=20000/c3000/product/manual',
    'two owners on a per-acre-priced field: no longer refused, each bills its lines');
  for (const k of ['feeMixed', 'feeMixedOverride']) after(k, 'A:150000:150000:70000:10.0000 Gal @5000=50000/c3000/product/manual,100.0000 acre @1000=100000/c40000/none/tier',
    'the spraying fee bills all 100 treated acres, with or without a per-acre price on the field');
  after('nullJobCost', 'A:50000:50000:30000:10.0000 Gal @5000=50000/c3000/product/manual', 'a line with no saved job cost books the catalog cost');
  after('dottedGalCost', 'A:117:117:70:0.0234 Gal @4992=117/c3000/product/manual', 'a per-Gal job cost saved against fl. oz books the catalog cost, not $30 an ounce');
  after('zeroJobCost', 'A:1500:1500:1500:0.5000 Gal @3000=1500/c3000/product/manual', 'a $0 job cost books the catalog cost (no commission on cost)');
  after('suppliedFirstSplit', 'A:4800:4800:3840:6.0000 Gal @0=0/c0/none/manual,4.8000 Qt @1000=4800/c800/product/manual B:3200:3200:2560:4.0000 Gal @0=0/c0/none/manual,3.2000 Qt @1000=3200/c800/product/manual',
    "a two-owner job whose first line is the grower's own product bills both owners");
  after('nearHundred', 'A:50000:50000:30000:10.0000 Gal @5000=50000/c3000/product/manual', 'a 99.99% split bills all $500.00 of its lines');
  for (const k of ['fullBelow', 'tenBelow', 'half64flozBelow', 'dottedBelow', 'spelledBelow']) {
    refusedProbe(CASES[k], /JOB_LINE_BELOW_COST: \[PROVER\] JBC chem is priced below its cost on this job\. Nothing was invoiced/);
    assert.doesNotMatch(probe(CASES[k]).output, /\b(3000|1500|30\.00|15\.00)\b/, 'the refusal never states the cost');
    console.log(`[after] ${k}: refused JOB_LINE_BELOW_COST, no cost shown, nothing billed`);
  }
  refusedProbe(CASES.perWordUnit, /JOB_LINE_UNIT_UNCONVERTIBLE/);
  console.log('[after] perWordUnit: refused JOB_LINE_UNIT_UNCONVERTIBLE');
  refusedProbe(CASES.dryBelow, /JOB_LINE_BELOW_COST: \[PROVER\] JBC dry/);
  console.log('[after] dryBelow: refused JOB_LINE_BELOW_COST');
  refusedProbe(CASES.eaUnit, /JOB_LINE_UNIT_UNCONVERTIBLE: \[PROVER\] JBC chem is recorded on this job in "Ea", which can't be converted to the unit it is sold in \("Gal"\)/);
  refusedProbe(CASES.perAcreUnit, /JOB_LINE_UNIT_UNCONVERTIBLE: \[PROVER\] JBC chem is recorded on this job in "Gal\/ac"/);
  console.log('[after] eaUnit, perAcreUnit: refused JOB_LINE_UNIT_UNCONVERTIBLE, naming the product and both units');
  refusedProbe(CASES.noSplitField, /JOB_FIELD_NO_BILLING_SPLIT: \[PROVER\] JBC field A, no billing defaults has no billing split/);
  console.log('[after] noSplitField: refused JOB_FIELD_NO_BILLING_SPLIT, naming the field');
  for (const k of ['gramsOnLiquid', 'perSoftHyphen']) refusedProbe(CASES[k], /JOB_LINE_UNIT_UNCONVERTIBLE/);
  console.log('[after] gramsOnLiquid, perSoftHyphen: refused JOB_LINE_UNIT_UNCONVERTIBLE');
  refusedProbe(CASES.gramsDry, /JOB_LINE_UNIT_UNCONVERTIBLE: \[PROVER\] JBC dry is recorded on this job in "g", which can't be converted to the unit it is sold in \("Lb"\)/);
  refusedProbe(CASES.mlLiquid, /JOB_LINE_UNIT_UNCONVERTIBLE: \[PROVER\] JBC chem is recorded on this job in "mL", which can't be converted to the unit it is sold in \("Gal"\)/);
  console.log('[after] gramsDry, mlLiquid: refused JOB_LINE_UNIT_UNCONVERTIBLE (a metric unit other than the sold unit is not converted)');
  after('mgOnMg', 'A:1000:1000:500:500.0000 MG @2=1000/c1/product/manual', '500 mg of a product stocked by the MG bills as-is (no conversion)');
  after('payerB', 'B:50000:50000:30000:10.0000 Gal @5000=50000/c3000/product/manual', "A's job on a field billed 100% to B is invoiced to B");
  refusedProbe(CASES.noCost, /JOB_LINE_COST_MISSING: \[PROVER\] JBC grower chem has no cost recorded/);
  console.log('[after] noCost: refused JOB_LINE_COST_MISSING');
  refusedProbe(CASES.roundingBig, /JOB_LINE_ROUNDING: \[PROVER\] JBC chem can't be recorded to 4 decimals in Gal/);
  refusedProbe(CASES.roundingZero, /JOB_LINE_ROUNDING: \[PROVER\] JBC chem/);
  console.log('[after] roundingBig ($1.60 off), roundingZero (no quantity left): refused JOB_LINE_ROUNDING');
  refusedProbe(CASES.galOnQtFraction, /JOB_LINE_PRICE_NOT_WHOLE_CENTS: \[PROVER\] JBC quart chem is priced per "Gal" on this job, which comes to a fraction of a cent per "Qt".*whole cents per "Qt" \(for example \$41\.52\)\./);
  console.log('[after] galOnQtFraction (40 Gal at $41.50 = $10.375 per Qt): refused JOB_LINE_PRICE_NOT_WHOLE_CENTS, suggesting $41.52');
  for (const k of ['suppliedNaN', 'suppliedNaNSplit']) refusedProbe(CASES[k], /cannot convert NaN/);
  console.log('[after] suppliedNaN, suppliedNaNSplit: refused (NaN quantity), nothing billed');
  for (const [k, who] of [['resaveSmallAdmin', 'admin'], ['resaveSmallRep', 'sales rep']]) {
    const v = okProbe(CASES[k]);
    console.log(`[after] ${k}: ${v}`);
    assert.equal(v, 'A:117:117:70:0.0234 Gal @4992=117/c3000/product/manual | approvals=0', `a ${who}'s ordinary re-save keeps the line`);
  }
  for (const [k, who] of [['resaveSuppliedAdmin', 'admin'], ['resaveSuppliedRep', 'sales rep']]) {
    const v = okProbe(CASES[k]);
    console.log(`[after] ${k}: ${v}`);
    assert.equal(v, 'A:0:0:0:10.0000 Gal @0=0/c0/none/manual | approvals=0', `a ${who}'s ordinary re-save keeps the $0 information line`);
  }
  refusedProbe(CASES.deletedTicket, /BLEND_TICKET_ALREADY_BILLED/);
  console.log('[after] deletedTicket: a deleted blend ticket with a live invoice blocks (BLEND_TICKET_ALREADY_BILLED)');
  refusedProbe(CASES.deletedJob, /JOB_DELETED/);
  console.log('[after] deletedJob: refused JOB_DELETED');
  after('savedPayer', 'A:50000:50000:30000:10.0000 Gal @5000=50000/c3000/product/manual', 'the payer saved on the job (A) is billed, not the Field Setup payer (B)');
  assert.equal(okProbe(CASES.notesOtherPayer), 'A=JBC private note B=none', "split: the job's notes print on A's (the job customer's) invoice only");
  assert.equal(okProbe(CASES.notesSoleOtherPayer), 'B=none', "another payer's sole invoice never carries the job customer's notes");
  console.log("[after] notesOtherPayer, notesSoleOtherPayer: job notes print only on the job customer's own invoice");
  after('savedSplit', 'A:30000:30000:18000:6.0000 Gal @5000=30000/c3000/product/manual B:20000:20000:12000:4.0000 Gal @5000=20000/c3000/product/manual',
    "the split saved on the job (A 60/B 40) is billed, not Field Setup's A 100%");
  {
    const v = okProbe(CASES.sameProductTwoLines);
    console.log(`[after] sameProductTwoLines: ${v}`);
    assert.match(v, /^A:25000:25000:15000:/, 'company stock and the grower\'s own of one product: the company line bills $250');
    assert.ok(v.includes('5.0000 Gal @5000=25000/c3000/product/manual') && v.includes('5.0000 Gal @0=0/c0/none/manual') && v.endsWith(ok),
      "both lines are written: the company sale and the grower's $0 line");
  }
  for (const k of ['lockedFields', 'lockedChem', 'lockedShares']) {
    refusedProbe(CASES[k], /JOB_INVOICED_LOCKED: This job has been invoiced, so its chemicals, fields and billing split can't be changed\. Nothing was saved/);
    console.log(`[after] ${k}: refused JOB_INVOICED_LOCKED`);
  }
  assert.equal(okProbe(CASES.editCompleted), 'changed', "a completed job's rows can still be changed by the table owner");
  console.log("[after] editCompleted: a completed (not invoiced) job's fields and split can still be changed (the lock is for invoiced jobs)");
  // #2283: save_job refuses any change to a completed job's (product, quantity, unit, supplied) lines; nothing is saved.
  for (const [k, chem] of Object.entries(SAVES)) for (const [who, uid] of [['admin', ADMIN], ['sales rep', REP]]) {
    refusedProbe(saveJob(uid, { chem, hdr: `jsonb_set(h, '{notes}', '"edited"')` }),
      /JOB_COMPLETED_CHEMICALS_LOCKED: This job is complete, so its chemicals can't be changed: completion already took them from stock\. Nothing was saved\./);
    console.log(`[after] completed job, ${who}, chemical ${k}: refused JOB_COMPLETED_CHEMICALS_LOCKED, nothing saved`);
  }
  {
    const same = okProbe(saveJob(ADMIN, { jobSql: `jbc.twoline('${G}')`,
      chem: `(SELECT jsonb_agg(jsonb_set(e, '{quantity}', to_jsonb((e ->> 'quantity') || '.0')) ORDER BY o DESC) FROM jsonb_array_elements(c) WITH ORDINALITY t(e, o))`,
      hdr: `jsonb_set(h, '{notes}', '"edited"')` }));
    console.log(`[after] completed job, same lines reordered as 10.0 and 8.0, note edited: ${same}`);
    assert.equal(same, '1:10:Gal:t,5:8:Qt:f note=edited', "a completed job's unchanged lines save, and other changes save");
  }
  for (const status of ['scheduled', 'in_progress']) {
    const v = okProbe(saveJob(ADMIN, { status, chem: SAVES.qty }));
    console.log(`[after] ${status} job, quantity 10 -> 12: ${v}`);
    assert.equal(v, '1:12:Gal:f note=-', `a ${status} job's chemicals still save`);
  }
  {
    const replay = okProbe(`${asAdmin}
CREATE TEMP TABLE j AS SELECT ${job('Gal', 10, 5000)} AS id;
SELECT jbc.set_status((SELECT id FROM j), 'scheduled');
CREATE TEMP TABLE a AS SELECT jbc.hdr(id) AS h, jbc.flds(id) AS f, jsonb_set(jsonb_set(jbc.chems(id), '{0,quantity}', '12'), '{0,rate_per_acre}', '1.2') AS c FROM j;
SELECT public.save_job((SELECT id FROM j), h, f, c, '${ADMIN}', 'jbc-replay-1') FROM a;
SELECT jbc.set_status((SELECT id FROM j), 'completed');
SELECT public.save_job((SELECT id FROM j), h, f, c, '${ADMIN}', 'jbc-replay-1') ->> 'job_id' = (SELECT id FROM j)::text FROM a;
SELECT jbc.lines((SELECT id FROM j));`);
    console.log(`[after] a scheduled job's save replayed after completion: ${replay}`);
    assert.equal(replay, '1:12:Gal:f note=-', 'a replayed key returns its first result and changes nothing');
  }
  refusedProbe(saveJob(APP, { chem: SAVES.qty }), /INSUFFICIENT_ROLE/);
  console.log('[after] an applicator saving a completed job: refused INSUFFICIENT_ROLE as before');
  refusedProbe(`${transferOnly(job('Gal', 10, 5000))}
SELECT public.save_job((SELECT id FROM j), jbc.hdr((SELECT id FROM j)), jbc.flds((SELECT id FROM j)), jbc.chems((SELECT id FROM j)), '${ADMIN}', 'jbc-' || gen_random_uuid());`,
  /JOB_INVOICED_LOCKED/);
  console.log('[after] an invoiced job saved: refused JOB_INVOICED_LOCKED');
  await concurrentLock();
  refusedProbe(directLine, /BELOW_COST_CONTEXT_REQUIRED/);
  console.log('[after] a below-cost invoice line written outside the transfer: still refused by the unchanged wall');

  // Rollback restores the transfer body and drops the helpers; the old refusals come back.
  stageText('reverse.sql', lf(path.join(ROOT, 'scripts', 'smoke', 'job-transfer-below-cost-reverse.sql')));
  const back = apply('reverse.sql');
  assert.equal(back.status, 0, back.output);
  assert.equal(md5Of(IMPL), OLD_BODY);
  assert.equal(md5Of(WALL), OLD_WALL);
  assert.equal(acl(WALL), wallAcl);
  assert.equal(grants(IMPL), implGrants);
  assert.equal(md5Of(SAVE), OLD_SAVE, 'rollback restores save_job');
  assert.equal(grants(SAVE), saveGrants);
  assert.equal(okProbe(saveJob(ADMIN, { chem: SAVES.qty })), '1:12:Gal:f note=-', 'rollback: the completed-job refusal is gone');
  assert.equal(scalar(`SELECT to_regprocedure('${PRICE}') IS NULL AND to_regprocedure('${SPLIT}') IS NULL AND to_regprocedure('${SHARES}') IS NULL AND to_regprocedure('${LOCK}') IS NULL;`), 't');
  assert.equal(okProbe(CASES.lockedFields), 'changed', 'rollback: the lock triggers are gone');
  refusedProbe(CASES.small3floz, /BELOW_COST_CONTEXT_REQUIRED/);
  console.log('[rollback] transfer body and grants restored, helpers and lock triggers dropped; 3 fl oz is refused again');
  console.log('JOB_TRANSFER_BELOW_COST_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
