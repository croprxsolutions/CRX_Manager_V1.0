#!/usr/bin/env node
/**
 * Real-schema proof for REG-1 Step 2 (20261229180000, 20261229190000, 20261229200000), cut down 2026-11-09
 * (Mason: "Yes, simplify", then "Drop them"): the registration edit tool, restricted-use posting by the number each
 * line was sold under (either the registration or the product's tick says Yes), Sales to check, the seed preview
 * and the one-time seed, and the invoice-line grant check. No guard: sizes and brands stay directly editable.
 *
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays every
 * migration before the three files, seeds invented rows (live-shaped: disagreeing sizes, a brand-only and a
 * parent-only number, open and posted invoice lines), applies the three files and checks each case.
 *
 * Run: node scripts/smoke/prove-epa-registration-step2-real-schema.mjs   (needs local Docker image)
 * Prints EPA_REGISTRATION_STEP2_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// CRX_PROVER_REUSE=<container> reruns the cases in a kept container from its er2_snap copy (made after the
// replay and seed rows), for fast iteration; a full run builds everything from scratch.
const REUSE = process.env.CRX_PROVER_REUSE || '';
const NAME = REUSE || `crx-epareg2-${process.pid}-${Date.now().toString(36)}`;
const KEEP = REUSE !== '' || process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261229180000_epa_registration_tools.sql');
const FOLLOW_UPS = ['20261229190000_rup_records_by_sold_number.sql', '20261229200000_epa_registration_seed.sql']
  .map((f) => path.join(MIGRATIONS, f));
// Later files that only READ what this proof covers and redefine none of it.
const LATER_READ_ONLY = new Set();
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
  // Job access (#1650) refuses unless storage.objects carries live's policies, which the parked storage files above
  // would install; it changes job and storage access only, never what this proof covers (asserted below).
  '20261217100000_job_access_ends_with_the_job.sql',
  // Its KI-73 follow-up (applicator spray-record fields) needs part C applied; same reason.
  '20261220100000_applicator_keeps_own_record_fields.sql',
  // RT-1 rates (#1700) refuses unless unit_conversions holds live's rows, which this database lacks; it creates only
  // its own rate tables and functions and reads registrations and product numbers (asserted below).
  '20261229110000_product_rates_draft.sql',
]);
// Parked files that read what this proof covers but create, alter or drop none of it.
const PARKED_DEFINES_NONE = new Set(['20261229110000_product_rates_draft.sql']);
const DEFINES_TOUCHED = /\b(CREATE(\s+OR\s+REPLACE)?|ALTER|DROP)\s+(FUNCTION|TABLE|TRIGGER|VIEW|POLICY)\s+(IF\s+(NOT\s+)?EXISTS\s+)?(public\.)?(label_draft|epa_registration|_product_label_fingerprint|invoice_items|save_invoice|generate_rup_sales_records|add_product_size|move_product_size|create_product_with_parent|apply_product_setup|upsert_product_brand|upsert_parent_brand)/i;
// Parked files whose only match is a read of products.epa_registration (complete_job copies it onto the
// applied record); they redefine nothing this proof covers.
const PARKED_READS_ONLY = new Set(['20261217100000_job_access_ends_with_the_job.sql']);
// PR #889's data migrations rewrite live rows this disposable database does not have; they are
// recorded in the ledger (as live has them) instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  // DATA-11 rewrites live rows only (every product gets one preferred link); the proof seeds that state.
  '20261105170000_data11_preferred_vendor_links.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(label_draft|epa_registration|_product_label_fingerprint|invoice_items|save_invoice|generate_rup_sales_records|add_product_size|move_product_size|create_product_with_parent|apply_product_setup|upsert_product_brand|upsert_parent_brand)/i;
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
    if (PARKED_DEFINES_NONE.has(name)) {
      assert.ok(!DEFINES_TOUCHED.test(lf(file)), `${name} now defines what this proof covers; replay it or re-think the skip`);
      continue;
    }
    const text = PARKED_READS_ONLY.has(name) ? lf(file).replace(/'epa_registration', p\.epa_registration/g, '') : lf(file);
    assert.ok(!TOUCHED.test(text), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    // BLK-1a's preflight needs live's count units (live has Ea and Unit, factor 1, both).
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
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



const id = (n) => `7a7e5000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1'), REP = id('a2');
const P1 = id('f1'), P2 = id('f2'), P3 = id('f3'), P4 = id('f4'), P5 = id('f5'), P6 = id('f6');
const B1 = id('b1'), PP1 = id('c1');
const CUST = id('d1'), ORD = id('e1'), INV1 = id('11'), INV2 = id('12'), INV3 = id('13'), INV4 = id('15'), L8 = id('28');
const L1 = id('21'), L2 = id('22'), L3 = id('23'), L4 = id('24'), L5 = id('25'), L6 = id('26'), L7 = id('27'), L9 = id('29');
const N1 = '524-475', N2 = '100-1', N3 = '200-2', N4 = '300-3';

function asOwner(sql) { psql(sql, { user: 'supabase_admin' }); }
function txIn(uid, sql) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  return `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n`;
}
function as(uid, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: txIn(uid, sql) });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
const okJ = (uid, sql) => JSON.parse(ok(uid, sql));
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(r.output, pattern);
}
// Runs as postgres (the functions' owner, not a superuser bypass of triggers): every trigger fires.
function ownerOk(sql) { const r = psql(sql, { allowFailure: true }); assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); }
function ownerRefused(sql, pattern) {
  const r = psql(sql, { allowFailure: true });
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(`${r.stdout}\n${r.stderr}`, pattern);
}
// Writes that skip every trigger: set up rows (and break them on purpose) the way a bug or old data would.
const raw = (sql) => asOwner(`SET session_replication_role = replica;\n${sql}\nSET session_replication_role = origin;`);
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const q = (s) => (s === null ? 'NULL' : `'${String(s).replaceAll("'", "''")}'`);
const regCount = () => scalar('SELECT count(*) FROM public.epa_registrations;');
const PRODUCT_COLS = 'id, product_name, sku, product_form, inventory_unit, category, epa_registration, signal_word, rei_hours, is_rup, current_cost, tier1_price, is_active';
const NEW_COLS = 'id, product_name, sku, product_form, inventory_unit, category, epa_registration, signal_word, rei_hours, is_rup, is_active';  // new sizes start without prices
// The order's completed delivery covers every test sale, so the existing bill-only-delivered-goods rule stays on and passes.
const DELIVERED = `INSERT INTO public.order_items (id, order_id, product_id, total_units_needed)
      SELECT gen_random_uuid(), '${ORD}', p, 100 FROM unnest(ARRAY['${P1}', '${P2}', '${P3}', '${P4}', '${P5}']::uuid[]) AS t(p);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, status, created_by)
      VALUES ('${id('de1')}', 'E2-D1', '${ORD}', '${CUST}', 'completed', '${ADMIN}');
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered)
      SELECT '${id('de1')}', oi.id, oi.product_id, 100, 100 FROM public.order_items oi WHERE oi.order_id = '${ORD}';`;
const line = (lid, inv, pid, qty) => `INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents)
  VALUES ('${lid}', '${inv}', '${pid}', '[PROVER] line', ${qty}, 'Gal', 1500, ${1500 * qty});`;

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'er2-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'er2-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT 'Gal', 128, 'liquid' WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = 'Gal');
    INSERT INTO public.products (${PRODUCT_COLS}) VALUES
      ('${P1}', '[PROVER] Gly 2.5', 'E2-1', 'liquid', 'Gal', 'Herbicide', '${N1}', 'Caution', 4, false, 10.00, 15.00, true),
      ('${P2}', '[PROVER] No number', 'E2-2', 'liquid', 'Gal', 'Herbicide', NULL, NULL, NULL, false, 10.00, 15.00, true),
      ('${P3}', '[PROVER] Gly 30', 'E2-3', 'liquid', 'Gal', 'Herbicide', ' 524-475 ', 'Warning', 4, false, 10.00, 15.00, true),
      ('${P4}', '[PROVER] Paraquat', 'E2-4', 'liquid', 'Gal', 'Herbicide', '${N2}', 'Danger', 12, true, 10.00, 15.00, true),
      ('${P5}', '[PROVER] Spreader', 'E2-5', 'liquid', 'Gal', 'Herbicide', NULL, NULL, NULL, false, 10.00, 15.00, true);
    INSERT INTO public.product_brands (id, product_id, brand_name, epa_registration, signal_word, is_rup, created_by, updated_by)
      VALUES ('${B1}', '${P2}', '[PROVER] Brand 200', '${N3}', 'Caution', false, '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parents (id, name, product_form, category, generic_epa_registration, created_by, updated_by)
      VALUES ('${PP1}', '[PROVER] Parent only', 'liquid', 'Herbicide', '${N4}', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.customers (id, farm_name) VALUES ('${CUST}', '[PROVER] Farm');
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES ('${ORD}', 'E2-O1', '${CUST}', 'confirmed');
    ${DELIVERED}
    INSERT INTO public.invoices (id, customer_id, order_id, invoice_number, status, invoice_date, created_by) VALUES
      ('${INV1}', '${CUST}', '${ORD}', 'E2-I1', 'draft', current_date, '${ADMIN}');
    INSERT INTO public.invoices (id, customer_id, order_id, invoice_number, status, invoice_date, posted_at, created_by) VALUES
      ('${INV2}', '${CUST}', '${ORD}', 'E2-I2', 'posted', current_date, now(), '${ADMIN}');
    ${line(L1, INV1, P1, 2)}
    ${line(L2, INV1, P2, 1)}
    ${line(L3, INV2, P4, 1)}
    UPDATE public.invoice_items SET epa_registration = '${N1}' WHERE id = '${L1}';  -- live fill trigger's work (seeded with triggers off)
    UPDATE public.invoice_items SET epa_registration = '${N2}' WHERE id = '${L3}';`);
  console.log('[prover] seeded: two sizes on one number that disagree, a restricted-use size, a numberless size, a brand-only number, a parent-only number, a draft invoice with two lines and a posted one');
}

const SIG = {
  A: '20261229180000_epa_registration_tools.sql',
  C: '20261229190000_rup_records_by_sold_number.sql', D: '20261229200000_epa_registration_seed.sql',
};
const PUBLIC_FNS = [
  'public.set_epa_registration(text,bigint,jsonb,text,uuid,text)',
  'public.preview_epa_registration_seed(text)', 'public.seed_epa_registrations(jsonb,text,text,text)', 'public.get_epa_sales_to_check()',
];
const PRIVATE_FNS = [
  'public._rup_record_covers_line(public.invoice_items)', 'public._epa_registration_seed_plan(text)',
  'public._epa_registration_unrecorded_posted_lines(text)', 'public._epa_registration_lock(boolean)',
];
const SET = (n, v, changes, key, draft = null) => `SELECT public.set_epa_registration('${n}', ${v ?? 'NULL'}, ${J(changes)}, 'label checked', ${draft ? `'${draft}'` : 'NULL'}, ${q(key)});`;
const PREVIEW_SEED = (d) => `SELECT public.preview_epa_registration_seed(${q(d)});`;
const SEED = (picks, d, fp, key) => `SELECT public.seed_epa_registrations(${J(picks)}, ${q(d)}, ${q(fp)}, ${q(key)});`;
const product = (pid) => JSON.parse(scalar(`SELECT jsonb_build_object('n', btrim(epa_registration), 'sw', signal_word, 'rup', is_rup, 'rei', rei_hours, 'phi', phi_days) FROM public.products WHERE id = '${pid}';`));
const reg = (n) => JSON.parse(scalar(`SELECT COALESCE((SELECT to_jsonb(r) FROM public.epa_registrations r WHERE epa_registration = '${n}'), 'null');`));
const num = (lid) => scalar(`SELECT coalesce(epa_registration, '') FROM public.invoice_items WHERE id = '${lid}';`);

// Copies a database inside the throwaway container (the copy needs its source idle). A used copy is renamed
// aside, never removed.
// shortcut: set-aside copies fill the 1 GB scratch disk after about four reuse runs; start a fresh kept container then.
function copyDatabase(from, to) {
  // Ending the image's background workers can make the server restart itself; wait and retry.
  const sql = (s) => {
    for (let i = 0; ; i += 1) {
      ready();
      const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'template1', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', s], { allowFailure: true });
      if (r.status === 0) return r;
      if (i >= 20) throw new Error(`${s}
${r.stderr}`);
      wait(1000);
    }
  };
  if (sql(`SELECT 1 FROM pg_database WHERE datname = '${to}';`).stdout.includes('1')) {
    sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${to}' AND pid <> pg_backend_pid();`);
    sql(`ALTER DATABASE ${to} RENAME TO used_${Date.now().toString(36)};`);
  }
  sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${from}' AND pid <> pg_backend_pid();`);
  sql(`CREATE DATABASE ${to} TEMPLATE ${from} OWNER postgres;`);
  // A restart can begin just after the last statement; wait until the copy really answers.
  wait(3000);
  sql(`SELECT 1 FROM pg_database WHERE datname = '${to}';`);
}

async function main() {
  if (REUSE) {
    copyDatabase('er2_snap', 'postgres');
  } else {
    buildContainer();
    seed();
    if (KEEP) copyDatabase('postgres', 'er2_snap');
  }
  for (const [k, f] of Object.entries(SIG)) stageText(`${k}.sql`, lf(path.join(MIGRATIONS, f)));

  // 1. Order, one transaction, once.
  for (const k of ['C', 'D']) { const r = apply(`${k}.sql`); assert.notEqual(r.status, 0); assert.match(r.output, /PREFLIGHT/); }
  let r = docker([...psqlArgs(), '-f', '/tmp/A.sql'], { allowFailure: true });
  assert.match(`${r.stdout}\n${r.stderr}`, /EPA_REGISTRATION_TOOLS_NOT_IN_TRANSACTION/);
  for (const k of ['A', 'C', 'D']) {
    r = apply(`${k}.sql`); assert.equal(r.status, 0, `${k}: ${r.output}`);
    r = apply(`${k}.sql`); assert.notEqual(r.status, 0); assert.match(r.output, /already applied|PREFLIGHT/);
  }
  console.log('[prover] case 1: the three files apply only in order, each as one transaction, each once');

  // 2. Grants and ownership; no guard trigger, no wrapped size function, the products INSERT grants untouched.
  for (const sig of [...PUBLIC_FNS, ...PRIVATE_FNS]) {
    const row = scalar(`SELECT p.prosecdef || '|' || array_to_string(p.proconfig, ',') || '|' || pg_get_userbyid(p.proowner) || '|'
      || has_function_privilege('authenticated', p.oid, 'EXECUTE') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')
      FROM pg_proc p WHERE p.oid = '${sig}'::regprocedure;`);
    assert.equal(row, `true|search_path=public, pg_temp|postgres|${PUBLIC_FNS.includes(sig)}|false`, sig);
  }
  assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%registration%' AND tgrelid <> 'public.epa_registration_events'::regclass;`), '0');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE '%reg1%';`), '0');
  assert.equal(scalar(`SELECT to_regclass('public.epa_registration_copy_passes') IS NULL;`), 't');
  assert.equal(scalar(`SELECT has_any_column_privilege('authenticated', 'public.products', 'INSERT');`), 't');
  refused(ADMIN, `${line(id('99'), INV1, P1, 1)}`, /permission denied/);
  refused(ADMIN, `UPDATE public.invoice_items SET quantity = 9 WHERE id = '${L1}';`, /permission denied/);
  console.log('[prover] case 2: every new function is owned by postgres, pins search_path, and only the public ones run for signed-in users; no guard trigger, wrapper or pass table exists; nobody signed in writes invoice lines');

  // 3. Before the seed nothing changes: the guards are off, the tools refuse.
  ownerOk(`UPDATE public.products SET rei_hours = 6 WHERE id = '${P3}';`);
  ownerOk(line(L4, INV1, P5, 1));
  assert.equal(num(L4), '');
  refused(ADMIN, SET(N1, null, { rup_status: 'no' }, 'k0'), /EPA_REGISTRATION_NOT_SEEDED/);
  refused(ADMIN, 'SELECT public.get_epa_sales_to_check();', /EPA_REGISTRATION_NOT_SEEDED/);
  assert.equal(regCount(), '0');
  console.log('[prover] case 3: before the seed a size\'s facts still edit directly, a new line saves as today, and the tools refuse');

  // 4. Preview. A size with a max-rate unit and no rate seeds no max rate (Codex App P2 4517423220).
  ownerOk(`UPDATE public.products SET max_label_rate = NULL, max_label_rate_unit = 'fl oz/A' WHERE id = '${P1}';`);
  refused(REP, PREVIEW_SEED('no'), /ADMIN_REQUIRED/);
  refused(null, PREVIEW_SEED('no'), /permission denied/);
  refused(ADMIN, PREVIEW_SEED('yes'), /EPA_REGISTRATION_SEED_DEFAULT/);
  const pv = okJ(ADMIN, PREVIEW_SEED('no'));
  assert.deepEqual(pv.registrations.map((x) => x.epa_registration), [N2, N3, N4, N1]);
  const byN = Object.fromEntries(pv.registrations.map((x) => [x.epa_registration, x]));
  assert.deepEqual(byN[N1].disagreements, { signal_word: ['Caution', 'Warning'], rei_hours: [4, 6] });
  assert.deepEqual(byN[N1].facts, { rup_status: 'no' });
  assert.deepEqual(byN[N2].facts, { rup_status: 'yes', signal_word: 'Danger', rei_hours: 12 });
  assert.deepEqual(byN[N3].facts, { rup_status: 'no', signal_word: 'Caution' });
  assert.deepEqual(byN[N4], { epa_registration: N4, number_valid: true, carried: false, facts: { rup_status: 'unknown' }, disagreements: {} });
  assert.deepEqual([pv.registration_count, pv.disagreement_count, pv.invalid_numbers], [4, 1, []]);
  assert.equal(pv.open_lines, undefined);
  assert.notEqual(okJ(ADMIN, PREVIEW_SEED('unknown')).fingerprint, pv.fingerprint);
  console.log('[prover] case 4: the preview lists each number with its agreed facts and disagreements, and a fingerprint that depends on the default');

  // 5. Seed refusals, then the seed.
  const PICKS = { [N1]: { signal_word: 'Warning', rei_hours: 4 } };
  refused(REP, SEED(PICKS, 'no', pv.fingerprint, 's-rep'), /ADMIN_REQUIRED/);
  refused(ADMIN, SEED(PICKS, 'no', pv.fingerprint, null), /IDEMPOTENCY_KEY_REQUIRED/);
  refused(ADMIN, SEED(PICKS, 'no', 'stale', 's-x1'), /EPA_REGISTRATION_SEED_STALE/);
  refused(ADMIN, SEED(PICKS, 'unknown', pv.fingerprint, 's-x2'), /EPA_REGISTRATION_SEED_STALE/);
  refused(ADMIN, SEED({}, 'no', pv.fingerprint, 's-x3'), /EPA_REGISTRATION_SEED_PICK_REQUIRED/);
  refused(ADMIN, SEED({ [N1]: { signal_word: 'Danger', rei_hours: 4 } }, 'no', pv.fingerprint, 's-x4'), /EPA_REGISTRATION_SEED_PICK_REQUIRED/);
  refused(ADMIN, SEED({ ...PICKS, [N2]: { signal_word: 'Danger' } }, 'no', pv.fingerprint, 's-x5'), /EPA_REGISTRATION_SEED_PICK_UNEXPECTED/);
  refused(ADMIN, SEED({ [N1]: { ...PICKS[N1], phi_days: 1 } }, 'no', pv.fingerprint, 's-x6'), /EPA_REGISTRATION_SEED_PICK_UNEXPECTED/);
  // A product edited after the preview makes it stale.
  ownerOk(`UPDATE public.products SET phi_days = 3 WHERE id = '${P5}';`);
  refused(ADMIN, SEED(PICKS, 'no', pv.fingerprint, 's-x7'), /EPA_REGISTRATION_SEED_STALE/);
  ownerOk(`UPDATE public.products SET phi_days = NULL WHERE id = '${P5}';`);
  // An active record short of its matching lines (today's posting records only the first) refuses the seed (Sol r7 HIGH).
  raw(`INSERT INTO public.rup_sales_records (id, invoice_id, order_id, customer_id, product_id, sale_date, product_name, quantity, unit,
         unit_price_cents, total_cents, season, buyer_name)
       SELECT 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', ii.invoice_id, i.order_id, i.customer_id, ii.product_id, i.invoice_date, 'x',
              ii.quantity + 1, COALESCE(ii.unit_size, 'Unit not set'), ii.unit_price_cents, ii.extended_cents, 2027, 'x'
         FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id ORDER BY ii.id LIMIT 1;`);
  refused(ADMIN, SEED(PICKS, 'no', pv.fingerprint, 's-x8'), /EPA_REGISTRATION_SEED_SHORT_RECORD/);
  raw(`DELETE FROM public.rup_sales_records WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';`);
  assert.equal(regCount(), '0');
  const seeded = okJ(ADMIN, SEED(PICKS, 'no', pv.fingerprint, 's1'));
  assert.deepEqual(seeded, { registrations: 4, rup_default: 'no', fingerprint: pv.fingerprint });
  assert.deepEqual(okJ(ADMIN, SEED(PICKS, 'no', pv.fingerprint, 's1')), seeded);
  refused(ADMIN, SEED({}, 'no', pv.fingerprint, 's1'), /IDEMPOTENCY|mismatch|another request/i);
  refused(ADMIN, SEED(PICKS, 'no', pv.fingerprint, 's2'), /EPA_REGISTRATION_SEED_DONE/);
  refused(ADMIN, PREVIEW_SEED('no'), /EPA_REGISTRATION_SEED_DONE/);
  assert.equal(reg(N1).signal_word, 'Warning'); assert.equal(reg(N1).rei_hours, 4); assert.equal(reg(N1).rup_status, 'no');
  assert.equal(reg(N2).rup_status, 'yes'); assert.equal(reg(N4).rup_status, 'unknown');
  // Sizes, brands and invoice lines are not touched.
  assert.deepEqual(product(P1), { n: N1, sw: 'Caution', rup: false, rei: 4, phi: null });
  assert.deepEqual(product(P3), { n: N1, sw: 'Warning', rup: false, rei: 6, phi: null });
  assert.deepEqual(product(P4), { n: N2, sw: 'Danger', rup: true, rei: 12, phi: null });
  assert.equal(scalar(`SELECT signal_word || '|' || is_rup FROM public.product_brands WHERE id = '${B1}';`), 'Caution|false');
  assert.equal(scalar("SELECT count(*) FROM public.epa_registration_events WHERE event_type = 'seeded';"), '4');
  assert.deepEqual([num(L1), num(L2), num(L3), num(L4)], [N1, '', N2, '']);
  console.log('[prover] case 5: the seed refuses a non-admin, a missing key, a stale preview, a missing, wrong or extra pick; then makes 4 registrations, changes no size, brand or invoice line, replays under its key, and never runs twice');

  // 6. No guards (Mason, 2026-11-09, "Drop them"): sizes and brands stay directly editable after the seed.
  ownerOk(`UPDATE public.products SET signal_word = 'Danger', rei_hours = 5 WHERE id = '${P1}';`);
  ownerOk(`UPDATE public.products SET signal_word = 'Caution', rei_hours = 4 WHERE id = '${P1}';`);
  ownerOk(`UPDATE public.products SET is_rup = true WHERE id = '${P5}';`);
  ownerOk(`INSERT INTO public.products (${NEW_COLS}) VALUES ('${P6}', '[PROVER] New', 'E2-6', 'liquid', 'Gal', 'Herbicide', '999-9', NULL, NULL, false, true);`);
  ownerOk(`UPDATE public.product_brands SET signal_word = 'Danger', epa_registration = '${N1}' WHERE id = '${B1}';`);
  assert.equal(reg('999-9'), null);
  console.log('[prover] case 6: after the seed a size\'s or brand\'s facts and number still edit directly, and a new size may carry an unregistered number');

  // 7. set_epa_registration.
  refused(REP, SET(N1, 1, { phi_days: 30 }, 'k-rep'), /ADMIN_REQUIRED/);
  refused(ADMIN, SET(N1, 7, { phi_days: 30 }, 'k-st'), /EPA_REGISTRATION_STALE/);
  refused(ADMIN, SET(N1, 1, {}, 'k-empty'), /EPA_REGISTRATION_NO_CHANGES/);
  const set1 = okJ(ADMIN, SET(N1, 1, { signal_word: 'Caution', phi_days: 30 }, 'k-set1'));
  assert.equal(set1.registration_version, 2); assert.equal(set1.event_type, 'updated'); assert.equal(set1.affected_count, undefined);
  assert.deepEqual(okJ(ADMIN, SET(N1, 1, { signal_word: 'Caution', phi_days: 30 }, 'k-set1')), set1);
  assert.equal(reg(N1).phi_days, 30);
  assert.deepEqual(product(P3), { n: N1, sw: 'Warning', rup: false, rei: 6, phi: null });  // nothing copied to sizes
  const set2 = okJ(ADMIN, SET('400-4', null, { rup_status: 'no', signal_word: 'Caution' }, 'k-set2'));
  assert.equal(set2.event_type, 'created');
  refused(ADMIN, SET('0400-4', null, { rup_status: 'no' }, 'k-set3'), /EPA_REGISTRATION_NUMBER_INVALID/);
  // Any decimal rate the products column can hold is a valid fact (Sol r1: the seed must not refuse what its preview shows).
  okJ(ADMIN, SET('400-4', 1, { max_label_rate: 0.1234567, max_label_rate_unit: 'fl oz/A' }, 'k-set4'));
  assert.equal(String(reg('400-4').max_label_rate), '0.1234567');
  refused(ADMIN, `SELECT public.assign_epa_registration('products', '${P5}', '400-4', NULL, 'x', 1, 'r', NULL, 'k-a1');`, /EPA_REGISTRATION/);
  console.log('[prover] case 7: Edit registration refuses a non-admin, an old version and no change; it bumps the version, replays under its key, creates a new number and copies nothing to sizes; Change EPA number stays Step 1\'s stub');

  // 8. Product tools and label drafts work as today: no registration is made or changed by them.
  const NEW_PARENT = { name: '[PROVER] Brand new', product_form: 'liquid', generic_epa_registration: '600-6', category: 'Herbicide' };
  const NEW_SIZE = { product_name: '[PROVER] Brand new 1 gal', sku: 'E2-NW', inventory_unit: 'Gal', is_rup: false, signal_word: 'Caution' };
  ok(ADMIN, `SELECT public.create_product_with_parent(${J(NEW_PARENT)}, ${J(NEW_SIZE)}, 'k-np2');`);
  assert.equal(reg('600-6'), null);
  const d1 = ok(ADMIN, `SELECT public.create_label_draft('${P1}', NULL, NULL, 21, ${q(N1)}, NULL, NULL, 'label pdf', 'high', 'pending', 'dk1');`);
  ok(ADMIN, `SELECT public.commit_label_draft('${d1}', 'accepted', NULL, NULL, 21, NULL, NULL, NULL, true, 'ck1');`);
  assert.equal(product(P1).phi, 21);
  assert.equal(reg(N1).phi_days, 30); assert.equal(reg(N1).registration_version, 2);
  console.log('[prover] case 8: creating a product with a new number and committing a label draft work as today and leave the registrations alone');

  // 11. Invoice lines after the seed: today's number rules, nothing copied onto the line.
  ownerOk(line(L5, INV1, P4, 3));
  assert.equal(num(L5), N2);
  // Never block a sale (Mason, 2026-11-09): a size whose number has no registration still saves.
  raw(`UPDATE public.products SET epa_registration = '999-9' WHERE id = '${P2}';`);
  ownerOk(line(L6, INV1, P2, 1));
  assert.equal(num(L6), '999-9');
  raw(`DELETE FROM public.invoice_items WHERE id = '${L6}'; UPDATE public.products SET epa_registration = NULL WHERE id = '${P2}';`);
  // Price and quantity edits keep the number the line was sold under, even after its size moved to another number.
  raw(`UPDATE public.products SET epa_registration = '${N3}' WHERE id = '${P4}';`);
  ownerOk(`UPDATE public.invoice_items SET unit_price_cents = 1600, extended_cents = 3200 WHERE id = '${L1}';`);
  ownerOk(`UPDATE public.invoice_items SET quantity = 5, extended_cents = 7500 WHERE id = '${L5}';`);
  assert.equal(num(L1), N1);
  assert.equal(num(L5), N2);
  raw(`UPDATE public.products SET epa_registration = '${N2}' WHERE id = '${P4}'; UPDATE public.invoice_items SET quantity = 3, extended_cents = 4500 WHERE id = '${L5}';`);
  console.log('[prover] case 11: after the seed a new line takes its size\'s number, an unregistered number never blocks the line, and price or quantity edits keep the number it was sold under');

  // 12. Posting writes the restricted-use record once, under the line's stored number.
  raw(`UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${INV1}';`);
  const GEN = (key) => `SELECT public.generate_rup_sales_records('${INV1}', '${key}');`;
  // L4 has no number and its product was ticked restricted-use in case 6: posting goes through and records it with the
  // number blank (Mason, 2026-11-09, "Yes, always record"; Sol r2 HIGH).
  assert.equal(ok(ADMIN, GEN('g0')), '2');
  assert.equal(scalar(`SELECT count(*) || '|' || count(*) FILTER (WHERE epa_registration IS NULL) FROM public.rup_sales_records WHERE invoice_id = '${INV1}';`), '2|1');
  raw(`DELETE FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND epa_registration IS NULL;`);
  raw(`INSERT INTO public.invoices (id, customer_id, order_id, invoice_number, status, invoice_date, created_by)
      VALUES ('${INV3}', '${CUST}', '${ORD}', 'E2-I3', 'draft', current_date, '${ADMIN}');
    UPDATE public.invoice_items SET invoice_id = '${INV3}' WHERE id = '${L4}';`);
  assert.equal(ok(ADMIN, GEN('g1')), '0');
  assert.equal(scalar(`SELECT epa_registration || '|' || quantity || '|' || signal_word FROM public.rup_sales_records WHERE invoice_id = '${INV1}';`), `${N2}|3.0000|Danger`);
  assert.equal(ok(ADMIN, GEN('g2')), '0');
  raw(`UPDATE public.invoice_items SET quantity = 4 WHERE id = '${L5}';`);
  refused(ADMIN, GEN('g3'), /RUP_RECORD_CONFLICT/);
  raw(`UPDATE public.invoice_items SET quantity = 3, extended_cents = 4400 WHERE id = '${L5}';`);
  refused(ADMIN, GEN('g3b'), /RUP_RECORD_CONFLICT/);
  raw(`UPDATE public.invoice_items SET extended_cents = 4500 WHERE id = '${L5}';`);
  // The record names the product's own number, never the one stored on the line (Mason, 2026-11-09, "Yes, product's
  // number"; Sol r3 BLOCKER): a line carrying 999-9 on P4 (N2) records under N2.
  raw(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration) VALUES ('${L6}', '${INV1}', '${P4}', 'x', 1, 'Gal', 1600, 1600, '999-9');`);
  assert.equal(ok(ADMIN, GEN('g4')), '1');
  assert.equal(scalar(`SELECT epa_registration || '|' || quantity || '|' || signal_word FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 1600;`), `${N2}|1.0000|Danger`);
  raw(`DELETE FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 1600; DELETE FROM public.invoice_items WHERE id = '${L6}';`);
  // A product whose number changed before posting records under its number at posting (accepted), whatever the line holds.
  raw(`UPDATE public.products SET epa_registration = '${N3}' WHERE id = '${P4}';
    INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration) VALUES ('${L6}', '${INV1}', '${P4}', 'x', 1, 'Gal', 1800, 1800, '${N2}');`);
  assert.equal(ok(ADMIN, GEN('g4b')), '1');
  assert.equal(scalar(`SELECT epa_registration FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 1800;`), N3);
  raw(`DELETE FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 1800; DELETE FROM public.invoice_items WHERE id = '${L6}';
    UPDATE public.products SET epa_registration = '${N2}' WHERE id = '${P4}';`);
  // The product's tick records it when its number's registration says No (P1 on N1): L1 (1600) and a new line (1900).
  // Any Yes records it (Mason, 2026-11-09, "Yes, any Yes"; Sol r5 HIGH): a line on an unticked product whose number
  // says No (P3 on N1) but saved under N2 (Yes), as when the product moved off N2 before posting, records under N1.
  raw(`UPDATE public.products SET is_rup = true WHERE id = '${P1}';
    INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration) VALUES
      ('${L6}', '${INV1}', '${P1}', 'x', 1, 'Gal', 1900, 1900, '${N1}'),
      ('${id('2a')}', '${INV1}', '${P3}', 'x', 1, 'Gal', 2000, 2000, '${N2}');`);
  assert.equal(ok(ADMIN, GEN('g4c')), '3');
  assert.equal(scalar(`SELECT string_agg(epa_registration || '|' || signal_word, ',' ORDER BY unit_price_cents) FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents IN (1600, 1900, 2000);`),
    `${N1}|Caution,${N1}|Caution,${N1}|Caution`);
  raw(`DELETE FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents IN (1600, 1900, 2000);
    DELETE FROM public.invoice_items WHERE id IN ('${L6}', '${id('2a')}'); UPDATE public.products SET is_rup = false WHERE id = '${P1}';`);
  // Only the restricted-use lines count (Sol r6 HIGH): two P3 lines at one price, one saved under N2 (Yes), one under
  // N1 (No), record a quantity of 1, both count as recorded, and a repeat writes nothing.
  raw(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration) VALUES
      ('${L6}', '${INV1}', '${P3}', 'x', 1, 'Gal', 2400, 2400, '${N2}'),
      ('${id('2a')}', '${INV1}', '${P3}', 'x', 1, 'Gal', 2400, 2400, '${N1}');`);
  assert.equal(ok(ADMIN, GEN('g4h')), '1');
  assert.equal(scalar(`SELECT quantity || '|' || total_cents FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 2400;`), '1.0000|2400');
  assert.equal(scalar(`SELECT bool_and(public._rup_record_covers_line(ii))::text FROM public.invoice_items ii WHERE id IN ('${L6}', '${id('2a')}');`), 'true');
  assert.equal(ok(ADMIN, GEN('g4i')), '0');
  raw(`DELETE FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 2400;
    DELETE FROM public.invoice_items WHERE id IN ('${L6}', '${id('2a')}');`);
  // The product's number's registration records it when the product is not ticked: P4 unticked, N2 says Yes, the line
  // carries N1 (No) and still records, under N2.
  raw(`UPDATE public.products SET is_rup = false WHERE id = '${P4}';
    INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration) VALUES ('${L6}', '${INV1}', '${P4}', 'x', 1, 'Gal', 2100, 2100, '${N1}');`);
  assert.equal(ok(ADMIN, GEN('g4d')), '1');
  assert.equal(scalar(`SELECT epa_registration FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 2100;`), N2);
  raw(`DELETE FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 2100; DELETE FROM public.invoice_items WHERE id = '${L6}';
    UPDATE public.products SET is_rup = true WHERE id = '${P4}';`);
  // A line with no unit on a product whose number says Yes (P4 unticked, N2) posts and records as 'Unit not set',
  // and a repeat call writes nothing more (Sol r4 HIGH: the record's unit is required).
  raw(`UPDATE public.products SET is_rup = false WHERE id = '${P4}';
    INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents) VALUES ('${L6}', '${INV1}', '${P4}', 'x', 1, NULL, 2200, 2200);`);
  assert.equal(ok(ADMIN, GEN('g4e')), '1');
  assert.equal(scalar(`SELECT epa_registration || '|' || unit FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 2200;`), `${N2}|Unit not set`);
  assert.equal(ok(ADMIN, GEN('g4f')), '0');
  // A line with no unit and one saved as 'Unit not set' at the same price share one record, and both count as
  // recorded, so the list does not keep them (Sol r5 MED).
  raw(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents) VALUES ('${id('2b')}', '${INV1}', '${P4}', 'x', 1, 'Unit not set', 2200, 2200);
    DELETE FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 2200;`);
  assert.equal(ok(ADMIN, GEN('g4g')), '1');
  assert.equal(scalar(`SELECT quantity || '|' || total_cents FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 2200;`), '2.0000|4400');
  assert.equal(scalar(`SELECT bool_and(public._rup_record_covers_line(ii))::text FROM public.invoice_items ii WHERE id IN ('${L6}', '${id('2b')}');`), 'true');
  raw(`DELETE FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 2200; DELETE FROM public.invoice_items WHERE id IN ('${L6}', '${id('2b')}');
    UPDATE public.products SET is_rup = true WHERE id = '${P4}';`);
  // The same product and number sold at a second price gets its own record; neither merges price nor total.
  raw(`UPDATE public.invoices SET status = 'draft', posted_at = NULL WHERE id = '${INV1}';`);
  ownerOk(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents) VALUES ('${L7}', '${INV1}', '${P4}', 'x', 2, 'Gal', 1700, 3400);`);
  raw(`UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${INV1}';`);
  assert.equal(ok(ADMIN, GEN('g5')), '1');
  assert.equal(scalar(`SELECT string_agg(quantity || '@' || unit_price_cents || '=' || total_cents, ',' ORDER BY unit_price_cents) FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND voided_at IS NULL;`),
    '3.0000@1500=4500,2.0000@1700=3400');
  assert.equal(ok(ADMIN, GEN('g6')), '0');
  // Any one of several active records that disagrees is refused, not only the first by id (Luna r13 MED).
  raw(`INSERT INTO public.rup_sales_records SELECT (jsonb_populate_record(r, '{"id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "quantity": 9}')).*
      FROM public.rup_sales_records r WHERE invoice_id = '${INV1}' AND unit_price_cents = 1500 AND voided_at IS NULL;`);
  refused(ADMIN, GEN('g6b'), /RUP_RECORD_CONFLICT/);
  raw(`DELETE FROM public.rup_sales_records WHERE id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';`);
  // A record kept under an older number (the product's number changed since, or a record from before the seed) still
  // covers its sale: a later call with a fresh key writes no second record (Sol r3 HIGH).
  raw(`UPDATE public.products SET epa_registration = '${N3}' WHERE id = '${P4}';`);
  assert.equal(ok(ADMIN, GEN('g6c')), '0');
  raw(`UPDATE public.products SET epa_registration = '${N2}' WHERE id = '${P4}';`);
  console.log('[prover] case 12: posting records a numberless restricted-use line with the number blank, records under the product\'s own number (never the line\'s) when its tick or its number\'s registration says Yes, one record per unit and price, skips a repeat (even under an older number) and refuses a record that disagrees');

  // 13. Sales to check.
  refused(REP, 'SELECT public.get_epa_sales_to_check();', /ADMIN_REQUIRED/);
  assert.equal(okJ(ADMIN, 'SELECT public.get_epa_sales_to_check();').some((x) => x.line_id === L4), false);  // drafts are not listed
  raw(`UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${INV3}';`);
  const reasons = () => Object.fromEntries(okJ(ADMIN, 'SELECT public.get_epa_sales_to_check();').map((x) => [x.line_id, x.reason]));
  const check = reasons();
  assert.equal(check[L3], 'restricted_use_to_record');  // posted before the seed, never recorded
  assert.equal(check[L4], 'no_epa_number');             // restricted-use product, no number
  for (const lid of [L1, L2, L5, L7]) assert.equal(check[lid], undefined, lid);
  // A line is judged by its product's number, not the one it carries: 999-9 on restricted-use P4 is listed as unrecorded.
  raw(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration) VALUES ('${L6}', '${INV3}', '${P4}', 'x', 1, 'Gal', 1500, 1500, '999-9');`);
  assert.equal(reasons()[L6], 'restricted_use_to_record');
  raw(`DELETE FROM public.invoice_items WHERE id = '${L6}';`);
  // Any Yes lists it (Sol r5 HIGH): an unrecorded line on unticked P3 (N1, No) saved under N2 (Yes) is listed.
  raw(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration) VALUES ('${L6}', '${INV3}', '${P3}', 'x', 1, 'Gal', 1500, 1500, '${N2}');
    UPDATE public.epa_registrations SET rup_status = 'no' WHERE epa_registration = '${N1}';`);
  assert.equal(reasons()[L6], 'restricted_use_to_record');
  assert.equal(scalar(`SELECT (public._epa_registration_unrecorded_posted_lines('${N2}') @> jsonb_build_array(jsonb_build_object('invoice_item_id', '${L6}'::uuid)))::text;`), 'true');
  // A Not reviewed number saved on the line keeps it listed though its product's number says No (Sol r6 MED).
  raw(`UPDATE public.epa_registrations SET rup_status = 'unknown' WHERE epa_registration = '${N2}';`);
  assert.equal(reasons()[L6], 'not_reviewed');
  // ...and when its product has no number at all (Sol r7 MED).
  raw(`UPDATE public.products SET epa_registration = NULL WHERE id = '${P3}';`);
  assert.equal(reasons()[L6], 'no_epa_number');
  raw(`UPDATE public.products SET epa_registration = '${N1}' WHERE id = '${P3}';
    UPDATE public.epa_registrations SET rup_status = 'yes' WHERE epa_registration = '${N2}';`);
  raw(`DELETE FROM public.invoice_items WHERE id = '${L6}';`);
  // A number with no registration, or a Not reviewed one, is listed even when its product is not ticked (Luna r13 HIGH).
  raw(`UPDATE public.products SET epa_registration = '999-9' WHERE id = '${P1}';`);
  assert.equal(reasons()[L1], 'no_registration');
  raw(`UPDATE public.products SET epa_registration = '${N1}' WHERE id = '${P1}'; UPDATE public.epa_registrations SET rup_status = 'unknown' WHERE epa_registration = '${N1}';`);
  assert.equal(reasons()[L1], 'not_reviewed');
  raw(`UPDATE public.epa_registrations SET rup_status = 'no' WHERE epa_registration = '${N1}';`);
  assert.equal(reasons()[L1], undefined);
  // A record covers a line only when it holds every line sharing its number, unit and price (Sol r1): a second
  // same-price line beside L5 makes L5's record short, so both are listed, and neither once it is removed.
  raw(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration) VALUES ('${L6}', '${INV1}', '${P4}', 'x', 1, 'Gal', 1500, 1500, '${N2}');`);
  const short = reasons();
  assert.equal(short[L6], 'restricted_use_to_record'); assert.equal(short[L5], 'restricted_use_to_record');
  raw(`DELETE FROM public.invoice_items WHERE id = '${L6}';`);
  assert.equal(reasons()[L5], undefined);
  // A record covers only its own price: with the second-price record voided, that line is listed and L5 is not.
  raw(`UPDATE public.rup_sales_records SET voided_at = now() WHERE invoice_id = '${INV1}' AND unit_price_cents = 1700;`);
  const check2 = reasons();
  assert.equal(check2[L7], 'restricted_use_to_record');
  assert.equal(check2[L5], undefined);
  // A registration corrected to No still lists the sale while its product is ticked restricted-use (either Yes).
  raw(`UPDATE public.epa_registrations SET rup_status = 'no' WHERE epa_registration = '${N2}';`);
  assert.equal(reasons()[L7], 'restricted_use_to_record');
  raw(`UPDATE public.epa_registrations SET rup_status = 'yes' WHERE epa_registration = '${N2}';`);
  assert.equal(scalar(`SELECT public._epa_registration_unrecorded_posted_lines('${N2}') @> '[{"invoice_item_id": "${L7}"}]' AND NOT public._epa_registration_unrecorded_posted_lines('${N2}') @> '[{"invoice_item_id": "${L5}"}]';`), 't');
  // A label turning Yes lists the unrecorded sales of products carrying that number (Luna r15 MED).
  raw(`UPDATE public.rup_sales_records SET voided_at = '2000-01-01' WHERE invoice_id = '${INV1}' AND product_id = '${P1}' AND voided_at IS NULL;
       UPDATE public.products SET epa_registration = '${N2}' WHERE id = '${P1}';`);
  assert.equal(scalar(`SELECT public._epa_registration_unrecorded_posted_lines('${N2}') @> '[{"invoice_item_id": "${L1}"}]';`), 't');
  raw(`UPDATE public.products SET epa_registration = '${N1}' WHERE id = '${P1}';
       UPDATE public.rup_sales_records SET voided_at = NULL WHERE voided_at = '2000-01-01';`);
  // A recorded numberless sale stays listed after its product is unticked (Sol r2 HIGH).
  assert.equal(ok(ADMIN, `SELECT public.generate_rup_sales_records('${INV3}', 'g-inv3');`), '1');
  raw(`UPDATE public.products SET is_rup = false WHERE id = '${P5}';`);
  assert.equal(reasons()[L4], 'no_epa_number');
  raw(`UPDATE public.products SET is_rup = true WHERE id = '${P5}';`);
  console.log('[prover] case 13: Sales to check lists an unrecorded restricted-use sale (by number or product tick) and a numberless restricted-use sale, and not a recorded one');

  // 14. Keep as sold (Mason, 2026-11-09): a re-saved line keeps the number it was sold under, through save_invoice and any
  // writer that deletes and rebuilds the lines and sends each line's number back (the screens do), a quantity change included.
  raw(`INSERT INTO public.invoices (id, customer_id, order_id, invoice_number, status, invoice_date, created_by)
      VALUES ('${INV4}', '${CUST}', '${ORD}', 'E2-I4', 'draft', current_date, '${ADMIN}');`);
  ownerOk(line(L8, INV4, P4, 2));
  ownerOk(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents)
    VALUES ('${L9}', '${INV4}', '${P2}', '[PROVER] blank', 1, 'Gal', 1500, 1500);`);
  const numD = (d) => scalar(`SELECT coalesce(epa_registration, '-') FROM public.invoice_items WHERE invoice_id = '${INV4}' AND description = '${d}';`);
  const items = () => JSON.parse(scalar(`SELECT jsonb_agg(jsonb_build_object('id', id, 'product_id', product_id, 'description', description, 'quantity', quantity, 'unit_size', unit_size, 'unit_price_cents', unit_price_cents, 'epa_registration', epa_registration) ORDER BY description) FROM public.invoice_items WHERE invoice_id = '${INV4}';`));
  const HDR = J({ id: INV4, customer_id: CUST, order_id: ORD, status: 'draft', invoice_date: scalar('SELECT current_date::text;') });
  assert.deepEqual([numD('[PROVER] line'), numD('[PROVER] blank')], [N2, '-']);
  // The labels move on: both sizes move to N3.
  raw(`UPDATE public.products SET epa_registration = '${N3}' WHERE id IN ('${P2}', '${P4}');`);
  ok(ADMIN, `SELECT public.save_invoice(${HDR}, ${J(items())}, 'k-save14');`);
  assert.equal(numD('[PROVER] line'), N2);
  ownerOk(`BEGIN;
    DELETE FROM public.invoice_items WHERE invoice_id = '${INV4}';
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration)
    SELECT '${INV4}', (x->>'product_id')::uuid, x->>'description', (x->>'quantity')::numeric, x->>'unit_size',
           (x->>'unit_price_cents')::bigint, round((x->>'unit_price_cents')::numeric * (x->>'quantity')::numeric)::bigint, x->>'epa_registration'
      FROM jsonb_array_elements(${J(items())}) x;
    COMMIT;`);
  assert.equal(numD('[PROVER] line'), N2);
  ok(ADMIN, `SELECT public.save_invoice(${HDR}, ${J(items().map((x) => (x.description === '[PROVER] line' ? { ...x, quantity: 6 } : x)))}, 'k-save14b');`);
  assert.equal(numD('[PROVER] line'), N2);
  // Accepted (Mason, 2026-11-09): a draft line with no number takes its size's number when re-saved (today's rule).
  assert.equal(numD('[PROVER] blank'), N3);
  raw(`UPDATE public.products SET epa_registration = NULL WHERE id = '${P2}'; UPDATE public.products SET epa_registration = '${N2}' WHERE id = '${P4}';`);
  console.log('[prover] case 14: a re-saved line keeps the number it was sold under (save_invoice, a delete-and-rebuild writer, a quantity change); a numberless draft line takes its size\'s number');
  console.log('EPA_REGISTRATION_STEP2_PROOF_PASS');
}
try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
