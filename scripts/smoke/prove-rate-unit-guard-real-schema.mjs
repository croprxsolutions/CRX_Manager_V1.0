#!/usr/bin/env node
/**
 * Real-schema proof for 20261231100000_rate_unit_denominator_guard_and_invisible_chars (KI-16 bullets 1-2;
 * contract docs/plans/2026-11-10-ki16-rate-unit-denominator-and-invisible-chars-CONTRACT.md).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, then, through the real RPCs:
 *   BEFORE  scheduling a job from a booking line rated 'oz/cwt' and saving a blend ticket line rated 'oz/cwt'
 *           (or blank on a product rated per cwt) all succeed; a blend line rated 'oz'+ZWSP fails the
 *           invoice's own unit check.
 *   P8  a changed normalize_rate_unit body makes the candidate refuse; a second run refuses.
 *   P1  scheduling from a booking line rated 'oz/cwt', 'oz per cwt' or 'oz p'+ZWSP+'er cwt' is refused, no job;
 *       'oz/ac' schedules.
 *   P2  load_recipe_into_job with a product rated 'oz per cwt' is refused, the job's lines untouched.
 *   P3  blend lines: per-cwt units, a lookalike slash, or a blank unit on a per-cwt product are refused at save;
 *       per-acre spellings save and pass the invoice check; an invisible-only unit is stored blank; edits
 *       to a per-cwt unit or product are refused; an unrelated edit saves.
 *   P4  a priced job line rated 'oz'+U+2215+'cwt' is refused; unpriced it saves (save_job's price gate).
 *   P5  normalize_rate_unit folds invisible characters; a non-acre unit stays whole.
 *   P6  the blend invoice's unit check now passes the 'oz'+ZWSP line.
 *   P7  live-shaped existing lines ('32', 'pt/ac', 'oz') take other edits, price changes included.
 *
 * Run: node scripts/smoke/prove-rate-unit-guard-real-schema.mjs   (needs Docker)
 * Prints RATE_UNIT_GUARD_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki16-units-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261231100000_rate_unit_denominator_guard_and_invisible_chars.sql');
const FOLLOW_UPS = [];
// Later files that only READ what this proof covers and redefine none of it.
const LATER_READ_ONLY = new Set();
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
  // KI-01 part C and its KI-73 follow-up need live's storage.objects policies, which this database does not have
  // (same approach as prove-document-restore-photo-uploader-real-schema.mjs); neither touches units or products.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(normalize_rate_unit|job_chemicals|blend_ticket_products|create_job_from_quote_section|create_blend_ticket)/i;
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

// Live unit_conversions, read-only 2026-11-10 (RT-1's preflight pins them).
const LIVE_UNIT_ROWS = "('3f5c3827-8523-4b42-9913-ad479588ff95'::uuid, 'Dry oz', 1, 'dry', '1 dry ounce'), ('5ed18e4b-c4d9-42fc-b85e-22babd3fc098'::uuid, 'Ea', 1, 'both', 'Each / unit'), ('f9e10e66-5027-464e-bb9e-ed9800875256'::uuid, 'fl oz', 1, 'liquid', '1 fluid ounce'), ('4406cacd-a7fe-42db-8c84-694e61bb937b'::uuid, 'g', 0.03527396, 'dry', '1 gram = 0.03527396 dry ounces (1000 mg)'), ('29d05e43-cb40-461b-a969-88ee299faca8'::uuid, 'Gal', 128, 'liquid', '1 gallon = 128 fluid ounces'), ('53997e31-d152-4ab6-b768-d1aa81b657bf'::uuid, 'Lb', 16, 'dry', '1 pound = 16 dry ounces'), ('fc5d349f-b58c-48f1-991d-fa0161fd3d01'::uuid, 'LB', 16, 'dry', '1 pound (capitalized alias)'), ('ddde7daf-8090-492b-aed9-c0b7f8ecfd34'::uuid, 'MG', 0.00003527396, 'dry', '1 milligram = 0.00003527396 dry ounces'), ('438d5f7b-f015-4319-b2b7-4f9a672cb350'::uuid, 'oz', 1, 'liquid', '1 fluid ounce (alias for fl oz)'), ('b69ddac6-68ed-4f1d-8e09-e63a7fa6635a'::uuid, 'Oz', 1, 'liquid', '1 fluid ounce (capitalized alias)'), ('a31f95a0-df80-4025-977f-f1fb4e5c8d53'::uuid, 'Pt', 16, 'liquid', '1 pint = 16 fluid ounces'), ('35532f45-2fd0-4400-87d8-3509a58377c0'::uuid, 'qt', 32, 'liquid', '1 quart lowercase (alias for Qt)'), ('915f25ff-8876-4a49-a375-940047e38313'::uuid, 'Qt', 32, 'liquid', '1 quart = 32 fluid ounces'), ('722e8d86-8e68-47d8-a940-209fad38c70e'::uuid, 'Unit', 1, 'both', 'Each / unit (alias for Ea)')";

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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
const ADMIN = 'a16a1600-0000-4000-8000-0000000000a1';
const CUSTOMER = 'a16a1600-0000-4000-8000-0000000000c1';
const LIQUID = 'a16a1600-0000-4000-8000-0000000000b1';
const CWT = 'a16a1600-0000-4000-8000-0000000000b2';
const RECIPE = 'a16a1600-0000-4000-8000-0000000000e1';
const ZWSP = 'chr(8203)';

// Runs sql as the signed-in admin (role authenticated unless asOwner), committing only when asked.
// Returns the first ERROR line, or '' when it ran clean.
function asAdmin(sql, { commit = false, asOwner = false } = {}) {
  const r = docker(psqlArgs(), { input: `BEGIN;
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', 'authenticated')::text, true);
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    ${asOwner ? '' : 'SET LOCAL ROLE authenticated;'}
    ${sql}
    ${commit ? 'COMMIT;' : 'ROLLBACK;'}`, allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const err = out.split(/\r?\n/).find((l) => /ERROR:/.test(l));
  if (!err && r.status !== 0) throw new Error(`psql failed without an ERROR line:\n${out}`);
  return err ?? '';
}
function clean(label, sql, opts) {
  const err = asAdmin(sql, opts);
  assert.equal(err, '', `${label}: expected to succeed, got ${err}`);
}
function refusedWith(label, sql, token, opts) {
  const err = asAdmin(sql, opts);
  assert.match(err, new RegExp(token), `${label}: expected ${token}, got ${err || 'success'}`);
  return err;
}

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ki16-admin@example.invalid', '{"full_name":"[PROVER] KI16 Admin","role":"admin"}'::jsonb);`);
  assert.equal(scalar(`SELECT role || ',' || is_active FROM public.profiles WHERE id = '${ADMIN}';`), 'admin,true');
  raw(`INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUSTOMER}', '[PROVER] KI16 Farm', true);
    INSERT INTO public.products (id, product_name, unit_size, inventory_unit, rate_unit, product_form, current_cost, tier1_price, tier1_margin, is_active)
    VALUES ('${LIQUID}', '[PROVER] KI16 Liquid', 'Gal', 'Gal', 'oz', 'liquid', 10.00, 12.80, 21.875, true),
           ('${CWT}', '[PROVER] KI16 Seed Treat', 'Gal', 'Gal', 'oz per cwt', 'liquid', 10.00, 12.80, 21.875, true);
    INSERT INTO public.blend_recipes (id, name, recipe_type, created_by) VALUES ('${RECIPE}', '[PROVER] KI16 Recipe', 'generic', '${ADMIN}');
    INSERT INTO public.blend_recipe_items (recipe_id, product_id, product_name, quantity, unit, rate_per_acre, sort_order)
    VALUES ('${RECIPE}', '${CWT}', '[PROVER] KI16 Seed Treat', 50, 'oz', 1, 0);`);
  // A planned draft booking with one line, saved through save_quote as the app does.
  clean('seed booking', `DO $seed$
    BEGIN
      PERFORM public.save_quote(NULL, jsonb_build_object(
          'quote_number', 'PROVER-KI16-1', 'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb,
          'customer_id', '${CUSTOMER}'),
        jsonb_build_array(jsonb_build_object('section_name', 'S1', 'sort_order', 0, 'items', jsonb_build_array(
          jsonb_build_object('product_id', '${LIQUID}', 'sort_order', 0, 'calc_mode', 'units_direct',
            'total_units_needed', 2, 'unit_size', 'Gal')))),
        '${ADMIN}', 'prover-ki16-seed-save');
    END $seed$;`, { commit: true, asOwner: true });
  raw(`UPDATE public.quotes SET is_planned = true WHERE quote_number = 'PROVER-KI16-1';`);
  assert.equal(scalar(`SELECT count(*) FROM public.quote_items qi JOIN public.quotes q ON q.id = qi.quote_id WHERE q.quote_number = 'PROVER-KI16-1';`), '1');
}
const quoteId = () => scalar(`SELECT id FROM public.quotes WHERE quote_number = 'PROVER-KI16-1';`);
const sectionId = () => scalar(`SELECT qs.id FROM public.quote_sections qs JOIN public.quotes q ON q.id = qs.quote_id WHERE q.quote_number = 'PROVER-KI16-1';`);
const setQuoteRateUnit = (u) => raw(`UPDATE public.quote_items SET rate_unit = ${u}, actual_rate = 2 WHERE quote_id = '${quoteId()}';`);
const schedule = (key) => `SELECT public.create_job_from_quote_section('${quoteId()}', '${sectionId()}', '${ADMIN}', '${key}');`;
const jobsForQuote = () => scalar(`SELECT count(*) FROM public.jobs WHERE quote_id = '${quoteId()}';`);
// lines: SQL expressions for rate_per_acre_unit, or [expr, productId] pairs.
const ticket = (id, lines) => `SELECT public.create_blend_ticket('${id}', jsonb_build_object('customer_id', '${CUSTOMER}', 'total_acres', 100),
  jsonb_build_array(${lines.map((l, i) => { const [u, pid] = Array.isArray(l) ? l : [l, LIQUID];
    return `jsonb_build_object('product_name', '[PROVER] KI16 line ${i}', 'product_id', '${pid}',
    'quantity', 200, 'unit', 'oz', 'rate_per_acre', 2, 'rate_per_acre_unit', ${u}, 'sequence_order', ${i})`; }).join(', ')}),
  '[]'::jsonb, false, '${ADMIN}', 'prover-ki16-${id.slice(-4)}');`;
// The exact unit check create_invoice_from_blend_ticket runs before billing (20261022020000).
const billingUnitRefusal = (ticketId) => scalar(`SELECT count(*) FROM public.blend_ticket_products btp
    JOIN public.products p ON p.id = btp.product_id
   WHERE btp.blend_ticket_id = '${ticketId}' AND btp.product_id IS NOT NULL
     AND public.field_app_priced_quantity(1,
           public.normalize_rate_unit(COALESCE(NULLIF(btrim(btp.rate_per_acre_unit), ''), p.rate_unit)),
           public.normalize_rate_unit(COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)),
           p.product_form) IS NULL;`);
const T_ZW = 'a16a1600-0000-4000-8000-00000000f001';

async function main() {
  buildContainer();
  seed();

  // BEFORE: the holes the candidate closes.
  setQuoteRateUnit("'oz/cwt'");
  clean('BEFORE schedule oz/cwt', schedule('k-before'));
  clean('BEFORE blend oz/cwt', ticket('a16a1600-0000-4000-8000-00000000f000', ["'oz/cwt'"]));
  clean('BEFORE blend blank unit on a per-cwt product', ticket('a16a1600-0000-4000-8000-00000000f00b', [["NULL", CWT]]));
  assert.equal(scalar(`SELECT public.normalize_rate_unit('oz' || ${ZWSP}) = 'oz';`), 'f');
  clean('BEFORE blend oz+ZWSP saves', ticket(T_ZW, [`'oz' || ${ZWSP}`]), { commit: true });
  assert.equal(billingUnitRefusal(T_ZW), '1', 'BEFORE: the invoice unit check refuses oz+ZWSP');
  console.log('[prover] BEFORE: a booking line and a blend ticket line rated oz/cwt both save; oz+ZWSP blocks billing');

  // P8: a drifted normalize_rate_unit body refuses the whole file.
  const candidate = lf(CANDIDATE);
  stageText('drift.sql', `CREATE OR REPLACE FUNCTION public.normalize_rate_unit(p_unit text) RETURNS text LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp' AS $d$ SELECT lower(btrim(p_unit)) $d$;\n${candidate}`);
  const drift = apply('drift.sql');
  assert.notEqual(drift.status, 0); assert.match(drift.output, /KI16_RATE_UNIT_PREFLIGHT: normalize_rate_unit is not the reviewed/);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = 'rate_unit_line_refusal';`), '0');
  console.log('[prover] P8: a changed normalize_rate_unit body refuses the file; nothing changed');

  stageText('cand.sql', candidate);
  const applied = apply('cand.sql');
  assert.equal(applied.status, 0, applied.output);
  const again = apply('cand.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /KI16_RATE_UNIT_PREFLIGHT: normalize_rate_unit is not the reviewed|KI16_RATE_UNIT_PREFLIGHT: a rate-unit guard trigger already exists/);
  console.log('[prover] candidate applied (postflight passed); a second run refuses');

  // P1
  const p1 = refusedWith('P1 schedule oz/cwt', schedule('k-p1'), 'CHEM_RATE_DENOMINATOR_NOT_ACRES');
  assert.match(p1, /\[PROVER\] KI16 Liquid has a rate unit of "oz\/cwt"/);
  setQuoteRateUnit("'oz per cwt'");
  refusedWith('P1 schedule oz per cwt', schedule('k-p1b'), 'CHEM_RATE_DENOMINATOR_NOT_ACRES');
  setQuoteRateUnit(`'oz p' || ${ZWSP} || 'er cwt'`);
  refusedWith('P1 schedule oz p<ZWSP>er cwt', schedule('k-p1c'), 'CHEM_RATE_DENOMINATOR_NOT_ACRES');
  assert.equal(jobsForQuote(), '0', 'P1: a refused scheduling left a job behind');
  setQuoteRateUnit("'oz/ac'");
  clean('P1 schedule oz/ac', schedule('k-p1-ok'), { commit: true });
  assert.equal(jobsForQuote(), '1');
  const job = scalar(`SELECT id FROM public.jobs WHERE quote_id = '${quoteId()}';`);
  assert.equal(scalar(`SELECT count(*) || ':' || min(rate_unit) FROM public.job_chemicals WHERE job_id = '${job}';`), '1:oz/ac');
  console.log(`[prover] P1: scheduling refuses oz/cwt, 'oz per cwt' and a 'per' hidden by a zero-width space (${p1.replace(/^.*ERROR:\s*/, '')}); oz/ac schedules one line`);

  // P2 (owner session: the app no longer holds EXECUTE on load_recipe_into_job)
  refusedWith('P2 recipe oz per cwt', `SELECT public.load_recipe_into_job('${job}', '${RECIPE}', 'k-p2');`, 'CHEM_RATE_DENOMINATOR_NOT_ACRES', { asOwner: true });
  assert.equal(scalar(`SELECT count(*) || ':' || min(rate_unit) FROM public.job_chemicals WHERE job_id = '${job}';`), '1:oz/ac', 'P2: job lines changed');
  console.log("[prover] P2: load_recipe_into_job refuses a product rated 'oz per cwt'; the job's lines are untouched");

  // P3
  refusedWith('P3 blend oz/cwt/ac', ticket('a16a1600-0000-4000-8000-00000000f003', ["'oz/cwt/ac'"]), 'CHEM_RATE_DENOMINATOR_NOT_ACRES');
  refusedWith('P3 blend oz/cwt', ticket('a16a1600-0000-4000-8000-00000000f004', ["'pt/ac'", "'oz/cwt'"]), 'CHEM_RATE_DENOMINATOR_NOT_ACRES');
  refusedWith('P3 blend U+2215', ticket('a16a1600-0000-4000-8000-00000000f005', [`'oz' || chr(8725) || 'cwt'`]), 'CHEM_UNIT_UNSUPPORTED_CHARACTER');
  const p3b = refusedWith('P3 blank unit, per-cwt product', ticket('a16a1600-0000-4000-8000-00000000f007', [["NULL", CWT]]), 'CHEM_RATE_DENOMINATOR_NOT_ACRES');
  assert.match(p3b, /rate unit of "oz per cwt"/);
  const T_OK = 'a16a1600-0000-4000-8000-00000000f006';
  clean('P3 blend per-acre spellings', ticket(T_OK, ["'pt/ac'", "'gal per acre'", "'oz'", "'fl. oz/acre'", `'pt/a' || ${ZWSP} || 'c'`, 'NULL']), { commit: true });
  assert.equal(scalar(`SELECT count(*) FROM public.blend_ticket_products WHERE blend_ticket_id = '${T_OK}';`), '6');
  assert.equal(scalar(`SELECT count(*) FROM public.blend_ticket_products WHERE blend_ticket_id = '${T_OK}' AND rate_per_acre_unit IS NULL;`), '1',
    'P3: the blank-unit line did not save');
  // Sol round 2 HIGH: an invisible-only line unit is refused, not blanked (billing would not fall back).
  refusedWith('P3 invisible-only unit', ticket('a16a1600-0000-4000-8000-00000000f008', [`${ZWSP} || chr(160)`]), 'CHEM_UNIT_UNSUPPORTED_CHARACTER');
  // 'fl. oz' (with the period) has never been in normalize_rate_unit's list, so billing refuses that one line
  // before and after this change; every other saved spelling passes the invoice's unit check.
  assert.equal(scalar(`SELECT string_agg(btp.rate_per_acre_unit, ',') FROM public.blend_ticket_products btp
    JOIN public.products p ON p.id = btp.product_id WHERE btp.blend_ticket_id = '${T_OK}'
     AND public.field_app_priced_quantity(1, public.normalize_rate_unit(COALESCE(NULLIF(btrim(btp.rate_per_acre_unit), ''), p.rate_unit)),
           public.normalize_rate_unit(COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)), p.product_form) IS NULL;`),
    'fl. oz/acre', 'P3: a saved per-acre line other than fl. oz/acre fails the invoice unit check');
  refusedWith('P3 edit to oz/cwt', `UPDATE public.blend_ticket_products SET rate_per_acre_unit = 'oz/cwt' WHERE blend_ticket_id = '${T_OK}' AND rate_per_acre_unit = 'oz';`,
    'CHEM_RATE_DENOMINATOR_NOT_ACRES', { asOwner: true });
  refusedWith('P3 blank line moved to a per-cwt product', `UPDATE public.blend_ticket_products SET product_id = '${CWT}' WHERE blend_ticket_id = '${T_OK}' AND rate_per_acre_unit IS NULL;`,
    'CHEM_RATE_DENOMINATOR_NOT_ACRES', { asOwner: true });
  // Sol round 1 HIGH: billing reads NULLIF(btrim(unit), ''), so '' and spaces fall back to the product's unit too.
  for (const blank of ["''", "'   '"]) {
    refusedWith(`P3 line unit ${blank} on a per-cwt product`, `UPDATE public.blend_ticket_products SET product_id = '${CWT}', rate_per_acre_unit = ${blank} WHERE blend_ticket_id = '${T_OK}' AND rate_per_acre_unit = 'oz';`,
      'CHEM_RATE_DENOMINATOR_NOT_ACRES', { asOwner: true });
  }
  // Sol round 2 MED: a product's rate unit cannot become one a blank-unit unbilled line would refuse.
  refusedWith('P9 product edit to oz/cwt under a blank-unit line', `UPDATE public.products SET rate_unit = 'oz/cwt' WHERE id = '${LIQUID}';`,
    'CHEM_RATE_DENOMINATOR_NOT_ACRES', { asOwner: true });
  clean('P9 product edit to gal/ac', `UPDATE public.products SET rate_unit = 'gal/ac' WHERE id = '${LIQUID}';`, { asOwner: true });
  clean('P9 per-cwt edit on a product no blank line uses', `UPDATE public.products SET rate_unit = 'oz/bu' WHERE id = '${CWT}';`, { asOwner: true });
  // Luna round 3: an invisible-only product unit normalizes to nothing at billing, so neither path may rely on it.
  refusedWith('P9 product edit to an invisible-only unit under a blank-unit line', `UPDATE public.products SET rate_unit = ${ZWSP} WHERE id = '${LIQUID}';`,
    'CHEM_UNIT_UNSUPPORTED_CHARACTER', { asOwner: true });
  refusedWith('P9 blank line moved to a product whose unit is invisible-only', `UPDATE public.products SET rate_unit = ${ZWSP} WHERE id = '${CWT}';
    UPDATE public.blend_ticket_products SET product_id = '${CWT}' WHERE blend_ticket_id = '${T_OK}' AND rate_per_acre_unit IS NULL;`,
    'CHEM_UNIT_UNSUPPORTED_CHARACTER', { asOwner: true });
  console.log("[prover] P9: a product's rate unit edit is refused only while an unbilled blank-unit blend line relies on it");
  clean('P3 unrelated edit', `UPDATE public.blend_ticket_products SET quantity = quantity + 1 WHERE blend_ticket_id = '${T_OK}';`, { asOwner: true });
  console.log('[prover] P3: blend lines oz/cwt/ac, oz/cwt, a lookalike slash, and a blank unit on a per-cwt product are refused at save; per-acre spellings (one with a pasted zero-width space) save and pass the invoice check; edits to a per-cwt unit are refused');

  // P4
  const line = (unit, cents, qty) => `INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES ('${job}', '${LIQUID}', ${qty}, 'oz', 2, ${unit}, 0, ${cents}, 9);`;
  refusedWith('P4 priced U+2215', line(`'oz' || chr(8725) || 'cwt'`, 500, 10), 'CHEM_UNIT_UNSUPPORTED_CHARACTER', { asOwner: true });
  clean('P4 unpriced U+2215', line(`'oz' || chr(8725) || 'cwt'`, 0, 0), { asOwner: true });
  clean('P4 priced oz+ZWSP', line(`'oz' || ${ZWSP}`, 500, 10), { asOwner: true });
  refusedWith('P4 unpriced oz/cwt', line("'oz/cwt'", 0, 0), 'CHEM_RATE_DENOMINATOR_NOT_ACRES', { asOwner: true });
  console.log("[prover] P4: a priced lookalike-slash line is refused, unpriced it saves (save_job's price gate); oz/cwt is refused priced or not");

  // P5
  for (const [expr, want] of [[`'oz' || ${ZWSP}`, 'oz'], [`chr(65279) || 'Gal' || chr(160)`, 'gal'], [`'fl' || chr(160) || 'oz'`, 'oz'],
    [`'l' || chr(173) || 'b' || chr(8288) || '/ac'`, 'lb'], [`'oz/' || ${ZWSP} || 'cwt'`, 'oz/cwt'], ["'oz/cwt'", 'oz/cwt'], ["'Dry oz'", 'dry oz'],
    ["'pt/ac'", 'pt'], [`chr(8204) || chr(8205)`, '<null>']]) {
    assert.equal(scalar(`SELECT coalesce(public.normalize_rate_unit(${expr}), '<null>');`), want, `P5: normalize_rate_unit(${expr})`);
  }
  console.log('[prover] P5: normalize_rate_unit folds invisible characters; non-acre units stay whole');

  // P6
  assert.equal(billingUnitRefusal(T_ZW), '0', 'P6: the invoice unit check no longer refuses oz+ZWSP');
  console.log('[prover] P6: the blend invoice unit check now passes the oz+ZWSP line it refused BEFORE');

  // P7
  raw(`INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES ('${job}', '${LIQUID}', 0, 'oz', 2, '32', 0, 0, 20), ('${job}', '${LIQUID}', 10, 'Pt', 2, 'pt/ac', 0, 100, 21),
           ('${job}', '${LIQUID}', 10, 'oz', 2, 'oz', 0, 100, 22);`);
  clean('P7 edits on live-shaped lines', `UPDATE public.job_chemicals SET rate_unit = rate_unit, sort_order = sort_order + 10, price_per_unit_cents = price_per_unit_cents + 1
    WHERE job_id = '${job}' AND sort_order IN (20, 21, 22);`, { asOwner: true });
  console.log("[prover] P7: lines rated '32', 'pt/ac' and 'oz' take edits, price changes included");

  console.log('RATE_UNIT_GUARD_PROOF_PASS');
}
try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
