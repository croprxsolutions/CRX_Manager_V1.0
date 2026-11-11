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
 *       per-acre spellings save (each is then run through the invoice's unit query, which still refuses
 *       'fl. oz/acre' — a known KI-16 gap); an invisible-only unit is refused; edits to a per-cwt unit or
 *       product are refused; an unrelated edit saves. The invoice checks run the invoice's unit query, not the
 *       full invoice RPC.
 *   P4  a priced job line rated 'oz'+U+2215+'cwt' is refused; unpriced it saves (save_job's price gate).
 *   P5  normalize_rate_unit folds invisible characters; a non-acre unit stays whole.
 *   P6  the blend invoice's unit check now passes the 'oz'+ZWSP line.
 *   P7  live-shaped existing lines ('32', 'pt/ac', 'oz') take other edits, price changes included.
 *
 * Then the follow-up 20270101000000 (contract docs/plans/2026-11-10-ki16-rate-unit-followups-CONTRACT.md):
 *   R0  real invoices: create_invoice_from_blend_ticket bills a 'pt/ac' and an 'oz'+ZWSP line after the candidate.
 *   FB  BEFORE the follow-up: a liquid 'fl. oz/ac' line saves but its invoice is refused; 'oz'+TAB is refused at
 *       save; save_job refuses a priced 'pt/a'+ZWSP+'c'; a soft-deleted ticket blocks a product rate unit edit.
 *   F0  a changed save_job body refuses the follow-up with nothing changed; it applies; a second run refuses.
 *   F1  the 'fl. oz/ac' ticket now invoices (200 fl oz = 1.5625 Gal); a dry product's 'fl. oz/ac' is still refused.
 *   F2  'oz'+TAB and 'fl'+TAB+'oz/ac' save and invoice as ounces; a tab-only unit is refused at save.
 *   F3  save_job saves a priced 'pt/a'+ZWSP+'c' line (stored 'pt/ac') ; a stock Unit 'Pt'+TAB is refused (not folded); 'oz/'+ZWSP+'cwt' is still refused.
 *   F4  a soft-deleted ticket no longer blocks the product edit; a live unbilled ticket still does.
 *   F5  normalizer table: earlier outputs unchanged; whitespace and dotted fl. oz as reviewed.
 *   F6  a dry product refuses fluid ounces on a blend line in any spelling, through its default, and by turning dry (Sol round 1 HIGH).
 *
 * Then 20270101020000 (contract docs/plans/2026-11-10-ki16-dry-fluid-ounce-CONTRACT.md):
 *   GB  BEFORE: a dry product's job line in 'fl oz' saves and its hold/deduction sizes 16 as 1 (lb); a booking with a
 *       dry fl oz line schedules; a dry blend line rated 'fl oz/ac' saves and its real invoice bills 200 fl oz as 12.5 lb.
 *   G0  the guard applies (postflight passed); a second run refuses.
 *   G1  scheduling a booking whose dry line is in fl oz is refused, no job; save_job still refuses; liquid schedules.
 *   G2  dry blend lines in fl oz (rate, quantity unit, edits, moves, a direct table edit) are refused; dry oz/lb and a
 *       liquid fl oz line save, and the liquid one invoices.
 *   G3  direct job_chemicals writes (as every definer RPC writes them) with fl oz on a dry product are refused; oz on
 *       dry and fl oz on liquid save; an unrelated edit saves.
 *   G4  a dry product's rate, size or stock unit cannot be fl oz; every product needs a form (a direct insert, the
 *       spreadsheet import and clearing a saved form are refused), and a saved form cannot change.
 *   G5  unit_names_fluid_ounce table.
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
// KI-16 follow-ups (contract docs/plans/2026-11-10-ki16-rate-unit-followups-CONTRACT.md), applied after P1-P9.
const FOLLOW_UP = path.join(MIGRATIONS, '20270101000000_rate_unit_followups_whitespace_dotted_floz_save_job_fold.sql');
// KI-16 dry fluid ounce (contract docs/plans/2026-11-10-ki16-dry-fluid-ounce-CONTRACT.md), applied after F0-F5.
const DRY_FLOZ = path.join(MIGRATIONS, '20270101020000_dry_product_fluid_ounce_guard.sql');
const FOLLOW_UPS = [FOLLOW_UP, DRY_FLOZ];
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
const T_OK = 'a16a1600-0000-4000-8000-00000000f006';

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

  followUps();
  dryFluidOunce();
  console.log('RATE_UNIT_GUARD_PROOF_PASS');
}

// ── Follow-up 20270101000000 ──
const DRY = 'a16a1600-0000-4000-8000-0000000000b3';
const LIQ2 = 'a16a1600-0000-4000-8000-0000000000b4';
const FIELD = 'a16a1600-0000-4000-8000-0000000000d1';
const TAB = 'chr(9)';
const SAVE_JOB = "'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)'::regprocedure";
// Approve a ticket with one 100-acre field, as the review screen leaves it (seed, triggers off).
const approve = (t) => raw(`UPDATE public.blend_tickets SET review_status = 'approved', status = 'completed', season = 2027,
    ticket_date = DATE '2026-11-01' WHERE id = '${t}';
  INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, planned_acres) VALUES ('${t}', '${FIELD}', '${CUSTOMER}', 100);`);
const invoice = (t) => `SELECT public.create_invoice_from_blend_ticket('${t}', '${ADMIN}', 'prover-ki16-inv-${t.slice(-4)}');`;
// The billed chemical quantities of a ticket's invoice, in line order (4 dp).
const billed = (t) => scalar(`SELECT string_agg(round(ii.quantity, 4)::text, ' | ' ORDER BY ii.sort_order, ii.quantity)
  FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
 WHERE i.blend_ticket_id = '${t}' AND ii.product_id IS NOT NULL AND NOT coalesce(ii.is_application_fee, false);`);
const saveJobLine = (unit, stock = "'Pt'") => `SELECT public.save_job(NULL, jsonb_build_object('customer_id', '${CUSTOMER}', 'job_date', to_char(CURRENT_DATE, 'YYYY-MM-DD')),
  jsonb_build_array(jsonb_build_object('field_id', '${FIELD}', 'acres_to_treat', 10, 'sort_order', 0)),
  jsonb_build_array(jsonb_build_object('product_id', '${LIQUID}', 'quantity', 10, 'unit', ${stock}, 'rate_per_acre', 1, 'rate_unit', ${unit},
    'cost_per_unit_cents', 0, 'price_per_unit_cents', 400, 'sort_order', 0)),
  '${ADMIN}', NULL);`;

function followUps() {
  raw(`UPDATE public.customers SET assigned_tier = 1 WHERE id = '${CUSTOMER}';
    INSERT INTO public.products (id, product_name, unit_size, inventory_unit, rate_unit, product_form, current_cost, tier1_price, tier1_margin, is_active)
    VALUES ('${DRY}', '[PROVER] KI16 Dry', 'Lb', 'Lb', 'lb', 'dry', 1.00, 2.00, 50, true),
           ('${LIQ2}', '[PROVER] KI16 Liquid Two', 'Gal', 'Gal', 'oz', 'liquid', 10.00, 12.80, 21.875, true);
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
    VALUES ('${LIQUID}', 'Main Warehouse', 1000, 0, 0), ('${DRY}', 'Main Warehouse', 1000, 0, 0), ('${LIQ2}', 'Main Warehouse', 1000, 0, 0);
    INSERT INTO public.fields (id, customer_id, field_name) VALUES ('${FIELD}', '${CUSTOMER}', '[PROVER] KI16 Field');`);

  // R0: the candidate's own cases billed through the real RPC (rate 2 x 100 acres = 200, sold per Gal).
  const R0 = 'a16a1600-0000-4000-8000-00000000f100';
  clean('R0 ticket pt/ac + oz<ZWSP>', ticket(R0, ["'pt/ac'", `'oz' || ${ZWSP}`]), { commit: true });
  approve(R0);
  clean('R0 invoice', invoice(R0), { commit: true });
  assert.equal(billed(R0), '25.0000 | 1.5625', 'R0: 200 pt and 200 oz bill as 25 and 1.5625 Gal');
  console.log(`[prover] R0: create_invoice_from_blend_ticket bills a pt/ac and an oz+ZWSP line: ${billed(R0)} Gal`);

  // FB: the follow-up's holes, after the candidate and before the follow-up.
  const T_FL = 'a16a1600-0000-4000-8000-00000000f101';
  clean('FB liquid fl. oz/ac saves', ticket(T_FL, ["'fl. oz/ac'"]), { commit: true });
  approve(T_FL);
  refusedWith('FB liquid fl. oz/ac invoice', invoice(T_FL), 'BLEND_TICKET_UNIT_UNCONVERTIBLE');
  const fbTab = refusedWith('FB oz<TAB> at save', ticket('a16a1600-0000-4000-8000-00000000f102', [`'oz' || ${TAB}`]), 'CHEM_UNIT_UNSUPPORTED_CHARACTER');
  refusedWith('FB save_job pt/a<ZWSP>c', saveJobLine(`'pt/a' || ${ZWSP} || 'c'`), 'CHEM_RATE_DENOMINATOR_NOT_ACRES');
  // Sol round 1 HIGH: a dry product's undotted 'fl oz/ac' saves and bills 200 fl oz as 12.5 lb of weight.
  const T_DRYB = 'a16a1600-0000-4000-8000-00000000f107';
  clean('FB dry fl oz/ac saves', ticket(T_DRYB, [["'fl oz/ac'", DRY]]), { commit: true });
  approve(T_DRYB);
  clean('FB dry fl oz/ac invoice', invoice(T_DRYB), { commit: true });
  assert.equal(billed(T_DRYB), '12.5000', 'FB: 200 fl oz on a dry product bills as 12.5 lb');
  const T_DEL = 'a16a1600-0000-4000-8000-00000000f103';
  clean('FB blank-unit line on product two', ticket(T_DEL, [['NULL', LIQ2]]), { commit: true });
  raw(`UPDATE public.blend_tickets SET deleted_at = now() WHERE id = '${T_DEL}';`);
  refusedWith('FB soft-deleted ticket blocks the product edit', `UPDATE public.products SET rate_unit = 'oz/cwt' WHERE id = '${LIQ2}';`,
    'CHEM_RATE_DENOMINATOR_NOT_ACRES', { asOwner: true });
  console.log(`[prover] FB: before the follow-up, fl. oz/ac is refused at billing, oz+TAB at save (${fbTab.replace(/^.*ERROR:\s*/, '').slice(0, 60)}), pt/a+ZWSP+c by save_job, a deleted ticket blocks a product edit, and a dry product's fl oz/ac bills ${billed(T_DRYB)} lb`);

  // F0: a drifted save_job body refuses the whole follow-up.
  const followUp = lf(FOLLOW_UP);
  const saveJobMd5 = () => scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = ${SAVE_JOB};`);
  const saveJobBefore = saveJobMd5();
  stageText('f-drift.sql', `UPDATE pg_catalog.pg_proc SET prosrc = prosrc || ' ' WHERE oid = ${SAVE_JOB};\n${followUp}`);
  const fDrift = docker([...psqlArgs('supabase_admin'), '-1', '-f', '/tmp/f-drift.sql'], { allowFailure: true });
  assert.notEqual(fDrift.status, 0);
  assert.match(`${fDrift.stdout}\n${fDrift.stderr}`, /KI16_FOLLOWUP_PREFLIGHT: .*save_job.* is not the reviewed body/);
  assert.equal(saveJobMd5(), saveJobBefore, 'F0: the refused follow-up changed save_job');
  assert.equal(scalar("SELECT coalesce(public.normalize_rate_unit('fl. oz'), '<null>');"), 'fl. oz', 'F0: the refused follow-up changed the normalizer');
  stageText('follow-up.sql', followUp);
  const fApplied = apply('follow-up.sql');
  assert.equal(fApplied.status, 0, fApplied.output);
  const fAgain = apply('follow-up.sql');
  assert.notEqual(fAgain.status, 0); assert.match(fAgain.output, /KI16_FOLLOWUP_PREFLIGHT: .* is not the reviewed body/);
  console.log('[prover] F0: a changed save_job body refuses the follow-up with nothing changed; it applies (postflight passed); a second run refuses');

  // F1
  clean('F1 liquid fl. oz/ac invoice', invoice(T_FL), { commit: true });
  assert.equal(billed(T_FL), '1.5625', 'F1: 200 fl oz bills as 1.5625 Gal');
  const T_DRY = 'a16a1600-0000-4000-8000-00000000f104';
  refusedWith('F1 dry fl. oz/ac at save', ticket(T_DRY, [["'fl. oz/ac'", DRY]]), 'CHEM_UNIT_FORM_MISMATCH');
  assert.equal(billingUnitRefusal(T_OK), '0', "F1: P3's saved 'fl. oz/acre' line now passes the invoice unit check");
  console.log(`[prover] F1: a liquid fl. oz/ac line now bills ${billed(T_FL)} Gal; a dry product's fl. oz/ac is refused at save`);

  // F2
  const T_TAB = 'a16a1600-0000-4000-8000-00000000f105';
  clean('F2 tab units save', ticket(T_TAB, [`'oz' || ${TAB}`, `'fl' || ${TAB} || 'oz/ac'`]), { commit: true });
  approve(T_TAB);
  clean('F2 tab units invoice', invoice(T_TAB), { commit: true });
  assert.equal(billed(T_TAB), '1.5625 | 1.5625', 'F2: oz+TAB and fl+TAB+oz/ac bill as ounces');
  refusedWith('F2 tab-only unit', ticket('a16a1600-0000-4000-8000-00000000f106', [`${TAB} || chr(10)`]), 'CHEM_UNIT_UNSUPPORTED_CHARACTER');
  console.log(`[prover] F2: oz+TAB and fl+TAB+oz/ac save and bill ${billed(T_TAB)} Gal; a tab-only unit is refused at save`);

  // F3
  const jobs = () => Number(scalar(`SELECT count(*) FROM public.jobs WHERE customer_id = '${CUSTOMER}';`));
  const jobsBefore = jobs();
  clean('F3 save_job pt/a<ZWSP>c', saveJobLine(`'pt/a' || ${ZWSP} || 'c'`), { commit: true });
  assert.equal(jobs(), jobsBefore + 1);
  assert.equal(scalar(`SELECT jc.rate_unit FROM public.job_chemicals jc JOIN public.jobs j ON j.id = jc.job_id
    WHERE j.customer_id = '${CUSTOMER}' ORDER BY j.created_at DESC, jc.sort_order LIMIT 1;`), 'pt/ac', 'F3: the stored rate unit is folded');
  // Sol round 3 MED: the stock Unit is not folded (the non-admin cost lookup matches it as stored); a tab fails closed.
  refusedWith('F3 save_job stock Unit Pt<TAB>', saveJobLine("'pt/ac'", `'Pt' || ${TAB}`), 'CHEM_UNIT_UNSUPPORTED_CHARACTER');
  refusedWith('F3 save_job oz/<ZWSP>cwt', saveJobLine(`'oz/' || ${ZWSP} || 'cwt'`), 'CHEM_RATE_DENOMINATOR_NOT_ACRES');
  refusedWith('F3 save_job oz<TAB>/cwt', saveJobLine(`'oz' || ${TAB} || '/cwt'`), 'CHEM_RATE_DENOMINATOR_NOT_ACRES');
  console.log("[prover] F3: save_job saves a priced pt/a+ZWSP+c line (stored 'pt/ac'); a stock Unit Pt+TAB is refused; oz/+ZWSP+cwt and oz+TAB+/cwt are still refused");

  // F4
  clean('F4 soft-deleted ticket no longer blocks', `UPDATE public.products SET rate_unit = 'oz/cwt' WHERE id = '${LIQ2}';`, { asOwner: true, commit: true });
  refusedWith('F4 a live unbilled blank-unit line still blocks', `UPDATE public.products SET rate_unit = 'oz/cwt' WHERE id = '${LIQUID}';`,
    'CHEM_RATE_DENOMINATOR_NOT_ACRES', { asOwner: true });
  // An admin or sales rep may clear deleted_at directly (live RLS, 2026-11-10); the restored line then fails closed at billing.
  clean('F4 restore the deleted ticket', `UPDATE public.blend_tickets SET deleted_at = NULL WHERE id = '${T_DEL}';`, { commit: true });
  approve(T_DEL);
  refusedWith('F4 restored ticket on a per-cwt product', invoice(T_DEL), 'BLEND_TICKET_UNIT_UNCONVERTIBLE');
  console.log('[prover] F4: a soft-deleted ticket no longer blocks a product rate unit edit; a live unbilled ticket still does; a restored one is refused at billing');

  // F6: a dry product cannot be measured in fluid ounces on a blend line, in any spelling or through its default.
  for (const u of ["'fl oz/ac'", `'fl' || ${TAB} || 'oz/ac'`, "'FLUID OUNCES per acre'", `'fl' || ${ZWSP} || 'oz'`, "'floz'"]) {
    refusedWith(`F6 dry ${u}`, ticket('a16a1600-0000-4000-8000-00000000f108', [[u, DRY]]), 'CHEM_UNIT_FORM_MISMATCH');
  }
  clean('F6 dry oz/ac saves', ticket('a16a1600-0000-4000-8000-00000000f108', [["'oz/ac'", DRY]]));
  const T_DRYN = 'a16a1600-0000-4000-8000-00000000f109';
  clean('F6 dry blank-unit line', ticket(T_DRYN, [['NULL', DRY]]), { commit: true });
  refusedWith('F6 dry product default to fl oz/ac', `UPDATE public.products SET rate_unit = 'fl oz/ac' WHERE id = '${DRY}';`,
    'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  // Sol round 2 HIGH: a soft-deleted ticket still holds it, since a restore would bill the line.
  raw(`UPDATE public.blend_tickets SET deleted_at = now() WHERE id = '${T_DRYN}';`);
  refusedWith('F6 dry default to fl oz/ac under a deleted ticket', `UPDATE public.products SET rate_unit = 'fl oz/ac' WHERE id = '${DRY}';`,
    'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  // Sol round 3 HIGH: a no-charge ticket can return to billing, so it holds it too; no ticket state is exempt.
  raw(`UPDATE public.blend_tickets SET deleted_at = NULL, payment_status = 'no_charge' WHERE id = '${T_DRYN}';`);
  refusedWith('F6 dry default to fl oz/ac under a no-charge ticket', `UPDATE public.products SET rate_unit = 'fl oz/ac' WHERE id = '${DRY}';`,
    'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  const T_LF = 'a16a1600-0000-4000-8000-00000000f10a';
  clean('F6 liquid fl oz/ac line', ticket(T_LF, ["'fl oz/ac'"]), { commit: true });
  refusedWith('F6 liquid product turning dry', `UPDATE public.products SET product_form = 'dry', inventory_unit = 'Lb', unit_size = 'Lb' WHERE id = '${LIQUID}';`,
    "can't change on a saved product", { asOwner: true }); // the existing unit lock refuses first; the guard's became-dry check is a backstop
  // Sol round 3 LOW: with the unit lock set aside (rolled back), the became-dry backstop itself refuses.
  refusedWith('F6 became-dry backstop', `ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_setup_fields;
    UPDATE public.products SET product_form = 'dry', inventory_unit = 'Lb', unit_size = 'Lb' WHERE id = '${LIQUID}';`,
    'CHEM_UNIT_FORM_MISMATCH: .* cannot become a dry product', { asOwner: true });
  console.log("[prover] F6: a dry product's fl oz in five spellings is refused at save, oz/ac saves; a dry default cannot become fl oz/ac under a blank line, deleted or no-charge ticket or not; a saved product cannot turn dry (unit lock first, then the backstop)");

  // F5
  for (const [expr, want] of [[`'oz' || ${ZWSP}`, 'oz'], [`chr(65279) || 'Gal' || chr(160)`, 'gal'], [`'fl' || chr(160) || 'oz'`, 'oz'],
    [`'oz/' || ${ZWSP} || 'cwt'`, 'oz/cwt'], ["'oz/cwt'", 'oz/cwt'], ["'Dry oz'", 'dry oz'], ["'pt/ac'", 'pt'], ["'fl oz'", 'oz'],
    ["'floz/acre'", 'oz'], [`'oz' || ${TAB}`, 'oz'], [`chr(12288) || 'GAL' || chr(13) || chr(10)`, 'gal'], [TAB, '<null>'],
    [`'oz/' || ${TAB} || 'cwt'`, 'oz/ cwt'], ["'fl. oz'", 'fl oz'], ["'FL.OZ/ac'", 'fl oz'], ["'fl. oz. per acre'", 'fl oz'], ["'fl. oz/cwt'", 'fl. oz/cwt']]) {
    assert.equal(scalar(`SELECT coalesce(public.normalize_rate_unit(${expr}), '<null>');`), want, `F5: normalize_rate_unit(${expr})`);
  }
  console.log('[prover] F5: normalize_rate_unit keeps every earlier output; whitespace folds and dotted fl. oz maps to fl oz');
}

// ── 20270101020000: a fluid ounce on a dry product ──
const LIQ3 = 'a16a1600-0000-4000-8000-0000000000b5';
const jobLine = (job, pid, unit, rateUnit, sort) => `INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES ('${job}', '${pid}', 16, ${unit}, 16, ${rateUnit}, 0, 0, ${sort});`;
// A blend ticket with full control of each line: [rate_per_acre_unit expr, product id, quantity unit expr].
const ticketLines = (id, lines) => `SELECT public.create_blend_ticket('${id}', jsonb_build_object('customer_id', '${CUSTOMER}', 'total_acres', 100),
  jsonb_build_array(${lines.map(([u, pid, qu], i) => `jsonb_build_object('product_name', '[PROVER] KI16 line ${i}', 'product_id', '${pid}',
    'quantity', 200, 'unit', ${qu}, 'rate_per_acre', 2, 'rate_per_acre_unit', ${u}, 'sequence_order', ${i})`).join(', ')}),
  '[]'::jsonb, false, '${ADMIN}', 'prover-ki16-${id.slice(-4)}');`;
// The hold and deduction expression (complete_job 20261217100000, holds 20261206110000) on a stored unit.
const sized = (qty, unit, pid) => scalar(`SELECT coalesce(round(public.field_app_priced_quantity(${qty}, public.normalize_rate_unit(${unit}), p.inventory_unit, p.product_form), 4)::text, '<null>')
  FROM public.products p WHERE p.id = '${pid}';`);
function bookingFor(n, pid, priceUnit, rateUnit) {
  clean(`booking ${n}`, `DO $b$ BEGIN
      PERFORM public.save_quote(NULL, jsonb_build_object('quote_number', 'PROVER-KI16-${n}', 'status', 'draft', 'tier', 1,
          'commission_split', '{"splits": []}'::jsonb, 'customer_id', '${CUSTOMER}'),
        jsonb_build_array(jsonb_build_object('section_name', 'S1', 'sort_order', 0, 'items', jsonb_build_array(
          jsonb_build_object('product_id', '${pid}', 'sort_order', 0, 'calc_mode', 'units_direct', 'total_units_needed', 2)))),
        '${ADMIN}', 'prover-ki16-booking-${n}');
    END $b$;`, { commit: true, asOwner: true });
  raw(`UPDATE public.quotes SET is_planned = true WHERE quote_number = 'PROVER-KI16-${n}';
    UPDATE public.quote_items qi SET price_unit = ${priceUnit}, rate_unit = ${rateUnit}, actual_rate = 16
      FROM public.quotes q WHERE q.id = qi.quote_id AND q.quote_number = 'PROVER-KI16-${n}';`);
  const q = scalar(`SELECT id FROM public.quotes WHERE quote_number = 'PROVER-KI16-${n}';`);
  const sec = scalar(`SELECT id FROM public.quote_sections WHERE quote_id = '${q}';`);
  return { run: (key) => `SELECT public.create_job_from_quote_section('${q}', '${sec}', '${ADMIN}', '${key}');`,
    jobs: () => scalar(`SELECT count(*) FROM public.jobs WHERE quote_id = '${q}';`) };
}

const bookingLines = (n) => `FROM public.quotes q WHERE q.id = qi.quote_id AND q.quote_number = 'PROVER-KI16-${n}'`;

function dryFluidOunce() {
  raw(`INSERT INTO public.products (id, product_name, unit_size, inventory_unit, rate_unit, product_form, current_cost, tier1_price, tier1_margin, is_active)
    VALUES ('${LIQ3}', '[PROVER] KI16 Liquid Three', 'Ea', 'Ea', 'oz', 'liquid', 10.00, 12.80, 21.875, true);
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
    VALUES ('${LIQ3}', 'Main Warehouse', 1000, 0, 0);`);
  const job = scalar(`SELECT j.id FROM public.jobs j WHERE j.quote_id = '${quoteId()}';`);
  assert.match(job, /^[0-9a-f-]{36}$/, 'GB: P1 job not found');

  // GB: the hole, after both earlier files and before this one (nothing committed).
  clean('GB dry job line in fl oz saves', jobLine(job, DRY, "'fl oz'", "'fl oz/ac'", 40), { asOwner: true });
  assert.equal(sized(16, "'fl oz'", DRY), '1.0000', 'GB: 16 fl oz of a dry product sizes as 1 lb for holds and deduction');
  const bk = bookingFor(2, DRY, "'fl oz'", "'fl oz/ac'");
  clean('GB booking with a dry fl oz line schedules', bk.run('k-gb'));
  const T_GB = 'a16a1600-0000-4000-8000-00000000f200';
  // #1741 already refuses a dry blend line's billed rate unit in fl oz; its quantity unit (blend stock deduction) is open.
  refusedWith('GB dry blend line rated fl oz/ac (already refused by #1741)', ticketLines(T_GB, [["'fl oz/ac'", DRY, "'oz'"]]), 'CHEM_UNIT_FORM_MISMATCH');
  clean('GB dry blend line with a fl oz quantity unit saves', ticketLines(T_GB, [["'lb/ac'", DRY, "'fl oz'"]]), { commit: true });
  // The proof database now holds dry fl oz lines, which the postflight would (rightly) refuse; make them weight.
  // Earlier stages (F1, F6) also left dry fl oz fixture lines; the postflight caught them before this cleanup.
  raw(`UPDATE public.blend_ticket_products b SET unit = CASE WHEN public.unit_names_fluid_ounce(b.unit) THEN 'oz' ELSE b.unit END,
      rate_per_acre_unit = CASE WHEN public.unit_names_fluid_ounce(b.rate_per_acre_unit) THEN 'lb/ac' ELSE b.rate_per_acre_unit END
      FROM public.products p WHERE p.id = b.product_id AND p.product_form = 'dry';
    UPDATE public.products SET rate_unit = 'lb' WHERE product_form = 'dry' AND public.unit_names_fluid_ounce(rate_unit);
    UPDATE public.quote_items qi SET price_unit = 'oz', rate_unit = 'oz/ac' ${bookingLines(2)};`);
  console.log(`[prover] GB: before the guard a dry job line in fl oz saves (16 fl oz sizes as ${sized(16, "'fl oz'", DRY)} lb for holds and deduction), a booking schedules it, and a dry blend line saves a fl oz quantity unit`);

  // G0
  const guard = lf(DRY_FLOZ);
  stageText('dry-floz.sql', guard);
  const gApplied = apply('dry-floz.sql');
  assert.equal(gApplied.status, 0, gApplied.output);
  const gAgain = apply('dry-floz.sql');
  assert.notEqual(gAgain.status, 0); assert.match(gAgain.output, /KI16_DRY_FLOZ_PREFLIGHT: unit_names_fluid_ounce or a #1741 guard is not the reviewed body/);
  console.log('[prover] G0: the guard applies (postflight passed); a second run refuses');
  // Booking 2 back to the fl oz units it was stored with before the guard (a legacy row: the job side still refuses it).
  raw(`UPDATE public.quote_items qi SET price_unit = 'fl oz', rate_unit = 'fl oz/ac' ${bookingLines(2)};`);

  // G1
  const g1 = refusedWith('G1 schedule dry fl oz', bk.run('k-g1'), 'CHEM_UNIT_FORM_MISMATCH');
  assert.match(g1, /\[PROVER\] KI16 Dry is a DRY product/);
  assert.equal(bk.jobs(), '0', 'G1: a refused scheduling left a job behind');
  const bk3 = bookingFor(3, DRY, "'fl. oz'", "'oz/ac'");
  refusedWith('G1 schedule dry fl. oz (quantity unit only)', bk3.run('k-g1b'), 'CHEM_UNIT_FORM_MISMATCH');
  const bk4 = bookingFor(4, LIQ3, "'fl oz'", "'fl oz/ac'");
  clean('G1 schedule liquid fl oz', bk4.run('k-g1c'), { commit: true });
  assert.equal(bk4.jobs(), '1');
  refusedWith('G1 save_job dry fl oz', `SELECT public.save_job(NULL, jsonb_build_object('customer_id', '${CUSTOMER}', 'job_date', to_char(CURRENT_DATE, 'YYYY-MM-DD')),
    jsonb_build_array(jsonb_build_object('field_id', '${FIELD}', 'acres_to_treat', 10, 'sort_order', 0)),
    jsonb_build_array(jsonb_build_object('product_id', '${DRY}', 'quantity', 160, 'unit', 'fl oz', 'rate_per_acre', 16, 'rate_unit', 'fl oz/ac',
      'cost_per_unit_cents', 0, 'price_per_unit_cents', 10, 'sort_order', 0)), '${ADMIN}', NULL);`, 'CHEM_UNIT_FORM_MISMATCH');
  // Bookings themselves (save_quote as the signed-in admin, and a direct edit).
  const saveBooking = (n, pid, priceUnit, rateUnit) => `SELECT public.save_quote(NULL, jsonb_build_object('quote_number', 'PROVER-KI16-${n}', 'status', 'draft', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'customer_id', '${CUSTOMER}'),
    jsonb_build_array(jsonb_build_object('section_name', 'S1', 'sort_order', 0, 'items', jsonb_build_array(
      jsonb_build_object('product_id', '${pid}', 'sort_order', 0, 'calc_mode', 'units_direct', 'total_units_needed', 2,
        'price_unit', ${priceUnit}, 'rate_unit', ${rateUnit}, 'actual_rate', 16)))),
    '${ADMIN}', 'prover-ki16-booking-${n}');`;
  refusedWith('G1 save a booking with a dry fl oz price unit', saveBooking(5, DRY, "'fl oz'", "'oz/ac'"), 'CHEM_UNIT_FORM_MISMATCH');
  refusedWith('G1 save a booking with a dry FLOZ/acre rate unit', saveBooking(6, DRY, "'oz'", "'FLOZ/acre'"), 'CHEM_UNIT_FORM_MISMATCH');
  refusedWith('G1 save a booking priced per 32 fl oz on a dry product', saveBooking(9, DRY, "'32 fl oz'", "'oz/ac'"), 'CHEM_UNIT_FORM_MISMATCH');
  refusedWith('G1 dry job line in 2.5 fl oz', jobLine(job, DRY, "'2.5 fl oz'", "'oz/ac'", 45), 'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  clean('G1 save a booking with dry oz units', saveBooking(7, DRY, "'oz'", "'oz/ac'"));
  clean('G1 save a booking with liquid fl oz units', saveBooking(8, LIQUID, "'fl oz'", "'fl oz/ac'"));
  refusedWith('G1 edit a stored dry booking line to fl oz', `UPDATE public.quote_items qi SET price_unit = 'fl oz' ${bookingLines(3)};`,
    'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  refusedWith('G1 move the liquid fl oz booking line to the dry product', `UPDATE public.quote_items qi SET product_id = '${DRY}' ${bookingLines(4)};`,
    'CHEM_UNIT_FORM_MISMATCH|QUOTE_ITEM_PRODUCT_IMMUTABLE', { asOwner: true });
  console.log(`[prover] G1: scheduling a dry fl oz (or fl. oz) booking line is refused with no job (${g1.replace(/^.*ERROR:\s*/, '').slice(0, 60)}...); save_job still refuses; a liquid fl oz line schedules; saving or editing a booking line in fl oz on a dry product is refused, dry oz and liquid fl oz bookings save`);

  // G2
  for (const [label, lines] of [
    ['rate fl oz/ac', [["'fl oz/ac'", DRY, "'oz'"]]],
    ['rate FLUID OUNCES per acre', [["'FLUID OUNCES per acre'", DRY, "'oz'"]]],
    ['rate fl. oz', [["'fl. oz'", DRY, "'lb'"]]],
    ['rate fl+NBSP+oz/a', [["'fl' || chr(160) || 'oz/a'", DRY, "'oz'"]]],
    ['quantity unit fl oz', [["'oz/ac'", DRY, "'fl oz'"]]],
    ['second line of two', [["'lb/ac'", DRY, "'lb'"], ["'floz/acre'", DRY, "'oz'"]]],
  ]) refusedWith(`G2 dry ${label}`, ticketLines('a16a1600-0000-4000-8000-00000000f201', lines), 'CHEM_UNIT_FORM_MISMATCH');
  const T_G2 = 'a16a1600-0000-4000-8000-00000000f202';
  clean('G2 dry oz/lb and liquid fl oz save', ticketLines(T_G2, [["'oz/ac'", DRY, "'oz'"], ["'Dry oz'", DRY, "'dry oz'"], ["'lb/ac'", DRY, "'lb'"], ['NULL', DRY, "'lb'"],
    ["'fl oz/ac'", LIQUID, "'fl oz'"]]), { commit: true });
  refusedWith('G2 edit a dry rate to fl oz/ac', `UPDATE public.blend_ticket_products SET rate_per_acre_unit = 'fl oz/ac' WHERE blend_ticket_id = '${T_G2}' AND rate_per_acre_unit = 'oz/ac';`,
    'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  refusedWith('G2 edit a dry quantity unit to fl oz', `UPDATE public.blend_ticket_products SET unit = 'fl oz' WHERE blend_ticket_id = '${T_G2}' AND unit = 'lb';`,
    'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  refusedWith('G2 move the liquid fl oz line to the dry product', `UPDATE public.blend_ticket_products SET product_id = '${DRY}' WHERE blend_ticket_id = '${T_G2}' AND product_id = '${LIQUID}';`,
    'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  // As the signed-in admin through the column grants (no RPC), the same refusal.
  refusedWith('G2 direct table edit as authenticated', `UPDATE public.blend_ticket_products SET rate_per_acre_unit = 'fl oz' WHERE blend_ticket_id = '${T_G2}' AND rate_per_acre_unit = 'lb/ac';`,
    'CHEM_UNIT_FORM_MISMATCH');
  clean('G2 unrelated edit', `UPDATE public.blend_ticket_products SET quantity = quantity + 1 WHERE blend_ticket_id = '${T_G2}';`, { asOwner: true });
  approve(T_G2);
  clean('G2 dry oz/lb ticket invoices', invoice(T_G2), { commit: true });
  const g2Billed = billed(T_G2);
  assert.ok(g2Billed && !/null/.test(g2Billed), `G2: dry oz/lb lines did not bill: ${g2Billed}`);
  const T_G2L = 'a16a1600-0000-4000-8000-00000000f203';
  clean('G2 liquid fl oz/ac ticket', ticketLines(T_G2L, [["'fl oz/ac'", LIQUID, "'fl oz'"]]), { commit: true });
  approve(T_G2L);
  clean('G2 liquid invoice', invoice(T_G2L), { commit: true });
  assert.equal(billed(T_G2L), '1.5625', 'G2: 200 fl oz of a liquid bills as 1.5625 Gal');
  console.log(`[prover] G2: dry blend lines in fl oz (rate, quantity unit, edits, a move, a direct table edit) are refused; dry oz/lb save and bill (${g2Billed}); a liquid fl oz line bills ${billed(T_G2L)} Gal`);

  // G3 (owner session: every definer RPC writes job_chemicals as the owner)
  refusedWith('G3 dry unit fl oz', jobLine(job, DRY, "'fl oz'", "'oz/ac'", 41), 'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  refusedWith('G3 dry rate_unit fluid ounce/ac', jobLine(job, DRY, "'oz'", "'fluid ounce/ac'", 42), 'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  clean('G3 dry oz', jobLine(job, DRY, "'oz'", "'oz/ac'", 43), { asOwner: true, commit: true });
  clean('G3 liquid fl oz', jobLine(job, LIQUID, "'fl oz'", "'fl oz/ac'", 44), { asOwner: true, commit: true });
  refusedWith('G3 edit the dry oz line to FL OZ', `UPDATE public.job_chemicals SET unit = 'FL OZ' WHERE job_id = '${job}' AND sort_order = 43;`, 'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  refusedWith('G3 move the liquid fl oz line to the dry product', `UPDATE public.job_chemicals SET product_id = '${DRY}' WHERE job_id = '${job}' AND sort_order = 44;`,
    'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  clean('G3 unrelated edit', `UPDATE public.job_chemicals SET sort_order = 46 WHERE job_id = '${job}' AND sort_order = 44;`, { asOwner: true });
  console.log('[prover] G3: direct job_chemicals writes with fl oz on a dry product are refused (insert, edit, move); oz on dry and fl oz on liquid save; an unrelated edit saves');

  // G4
  refusedWith('G4 dry rate unit to fl oz', `UPDATE public.products SET rate_unit = 'fl oz' WHERE id = '${DRY}';`, 'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  // A saved form cannot change (guard_product_setup_fields), and with a form now required no product can turn dry.
  refusedWith('G4 liquid to dry is locked', `UPDATE public.products SET product_form = 'dry' WHERE id = '${LIQ3}';`, "can't change on a saved product", { asOwner: true });
  refusedWith('G4 clearing a saved form', `UPDATE public.products SET product_form = NULL WHERE id = '${LIQ3}';`, "can't change on a saved product|needs a product form", { asOwner: true });
  // Every product needs a form: a direct insert and the spreadsheet import (apply_product_setup) are refused.
  refusedWith('G4 new product with no form', `INSERT INTO public.products (id, product_name, unit_size, inventory_unit, rate_unit, product_form)
    VALUES ('a16a1600-0000-4000-8000-0000000000b6', '[PROVER] KI16 No Form', 'Gal', 'Gal', 'oz', NULL);`, 'needs a product form', { asOwner: true });
  refusedWith('G4 import a product with a blank form', `SELECT public.apply_product_setup(jsonb_build_array(jsonb_build_object('insert',
      jsonb_build_object('product_name', '[PROVER] KI16 Import No Form', 'product_form', ' ', 'unit_size', 'Gal', 'inventory_unit', 'Gal'))),
    '${ADMIN}', 'prover-ki16-import-noform');`, 'needs a product form');
  clean('G4 import a product with a form', `SELECT public.apply_product_setup(jsonb_build_array(jsonb_build_object('insert',
      jsonb_build_object('product_name', '[PROVER] KI16 Import Liquid', 'product_form', 'liquid', 'unit_size', 'Gal', 'inventory_unit', 'Gal'))),
    '${ADMIN}', 'prover-ki16-import-liquid');`);
  assert.equal(scalar(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'product_form';`), 'NO');
  // The stock side of a dry product (an earlier unit trigger may refuse first; either way it is refused).
  const g4Size = refusedWith('G4 dry unit size to fl oz', `UPDATE public.products SET unit_size = 'fl oz' WHERE id = '${DRY}';`, 'ERROR', { asOwner: true });
  const g4Stock = refusedWith('G4 dry stock unit to fl oz', `UPDATE public.products SET inventory_unit = 'fl oz' WHERE id = '${DRY}';`, 'ERROR', { asOwner: true });
  console.log(`[prover] G4: dry unit size fl oz refused (${g4Size.replace(/^.*ERROR:\s*/, '').slice(0, 50)}...); dry stock unit fl oz refused (${g4Stock.replace(/^.*ERROR:\s*/, '').slice(0, 50)}...)`);

  // A package size that leads with a number (Luna round 1).
  refusedWith('G4 new dry product sized 32 fl oz', `INSERT INTO public.products (id, product_name, unit_size, inventory_unit, rate_unit, product_form)
    VALUES ('a16a1600-0000-4000-8000-0000000000b8', '[PROVER] KI16 Dry Sized', '32 fl oz', 'Lb', 'lb', 'dry');`, 'CHEM_UNIT_FORM_MISMATCH', { asOwner: true });
  console.log('[prover] G4: a dry product cannot take a fl oz rate unit; every product needs a form (direct insert, import, clearing it: refused) and a saved form cannot change, so no product can turn dry under a fl oz line');

  // G5
  for (const [expr, want] of [["'fl oz'", 't'], ["'FLOZ/acre'", 't'], ["'fl. oz. per acre'", 't'], ["'fluid ounces'", 't'], ["'fl' || chr(8208) || 'oz'", 't'],
    ["'fl' || chr(8203) || 'oz/ac'", 't'], ["'32 fl oz'", 't'], ["'2.5 FLOZ/ac'", 't'], ["'32 oz'", 'f'], ["'32'", 'f'], ["'oz'", 'f'], ["'Dry oz'", 'f'], ["'lb/ac'", 'f'], ["'flour oz'", 'f'], ['NULL', 'f'], ["''", 'f']]) {
    assert.equal(scalar(`SELECT public.unit_names_fluid_ounce(${expr});`), want, `G5: unit_names_fluid_ounce(${expr})`);
  }
  console.log('[prover] G5: unit_names_fluid_ounce matches every fluid-ounce spelling and no dry unit');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
