#!/usr/bin/env node
/**
 * Real-schema proof for 20270204140000_quote_restore_keeps_planning_picks.sql (bookings Phase A
 * follow-up, PR #1980): rewinding a booking to an earlier version keeps each section's timing and
 * confidence.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (harness copied from
 * prove-inventory-edge-cases-1942-real-schema.mjs),
 * then, with rolled-back probes through the real RPCs (save_quote as the admin; create_quote_version and
 * restore_quote_version under SET ROLE authenticated as that active admin):
 *   1. BEFORE: a booking with picks on three sections is versioned, edited (picks changed, one section
 *      removed) and rewound: every section comes back with timing and confidence blank (the bug).
 *   2. The candidate applies; a second apply is refused by its preflight.
 *   3. AFTER: the same chain keeps each current section's picks (matched on position AND name); the
 *      section only the version has comes back unset; after a removal that renumbers sections, or a
 *      rename, the moved or renamed sections come back unset (no picks land on another section); a drawn booking is still refused QUOTE_RESTORE_BLOCKED_BY_DRAW with nothing
 *      changed; owner, SECURITY DEFINER, search_path, EXECUTE grants and the single overload are
 *      unchanged; the existing restore chain smoke-quote-version-restore-trust.sql ends as before.
 *
 * Run: npm run proof:quote-restore-keeps-planning-picks   (needs Docker)
 * Prints QUOTE_RESTORE_KEEPS_PLANNING_PICKS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a disposable container this run creates (no reuse of another container or database: Sol r1).
const NAME = `crx-qrpp-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270204140000_quote_restore_keeps_planning_picks.sql');
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
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate changes or relies on.
const TOUCHED = /(_restore_quote_version_owner_impl|quote_sections_(timing|confidence)|PLANNING_PICKS_KEPT)/i;
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
    GRANT ALL ON storage.objects, storage.buckets TO postgres;
    -- Row security on, as live has it: 20261217100000 (the current job completion body) checks it (Sol r1).
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`, { user: 'supabase_admin' });
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


const ADMIN = 'a7200000-0000-4000-8000-0000000000b1';
const SIG = 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)';
const REGRESSION = ['smoke-quote-version-restore-trust.sql'];

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'qrpp-admin@example.invalid', '{"full_name":"[PROVER] Restore Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};`);
}

// The default edit after the send: North and South picks change, West is removed.
const EDIT_DEFAULT = [
  { from: 'North', name: 'North', sort: 0, timing: 'in_season', confidence: 'likely', items: true },
  { from: 'South', name: 'South', sort: 1, timing: 'late_summer', confidence: 'firm' },
];
// One rolled-back chain through the real RPCs. Sends a booking with picks on North (sort 0),
// South (1) and West (2), versions it, then saves the edit (each entry: the sent section it keeps,
// by name, with its new name, position and picks; sections not listed are removed) and rewinds to
// that version. With drawn = true a stamped order line is added before the rewind.
// Returns {section: "timing/confidence"} of the rewound booking, or {refused, unchanged}.
function chain({ drawn = false, edit = EDIT_DEFAULT } = {}) {
  const editSections = edit.map((s) => `jsonb_build_object('id', (SELECT id FROM quote_sections WHERE quote_id = v_q AND section_name = '${s.from}'),
        'client_key', '_${s.from}', 'section_name', '${s.name}', 'sort_order', ${s.sort},
        'timing', '${s.timing}', 'confidence', '${s.confidence}', 'items', ${s.items ? 'jsonb_build_array(v_line)' : "'[]'::jsonb"})`).join(',\n      ');
  const editCheck = edit.map((s) => `'${s.name}', '${s.timing}/${s.confidence}'`).join(', ');
  const sql = `DO $chain$
DECLARE
  v_admin uuid := '${ADMIN}';
  v_customer uuid; v_product uuid; v_price jsonb; v_line jsonb; v_payload jsonb; v_res jsonb;
  v_q uuid; v_rv bigint; v_ver uuid; v_order uuid; v_before jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  INSERT INTO customers (farm_name) VALUES ('[PROVER] Restore Picks Farm') RETURNING id INTO v_customer;
  INSERT INTO products (product_name, unit_size, inventory_unit, product_form)
  VALUES ('[PROVER] Restore Picks Product', 'Gal', 'Gal', 'liquid') RETURNING id INTO v_product;
  v_price := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', (SELECT pricing_version FROM products WHERE id = v_product),
      'pricing_mode', 'margin_driven', 'new_cost', '6.00',
      'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
      'change_reason', 'Restore picks prover fixture')),
    v_admin, 'qrpp-price-preview');
  PERFORM apply_product_pricing_change_set((v_price->>'change_set_id')::uuid, v_price->>'request_fingerprint',
    v_admin, 'qrpp-price-apply');
  v_line := jsonb_build_object('client_key', '_k1', 'product_id', v_product, 'sort_order', 0,
    'calc_mode', 'units_direct', 'total_units_needed', 10, 'price_override', 20, 'price_per_unit', 20,
    'current_cost', 6, 'unit_size', 'Gal', 'acres', 0);
  v_payload := jsonb_build_object('quote_number', '[PROVER] QRPP', 'customer_id', v_customer,
    'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true);
  v_res := save_quote(NULL, v_payload, jsonb_build_array(
    jsonb_build_object('client_key', '_n', 'section_name', 'North', 'sort_order', 0,
      'timing', 'pre_plant', 'confidence', 'firm', 'items', jsonb_build_array(v_line)),
    jsonb_build_object('client_key', '_s', 'section_name', 'South', 'sort_order', 1,
      'timing', 'in_season', 'confidence', 'likely', 'items', '[]'::jsonb),
    jsonb_build_object('client_key', '_w', 'section_name', 'West', 'sort_order', 2,
      'timing', 'late_summer', 'confidence', 'maybe', 'items', '[]'::jsonb)),
    v_admin, 'qrpp-save-1');
  v_q := (v_res->>'quote_id')::uuid;

  -- Send (version) through the real RPC as the signed-in admin.
  v_rv := (SELECT row_version FROM quotes WHERE id = v_q);
  SET LOCAL ROLE authenticated;
  v_res := create_quote_version(v_q, v_admin, 'presented', 'qrpp-version-1', v_rv);
  RESET ROLE;
  v_ver := (v_res->>'version_id')::uuid;
  IF v_ver IS NULL THEN RAISE EXCEPTION 'PROVER_SETUP: no version: %', v_res; END IF;

  -- Edit after the send.
  v_rv := (SELECT row_version FROM quotes WHERE id = v_q);
  v_res := save_quote(v_q, v_payload || jsonb_build_object('row_version_expected', v_rv,
      'status', (SELECT status FROM quotes WHERE id = v_q)),
    jsonb_build_array(
      ${editSections}),
    v_admin, 'qrpp-save-2');
  IF (SELECT jsonb_object_agg(section_name, timing || '/' || confidence) FROM quote_sections WHERE quote_id = v_q)
     IS DISTINCT FROM jsonb_build_object(${editCheck}) THEN
    RAISE EXCEPTION 'PROVER_SETUP: the edit did not land: %', v_res;
  END IF;

  IF ${drawn} THEN
    -- A stamped order line from this booking (what a draw-down leaves), written with triggers off.
    SET LOCAL session_replication_role = replica;
    INSERT INTO orders (order_number, customer_id) VALUES ('[PROVER] QRPP-DRAW', v_customer) RETURNING id INTO v_order;
    INSERT INTO order_items (order_id, product_id, quote_item_id)
    SELECT v_order, qi.product_id, qi.id FROM quote_items qi WHERE qi.quote_id = v_q LIMIT 1;
    SET LOCAL session_replication_role = origin;
  END IF;

  v_before := (SELECT jsonb_agg(to_jsonb(qs) ORDER BY qs.sort_order) FROM quote_sections qs WHERE qs.quote_id = v_q);
  v_rv := (SELECT row_version FROM quotes WHERE id = v_q);
  BEGIN
    SET LOCAL ROLE authenticated;
    v_res := restore_quote_version(v_q, v_ver, v_admin, 'qrpp-restore-1', v_rv, NULL::text);
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM set_config('crx.result', jsonb_build_object('refused', SQLERRM,
      'unchanged', v_before IS NOT DISTINCT FROM
        (SELECT jsonb_agg(to_jsonb(qs) ORDER BY qs.sort_order) FROM quote_sections qs WHERE qs.quote_id = v_q))::text, true);
    RETURN;
  END;
  IF v_res->>'status' IS DISTINCT FROM 'restored' THEN RAISE EXCEPTION 'PROVER_FAIL: restore said %', v_res; END IF;
  PERFORM set_config('crx.result', (SELECT jsonb_object_agg(section_name,
      COALESCE(timing, '-') || '/' || COALESCE(confidence, '-')) FROM quote_sections WHERE quote_id = v_q)::text, true);
END;
$chain$;
SELECT current_setting('crx.result');`;
  // supabase_admin: the drawn fixture needs session_replication_role; the RPCs still run as authenticated.
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t'],
    { allowFailure: true, input: `BEGIN;\n${sql}\nROLLBACK;\n` });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
}

const security = () => scalar(`SELECT jsonb_build_object(
    'overloads', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_restore_quote_version_owner_impl'),
    'owner', p.proowner::regrole::text, 'secdef', p.prosecdef, 'config', p.proconfig,
    'execs', ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                     FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1),
    'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
    'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
    'oid', p.oid)
  FROM pg_proc p WHERE p.oid = '${SIG}'::regprocedure;`);
const bodyMd5 = () => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${SIG}'::regprocedure;`);

function chainOutcome(file) {
  stageText(file, lf(path.join(ROOT, 'scripts', 'smoke', file)));
  const r = apply(file);
  const line = r.output.split(/\r?\n/).find((l) => /ERROR:/.test(l)) ?? `(no error, status ${r.status})`;
  return line.replace(/^.*?ERROR:\s*/, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>').replace(/\b[0-9a-f]{8}\b/g, '<sfx>');
}

async function main() {
  buildContainer();
  seed();

  // 1. BEFORE
  const candidate = lf(CANDIDATE);
  const oldMd5 = /'([0-9a-f]{32})' THEN\s+RAISE EXCEPTION 'PREFLIGHT_RESTORE_DRIFT/.exec(candidate)?.[1];
  assert.ok(oldMd5, 'the candidate no longer pins the prior body md5');
  assert.equal(bodyMd5(), oldMd5, 'the replayed restore body is not the one the candidate pins');
  const secBefore = security();
  const before = chain();
  console.log(`[before] rewind: ${JSON.stringify(before)}`);
  assert.deepEqual(before, { North: '-/-', South: '-/-', West: '-/-' }, 'BEFORE: the rewind should blank every pick (the bug)');
  const drawnBefore = chain({ drawn: true });
  assert.match(drawnBefore.refused ?? '', /QUOTE_RESTORE_BLOCKED_BY_DRAW/, JSON.stringify(drawnBefore));
  const regressionBefore = Object.fromEntries(REGRESSION.map((f) => [f, chainOutcome(f)]));
  for (const [f, o] of Object.entries(regressionBefore)) console.log(`[before] ${f}: ${o.slice(0, 160)}`);
  console.log('[case] BEFORE: a rewind blanks timing and confidence on every section; a drawn booking is refused');

  // 2. Apply, then a second apply is refused.
  stageText('candidate.sql', candidate);
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /POSTFLIGHT_OK rewind keeps planning picks/);
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /PREFLIGHT_ALREADY_APPLIED/);
  console.log('[case] the candidate applies (postflight OK); a second apply stops at PREFLIGHT_ALREADY_APPLIED');

  // 3. AFTER
  const after = chain();
  console.log(`[after] rewind: ${JSON.stringify(after)}`);
  assert.deepEqual(after, { North: 'in_season/likely', South: 'late_summer/firm', West: '-/-' },
    'AFTER: current picks kept per position and name; the version-only section restores unset');
  console.log('[case] AFTER: each section keeps its current picks; the section only the version has comes back unset');
  // Removing North renumbers South and West (QuoteBuilder removeSection): no restored section
  // matches a current one on both position and name, so none takes picks.
  const removedFirst = chain({ edit: [
    { from: 'South', name: 'South', sort: 0, timing: 'in_season', confidence: 'firm', items: true },
    { from: 'West', name: 'West', sort: 1, timing: 'late_summer', confidence: 'maybe' },
  ] });
  console.log(`[after] rewind after removing North: ${JSON.stringify(removedFirst)}`);
  assert.deepEqual(removedFirst, { North: '-/-', South: '-/-', West: '-/-' },
    'AFTER: picks must not move onto another section when a removal renumbers sections');
  // Removing South: North keeps position and name (kept); West moved from 2 to 1 (unset).
  const removedMiddle = chain({ edit: [
    { from: 'North', name: 'North', sort: 0, timing: 'in_season', confidence: 'likely', items: true },
    { from: 'West', name: 'West', sort: 1, timing: 'pre_plant', confidence: 'firm' },
  ] });
  console.log(`[after] rewind after removing South: ${JSON.stringify(removedMiddle)}`);
  assert.deepEqual(removedMiddle, { North: 'in_season/likely', South: '-/-', West: '-/-' });
  // Renaming North at the same position: no longer the same section, so it restores unset.
  const renamed = chain({ edit: [
    { from: 'North', name: 'North Field', sort: 0, timing: 'in_season', confidence: 'likely', items: true },
    { from: 'South', name: 'South', sort: 1, timing: 'late_summer', confidence: 'firm' },
  ] });
  console.log(`[after] rewind after renaming North: ${JSON.stringify(renamed)}`);
  assert.deepEqual(renamed, { North: '-/-', South: 'late_summer/firm', West: '-/-' });
  console.log('[case] AFTER: picks follow position AND name: a removal that renumbers, or a rename, restores unset');
  const drawnAfter = chain({ drawn: true });
  assert.match(drawnAfter.refused ?? '', /QUOTE_RESTORE_BLOCKED_BY_DRAW/, JSON.stringify(drawnAfter));
  assert.equal(drawnAfter.unchanged, true, 'a refused rewind must change nothing');
  console.log('[case] AFTER: a drawn booking is still refused QUOTE_RESTORE_BLOCKED_BY_DRAW and nothing changes');
  const secAfter = security();
  assert.equal(secAfter, secBefore, 'owner, mode, search_path, grants or OID changed');
  const sec = JSON.parse(secAfter);
  assert.deepEqual([sec.overloads, sec.owner, sec.secdef, sec.config, sec.execs, sec.anon, sec.authenticated],
    [1, 'postgres', true, ['search_path=public, pg_temp'], ['postgres', 'service_role'], false, false]);
  console.log(`[case] AFTER: security unchanged: ${secAfter}`);
  for (const f of REGRESSION) assert.equal(chainOutcome(f), regressionBefore[f], `${f} ends differently after the candidate`);
  console.log(`[case] AFTER: ${REGRESSION.length} existing restore chain(s) end exactly as before`);
  console.log('QUOTE_RESTORE_KEEPS_PLANNING_PICKS_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
