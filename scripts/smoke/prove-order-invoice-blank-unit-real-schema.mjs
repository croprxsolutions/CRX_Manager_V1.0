#!/usr/bin/env node
/**
 * Real-schema proof for 20261230100000 (KI-76: invoice lines with no unit). Builds the checked-in schema
 * baseline in a network-disabled PostgreSQL container and replays every migration before the candidate.
 * With invented rows (an admin, a rep, a customer, a product sold in gal and one with no unit), every flow
 * runs through the real RPCs as the signed-in user (the API role), rolled back.
 *  Delivery side (complete_delivery -> draft invoice -> post_invoice -> return -> issue_return_credit):
 *   BEFORE: an order line and delivery line with no unit give a draft invoice line with no unit; it posts,
 *           and its return credit is refused (RETURN_CREDIT_UNIT_MISMATCH).
 *   AFTER:  the new order line takes the product unit, the invoice line gets it, it posts and is credited.
 *           A product with no unit: the delivery STILL completes, the draft line stays blank, posting is
 *           refused (INVOICE_LINE_UNIT_MISSING); once the product has a unit and the draft is saved, it posts.
 *           An order line written before the candidate with no unit: the invoice line takes the product unit
 *           and posts; its return credit stays refused, as today (the return reads the order line).
 *           An existing line whose order line and invoice line are both empty text takes the product unit
 *           (Mason, 2026-11-10: no sale line posts without a unit); its return is refused.
 *           A hand-replaced draft line (no order link, no unit) takes its product unit, or posting is refused.
 *           A line with a unit is unchanged throughout.
 *  Order side (create_invoice_from_order; the delivered cap is switched off inside these rolled-back probes
 *  only, since no order can pass it today): a line with no unit is refused (ORDER_LINE_UNIT_MISSING) and
 *  nothing is written; a gal line is billed and credited exactly as before.
 * A second apply refuses at the preflight; SECURITY DEFINER, search_path, owner and grants are unchanged.
 * It also checks KI-76 season item (fixed by 20261204110000): get_customer_summary and
 * operational_dashboard_summary read only the Chicago date.
 *
 * Run: node scripts/smoke/prove-order-invoice-blank-unit-real-schema.mjs   (needs local Docker image)
 * Prints ORDER_INVOICE_BLANK_UNIT_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(_create_invoice_from_order_impl_20260718|FUNCTION public\.create_invoice_from_order\(|_fill_order_line_unit|_fill_invoice_line_unit|_refuse_post_blank_unit_line)/i;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-order-unit-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
if (REUSE && !/^crx-order-unit-\d+-[0-9a-z]+$/.test(NAME)) {
  console.error(`CRX_PROVER_REUSE_CONTAINER must name a container this prover created (crx-order-unit-<pid>-<id>), not "${NAME}"`);
  process.exit(1);
}
if (REUSE && spawnSync('docker', ['inspect', '-f', '{{index .Config.Labels "crx-prover"}}', NAME], { encoding: 'utf8' }).stdout.trim() !== 'order-unit') {
  console.error(`CRX_PROVER_REUSE_CONTAINER "${NAME}" is not labelled crx-prover=order-unit; refusing to touch it`);
  process.exit(1);
}
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261230100000_blank_unit_fill_and_post_refusal.sql');
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
  '20261105170000_data11_preferred_vendor_links.sql',
  // KI-01 part C (#1650) changes job and storage access only; its preflight needs live's storage.objects policies,
  // which this database does not have (the staff photo storage files are parked above). Its own proof is
  // prove-job-access-ends-with-the-job-real-schema.mjs; same approach as prove-close-delivery-receipt-real-schema.mjs.
  '20261217100000_job_access_ends_with_the_job.sql',
  // Its KI-73 follow-up (applicator spray-record fields) needs part C applied; same reason.
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

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
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
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
  docker(['run', '-d', '--name', NAME, '--label', 'crx-prover=order-unit', '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
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
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    // BLK-1a's preflight needs the count units live already has.
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql("INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Ea', 1, 'both'), ('Unit', 1, 'both') ON CONFLICT DO NOTHING;");
    }
    // RT-1's preflight pins live's unit_conversions (read-only, 2026-11-09); the baseline carries only Ea and Unit.
    if (base === '20261229110000_product_rates_draft.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('fl oz', 1, 'liquid'), ('oz', 1, 'liquid'),
        ('Oz', 1, 'liquid'), ('Pt', 16, 'liquid'), ('qt', 32, 'liquid'), ('Qt', 32, 'liquid'), ('Gal', 128, 'liquid'), ('Dry oz', 1, 'dry'),
        ('Lb', 16, 'dry'), ('LB', 16, 'dry'), ('g', 0.03527396, 'dry'), ('MG', 0.00003527396, 'dry') ON CONFLICT DO NOTHING;`);
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}



const id = (n) => `12300000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
const CUST = id('c1');
const PROD = id('f1');
const PROD_NO = id('f2');
// Order side: one delivered order per order-line unit: NULL (the KI-76 case), '' and 'gal' (billed as before).
const CASES = { null: [id('e1'), id('e11'), 'NULL'], empty: [id('e3'), id('e31'), "E' \t'"], gal: [id('e2'), id('e21'), "'gal'"] };
// A two-line order: one 'gal' line and one line with no unit (named "[PROVER] No Unit").
const MIXED = id('e4'); const MIXED_GAL = id('e41'); const MIXED_BLANK = id('e42');
// Delivery side: order line written before the candidate with no unit (an existing legacy line).
const LEGACY = id('e5'); const LEGACY_LINE = id('e51');
// ...and one written before the candidate with an empty-text unit, delivered as empty text: today it credits.
const LEGACY_E = id('e6'); const LEGACY_E_LINE = id('e61');
const NO_PROOF_SIGNER = 'No proof — recorded by office';
// Delivery cases: [order, line, delivery, product, order-line unit, delivery-line unit, line inserted in the probe?]
const DCASES = {
  fill: [id('d1'), id('d11'), id('d12'), PROD, 'NULL', 'NULL', true],
  nounit: [id('d2'), id('d21'), id('d22'), PROD_NO, 'NULL', 'NULL', true],
  tab: [id('d5'), id('d51'), id('d52'), PROD, "E'\t'", "E'\t'", true],
  gal: [id('d3'), id('d31'), id('d32'), PROD, "'gal'", "'gal'", true],
  legacy: [LEGACY, LEGACY_LINE, id('d42'), PROD, null, 'NULL', false],
  legacyempty: [LEGACY_E, LEGACY_E_LINE, id('d62'), PROD, null, "''", false],
  // Hand-replaced draft line (order link and unit cleared, as a draft edit can): product with a unit / without.
  handgal: [id('d7'), id('d71'), id('d72'), PROD, "'gal'", "'gal'", true],
  handno: [id('d8'), id('d81'), id('d82'), PROD_NO, 'NULL', 'NULL', true],
};

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
// Inside a rolled-back probe only: no order passes the delivered cap today (KI-76 contract), so the
// order-side probes switch it off to reach the unit check.
const CAP_OFF = `ALTER TABLE public.invoice_items DISABLE TRIGGER zz_cap_order_invoice_items;
ALTER TABLE public.invoices DISABLE TRIGGER zz_cap_order_invoice_header;`;
function seed() {
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ou-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'ou-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb) ON CONFLICT DO NOTHING;`);
  // Test setup only: replica mode skips the profile and pricing triggers so the rows go in as written.
  // Re-runnable (ON CONFLICT) so CRX_PROVER_REUSE_CONTAINER can reuse a replayed database.
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true, created_at = now() - interval '10 minutes' WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true, created_at = now() - interval '10 minutes' WHERE id = '${REP}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Unit Farm', true) ON CONFLICT DO NOTHING;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, is_active) VALUES
      ('${PROD}', '[PROVER] Herbicide', 'gal', 6, 10, 'liquid', true),
      ('${PROD_NO}', '[PROVER] Unitless', NULL, 6, 10, 'liquid', true)
      ON CONFLICT (id) DO UPDATE SET unit_size = EXCLUDED.unit_size;
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES
      ('${PROD}', 'Main Warehouse', 100, 0, 'gal'), ('${PROD_NO}', 'Main Warehouse', 100, 0, 'gal') ON CONFLICT DO NOTHING;
    INSERT INTO public.orders (id, order_number, customer_id, salesman_id, order_date, status) VALUES
      ${Object.entries(CASES).map(([k, [o]]) => `('${o}', 'PROVER-OU-${k}', '${CUST}', '${REP}', current_date, 'confirmed')`).join(',\n      ')},
      ('${MIXED}', 'PROVER-OU-mixed', '${CUST}', '${REP}', current_date, 'confirmed'),
      ('${LEGACY}', 'PROVER-DU-legacy', '${CUST}', '${REP}', current_date, 'confirmed'),
      ('${LEGACY_E}', 'PROVER-DU-legacyempty', '${CUST}', '${REP}', current_date, 'confirmed')
      ON CONFLICT (id) DO UPDATE SET salesman_id = EXCLUDED.salesman_id;
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
        total_units_needed, total_price, quantity_delivered, quantity_remaining, sort_order) VALUES
      ${Object.values(CASES).map(([o, l, u]) => `('${l}', '${o}', '${PROD}', '[PROVER] Herbicide', ${u}, 10, 6, 2, 20, 2, 0, 0)`).join(',\n      ')},
      ('${MIXED_GAL}', '${MIXED}', '${PROD}', '[PROVER] Herbicide', 'gal', 10, 6, 2, 20, 2, 0, 0),
      ('${MIXED_BLANK}', '${MIXED}', '${PROD}', '[PROVER] No Unit', NULL, 10, 6, 1, 10, 1, 0, 1),
      ('${LEGACY_LINE}', '${LEGACY}', '${PROD}', '[PROVER] Herbicide', NULL, 10, 6, 2, 20, 0, 2, 0),
      ('${LEGACY_E_LINE}', '${LEGACY_E}', '${PROD}', '[PROVER] Herbicide', '', 10, 6, 2, 20, 0, 2, 0)
      ON CONFLICT (id) DO UPDATE SET unit_size = EXCLUDED.unit_size;`);
  assert.equal(scalar(`SELECT string_agg(coalesce('[' || unit_size || ']', '<null>'), ',' ORDER BY id) FROM public.order_items
    WHERE order_id IN (${Object.values(CASES).map(([o]) => `'${o}'`).join(',')});`), '<null>,[gal],[ \t]');
}
// Order side, as the signed-in user (the API role), rolled back: invoice the order. Returns { unit } (the
// invoice line's unit) or { error } (the first error token). A return needs a completed delivery, which an
// order billed this way cannot have, so the return side is proved on the delivery path.
function flow(kind, uid = REP) {
  const [order, line] = CASES[kind];
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;
${CAP_OFF}
${claims(uid)}
SET LOCAL ROLE authenticated;
DO $flow$
DECLARE v_inv uuid; v_return uuid;
BEGIN
  v_inv := public.create_invoice_from_order('${order}', NULL, 'chemical_sale', gen_random_uuid()::text);
  RAISE NOTICE 'UNIT=[%]', (SELECT coalesce(unit_size, '<null>') FROM public.invoice_items WHERE invoice_id = v_inv);
END;
$flow$;
RESET ROLE;
ROLLBACK;` });
  const out = `${r.stdout}\n${r.stderr}`;
  const unit = /UNIT=\[([^\]]*)\]/.exec(out)?.[1];
  if (unit !== undefined) return { unit };
  return { error: /ERROR:\s+([A-Z_]+)/.exec(out)?.[1] ?? out.trim().slice(0, 600) };
}
// The two-line order, as the rep, rolled back: refused with a readable message naming the blank line and
// nothing written (no invoice, line, audit, feed or receipt); once the line has a unit, the SAME key bills it.
function mixed() {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;
${CAP_OFF}
${claims(REP)}
CREATE TEMP TABLE k ON COMMIT DROP AS SELECT gen_random_uuid()::text AS key;
GRANT SELECT ON k TO authenticated;
SET LOCAL ROLE authenticated;
DO $m$
BEGIN
  PERFORM public.create_invoice_from_order('${MIXED}', NULL, 'chemical_sale', (SELECT key FROM k));
  RAISE NOTICE 'MIXED_NOT_REFUSED';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'MIXED_MSG=[%]', SQLERRM;
END;
$m$;
RESET ROLE;
SELECT 'WRITTEN=' || (SELECT count(*) FROM public.invoices WHERE order_id = '${MIXED}')
  || ',' || (SELECT count(*) FROM public.financial_audit_log WHERE description LIKE '%PROVER-OU-mixed%')
  || ',' || (SELECT count(*) FROM public.activity_feed WHERE description LIKE '%PROVER-OU-mixed%')
  || ',' || (SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = (SELECT key FROM k));
UPDATE public.order_items SET unit_size = 'gal' WHERE id = '${MIXED_BLANK}';
${claims(REP)}
SET LOCAL ROLE authenticated;
-- Create first, read in a later statement: a query that creates the rows cannot see them in its own snapshot.
SELECT set_config('crx.prover_inv', public.create_invoice_from_order('${MIXED}', NULL, 'chemical_sale', (SELECT key FROM k))::text, true);
RESET ROLE;
SELECT 'RETRY=' || (SELECT string_agg(ii.unit_size || ':' || ii.quantity::float8, ',' ORDER BY ii.sort_order)
  FROM public.invoice_items ii WHERE ii.invoice_id = current_setting('crx.prover_inv')::uuid);
ROLLBACK;` });
  const out = `${r.stdout}\n${r.stderr}`;
  return { message: /MIXED_MSG=\[(.*)\]\s*$/m.exec(out)?.[1], written: /WRITTEN=(\S+)/.exec(out)?.[1], retry: /RETRY=(\S+)/.exec(out)?.[1],
    raw: /MIXED_NOT_REFUSED|ERROR:.*/.exec(out)?.[0] };
}
// Delivery side, rolled back. Setup rows are written as the database owner with every trigger on (so the
// candidate's order-line fill runs on a new line); complete_delivery, post_invoice and the return run as the
// signed-in admin through the API role. Returns what each step saw:
//  { order: order-line unit, done: delivery completed, unit: draft invoice line unit, post: 'posted' | error,
//    fixed: { unit, post } after the product gets a unit and the draft is saved, credit: credit memo | error }
function deliver(kind, { fix = false, unlink = false } = {}) {
  const [order, line, del, prod, orderUnit, deliveryUnit, fresh] = DCASES[kind];
  const setup = fresh ? `INSERT INTO public.orders (id, order_number, customer_id, salesman_id, order_date, status)
  VALUES ('${order}', 'PROVER-DU-${kind}', '${CUST}', '${REP}', current_date, 'confirmed');
INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
    total_units_needed, total_price, quantity_delivered, quantity_remaining, sort_order)
  VALUES ('${line}', '${order}', '${prod}', '[PROVER] DU ${kind}', ${orderUnit}, 10, 6, 2, 20, 0, 2, 0);` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;
${claims(ADMIN)}
${setup}
INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, scheduled_date, status, created_by, is_quick_delivery)
  VALUES ('${del}', 'PROVER-DU-${kind}', '${order}', '${CUST}', CURRENT_DATE, 'scheduled', '${ADMIN}', false);
INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
  VALUES ('${del}', '${line}', '${prod}', 2, 0, ${deliveryUnit});
UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${del}';
SELECT 'ORDER=' || coalesce('[' || unit_size || ']', '<null>') FROM public.order_items WHERE id = '${line}';
SET LOCAL ROLE authenticated;
SELECT 'DONE=' || (public.complete_delivery(p_delivery_id => '${del}', p_signed_by => '${NO_PROOF_SIGNER}', p_performed_by => '${ADMIN}',
  p_idempotency_key => gen_random_uuid()::text, p_evidence => 'no_proof', p_evidence_ref => '[PROVER] fixture') IS NOT NULL)::text;
RESET ROLE;
SELECT 'STATUS=' || status FROM public.deliveries WHERE id = '${del}';
${unlink ? `UPDATE public.invoice_items SET order_item_id = NULL, unit_size = NULL
  WHERE invoice_id = (SELECT id FROM public.invoices WHERE delivery_id = '${del}');` : ''}
CREATE TEMP TABLE v ON COMMIT DROP AS SELECT id, public._invoice_post_version(id) AS ver FROM public.invoices WHERE delivery_id = '${del}';
GRANT SELECT ON v TO authenticated;
SELECT 'UNIT=' || coalesce('[' || ii.unit_size || ']', '<null>') FROM public.invoice_items ii WHERE ii.invoice_id = (SELECT id FROM v);
SET LOCAL ROLE authenticated;
DO $p$
BEGIN
  PERFORM public.post_invoice((SELECT id FROM v), (SELECT ver FROM v), gen_random_uuid()::text);
  RAISE NOTICE 'POST=[posted]';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'POST=[%]', SQLERRM;
END;
$p$;
RESET ROLE;
${fix ? `-- An admin sets the product unit (the Products page).
UPDATE public.products SET unit_size = 'gal' WHERE id = '${prod}';
-- Saving the draft writes its lines again (save_invoice sends each line's unit).
UPDATE public.invoice_items SET unit_size = NULL WHERE invoice_id = (SELECT id FROM v);
UPDATE v SET ver = public._invoice_post_version(id);
SELECT 'FIXUNIT=' || coalesce('[' || ii.unit_size || ']', '<null>') FROM public.invoice_items ii WHERE ii.invoice_id = (SELECT id FROM v);
SET LOCAL ROLE authenticated;
DO $p$
BEGIN
  PERFORM public.post_invoice((SELECT id FROM v), (SELECT ver FROM v), gen_random_uuid()::text);
  RAISE NOTICE 'FIXPOST=[posted]';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'FIXPOST=[%]', SQLERRM;
END;
$p$;
RESET ROLE;` : ''}
SET LOCAL ROLE authenticated;
DO $c$
DECLARE v_return uuid;
BEGIN
  v_return := (public.create_return(jsonb_build_object('customer_id', '${CUST}', 'order_id', '${order}', 'reason', 'defective'),
    jsonb_build_array(jsonb_build_object('order_item_id', '${line}', 'quantity', 1, 'condition', 'damaged', 'restock', false)),
    gen_random_uuid()::text)->>'return_id')::uuid;
  PERFORM public.approve_return(v_return, '${ADMIN}', gen_random_uuid()::text);
  PERFORM public.receive_return(v_return, '${ADMIN}', gen_random_uuid()::text);
  PERFORM public.issue_return_credit(v_return, '${ADMIN}', gen_random_uuid()::text);
  RAISE NOTICE 'CREDIT=[%]', (SELECT i.status || ' ' || ii.quantity::float8 || ' ' || coalesce(ii.unit_size, '<null>') || ' ' || ii.extended_cents
    FROM public.returns r JOIN public.invoices i ON i.id = r.credit_invoice_id JOIN public.invoice_items ii ON ii.invoice_id = i.id
    WHERE r.id = v_return AND i.invoice_type = 'credit_memo');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CREDIT=[%]', split_part(SQLERRM, ':', 1);
END;
$c$;
RESET ROLE;
ROLLBACK;` });
  const out = `${r.stdout}\n${r.stderr}`;
  const get = (k) => new RegExp(`\\b${k}=\\[(.*)\\]\\s*$`, 'm').exec(out)?.[1] ?? new RegExp(`\\b${k}=(<null>)`).exec(out)?.[1];
  const res = { order: get('ORDER'), done: `${/DONE=(\S+)/.exec(out)?.[1]} ${/STATUS=(\S+)/.exec(out)?.[1]}`, unit: get('UNIT'), post: get('POST') };
  if (fix) res.fixed = { unit: get('FIXUNIT'), post: get('FIXPOST') };
  res.credit = get('CREDIT');
  if (res.post === undefined || res.credit === undefined) res.raw = /ERROR:.*/.exec(out)?.[0] ?? out.trim().slice(0, 800);
  return res;
}
const FN = 'public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)';
const md5 = () => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${FN}'::regprocedure;`);
const settings = () => scalar(`SELECT prosecdef::text || ' ' || array_to_string(proconfig, ',') || ' ' || pg_get_userbyid(proowner) || ' '
  || coalesce(proacl::text, '<default>') FROM pg_proc WHERE oid = '${FN}'::regprocedure;`);
const NEW_FNS = "('_fill_order_line_unit', '_fill_invoice_line_unit', '_refuse_post_blank_unit_line')";
const newFnAcl = () => scalar(`SELECT string_agg(proname || ' ' || prosecdef::text || ' ' || array_to_string(proconfig, ',') || ' '
  || has_function_privilege('anon', oid, 'EXECUTE')::text || has_function_privilege('authenticated', oid, 'EXECUTE')::text
  || has_function_privilege('service_role', oid, 'EXECUTE')::text, '; ' ORDER BY proname) FROM pg_proc WHERE proname IN ${NEW_FNS};`);

function main() {
  if (!REUSE) buildContainer();
  assert.equal(md5(), '454e04c4e199549a4f5be9975e397e17', "before the candidate the body must be live's");
  // KI-76's season item: both summaries read only the Chicago date (20261204110000) and no later file undoes it.
  for (const fn of ['public.get_customer_summary(uuid)', 'public.operational_dashboard_summary()']) {
    const check = (expr) => scalar(`SELECT (${expr})::text FROM pg_proc WHERE oid = '${fn}'::regprocedure;`);
    assert.equal(check("lower(prosrc) ~ 'current_date|localtimestamp|now\\(\\)(?! at time zone)'"), 'false', `${fn} reads a UTC date`);
    assert.equal(check("prosrc LIKE '%America/Chicago%'"), 'true', `${fn} must read the Chicago date`);
  }
  console.log('[prover] season item: get_customer_summary and operational_dashboard_summary read only the Chicago date');
  seed();
  const settingsBefore = settings();

  const dBefore = { fill: deliver('fill'), tab: deliver('tab'), nounit: deliver('nounit'), gal: deliver('gal'), legacy: deliver('legacy'), legacyempty: deliver('legacyempty'),
    handgal: deliver('handgal', { unlink: true }), handno: deliver('handno', { unlink: true }) };
  console.log(`[prover] BEFORE delivery side: ${JSON.stringify(dBefore)}`);
  assert.deepEqual(dBefore.fill, { order: '<null>', done: 'true completed', unit: '<null>', post: 'posted', credit: 'RETURN_CREDIT_UNIT_MISMATCH' },
    'BEFORE: a delivered line with no unit is invoiced blank, posts, and its return credit is refused');
  assert.equal(dBefore.tab.post, 'posted', 'BEFORE: a tab-only unit posts');
  assert.equal(dBefore.nounit.post, 'posted', 'BEFORE: a unitless product line posts blank');
  assert.equal(dBefore.legacy.post, 'posted', 'BEFORE: an existing no-unit line posts blank');
  assert.deepEqual(dBefore.legacyempty, { order: '', done: 'true completed', unit: '', post: 'posted', credit: 'posted -1  -1000' },
    'BEFORE: an existing empty-text order line and its empty-text invoice line match, so the return is credited');
  assert.deepEqual([dBefore.handgal.unit, dBefore.handgal.post, dBefore.handno.unit, dBefore.handno.post], ['<null>', 'posted', '<null>', 'posted'],
    'BEFORE: a hand-replaced draft line with no order link and no unit posts blank');
  assert.deepEqual(dBefore.gal, { order: 'gal', done: 'true completed', unit: 'gal', post: 'posted', credit: 'posted -1 gal -1000' });
  const before = Object.fromEntries(Object.keys(CASES).map((k) => [k, flow(k)]));
  console.log(`[prover] BEFORE order side: ${JSON.stringify(before)}`);
  assert.deepEqual(before, { null: { unit: '<null>' }, empty: { unit: ' \t' }, gal: { unit: 'gal' } }, 'BEFORE: each line is billed with its unit as is, blank included');
  const mixedBefore = mixed();
  assert.equal(mixedBefore.raw, 'MIXED_NOT_REFUSED', `BEFORE: the two-line order is billed: ${JSON.stringify(mixedBefore)}`);

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /PREFLIGHT_ORDER_INVOICE_UNIT_DRIFT/);
  assert.equal(settings(), settingsBefore, 'SECURITY DEFINER, search_path, owner and grants unchanged');
  assert.equal(newFnAcl(), ['_fill_invoice_line_unit', '_fill_order_line_unit', '_refuse_post_blank_unit_line']
    .map((n) => `${n} true search_path=public, pg_temp falsefalsefalse`).join('; '), 'new trigger functions: definer, pinned path, no API execute');
  console.log(`[prover] candidate applied once (body md5 ${md5()}); a second apply refuses at the preflight; settings and grants unchanged (${settingsBefore})`);

  const dAfter = { fill: deliver('fill'), tab: deliver('tab'), nounit: deliver('nounit', { fix: true }), gal: deliver('gal'), legacy: deliver('legacy'), legacyempty: deliver('legacyempty'),
    handgal: deliver('handgal', { unlink: true }), handno: deliver('handno', { unlink: true }) };
  console.log(`[prover] AFTER delivery side: ${JSON.stringify(dAfter)}`);
  const GOOD = { order: 'gal', done: 'true completed', unit: 'gal', post: 'posted', credit: 'posted -1 gal -1000' };
  assert.deepEqual(dAfter.fill, GOOD, 'AFTER: a new line with no unit takes the product unit; the invoice line carries it, posts and is credited');
  assert.deepEqual(dAfter.tab, GOOD, 'AFTER: a tab-only unit counts as blank and is filled the same way');
  const n = dAfter.nounit;
  assert.equal(n.done, 'true completed', 'AFTER: a line no unit can be found for STILL completes the delivery');
  assert.equal(n.unit, '<null>', 'AFTER: its draft line keeps no unit');
  assert.match(n.post ?? '', /^INVOICE_LINE_UNIT_MISSING: invoice \S+ has a line with no unit \(\[PROVER\] DU nounit\)\. Set the unit on the product, save the draft invoice, then post it again$/,
    'AFTER: posting it is refused with a message staff can act on');
  assert.deepEqual(n.fixed, { unit: 'gal', post: 'posted' }, 'AFTER: once the product has a unit and the draft is saved, it posts');
  assert.equal(n.credit, 'RETURN_CREDIT_UNIT_MISMATCH', 'AFTER: its return stays refused (the order line has no unit), as today');
  assert.deepEqual(dAfter.legacy, { order: '<null>', done: 'true completed', unit: 'gal', post: 'posted', credit: 'RETURN_CREDIT_UNIT_MISMATCH' },
    'AFTER: an existing order line with no unit invoices with the product unit and posts; its return stays refused, as today');
  assert.deepEqual(dAfter.gal, dBefore.gal, 'AFTER: a line with a unit is unchanged');
  assert.deepEqual(dAfter.legacyempty, { order: '', done: 'true completed', unit: 'gal', post: 'posted', credit: 'RETURN_CREDIT_UNIT_MISMATCH' },
    'AFTER (Mason 2026-11-10, no sale line posts without a unit): an existing empty-text line takes the product unit and posts; its return reads the empty order line and is refused');
  assert.deepEqual([dAfter.handgal.unit, dAfter.handgal.post], ['gal', 'posted'], 'AFTER: a hand-replaced line with no unit takes its product unit and posts');
  assert.equal(dAfter.handno.unit, '<null>', 'AFTER: a hand-replaced line whose product has no unit stays blank');
  assert.match(dAfter.handno.post ?? '', /^INVOICE_LINE_UNIT_MISSING: invoice \S+ has a line with no unit \(\[PROVER\] DU handno\)/,'AFTER: posting it is refused');

  const after = Object.fromEntries(Object.keys(CASES).map((k) => [k, flow(k)]));
  console.log(`[prover] AFTER order side: ${JSON.stringify(after)}`);
  assert.deepEqual(after.null, { error: 'ORDER_LINE_UNIT_MISSING' }, 'AFTER: a line with no unit is refused');
  assert.deepEqual(after.empty, { error: 'ORDER_LINE_UNIT_MISSING' }, 'AFTER: a space-and-tab unit is refused');
  assert.deepEqual(after.gal, before.gal, "AFTER: a 'gal' line is billed exactly as before");
  assert.deepEqual(flow('gal', ADMIN), before.gal, 'AFTER: the same for an admin');
  const m = mixed();
  console.log(`[prover] AFTER two-line order: ${JSON.stringify(m)}`);
  assert.equal(m.message, 'ORDER_LINE_UNIT_MISSING: order PROVER-OU-mixed has a line with no unit ([PROVER] No Unit). '
    + "Set each line's unit on the order, then create the invoice again");
  assert.equal(m.written, '0,0,0,0', 'a refused order writes no invoice, audit row, feed row or receipt');
  assert.equal(m.retry, 'gal:2,gal:1', 'once the line has a unit, the same key bills both lines');
  console.log('ORDER_INVOICE_BLANK_UNIT_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
