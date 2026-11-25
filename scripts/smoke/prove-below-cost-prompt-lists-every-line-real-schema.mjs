#!/usr/bin/env node
/**
 * Real-schema proof for 20270307100000_below_cost_prompt_lists_every_line (pricing audit fix 1, Mason 2026-11-25).
 * Container setup and replay copied from prove-grower-share-rep-cover-real-schema.mjs. Products P1, P2, P3 cost $10.00.
 * An admin's direct order: P1 2 @ $8.00 ($4.00 short), P2 3 @ $9.50 ($1.50 short), P3 1 @ $12.00 (above cost).
 *   BEFORE: the save stops at P1 with BELOW_COST_REASON_REQUIRED naming P1 only.
 *   AFTER: the RPC returns, COMMIT fails with ONE BELOW_COST_REASON_REQUIRED listing P1 and P2 (price, cost, qty, shortfall)
 *   and the $5.50 total; nothing is saved. The retry with a reason saves and logs exactly those two approvals. A rep still
 *   gets BELOW_COST_ADMIN_REQUIRED at once, with no cost and no list. A line raised to cost, or deleted, later in the same
 *   save asks nothing; a line written twice is listed once with its latest price; 300 lines are all listed; no context
 *   still fails at once. The same refusal and retry run through a real PostgREST server over HTTP. Then a second apply
 *   stops at the preflight, the reverse restores the old body (first-line refusal again), and the candidate re-applies.
 *
 * Run: node scripts/smoke/prove-below-cost-prompt-lists-every-line-real-schema.mjs   (needs Docker)
 * Prints BELOW_COST_LIST_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Iterating: CRX_PROVER_REUSE=<kept container> CRX_PROVER_DB=<a copy of its replayed database> skips the replay.
const REUSE = process.env.CRX_PROVER_REUSE;
const NAME = REUSE || `crx-bcl-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
// Shell commands below name the database; only a bare name is accepted (Sol r1).
if (!/^[a-z0-9_]+$/.test(DB)) throw new Error('CRX_PROVER_DB must be a bare database name (a-z, 0-9, _)');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270307100000_below_cost_prompt_lists_every_line.sql');
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
  // Its preflight pins stage_offline_action as 20261217100000 (ledger-only above) leaves it; delivery driver checks only.
  '20270227110000_delivery_driver_checks_need_a_driver.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate changes or relies on.
// Also what the proof relies on: the field-app single save and the approval log.
const TOUCHED = /(_enforce_below_cost_line|_raise_below_cost_reason_list|crx_below_cost_pending|zz_crx_below_cost|below_cost_approvals)/i;
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
  for (const name of [...PARKED, '20270227110000_delivery_driver_checks_need_a_driver.sql']) {
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


// A COMMITTED transaction as a signed-in user, so the deferred trigger fires at COMMIT, after the RPC returned.
function committed(sql, uid) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;\n` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${claims}${sql}\nSELECT 'STATEMENTS_DONE';\nCOMMIT;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
// As postgres, in the admin's name, inside a declared below-cost operation with no reason (the wrapper's settings).
function asAdminWrite(sql, operation = 'update_order_items') {
  return committed(`SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
SELECT set_config('app.crx_below_cost_operation', '${operation}', true);
SELECT set_config('app.crx_below_cost_reason', '', true);
${sql}`);
}
function detail(output, prefix = 'BELOW_COST_REASON_REQUIRED') {
  const line = output.split(/\r?\n/).find((l) => l.includes(`${prefix}:`));
  assert.ok(line, `expected ${prefix}:\n${output}`);
  return JSON.parse(line.slice(line.indexOf(`${prefix}:`) + prefix.length + 1));
}
const refusedAtCommit = (r) => {
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /STATEMENTS_DONE/, `the refusal must come at COMMIT, after every statement ran:\n${r.output}`);
  return detail(r.output);
};

const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'below-cost-prompt-lists-every-line-reverse.sql');
const id = (s) => `b7b7b7b7-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), REP = id('a2'), C = id('c1'), P1 = id('d1'), P2 = id('d2'), P3 = id('d3');
const GUARD = 'public._enforce_below_cost_line()';
const body = () => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${GUARD}'::regprocedure;`);
const grants = () => scalar(`SELECT COALESCE(string_agg(g, ',' ORDER BY g), '-') FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
  FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${GUARD}'::regprocedure AND a.privilege_type = 'EXECUTE') x;`);
const OLD_BODY = '5fa0a5f975dc2a84b3c6599a84b8cc55';
const NEW_BODY = process.env.CRX_BCL_NEW_BODY || 'e982656e78d23e9345411f1a7bb83b01';

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'bcl-admin@example.invalid', '{"full_name":"[PROVER] BCL Admin","role":"admin"}'::jsonb),
    ('${REP}', 'bcl-rep@example.invalid', '{"full_name":"[PROVER] BCL Rep","role":"sales_rep"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active, assigned_sales_rep) VALUES ('${C}', '[PROVER] BCL Farm', 1, true, '${REP}');
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active) VALUES
      ('${P1}', '[PROVER] BCL one', 'BCL-1', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 10, 30, 30, 30, true),
      ('${P2}', '[PROVER] BCL two', 'BCL-2', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 10, 30, 30, 30, true),
      ('${P3}', '[PROVER] BCL three', 'BCL-3', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 10, 30, 30, 30, true);`);
  console.log('[prover] committed test rows: an admin, a sales rep (assigned to the farm), products one/two/three at $10.00 cost');
}
const ITEMS = [
  { product_id: P1, product_name: '[PROVER] BCL one', quantity: 2, price_per_unit: 8, unit_cost: 10, unit_size: null },
  { product_id: P2, product_name: '[PROVER] BCL two', quantity: 3, price_per_unit: 9.5, unit_cost: 10, unit_size: null },
  { product_id: P3, product_name: '[PROVER] BCL three', quantity: 1, price_per_unit: 12, unit_cost: 10, unit_size: null },
];
const orderArgs = (uid, tag, notes = null) => ({
  p_customer_id: C, p_order_date: '2026-11-25', p_order_name: `[PROVER] BCL ${tag}`, p_notes: notes,
  p_items: ITEMS, p_performed_by: uid, p_idempotency_key: `bcl-${tag}`,
});
const lit = (v) => (v === null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
const orderSql = (a) => `SELECT public.create_direct_order(${lit(a.p_customer_id)}::uuid, ${lit(a.p_order_date)}::date, ${lit(a.p_order_name)}, ${lit(a.p_notes)}, ${lit(JSON.stringify(a.p_items))}::jsonb, ${lit(a.p_performed_by)}::uuid, ${lit(a.p_idempotency_key)});`;
const orders = (tag) => scalar(`SELECT count(*) FROM public.orders WHERE order_name = '[PROVER] BCL ${tag}';`);
const approvals = (tag) => scalar(`SELECT COALESCE(string_agg(a.actor_user_id::text || ':' || p.product_name || ':' || a.unit_price_cents || ':' || a.locked_unit_cost_cents || ':' || a.quantity::numeric(12,2) || ':' || a.total_shortfall_cents, ',' ORDER BY p.product_name), '-')
  FROM public.below_cost_approvals a JOIN public.products p ON p.id = a.product_id
  WHERE a.entity_id = (SELECT id FROM public.orders WHERE order_name = '[PROVER] BCL ${tag}');`);
const EXPECTED_LINES = [
  { product_id: P1, product_name: '[PROVER] BCL one', unit_price_cents: 800, locked_unit_cost_cents: 1000, quantity: 2, line_shortfall_cents: 400, per: 'unit' },
  { product_id: P2, product_name: '[PROVER] BCL two', unit_price_cents: 950, locked_unit_cost_cents: 1000, quantity: 3, line_shortfall_cents: 150, per: 'unit' },
];
function checkList(d, label) {
  assert.equal(d.operation, 'create_direct_order', label);
  assert.equal(d.product_name, '[PROVER] BCL one', `${label}: the top-level fields are the first line's`);
  assert.deepEqual(d.lines.map(({ product_id, product_name, unit_price_cents, locked_unit_cost_cents, quantity, line_shortfall_cents, per }) =>
    ({ product_id, product_name, unit_price_cents, locked_unit_cost_cents, quantity: Number(quantity), line_shortfall_cents, per })), EXPECTED_LINES, label);
  assert.equal(d.line_count, 2, label); assert.equal(d.more_count, 0, label); assert.equal(d.total_shortfall_cents, 550, label);
}

const INV = id('e1'), INV_LINE = id('e2'), INV_DELIVERY = id('e3');
// The approved order's line for product one ($8.00, cost $10.00); the invoice line descends from it, repriced to $7.00.
const INV_OI = `SELECT oi.id FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id WHERE o.order_name = '[PROVER] BCL inv' AND oi.product_id = '${P1}'`;
const resaveSql = `SELECT public.save_invoice(${lit(JSON.stringify({ id: INV, customer_id: C, invoice_type: 'chemical_sale', salesman_id: ADMIN, invoice_date: '2026-11-25' }))}::jsonb,
  jsonb_build_array(${lit(JSON.stringify({ id: INV_LINE, product_id: P1, description: '[PROVER] BCL one', quantity: 2, unit_price_cents: 700, extended_cents: 1400, cost_cents: 1000, sort_order: 0 }))}::jsonb
    || jsonb_build_object('order_item_id', (${INV_OI}))), 'bcl-resave');`;

// One order line (from the approved order) copied N times at a given price, inside the admin's no-reason operation.
const copyLine = (src, n, price) => `INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, total_units_needed)
  SELECT order_id, product_id, product_name, ${price}, 2 FROM public.order_items, generate_series(1, ${n}) WHERE id = '${src}'`;

async function main() {
  if (REUSE) {
    assert.match(REUSE, /^crx-[a-z0-9-]+$/, 'CRX_PROVER_REUSE must name a kept prover container (crx-...)');
    assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', REUSE]).stdout.trim(), 'none', 'CRX_PROVER_REUSE must be a network-less prover container');
    assert.match(DB, /^bcl_run_[a-z0-9_]+$/, 'CRX_PROVER_REUSE needs CRX_PROVER_DB naming a fresh copy called bcl_run_<n>');
  } else buildContainer();
  assert.equal(body(), OLD_BODY, 'the replayed guard is not the body the candidate expects');
  assert.equal(scalar(`SELECT count(*) FROM auth.users WHERE id = '${ADMIN}';`), '0', 'this database was already used by a proof run: make a fresh copy');
  const guardGrants = grants();
  seed();

  // BEFORE: the first below-cost line stops the save, so the prompt can name only it.
  const before = committed(orderSql(orderArgs(ADMIN, 'before')), ADMIN);
  assert.notEqual(before.status, 0, before.output);
  assert.doesNotMatch(before.output, /STATEMENTS_DONE/, 'before: the refusal comes at the first line, inside the RPC');
  const b = detail(before.output);
  assert.equal(b.product_name, '[PROVER] BCL one'); assert.equal(b.lines, undefined);
  console.log('[before] an admin\'s order with two below-cost lines stops at the first; the refusal names only "one", no list');

  // Case 12 seed: a draft invoice on an approved order holding one order-linked line repriced below the order's price
  // ($8.00 -> $7.00, cost $10.00), as an earlier approved save left it. Seeded as the owner with triggers off; save_invoice then re-saves it unchanged.
  assert.equal(committed(orderSql(orderArgs(ADMIN, 'inv', 'Below-cost approved: seed')), ADMIN).status, 0);
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.invoices (id, invoice_number, order_id, customer_id, invoice_type, status, invoice_date, created_by, salesman_id, total_amount_cents)
      SELECT '${INV}', 'PROVER-BCL-INV', id, '${C}', 'chemical_sale', 'draft', DATE '2026-11-25', '${ADMIN}', '${ADMIN}', 1600 FROM public.orders WHERE order_name = '[PROVER] BCL inv';
    INSERT INTO public.invoice_items (id, invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order)
      VALUES ('${INV_LINE}', '${INV}', (${INV_OI}), '${P1}', '[PROVER] BCL one', 2, 700, 1400, 1000, 0);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, completed_at, signed_by, scheduled_date)
      SELECT '${INV_DELIVERY}', 'PROVER-BCL-D1', id, '${C}', '${ADMIN}', 'completed', now(), '[PROVER]', current_date FROM public.orders WHERE order_name = '[PROVER] BCL inv';
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
      SELECT '${INV_DELIVERY}', oi.id, oi.product_id, 2, 2, 'gal' FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
       WHERE o.order_name = '[PROVER] BCL inv' AND oi.product_id = '${P1}';
    COMMIT;`);
  const resaveBefore = committed(resaveSql, ADMIN);
  assert.notEqual(resaveBefore.status, 0, resaveBefore.output);
  assert.doesNotMatch(resaveBefore.output, /STATEMENTS_DONE/, 'before: the kept line refuses inside save_invoice');
  assert.equal(detail(resaveBefore.output).product_name, '[PROVER] BCL one');
  console.log('[before] save_invoice re-saving a kept order-linked line repriced below cost, with no reason, is refused (it asks again)');

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.equal(body(), NEW_BODY, `new guard md5 is ${body()}`);
  assert.equal(grants(), guardGrants, 'the guard grants must not change');
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /BELOW_COST_LIST_PREFLIGHT/);
  console.log(`[case 9] the candidate applies (guard EXECUTE unchanged: ${guardGrants}); a second apply stops at its preflight`);

  // Case 1: the RPC returns; COMMIT refuses once, listing both lines; nothing is saved.
  const listed = refusedAtCommit(committed(orderSql(orderArgs(ADMIN, 'c1')), ADMIN));
  checkList(listed, 'case 1');
  assert.equal(orders('c1'), '0', 'case 1: no order survives the refusal');
  assert.equal(approvals('c1'), '-', 'case 1: no approval row');
  console.log('[case 1] the RPC returns, then COMMIT refuses ONCE: lines = one (2 @ $8.00, cost $10.00, short $4.00) and two (3 @ $9.50, short $1.50), total $5.50; three (above cost) not listed; no order, no approval');

  // Case 2: the retry with a reason (create_direct_order carries it in the notes) saves and logs exactly those two.
  const retry = committed(orderSql(orderArgs(ADMIN, 'c1', 'Below-cost approved: price match')), ADMIN);
  assert.equal(retry.status, 0, retry.output);
  assert.equal(orders('c1'), '1');
  assert.equal(approvals('c1'), `${ADMIN}:[PROVER] BCL one:800:1000:2.00:400,${ADMIN}:[PROVER] BCL two:950:1000:3.00:150`);
  console.log('[case 2] the retry with a reason saves; two approval rows under the admin match the listed lines exactly');

  // Case 3: a sales rep is still refused at the first line, with no cost and no list.
  const rep = committed(orderSql(orderArgs(REP, 'rep')), REP);
  assert.notEqual(rep.status, 0, rep.output);
  assert.doesNotMatch(rep.output, /STATEMENTS_DONE/);
  const repLine = rep.output.split(/\r?\n/).find((l) => l.includes('BELOW_COST_ADMIN_REQUIRED:')) ?? '';
  assert.ok(repLine, rep.output);
  assert.doesNotMatch(rep.output, /locked_unit_cost_cents|"lines"|1000/, 'a rep never sees cost or a list');
  console.log('[case 3] a sales rep gets BELOW_COST_ADMIN_REQUIRED at the first line, inside the RPC; no cost, no list');

  const src = scalar(`SELECT oi.id FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id WHERE o.order_name = '[PROVER] BCL c1' AND oi.product_id = '${P1}';`);
  const lineCount = () => scalar(`SELECT count(*) FROM public.order_items WHERE order_id = (SELECT order_id FROM public.order_items WHERE id = '${src}');`);
  const startLines = lineCount();

  // Case 6a: a line written below cost, then raised to cost in the same save, asks nothing.
  const raised = asAdminWrite(`WITH n AS (${copyLine(src, 1, 8)} RETURNING id) SELECT set_config('bcl.raised', (SELECT id::text FROM n), true);
UPDATE public.order_items SET price_per_unit = 10 WHERE id = current_setting('bcl.raised')::uuid;`);
  assert.equal(raised.status, 0, raised.output);
  // Case 6b: a line written below cost, then deleted, asks nothing.
  const deleted = asAdminWrite(`WITH n AS (${copyLine(src, 1, 8)} RETURNING id) SELECT set_config('bcl.deleted', (SELECT id::text FROM n), true);
DELETE FROM public.order_items WHERE id = current_setting('bcl.deleted')::uuid;`);
  assert.equal(deleted.status, 0, deleted.output);
  assert.equal(lineCount(), String(Number(startLines) + 1), 'the raised line saved; the deleted one is gone');
  // Case 6c: a line written below cost twice is listed once, with its latest price.
  const twice = refusedAtCommit(asAdminWrite(`WITH n AS (${copyLine(src, 1, 8)} RETURNING id) SELECT set_config('bcl.twice', (SELECT id::text FROM n), true);
UPDATE public.order_items SET price_per_unit = 7 WHERE id = current_setting('bcl.twice')::uuid;`));
  assert.equal(twice.lines.length, 1); assert.equal(twice.lines[0].unit_price_cents, 700);
  assert.equal(twice.total_shortfall_cents, 600);
  assert.equal(lineCount(), String(Number(startLines) + 1));
  console.log('[case 6] in one save: a below-cost line raised to cost saves with no prompt; one deleted saves with no prompt; one written twice (8.00 then 7.00) is listed once at $7.00 ($6.00 short)');

  // Case 7: 300 below-cost lines are all listed (no cap), total = 300 x $4.00.
  const many = refusedAtCommit(asAdminWrite(`${copyLine(src, 300, 8)};`));
  assert.equal(many.lines.length, 300); assert.equal(many.line_count, 300); assert.equal(many.more_count, 0);
  assert.equal(many.total_shortfall_cents, 300 * 400);
  assert.equal(lineCount(), String(Number(startLines) + 1));
  console.log(`[case 7] 300 below-cost lines in one save: all 300 listed, total $1,200.00; nothing saved (error ${many.lines.length} lines, ${JSON.stringify(many).length} bytes)`);

  // Case 8: no context still fails at once, inside the statement.
  const noContext = committed(`SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
${copyLine(src, 1, 8)};`);
  assert.notEqual(noContext.status, 0); assert.doesNotMatch(noContext.output, /STATEMENTS_DONE/);
  assert.match(noContext.output, /BELOW_COST_CONTEXT_REQUIRED:/);
  // Case 8b: forcing constraints immediate fires the list inside the transaction (still a refusal, never a save).
  const immediate = asAdminWrite(`SET CONSTRAINTS ALL IMMEDIATE;\n${copyLine(src, 1, 8)};`);
  assert.notEqual(immediate.status, 0); assert.doesNotMatch(immediate.output, /STATEMENTS_DONE/);
  assert.equal(detail(immediate.output).lines.length, 1);
  console.log('[case 8] no context: BELOW_COST_CONTEXT_REQUIRED at once; SET CONSTRAINTS ALL IMMEDIATE: the list refusal fires at the write, still a refusal');

  // Case 12: save_invoice re-inserts a kept line under a new id, then restores its saved id. The line's note follows it,
  // so the re-save is still refused (as before) and lists that line under its real id; the draft is unchanged.
  const resave = refusedAtCommit(committed(resaveSql, ADMIN));
  assert.equal(resave.lines.length, 1, JSON.stringify(resave));
  assert.equal(resave.lines[0].line_id, INV_LINE); assert.equal(resave.lines[0].product_name, '[PROVER] BCL one');
  assert.equal(resave.total_shortfall_cents, 600);
  assert.equal(scalar(`SELECT string_agg(id::text || ':' || unit_price_cents, ',') FROM public.invoice_items WHERE invoice_id = '${INV}';`), `${INV_LINE}:700`);
  console.log('[case 12] save_invoice re-saving a kept order-linked line repriced below cost, with no reason: still refused, at COMMIT, listing that line under its restored id ($6.00 short); the draft is unchanged');

  // Case 11: the real HTTP path. PostgREST commits after the function returns; the client sees the commit-time refusal.
  const secret = 'bcl-prover-jwt-secret-0123456789abcdef';
  const apiName = `${NAME}-rest`;
  const token = (actor) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ role: 'authenticated', sub: actor, exp: Math.floor(Date.now() / 1000) + 1800 })).toString('base64url');
    return `${header}.${claims}.${createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url')}`;
  };
  const rest = (args, actor) => {
    const r = docker(['exec', NAME, 'curl', '-sS', '--max-time', '20', '-X', 'POST', 'http://127.0.0.1:3000/rpc/create_direct_order',
      '-H', 'Content-Type: application/json', '-H', `Authorization: Bearer ${token(actor)}`, '--data', JSON.stringify(args), '-w', '\n%{http_code}'], { allowFailure: true });
    const lines = r.stdout.trim().split('\n');
    return { status: Number(lines.pop()), body: lines.join('\n') };
  };
  docker(['run', '-d', '--name', apiName, '--network', `container:${NAME}`,
    '-e', `PGRST_DB_URI=postgres://postgres:postgres@127.0.0.1/${DB}`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, 'public.ecr.aws/supabase/postgrest:v14.16']);
  try {
    let http;
    for (let i = 0; i < 100; i += 1) { http = rest(orderArgs(ADMIN, 'http'), ADMIN); if (http.status && !/Could not connect|Failed to connect|PGRST002/.test(http.body)) break; wait(300); }
    assert.ok(http.status >= 400, `HTTP refusal expected: ${http.status} ${http.body}`);
    const err = JSON.parse(http.body);
    assert.equal(err.code, 'P0001', http.body);
    assert.ok(err.message.startsWith('BELOW_COST_REASON_REQUIRED:'), err.message);
    checkList(JSON.parse(err.message.slice('BELOW_COST_REASON_REQUIRED:'.length)), 'HTTP');
    assert.equal(orders('http'), '0', 'HTTP: nothing saved');
    const repHttp = rest(orderArgs(REP, 'http-rep'), REP);
    assert.ok(repHttp.status >= 400); assert.ok(JSON.parse(repHttp.body).message.startsWith('BELOW_COST_ADMIN_REQUIRED:'));
    assert.doesNotMatch(repHttp.body, /locked_unit_cost_cents|lines/);
    const ok = rest(orderArgs(ADMIN, 'http', 'Below-cost approved: price match'), ADMIN);
    assert.equal(ok.status, 200, ok.body);
    assert.equal(approvals('http'), `${ADMIN}:[PROVER] BCL one:800:1000:2.00:400,${ADMIN}:[PROVER] BCL two:950:1000:3.00:150`);
    console.log(`[case 11] real PostgREST over HTTP: the admin gets HTTP ${http.status} {code P0001, message BELOW_COST_REASON_REQUIRED:{... lines: 2, total 550}}; nothing saved; a rep gets BELOW_COST_ADMIN_REQUIRED with no cost; the retry with a reason returns 200 and logs the two listed lines`);
  } finally { docker(['rm', '-f', apiName], { allowFailure: true }); }

  // Case 9 (undo): the reverse restores the old body and drops the list; the candidate re-applies.
  stageText('reverse.sql', lf(REVERSE));
  const rev = apply('reverse.sql');
  assert.equal(rev.status, 0, rev.output);
  assert.equal(body(), OLD_BODY, 'the reverse must restore the old body');
  assert.equal(grants(), guardGrants);
  assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgname = 'zzz_crx_below_cost_reason_list';`), '0');
  const undone = committed(orderSql(orderArgs(ADMIN, 'undone')), ADMIN);
  assert.doesNotMatch(undone.output, /STATEMENTS_DONE/); assert.equal(detail(undone.output).lines, undefined);
  const undoneOk = committed(orderSql(orderArgs(ADMIN, 'undone', 'Below-cost approved: price match')), ADMIN);
  assert.equal(undoneOk.status, 0, undoneOk.output);
  const again = apply('candidate.sql');
  assert.equal(again.status, 0, again.output);
  assert.equal(body(), NEW_BODY);
  checkList(refusedAtCommit(committed(orderSql(orderArgs(ADMIN, 'again')), ADMIN)), 'after re-apply');
  console.log('[case 9] the reverse restores the old body (first-line refusal, no list; an approved save still works); the candidate re-applies and lists again');
  console.log('BELOW_COST_LIST_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
