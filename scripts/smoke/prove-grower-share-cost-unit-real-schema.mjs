#!/usr/bin/env node
/**
 * Real-schema proof for 20270111130000_grower_share_cost_in_sold_unit (KI-156; contract
 * docs/plans/2026-11-15-product-master-steps-1-3-CONTRACT.md, PR C) and its follow-up
 * 20270111140000_grower_share_line_saves_for_admins_and_reps (Mason, 2026-11-15: "Admins and reps").
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container, replays
 * every post-baseline migration before the candidate, then saves field-application invoices the way the app does
 * (public.save_field_app_invoice as the signed-in admin, or a sales rep) in rolled-back transactions.
 *   B   BEFORE: 16 oz/ac x 100 ac of a $30/gal product in the grower's share books $48,000 of cost (the bug).
 *   D   a drifted live body is refused; the candidate applies; a second run is refused; grants are unchanged.
 *   1   the same grower-share line books $375.00 (12.5 Gal x $30), stores 12.5000 Gal, keeps total applied 1,600 oz,
 *       and the bill is unchanged (the $0 line and the per-acre grower price); a sales rep's save (server cost) too.
 *   2   the billed branch is unchanged, alone and beside a grower-share field on one invoice.
 *   3   an "oz" rate on a product sold per Ea is refused (FIELD_APP_UNIT_UNCONVERTIBLE) in the grower share.
 *   4   a manual line with no product: rate and unit both oz is identity (unchanged); unit Gal with an oz rate
 *       converts (12.5 Gal, $375); a unit that does not convert is refused.
 *   5   rounding: the cost is the stored 4-place quantity x cost (1 oz of a 1,000,000-cent/gal product = 0.0078 Gal,
 *       7,800 cents), the same order as the billed branch.
 *   6   the generic invoice saver cannot re-cost a grower-share invoice (FIELD_INVOICE_SPLIT_LOCKED), and the split
 *       field-app saver refuses grower-price fields (MODE_A_UNSUPPORTED), so neither path has this branch.
 *   W   before the follow-up, the below-cost wall refuses every costed grower-share line (no context; a rep even with one).
 *   N   a normal below-cost line (a billed line priced under cost) needs the existing approval, before AND after the
 *       follow-up: no context is refused, a sales rep is refused, an admin with a reason saves and is recorded.
 *   G   the follow-up applies (refused before 20270111130000 and on a second run; grants unchanged): an admin and a
 *       sales rep save a costed $0 grower-share line with no below-cost context and no approval row; an applicator is
 *       refused; the context it declares lets nothing else through (a 1-cent line, an applicator's $0 line); a billed
 *       below-cost line beside a grower share is still refused, so the context is put back after the grower line.
 *   RG  the follow-up's reverse restores both bodies and the refusal (W); a second run is refused.
 *   R   the reverse script restores the live body (md5 29d699a8...) and the old cost; a second reverse is refused.
 *
 * Run: node scripts/smoke/prove-grower-share-cost-unit-real-schema.mjs   (needs Docker)
 * Prints GROWER_SHARE_COST_UNIT_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
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
const NAME = REUSE || `crx-ki156-gscost-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270111130000_grower_share_cost_in_sold_unit.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'grower-share-cost-unit-reverse.sql');
const CANDIDATE2 = path.join(MIGRATIONS, '20270111140000_grower_share_line_saves_for_admins_and_reps.sql');
const REVERSE2 = path.join(ROOT, 'scripts', 'smoke', 'grower-share-line-saves-reverse.sql');
const FOLLOW_UPS = [CANDIDATE2];
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
  // Need live's storage.objects policies, which this database does not have; neither touches field-app invoices.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate replaces or relies on.
const TOUCHED = /(_save_field_app_invoice_impl_20260714|field_app_priced_quantity|_enforce_below_cost_line)/i;
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


const LIVE_MD5 = '29d699a8b0698424345a78e9aac9dcd1';
const FIX_MD5 = 'c3df537c2540a3bbc3f39ddc16c09166';
const SAVES_MD5 = '458f68210d5587ffe7b1f2847ac136ed';
const GUARD_LIVE_MD5 = '3708388e22f081fd5b70ce8f89492aaf';
const GUARD_SAVES_MD5 = '1c421de75f20d9244a06d29428d1f99a';
const GUARD = "'public._enforce_below_cost_line()'::regprocedure";
const guardMd5 = () => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = ${GUARD};`);
const guardAcl = () => scalar(`SELECT coalesce(proacl::text, '-') FROM pg_proc WHERE oid = ${GUARD};`);
const IMPL = "'public._save_field_app_invoice_impl_20260714(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure";
const bodyMd5 = () => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = ${IMPL};`);
const acl = () => scalar(`SELECT coalesce(proacl::text, '-') FROM pg_proc WHERE oid = ${IMPL};`);
const id = (s) => `c156c156-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), REP = id('a2'), APPL = id('a3'), CUST = id('c1'), FG = id('f1'), FB = id('f2'), GAL = id('d1'), EA = id('d2'), NOINV = id('d3');
let keyN = 0;
const key = () => `prover-ki156-${process.pid}-${keyN += 1}`;

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ki156-admin@example.invalid', '{"full_name":"[PROVER] KI156 Admin","role":"admin"}'::jsonb),
    ('${REP}', 'ki156-rep@example.invalid', '{"full_name":"[PROVER] KI156 Rep","role":"sales_rep"}'::jsonb),
    ('${APPL}', 'ki156-appl@example.invalid', '{"full_name":"[PROVER] KI156 Applicator","role":"applicator"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'applicator', is_active = true WHERE id = '${APPL}';`);
  assert.equal(scalar(`SELECT string_agg(role || ',' || is_active, ' ' ORDER BY role) FROM public.profiles WHERE id IN ('${ADMIN}', '${REP}', '${APPL}');`),
    'admin,true applicator,true sales_rep,true');
  raw(`INSERT INTO public.customers (id, farm_name, assigned_tier) VALUES ('${CUST}', '[PROVER] KI156 Farm', 1);
    INSERT INTO public.products (id, product_name, unit_size, inventory_unit, product_form, current_cost, tier1_price, tier1_margin, is_active) VALUES
      ('${GAL}', '[PROVER] KI156 Gallon chem', 'Gal', 'Gal', 'liquid', 30.00, 40.00, 25, true),
      ('${EA}', '[PROVER] KI156 Each item', 'Ea', 'Ea', 'each', 30.00, 40.00, 25, true),
      ('${NOINV}', '[PROVER] KI156 no stock unit', 'Gal', NULL, 'liquid', 30.00, 40.00, 25, true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
      ('${FG}', '${CUST}', '[PROVER] KI156 grower-price field', 100, true),
      ('${FB}', '${CUST}', '[PROVER] KI156 billed field', 100, true);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES
      ('${FG}', '${CUST}', 100, true, 2500),
      ('${FB}', '${CUST}', 100, true, NULL);
    DELETE FROM public.app_settings WHERE setting_key = 'per_line_split_billing_enabled';
    INSERT INTO public.app_settings (setting_key, setting_value) VALUES ('per_line_split_billing_enabled', 'true');`);
}

const loc = (field, acres, i = 0) => ({ field_id: field, map_number: i + 1, total_acres: 100, planted_acres: 100, applied_acres: acres, sort_order: i });
const chem = (o) => ({ description: 'KI156 chem', rate_per_acre: 16, rate_unit: 'oz', unit_size: 'Gal', cost_cents: 3000, sort_order: 0, manual_override: false, ...o });
// No field-app path declares a below-cost context (live, 2026-11-15), so the $0 "included in grower share" line of a
// costed product is refused (case W). To reach the cost math the probes declare one, as an admin with a reason would.
// The follow-up (case G) declares it inside the save for that line only; its probes pass ctx = false.
const CTX = "SELECT set_config('app.crx_below_cost_operation', 'save_invoice', true), set_config('app.crx_below_cost_reason', '[PROVER] KI156 grower share', true);\n";
const saveSql = (locs, chems, by = ADMIN, ctx = true) => `${ctx ? CTX : ''}SELECT set_config('crx.inv', public.save_field_app_invoice(NULL,
  ${J({ invoice_date: '2026-11-15', salesman_id: by })}, ${J(locs)}, ${J(chems)}, '${by}', NULL, '${key()}')->'invoice_ids'->>0, true);`;
// cost || total || lines; each line is description|quantity|unit|price|extended|cost|total applied|applied unit
const READ = `SELECT concat_ws(' || ', i.total_cost_cents, i.total_amount_cents, (SELECT string_agg(concat_ws('|', ii.description,
    ii.quantity, ii.unit_size, ii.unit_price_cents, ii.extended_cents, ii.cost_cents, ii.total_applied, ii.total_applied_unit), ' ; '
    ORDER BY ii.description) FROM public.invoice_items ii WHERE ii.invoice_id = i.id))
  FROM public.invoices i WHERE i.id = current_setting('crx.inv')::uuid;`;
const save = (locs, chems, by = ADMIN, ctx = true) => okProbe(`${saveSql(locs, chems, by, ctx)}\nRESET ROLE;\n${READ}`, by);
const refusedSave = (locs, chems, pattern, by = ADMIN, ctx = true) => refusedProbe(saveSql(locs, chems, by, ctx), pattern, by);
const costOf = (s) => Number(s.split(' || ')[0]);
const lineOf = (s, prefix) => s.split(' || ')[2].split(' ; ').find((l) => l.startsWith(prefix));

// The scenarios run before and after the candidate.
const GROWER = () => save([loc(FG, 100)], [chem({ product_id: GAL })]);
const GROWER_WALL = () => {
  refusedSave([loc(FG, 100)], [chem({ product_id: GAL })], /BELOW_COST_CONTEXT_REQUIRED/, ADMIN, false);
  refusedSave([loc(FG, 100)], [chem({ product_id: GAL })], /BELOW_COST_ADMIN_REQUIRED/, REP);
};
const BILLED = () => save([loc(FB, 100)], [chem({ product_id: GAL })]);
const MIXED = () => save([loc(FG, 50), loc(FB, 50, 1)], [chem({ product_id: GAL })]);
const MANUAL_OZ = () => save([loc(FG, 100)], [chem({ description: 'KI156 manual', unit_size: 'oz', cost_cents: 50, manual_override: true, unit_price_cents: 0 })]);
const MANUAL_GAL = () => save([loc(FG, 100)], [chem({ description: 'KI156 manual', manual_override: true, unit_price_cents: 0 })]);
const TINY = () => save([loc(FG, 1)], [chem({ product_id: GAL, rate_per_acre: 1, cost_cents: 1000000 })]);
const EA_GROWER = [[loc(FG, 100)], [chem({ product_id: EA, unit_size: 'Ea' })]];
// N: a billed line priced at $1/Gal under its $30 cost is a normal below-cost line.
const UNDER = chem({ product_id: GAL, manual_override: true, unit_price_cents: 100 });
const APPROVALS = "SELECT count(*) FROM public.below_cost_approvals WHERE entity_id = current_setting('crx.inv')::uuid;";
function normalWall(label) {
  refusedSave([loc(FB, 100)], [UNDER], /BELOW_COST_CONTEXT_REQUIRED/, ADMIN, false);
  refusedSave([loc(FB, 100)], [UNDER], /BELOW_COST_ADMIN_REQUIRED/, REP);
  assert.equal(okProbe(`${saveSql([loc(FB, 100)], [UNDER])}\nRESET ROLE;\n${APPROVALS}`, ADMIN), '1', `N ${label}: an admin with a reason saves and is recorded`);
  console.log(`[case] N ${label}: a billed line under cost is refused with no context (BELOW_COST_CONTEXT_REQUIRED) and for a rep (BELOW_COST_ADMIN_REQUIRED); an admin with a reason saves it and 1 approval is recorded`);
}
// G: a direct line write as the trigger owner, signed in as uid, declaring a below-cost context (after a field-app save).
const direct = (uid, op, price, ext = price) => `${saveSql([loc(FB, 100)], [chem({ product_id: GAL })], ADMIN, false)}
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('app.crx_below_cost_operation', '${op}', true);
INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, cost_cents)
VALUES (current_setting('crx.inv')::uuid, '${GAL}', '[PROVER] KI156 direct', 1, 'Gal', ${price}, ${ext}, 3000);
SELECT 'inserted';`;

function applyFile(label, file) {
  stageText(`${label}.sql`, lf(file));
  return apply(`${label}.sql`);
}

async function main() {
  if (!REUSE) buildContainer();
  seed();

  // B: the bug.
  const before = { grower: GROWER(), billed: BILLED(), mixed: MIXED(), manualOz: MANUAL_OZ(), manualGal: MANUAL_GAL(), tiny: TINY() };
  assert.equal(costOf(before.grower), 4800000, `B: before the fix the grower-share line books 1,600 x $30: ${before.grower}`);
  assert.match(lineOf(before.grower, 'KI156 chem — included'), /\|1600\.0000\|Gal\|0\|0\|3000\|1600\.0000\|oz$/, before.grower);
  assert.equal(costOf(before.manualGal), 4800000, `B: manual Gal line before: ${before.manualGal}`);
  assert.equal(costOf(before.tiny), 1000000, `B: tiny before: ${before.tiny}`);
  okProbe(`${saveSql(...EA_GROWER)}\nSELECT 1;`, ADMIN);
  GROWER_WALL();
  console.log('[case] W before: with no below-cost context the grower-share save is refused (BELOW_COST_CONTEXT_REQUIRED); a sales rep is refused (BELOW_COST_ADMIN_REQUIRED)');
  console.log(`[case] B before: grower share books ${costOf(before.grower)} cents (1,600 at $30/Gal); an oz rate on an Ea product saves`);

  // D: drift refusal, apply, re-run refusal, grants.
  assert.equal(bodyMd5(), LIVE_MD5, 'D: replay ends on the live body');
  const aclBefore = acl();
  psql(`DO $d$ DECLARE v text; BEGIN SELECT pg_get_functiondef(${IMPL}) INTO v;
    EXECUTE replace(v, 'At least one field is required', 'At least one field is required '); END $d$;`);
  const drift = applyFile('cand-drift', CANDIDATE);
  assert.notEqual(drift.status, 0); assert.match(drift.output, /KI156_PREFLIGHT: .*body md5/);
  psql(`DO $d$ DECLARE v text; BEGIN SELECT pg_get_functiondef(${IMPL}) INTO v;
    EXECUTE replace(v, 'At least one field is required ', 'At least one field is required'); END $d$;`);
  assert.equal(bodyMd5(), LIVE_MD5, 'D: body restored');
  const early = applyFile('cand2-early', CANDIDATE2);
  assert.notEqual(early.status, 0); assert.match(early.output, /KI156_SAVES_PREFLIGHT/);
  const applied = applyFile('cand', CANDIDATE);
  assert.equal(applied.status, 0, applied.output);
  assert.equal(bodyMd5(), FIX_MD5);
  assert.equal(acl(), aclBefore, 'D: grants unchanged');
  assert.equal(scalar(`SELECT prosecdef::text || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = ${IMPL};`), 'truesearch_path=public, pg_temp');
  const again = applyFile('cand-again', CANDIDATE);
  assert.notEqual(again.status, 0); assert.match(again.output, /KI156_PREFLIGHT/);
  console.log(`[case] D a drifted body is refused; the candidate applies (md5 ${FIX_MD5}); a second run is refused; ACL, SECURITY DEFINER and search_path unchanged`);

  // 1: the fix.
  const g = GROWER();
  assert.equal(costOf(g), 37500, `1: 12.5 Gal x $30 = $375.00: ${g}`);
  assert.match(lineOf(g, 'KI156 chem — included'), /\|12\.5000\|Gal\|0\|0\|3000\|1600\.0000\|oz$/, g);
  assert.equal(g.split(' || ')[1], before.grower.split(' || ')[1], '1: the bill total is unchanged');
  assert.equal(lineOf(g, '[PROVER] KI156 grower-price field'), lineOf(before.grower, '[PROVER] KI156 grower-price field'), '1: the grower price line is unchanged');
  GROWER_WALL();
  console.log(`[case] 1 grower share: 16 oz/ac x 100 ac of a $30/gal product books 37500 cents (12.5000 Gal; total applied 1600 oz); bill unchanged (${g.split(' || ')[1]} cents); the below-cost refusals (W) are unchanged`);

  // 2: billed branch unchanged.
  assert.equal(BILLED(), before.billed, '2: billed-only invoice identical');
  const m = MIXED();
  assert.equal(lineOf(m, 'KI156 chem|'), lineOf(before.mixed, 'KI156 chem|'), '2: the billed line beside a grower share is identical');
  assert.equal(costOf(m), 18750 + 18750, `2: mixed invoice cost 6.25 Gal billed + 6.25 Gal grower share at $30: ${m}`);
  console.log(`[case] 2 billed branch unchanged: ${before.billed}; mixed 50/50 invoice books 37500 (was ${costOf(before.mixed)})`);

  // 3: unconvertible unit refused.
  refusedSave(...EA_GROWER, /FIELD_APP_UNIT_UNCONVERTIBLE: cannot price "KI156 chem" — rate unit "oz" does not convert to the product's sold unit "Ea"/);
  refusedSave([loc(FB, 100)], [chem({ product_id: EA, unit_size: 'Ea' })], /FIELD_APP_UNIT_UNCONVERTIBLE/);
  console.log('[case] 3 an oz rate on an Ea product is refused in the grower share with the billed message (and still in the billed branch)');

  // 4: manual lines.
  assert.equal(MANUAL_OZ(), before.manualOz, '4: manual oz line is identity and unchanged');
  assert.match(lineOf(before.manualOz, 'KI156 manual — included'), /\|1600\.0000\|oz\|0\|0\|50\|1600\.0000\|oz$/, before.manualOz);
  const mg = MANUAL_GAL();
  assert.equal(costOf(mg), 37500, `4: manual Gal line with an oz rate converts: ${mg}`);
  assert.match(lineOf(mg, 'KI156 manual — included'), /\|12\.5000\|Gal\|0\|0\|3000\|1600\.0000\|oz$/, mg);
  refusedSave([loc(FG, 100)], [chem({ description: 'KI156 jug', unit_size: 'jug', manual_override: true, unit_price_cents: 0 })],
    /FIELD_APP_UNIT_UNCONVERTIBLE: cannot price "KI156 jug" — rate unit "oz" does not convert to the product's sold unit "jug"/);
  console.log(`[case] 4 manual line: oz/oz keeps 1600 oz at 50 cents (${costOf(before.manualOz)}, unchanged); Gal with an oz rate books 37500 (was ${costOf(before.manualGal)}); "jug" is refused`);

  // 4b: a product with no inventory_unit takes the rate unit like the billed branch; the request's unit_size cannot steer it.
  const ni = save([loc(FG, 50), loc(FB, 50, 1)], [chem({ product_id: NOINV })]);
  assert.match(lineOf(ni, 'KI156 chem — included'), /\|800\.0000\|oz\|0\|0\|3000\|800\.0000\|oz$/, ni);
  assert.match(lineOf(ni, 'KI156 chem|'), /\|800\.0000\|Gal\|/, ni);
  console.log('[case] 4b a product with no stock unit costs the grower share in the rate unit like the billed line (800 oz each); the request unit_size Gal is ignored');

  // 5: rounding order.
  const t = TINY();
  assert.match(lineOf(t, 'KI156 chem — included'), /\|0\.0078\|Gal\|0\|0\|1000000\|1\.0000\|oz$/, t);
  assert.equal(costOf(t), 7800, `5: cost is the stored 0.0078 Gal x 1,000,000 (not 7813 from the unrounded 0.0078125): ${t}`);
  console.log('[case] 5 rounding: 1 oz of a 1,000,000-cent/gal product stores 0.0078 Gal and books 7800 cents = stored quantity x cost');

  // 6: the other writers.
  refusedProbe(`${saveSql([loc(FG, 100)], [chem({ product_id: GAL })])}
    SELECT public.save_invoice(jsonb_build_object('id', current_setting('crx.inv'), 'salesman_id', '${ADMIN}'),
      ${J([{ product_id: GAL, description: 'KI156 chem', quantity: 1600, unit_size: 'Gal', unit_price_cents: 0, cost_cents: 3000 }])}, '${key()}');`,
    /FIELD_INVOICE_SPLIT_LOCKED/, ADMIN);
  refusedProbe(`SELECT public.save_field_app_split_invoice(NULL, NULL, ${J({ invoice_date: '2026-11-15' })},
      ${J([{ field_id: FG, applied_acres: 100 }])}, '[]'::jsonb, '${ADMIN}', NULL, '${key()}');`, /MODE_A_UNSUPPORTED/, ADMIN);
  console.log('[case] 6 the generic invoice saver refuses to re-save a grower-share invoice (FIELD_INVOICE_SPLIT_LOCKED); the split saver refuses grower-price fields (MODE_A_UNSUPPORTED)');

  normalWall('before the follow-up');

  // G: the follow-up (Mason, 2026-11-15: "Admins and reps").
  const aclGuard = guardAcl();
  assert.equal(guardMd5(), GUARD_LIVE_MD5, 'G: the below-cost wall is the live body');
  const g2 = applyFile('cand2', CANDIDATE2);
  assert.equal(g2.status, 0, g2.output);
  assert.equal(bodyMd5(), SAVES_MD5); assert.equal(guardMd5(), GUARD_SAVES_MD5);
  assert.equal(acl(), aclBefore, 'G: impl grants unchanged'); assert.equal(guardAcl(), aclGuard, 'G: wall grants unchanged');
  const g2again = applyFile('cand2-again', CANDIDATE2);
  assert.notEqual(g2again.status, 0); assert.match(g2again.output, /KI156_SAVES_PREFLIGHT/);
  for (const [who, uid] of [['admin', ADMIN], ['sales rep', REP]]) {
    const s = save([loc(FG, 100)], [chem({ product_id: GAL })], uid, false);
    assert.equal(costOf(s), 37500, `G: ${who} grower-share save books 12.5 Gal x $30: ${s}`);
    assert.equal(lineOf(s, 'KI156 chem — included'), lineOf(g, 'KI156 chem — included'), `G: ${who} line identical to case 1`);
    assert.equal(s.split(' || ')[1], g.split(' || ')[1], `G: ${who} bill unchanged`);
    assert.equal(okProbe(`${saveSql([loc(FG, 100)], [chem({ product_id: GAL })], uid, false)}\nRESET ROLE;\n${APPROVALS}`, uid), '0', `G: ${who} writes no approval row`);
  }
  refusedSave([loc(FG, 100)], [chem({ product_id: GAL })], /Not authorized/, APPL, false);
  assert.equal(okProbe(direct(ADMIN, 'field_app_grower_share', 0), ADMIN), 'inserted', 'G: the declared $0 line saves for an admin');
  assert.equal(okProbe(direct(REP, 'field_app_grower_share', 0), ADMIN), 'inserted', 'G: the declared $0 line saves for a rep');
  refusedProbe(direct(APPL, 'field_app_grower_share', 0), /BELOW_COST_CONTEXT_REQUIRED/, ADMIN);
  refusedProbe(direct(ADMIN, 'field_app_grower_share', 1), /BELOW_COST_CONTEXT_REQUIRED/, ADMIN);
  refusedProbe(direct(ADMIN, 'field_app_grower_share', 0, 100), /BELOW_COST_CONTEXT_REQUIRED/, ADMIN);
  // A rep's chemical cost comes from the server (_cost_step2_field_app_chemicals), so a rep sending 0 still books it.
  assert.equal(costOf(save([loc(FG, 100)], [chem({ product_id: GAL, cost_cents: 0 })], REP, false)), 37500, 'G: rep cost is the server cost');
  const manualG = save([loc(FG, 100)], [chem({ description: 'KI156 manual', manual_override: true, unit_price_cents: 0 })], ADMIN, false);
  assert.equal(costOf(manualG), 37500, `G: an admin's costed manual grower-share line saves with no context: ${manualG}`);
  refusedSave([loc(FG, 50), loc(FB, 50, 1)], [UNDER], /BELOW_COST_CONTEXT_REQUIRED/, ADMIN, false);
  assert.equal(okProbe(`${saveSql([loc(FG, 50), loc(FB, 50, 1)], [UNDER])}\nRESET ROLE;\n${APPROVALS}`, ADMIN), '1', 'G: mixed save with a reason records only the billed line');
  console.log(`[case] G follow-up applies (impl md5 ${SAVES_MD5}, wall md5 ${GUARD_SAVES_MD5}; grants unchanged; a second run is refused): an admin and a sales rep save a costed $0 grower-share line with no context (37500 cents, no approval row); an applicator is refused; the declared context lets an admin's or rep's $0 line through but not an applicator's $0 line, a 1-cent line or a $0 line with an amount (BELOW_COST_CONTEXT_REQUIRED); a rep sending cost 0 still books the server cost (37500); an admin's costed manual grower-share line saves; a billed under-cost line beside a grower share is still refused, and with a reason only it is recorded`);
  normalWall('after the follow-up');

  // RG: the follow-up's rollback.
  const rg = applyFile('rev2', REVERSE2);
  assert.equal(rg.status, 0, rg.output);
  assert.equal(bodyMd5(), FIX_MD5); assert.equal(guardMd5(), GUARD_LIVE_MD5);
  assert.equal(acl(), aclBefore, 'RG: impl grants unchanged'); assert.equal(guardAcl(), aclGuard, 'RG: wall grants unchanged');
  GROWER_WALL();
  const rg2 = applyFile('rev2-again', REVERSE2);
  assert.notEqual(rg2.status, 0); assert.match(rg2.output, /KI156_SAVES_REVERSE/);
  console.log(`[case] RG the follow-up reverse restores md5 ${FIX_MD5} and the wall ${GUARD_LIVE_MD5}; the grower-share refusal (W) is back; a second reverse is refused`);

  // R: rollback.
  const r1 = applyFile('rev', REVERSE);
  assert.equal(r1.status, 0, r1.output);
  assert.equal(bodyMd5(), LIVE_MD5, 'R: the live body is back');
  assert.equal(acl(), aclBefore, 'R: grants unchanged');
  assert.equal(GROWER(), before.grower, 'R: the old behaviour is back');
  const r2 = applyFile('rev-again', REVERSE);
  assert.notEqual(r2.status, 0); assert.match(r2.output, /KI156_REVERSE/);
  console.log(`[case] R the reverse restores md5 ${LIVE_MD5} and the old cost (${costOf(before.grower)}); a second reverse is refused`);

  console.log('GROWER_SHARE_COST_UNIT_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
