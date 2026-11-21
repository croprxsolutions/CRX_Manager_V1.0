#!/usr/bin/env node
/**
 * Real-schema proof for 20270204130000_pnl_commission_share_billed (KI-125, KI-126, KI-129 invoice count).
 * Container setup and replay copied from prove-page-access-locks-reports-real-schema.mjs. Then, on synthetic rows:
 *   1. BEFORE: the P&L and Month-End Close subtract every booked commission by order date, multiply a fee line's
 *      cost by acres again, and show $0 payments; the close receipt counts only invoices still 'posted'.
 *   2. The candidate applies; a second apply is refused by its preflight.
 *   3. AFTER: each figure equals the business rule (expected values written from the rule, not the code);
 *      payments received are unchanged (moved to a follow-up); a rep is still refused; the helpers are refused to
 *      signed-in and signed-out callers.
 *
 * Run: node scripts/smoke/prove-pnl-commission-share-billed-real-schema.mjs   (needs Docker)
 * Prints PNL_COMMISSION_SHARE_BILLED_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-pnl-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270204130000_pnl_commission_share_billed.sql');
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
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate changes or relies on.
const TOUCHED = /(get_monthly_summary|_get_bottom_line_pnl_cost_impl_20261019|_close_accounting_period_replay_impl_20261015|_invoice_sales_tax_cents_20270109|_report_commission_cents|_report_payments_received)/i;
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
// A rolled-back probe: as postgres with triggers on (uid null) or as a signed-in user. Returns the last row.
function probe(sql, uid = null) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${claims}\n${sql}\nROLLBACK;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '' };
}
function okProbe(sql, uid) { const r = probe(sql, uid); assert.equal(r.status, 0, r.output); return r.last; }
function refusedProbe(sql, pattern, uid) {
  const r = probe(sql, uid);
  assert.notEqual(r.status, 0, `expected a refusal:
${sql}
${r.output}`);
  assert.match(r.output, pattern);
}

const ADMIN = 'c1250000-0000-4000-8000-0000000000a1';
const REP = 'c1250000-0000-4000-8000-0000000000b2';
const CUSTOMER = 'c1250000-0000-4000-8000-0000000000c1';
const id = (n) => `c1250000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Orders O1..O6 are each booked at $1,000.00. Every commission is dated 2025-10-15 (its order date).
// Invoices: [id, order, type, status, date, lines]; a line is [extended cents, charge_type|null, cost_cents, quantity, is_fee].
const P = (cents) => [cents, null, 0, 1, false];
// A legacy untyped charge: no charge type and no product (the invoice screen shows it as a charge).
const U = (cents) => [cents, null, 0, 1, false, true];
const PRODUCT = 'c1250000-0000-4000-8000-0000000000d1';
const INVOICES = [
  // O2: a quarter billed in November (with freight, a standing discount and sales tax), the rest in December.
  [id(201), 2, 'chemical_sale', 'posted', '2025-11-10', [P(25000), [5000, 'freight', 0, 1, false], [-1000, 'standing_discount', 0, 1, false], [1500, 'sales_tax', 0, 1, false]]],
  [id(202), 2, 'chemical_sale', 'paid', '2025-12-10', [P(75000)]],
  // O3: billed $1,200 over two months (price raised at invoicing).
  [id(301), 3, 'chemical_sale', 'overdue', '2025-11-12', [P(60000)]],
  [id(302), 3, 'chemical_sale', 'posted', '2025-12-12', [P(60000)]],
  // O4: a 50/50 bill split, two payer invoices (one already paid).
  [id(401), 4, 'chemical_sale', 'posted', '2025-11-20', [P(50000)]],
  [id(402), 4, 'chemical_sale', 'paid', '2025-11-20', [P(50000)]],
  // O5: only a voided invoice and a draft.
  [id(501), 5, 'chemical_sale', 'voided', '2025-11-08', [P(100000)]],
  [id(502), 5, 'chemical_sale', 'draft', '2025-09-08', [P(100000)]],
  // O6: billed in full in November, half returned in December (credit memo on the order): no commission taken back yet (KI-184).
  [id(601), 6, 'chemical_sale', 'posted', '2025-11-05', [P(100000)]],
  [id(602), 6, 'credit_memo', 'posted', '2025-12-05', [P(-50000)]],
  // O7: a one-cent commission billed half in November, half in December (rounding must not make two cents).
  [id(801), 7, 'chemical_sale', 'posted', '2025-11-14', [P(50000)]],
  [id(802), 7, 'chemical_sale', 'posted', '2025-12-14', [P(50000)]],
  // O8: a negative product line first (November, with freight so the invoice total stays positive), the full order in December.
  [id(901), 8, 'chemical_sale', 'posted', '2025-11-16', [P(-2000), [5000, 'freight', 0, 1, false]]],
  [id(902), 8, 'chemical_sale', 'posted', '2025-12-16', [P(102000)]],
  // O9: billed in full in November; a December adjustment lowers product billing by $20 (with freight so the total stays
  // positive): the December commission is $0, never negative.
  [id(1001), 9, 'chemical_sale', 'posted', '2025-11-06', [P(100000)]],
  [id(1002), 9, 'chemical_sale', 'posted', '2025-12-06', [P(-2000), [5000, 'freight', 0, 1, false]]],
  // O10: booked $1,400, $100 billed in November, $7.07 commission: exactly 50.5 cents, so 51 cents (not 50).
  // Its $500 legacy untyped charge is not product: counting it would make 303 cents.
  [id(1101), 10, 'chemical_sale', 'posted', '2025-11-07', [P(10000), U(50000)]],
  // O11: a draft switched to Misc charge keeps its order's product lines; billed in full in December, so its $40 counts.
  [id(1201), 11, 'misc_charge', 'posted', '2025-12-09', [P(100000)]],
  // A field application (the job commission's invoice): 100 acres, $5/acre billed, $2/acre cost stored extended ($200).
  [id(701), null, 'field_application', 'posted', '2025-11-25', [[50000, null, 20000, 100, true]]],
  // A second job's invoice, still a draft (September).
  [id(702), null, 'field_application', 'draft', '2025-09-25', [[10000, null, 0, 100, true]]],
];
// [order, invoice, cents]; O4 has two recipients (split commission).
const COMMISSIONS = [[1, null, 10000], [2, null, 10000], [3, null, 10000], [4, null, 5000], [4, null, 5000], [5, null, 10000],
  [6, null, 10000], [7, null, 1], [8, null, 1000], [null, id(701), 3000], [null, id(702), 2000], [9, null, 5000], [10, null, 707], [11, null, 4000]];
// O4's first recipient (index 3) is already paid.
const PAID = 3;

function seed() {
  psql('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;', { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'pnl-a@example.invalid', '{"full_name":"[PROVER] PNL admin","role":"admin"}'::jsonb),
    ('${REP}', 'pnl-r@example.invalid', '{"full_name":"[PROVER] PNL rep","role":"sales_rep"}'::jsonb);`);
  const orders = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `('${id(n)}', 'PNL-O${n}', '${CUSTOMER}', ${n === 10 ? '1400.00' : '1000.00'}, 'fulfilled', DATE '2025-10-15')`).join(', ');
  const invoices = INVOICES.map(([iid, o, type, status, date, lines], k) => `('${iid}', 'PNL-${k}', '${CUSTOMER}', ${o ? `'${id(o)}'` : 'NULL'}, '${type}', '${status}', DATE '${date}', ${lines.reduce((s, l) => s + l[0], 0)}, '${ADMIN}', ${status === 'draft' ? 'NULL' : `TIMESTAMPTZ '${date} 12:00Z'`})`).join(', ');
  const items = INVOICES.flatMap(([iid, , , , , lines]) => lines.map(([ext, ct, cost, qty, fee, untyped]) =>
    `('${iid}', ${ct ? `'${ct}'` : 'NULL'}, ${!ct && !fee && !untyped ? `'${PRODUCT}'` : 'NULL'}, '[PROVER] line', ${qty}, ${ext / qty}, ${ext}, ${cost}, ${fee})`)).join(', ');
  const comms = COMMISSIONS.map(([o, inv, cents], k) => `('${CUSTOMER}', ${o ? `'${id(o)}'` : 'NULL'}, ${inv ? 'gen_random_uuid()' : 'NULL'}, ${inv ? `'${inv}'` : 'NULL'}, '[PROVER] rep ${k}', ${cents / 100}, '${k === PAID ? 'paid' : 'pending'}', DATE '2025-10-15')`).join(', ');
  raw(`BEGIN;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUSTOMER}', '[PROVER] PNL Farm', true);
    INSERT INTO public.orders (id, order_number, customer_id, total_price, status, order_date) VALUES ${orders};
    INSERT INTO public.invoices (id, invoice_number, customer_id, order_id, invoice_type, status, invoice_date, total_amount_cents, created_by, posted_at) VALUES ${invoices};
    INSERT INTO public.invoice_items (invoice_id, charge_type, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, is_application_fee) VALUES ${items};
    INSERT INTO public.commissions (customer_id, order_id, job_id, invoice_id, recipient, commission_amount, status, order_date) VALUES ${comms};
    -- Payments (not counted yet: payments received moved to a follow-up): one dated in November; one with no date, recorded the evening of Nov 30 Chicago (Dec 1 UTC);
    -- a superseded (inactive) version; one in December.
    INSERT INTO public.allocation_sets (entity_type, entity_id, customer_id, is_active, total_payment_cents, total_allocated_cents, payment_date, created_at) VALUES
      ('payment', gen_random_uuid(), '${CUSTOMER}', true, 680000, 502040, DATE '2025-11-18', '2025-11-18 15:00Z'),
      ('payment', gen_random_uuid(), '${CUSTOMER}', true, 100000, 100000, NULL, '2025-12-01 03:00Z'),
      ('payment', gen_random_uuid(), '${CUSTOMER}', false, 99900, 99900, DATE '2025-11-19', '2025-11-19 15:00Z'),
      ('payment', gen_random_uuid(), '${CUSTOMER}', true, 12300, 12300, DATE '2025-12-03', '2025-12-03 15:00Z');
    -- Prepayment Manager: one $4,000 check split into two buckets on Nov 20 (one payment); overpayment credits, linked
    -- to their payment or not, are left out (their cash is already in the payment).
    INSERT INTO public.prepay_credits (customer_id, season, original_amount_cents, balance_cents, source_type, source_reference, allocation_set_id, created_by, created_at) VALUES
      ('${CUSTOMER}', 2026, 300000, 300000, 'check', '5150', NULL, '${ADMIN}', '2025-11-20 16:00Z'),
      ('${CUSTOMER}', 2026, 100000, 100000, 'check', '5150', NULL, '${ADMIN}', '2025-11-20 16:00Z'),
      ('${CUSTOMER}', 2026, 77700, 77700, 'overpayment', 'From payment 1', (SELECT id FROM public.allocation_sets WHERE total_payment_cents = 680000), '${ADMIN}', '2025-11-18 15:00Z'),
      ('${CUSTOMER}', 2026, 55500, 55500, 'overpayment', 'From payment 2', NULL, '${ADMIN}', '2025-11-18 15:00Z');
    COMMIT;`);
}

const pnl = (a, b) => `SELECT json_object_agg(line_item, amount)::text FROM public.get_bottom_line_pnl(DATE '${a}', DATE '${b}');`;
const month = (a, b) => `SELECT public.get_monthly_summary(DATE '${a}', DATE '${b}')::text;`;
// Each close runs in a rolled-back probe, so the month stays open for the next one.
const close = (end, key, actor = ADMIN) => `SELECT public.close_accounting_period(DATE '${end}', '${actor}', '${key}')::text;`;
const RANGES = { oct: ['2025-10-01', '2025-10-31'], nov: ['2025-11-01', '2025-11-30'], dec: ['2025-12-01', '2025-12-31'], all: ['2025-09-01', '2025-12-31'] };
const read = () => Object.fromEntries(Object.entries(RANGES).map(([k, [a, b]]) => [k, {
  pnl: JSON.parse(okProbe(pnl(a, b), ADMIN)), month: JSON.parse(okProbe(month(a, b), ADMIN)) }]));

async function main() {
  buildContainer();
  seed();

  // 1. BEFORE
  const b = read();
  const closeBefore = JSON.parse(okProbe(close('2025-11-30', 'pnl-proof-close-1'), ADMIN));
  console.log('[before]', JSON.stringify({ oct: b.oct.pnl, nov: b.nov.pnl, dec: b.dec.pnl }));
  console.log('[before] Nov Month-End payments', JSON.stringify(b.nov.month.payments), 'commissions', JSON.stringify(b.nov.month.commissions), 'cost', b.nov.month.invoices.total_cost_cents);
  console.log('[before] Nov close receipt', JSON.stringify(closeBefore));
  assert.equal(Number(b.oct.pnl.Commissions), 757.08, 'BEFORE: every booked commission lands in October by order date');
  assert.equal(Number(b.nov.pnl.Commissions), 0);
  assert.equal(Number(b.nov.pnl['Cost of Goods Sold']), 20000, 'BEFORE: the fee cost is multiplied by acres again');
  assert.deepEqual(b.nov.month.payments, { count: 0, total_cents: 0 });
  assert.equal(closeBefore.payments_received_cents, 0);
  assert.equal(closeBefore.invoices_posted, 8, 'BEFORE: the overdue and paid November invoices are missed');
  assert.equal(b.oct.month.commissions.paid_count, 1, 'BEFORE: a paid commission counts in its order-date month');
  assert.equal(b.oct.month.commissions.basis, undefined);
  console.log('[case] BEFORE: $757.08 of commission in October with no revenue; fee COGS $20,000; payments $0; the close receipt misses the overdue and paid invoices');

  // 2. Apply, then a second apply is refused.
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /PNL_COMMISSION_SHARE_BILLED_PREFLIGHT: already applied/);
  console.log('[case] the candidate applies; a second apply stops at its preflight');

  // 3. AFTER (expected values from the rule)
  const a = read();
  console.log('[after]', JSON.stringify({ oct: a.oct.pnl, nov: a.nov.pnl, dec: a.dec.pnl, all: a.all.pnl }));
  // Nov: O2 25% ($25) + O3 60% ($60) + O4 split 2 x $50 + O6 in full ($100) + job $30 = $315.
  // Dec: O2 75% ($75) + O3 the remaining 40% ($40); O6's half return takes nothing back yet (KI-184) = $115.
  // O7 one cent: Nov recognizes round(0.5c) = 1c, Dec round(1c) - 1c = 0. O8: Nov share clamps at 0, Dec $10.
  assert.equal(Number(a.oct.pnl.Commissions), 0, 'P1: booked but unbilled commissions count nowhere');
  // O9: Nov $50, Dec $0 (the adjustment lowers billing, never the commission). O10: Nov 51 cents.
  assert.equal(Number(a.nov.pnl.Commissions), 365.52, 'P2-P5, P7: November share billed');
  assert.equal(Number(a.dec.pnl.Commissions), 165, 'P2, P3, P8: December share billed (O11 on a Misc charge invoice); a return takes nothing back yet (KI-184)');
  assert.equal(Number(a.all.pnl.Commissions), 530.52, 'P6: the voided/draft order and the draft job invoice count nothing; full range = sum of months');
  assert.equal(a.nov.month.commissions.earned_cents, 36552, 'Month-End uses the same commission');
  assert.equal(a.nov.month.commissions.basis, 'billed_share', 'the screen labels it as billed-share commission only now');
  assert.equal(a.oct.month.commissions.paid_count, 0, 'paid count follows the billed share');
  assert.equal(a.nov.month.commissions.paid_count, 1);
  assert.equal(a.dec.month.commissions.paid_count, 0);
  assert.equal(a.dec.month.commissions.earned_cents, 16500);
  assert.equal(okProbe("SELECT earned_cents FROM public._report_commission_cents_20270203(NULL, DATE '2025-12-31');"), '0', 'no start date is no range');
  assert.equal(okProbe('SELECT public._report_billed_part_cents_20270203(707, 10000, 140000);'), '51', 'an exact half cent rounds up');
  assert.equal(okProbe('SELECT public._report_billed_part_cents_20270203(150000001, 300000000, 300000001);'), '150000000', 'just under a half cent rounds down');
  console.log('[case] AFTER: commission $0 Oct / $365.52 Nov / $165 Dec / $530.52 all; a Misc charge invoice counts; a return takes nothing back yet; one cent is counted once; a half cent rounds up and just under rounds down; no start date is $0; a negative sale line or a downward sale adjustment never makes a negative commission; the paid count follows the billed share');
  assert.equal(Number(a.nov.pnl['Cost of Goods Sold']), 200, 'P9: fee cost $2/acre x 100 acres = $200');
  assert.equal(a.nov.month.invoices.total_cost_cents, 20000, 'P9: Month-End fee cost $200');
  console.log('[case] AFTER: the fee line costs $200 in both reports (was $20,000)');
  for (const k of Object.keys(RANGES)) {
    assert.equal(a[k].pnl.Revenue, b[k].pnl.Revenue, `${k}: revenue must not change`);
    assert.equal(a[k].month.invoices.total_amount_cents, b[k].month.invoices.total_amount_cents);
    assert.equal(a[k].month.ar_balance_cents, b[k].month.ar_balance_cents);
  }
  console.log('[case] AFTER: revenue and AR are unchanged in every range');
  for (const k of Object.keys(RANGES)) assert.deepEqual(a[k].month.payments, b[k].month.payments, `${k}: payments received unchanged`);
  const closeAfter = JSON.parse(okProbe(close('2025-11-30', 'pnl-proof-close-2'), ADMIN));
  console.log('[after] Nov close receipt', JSON.stringify(closeAfter));
  assert.equal(closeAfter.payments_received_cents, closeBefore.payments_received_cents, 'close receipt payments unchanged');
  assert.equal(closeAfter.invoices_posted, 10, 'P10: posted, overdue and paid November invoices');
  assert.equal(closeAfter.total_invoiced_cents, 25000 + 5000 - 1000 + 1500 + 60000 + 50000 + 50000 + 100000 + 50000 + 50000 + 3000 + 100000 + 10000 + 50000);
  assert.equal(closeAfter.orders_count, closeBefore.orders_count);
  assert.equal(closeAfter.deliveries_count, closeBefore.deliveries_count);
  console.log('[case] AFTER: Month-End and the close receipt payments are unchanged; the close receipt counts 10 invoices (posted, overdue and paid)');
  refusedProbe(pnl(...RANGES.nov), /requires admin/, REP);
  refusedProbe(month(...RANGES.nov), /requires admin/, REP);
  refusedProbe(close('2025-11-30', 'pnl-proof-close-3', REP), /Only admin users/, REP);
  for (const fn of ["_report_commission_cents_20270203(DATE '2025-11-01', DATE '2025-11-30')", '_report_billed_part_cents_20270203(1, 1, 1)']) {
    refusedProbe(`SELECT public.${fn};`, /permission denied for function/, REP);
    const anon = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\nSET LOCAL ROLE anon;\nSELECT public.${fn};\nROLLBACK;\n` });
    assert.match(`${anon.stdout}\n${anon.stderr}`, /permission denied for function/);
  }
  console.log('[case] AFTER: a rep is refused all three; the helpers are refused to signed-in and signed-out callers');
  console.log('PNL_COMMISSION_SHARE_BILLED_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
