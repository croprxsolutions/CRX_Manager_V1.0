#!/usr/bin/env node
/**
 * Real-schema proof for the security batch (contract docs/plans/2026-11-18-security-batch-ki121-124-CONTRACT.md):
 *   20270127100000_security_batch_ki121_ki123.sql (the candidate)
 *   scripts/smoke/security-batch-ki123-reverse.sql (its rollback)
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, commits invented test users (ids 5ec5ec5e-...), then:
 *   before  the only active admin CAN be demoted (KI-121), and anon holds read grants (KI-123);
 *   apply   the candidate applies;
 *   K1-K5   demoting or deactivating the last active admin is refused (direct update and admin_update_profile);
 *           with two admins one demotion works; promotions and no-op saves pass;
 *   K6      two admins demoting each other at once: the second waits on the first, then is refused;
 *           under REPEATABLE READ the second fails with a serialization error instead;
 *   K7      three admins, two removals at once on different rows: both succeed, no deadlock;
 *   P2      a reset row planted before the lock is relabelled unverified_;
 *   P1      a signed-in user can no longer write the server-only auth_password_reset rows, but still logs
 *           their own activity;
 *   A1-A3   anon is refused on every public table, view, column and sequence; a signed-in admin still reads;
 *           a table, view and sequence postgres creates afterwards give anon nothing;
 *   again   a second apply refuses (SECURITY_BATCH_PREFLIGHT);
 *   reverse the rollback restores the old guard body (md5) and comment and anon's rights as they were before the candidate;
 *           the candidate re-applies cleanly after it.
 *
 * Run: node scripts/smoke/prove-security-batch-ki121-ki123-real-schema.mjs   (needs Docker)
 * Prints SECURITY_BATCH_KI121_KI123_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a fresh, network-disabled container: there is no reuse mode, so the proof can only write to its own database.
const NAME = `crx-sec-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270127100000_security_batch_ki121_ki123.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'security-batch-ki123-reverse.sql');
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
  // Need live's storage.objects policies, which this database does not have; neither touches profiles or anon grants.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that changes the guard, grants anon anything, or changes default privileges.
const TOUCHED = /(_guard_last_active_admin|TO\s+anon\b|DEFAULT\s+PRIVILEGES)/i;
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
    /CREATE OR REPLACE FUNCTION public.field_app_priced_quantity\([\s\S]*?AS \$fapq\$([\s\S]*?)\$fapq\$;/)
    .replaceAll('\r\n', '\n');  // pinned live body is LF (file is eol=lf); same bytes on any checkout
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
const n = (sql) => Number(scalar(sql));
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
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

const id = (s) => `5ec5ec5e-0000-4000-8000-${String(s).padStart(12, '0')}`;
const X = id('a1'), Y = id('a2'), R = id('b1');
const GUARD_OLD = '411de704268c49ac63b2755486b61ad5';
const logAs = (eventType, by) => `INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('${eventType}', '[PROVER] SEC', '${by}', 'profile', '${X}') RETURNING 'logged';`;
function policyRefuses() {
  refusedProbe(logAs('auth_password_reset', R), /row-level security/, R);
  refusedProbe(logAs('auth_password_reset_failed', R), /row-level security/, R);
  assert.equal(okProbe(logAs('quote_created', R), R), 'logged');
  assert.equal(okProbe(logAs('user_password_reset', X), X), 'logged');
  refusedProbe(logAs('quote_created', X), /row-level security/, R);
}
const guardMd5 = () => scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._guard_last_active_admin()'::regprocedure;");
const activeAdmins = () => scalar("SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM public.profiles WHERE role = 'admin' AND is_active;");
// Every anon right in public as md5:count: table/view SELECT, column-only SELECT, sequence rights.
const anonItemsSql = (select) => `WITH rel AS MATERIALIZED (SELECT oid, relname, relkind FROM pg_class WHERE relnamespace = 'public'::regnamespace),
  seq AS MATERIALIZED (SELECT oid, relname FROM rel WHERE relkind = 'S')
  SELECT ${select} FROM (
    SELECT 't:' || relname AS x FROM rel WHERE relkind IN ('r','v','m','p','f') AND has_table_privilege('anon', oid, 'SELECT')
    UNION ALL SELECT 'c:' || r.relname || '.' || a.attname FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE r.relkind IN ('r','v','m','p','f') AND NOT has_table_privilege('anon', r.oid, 'SELECT') AND has_column_privilege('anon', r.oid, a.attnum, 'SELECT')
    UNION ALL SELECT 's:' || relname || ':' || has_sequence_privilege('anon', oid, 'SELECT') || has_sequence_privilege('anon', oid, 'UPDATE') || has_sequence_privilege('anon', oid, 'USAGE')
      FROM seq WHERE has_sequence_privilege('anon', oid, 'SELECT') OR has_sequence_privilege('anon', oid, 'UPDATE') OR has_sequence_privilege('anon', oid, 'USAGE')
  ) i;`;
const anonInventory = () => scalar(anonItemsSql(`md5(coalesce(string_agg(x, ';' ORDER BY x), '')) || ':' || count(*)`));
const anonItems = () => new Set(scalar(anonItemsSql(`coalesce(string_agg(x, ';' ORDER BY x), '')`)).split(';').filter(Boolean));
const setDiff = (a, b) => [...a].filter((x) => !b.has(x));
const count = (inv) => inv.split(':')[1];
const asAnon = (sql) => probe(`SET LOCAL ROLE anon;\n${sql}`);
// Test rows only: X, Y, R become admin (if listed) or sales_rep, all active, with triggers off.
const setAdmins = (ids) => raw(`UPDATE public.profiles SET role = CASE WHEN id = ANY(ARRAY['${ids.join("','")}']::uuid[]) THEN 'admin' ELSE 'sales_rep' END,
  is_active = true WHERE id IN ('${X}', '${Y}', '${R}');`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${X}', 'sec-x@example.invalid', '{"full_name":"[PROVER] SEC Admin X"}'::jsonb),
    ('${Y}', 'sec-y@example.invalid', '{"full_name":"[PROVER] SEC Admin Y"}'::jsonb),
    ('${R}', 'sec-r@example.invalid', '{"full_name":"[PROVER] SEC Rep R"}'::jsonb);`);
  setAdmins([X]);
  assert.equal(activeAdmins(), X, 'the test database must start with exactly one active admin');
  console.log('[prover] committed test rows: active admin X, active rep R, and Y (admin or rep per case)');
}

const demote = (target) => `UPDATE public.profiles SET role = 'sales_rep' WHERE id = '${target}' RETURNING 'demoted';`;
const deactivate = (target) => `UPDATE public.profiles SET is_active = false WHERE id = '${target}' RETURNING 'deactivated';`;
const viaRpc = (target, role) => `SELECT public.admin_update_profile(target_user_id => '${target}', new_role => '${role}', new_full_name => NULL,
  new_phone => NULL, new_is_active => true, p_idempotency_key => 'sec-${Math.random().toString(36).slice(2)}')::text;`;

function guardCases() {
  setAdmins([X]);
  refusedProbe(demote(X), /LAST_ACTIVE_ADMIN: cannot remove or deactivate the only active admin/, X);
  const rpc = probe(viaRpc(X, 'sales_rep'), X);
  assert.match(rpc.output, /LAST_ACTIVE_ADMIN/, `admin_update_profile let the last admin demote themself:\n${rpc.output}`);
  console.log('[case] K1 the only admin demoting themself is refused (direct update and admin_update_profile: LAST_ACTIVE_ADMIN)');
  refusedProbe(deactivate(X), /LAST_ACTIVE_ADMIN/, X);
  refusedProbe(`UPDATE public.profiles SET role = 'sales_rep', is_active = false WHERE id = '${X}';`, /LAST_ACTIVE_ADMIN/, X);
  console.log('[case] K2 deactivating the only admin, or demoting and deactivating at once, is still refused');
  setAdmins([X, Y]);
  assert.equal(okProbe(demote(Y), X), 'demoted');
  const viaApp = probe(viaRpc(Y, 'sales_rep'), X);
  assert.equal(viaApp.status, 0, viaApp.output);
  assert.match(viaApp.output, /"success"\s*:\s*true/, viaApp.output);
  console.log('[case] K3 with two admins, demoting one works (direct update and admin_update_profile)');
  setAdmins([X]);
  assert.equal(okProbe(`UPDATE public.profiles SET role = 'admin' WHERE id = '${R}' RETURNING 'promoted';`, X), 'promoted');
  assert.equal(okProbe(`UPDATE public.profiles SET role = 'admin', is_active = true, full_name = full_name WHERE id = '${X}' RETURNING 'kept';`, X), 'kept');
  assert.equal(okProbe(`UPDATE public.profiles SET role = 'driver' WHERE id = '${R}' RETURNING 'rep moved';`, X), 'rep moved');
  console.log('[case] K4 promoting a rep, a no-op save of the last admin, and moving a non-admin between roles all pass');
  setAdmins([X, Y]);
  refusedProbe(`UPDATE public.profiles SET role = 'sales_rep' WHERE id IN ('${X}', '${Y}');`, /LAST_ACTIVE_ADMIN/, X);
  console.log('[case] K5 one statement demoting every admin at once is refused');
}

function session(sql) {
  const child = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT });
  const result = { out: '' };
  child.stdout.on('data', (d) => { result.out += d; }); child.stderr.on('data', (d) => { result.out += d; });
  result.done = new Promise((resolve) => child.on('close', resolve));
  child.stdin.end(sql);
  return result;
}

// A (signed in as X) demotes Y and holds its transaction open; B (signed in as Y) then demotes X.
async function raceCase(isolation) {
  setAdmins([X, Y]);
  const a = session(`BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${X}","role":"authenticated"}', true);
${demote(Y)}
SELECT pg_sleep(4);
COMMIT;
`);
  let holding = false;
  for (let i = 0; i < 40 && !holding; i += 1) {
    wait(250);
    holding = scalar("SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%pg_sleep(4)%' AND state = 'active';") !== '0';
  }
  assert.ok(holding, `session A never reached its sleep:\n${a.out}`);
  const b = session(`BEGIN ISOLATION LEVEL ${isolation};
SELECT set_config('request.jwt.claims', '{"sub":"${Y}","role":"authenticated"}', true);
SELECT 'snapshot:' || count(*) FROM public.profiles WHERE role = 'admin' AND is_active;
${demote(X)}
COMMIT;
`);
  let waited = false;
  for (let i = 0; i < 40 && !waited; i += 1) {
    wait(150);
    waited = scalar("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted;") !== '0';
  }
  assert.ok(waited, `session B never waited on the guard's lock:\n${b.out}`);
  assert.equal(await a.done, 0, a.out);
  assert.match(a.out, /demoted/);
  await b.done;
  assert.match(b.out, /snapshot:2/, b.out);
  if (isolation === 'READ COMMITTED') assert.match(b.out, /LAST_ACTIVE_ADMIN/, b.out);
  else assert.match(b.out, /could not serialize access/, b.out);
  assert.doesNotMatch(b.out, /^demoted$/m);
  assert.equal(activeAdmins(), X, 'exactly one admin (X) must remain');
  console.log(`[case] K6 ${isolation}: two admins demote each other at once; B waited on A's lock, then was refused (${isolation === 'READ COMMITTED' ? 'LAST_ACTIVE_ADMIN' : 'serialization error'}); X stays the active admin`);
}

// The reviewers' deadlock case: with three admins, X demotes Y while R demotes X at the same moment.
// Both are allowed (one admin remains), and neither may fail with a deadlock.
async function noDeadlockCase() {
  setAdmins([X, Y, R]);
  const a = session(`BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${X}","role":"authenticated"}', true);
${demote(Y)}
SELECT pg_sleep(3);
COMMIT;
`);
  let holding = false;
  for (let i = 0; i < 40 && !holding; i += 1) {
    wait(250);
    holding = scalar("SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%pg_sleep(3)%' AND state = 'active';") !== '0';
  }
  assert.ok(holding, `session A never reached its sleep:
${a.out}`);
  const b = session(`BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${R}","role":"authenticated"}', true);
${demote(X)}
COMMIT;
`);
  assert.equal(await a.done, 0, a.out);
  assert.equal(await b.done, 0, b.out);
  assert.doesNotMatch(a.out + b.out, /deadlock|ERROR/i);
  assert.equal(activeAdmins(), R, 'R must be the one admin left');
  console.log('[case] K7 three admins: X demotes Y while R demotes X at once; both succeed, no deadlock, R remains');
}

function anonCases() {
  assert.equal(count(anonInventory()), '0', 'anon still holds rights in public');
  for (const table of ['profiles', 'customers', 'invoices', 'quotes', 'products', 'payments', 'view_unmigrated_products']) {
    const r = asAnon(`SELECT 1 FROM public.${table} LIMIT 1;`);
    assert.notEqual(r.status, 0, `anon read ${table}`); assert.match(r.output, /permission denied/);
  }
  const s = asAnon("SELECT nextval('public.invoice_number_seq');");
  assert.notEqual(s.status, 0); assert.match(s.output, /permission denied/);
  const c = asAnon('SELECT id FROM public.invoices LIMIT 1;');
  assert.match(c.output, /permission denied/, 'column-level anon read of invoices.id survived');
  console.log('[case] A1 anon holds no right on any public table, view, column or sequence; reads of profiles, customers, invoices (column grant), quotes, products, payments, a view, and invoice_number_seq are all refused');
  setAdmins([X]);
  assert.equal(okProbe('SELECT count(*) > 0 FROM public.profiles;', X), 't');
  assert.equal(okProbe('SELECT count(*) >= 0 FROM public.customers;', X), 't');
  console.log('[case] A2 a signed-in admin still reads profiles and customers');
  const fresh = probe(`CREATE TABLE public.zz_sec_probe (id serial PRIMARY KEY);
CREATE VIEW public.zz_sec_probe_v AS SELECT id FROM public.zz_sec_probe;
SELECT has_table_privilege('anon', 'public.zz_sec_probe', 'SELECT')::text || has_table_privilege('anon', 'public.zz_sec_probe_v', 'SELECT')::text
  || has_sequence_privilege('anon', 'public.zz_sec_probe_id_seq', 'USAGE')::text;`);
  assert.equal(fresh.status, 0, fresh.output);
  assert.equal(fresh.last, 'falsefalsefalse');
  console.log('[case] A3 a table, view and sequence postgres creates afterwards give anon nothing (created and rolled back)');
}

async function main() {
  buildContainer();
  installLiveAuthUid();
  seed();
  assert.equal(guardMd5(), GUARD_OLD, 'the guard before the candidate is not the reviewed live body');
  const inventoryBefore = anonInventory();
  const itemsBefore = anonItems();
  assert.notEqual(count(inventoryBefore), '0');
  assert.equal(okProbe(demote(X), X), 'demoted', 'before the fix the last admin should be demotable (KI-121)');
  assert.equal(okProbe(logAs('auth_password_reset', R), R), 'logged');
  psql(`INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
    VALUES ('auth_password_reset', '[PROVER] SEC planted', '${R}', 'profile', '${X}');`);
  console.log(`[case] B before the fix the only admin CAN be demoted, a rep CAN write an auth_password_reset row, and anon holds ${count(inventoryBefore)} rights in public`);

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.notEqual(guardMd5(), GUARD_OLD);

  guardCases();
  await raceCase('READ COMMITTED');
  await raceCase('REPEATABLE READ');
  await noDeadlockCase();
  anonCases();
  policyRefuses();
  assert.equal(scalar("SELECT event_type FROM public.activity_feed WHERE description = '[PROVER] SEC planted';"), 'unverified_auth_password_reset');
  console.log('[case] P2 a reset row written before the lock is relabelled unverified_auth_password_reset');
  console.log('[case] P1 a rep cannot write auth_password_reset or auth_password_reset_failed rows; own activity and the screen user_password_reset row still log; forged performed_by still refused');

  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /SECURITY_BATCH_PREFLIGHT/);
  console.log('[case] AG a second apply refuses (SECURITY_BATCH_PREFLIGHT)');

  stageText('reverse.sql', lf(REVERSE));
  const rev = apply('reverse.sql');
  assert.equal(rev.status, 0, rev.output);
  assert.equal(guardMd5(), GUARD_OLD, 'the reverse did not restore the old guard body');
  assert.match(scalar("SELECT obj_description('public._guard_last_active_admin()'::regprocedure, 'pg_proc');"), /^Refuses to deactivate the last active admin/);
  const inventoryAfter = anonInventory();
  console.log(`[prover] anon rights before the candidate ${inventoryBefore}; after the reverse ${inventoryAfter}`);
  if (inventoryAfter !== inventoryBefore) {
    const itemsAfter = anonItems();
    console.log(`[prover] missing after the reverse: ${JSON.stringify(setDiff(itemsBefore, itemsAfter))}`);
    console.log(`[prover] extra after the reverse: ${JSON.stringify(setDiff(itemsAfter, itemsBefore))}`);
  }
  assert.equal(inventoryAfter, inventoryBefore, "the reverse did not restore anon's rights exactly as they were");
  setAdmins([X]);
  assert.equal(okProbe(demote(X), X), 'demoted');
  policyRefuses();
  console.log('[case] R the reverse restores the old guard (md5 411de704), keeps the reset-row lock, and exactly the anon rights the database had before');

  const reapply = apply('candidate.sql');
  assert.equal(reapply.status, 0, reapply.output);
  refusedProbe(demote(X), /LAST_ACTIVE_ADMIN/, X);
  assert.equal(count(anonInventory()), '0');
  policyRefuses();
  console.log('[case] RA the candidate re-applies after the reverse and the guard and lockdown hold again');
  console.log('SECURITY_BATCH_KI121_KI123_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
