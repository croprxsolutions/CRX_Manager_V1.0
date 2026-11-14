#!/usr/bin/env node
/**
 * Real-schema proof for 20270110100000_ki99_void_reverses_write_offs (KI-99; contract
 * docs/plans/2026-11-14-ki99-void-reverses-write-off-CONTRACT.md).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, seeds an invented customer, invoices and
 * write-offs, shows the bug BEFORE (a void leaves the write-off active), applies the candidate, checks the
 * definition is the pre-image plus only the KI-99 lines, then runs the contract's cases as a signed-in admin:
 * posted and paid voids reverse the write-off with one audit row; the write-off's closed Chicago month refuses
 * the whole void; batch (and, when the invented group passes its guard, group) void reverse it; the statement
 * drops the pair; a keyed retry writes nothing; an invoice with no write-off is unchanged; a second apply passes.
 *
 * Run: node scripts/smoke/prove-ki99-void-reverses-write-offs-real-schema.mjs   (needs Docker)
 * Prints KI99_VOID_REVERSES_WRITE_OFFS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki99-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270110100000_ki99_void_reverses_write_offs.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// Data migrations that rewrite live rows this disposable database does not have, or need live's storage
// policies; recorded in the ledger (as live has them) instead of replayed. Same list as the DM-1b proof.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate creates or relies on.
// A later or parked file that (re)defines the voided-invoice path or write-offs.
const TOUCHED = /(_void_invoice_split_provenance_impl_20260719|\bwrite_offs\b|_get_customer_statement_scoped_impl)/i;
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
  const validate = bodyFrom('20260211000000_unit_tracking_pricing_overhaul.sql',
    /CREATE OR REPLACE FUNCTION validate_product_units\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)
    .replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
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
  for (const file of all.slice(at + 1)) {
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
    if (ONE_SHOT.has(base.slice(0, -4))) { ledger(base.slice(0, -4)); continue; }
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
    }
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
        SELECT '00000000-0000-4000-8000-000000000000', 'unknown', 'moa1-proof' WHERE NOT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);`);
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate`);
}

const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
const id = (n) => `d8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = id('a1');
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);

function txIn(uid, sql) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  return `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n`;
}
function as(uid, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: txIn(uid, sql) });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}

// ---------------------------------------------------------------------------------------------
// KI-99 cases. Invented customer, invoices and write-offs, seeded without triggers.
// ---------------------------------------------------------------------------------------------
const CUSTOMER = id('c1');
const INV = { one: id('b1'), paid: id('b2'), closed: id('b3'), batch: id('b4'), plain: id('b5'), cash: id('b9'), key: id('b6') };
const WO = { active2: id('e9'), open: id('ea'), cash: id('eb'), active: id('e1'), old: id('e2'), paid: id('e3'), closed: id('e4'), batch: id('e5'), key: id('e6') };

function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}\n${r.output}`);
  assert.match(r.output, pattern);
  return r.output;
}
const n = (sql) => Number(scalar(sql));
const row = (sql) => JSON.parse(scalar(`SELECT COALESCE((${sql}), 'null'::jsonb);`));
// Insert one row with triggers off, filling NOT NULL columns without a default with a typed placeholder.
function seedRow(table, fields) {
  const o = JSON.stringify(fields).replaceAll("'", "''");
  raw(`DO $seed$
DECLARE v_o jsonb := '${o}'::jsonb; v_cols text := ''; v_vals text := ''; c record;
BEGIN
  FOR c IN SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
             FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = 'public.${table}'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
              AND (v_o ? a.attname OR (a.attnotnull AND (NOT a.atthasdef OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE '%auth.uid()%')))
  LOOP
    v_cols := v_cols || CASE WHEN v_cols = '' THEN '' ELSE ', ' END || quote_ident(c.attname);
    v_vals := v_vals || CASE WHEN v_vals = '' THEN '' ELSE ', ' END || CASE
      WHEN v_o ? c.attname THEN quote_nullable(v_o ->> c.attname) || '::' || c.typ
      WHEN c.typ = 'uuid' THEN quote_literal('${ADMIN}') || '::uuid'
      WHEN c.typ IN ('integer','bigint','smallint') OR c.typ LIKE 'numeric%' THEN '0'
      WHEN c.typ = 'boolean' THEN 'false'
      WHEN c.typ = 'date' THEN 'current_date'
      WHEN c.typ LIKE 'timestamp%' THEN 'now()'
      WHEN c.typ = 'jsonb' THEN '''{}''::jsonb'
      ELSE quote_literal('[PROVER] ' || substr(md5(random()::text), 1, 8)) || '::' || c.typ END;
  END LOOP;
  EXECUTE format('INSERT INTO public.${table} (%s) VALUES (%s)', v_cols, v_vals);
END $seed$;`);
}
function invoice(idv, number, fields = {}) {
  seedRow('invoices', { id: idv, customer_id: CUSTOMER, status: 'posted', invoice_date: '2026-12-01', due_date: '2099-01-01',
    posted_at: '2026-12-01 15:00:00+00', posted_by: ADMIN, invoice_type: 'chemical_sale', total_amount_cents: 10000,
    paid_amount_cents: 0, prepay_applied_cents: 0, credit_applied_cents: 0, write_off_cents: 0, invoice_number: number,
    deleted_at: null, invoice_group_id: null, order_id: null, job_id: null, created_by: ADMIN, ...fields });
}
function writeOff(idv, inv, cents, fields = {}) {
  seedRow('write_offs', { id: idv, invoice_id: inv, customer_id: CUSTOMER, amount_cents: cents, reason: '[PROVER] small balance',
    created_by: ADMIN, approved_by: ADMIN, created_at: '2026-12-02 15:00:00+00', reversed_at: null, ...fields });
}
function seed() {
  raw(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}', 'ki99-admin@example.invalid') ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES ('${ADMIN}', 'ki99-admin@example.invalid', '[PROVER] KI99 admin', 'admin', true)
    ON CONFLICT (id) DO UPDATE SET role = 'admin', is_active = true;`);
  seedRow('customers', { created_by: ADMIN, id: CUSTOMER, email: 'ki99-customer@example.invalid', is_active: true, assigned_sales_rep: ADMIN });
  // 1. posted, $100.00 with an active $10.00 write-off and an earlier $5.00 write-off already reversed.
  invoice(INV.one, 'INV-K99-1', { write_off_cents: 1250 });
  writeOff(WO.active, INV.one, 1000);
  writeOff(WO.active2, INV.one, 250, { created_at: '2026-12-03 15:00:00+00' });
  writeOff(WO.old, INV.one, 500, { created_at: '2026-12-01 16:00:00+00', reversed_at: '2026-12-01 17:00:00+00', reversed_by: ADMIN, reversed_reason: '[PROVER] earlier' });
  // 2. paid, settled only by a $100.00 write-off.
  invoice(INV.paid, 'INV-K99-2', { status: 'paid', write_off_cents: 10000 });
  writeOff(WO.paid, INV.paid, 10000);
  // 3. write-off booked Oct 31 7:30 pm CDT (Nov 1 00:30 UTC) on an invoice dated in December.
  invoice(INV.closed, 'INV-K99-3', { write_off_cents: 1300 });
  writeOff(WO.open, INV.closed, 300);
  writeOff(WO.closed, INV.closed, 1000, { created_at: '2026-11-01 00:30:00+00' });
  // 8. direct cash applied plus a write-off.
  invoice(INV.cash, 'INV-K99-8', { write_off_cents: 1000, paid_amount_cents: 500 });
  writeOff(WO.cash, INV.cash, 1000);
  // 4. batch void path.
  invoice(INV.batch, 'INV-K99-4', { write_off_cents: 1000 });
  writeOff(WO.batch, INV.batch, 1000);
  // 7. no write-off.
  invoice(INV.plain, 'INV-K99-7');
  // 6. retry with the same key.
  invoice(INV.key, 'INV-K99-6', { write_off_cents: 1000 });
  writeOff(WO.key, INV.key, 1000);
}
function setClosed(month) {
  raw(`DELETE FROM public.accounting_periods;
    ${month ? `INSERT INTO public.accounting_periods (period_start, period_end, status, closed_at, closed_by)
    VALUES ('${month}', ('${month}'::date + interval '1 month' - interval '1 day')::date, 'closed', now(), '${ADMIN}');` : ''}`);
}
const woState = (w) => row(`SELECT jsonb_build_object('reversed', reversed_at IS NOT NULL, 'by', reversed_by, 'reason', reversed_reason) FROM public.write_offs WHERE id = '${w}'`);
const invState = (i) => row(`SELECT jsonb_build_object('status', status, 'write_off_cents', write_off_cents) FROM public.invoices WHERE id = '${i}'`);
const audits = (w) => n(`SELECT count(*) FROM public.financial_audit_log WHERE operation_type = 'write_off_reversed' AND entity_id = '${w}'`);
const voidSql = (i, key = null) => `SELECT public.void_invoice('${i}', '[PROVER] wrong customer', ${q(key)});`;
// Runs the call as the signed-in admin and reports what it left, all rolled back.
function trial(sql, w) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
${sql}
RESET ROLE;
SELECT (SELECT reversed_at IS NOT NULL FROM public.write_offs WHERE id = '${w}')::text;
ROLLBACK;` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, reversed: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) };
}
const statementRefs = () => ok(ADMIN, `SELECT coalesce(string_agg(txn_type || ':' || ref_num || ':' || amount_cents, ',' ORDER BY ref_num, txn_type), '-')
  FROM public.get_customer_statement('${CUSTOMER}', '2026-01-01', '2099-12-31') s(txn_date, txn_type, ref_num, description, amount_cents, running_balance_cents);`);
const definition = (sig) => docker([...psqlArgs(), '-A', '-t'], { input: `SELECT pg_get_functiondef('public.${sig}'::regprocedure);` }).stdout.replace(/\r/g, '');
const aclOf = (sig) => scalar(`SELECT coalesce(proacl::text, '-') || ' ' || pg_get_userbyid(proowner) || ' ' || prosecdef::text || ' ' || provolatile::text FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;`);
const TARGET = '_void_invoice_split_provenance_impl_20260719(uuid,text,text)';

function main() {
  buildContainer();
  seed();
  setClosed(null);
  const preDef = definition(TARGET);
  const preAcl = aclOf(TARGET);
  // BEFORE: the void zeroes the invoice's write-off amount but leaves the write-off active (KI-99).
  const before = trial(voidSql(INV.one), WO.active);
  assert.equal(before.status, 0, before.output);
  assert.equal(before.reversed, 'false', `BEFORE: the write-off was already reversed by the void\n${before.output}`);
  console.log('[prover] BEFORE: voiding INV-K99-1 leaves its $10.00 write-off active (KI-99 reproduced)');

  stageText('candidate.sql', lf(CANDIDATE));
  let r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  // Only the planned KI-99 lines are new: the cursor declaration and the loop before the invoice is zeroed.
  const cand = lf(CANDIDATE);
  const loop = cand.slice(cand.indexOf('  -- KI-99 (Mason, 2026-11-14)'), cand.indexOf('  -- CREDIT-APPLY: credit_applied_cents = 0 added'));
  assert.ok(loop.includes('END LOOP;') && loop.split('\n').length < 40, 'the KI-99 block was not found');
  const decl = '  v_capp record;  -- CREDIT-APPLY: active-application cursor\n';
  const anchor = '  -- CREDIT-APPLY: credit_applied_cents = 0 added';
  assert.equal(preDef.split(decl).length, 2); assert.equal(preDef.split(anchor).length, 2);
  const planned = preDef.replace(decl, () => `${decl}  v_wo record;  -- KI-99: active write-off cursor\n`).replace(anchor, () => loop + anchor);
  assert.equal(definition(TARGET), planned, 'the new definition differs from the pre-image by more than the KI-99 lines');
  assert.equal(aclOf(TARGET), preAcl, 'grants, owner, SECURITY DEFINER or volatility changed');
  console.log('[prover] candidate applied; the definition equals the pre-image plus only the KI-99 lines; grants unchanged');

  // 1. posted invoice: the active write-off is reversed and recorded; the earlier reversal is untouched.
  const oldBefore = row(`SELECT to_jsonb(w) FROM public.write_offs w WHERE id = '${WO.old}'`);
  ok(ADMIN, voidSql(INV.one));
  assert.deepEqual(invState(INV.one), { status: 'voided', write_off_cents: 0 });
  assert.deepEqual(woState(WO.active), { reversed: true, by: ADMIN, reason: 'Auto-reversed: invoice INV-K99-1 voided — [PROVER] wrong customer' });
  assert.equal(audits(WO.active), 1);
  assert.deepEqual(woState(WO.active2), { reversed: true, by: ADMIN, reason: 'Auto-reversed: invoice INV-K99-1 voided — [PROVER] wrong customer' });
  assert.equal(audits(WO.active2), 1);
  assert.equal(n(`SELECT count(*) FROM public.financial_audit_log WHERE entity_id IN ('${WO.active}', '${WO.active2}') AND actor_user_id = '${ADMIN}'`), 2, 'audit actor not filled');
  assert.deepEqual(row(`SELECT to_jsonb(w) FROM public.write_offs w WHERE id = '${WO.old}'`), oldBefore, 'the earlier reversal changed');
  assert.equal(audits(WO.old), 0);
  const audit = row(`SELECT jsonb_build_object('impact', total_impact_cents, 'role', actor_role, 'old', old_values, 'new', new_values - 'reversed_at') FROM public.financial_audit_log WHERE operation_type = 'write_off_reversed' AND entity_id = '${WO.active}'`);
  assert.deepEqual(audit, { impact: 1000, role: 'admin', old: { amount_cents: 1000, reversed_at: null, invoice_status: 'posted' },
    new: { reverse_reason: 'Auto-reversed: invoice voided — [PROVER] wrong customer', invoice_status: 'voided' } });
  console.log('[prover] case 1: void reverses both active write-offs (by the admin, with the void reason) and logs one write_off_reversed row each (+$10.00, +$2.50, actor filled); the earlier reversal is untouched');

  // 5. statement: neither the voided invoice nor its write-off shows.
  const stmt = statementRefs();
  assert.ok(!stmt.includes('INV-K99-1'), `the statement still shows INV-K99-1: ${stmt}`);
  console.log('[prover] case 5: the customer statement shows neither INV-K99-1 nor its write-off');

  // 2. paid invoice settled only by a write-off.
  ok(ADMIN, voidSql(INV.paid));
  assert.deepEqual(invState(INV.paid), { status: 'voided', write_off_cents: 0 });
  assert.equal(woState(WO.paid).reversed, true);
  console.log('[prover] case 2: a paid invoice settled by a write-off voids and its write-off is reversed');

  // 3. the write-off's Chicago month (October) closed: the whole void is refused; November closed: it passes.
  setClosed('2026-10-01');
  const refusal = refused(ADMIN, voidSql(INV.closed), /closed accounting period/);
  assert.deepEqual(invState(INV.closed), { status: 'posted', write_off_cents: 1300 });
  assert.equal(woState(WO.closed).reversed, false);
  assert.equal(woState(WO.open).reversed, false, 'the open-month write-off stayed reversed after the refusal');
  assert.equal(audits(WO.open), 0);
  assert.equal(audits(WO.closed), 0);
  setClosed('2026-11-01');
  const nov = trial(voidSql(INV.closed), WO.closed);
  assert.equal(nov.status, 0, nov.output); assert.equal(nov.reversed, 'true');
  setClosed(null);
  console.log(`[prover] case 3: with October (the write-off's Chicago month) closed the void is refused and nothing changes (${refusal.split('\n').find((l) => /ERROR/.test(l))?.trim()}); with only November (its UTC month) closed it passes`);

  // 4. batch void and group void reach the same code.
  ok(ADMIN, `SELECT public.batch_void_invoices(ARRAY['${INV.batch}']::uuid[], '[PROVER] batch', NULL, 'ki99-batch-key');`);
  assert.equal(invState(INV.batch).status, 'voided'); assert.equal(woState(WO.batch).reversed, true);
  // A real governed split group needs a real split sale's provenance; instead show the group path voids each
  // member through the fixed function, with no exception handler that could keep a partial group.
  const groupDef = definition('void_invoice_group(uuid,text,text)');
  const guardDef = definition('_void_invoice_group_guard_impl_20260720(uuid,text,text)');
  assert.match(groupDef, /PERFORM public\._void_invoice_group_guard_impl_20260720\(/);
  assert.match(guardDef, /_void_invoice_split_provenance_impl_20260719\(/);
  for (const def of [groupDef, guardDef]) assert.doesNotMatch(def, /\bEXCEPTION\b\s+WHEN/i, 'a void path catches errors');
  console.log('[prover] case 4: batch void reverses the write-off; group void voids each member through the fixed function and catches no error (one refusal rolls back the group)');

  // 6. retry with the same key: the second call writes nothing new.
  ok(ADMIN, voidSql(INV.key, 'ki99-retry-key'));
  const after1 = n("SELECT count(*) FROM public.financial_audit_log");
  const woAfter1 = row(`SELECT to_jsonb(w) FROM public.write_offs w WHERE id = '${WO.key}'`);
  ok(ADMIN, voidSql(INV.key, 'ki99-retry-key'));
  assert.equal(n("SELECT count(*) FROM public.financial_audit_log"), after1);
  assert.deepEqual(row(`SELECT to_jsonb(w) FROM public.write_offs w WHERE id = '${WO.key}'`), woAfter1);
  refused(ADMIN, voidSql(INV.key), /already voided/);
  console.log('[prover] case 6: a retry with the same key returns and writes nothing; without a key it is refused (already voided)');

  // 8. direct cash applied: the existing refusal stands and the write-off stays active.
  refused(ADMIN, voidSql(INV.cash), /INVOICE_HAS_APPLIED_PAYMENTS/);
  assert.equal(woState(WO.cash).reversed, false);
  console.log('[prover] case 8: with direct cash applied the void is still refused and the write-off stays active');

  // 7. no write-off: no write-off audit row.
  const total = n("SELECT count(*) FROM public.financial_audit_log WHERE operation_type = 'write_off_reversed'");
  ok(ADMIN, voidSql(INV.plain));
  assert.equal(invState(INV.plain).status, 'voided');
  assert.equal(n("SELECT count(*) FROM public.financial_audit_log WHERE operation_type = 'write_off_reversed'"), total);
  console.log('[prover] case 7: an invoice with no write-off voids as before, with no write-off row');

  assert.equal(n(`SELECT count(*) FROM public.write_offs w JOIN public.invoices i ON i.id = w.invoice_id WHERE w.reversed_at IS NULL AND i.status IN ('voided', 'cancelled')`), 0);
  r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log('[prover] no active write-off is left on a voided invoice; a second apply passes');
  console.log('KI99_VOID_REVERSES_WRITE_OFFS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
