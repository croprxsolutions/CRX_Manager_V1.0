#!/usr/bin/env node
/**
 * Real-schema proof for the units batch (KI-136, KI-158, KI-140, KI-137; contract
 * docs/plans/2026-11-15-product-master-steps-1-3-CONTRACT.md, PR A):
 *   20270121100000_ki137_powder_keg_each_piksi_mg_labels.sql (data correction, the candidate)
 *   20270121110000_line_unit_is_stock_unit.sql (the rules, its follow-up)
 *   20270121120000_stock_unit_keeps_history.sql (no stock-unit change under history in the old unit; Sol HIGH)
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, seeds live's pinned rows (same ids, units and
 * quantities as live 2026-11-15) plus invented controls, then checks every proof case. Probes run in
 * transactions that are rolled back, as postgres with triggers on (a direct table write) or as the signed-in
 * admin through the real RPCs.
 *
 * Run: node scripts/smoke/prove-units-batch-real-schema.mjs   (needs Docker)
 * Prints UNITS_BATCH_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
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
const NAME = REUSE || `crx-units-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270121100000_ki137_powder_keg_each_piksi_mg_labels.sql');
const RULES = path.join(MIGRATIONS, '20270121110000_line_unit_is_stock_unit.sql');
const HISTORY = path.join(MIGRATIONS, '20270121120000_stock_unit_keeps_history.sql');
const FOLLOW_UPS = [RULES, HISTORY];
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
// A later or parked file that (re)defines anything the candidate or its follow-up creates or relies on.
const TOUCHED = /(_fill_order_line_unit|product_price_per_acre|_unit_matches_stock_unit|_enforce_line_stock_unit|_refuse_unknown_quote_rate_unit|receive_po_items)/i;
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

const CORN = '0b2e713b-4962-4c49-ae3a-6074ddac1464';
const SOY = '17ccc5ba-7e98-49bf-9510-4d57c0eda962';
const PIKSI = '36732b8d-b4ed-4643-8a13-d793975d13c7';
const TREATY = 'ac926057-cfae-4070-9cb6-ff2ecc421c3c';
const id = (s) => `a7000000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), CUST = id('c1'), GAL = id('d1'), GAL_INV = id('d2');
const PO11 = id('b11');
const O1 = id('e1'), O2 = id('e2'), O3 = id('e3'), D1 = id('f1'), D2 = id('f2'), PO1 = id('b1'), PO2 = id('b2');
const GAL_PO_LINE = id('b21'), BLANK_PO_LINE = id('b22'), GAL_OI = id('e21'), QUOTE = id('91'), SECTION = id('92');
const PINNED = {
  inv: { corn: 'a1396a1c-7cbf-48f7-b98d-83e36ad7de25', soy: 'd847d5c1-0676-4e7e-addf-3e1640e216db', piksi: '40224943-7238-4504-ae72-1dbc0ad0bdf6',
         treaty: '687b3d54-1f4e-4ae1-9a5f-afa0542e94c2' },
  oi: { corn: '41ce7cfe-ad47-4fe3-9ace-9b694338ec34', soy: 'b24ffb13-7925-4c03-8ffd-bdcbb00ad0ca', p1: '69766da1-a9bf-4fc6-90c0-f9ced47556bc',
        p2: 'c12acb4c-45ec-424e-bb13-9566ea3c73f9', p3: 'c8fd3a29-e44b-4ba5-9318-b574845d69a4' },
  di: 'd33b3ba5-8c72-49e5-81a1-6a60a5507c93',
  poi: { piksiOpen: '59a5c466-7e4a-46d8-a65c-55cd8397d52c', piksiDone: '74b7f457-b4ef-462a-a3a2-0a125a98392f',
         soy1: '789870fe-bca9-4bbc-a1e3-3dc12502f378', soy2: 'e9b444b9-aef3-44fc-b0ba-0ddc83599f7d', corn: 'eff71606-65c0-499d-aa57-450ee85a1a3c',
         treaty: '46142f54-0e4d-4259-b749-f24e4101b062' },
};

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'units-admin@example.invalid', '{"full_name":"[PROVER] Units Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.product_rate_lock (id, is_locked) VALUES (true, false) ON CONFLICT (id) DO UPDATE SET is_locked = false;
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Units Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, suggested_rate, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${CORN}', 'Powder Keg - Corn', 'U-CORN', 'dry', 'Lb', 'Lb', 'Lb', 'Ea', NULL, NULL, 100, 125, 125, 125, 3, true),
      ('${SOY}', 'Powder Keg - Soybeans', 'U-SOY', 'dry', 'Lb', 'Lb', 'Lb', 'Ea', NULL, NULL, 200.5, 250, 250, 250, 3, true),
      ('${PIKSI}', 'Piksi Dust Plus - 1800G Jar', 'U-PIKSI', 'dry', 'MG', 'MG', 'MG', 'MG', 18, '18 grams per Acre', 0.1, 0.2, 0.2, 0.2, 1, true),
      ('${GAL}', '[PROVER] Gallon Herbicide', 'U-GAL', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, NULL, 24, 30, 30, 30, 1, true),
      ('${TREATY}', 'Treaty Extra', 'U-TREATY', 'dry', 'Dry oz', 'Dry oz', 'Dry oz', 'Dry oz', NULL, NULL, 5.87, 7, 7, 7, 1, true);
    INSERT INTO public.product_parents (id, name, product_form, rate_unit, created_by, updated_by) VALUES
      ('8a1f87bf-9732-4046-b464-8bb5e0ee97b9', 'Powder Keg - Corn', 'dry', 'Lb', '${ADMIN}', '${ADMIN}'),
      ('7a565acf-19e8-416e-9373-817ca065ae8a', 'Powder Keg - Soybeans', 'dry', 'Lb', '${ADMIN}', '${ADMIN}'),
      ('afdae5f9-3410-4f17-975b-07a1650089ae', 'Piksi Dust Plus', 'dry', 'MG', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by) VALUES
      ('${CORN}', '8a1f87bf-9732-4046-b464-8bb5e0ee97b9', 'package', '${ADMIN}'),
      ('${SOY}', '7a565acf-19e8-416e-9373-817ca065ae8a', 'package', '${ADMIN}'),
      ('${PIKSI}', 'afdae5f9-3410-4f17-975b-07a1650089ae', 'package', '${ADMIN}');
    INSERT INTO public.product_cost_basis (id, product_id, basis_type, cost_cents, selection_source, reason) VALUES
      ('bef8f574-e1a5-495a-a6a6-cf0218850f89', '${CORN}', 'manual_override', 10000, 'migration_baseline', 'Phase 2 baseline copied from the existing governed Product cost.'),
      ('41414dad-1ec7-4191-a80c-95806c5a5c50', '${SOY}', 'manual_override', 20050, 'migration_baseline', 'Phase 2 baseline copied from the existing governed Product cost.'),
      ('0522b9ea-401e-41df-bce8-23822c286d4e', '${PIKSI}', 'manual_override', 40, 'migration_baseline', 'Phase 2 baseline copied from the existing governed Product cost.');
    INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order) VALUES
      ('${PINNED.inv.corn}', '${CORN}', 'Main Warehouse', 'Lb', 0, 1, 1),
      ('${PINNED.inv.soy}', '${SOY}', 'Main Warehouse', 'Lb', 0, 0, 0),
      ('${PINNED.inv.piksi}', '${PIKSI}', 'Main Warehouse', 'Dry oz', 58500, 27000, 9000),
      ('${GAL_INV}', '${GAL}', 'Main Warehouse', 'Gal', 100, 0, 13),
      ('${PINNED.inv.treaty}', '${TREATY}', 'Main Warehouse', 'oz', 0, 0, 0);
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES
      ('${O1}', 'U-O1', '${CUST}', 'partially_fulfilled'), ('${O2}', 'U-O2', '${CUST}', 'confirmed'),
      ('${O3}', 'U-O3', '${CUST}', 'partially_fulfilled');
    INSERT INTO public.order_items (id, order_id, product_id, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit) VALUES
      ('${PINNED.oi.corn}', '${O1}', '${CORN}', 'Lb', 2, 1, 1, 125),
      ('${PINNED.oi.soy}', '${O1}', '${SOY}', 'Lb', 2, 2, 0, 250),
      ('${PINNED.oi.p1}', '${O3}', '${PIKSI}', 'Dry oz', 10800, 10800, 0, 0.2),
      ('${PINNED.oi.p2}', '${O2}', '${PIKSI}', 'Dry oz', 27000, 0, 27000, 0.2),
      ('${PINNED.oi.p3}', '${O3}', '${PIKSI}', 'Dry oz', 21600, 21600, 0, 0.2),
      ('${GAL_OI}', '${O2}', '${GAL}', 'Gal', 5, 0, 5, 30);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status) VALUES
      ('${D1}', 'U-D1', '${O2}', '${CUST}', '${ADMIN}', 'in_progress'),
      ('${D2}', 'U-D2', '${O2}', '${CUST}', '${ADMIN}', 'scheduled');
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size) VALUES
      ('${PINNED.di}', '${D1}', '${PINNED.oi.p2}', '${PIKSI}', 27000, 'Dry oz');
    INSERT INTO public.purchase_orders (id, po_number, created_by, status) VALUES
      ('${PO1}', 'U-PO1', '${ADMIN}', 'partially_received'), ('${PO2}', 'U-PO2', '${ADMIN}', 'submitted'),
      ('${PO11}', 'PO-2026-0011', '${ADMIN}', 'fully_received');
    INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, unit_size, quantity_ordered, quantity_received, unit_cost) VALUES
      ('${PINNED.poi.piksiOpen}', '${PO1}', '${PIKSI}', 'Dry oz', 9000, 0, 0.1),
      ('${PINNED.poi.piksiDone}', '${PO1}', '${PIKSI}', 'MG', 45000, 45000, 0.1),
      ('${PINNED.poi.soy1}', '${PO1}', '${SOY}', 'EA', 1, 1, 200.5),
      ('${PINNED.poi.soy2}', '${PO1}', '${SOY}', 'EA', 1, 1, 200.5),
      ('${PINNED.poi.corn}', '${PO1}', '${CORN}', 'EA', 2, 1, 100),
      ('${GAL_PO_LINE}', '${PO2}', '${GAL}', 'Gal', 10, 0, 24),
      ('${BLANK_PO_LINE}', '${PO2}', '${GAL}', NULL, 3, 0, 24),
      ('${PINNED.poi.treaty}', '${PO11}', '${TREATY}', 'oz', 800, 800, 5.87);
    INSERT INTO public.quotes (id, quote_number, customer_id, status, created_by) VALUES ('${QUOTE}', 'U-Q1', '${CUST}', 'draft', '${ADMIN}');
    INSERT INTO public.quote_sections (id, quote_id, section_name) VALUES ('${SECTION}', '${QUOTE}', 'Field');`);
  console.log('[prover] seeded live\'s pinned Powder Keg and Piksi rows (ids, units, quantities as live 2026-11-15) and a Gal control');
}

// Everything the data correction must not touch, and the rows it must.
const snapshot = () => scalar(`SELECT md5(concat_ws('#',
  (SELECT string_agg(concat_ws('|', id, rate_per_acre, tier1_price, tier2_price, tier3_price, current_cost), ',' ORDER BY id) FROM public.products),
  (SELECT string_agg(concat_ws('|', id, quantity_available, quantity_prebooked, quantity_on_order), ',' ORDER BY id) FROM public.inventory),
  (SELECT string_agg(concat_ws('|', id, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit), ',' ORDER BY id) FROM public.order_items),
  (SELECT string_agg(concat_ws('|', id, quantity), ',' ORDER BY id) FROM public.delivery_items),
  (SELECT string_agg(concat_ws('|', id, quantity_ordered, quantity_received, unit_cost), ',' ORDER BY id) FROM public.purchase_order_items)));`);
const labels = () => scalar(`SELECT concat_ws(' ',
  (SELECT string_agg(left(id::text, 4) || '=' || inventory_unit || '/' || unit_size || '/' || rate_unit, ',' ORDER BY id) FROM public.products),
  (SELECT string_agg(left(id::text, 4) || '=' || unit_size, ',' ORDER BY id) FROM public.inventory),
  (SELECT string_agg(left(id::text, 4) || '=' || unit_size, ',' ORDER BY id) FROM public.order_items),
  (SELECT string_agg(left(id::text, 4) || '=' || unit_size, ',' ORDER BY id) FROM public.delivery_items),
  (SELECT string_agg(left(id::text, 4) || '=' || unit_size, ',' ORDER BY id) FROM public.purchase_order_items));`);
const stockState = () => scalar(`SELECT concat_ws('|',
  (SELECT quantity_available || '/' || quantity_on_order FROM public.inventory WHERE id = '${PINNED.inv.piksi}'),
  (SELECT count(*) FROM public.receiving_records), (SELECT count(*) FROM public.inventory_transactions),
  (SELECT quantity_received FROM public.purchase_order_items WHERE id = '${PINNED.poi.piksiOpen}'));`);
const receive = (line, qty, key) => `SELECT public.receive_po_items(${J([{ po_item_id: line, quantity: qty }])}, '${ADMIN}', '${key}');`;

function beforeCases() {
  // The bug (KI-136): receiving the "Dry oz" line on the MG product adds the typed number to MG stock.
  const after = okProbe(`${receive(PINNED.poi.piksiOpen, 9000, 'units-before-1')}\nSELECT quantity_available FROM public.inventory WHERE id = '${PINNED.inv.piksi}';`, ADMIN);
  assert.equal(Number(after), 67500);
  assert.equal(Number(okProbe(`SELECT public.product_price_per_acre(30, 16, 'oz', 'Widget', NULL);`)), 480, 'today an unknown stock unit prices as 1 oz');
  assert.equal(Number(okProbe(`SELECT public.product_price_per_acre(30, 16, 'bogus', 'Gal', 'Gal');`)), 3.75, 'today an unknown rate unit prices as 1 oz');
  console.log('[case] B1 before: a "Dry oz" PO line on an MG product receives 9,000 into MG stock; an unknown stock unit prices as 1 oz ($480/acre for $3.75 of product)');
}

let labelsBefore, fnBefore;
function dataCases() {
  const before = snapshot();
  labelsBefore = labels();
  fnBefore = scalar("SELECT md5(prosrc) FROM pg_proc WHERE proname = 'product_price_per_acre';");
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.equal(snapshot(), before, 'no quantity, price or cost changed');
  assert.equal(scalar(`SELECT string_agg(pricing_version::text, ',' ORDER BY id) FROM public.products;`), '4,4,1,1,1', 'the rate-unit change bumps Powder Keg pricing versions 3 -> 4 (stale workbooks refuse), nothing else');
  const l = labels();
  assert.notEqual(l, labelsBefore);
  assert.equal(scalar(`SELECT string_agg(inventory_unit || unit_size || rate_unit, ',' ORDER BY id) FROM public.products WHERE id IN ('${CORN}', '${SOY}');`), 'EaEaEa,EaEaEa');
  assert.equal(scalar(`SELECT inventory_unit || unit_size || rate_unit FROM public.products WHERE id = '${PIKSI}';`), 'MGMGMG');
  assert.equal(scalar(`SELECT string_agg(rate_unit || parent_version, ',' ORDER BY id) FROM public.product_parents;`), 'Ea2,Ea2,MG1', 'family rate units: Powder Keg Ea (version +1), Piksi unchanged');
  assert.equal(scalar(`SELECT string_agg(unit_size, ',' ORDER BY id) FROM public.inventory WHERE product_id IN ('${CORN}', '${SOY}', '${PIKSI}');`).split(',').sort().join(','), 'Ea,Ea,MG');
  assert.equal(scalar(`SELECT string_agg(DISTINCT unit_size, ',') FROM public.order_items WHERE product_id IN ('${CORN}', '${SOY}');`), 'Ea');
  assert.equal(scalar(`SELECT string_agg(DISTINCT unit_size, ',') FROM public.order_items WHERE product_id = '${PIKSI}';`), 'MG');
  assert.equal(scalar(`SELECT unit_size FROM public.delivery_items WHERE id = '${PINNED.di}';`), 'MG');
  assert.equal(scalar(`SELECT unit_size FROM public.purchase_order_items WHERE id = '${PINNED.poi.piksiOpen}';`), 'MG');
  assert.equal(scalar(`SELECT string_agg(unit_size, ',' ORDER BY id) FROM public.purchase_order_items WHERE product_id IN ('${CORN}', '${SOY}');`), 'EA,EA,EA', 'Powder Keg PO lines already say EA');
  // Cost basis: the old open row closed by the unit change, one new open row at the same cents.
  assert.equal(scalar(`SELECT string_agg(cost_cents || ':' || (effective_to IS NULL) || ':' || selection_source, ',' ORDER BY product_id, effective_to NULLS LAST)
      FROM public.product_cost_basis WHERE product_id IN ('${CORN}', '${SOY}');`), '10000:false:migration_baseline,10000:true:migration_baseline,20050:false:migration_baseline,20050:true:migration_baseline'
    .split(',').join(','));
  assert.equal(n(`SELECT count(*) FROM public.product_cost_basis WHERE product_id = '${PIKSI}' AND effective_to IS NULL;`), 1, "Piksi's basis is untouched");
  // Treaty Extra: its received PO-2026-0011 line and stock row now say Dry oz; cost, review flag and quantities unchanged.
  assert.equal(scalar(`SELECT x.unit_size || '/' || x.unit_cost || '/' || x.cost_needs_review || '/' || x.quantity_received || ' ' || i.unit_size
      FROM public.purchase_order_items x, public.inventory i WHERE x.id = '${PINNED.poi.treaty}' AND i.id = '${PINNED.inv.treaty}';`), 'Dry oz/5.87/false/800 Dry oz');
  assert.equal(scalar(`SELECT string_agg(tgenabled::text, '' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.purchase_order_items'::regclass
      AND tgname IN ('trigger_0_guard_closed_po_item', 'trigger_capture_purchase_order_item_cost_snapshot');`), 'OO', 'the two PO line guards are back on');
  // The two product guards are back on.
  assert.equal(scalar(`SELECT string_agg(tgenabled::text, '' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
      AND tgname IN ('trg_validate_product_setup_fields', 'trigger_zz_guard_product_parent_values');`), 'OO');
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /KI137_ROW_MOVED/);
  console.log('[case] M1 the data correction relabels exactly the pinned rows (Powder Keg Lb -> Ea, Piksi "Dry oz" -> MG), changes no quantity, price or cost, reopens one cost basis per Powder Keg product at the same cents, relabels the received Treaty Extra "oz" PO line and stock row to Dry oz (cost and quantities unchanged, both PO guards back on), and a second run refuses');
}

function driftCase() {
  // On drift it refuses and changes nothing: run it on a copy where one pinned line moved.
  const r = probe(`UPDATE public.order_items SET total_units_needed = 3 WHERE id = '${PINNED.oi.corn}';\n${lf(CANDIDATE)}`);
  assert.notEqual(r.status, 0); assert.match(r.output, /KI137_ROW_MOVED/);
  const t = probe(`UPDATE public.inventory SET unit_size = 'Dry oz' WHERE id = '${PINNED.inv.treaty}';\n${lf(CANDIDATE)}`);
  assert.notEqual(t.status, 0); assert.match(t.output, /PO_OZ_ROW_MOVED/);
  const c = probe(`INSERT INTO public.cycle_counts (count_number, status, initiated_by) VALUES ('CC-PROVER', 'in_progress', '${ADMIN}');\n${lf(CANDIDATE)}`);
  assert.notEqual(c.status, 0); assert.match(c.output, /KI137_COUNT_IN_PROGRESS/);
  console.log('[case] M1b on any pinned-row drift the data correction refuses with KI137_ROW_MOVED (checked before applying); with a cycle count in progress it refuses with KI137_COUNT_IN_PROGRESS');
}

function rulesCases() {
  stageText('rules.sql', lf(RULES));
  // A legacy stock row in another unit stops the rules (Sol, #1896): its quantity-only receipts would not be checked.
  const legacyRow = probe(`INSERT INTO public.inventory (product_id, location, unit_size, quantity_available) VALUES ('${GAL}', 'Prover Legacy', 'Qt', 5);\n${lf(RULES)}`);
  assert.notEqual(legacyRow.status, 0); assert.match(legacyRow.output, /UNITS_POSTFLIGHT_OPEN_LINE: .*stock row/);
  const first = apply('rules.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('rules.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /PREFLIGHT_UNITS_DRIFT/);
  assert.equal(n("SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_fill_order_line_unit';"), 0);
  assert.equal(scalar(`SELECT unit_size FROM public.purchase_order_items WHERE id = '${BLANK_PO_LINE}';`), 'Gal', 'the open blank-unit PO line now says Gal');
  assert.equal(n("SELECT count(*) FROM pg_trigger WHERE tgname IN ('a1_line_unit_is_stock_unit', 'a1_product_unit_keeps_open_lines');"), 4);
  for (const fn of ['_unit_matches_stock_unit(text,text)', '_enforce_line_stock_unit()', '_refuse_unknown_quote_rate_unit()', '_refuse_stock_unit_change_with_open_lines()',
                    '_stock_row_unit_is_stock_unit()', '_relabel_empty_stock_rows()']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.${fn}', 'EXECUTE');`), 'f', `${role} cannot run ${fn}`);
    }
  }
  console.log('[case] M2 the rules apply (postflight: no open line in another unit), a second run refuses, the old fill trigger is gone, the one open blank-unit PO line now says Gal, the helpers are private');

  // Fill: a new line with no unit takes the stock unit.
  const fill = okProbe(`
    INSERT INTO public.order_items (id, order_id, product_id, unit_size, total_units_needed, quantity_remaining, price_per_unit)
      VALUES ('${id('e31')}', '${O2}', '${CORN}', '', 1, 1, 125);
    INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, unit_size, quantity_ordered, unit_cost)
      VALUES ('${id('b31')}', '${PO2}', '${GAL}', NULL, 1, 24);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${id('f31')}', '${D2}', '${GAL_OI}', '${GAL}', 1, ' ');
    SELECT (SELECT unit_size FROM public.order_items WHERE id = '${id('e31')}') || ',' || (SELECT unit_size FROM public.purchase_order_items WHERE id = '${id('b31')}')
      || ',' || (SELECT unit_size FROM public.delivery_items WHERE id = '${id('f31')}');`);
  assert.equal(fill, 'Ea,Gal,Gal');
  console.log('[case] 1 a new order, PO or delivery line with no unit is stored in the stock unit (Corn -> Ea, Gal product -> Gal)');

  // Refuse: a unit that is not the stock unit, on each table; spelling and alias variants pass.
  refusedProbe(`INSERT INTO public.order_items (order_id, product_id, unit_size, total_units_needed, quantity_remaining, price_per_unit)
      VALUES ('${O2}', '${GAL}', 'Gallon', 1, 1, 30);`, /LINE_UNIT_NOT_STOCK_UNIT: this order line is in "Gallon" but the product is stocked in "Gal"/);
  refusedProbe(`INSERT INTO public.purchase_order_items (purchase_order_id, product_id, unit_size, quantity_ordered, unit_cost)
      VALUES ('${PO2}', '${PIKSI}', 'Dry oz', 9000, 0.1);`, /LINE_UNIT_NOT_STOCK_UNIT: this purchase order line is in "Dry oz" but the product is stocked in "MG"/);
  refusedProbe(`INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${D2}', '${GAL_OI}', '${GAL}', 1, 'Qt');`, /LINE_UNIT_NOT_STOCK_UNIT: this delivery line/);
  refusedProbe(`UPDATE public.order_items SET unit_size = 'Lb' WHERE id = '${PINNED.oi.corn}';`, /LINE_UNIT_NOT_STOCK_UNIT/);
  assert.equal(okProbe(`
    INSERT INTO public.purchase_order_items (purchase_order_id, product_id, unit_size, quantity_ordered, unit_cost) VALUES
      ('${PO2}', '${GAL}', 'gal', 1, 24), ('${PO2}', '${GAL}', ' GAL ', 1, 24), ('${PO2}', '${CORN}', 'Unit', 1, 100), ('${PO2}', '${CORN}', 'EA', 1, 100);
    SELECT string_agg(unit_size, ',' ORDER BY unit_size) FROM public.purchase_order_items WHERE purchase_order_id = '${PO2}';`), 'Ea,Ea,Gal,Gal,Gal,Gal');
  console.log('[case] 2 "Gallon" on a Gal product, "Dry oz" on an MG product, "Qt" on a Gal delivery and Lb on a now-Ea order line are refused; "gal", " GAL ", "Unit" and "EA" pass and are stored as the product\'s own spelling (Gal, Ea)');

  // The product side. Today the setup guard refuses any stock-unit change on a saved product; the new rule is the
  // layer under it, for a reviewed change that lifts that guard (as a migration does).
  refusedProbe(`DELETE FROM public.purchase_order_items WHERE id IN ('${GAL_PO_LINE}', '${BLANK_PO_LINE}');
    DELETE FROM public.order_items WHERE id = '${GAL_OI}';
    UPDATE public.inventory SET quantity_available = 0, quantity_on_order = 0 WHERE id = '${GAL_INV}';
    UPDATE public.products SET inventory_unit = 'Qt', unit_size = 'Qt' WHERE id = '${GAL}';`, /can't change on a saved product yet/);
  const LIFT = 'ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_setup_fields;';
  refusedProbe(`${LIFT} UPDATE public.products SET inventory_unit = 'Qt', unit_size = 'Qt' WHERE id = '${GAL}';`,
    /PRODUCT_UNIT_HAS_OPEN_LINES: this product's stock unit cannot change to "Qt" while these are open in another unit: .*(PO U-PO2|order U-O2)/);
  refusedProbe(`${LIFT} UPDATE public.products SET inventory_unit = NULL, unit_size = NULL WHERE id = '${GAL}';`,
    /PRODUCT_UNIT_HAS_OPEN_LINES: this product's stock unit cannot change to "" while/);
  refusedProbe(`${LIFT} DELETE FROM public.purchase_order_items WHERE id IN ('${GAL_PO_LINE}', '${BLANK_PO_LINE}');
    DELETE FROM public.order_items WHERE id = '${GAL_OI}';
    UPDATE public.products SET inventory_unit = 'Qt', unit_size = 'Qt' WHERE id = '${GAL}';`,
    /PRODUCT_UNIT_HAS_STOCK: this product's stock unit cannot change to "Qt" while it has stock counted in "Gal"/);
  // On-order counts as stock too (Mason 2026-11-16, option A). Deleting the PO lines recomputes on-order to 0, so the
  // probe puts 13 back as an on-order count with no line behind it.
  refusedProbe(`${LIFT} DELETE FROM public.purchase_order_items WHERE id IN ('${GAL_PO_LINE}', '${BLANK_PO_LINE}');
    DELETE FROM public.order_items WHERE id = '${GAL_OI}';
    UPDATE public.inventory SET quantity_available = 0, quantity_on_order = 13 WHERE id = '${GAL_INV}';
    UPDATE public.products SET inventory_unit = 'Qt', unit_size = 'Qt' WHERE id = '${GAL}';`,
    /PRODUCT_UNIT_HAS_STOCK: this product's stock unit cannot change to "Qt" while it has stock counted in "Gal"/);
  // Once every count is zero the change saves and the empty stock row is relabelled to the new unit.
  assert.equal(okProbe(`${LIFT} DELETE FROM public.purchase_order_items WHERE id IN ('${GAL_PO_LINE}', '${BLANK_PO_LINE}');
    DELETE FROM public.order_items WHERE id = '${GAL_OI}';
    UPDATE public.inventory SET quantity_available = 0, quantity_on_order = 0 WHERE id = '${GAL_INV}';
    UPDATE public.products SET inventory_unit = 'Qt', unit_size = 'Qt' WHERE id = '${GAL}';
    SELECT p.inventory_unit || '/' || i.unit_size FROM public.products p, public.inventory i WHERE p.id = '${GAL}' AND i.id = '${GAL_INV}';`), 'Qt/Qt');
  // A new stock row must be in the product's stock unit (it locks the product first, so it cannot race a unit change).
  refusedProbe(`INSERT INTO public.inventory (product_id, location, unit_size, quantity_available) VALUES ('${GAL}', 'Prover Yard', 'Qt', 5);`,
    /STOCK_ROW_UNIT_NOT_STOCK_UNIT: this stock row is in "Qt" but the product is stocked in "Gal"/);
  assert.equal(okProbe(`INSERT INTO public.inventory (product_id, location, unit_size, quantity_available) VALUES ('${GAL}', 'Prover Yard', 'gal', 5);
    SELECT count(*) FROM public.inventory WHERE product_id = '${GAL}';`), '2');
  assert.equal(okProbe(`INSERT INTO public.inventory (product_id, location, unit_size, quantity_available) VALUES ('${GAL}', 'Prover Yard 2', NULL, 5);
    SELECT unit_size FROM public.inventory WHERE product_id = '${GAL}' AND location = 'Prover Yard 2';`), 'Gal');
  // A stock row holding stock cannot change its unit or product (Luna round 4); an empty one can.
  refusedProbe(`UPDATE public.inventory SET unit_size = 'Qt' WHERE id = '${GAL_INV}';`,
    /STOCK_ROW_UNIT_NOT_STOCK_UNIT: this stock row is in "Qt" but the product is stocked in "Gal"/);
  refusedProbe(`UPDATE public.inventory SET product_id = '${CORN}' WHERE id = '${GAL_INV}';`,
    /STOCK_ROW_UNIT_NOT_STOCK_UNIT: a stock row holding stock cannot move to another product/);
  refusedProbe(`UPDATE public.inventory SET quantity_available = 0, quantity_on_order = 0 WHERE id = '${GAL_INV}';
    UPDATE public.inventory SET unit_size = 'Qt' WHERE id = '${GAL_INV}';`,
    /STOCK_ROW_UNIT_NOT_STOCK_UNIT: this stock row is in "Qt" but the product is stocked in "Gal"/);
  assert.equal(okProbe(`UPDATE public.inventory SET unit_size = 'gal' WHERE id = '${GAL_INV}';
    SELECT unit_size FROM public.inventory WHERE id = '${GAL_INV}';`), 'gal');
  // A product with no stock unit but stock on hand cannot be given one (its count was in no known unit).
  refusedProbe(`SET session_replication_role = replica;
    UPDATE public.products SET inventory_unit = NULL, unit_size = NULL WHERE id = '${GAL}';
    SET session_replication_role = origin;
    ${LIFT} DELETE FROM public.purchase_order_items WHERE id IN ('${GAL_PO_LINE}', '${BLANK_PO_LINE}');
    DELETE FROM public.order_items WHERE id = '${GAL_OI}';
    UPDATE public.products SET inventory_unit = 'Gal', unit_size = 'Gal' WHERE id = '${GAL}';`,
    /PRODUCT_UNIT_HAS_STOCK: this product's stock unit cannot change to "Gal" while it has stock counted in "\(no unit\)"/);
  refusedProbe(`${LIFT} DELETE FROM public.purchase_order_items WHERE id IN ('${GAL_PO_LINE}', '${BLANK_PO_LINE}');
    DELETE FROM public.order_items WHERE id = '${GAL_OI}';
    UPDATE public.products SET inventory_unit = 'Tote', unit_size = 'Tote' WHERE id = '${GAL}';`, /PRODUCT_STOCK_UNIT_UNKNOWN: "Tote" is not a known unit/);
  // Clearing the stock unit is refused even with no lines and no stock (Luna round 4).
  refusedProbe(`${LIFT} DELETE FROM public.purchase_order_items WHERE id IN ('${GAL_PO_LINE}', '${BLANK_PO_LINE}');
    DELETE FROM public.order_items WHERE id = '${GAL_OI}';
    UPDATE public.inventory SET quantity_available = 0, quantity_on_order = 0 WHERE id = '${GAL_INV}';
    UPDATE public.products SET inventory_unit = NULL, unit_size = NULL WHERE id = '${GAL}';`,
    /PRODUCT_STOCK_UNIT_UNKNOWN: a stock unit cannot be cleared/);
  // A product with no stock unit (none live) takes a blank line but refuses a typed unit.
  refusedProbe(`SET session_replication_role = replica;
    UPDATE public.products SET inventory_unit = NULL, unit_size = NULL WHERE id = '${GAL}';
    SET session_replication_role = origin;
    INSERT INTO public.purchase_order_items (purchase_order_id, product_id, unit_size, quantity_ordered, unit_cost)
      VALUES ('${PO2}', '${GAL}', 'Gal', 1, 1);`, /LINE_UNIT_NOT_STOCK_UNIT: this purchase order line is in "Gal" but the product has no stock unit/);
  refusedProbe(`SET session_replication_role = replica;
    UPDATE public.products SET inventory_unit = NULL, unit_size = NULL WHERE id = '${GAL}';
    SET session_replication_role = origin;
    INSERT INTO public.inventory (product_id, location, unit_size, quantity_available) VALUES ('${GAL}', 'Prover Yard 3', 'Gal', 5);`,
    /STOCK_ROW_UNIT_NOT_STOCK_UNIT: this stock row is in "Gal" but the product is stocked in/);
  console.log('[case] 2b the setup guard still refuses any stock-unit change; with it lifted, changing a Gal product to Qt is refused while a PO or order line is open in Gal or 100 Gal is in stock or 13 Gal on order, and saves (relabelling the empty stock row) once none is; a new stock row in another unit is refused; blanking the unit with lines open is refused too; an unknown stock unit ("Tote") is refused; a product with no stock unit refuses a typed line unit');

  // A legacy mismatched open line (written before the rules) is refused at receiving; nothing moves.
  const LEGACY = id('b41');
  raw(`INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, unit_size, quantity_ordered, quantity_received, unit_cost)
      VALUES ('${LEGACY}', '${PO2}', '${PIKSI}', 'Dry oz', 500, 0, 0.1);`);
  const before = stockState();
  refusedProbe(receive(LEGACY, 500, 'units-legacy-1'), /LINE_UNIT_NOT_STOCK_UNIT: this purchase order line is in "Dry oz"/, ADMIN);
  assert.equal(stockState(), before, 'stock, on-order, receiving records and history are unchanged');
  // Editing it without touching unit or product still works (history keeps saving).
  assert.equal(okProbe(`UPDATE public.purchase_order_items SET notes = 'legacy note' WHERE id = '${LEGACY}'; SELECT notes FROM public.purchase_order_items WHERE id = '${LEGACY}';`), 'legacy note');
  raw(`DELETE FROM public.purchase_order_items WHERE id = '${LEGACY}';`);
  // The relabelled Piksi line receives 9,000 as 9,000 MG.
  const got = okProbe(`${receive(PINNED.poi.piksiOpen, 9000, 'units-after-1')}
    SELECT (SELECT quantity_available || '/' || quantity_on_order FROM public.inventory WHERE id = '${PINNED.inv.piksi}')
      || ' ' || (SELECT unit_size FROM public.receiving_records ORDER BY received_at DESC NULLS LAST LIMIT 1);`, ADMIN);
  assert.equal(got, '67500/0 MG');
  const LEG2 = id('b43'), SAME = id('b44');
  raw(`INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, unit_size, quantity_ordered, quantity_received, unit_cost) VALUES
      ('${LEG2}', '${PO1}', '${PIKSI}', 'Dry oz', 500, 500, 0.1), ('${SAME}', '${PO1}', '${GAL}', 'Gal', 2, 2, 24);`);
  refusedProbe(`UPDATE public.purchase_order_items SET quantity_received = 400 WHERE id = '${LEG2}';`, /LINE_UNIT_NOT_STOCK_UNIT: this purchase order line is in "Dry oz"/);
  refusedProbe(`UPDATE public.purchase_order_items SET quantity_ordered = 600 WHERE id = '${LEG2}';`, /LINE_UNIT_NOT_STOCK_UNIT: this purchase order line is in "Dry oz"/);
  assert.equal(okProbe(`UPDATE public.purchase_order_items SET quantity_received = 1 WHERE id = '${SAME}'; SELECT quantity_received FROM public.purchase_order_items WHERE id = '${SAME}';`), '1');
  raw(`DELETE FROM public.purchase_order_items WHERE id IN ('${LEG2}', '${SAME}');`);
  console.log('[case] 3c reopening a received legacy "Dry oz" line on the MG product (a receipt undone or more ordered) is refused; a received Gal line reopens');
  console.log('[case] 3 receiving a legacy "Dry oz" line on the MG product is refused and nothing moves; a legacy line still saves a note; the relabelled line receives 9,000 MG (stock 58,500 -> 67,500, on order 9,000 -> 0)');

  // A part-received line in another spelling receives the rest without its unit being rewritten (the cost-snapshot
  // trigger would read a rewrite as tampering).
  const PART = id('b42');
  raw(`INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, unit_size, quantity_ordered, quantity_received, unit_cost)
      VALUES ('${PART}', '${PO2}', '${GAL}', 'gal', 2, 1, 24);`);
  assert.equal(okProbe(`${receive(PART, 1, 'units-part-1')}
    SELECT unit_size || '/' || quantity_received FROM public.purchase_order_items WHERE id = '${PART}';`, ADMIN), 'gal/2');
  raw(`DELETE FROM public.purchase_order_items WHERE id = '${PART}';`);
  console.log('[case] 3b a part-received "gal" line on a Gal product receives its last unit and keeps its spelling');

  // Existing mismatched history saves when its unit is not touched (delivery and order lines).
  raw(`INSERT INTO public.order_items (id, order_id, product_id, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit)
      VALUES ('${id('e41')}', '${O1}', '${GAL}', 'Gallon ', 1, 1, 0, 30);`);
  assert.equal(okProbe(`UPDATE public.order_items SET notes = 'x' WHERE id = '${id('e41')}'; SELECT unit_size FROM public.order_items WHERE id = '${id('e41')}';`), 'Gallon');
  console.log('[case] 4 an existing order line in "Gallon " saves an unrelated edit unchanged');

  // On-order matches the open PO lines for every seeded product.
  assert.equal(scalar(`SELECT count(*) FROM public.inventory i WHERE i.quantity_on_order <> COALESCE((SELECT sum(l.quantity_ordered - COALESCE(l.quantity_received, 0))
      FROM public.purchase_order_items l JOIN public.purchase_orders po ON po.id = l.purchase_order_id
     WHERE l.product_id = i.product_id AND po.status IN ('submitted', 'partially_received')), 0);`), '0');
  console.log('[case] 5 on-order equals the open PO remainder on every stock row');
}

async function historyCases() {
  // Sol HIGH on 20270121110000:248: the unit-change guard saw only open lines and stock. In each probe the Gal product
  // is cleared of open lines and stock (as in case 2b) and given closed history in "Gal".
  const LIFT = 'ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_setup_fields;';
  // Every Gal line and receipt from earlier cases is removed (guards off for the clean-up only), and stock zeroed.
  const CLEAR = `${LIFT} SET session_replication_role = replica;
    DELETE FROM public.receiving_records WHERE product_id = '${GAL}'; DELETE FROM public.delivery_items WHERE product_id = '${GAL}';
    DELETE FROM public.order_items WHERE product_id = '${GAL}'; DELETE FROM public.purchase_order_items WHERE product_id = '${GAL}';
    DELETE FROM public.inventory_transactions WHERE product_id = '${GAL}'; DELETE FROM public.inventory_holds WHERE product_id = '${GAL}';
    SET session_replication_role = origin;
    UPDATE public.inventory SET quantity_available = 0, quantity_on_order = 0 WHERE id = '${GAL_INV}';`;
  const TO_QT = `UPDATE public.products SET inventory_unit = 'Qt', unit_size = 'Qt' WHERE id = '${GAL}';`;
  const RET = id('c41'), RET_ITEM = id('c42'), RPO_LINE = id('b51'), DONE_O = id('e51'), DONE_D = id('f51');
  const replica = (sql) => `SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`;
  const RETURN = (status, restocked = false, unit = 'Gal') => replica(`
    INSERT INTO public.returns (id, return_number, customer_id, status, requested_by) VALUES ('${RET}', 'U-R1', '${CUST}', '${status}', '${ADMIN}');
    INSERT INTO public.return_items (id, return_id, product_id, quantity, unit, restock, restocked) VALUES ('${RET_ITEM}', '${RET}', '${GAL}', 2, '${unit}', true, ${restocked});`);
  const RECEIVED_PO = `INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, unit_size, quantity_ordered, quantity_received, unit_cost)
      VALUES ('${RPO_LINE}', '${PO11}', '${GAL}', 'Gal', 4, 4, 24);`;
  const DONE_ORDER = (unit) => replica(`
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES ('${DONE_O}', 'U-O9', '${CUST}', 'fulfilled');
    INSERT INTO public.order_items (order_id, product_id, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit)
      VALUES ('${DONE_O}', '${GAL}', ${unit}, 1, 1, 0, 30);`);
  const DONE_DELIVERY = (unit) => replica(`
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status) VALUES ('${DONE_D}', 'U-D9', '${O1}', '${CUST}', '${ADMIN}', 'completed');
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size) VALUES ('${DONE_D}', '${PINNED.oi.corn}', '${GAL}', 1, ${unit});`);
  const RECEIPT_ONLY = replica(`INSERT INTO public.receiving_records (purchase_order_id, po_item_id, product_id, quantity_received, received_by)
      VALUES ('${PO11}', '${PINNED.poi.corn}', '${GAL}', 1, '${ADMIN}');`);
  const MOVEMENT = replica(`INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, performed_by)
      VALUES ('${GAL}', 'adjusted', -1, '${ADMIN}');`);
  const HOLD = (active) => replica(`INSERT INTO public.inventory_holds (product_id, quantity, created_by, is_active) VALUES ('${GAL}', 1, '${ADMIN}', ${active});`);
  const asAdmin = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);`;
  const receiveReturn = `${asAdmin} SELECT public._receive_return_impl_20260714('${RET}', '${ADMIN}', NULL) IS NOT NULL;`;

  // Before (the HIGH): the change saves, then the approved return cannot be received and the receipt cannot be undone.
  refusedProbe(`${CLEAR} ${RETURN('approved')} ${TO_QT} ${receiveReturn}`, /RETURN_CREDIT_INVENTORY_UNIT_MISMATCH/);
  refusedProbe(`${CLEAR} ${RECEIVED_PO} ${TO_QT}
    UPDATE public.purchase_order_items SET quantity_received = 0 WHERE id = '${RPO_LINE}';`,
  /LINE_UNIT_NOT_STOCK_UNIT: this purchase order line is in "Gal" but the product is stocked in "Qt"/);
  // Control: without the change the same return restocks 2 Gal.
  assert.equal(okProbe(`${CLEAR} ${RETURN('approved')} ${receiveReturn}
    SELECT quantity_available::numeric(10,0) || ' ' || unit_size FROM public.inventory WHERE id = '${GAL_INV}';`), '2 Gal');
  console.log('[case] H0 before: a Gal -> Qt change saves under Gal history, then an approved Gal return cannot be received (RETURN_CREDIT_INVENTORY_UNIT_MISMATCH) and a received Gal PO line cannot be undone (LINE_UNIT_NOT_STOCK_UNIT); with no change the return restocks 2 Gal');

  stageText('history.sql', lf(HISTORY));
  const first = apply('history.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('history.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /PREFLIGHT_UNITS_DRIFT: _refuse_stock_unit_change_with_history already exists/);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const fn of ['_refuse_stock_unit_change_with_history', '_history_row_locks_product']) {
      assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.${fn}()', 'EXECUTE');`), 'f', `${role} cannot run ${fn}`);
    }
  }
  const HIST = 'PRODUCT_UNIT_HAS_HISTORY: this product\'s stock unit cannot change to "Qt" because it already has orders, purchases, deliveries, returns, stock movements or holds \\(.*';
  // Refused for any history, whatever its status or unit (blank too).
  for (const [pre, who] of [[RETURN('requested'), 'return U-R1'], [RETURN('approved'), 'return U-R1'], [RETURN('approved', true), 'return U-R1'],
    [RETURN('received'), 'return U-R1'], [RETURN('approved', false, 'Qt'), 'return U-R1'], [RECEIVED_PO, 'PO PO-2026-0011'],
    [RECEIPT_ONLY, 'PO PO-2026-0011'], [MOVEMENT, 'stock movements or holds'], [HOLD(true), 'stock movements or holds'], [DONE_ORDER("'Gal'"), 'order U-O9'], [DONE_ORDER('NULL'), 'order U-O9'], [DONE_DELIVERY("'Gal'"), 'delivery U-D9'], [DONE_DELIVERY("' '"), 'delivery U-D9']]) {
    refusedProbe(`${CLEAR} ${pre} ${TO_QT}`, new RegExp(`${HIST}${who}`));
  }
  // Allowed: no history at all (the empty stock row is relabelled); a case or outer-space change over history.
  assert.equal(okProbe(`${CLEAR} ${HOLD(false)} ${TO_QT} SELECT p.inventory_unit || '/' || i.unit_size FROM public.products p, public.inventory i
    WHERE p.id = '${GAL}' AND i.id = '${GAL_INV}';`), 'Qt/Qt');
  assert.equal(okProbe(`${CLEAR} ${RECEIVED_PO} ${RETURN('approved')} ${DONE_ORDER("'Gal'")}
    ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_units; UPDATE public.products SET inventory_unit = 'GAL', unit_size = 'GAL' WHERE id = '${GAL}';
    SELECT inventory_unit FROM public.products WHERE id = '${GAL}';`), 'GAL');
  // Open lines still answer first.
  refusedProbe(`${LIFT} ${TO_QT}`, /PRODUCT_UNIT_HAS_OPEN_LINES/);
  // Serialized: while another session holds an uncommitted return line for the product, the unit change waits.
  assert.equal(scalar("SELECT count(*) FROM pg_trigger WHERE tgname = 'a2_history_row_locks_product' AND tgenabled = 'O';"), '2');
  const holdAndChange = async (write) => {
    const holder = spawn('docker', psqlArgs(), { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let held = '';
    holder.stdout.on('data', (d) => { held += d; }); holder.stderr.on('data', (d) => { held += d; });
    const holderDone = new Promise((resolve) => holder.on('close', resolve));
    holder.stdin.end(`BEGIN; ${write} SELECT 'HOLDING'; SELECT pg_sleep(6); ROLLBACK;\n`);
    for (let i = 0; i < 100 && !held.includes('HOLDING'); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.match(held, /HOLDING/, `the row was written with its trigger on:\n${held}`);
    refusedProbe(`SET lock_timeout = '1s'; ${TO_QT}`, /lock timeout/);
    assert.equal(await holderDone, 0, held);
  };
  await holdAndChange(`SET session_replication_role = replica;
    INSERT INTO public.returns (id, return_number, customer_id, status, requested_by) VALUES ('${RET}', 'U-R1', '${CUST}', 'requested', '${ADMIN}');
    SET session_replication_role = origin;
    INSERT INTO public.return_items (id, return_id, product_id, quantity, unit, restock) VALUES ('${RET_ITEM}', '${RET}', '${GAL}', 2, 'Gal', true);`);
  // Holds are created only through create_inventory_hold; re-activating an ended one fires the same lock.
  await holdAndChange(`SET session_replication_role = replica;
    INSERT INTO public.inventory_holds (id, product_id, quantity, created_by, is_active) VALUES ('${id('c43')}', '${GAL}', 1, '${ADMIN}', false);
    SET session_replication_role = origin;
    UPDATE public.inventory_holds SET is_active = true WHERE id = '${id('c43')}';`);
  // Control: with no session holding a line, the same change is not blocked (it meets the open-lines rule instead).
  refusedProbe(`SET lock_timeout = '1s'; ${TO_QT}`, /PRODUCT_UNIT_HAS_OPEN_LINES/);
  console.log('[case] H1 Gal -> Qt is refused (PRODUCT_UNIT_HAS_HISTORY, naming the record) for any history: a requested, approved, restocked, received or Qt return; a received PO line; a receipt alone; a stock movement alone; an active hold; a fulfilled order line in Gal or blank; a completed delivery line in Gal or blank. With no history (an ended hold does not count) it saves and relabels the empty stock row; "GAL" (case only) saves over history; open lines still report PRODUCT_UNIT_HAS_OPEN_LINES first; an uncommitted return line or hold in another session makes the change wait (lock timeout); the functions are private; a second apply refuses');
}

function quoteCases() {
  // product_price_per_acre: unknown unit -> no figure; a known unit gives the same figure as before.
  assert.equal(okProbe(`SELECT coalesce(public.product_price_per_acre(30, 16, 'bogus', 'Gal', 'Gal')::text, 'null');`), 'null');
  assert.equal(okProbe(`SELECT coalesce(public.product_price_per_acre(30, 16, 'oz', 'Widget', NULL)::text, 'null');`), 'null');
  assert.equal(Number(okProbe(`SELECT public.product_price_per_acre(30, 16, 'oz', 'Gal', 'Gal');`)), 3.75);
  assert.equal(Number(okProbe(`SELECT public.product_price_per_acre(0.2, 18, 'MG', 'MG', 'MG');`)), 3.6);
  console.log('[case] 6 per-acre price: an unknown rate or stock unit gives no figure (was $3.75 and $480/acre); 16 oz of a $30/Gal product stays $3.75; 18 MG at $0.20/MG stays $3.6');

  const line = (unit, rate, mode = 'rate_acres') => `INSERT INTO public.quote_items (quote_id, section_id, product_id, calc_mode, actual_rate, rate_unit, acres, price_per_unit, unit_size)
      VALUES ('${QUOTE}', '${SECTION}', '${GAL}', '${mode}', ${rate}, ${unit === null ? 'NULL' : `'${unit}'`}, 100, 30, 'Gal');`;
  refusedProbe(line('bogus', 10), /QUOTE_RATE_UNIT_UNKNOWN: rate unit "bogus"/);
  refusedProbe(line('bogus', -1), /QUOTE_RATE_UNIT_UNKNOWN/);
  refusedProbe(line(null, 10), /QUOTE_RATE_UNIT_UNKNOWN/);
  okProbe(line('bogus', 0));
  okProbe(line('OZ', 10));
  okProbe(line('bogus', 10, 'units_direct'));
  refusedProbe(line('bogus', 10, 'other_mode'), /QUOTE_RATE_UNIT_UNKNOWN/);
  okProbe(line('Ea', 10));
  // A seed/each line with a blank rate unit is filled from the stock unit by the older guard first, then saves.
  // (product guards off for the one setup write only: the container has no seed unit rows to validate against)
  assert.equal(okProbe(`SET session_replication_role = replica;
    UPDATE public.products SET product_form = 'seed', inventory_unit = 'Lb', unit_size = 'Lb' WHERE id = '${GAL}';
    SET session_replication_role = origin;
${line(null, 10).replace(/;$/, ' RETURNING rate_unit;')}`), 'Lb');
  console.log('[case] 7 a quote line (any mode but units-direct) with rate 10 and an unknown or missing rate unit is refused; rate 0, a known unit in any case, a units-direct line, a count unit (Ea), and a blank-unit seed line (filled from its stock unit first) save');
}

function rollbackCases() {
  const DATA_REV = path.join(ROOT, 'scripts', 'smoke', 'ki137-units-data-reverse.sql');
  const RULES_REV = path.join(ROOT, 'scripts', 'smoke', 'units-batch-rules-reverse.sql');
  const HISTORY_REV = path.join(ROOT, 'scripts', 'smoke', 'stock-unit-history-guard-reverse.sql');
  stageText('data-rev.sql', lf(DATA_REV)); stageText('rules-rev.sql', lf(RULES_REV)); stageText('history-rev.sql', lf(HISTORY_REV));
  const early = apply('data-rev.sql');
  assert.notEqual(early.status, 0); assert.match(early.output, /KI137_REVERSE_ORDER/);
  const r0 = apply('history-rev.sql'); assert.equal(r0.status, 0, r0.output);
  assert.equal(n("SELECT count(*) FROM pg_trigger WHERE tgname = 'a2_product_unit_keeps_history';"), 0);
  assert.equal(n("SELECT count(*) FROM pg_trigger WHERE tgname = 'a2_history_row_locks_product';"), 0);
  assert.equal(n("SELECT count(*) FROM pg_proc WHERE proname IN ('_refuse_stock_unit_change_with_history', '_history_row_locks_product');"), 0);
  const r1 = apply('rules-rev.sql'); assert.equal(r1.status, 0, r1.output);
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE proname = 'product_price_per_acre';"), fnBefore, "live's per-acre body is back");
  assert.equal(n("SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_fill_order_line_unit';"), 1);
  assert.equal(n("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'a1\_%unit%' OR tgname = 'trg_h_quote_item_known_units';"), 0);
  // A later write refuses the data reverse (checked on a rolled-back copy).
  const later = probe(`INSERT INTO public.order_items (order_id, product_id, unit_size, total_units_needed, quantity_remaining, price_per_unit)
      VALUES ('${O2}', '${CORN}', 'Ea', 1, 1, 125);
${lf(DATA_REV)}`);
  assert.notEqual(later.status, 0); assert.match(later.output, /KI137_REVERSE_LATER_WRITES/);
  const r2 = apply('data-rev.sql'); assert.equal(r2.status, 0, r2.output);
  // Prover controls only: case 4's own "Gallon " line, and the blank line the rules filled (not un-filled by design).
  assert.equal(scalar(`SELECT unit_size FROM public.purchase_order_items WHERE id = '${BLANK_PO_LINE}';`), 'Gal');
  raw(`DELETE FROM public.order_items WHERE id = '${id('e41')}'; UPDATE public.purchase_order_items SET unit_size = NULL WHERE id = '${BLANK_PO_LINE}';`);
  assert.equal(labels(), labelsBefore, 'every unit label is back');
  assert.equal(n(`SELECT count(*) FROM public.product_cost_basis WHERE product_id IN ('${CORN}', '${SOY}') AND effective_to IS NULL AND cost_cents IN (10000, 20050);`), 2);
  console.log('[case] R rollback: the history reverse drops its triggers and functions; the data reverse refuses before the rules reverse and after any later write; rules reverse restores the live per-acre body and the old fill trigger; data reverse restores every label, one open basis each at the same cents');
}

async function main() {
  if (!REUSE) buildContainer();
  seed();
  beforeCases();
  driftCase();
  dataCases();
  rulesCases();
  await historyCases();
  quoteCases();
  rollbackCases();
  console.log('UNITS_BATCH_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
