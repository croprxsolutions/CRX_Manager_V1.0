#!/usr/bin/env node
/**
 * Real-schema proof for 20270103100000_setup_workbook_chemistry_tabs (DM-1b; build sheet
 * docs/plans/2026-11-10-product-DM1b-BUILD-SHEET.md section 5).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, seeds invented parents and sizes, applies the
 * candidate (and a second run, which refuses), then checks each "Done when" case through the real RPCs as a
 * signed-in admin, a signed-in sales rep and anon.
 *
 * Run: node scripts/smoke/prove-setup-workbook-chemistry-tabs-real-schema.mjs   (needs Docker)
 * Prints SETUP_WORKBOOK_CHEMISTRY_TABS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-dm1b-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270103100000_setup_workbook_chemistry_tabs.sql');
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
const TOUCHED = /(product_parent|_weight_unit_factors|_save_parent_density_draft|_save_size_net_weight_draft|_write_parent_density|_write_size_net_weight|_lock_parent_chemistry|_apply_parent_chemistry|_chemistry_strength|_chemistry_uuid|chemistry_change_proposals|setup_workbook)/i;
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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
const id = (n) => `d1b00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = id('a1'), REP = id('a2');
const HALEX = id('b01'), PEPA = id('b02');
const LIQ = Array.from({ length: 20 }, (_, i) => id(`c${String(i + 1).padStart(2, '0')}`));
const BAGS = Array.from({ length: 5 }, (_, i) => id(`d${i + 1}`));
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);

function txIn(uid, sql) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  return `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n`;
}
function as(uid, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: txIn(uid, sql) });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
const js = (uid, sql) => JSON.parse(ok(uid, sql));
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}\n${r.output}`);
  assert.match(r.output, pattern);
  return r.output;
}
const n = (sql) => Number(scalar(sql));

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'dm1b-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'dm1b-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  const parent = (pid, name, epa = null) => `('${pid}', '[PROVER] ${name}', 'liquid', 'SL', 'Herbicide', ${q(epa)}, true, '${ADMIN}', '${ADMIN}')`;
  const bag = (pid, i) => `('${pid}', '[PROVER] Bag ${i}', 'DM1B-BAG-${i}', 'dry', 'Ea', 'Herbicide', 10.00, 15.00, true)`;
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.product_parents (id, name, product_form, formulation_type, category, generic_epa_registration, is_active, created_by, updated_by) VALUES
      ${parent(HALEX, 'Halex GT')}, ${parent(PEPA, 'Registered', '100-44')},
      ${LIQ.map((p, i) => parent(p, `Liquid ${i + 1}`)).join(', ')};
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, current_cost, tier1_price, is_active) VALUES
      ${BAGS.map((p, i) => bag(p, i + 1)).join(', ')};`);
  assert.equal(scalar(`SELECT public._weight_unit_factors()->'factors'->'ea'->>'kind';`), 'count', 'Ea must be a count unit here, as on live');
  console.log('[prover] seeded: Halex GT (no EPA number), a parent with EPA number 100-44, 20 liquid parents, 5 dry bags in Ea');
}

const halexRows = (note = 'Halex GT label, page 1') => [
  { name: 'S-metolachlor', cas: '87392-12-9', strength_value: 29.4, strength_unit: 'pct_ww', strength_basis: 'active_ingredient' },
  { name: 'Glyphosate', cas: '1071-83-6', strength_value: 21.9, strength_unit: 'pct_ww', strength_basis: 'active_ingredient' },
  { name: 'Mesotrione', cas: '104206-82-8', strength_value: 2.94, strength_unit: 'pct_ww', strength_basis: 'active_ingredient' },
].map((r) => ({ parent_id: HALEX, expected_chemistry_version: 0, row_id: null, ...r, source: 'label', source_note: note }));
const chemVer = (pid) => n(`SELECT COALESCE((SELECT chemistry_version FROM public.product_parent_chemistry_state WHERE parent_id = '${pid}'), 0);`);
const activeRows = (pid) => n(`SELECT count(*) FROM public.product_parent_ingredients WHERE parent_id = '${pid}' AND status = 'active';`);
const proposals = () => n('SELECT count(*) FROM public.chemistry_change_proposals;');
const halexDownload = () => js(ADMIN, 'SELECT public.get_setup_workbook_chemistry();').parents.find((p) => p.parent_id === HALEX);
// A downloaded ingredient row turned back into an upload row (the screen does the same).
const upRow = (p, r, extra = {}) => ({ parent_id: p.parent_id, expected_chemistry_version: p.chemistry_version, row_id: r.row_id,
  name: r.name, cas: r.cas, strength_value: r.strength_value === null ? null : Number(r.strength_value),
  strength_unit: r.strength_unit, strength_basis: r.strength_basis, source: r.source, source_note: r.source_note, ...extra });
let promoteSeq = 0;
const promote = (pid, ver, decision, key = `dm1b-p-auto-${++promoteSeq}`) => `SELECT public.promote_chemistry_proposal('${pid}', ${ver}, '${decision}', ${q(key)});`;

function weightsCases() {
  const dl = js(ADMIN, 'SELECT public.get_setup_workbook_chemistry();');
  assert.equal(dl.densities.length, 22, 'every active liquid parent is on the Weights tab');
  assert.deepEqual(dl.net_weights.map((r) => r.product_id).sort(), [...BAGS].sort(), 'every dry size stocked in Ea is on the Weights tab');
  const rows = [
    ...LIQ.map((p, i) => ({ kind: 'density', subject_id: p, expected_version: 0, value: 8 + i / 10, unit: 'lb_per_gal', source: 'sds', source_note: `SDS section 9, liquid ${i + 1}` })),
    ...BAGS.map((p, i) => ({ kind: 'net_weight', subject_id: p, expected_version: 0, value: 40 + i, source: 'label', source_note: `bag label ${i + 1}` })),
  ];
  // Preview: every row is a change, nothing is written.
  const prev = js(ADMIN, `SELECT public.preview_weights_tab(${J(rows)});`);
  assert.deepEqual([...new Set(prev.rows.map((r) => r.status))], ['change'], JSON.stringify(prev.rows.filter((r) => r.status !== 'change')));
  assert.ok(prev.rows.every((r) => !('request' in r)), 'the preview does not leak the internal request');
  assert.equal(n('SELECT count(*) FROM public.product_parent_density_values;') + n('SELECT count(*) FROM public.product_size_net_weight_values;'), 0, 'a preview writes nothing');
  console.log('[case] W1 the download lists 22 liquid parents and 5 bags; a 25-row preview shows 25 changes and writes nothing');

  // A missing source refuses the whole save by name.
  const bad = rows.map((r, i) => (i === 3 ? { ...r, source: null } : r));
  const badPrev = js(ADMIN, `SELECT public.preview_weights_tab(${J(bad)});`).rows[3];
  assert.equal(badPrev.status, 'invalid'); assert.match(badPrev.problem, /PRODUCT_WEIGHT_BAD_SOURCE/);
  refused(ADMIN, `SELECT public.commit_weights_tab(${J(bad)}, 'dm1b-w-bad');`, /WORKBOOK_WEIGHTS_REFUSED: nothing was saved\. \[PROVER\] Liquid 4: PRODUCT_WEIGHT_BAD_SOURCE/);
  assert.equal(n('SELECT count(*) FROM public.product_parent_density_values;'), 0);
  console.log('[case] W2 a row with no source is refused by name and nothing is saved');

  // Commit: 25 drafts, each with its source; one retry key writes once.
  const rec = js(ADMIN, `SELECT public.commit_weights_tab(${J(rows)}, 'dm1b-w-1');`);
  assert.equal(rec.saved_count, 25);
  assert.equal(n(`SELECT count(*) FROM public.product_parent_density_values WHERE review_state = 'draft' AND source = 'sds' AND source_note LIKE 'SDS section 9%';`), 20);
  assert.equal(n(`SELECT count(*) FROM public.product_size_net_weight_values WHERE review_state = 'draft' AND source = 'label' AND source_note LIKE 'bag label%';`), 5);
  assert.equal(n(`SELECT count(*) FROM public.product_parent_density_values WHERE review_state = 'approved';`) + n(`SELECT count(*) FROM public.product_size_net_weight_values WHERE review_state = 'approved';`), 0, 'drafts only; nothing is approved');
  const events = n('SELECT count(*) FROM public.product_weight_events;');
  assert.deepEqual(js(ADMIN, `SELECT public.commit_weights_tab(${J(rows)}, 'dm1b-w-1');`), rec, 'the retry returns the first receipt');
  assert.equal(n('SELECT count(*) FROM public.product_weight_events;'), events, 'the retry writes nothing');
  refused(ADMIN, `SELECT public.commit_weights_tab(${J(rows.slice(1))}, 'dm1b-w-1');`, /IDEMPOTENCY|fingerprint|different/i);
  console.log('[case] W3 the 25 rows save as drafts with their sources; the same retry key writes once, a different body is refused');

  // The old download is now stale; the fresh one is unchanged.
  const stale = js(ADMIN, `SELECT public.preview_weights_tab(${J(rows)});`).rows;
  assert.ok(stale.every((r) => r.status === 'stale'), 'every row of the old download is stale');
  refused(ADMIN, `SELECT public.commit_weights_tab(${J(rows)}, 'dm1b-w-2');`, /WORKBOOK_WEIGHTS_REFUSED: nothing was saved\. .*changed by someone else/);
  const fresh = rows.map((r) => ({ ...r, expected_version: 1 }));
  assert.ok(js(ADMIN, `SELECT public.preview_weights_tab(${J(fresh)});`).rows.every((r) => r.status === 'unchanged'));
  refused(ADMIN, `SELECT public.commit_weights_tab(${J(fresh)}, 'dm1b-w-3');`, /WORKBOOK_NOTHING_TO_SAVE/);
  // One stale row among good ones refuses the whole save.
  const mixed = fresh.map((r, i) => (i === 0 ? { ...r, value: 9.9 } : i === 1 ? { ...r, value: 9.9, expected_version: 0 } : r));
  refused(ADMIN, `SELECT public.commit_weights_tab(${J(mixed)}, 'dm1b-w-4');`, /\[PROVER\] Liquid 2: changed by someone else/);
  assert.equal(n(`SELECT density_version FROM public.product_parent_density_state WHERE parent_id = '${LIQ[0]}';`), 1, 'the good row was not saved either');
  // Duplicates, a net weight with a unit, a non-number value and an unexpected field are invalid.
  const odd = js(ADMIN, `SELECT public.preview_weights_tab(${J([fresh[0], fresh[0], { ...fresh[20], unit: 'lb' }, { ...fresh[2], value: '9' }, { ...fresh[3], extra: 1 }])});`).rows;
  assert.deepEqual(odd.map((r) => r.status), ['unchanged', 'invalid', 'invalid', 'invalid', 'invalid']);
  // A density row with its unit left blank means lb/gal (the download's unit).
  assert.equal(js(ADMIN, `SELECT public.preview_weights_tab(${J([{ ...fresh[0], unit: undefined }])});`).rows[0].status, 'unchanged');
  // A huge number is one invalid row, not a failed preview.
  const huge = js(ADMIN, `SELECT public.preview_weights_tab('[${JSON.stringify({ ...fresh[0], unit: 'specific_gravity' }).replace('"value":8', '"value":1e131000')}, ${JSON.stringify(fresh[1])}]'::jsonb);`).rows;
  assert.deepEqual(huge.map((r) => r.status), ['invalid', 'unchanged']); assert.match(huge[0].problem, /out of range/);
  console.log('[case] W4 a stale row refuses the whole save; an unchanged upload saves nothing; duplicate and malformed rows are invalid');
}

function ingredientCases() {
  // Halex GT takes three rows; the upload lands as a proposal citing its sources and changes nothing live.
  const dl0 = halexDownload();
  assert.equal(dl0.chemistry_version, 0); assert.deepEqual(dl0.ingredients, []); assert.equal(dl0.epa_refusal, null);
  const prev = js(ADMIN, `SELECT public.preview_ingredients_tab(${J(halexRows())});`).parents;
  assert.equal(prev.length, 1); assert.equal(prev[0].status, 'proposal', JSON.stringify(prev[0]));
  assert.equal(prev[0].items.length, 3); assert.equal(prev[0].has_delete, false);
  assert.equal(n("SELECT count(*) FROM public.active_ingredients WHERE name IN ('S-metolachlor', 'Glyphosate', 'Mesotrione');"), 0, 'the preview creates no ingredient');
  const rec = js(ADMIN, `SELECT public.commit_ingredients_tab(${J(halexRows())}, 'dm1b-i-1');`);
  assert.equal(rec.proposal_count, 1);
  const p1 = rec.proposals[0];
  assert.deepEqual(js(ADMIN, `SELECT public.commit_ingredients_tab(${J(halexRows())}, 'dm1b-i-1');`), rec, 'the retry returns the first receipt');
  assert.equal(proposals(), 1, 'one retry key writes one proposal');
  assert.equal(activeRows(HALEX), 0); assert.equal(chemVer(HALEX), 0, 'nothing live changes at commit');
  assert.equal(n(`SELECT count(*) FROM public.chemistry_change_proposals, jsonb_array_elements(items) i WHERE id = '${p1.proposal_id}' AND i->>'source' = 'label' AND i->>'source_note' = 'Halex GT label, page 1';`), 3, 'each proposed row cites its source');
  console.log("[case] I1 Halex GT's three rows land as one proposal citing the label; nothing live changes; one retry key writes once");

  refused(ADMIN, promote(p1.proposal_id, 1, 'apply_delete'), /CHEMISTRY_PROPOSAL_NO_DELETE/);
  refused(ADMIN, promote(p1.proposal_id, 2, 'apply'), /CHEMISTRY_PROPOSAL_STALE/);
  refused(REP, promote(p1.proposal_id, 1, 'apply'), /ADMIN_REQUIRED/);
  const ap = js(ADMIN, promote(p1.proposal_id, 1, 'apply', 'dm1b-p-1'));
  assert.equal(ap.status, 'applied'); assert.equal(ap.applied_chemistry_version, 1); assert.equal(ap.proposal_version, 2);
  assert.deepEqual(js(ADMIN, promote(p1.proposal_id, 1, 'apply', 'dm1b-p-1')), ap, 'the promote retry returns the first receipt');
  assert.equal(activeRows(HALEX), 3); assert.equal(chemVer(HALEX), 1);
  assert.match(scalar(`SELECT evidence FROM public.product_chemistry_events WHERE parent_id = '${HALEX}' ORDER BY id DESC LIMIT 1;`), /label: Halex GT label, page 1/);
  refused(ADMIN, promote(p1.proposal_id, 2, 'reject'), /CHEMISTRY_PROPOSAL_DECIDED/);
  // A row filled by the EPA lookup comes back unchanged on a whole-tab re-upload, and cannot be edited here.
  const glyRow = halexDownload().ingredients.find((r) => r.name === 'Glyphosate');
  raw(`UPDATE public.product_parent_ingredients SET source = 'epa_lookup' WHERE id = '${glyRow.row_id}';`);
  const dlE = halexDownload();
  const asIs = dlE.ingredients.map((r) => upRow(dlE, r));
  assert.equal(js(ADMIN, `SELECT public.preview_ingredients_tab(${J(asIs)});`).parents[0].status, 'unchanged');
  const editE = asIs.map((r) => (r.row_id === glyRow.row_id ? { ...r, strength_value: 22.5 } : r));
  assert.match(js(ADMIN, `SELECT public.preview_ingredients_tab(${J(editE)});`).parents[0].problem, /Glyphosate was filled from the EPA lookup/);
  raw(`UPDATE public.product_parent_ingredients SET source = 'label' WHERE id = '${glyRow.row_id}';`);
  console.log('[case] I2a an EPA-filled row re-uploads as unchanged and is refused by name if edited');
  console.log('[case] I2 the proposal applies only as "apply" at its own version; Halex GT has 3 rows at version 1 with the label cited; a decided proposal is refused');

  // An absent row changes nothing; an unchanged upload is "unchanged".
  const dl1 = halexDownload();
  assert.equal(dl1.ingredients.length, 3);
  const onlyTwo = dl1.ingredients.slice(0, 2).map((r) => upRow(dl1, r));
  assert.equal(js(ADMIN, `SELECT public.preview_ingredients_tab(${J(onlyTwo)});`).parents[0].status, 'unchanged');
  refused(ADMIN, `SELECT public.commit_ingredients_tab(${J(onlyTwo)}, 'dm1b-i-2');`, /WORKBOOK_NOTHING_TO_SAVE/);
  assert.equal(activeRows(HALEX), 3);
  console.log('[case] I3 a row left off the upload changes nothing');

  // __delete makes a delete proposal that applies only with apply_delete; a change needs its source note.
  const meso = dl1.ingredients.find((r) => r.name === 'Mesotrione');
  const smet = dl1.ingredients.find((r) => r.name === 'S-metolachlor');
  const noNote = [upRow(dl1, smet, { strength_value: 30.1, source_note: null })];
  assert.match(js(ADMIN, `SELECT public.preview_ingredients_tab(${J(noNote)});`).parents[0].problem, /WORKBOOK_SOURCE_REQUIRED/);
  const renamed = [upRow(dl1, smet, { name: 'Metolachlor' })];
  assert.match(js(ADMIN, `SELECT public.preview_ingredients_tab(${J(renamed)});`).parents[0].problem, /cannot be renamed here/);
  const del = [upRow(dl1, meso, { delete: true }), upRow(dl1, smet, { strength_value: 30.1, source_note: 'Halex GT label 2026, page 1' })];
  const dp = js(ADMIN, `SELECT public.commit_ingredients_tab(${J(del)}, 'dm1b-i-3');`).proposals[0];
  assert.equal(dp.has_delete, true); assert.equal(dp.item_count, 2);
  refused(ADMIN, promote(dp.proposal_id, 1, 'apply'), /CHEMISTRY_PROPOSAL_HAS_DELETE/);
  assert.equal(activeRows(HALEX), 3, 'a delete never applies without apply_delete');
  const dap = js(ADMIN, promote(dp.proposal_id, 1, 'apply_delete'));
  assert.equal(dap.applied_chemistry_version, 2);
  assert.equal(activeRows(HALEX), 2);
  assert.equal(scalar(`SELECT status FROM public.product_parent_ingredients WHERE id = '${meso.row_id}';`), 'retired', 'the deleted row is kept, retired, with its history');
  assert.equal(scalar(`SELECT strength_value::text || ' ' || source_note FROM public.product_parent_ingredients WHERE id = '${smet.row_id}';`), '30.1 Halex GT label 2026, page 1');
  console.log('[case] I4 a __delete row makes a delete proposal that applies only with apply_delete; the row is retired, not erased; a change without a source note or a rename is refused');

  // A stale row: the old download (version 1) is refused by name, nothing written.
  const before = proposals();
  const staleUp = [upRow(dl1, smet, { strength_value: 31, source_note: 'old download' })];
  assert.equal(js(ADMIN, `SELECT public.preview_ingredients_tab(${J(staleUp)});`).parents[0].status, 'stale');
  refused(ADMIN, `SELECT public.commit_ingredients_tab(${J(staleUp)}, 'dm1b-i-4');`, /WORKBOOK_INGREDIENTS_REFUSED: nothing was saved\. \[PROVER\] Halex GT: its chemistry changed since you downloaded it/);
  assert.equal(proposals(), before);

  // A stale proposal: two proposals on the same version; promoting one makes the other stale.
  const dl2 = halexDownload();
  const add = (name, ver = dl2.chemistry_version) => ({ parent_id: HALEX, expected_chemistry_version: ver, row_id: null, name, cas: null,
    strength_value: null, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'sds', source_note: `${name} SDS section 3` });
  const pa = js(ADMIN, `SELECT public.commit_ingredients_tab(${J([add('Prover Safener A')])}, 'dm1b-i-5');`).proposals[0];
  const pb = js(ADMIN, `SELECT public.commit_ingredients_tab(${J([add('Prover Safener B')])}, 'dm1b-i-6');`).proposals[0];
  js(ADMIN, promote(pa.proposal_id, 1, 'apply'));
  refused(ADMIN, promote(pb.proposal_id, 1, 'apply'), /CHEMISTRY_STALE/);
  assert.equal(scalar(`SELECT status FROM public.chemistry_change_proposals WHERE id = '${pb.proposal_id}';`), 'proposed', 'a refused promote changes nothing');
  assert.equal(js(ADMIN, promote(pb.proposal_id, 1, 'reject')).status, 'rejected');
  console.log('[case] I5 a stale row is refused by name with nothing saved; a stale proposal is refused, then rejected');

  // A usable EPA number refuses the parent's workbook chemistry by name; with a good parent, the whole upload is refused.
  assert.match(js(ADMIN, 'SELECT public.get_setup_workbook_chemistry();').parents.find((p) => p.parent_id === PEPA).epa_refusal, /100-44/);
  const epaRow = { parent_id: PEPA, expected_chemistry_version: 0, row_id: null, name: 'Atrazine', cas: '1912-24-9', strength_value: 42,
    strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'label', source_note: 'label' };
  const ep = js(ADMIN, `SELECT public.preview_ingredients_tab(${J([epaRow])});`).parents[0];
  assert.equal(ep.status, 'refused'); assert.match(ep.problem, /CHEMISTRY_FROM_EPA_ONLY: .*100-44/);
  const good = add('Prover Safener C', halexDownload().chemistry_version);
  const p0 = proposals();
  refused(ADMIN, `SELECT public.commit_ingredients_tab(${J([good, epaRow])}, 'dm1b-i-7');`, /WORKBOOK_INGREDIENTS_REFUSED: nothing was saved\. \[PROVER\] Registered: CHEMISTRY_FROM_EPA_ONLY/);
  assert.equal(proposals(), p0, 'the good parent was not proposed either');
  assert.equal(activeRows(PEPA), 0);
  console.log('[case] I6 a product with EPA number 100-44 has its workbook chemistry refused by name, and the whole upload with it');
}

function accessCases() {
  const tiny = [{ kind: 'density', subject_id: LIQ[0], expected_version: 1, value: 8, unit: 'lb_per_gal', source: 'sds', source_note: 'x' }];
  const ing = [{ ...halexRows()[0], expected_chemistry_version: chemVer(HALEX) }];
  const anyProposal = scalar('SELECT id FROM public.chemistry_change_proposals LIMIT 1;');
  for (const sql of ['SELECT public.get_setup_workbook_chemistry();', `SELECT public.preview_weights_tab(${J(tiny)});`,
    `SELECT public.commit_weights_tab(${J(tiny)}, 'dm1b-r-1');`, `SELECT public.preview_ingredients_tab(${J(ing)});`,
    `SELECT public.commit_ingredients_tab(${J(ing)}, 'dm1b-r-2');`, promote(anyProposal, 1, 'reject', 'dm1b-r-3')]) {
    refused(REP, sql, /ADMIN_REQUIRED/);
    refused(null, sql, /permission denied for function/);
  }
  assert.equal(ok(REP, 'SELECT count(*) FROM public.chemistry_change_proposals;'), '0', 'a sales rep reads no proposals');
  assert.ok(Number(ok(ADMIN, 'SELECT count(*) FROM public.chemistry_change_proposals;')) > 0, 'an admin reads them');
  refused(ADMIN, "UPDATE public.chemistry_change_proposals SET status = 'applied';", /permission denied for table/);
  refused(ADMIN, `INSERT INTO public.chemistry_change_proposals (parent_id, items, has_delete, base_chemistry_version, created_by) VALUES ('${HALEX}', '[{}]', false, 0, '${ADMIN}');`, /permission denied for table/);
  refused(null, 'SELECT count(*) FROM public.chemistry_change_proposals;', /permission denied for table/);
  for (const fn of ['_workbook_weight_rows(jsonb)', '_workbook_ingredient_rows(jsonb)', '_apply_chemistry_proposal(uuid,text)']) {
    assert.equal(ok(ADMIN, `SELECT has_function_privilege('public.${fn}', 'EXECUTE');`), 'f', `${fn} is private`);
  }
  console.log('[case] A1 a sales rep and anon are refused by every function; reps read no proposals; nobody writes the table directly; the helpers are private');
}

async function main() {
  buildContainer();
  seed();
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /PREFLIGHT_DM1B_ALREADY_EXISTS/);
  console.log('[case] M1 the candidate applies (its postflight checks every grant) and a second run refuses');
  weightsCases();
  ingredientCases();
  accessCases();
  console.log('SETUP_WORKBOOK_CHEMISTRY_TABS_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
