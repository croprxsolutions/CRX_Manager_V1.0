#!/usr/bin/env node
/**
 * Real-schema proof for 20270227150000_f06_job_owns_linked_blend_stock.sql (F06 / KI-187; contract
 * docs/plans/2026-11-23-f06-job-blend-stock-once-CONTRACT.md). Mason, 2026-11-23: a job with a linked blend ticket
 * takes the stock through its completion; the ticket never takes it a second time.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container, replays
 * every post-baseline migration before the candidate (harness from the F05 prover), shows the double deduction before
 * the candidate, applies it, then checks every proof case through the real RPCs as a signed-in admin (rolled back),
 * two real two-session races, a mutation check and the rollback script.
 *
 * Run: node scripts/smoke/prove-f06-job-owns-linked-blend-stock-real-schema.mjs   (needs Docker)
 * Prints F06_JOB_OWNS_LINKED_BLEND_STOCK_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a disposable container this run creates (no reuse of another container or database: Sol r1).
const NAME = `crx-f06-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270227150000_f06_job_owns_linked_blend_stock.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'f06-job-owns-linked-blend-stock-reverse.sql');
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
// A later or parked file that (re)defines anything the candidate or its follow-up creates or relies on.
const TOUCHED = /(_f06_application_record_one_deduction|_f06_blend_ticket_link_keeps_stock_once|_f06_job_customer_keeps_linked_tickets|job_customer_keeps_linked_tickets_f06|blend_ticket_link_keeps_stock_once_f06|application_record_one_deduction_f06|FUNCTION public\.(_complete_job_replay_impl_20261015|_create_app_record_from_bt_replay_impl_20261015|reverse_application_record)\(|ON public\.application_records)/i;
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

// A real concurrent session (its own connection), started after delayMs. Resolves with its exit code and output.
function session(sql, delayMs = 0) {
  return new Promise((resolve) => setTimeout(() => {
    const c = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
    c.stdin.end(sql);
  }, delayMs));
}




const id = (s) => `af060000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), CUST = id('c1'), CUST2 = id('c2'), P = id('b1'), INV = id('d1'), FIELD = id('f1');
const JOB = (k) => id(`10${k}`), TICKET = (k) => id(`20${k}`);
const KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'f06-admin@example.invalid', '{"full_name":"[PROVER] F06 Admin","role":"admin"}'::jsonb);`);
  // Fixtures only, triggers off: in-progress jobs with one 10 Gal chemical, approved tickets with one 10 Gal product.
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] F06 Farm', true),
      ('${CUST2}', '[PROVER] F06 Other Farm', true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${FIELD}', '${CUST}', '[PROVER] F06 Field', 10);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${P}', '[PROVER] F06 Chem', 'F06-P', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 1, 8, 10, 10, 10, 1, true);
    INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order) VALUES
      ('${INV}', '${P}', 'Main Warehouse', 'Gal', 500, 0, 0);
    ${KEYS.map((k) => `
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id) VALUES
      ('${JOB(k)}', 'F06-J${k}', '${CUST}', current_date, 'in_progress', '${ADMIN}');
    INSERT INTO public.job_fields (job_id, field_id) VALUES ('${JOB(k)}', '${FIELD}');
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, customer_supplied, sort_order)
      VALUES ('${JOB(k)}', '${P}', 10, 'Gal', 1000, false, 1);
    INSERT INTO public.blend_tickets (id, ticket_number, uploaded_by, status, review_status, customer_id, season, ticket_date, total_acres)
      VALUES ('${TICKET(k)}', 'F06-T${k}', '${ADMIN}', 'completed', 'approved', '${CUST}', 2027, current_date, 10);
    INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, sequence_order, rate_per_acre, rate_per_acre_unit)
      VALUES ('${TICKET(k)}', '${P}', '[PROVER] F06 Chem', 10, 'Gal', 1, 1, 'Gal');
    INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, planned_acres) VALUES ('${TICKET(k)}', '${FIELD}', '${CUST}', 10);`).join('')}
    -- J9 has no chemical lines; J10 is cancelled with T10 linked; J11 belongs to another customer.
    DELETE FROM public.job_chemicals WHERE job_id = '${JOB(9)}';
    UPDATE public.jobs SET status = 'cancelled' WHERE id = '${JOB(10)}';
    UPDATE public.blend_tickets SET job_id = '${JOB(10)}' WHERE id = '${TICKET(10)}';
    UPDATE public.jobs SET customer_id = '${CUST2}' WHERE id = '${JOB(11)}';`);
  console.log(`[prover] seeded ${KEYS.length} in-progress jobs (10 Gal each) and ${KEYS.length} approved tickets (10 Gal each); 500 Gal on hand`);
}

const AS_ADMIN = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);`;
let keyN = 0;
const key = () => `f06-${(keyN += 1)}-${Date.now().toString(36)}`;
const complete = (k) => `SELECT public.complete_job('${JOB(k)}', '{}'::jsonb, '${ADMIN}', '${key()}') IS NOT NULL;`;
const record = (k) => `SELECT public.create_application_record_from_blend_ticket('${TICKET(k)}', '${ADMIN}', '${key()}') IS NOT NULL;`;
const link = (k, job) => `UPDATE public.blend_tickets SET job_id = ${job ? `'${job}'` : 'NULL'} WHERE id = '${TICKET(k)}';`;
const reverse = (k) => `SELECT public.reverse_application_record((SELECT id FROM public.application_records WHERE source_type = 'blend_ticket' AND source_id = '${TICKET(k)}'), '${key()}') IS NOT NULL;`;
const ON_HAND = `SELECT quantity_available::numeric(12,2) FROM public.inventory WHERE id = '${INV}';`;
const LEDGER = `SELECT count(*) || '/' || COALESCE(sum(quantity), 0)::numeric(12,2) FROM public.inventory_transactions WHERE product_id = '${P}';`;
const RECORDS = 'SELECT count(*) FROM public.application_records;';
const signedIn = (sql) => `${AS_ADMIN}\nSET LOCAL ROLE authenticated;\n${sql}`;
const ok = (sql) => okProbe(signedIn(sql));
function refused(sql, pattern, label) {
  const r = probe(signedIn(sql));
  assert.notEqual(r.status, 0, `${label}: expected a refusal:\n${r.output}`);
  assert.match(r.output, pattern, `${label}: wrong refusal:\n${r.output}`);
  return /ERROR:\s*([^\n]*)/.exec(r.output)[1];
}
// setup, then a step that must be refused (caught in a subtransaction): on-hand stock must not move.
function refusedAfter(setup, step, pattern, label) {
  const msg = refused(`${setup}\n${step}`, pattern, label);
  const stmt = step.trim().replace(/^SELECT /, 'PERFORM ').replace(/;$/, '');
  const pair = ok(`${setup}\nCREATE TEMP TABLE f06_s ON COMMIT DROP AS ${ON_HAND.replace(/;$/, '')};
DO $s$ BEGIN BEGIN ${stmt}; EXCEPTION WHEN OTHERS THEN NULL; END; END $s$;
SELECT (SELECT * FROM f06_s) || '=' || (${ON_HAND.replace(/;$/, '')});`);
  const [before, after] = pair.split('=');
  assert.equal(after, before, `${label}: the refused step changed on-hand stock`);
  return msg;
}

function beforeCases() {
  const base = Number(scalar(ON_HAND));
  const both = Number(ok(`${link(1, JOB(1))}\n${complete(1)}\n${record(1)}\n${ON_HAND}`));
  assert.equal(both, base - 20, 'BEFORE: the linked job and ticket should both deduct (the bug)');
  console.log(`[before] ticket T1 linked to job J1: completing J1 and recording T1 both take 10 Gal (on hand ${base} -> ${both})`);
  // Legacy state kept for case 3: ticket T2 recorded while unlinked, then linked to J2 (as the old code allowed).
  psql(`BEGIN;\n${signedIn(record(2))}\nCOMMIT;`);
  raw(`UPDATE public.blend_tickets SET job_id = '${JOB(2)}' WHERE id = '${TICKET(2)}';`);
  // T1 linked to a completed J1, committed, for the mutation check.
  psql(`BEGIN;\n${signedIn(`${link(1, JOB(1))}\n${complete(1)}`)}\nCOMMIT;`);
  console.log('[before] committed legacy state: T2 has its own record (10 Gal out) and is linked to J2; T1 is linked to completed J1');
}

function applyCandidate() {
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, `candidate failed:\n${first.output}`);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second run must refuse');
  assert.match(again.output, /F06_PREFLIGHT: already applied/);
  assert.equal(scalar(`SELECT string_agg(p.proname || ':' || p.prosecdef || ':' || pg_get_userbyid(p.proowner) || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE'), ',' ORDER BY p.proname)
    FROM pg_proc p WHERE p.proname LIKE '\\_f06\\_%';`),
    '_f06_application_record_one_deduction:true:postgres:false,_f06_blend_ticket_link_keeps_stock_once:true:postgres:false,_f06_job_customer_keeps_linked_tickets:true:postgres:false');
  console.log('[apply] candidate applies once (postflight passed), a second run is refused; all three guards are definer, owned by postgres, not callable by app users');
}

async function afterCases() {
  const base = Number(scalar(ON_HAND));
  // 1. Linked ticket, job completed first: the ticket's record is refused, stock taken once.
  const m1 = refusedAfter(`${link(3, JOB(3))}\n${complete(3)}`, record(3), /BLEND_TICKET_JOB_RECORDS/, 'case 1');
  assert.equal(Number(ok(`${link(3, JOB(3))}\n${complete(3)}\n${ON_HAND}`)), base - 10, 'case 1: completing the job must take 10 Gal');
  console.log(`[case 1] T3 linked to J3, J3 completed (10 Gal out), then Create App Record on T3: refused, stock unchanged ("${m1.slice(0, 90)}...")`);
  // 2. Linked ticket recorded before its job is done: refused too; the job then completes and takes the stock.
  refusedAfter(link(3, JOB(3)), record(3), /BLEND_TICKET_JOB_RECORDS/, 'case 2');
  assert.equal(Number(ok(`${link(3, JOB(3))}\n${complete(3)}\n${ON_HAND}`)), base - 10);
  console.log('[case 2] Create App Record on a linked ticket before its job is completed: refused, stock unchanged; the job then completes normally (10 Gal out once)');
  // 3. Legacy: T2 already recorded and linked to J2. Completing J2 is refused and changes nothing (status, stock, ledger, records).
  const legacyBefore = `${scalar(ON_HAND)}|${scalar(LEDGER)}|${scalar(RECORDS)}`;
  refused(complete(2), /JOB_BLEND_TICKET_ALREADY_RECORDED/, 'case 3');
  assert.equal(`${scalar(ON_HAND)}|${scalar(LEDGER)}|${scalar(RECORDS)}`, legacyBefore);
  assert.equal(scalar(`SELECT status FROM public.jobs WHERE id = '${JOB(2)}';`), 'in_progress');
  //    An admin reverses T2's record (10 Gal back), then J2 completes (10 Gal out): net one deduction.
  assert.equal(Number(ok(`${reverse(2)}\n${complete(2)}\n${ON_HAND}`)), base, 'case 3: reverse + complete must net to the same on-hand');
  assert.equal(ok(`${reverse(2)}\n${complete(2)}\nSELECT (SELECT count(*) FROM public.application_records WHERE source_type = 'blend_ticket' AND source_id = '${TICKET(2)}') || '/' || (SELECT count(*) FROM public.application_records WHERE source_type = 'job' AND source_id = '${JOB(2)}');`), '0/1');
  console.log('[case 3] legacy pair (T2 recorded, linked to J2): completing J2 is refused and leaves status, stock, ledger and records unchanged; after an admin reverses T2, J2 completes: one record, stock out once net');
  // 4. A ticket cannot leave a job that already recorded: unlink or move refused; an unchanged save still works.
  const m4 = refused(`${link(4, JOB(4))}\n${complete(4)}\n${link(4, null)}`, /BLEND_TICKET_COMPLETED_JOB_KEEPS_TICKET/, 'case 4 unlink');
  refused(`${link(4, JOB(4))}\n${complete(4)}\n${link(4, JOB(5))}`, /BLEND_TICKET_COMPLETED_JOB_KEEPS_TICKET/, 'case 4 move');
  ok(`${link(4, JOB(4))}\n${complete(4)}\nUPDATE public.blend_tickets SET job_id = job_id, notes = 'edited' WHERE id = '${TICKET(4)}';\nSELECT 1;`);
  ok(`${link(4, JOB(4))}\n${link(4, null)}\n${link(4, JOB(5))}\nSELECT 1;`);
  console.log(`[case 4] after J4 completes, unlinking T4 or moving it to J5 is refused ("${m4.slice(0, 70)}..."); an edit that keeps the job saves; before completion the link can still change`);
  // 5. A ticket with its own record cannot be linked to a job; an unlinked ticket and an unrelated job both record (unchanged).
  refused(`${record(5)}\n${link(5, JOB(5))}`, /BLEND_TICKET_RECORDED_NO_JOB/, 'case 5');
  assert.equal(Number(ok(`${record(6)}\n${complete(6)}\n${ON_HAND}`)), base - 20, 'case 5: unrelated ticket and job each take their own 10 Gal');
  console.log('[case 5] T5 recorded on its own, then linked to J5: refused; unrelated T6 and J6 each record and take 10 Gal as before');
  // 6. The internal ticket-record body (not reachable by app users) is guarded too: the trigger sits on the table.
  const r6 = probe(`${AS_ADMIN}\n${link(7, JOB(7))}\nSELECT public._create_app_record_from_bt_replay_impl_20261015('${TICKET(7)}', '${ADMIN}', '${key()}') IS NOT NULL;`);
  assert.notEqual(r6.status, 0, r6.output);
  assert.match(r6.output, /BLEND_TICKET_JOB_RECORDS/);
  console.log('[case 6] calling the internal ticket-record body directly on a linked ticket is refused by the table guard');
  // 7. Mason, 2026-11-23 (after Luna round 4): the job's own chemical list always counts, even when empty.
  assert.equal(Number(ok(`${link(9, JOB(9))}\n${complete(9)}\n${ON_HAND}`)), base, 'case 7: an empty job takes nothing');
  refused(`${link(9, JOB(9))}\n${complete(9)}\n${record(9)}`, /BLEND_TICKET_JOB_RECORDS/, 'case 7 ticket after empty job');
  console.log("[case 7] J9 has no chemicals and T9 linked: J9 completes and takes nothing (its own list counts); T9 still cannot record (accepted)");
  // 8. A cancelled job cannot complete, so its linked ticket records as before.
  assert.equal(Number(ok(`${record(10)}\n${ON_HAND}`)), base - 10, 'case 8: a ticket on a cancelled job must record and take its stock');
  console.log('[case 8] T10 is linked to cancelled J10: Create App Record works and takes 10 Gal');
  // Luna round 3: a job that already recorded, then was cancelled, still owns the stock.
  refusedAfter(`${link(3, JOB(3))}\n${complete(3)}\nRESET ROLE;\nSET LOCAL session_replication_role = replica;
UPDATE public.jobs SET status = 'cancelled' WHERE id = '${JOB(3)}';\nSET LOCAL session_replication_role = origin;\nSET LOCAL ROLE authenticated;`,
    record(3), /BLEND_TICKET_JOB_RECORDS/, 'case 8 recorded then cancelled');
  console.log('[case 8] J3 completed (10 Gal out), then cancelled: Create App Record on its linked T3 is still refused');
  // Luna round 4: a new ticket is checked too: linked at creation to another customer's job is refused, to its own customer's job is fine.
  const newTicket = (job) => `INSERT INTO public.blend_tickets (id, ticket_number, uploaded_by, status, review_status, customer_id, season, ticket_date, total_acres, job_id)
    VALUES ('${TICKET(99)}', 'F06-T99', '${ADMIN}', 'completed', 'approved', '${CUST}', 2027, current_date, 10, '${job}');`;
  refusedProbe(newTicket(JOB(11)), /BLEND_TICKET_JOB_OTHER_CUSTOMER/);
  okProbe(`${newTicket(JOB(5))}\nSELECT 1;`);
  console.log("[case 9] a new ticket created already linked to another customer's job: refused; to its own customer's job: saved");
  // Luna round 3: changing a linked ticket's customer is checked too.
  refused(`${link(4, JOB(4))}\nUPDATE public.blend_tickets SET customer_id = '${CUST2}' WHERE id = '${TICKET(4)}';`, /BLEND_TICKET_JOB_OTHER_CUSTOMER/, 'case 9 customer change');
  console.log("[case 9] changing linked T4's customer away from its job's customer: refused");
  // 9. A ticket cannot be linked to another customer's job, even by a direct table update.
  refused(link(6, JOB(11)), /BLEND_TICKET_JOB_OTHER_CUSTOMER/, 'case 9');
  console.log("[case 9] linking T6 to J11 (another customer's job) by a direct table update: refused");
  // Luna round 5: the job side too. A linked job's customer cannot change; an unlinked job's, or a save that keeps it, can.
  refused(`${link(4, JOB(4))}\nUPDATE public.jobs SET customer_id = '${CUST2}' WHERE id = '${JOB(4)}';`, /BLEND_TICKET_JOB_OTHER_CUSTOMER/, 'case 9 job customer change');
  assert.equal(ok(`${link(4, JOB(4))}\nUPDATE public.jobs SET customer_id = '${CUST}' WHERE id = '${JOB(4)}';\nSELECT 'kept';`), 'kept', 'case 9 job save keeping its customer');
  assert.equal(ok(`UPDATE public.jobs SET customer_id = '${CUST2}' WHERE id = '${JOB(6)}';\nSELECT customer_id FROM public.jobs WHERE id = '${JOB(6)}';`), CUST2, 'case 9 unlinked job customer change');
  console.log("[case 9] changing linked J4's customer: refused; a save keeping it, or changing unlinked J6's customer: saved");
  // Sol round 3: a deleted linked ticket does not block the job's customer change, but restoring it afterwards is refused.
  const softDelete = (when) => `UPDATE public.blend_tickets SET deleted_at = ${when} WHERE id = '${TICKET(4)}';`;
  refused(`${link(4, JOB(4))}\n${softDelete('now()')}\nUPDATE public.jobs SET customer_id = '${CUST2}' WHERE id = '${JOB(4)}';\n${softDelete('NULL')}`,
    /BLEND_TICKET_JOB_OTHER_CUSTOMER/, 'case 9 restore');
  console.log("[case 9] T4 linked to J4 is deleted, J4 moves to another customer (allowed), then restoring T4: refused");
  await races();
}

async function races() {
  // Race A: J7 completion holds the job lock; an office unlink of T7 waits for it, then sees the job record and is refused.
  psql(`BEGIN;\n${signedIn(link(7, JOB(7)))}\nCOMMIT;`);
  const a = session(`BEGIN;\n${signedIn(complete(7))}\nSELECT pg_sleep(3);\nCOMMIT;`);
  const b = session(`BEGIN;\n${signedIn(link(7, null))}\nCOMMIT;`, 1000);
  const w = session(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%job_id = NULL%' AND pid <> pg_backend_pid();`, 2200);
  const [ra, rb, rw] = await Promise.all([a, b, w]);
  assert.equal(ra.code, 0, ra.out);
  assert.equal(rw.out.trim().split(/\r?\n/).filter(Boolean).at(-1), '1', `race A: the unlink must be waiting on a lock mid-race:\n${rw.out}`);
  assert.notEqual(rb.code, 0, `race A: the unlink must be refused:\n${rb.out}`);
  assert.match(rb.out, /BLEND_TICKET_COMPLETED_JOB_KEEPS_TICKET/);
  assert.equal(scalar(`SELECT job_id FROM public.blend_tickets WHERE id = '${TICKET(7)}';`), JOB(7));
  console.log('[race A] two sessions: J7 completes while the office unlinks T7; the unlink waits on the lock, then is refused; T7 stays on J7');
  // Race B: T8 is being recorded on its own (ticket lock held); linking it to J8 waits, then is refused.
  const c = session(`BEGIN;\n${signedIn(record(8))}\nSELECT pg_sleep(3);\nCOMMIT;`);
  const d = session(`BEGIN;\n${signedIn(link(8, JOB(8)))}\nCOMMIT;`, 1000);
  const w2 = session(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%job_id = ''${JOB(8)}''%' AND pid <> pg_backend_pid();`, 2200);
  const [rc, rd, rw2] = await Promise.all([c, d, w2]);
  assert.equal(rc.code, 0, rc.out);
  assert.equal(rw2.out.trim().split(/\r?\n/).filter(Boolean).at(-1), '1', `race B: the link must be waiting on a lock mid-race:\n${rw2.out}`);
  assert.notEqual(rd.code, 0, `race B: the link must be refused:\n${rd.out}`);
  assert.match(rd.out, /BLEND_TICKET_RECORDED_NO_JOB/);
  console.log('[race B] two sessions: T8 is recorded while the office links it to J8; the link waits on the ticket lock, then is refused');
  // Luna round 6: a job customer change and a link on the same job serialize on the job row, in either order.
  const waiting = (pattern) => session(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '${pattern}' AND pid <> pg_backend_pid();`, 2200);
  const changeCustomer = (k) => `UPDATE public.jobs SET customer_id = '${CUST2}' WHERE id = '${JOB(k)}';`;
  // Race C: J12's customer change holds the job row; linking T12 (customer A) waits, then sees customer B and is refused.
  const [re, rf, rw3] = await Promise.all([
    session(`BEGIN;\n${signedIn(changeCustomer(12))}\nSELECT pg_sleep(3);\nCOMMIT;`),
    session(`BEGIN;\n${signedIn(link(12, JOB(12)))}\nCOMMIT;`, 1000),
    waiting(`%job_id = ''${JOB(12)}''%`),
  ]);
  assert.equal(re.code, 0, re.out);
  assert.equal(rw3.out.trim().split(/\r?\n/).filter(Boolean).at(-1), '1', `race C: the link must be waiting on a lock mid-race:\n${rw3.out}`);
  assert.notEqual(rf.code, 0, `race C: the link must be refused:\n${rf.out}`);
  assert.match(rf.out, /BLEND_TICKET_JOB_OTHER_CUSTOMER/);
  assert.equal(scalar(`SELECT coalesce(job_id::text, 'none') FROM public.blend_tickets WHERE id = '${TICKET(12)}';`), 'none');
  console.log("[race C] two sessions: J12's customer changes while the office links T12 to it; the link waits on the job, then is refused");
  // Race D: linking T13 to J13 holds the job row; changing J13's customer waits, then sees the link and is refused.
  const [rg, rh, rw4] = await Promise.all([
    session(`BEGIN;\n${signedIn(link(13, JOB(13)))}\nSELECT pg_sleep(3);\nCOMMIT;`),
    session(`BEGIN;\n${signedIn(changeCustomer(13))}\nCOMMIT;`, 1000),
    waiting(`%customer_id = ''${CUST2}'' WHERE id = ''${JOB(13)}''%`),
  ]);
  assert.equal(rg.code, 0, rg.out);
  assert.equal(rw4.out.trim().split(/\r?\n/).filter(Boolean).at(-1), '1', `race D: the customer change must be waiting on a lock mid-race:\n${rw4.out}`);
  assert.notEqual(rh.code, 0, `race D: the customer change must be refused:\n${rh.out}`);
  assert.match(rh.out, /BLEND_TICKET_JOB_OTHER_CUSTOMER/);
  assert.equal(scalar(`SELECT customer_id FROM public.jobs WHERE id = '${JOB(13)}';`), CUST);
  console.log("[race D] two sessions: T13 is linked to J13 while the office changes J13's customer; the change waits on the job, then is refused");
  // Race E (Sol round 2 HIGH): completion order is job row, then the record-number lock. A completion holding J14 that
  // then needs the number lock must not deadlock with Create App Record on linked T14, which takes the number lock first.
  psql(`BEGIN;\n${signedIn(link(14, JOB(14)))}\nCOMMIT;`);
  const numberLock = "SELECT pg_advisory_xact_lock(hashtext('next_application_record_number'));";
  const [ri, rj] = await Promise.all([
    session(`BEGIN;\nSELECT 1 FROM public.jobs WHERE id = '${JOB(14)}' FOR NO KEY UPDATE;\nSELECT pg_sleep(2);\n${numberLock}\nCOMMIT;`),
    session(`BEGIN;\n${signedIn(record(14))}\nCOMMIT;`, 1000),
  ]);
  assert.equal(ri.code, 0, `race E: the completion side must finish, not deadlock:\n${ri.out}`);
  assert.doesNotMatch(`${ri.out}\n${rj.out}`, /deadlock/i);
  assert.notEqual(rj.code, 0, `race E: the ticket must be refused:\n${rj.out}`);
  assert.match(rj.out, /BLEND_TICKET_JOB_RECORDS: this blend ticket's spray job is being changed right now/);
  console.log('[race E] two sessions: a completion holds J14 and then takes the record-number lock while Create App Record runs on linked T14; the ticket is refused at once ("being changed right now"), no deadlock');
}

function mutation() {
  const r = probe(`DROP TRIGGER blend_ticket_link_keeps_stock_once_f06 ON public.blend_tickets;\n${signedIn(`${link(1, null)}\nSELECT 1;`)}`);
  assert.equal(r.status, 0, `MUTATION: without the link guard the unlink of T1 (job J1 recorded) should go through:\n${r.output}`);
  refused(link(1, null), /BLEND_TICKET_COMPLETED_JOB_KEEPS_TICKET/, 'mutation control');
  console.log('[mutation] with the link guard dropped, unlinking T1 from its completed job goes through again; with it, refused');
}

function rollbackCases() {
  stageText('reverse.sql', lf(REVERSE));
  const r = docker([...psqlArgs(), '-f', '/tmp/reverse.sql'], { allowFailure: true }); // the script has its own transaction
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname LIKE '\\_f06\\_%';"), '0');
  assert.equal(Number(ok(`${link(3, JOB(3))}\n${complete(3)}\n${record(3)}\n${ON_HAND}`)), Number(scalar(ON_HAND)) - 20);
  console.log('[rollback] the reverse script removes the three guards and the old behaviour returns (linked job and ticket both deduct)');
}

async function main() {
  buildContainer();
  seed();
  beforeCases();
  applyCandidate();
  await afterCases();
  mutation();
  rollbackCases();
  console.log('F06_JOB_OWNS_LINKED_BLEND_STOCK_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
