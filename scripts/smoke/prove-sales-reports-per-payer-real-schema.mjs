#!/usr/bin/env node
/**
 * Real-schema proof for 20261228100000 (sales reports show each payer's share of a Bill Split sale).
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays migrations up to
 * the candidate, reads Sales Detail, Sales Summary and the dashboard as an admin and a rep on invented sales,
 * applies the candidate (a second apply refuses), reads them again and checks:
 *   - a $1,000 sale with a 40% landlord on the card: farmer $600 / 60 units, landlord $400 / 40 units, cost
 *     and profit split the same way, and each payer's row shows that payer's own invoice;
 *   - a card naming the main customer too, and a line with its own three-way shares on cents that don't
 *     divide (100.02): payers add up to each line exactly (dollars, quantity, cost);
 *   - an unsplit sale's rows are byte-for-byte what they were;
 *   - every total (detail, each summary grouping, dashboard headline and trend, product lists) is unchanged;
 *     "by product" rows are identical; "by customer" credits each payer; the customer filter finds a payer;
 *   - a rep gets the same rows with cost, profit and margin empty; the helper is callable by no API role.
 *
 * Run: node scripts/smoke/prove-sales-reports-per-payer-real-schema.mjs   (needs local Docker image)
 * Prints SALES_REPORTS_PER_PAYER_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-sales-payer-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
if (REUSE && !/^crx-sales-payer-\d+-[0-9a-z]+$/.test(NAME)) {
  console.error(`CRX_PROVER_REUSE_CONTAINER must name a container this prover created (crx-sales-payer-<pid>-<id>), not "${NAME}"`);
  process.exit(1);
}
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261228100000_sales_reports_per_payer.sql');
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
const TOUCHED = /(_sales_line_payers|_get_sales_detail_report_cost_impl_20261019|_get_sales_summary_report_cost_impl_20261019|financial_dashboard_summary|_bill_split_line_shares|_order_has_bill_split)/i;
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
  docker(['run', '-d', '--name', NAME, '--label', 'crx-prover=sales-payer', '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}


const id = (n) => `12280000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
const FARM = id('c1'); const LAND = id('c2'); const THIRD = id('c3');
const P = id('f1'); const P2 = id('f2');
const O1 = id('e1'); const O1A = id('e11');                        // $1,000, card: landlord 40%
const O2 = id('e2'); const O2A = id('e21'); const O2B = id('e22'); // card: farmer 60 + landlord 40; line A has its own shares
const O3 = id('e3'); const O3A = id('e31');                        // unsplit
const INV_F = id('d1'); const INV_L = id('d2'); const INV_X = id('d3');

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function q(sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: true });
  return { status: r.status, out: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '', err: r.stderr };
}
// One read as a signed-in user; returns its single-line answer.
function as(uid, sql) {
  const r = q(`BEGIN;\n${claims(uid)}\nSET LOCAL ROLE authenticated;\n${sql};\nCOMMIT;`);
  assert.equal(r.status, 0, r.err);
  return r.out;
}

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'sp-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'sp-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  // Test setup only: replica mode skips the share and profile triggers so the rows go in as written.
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES
      ('${FARM}', '[PROVER] Farmer', true), ('${LAND}', '[PROVER] Landlord', true), ('${THIRD}', '[PROVER] Third', true);
    INSERT INTO public.products (id, product_name, sku, unit_size, current_cost, tier1_price, is_active) VALUES
      ('${P}', '[PROVER] Herbicide', 'SP-1', 'GL', 6.00, 10.00, true),
      ('${P2}', '[PROVER] Adjuvant', 'SP-2', 'GL', 1.11, 33.34, true);
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id) VALUES
      ('${O1}', 'PROVER-SP-1', '${FARM}', current_date, 'confirmed', false, '${REP}'),
      ('${O2}', 'PROVER-SP-2', '${FARM}', current_date, 'confirmed', false, '${REP}'),
      ('${O3}', 'PROVER-SP-3', '${THIRD}', current_date, 'confirmed', false, '${REP}');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit, cost_at_time_cents,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining) VALUES
      ('${O1A}', '${O1}', '${P}', '[PROVER] Herbicide', 10, 6, NULL, 100, 1000, 400, 40, 0, 100),
      ('${O2A}', '${O2}', '${P2}', '[PROVER] Adjuvant', 33.34, 1.111, NULL, 3, 100.02, 96.69, 96, 0, 3),
      ('${O2B}', '${O2}', '${P}', '[PROVER] Herbicide', 10, 6, 655, 5, 50, 17.25, 34, 0, 5),
      ('${O3A}', '${O3}', '${P}', '[PROVER] Herbicide', 10, 6, NULL, 20, 200, 80, 40, 0, 20);
    INSERT INTO public.order_shares (order_id, customer_id, customer_name, split_percentage, amount_cents) VALUES
      ('${O1}', '${LAND}', '[PROVER] Landlord', 40, 40000),
      ('${O2}', '${FARM}', '[PROVER] Farmer', 60, 9000),
      ('${O2}', '${LAND}', '[PROVER] Landlord', 40, 6000);
    INSERT INTO public.order_item_shares (order_item_id, customer_id, split_percentage) VALUES
      ('${O2A}', '${LAND}', 33.333333), ('${O2A}', '${THIRD}', 33.333333);
    INSERT INTO public.invoices (id, invoice_number, customer_id, status, invoice_type, created_at, created_by) VALUES
      ('${INV_F}', 'PROVER-INV-F', '${FARM}', 'draft', 'chemical_sale', now() - interval '2 minutes', '${ADMIN}'),
      ('${INV_L}', 'PROVER-INV-L', '${LAND}', 'draft', 'chemical_sale', now() - interval '1 minute', '${ADMIN}'),
      ('${INV_X}', 'PROVER-INV-X', '${THIRD}', 'draft', 'chemical_sale', now(), '${ADMIN}');
    INSERT INTO public.invoice_items (invoice_id, order_item_id) VALUES
      ('${INV_F}', '${O1A}'), ('${INV_L}', '${O1A}'), ('${INV_X}', '${O3A}');`);
}

const MINE = "order_number LIKE 'PROVER-SP-%'";
const detail = (uid, args = '') => as(uid, `SELECT coalesce(string_agg(concat_ws('|', order_number, product_name, customer_name, quantity, total_price,
    coalesce(cost::text, '-'), coalesce(profit::text, '-'), coalesce(margin_pct::text, '-'), coalesce(invoice_number, '-')),
    ';' ORDER BY order_number, product_name, customer_name), '')
  FROM public.get_sales_detail_report(${args}) WHERE ${MINE}`);
const detailTotals = (uid) => as(uid, `SELECT count(DISTINCT order_number) || '|' || sum(quantity) || '|' || sum(total_price)
    || '|' || coalesce(sum(cost)::text, '-') || '|' || coalesce(sum(profit)::text, '-')
  FROM public.get_sales_detail_report()`);
const summary = (uid, by) => as(uid, `SELECT string_agg(concat_ws('|', group_key, total_quantity, total_revenue, coalesce(total_cost::text, '-'),
    coalesce(total_profit::text, '-'), coalesce(margin_pct::text, '-'), order_count, line_count), ';' ORDER BY group_key)
  FROM public.get_sales_summary_report(p_group_by => '${by}')`);
const summaryTotals = (uid, by) => as(uid, `SELECT sum(total_quantity) || '|' || sum(total_revenue) || '|' || coalesce(sum(total_cost)::text, '-')
    || '|' || sum(line_count)
  FROM public.get_sales_summary_report(p_group_by => '${by}')`);
const dash = (key) => as(ADMIN, `SELECT (public.financial_dashboard_summary() -> '${key}')::text`);
const DASH_SAME = ['total_revenue', 'total_profit', 'overall_margin', 'monthly_revenue', 'bottom_products_by_margin', 'monthly_margin_trend'];
const GROUPINGS = ['product', 'customer', 'sales_rep', 'month', 'category'];

function main() {
  if (!REUSE) buildContainer();
  else {
    const seen = docker(['inspect', '-f', '{{index .Config.Labels "crx-prover"}} {{.HostConfig.NetworkMode}}', NAME]).stdout.trim();
    if (seen !== 'sales-payer none') throw new Error(`refusing to reuse ${NAME}: not a container this prover built (${seen})`);
  }
  seed();

  const before = {
    detail: detail(ADMIN), totals: detailTotals(ADMIN), repTotals: detailTotals(REP),
    summaries: Object.fromEntries(GROUPINGS.map((by) => [by, summary(ADMIN, by)])),
    summaryTotals: Object.fromEntries(GROUPINGS.map((by) => [by, summaryTotals(ADMIN, by)])),
    dash: Object.fromEntries(DASH_SAME.map((k) => [k, dash(k)])),
  };
  // Before: the whole $1,000 sits under the farmer (its newest invoice is the landlord's).
  assert.match(before.detail, /PROVER-SP-1\|\[PROVER\] Herbicide\|\[PROVER\] Farmer\|100\|1000\.00\|600\.00\|400\.00\|40\.0\|PROVER-INV-L/, before.detail);
  assert.doesNotMatch(before.detail, /Landlord/);
  console.log('[prover] before the candidate a split sale sits wholly under the main customer');

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /SALES_REPORTS_PER_PAYER_PREFLIGHT/);
  console.log('[prover] candidate applied once; a second apply refuses at the preflight');

  const after = detail(ADMIN).split(';');
  const expected = [
    // $1,000 sale, landlord 40% on the card: 600/400, 60/40 units, cost 360/240; each payer's own invoice.
    'PROVER-SP-1|[PROVER] Herbicide|[PROVER] Farmer|60.0000000000000000|600.00|360.00|240.00|40.0|PROVER-INV-F',
    'PROVER-SP-1|[PROVER] Herbicide|[PROVER] Landlord|40.0000000000000000|400.00|240.00|160.00|40.0|PROVER-INV-L',
    // Own shares (33.333333% landlord, 33.333333% third): 100.02 -> 33.33 + 33.33, farmer the rest 33.36;
    // 3 units -> 0.99 + 0.99, farmer 1.02; cost 3.33 -> floor(1.111 x 0.99) = 1.09 each, farmer 1.15.
    'PROVER-SP-2|[PROVER] Adjuvant|[PROVER] Farmer|1.02000000000000000000|33.36|1.15|32.21|96.6|-',
    'PROVER-SP-2|[PROVER] Adjuvant|[PROVER] Landlord|0.99000000000000000000|33.33|1.09|32.24|96.7|-',
    'PROVER-SP-2|[PROVER] Adjuvant|[PROVER] Third|0.99000000000000000000|33.33|1.09|32.24|96.7|-',
    // Card naming the farmer 60 and landlord 40: $50 -> 30/20, 5 units -> 3/2, cost 32.75 -> landlord 13.10, farmer 19.65.
    'PROVER-SP-2|[PROVER] Herbicide|[PROVER] Farmer|3.0000000000000000|30.00|19.65|10.35|34.5|-',
    'PROVER-SP-2|[PROVER] Herbicide|[PROVER] Landlord|2.0000000000000000|20.00|13.10|6.90|34.5|-',
  ];
  // Quantities: compare by value, not by how many zeros numeric prints.
  const norm = (row) => row.split('|').map((v, i) => (i === 3 ? String(Number(v)) : v)).join('|');
  const afterN = after.map(norm);
  for (const row of expected) assert.ok(afterN.includes(norm(row)), `missing row ${row}\nin\n${after.join('\n')}`);
  const unsplit = (rows) => rows.filter((r) => r.startsWith('PROVER-SP-3|'));
  assert.equal(unsplit(after).length, 1);
  assert.deepEqual(unsplit(after), unsplit(before.detail.split(';')), 'the unsplit sale is byte-for-byte what it was');
  assert.equal(after.length, expected.length + 1);
  console.log('[prover] each payer gets their share; payers add up to each line; an unsplit sale is unchanged');

  const sum = (rows, i) => rows.filter((r) => r.startsWith('PROVER-SP-2|[PROVER] Adjuvant')).reduce((s, r) => s + Math.round(Number(r.split('|')[i]) * 100), 0);
  assert.deepEqual([sum(after, 3), sum(after, 4), sum(after, 5)], [300, 10002, 333], 'payers add up to the line exactly');

  // Split quantities carry four decimals (128.0000 vs 128): compare by value, the app reads numbers.
  const numeric = (s) => s.replace(/-?\d+\.\d+/g, (v) => String(Number(v)));
  assert.equal(numeric(detailTotals(ADMIN)), numeric(before.totals), 'detail totals unchanged');
  assert.equal(numeric(detailTotals(REP)), numeric(before.repTotals), 'rep detail totals unchanged');
  // "By customer" credits a split line to each payer, so its summed line count is per payer (1 x2, 1 x3, 1 x2, 1 = 8).
  for (const by of GROUPINGS) {
    const want = by === 'customer' ? before.summaryTotals[by].replace(/\|\d+$/, '|8') : before.summaryTotals[by];
    assert.equal(numeric(summaryTotals(ADMIN, by)), numeric(want), `summary ${by} totals unchanged`);
  }
  for (const by of ['product', 'sales_rep', 'month', 'category']) assert.equal(numeric(summary(ADMIN, by)), numeric(before.summaries[by]), `summary by ${by} rows unchanged`);
  for (const k of DASH_SAME) assert.equal(dash(k), before.dash[k], `dashboard ${k} unchanged`);
  console.log('[prover] every total is unchanged: detail, each summary grouping, dashboard headline, trends and product list');

  const byCustomer = summary(ADMIN, 'customer').split(';').map((r) => r.split('|'));
  const cust = (name) => byCustomer.find((r) => r[0] === name);
  // Farmer 600 + 33.36 + 30 = 663.36; landlord 400 + 33.33 + 20 = 453.33; third 33.33 + 200 = 233.33.
  assert.deepEqual(cust('[PROVER] Farmer').slice(2, 5), ['663.36', '380.80', '282.56']);
  assert.deepEqual(cust('[PROVER] Landlord').slice(2, 5), ['453.33', '254.19', '199.14']);
  assert.deepEqual(cust('[PROVER] Third').slice(2, 5), ['233.33', '121.09', '112.24']);
  assert.deepEqual([cust('[PROVER] Landlord')[6], cust('[PROVER] Landlord')[7]], ['2', '3'], 'landlord: 2 sales, 3 lines');
  assert.equal(detail(ADMIN, `p_customer_ids => ARRAY['${LAND}']::uuid[]`).split(';').map((r) => r.split('|')[4]).sort().join('+'), '20.00+33.33+400.00',
    "the customer filter finds the landlord's shares");
  console.log('[prover] "by customer" credits each payer; the customer filter finds a payer');

  const top = JSON.parse(dash('top_customers'));
  const share = (name) => top.find((c) => c.farm_name === name)?.total;
  assert.deepEqual([share('[PROVER] Farmer'), share('[PROVER] Landlord'), share('[PROVER] Third')], [663.36, 453.33, 233.33], JSON.stringify(top));
  const bottom = JSON.parse(dash('bottom_customers_by_margin'));
  const land = bottom.find((c) => c.farm_name === '[PROVER] Landlord');
  assert.deepEqual([land.total_revenue, land.total_cost, land.order_count], [453.33, 254.19, 2], JSON.stringify(bottom));
  console.log("[prover] dashboard top and lowest-margin customers use each payer's share");

  const rep = detail(REP).split(';');
  assert.ok(rep.map(norm).includes(norm('PROVER-SP-1|[PROVER] Herbicide|[PROVER] Landlord|40|400.00|-|-|-|PROVER-INV-L')), rep.join('\n'));
  assert.equal(rep.length, after.length);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public._sales_line_payers(uuid)', 'EXECUTE')::text;`), 'false', `${role} may not call the helper`);
  }
  console.log('[prover] a rep sees the shares without cost; the helper is callable by no API role');
  console.log('SALES_REPORTS_PER_PAYER_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
