#!/usr/bin/env node
/**
 * Real-schema proof for REG-1 Step 2 (20261218100000 to 20261218130000): the registration tools, label-draft
 * commits and product setup through registrations, invoice-line sale capture and restricted-use posting,
 * the size and brand guards, the seed preview and the one-time seed, and the Q7 grant removals.
 *
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays every
 * migration before the four files, seeds invented rows (live-shaped: disagreeing sizes, a brand-only and a
 * parent-only number, open and posted invoice lines), applies the four files and checks each case.
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
const CANDIDATE = path.join(MIGRATIONS, '20261218100000_epa_registration_tools.sql');
const FOLLOW_UPS = ['20261218110000_epa_registration_draft_setup.sql', '20261218120000_invoice_line_sale_capture.sql',
  '20261218130000_epa_registration_guards.sql'].map((f) => path.join(MIGRATIONS, f));
// Later files that only READ what this proof covers and redefine none of it.
const LATER_READ_ONLY = new Set();
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
  // Job access (#1650) refuses unless storage.objects carries live's policies, which the parked storage files above
  // would install; it changes job and storage access only, never what this proof covers (asserted below).
  '20261217100000_job_access_ends_with_the_job.sql',
]);
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
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
const L1 = id('21'), L2 = id('22'), L3 = id('23'), L4 = id('24'), L5 = id('25'), L6 = id('26'), L7 = id('27');
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
    UPDATE public.invoice_items SET epa_registration = '${N2}' WHERE id = '${L3}';`);
  console.log('[prover] seeded: two sizes on one number that disagree, a restricted-use size, a numberless size, a brand-only number, a parent-only number, a draft invoice with two lines and a posted one');
}

const SIG = {
  A: '20261218100000_epa_registration_tools.sql', B: '20261218110000_epa_registration_draft_setup.sql',
  C: '20261218120000_invoice_line_sale_capture.sql', D: '20261218130000_epa_registration_guards.sql',
};
const PUBLIC_FNS = [
  'public.set_epa_registration(text,bigint,jsonb,text,uuid,text)', 'public.preview_epa_assignment(text,uuid,text)',
  'public.assign_epa_registration(text,uuid,text,jsonb,text,bigint,text,uuid,text)', 'public.apply_product_setup(jsonb,uuid,text)',
  'public.preview_epa_registration_seed(text)', 'public.seed_epa_registrations(jsonb,text,text,text)', 'public.get_epa_sales_to_check()',
  'public.add_product_size(uuid,bigint,jsonb,text)', 'public.move_product_size(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)',
  'public.create_product_with_parent(jsonb,jsonb,text)',
];
const PRIVATE_FNS = [
  'public._capture_invoice_line_sale()', 'public.guard_product_registration()', 'public.guard_brand_registration()',
  'public._epa_registration_seed_plan(text)', 'public._epa_registration_ensure(text,jsonb,text)', 'public._apply_product_setup_reg1_impl(jsonb,uuid,text)',
  'public._add_product_size_reg1_impl(uuid,bigint,jsonb,text)', 'public._move_product_size_reg1_impl(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)',
  'public._create_product_with_parent_reg1_impl(jsonb,jsonb,text)', 'public._epa_registration_copy_to_targets(text)',
];
const SET = (n, v, changes, key, draft = null) => `SELECT public.set_epa_registration('${n}', ${v ?? 'NULL'}, ${J(changes)}, 'label checked', ${draft ? `'${draft}'` : 'NULL'}, ${q(key)});`;
const PREVIEW_SEED = (d) => `SELECT public.preview_epa_registration_seed(${q(d)});`;
const SEED = (picks, d, fp, key) => `SELECT public.seed_epa_registrations(${J(picks)}, ${q(d)}, ${q(fp)}, ${q(key)});`;
const product = (pid) => JSON.parse(scalar(`SELECT jsonb_build_object('n', btrim(epa_registration), 'sw', signal_word, 'rup', is_rup, 'rei', rei_hours, 'phi', phi_days) FROM public.products WHERE id = '${pid}';`));
const reg = (n) => JSON.parse(scalar(`SELECT COALESCE((SELECT to_jsonb(r) FROM public.epa_registrations r WHERE epa_registration = '${n}'), 'null');`));
const capture = (lid) => scalar(`SELECT concat_ws('|', epa_registration, sale_rup_status, sale_signal_word, sale_facts_source, (sale_facts_captured_at IS NOT NULL)::text) FROM public.invoice_items WHERE id = '${lid}';`);

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
  for (const k of ['B', 'C', 'D']) { const r = apply(`${k}.sql`); assert.notEqual(r.status, 0); assert.match(r.output, /PREFLIGHT/); }
  let r = docker([...psqlArgs(), '-f', '/tmp/A.sql'], { allowFailure: true });
  assert.match(`${r.stdout}\n${r.stderr}`, /EPA_REGISTRATION_TOOLS_NOT_IN_TRANSACTION/);
  for (const k of ['A', 'B', 'C', 'D']) {
    r = apply(`${k}.sql`); assert.equal(r.status, 0, `${k}: ${r.output}`);
    r = apply(`${k}.sql`); assert.notEqual(r.status, 0); assert.match(r.output, /already applied|PREFLIGHT/);
  }
  console.log('[prover] case 1: the four files apply only in order, each as one transaction, each once');

  // 2. Grants and ownership.
  for (const sig of [...PUBLIC_FNS, ...PRIVATE_FNS]) {
    const row = scalar(`SELECT p.prosecdef || '|' || array_to_string(p.proconfig, ',') || '|' || pg_get_userbyid(p.proowner) || '|'
      || has_function_privilege('authenticated', p.oid, 'EXECUTE') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')
      FROM pg_proc p WHERE p.oid = '${sig}'::regprocedure;`);
    assert.equal(row, `true|search_path=public, pg_temp|postgres|${PUBLIC_FNS.includes(sig)}|false`, sig);
  }
  for (const w of ['add_product_size', 'move_product_size', 'create_product_with_parent', 'apply_product_setup']) {
    assert.match(scalar(`SELECT replace(prosrc, E'\n', ' ') FROM pg_proc WHERE proname = '${w}' AND pronamespace = 'public'::regnamespace;`), /_epa_registration_lock\(true\)/, w);
  }
  refused(ADMIN, `INSERT INTO public.products (product_name, sku) VALUES ('[PROVER] direct', 'E2-X');`, /permission denied/);
  refused(ADMIN, `${line(id('99'), INV1, P1, 1)}`, /permission denied/);
  refused(ADMIN, `UPDATE public.invoice_items SET quantity = 9 WHERE id = '${L1}';`, /permission denied/);
  assert.equal(scalar(`SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'public.invoice_items'::regclass AND tgname >= 'zzz_capture';`), 'zzz_capture_invoice_line_sale');
  console.log('[prover] case 2: every new or wrapped function is owned by postgres, pins search_path, and only the public ones run for signed-in users; the size writers take the exclusive lock; nobody signed in inserts products or writes invoice lines; the capture trigger fires last');

  // 3. Before the seed nothing changes: guards and capture are off, the tools refuse.
  ownerOk(`UPDATE public.products SET rei_hours = 6 WHERE id = '${P3}';`);
  ownerOk(line(L4, INV1, P5, 1));
  assert.equal(capture(L4), 'false');
  refused(ADMIN, SET(N1, null, { rup_status: 'no' }, 'k0'), /EPA_REGISTRATION_NOT_SEEDED/);
  refused(ADMIN, 'SELECT public.get_epa_sales_to_check();', /EPA_REGISTRATION_NOT_SEEDED/);
  assert.equal(regCount(), '0');
  console.log('[prover] case 3: before the seed a size\'s facts still edit directly, a new line is not captured, and the tools refuse');

  // 4. Preview.
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
  assert.deepEqual(pv.open_lines.map((x) => x.invoice_item_id).sort(), [L1, L2, L4].sort());
  assert.deepEqual([pv.registration_count, pv.disagreement_count, pv.invalid_numbers, pv.blocked_lines], [4, 1, [], []]);
  assert.notEqual(okJ(ADMIN, PREVIEW_SEED('unknown')).fingerprint, pv.fingerprint);
  console.log('[prover] case 4: the preview lists each number with its agreed facts and disagreements, the open lines, and a fingerprint that depends on the default');

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
  assert.equal(regCount(), '0');
  const seeded = okJ(ADMIN, SEED(PICKS, 'no', pv.fingerprint, 's1'));
  assert.deepEqual(seeded, { registrations: 4, sizes_and_brands_updated: 2, lines_captured: 3, rup_default: 'no', fingerprint: pv.fingerprint });
  assert.deepEqual(okJ(ADMIN, SEED(PICKS, 'no', pv.fingerprint, 's1')), seeded);
  refused(ADMIN, SEED({}, 'no', pv.fingerprint, 's1'), /IDEMPOTENCY|mismatch|another request/i);
  refused(ADMIN, SEED(PICKS, 'no', pv.fingerprint, 's2'), /EPA_REGISTRATION_SEED_DONE/);
  refused(ADMIN, PREVIEW_SEED('no'), /EPA_REGISTRATION_SEED_DONE/);
  assert.equal(reg(N1).signal_word, 'Warning'); assert.equal(reg(N1).rei_hours, 4); assert.equal(reg(N1).rup_status, 'no');
  assert.equal(reg(N4).rup_status, 'unknown');
  assert.deepEqual(product(P1), { n: N1, sw: 'Warning', rup: false, rei: 4, phi: null });
  assert.deepEqual(product(P3), { n: N1, sw: 'Warning', rup: false, rei: 4, phi: null });
  assert.deepEqual(product(P4), { n: N2, sw: 'Danger', rup: true, rei: 12, phi: null });
  assert.equal(scalar(`SELECT signal_word || '|' || is_rup FROM public.product_brands WHERE id = '${B1}';`), 'Caution|false');
  assert.equal(scalar("SELECT count(*) FROM public.epa_registration_events WHERE event_type = 'seeded';"), '4');
  assert.equal(capture(L1), `${N1}|no|Warning|seed-assumed:registration:${N1}@1|true`);
  assert.equal(capture(L2), `no|seed-assumed:product:${P2}|true`);
  assert.equal(capture(L4), `no|seed-assumed:product:${P5}|true`);
  assert.equal(capture(L3), `${N2}|false`);  // posted before the seed: left alone
  assert.equal(scalar('SELECT count(*) FROM public.epa_registration_copy_passes;'), '0');
  console.log('[prover] case 5: the seed refuses a non-admin, a missing key, a stale preview, a missing, wrong or extra pick; then makes 4 registrations, copies their facts to sizes and brands, captures the 3 open lines as seed-assumed, replays under its key, and never runs twice');

  // 6. Product and brand guards.
  ownerRefused(`UPDATE public.products SET signal_word = 'Danger' WHERE id = '${P1}';`, /EPA_REGISTRATION_FACT: signal_word/);
  ownerRefused(`UPDATE public.products SET is_rup = true WHERE id = '${P1}';`, /EPA_REGISTRATION_FACT: is_rup/);
  ownerRefused(`UPDATE public.products SET epa_registration = '${N2}' WHERE id = '${P1}';`, /EPA_REGISTRATION_ASSIGN/);
  ownerRefused(`UPDATE public.products SET epa_registration = NULL WHERE id = '${P1}';`, /EPA_REGISTRATION_ASSIGN/);
  ownerRefused(`UPDATE public.products SET epa_registration = '${N1}' WHERE id = '${P5}';`, /EPA_REGISTRATION_ASSIGN/);
  ownerOk(`UPDATE public.products SET product_name = '[PROVER] Gly 2.5 gal' WHERE id = '${P1}';`);
  ownerOk(`UPDATE public.products SET signal_word = 'Caution' WHERE id = '${P5}';`);
  ownerRefused(`INSERT INTO public.products (${NEW_COLS}) VALUES ('${P6}', '[PROVER] New', 'E2-6', 'liquid', 'Gal', 'Herbicide', '999-9', NULL, NULL, false, true);`, /EPA_REGISTRATION_NEW_NUMBER/);
  ownerRefused(`INSERT INTO public.products (${NEW_COLS}) VALUES ('${P6}', '[PROVER] New', 'E2-6', 'liquid', 'Gal', 'Herbicide', '${N1}', 'Caution', NULL, false, true);`, /EPA_REGISTRATION_FACT_CONFLICT: signal_word/);
  ownerRefused(`INSERT INTO public.products (${NEW_COLS}) VALUES ('${P6}', '[PROVER] New', 'E2-6', 'liquid', 'Gal', 'Herbicide', '${N1}', NULL, NULL, true, true);`, /EPA_REGISTRATION_FACT_CONFLICT: is_rup/);
  ownerOk(`INSERT INTO public.products (${NEW_COLS}) VALUES ('${P6}', '[PROVER] New', 'E2-6', 'liquid', 'Gal', 'Herbicide', '${N1}', NULL, NULL, false, true);`);
  assert.deepEqual(product(P6), { n: N1, sw: 'Warning', rup: false, rei: 4, phi: null });
  ownerRefused(`UPDATE public.product_brands SET signal_word = 'Danger' WHERE id = '${B1}';`, /EPA_REGISTRATION_FACT_CONFLICT/);
  ownerRefused(`UPDATE public.product_brands SET epa_registration = '${N1}' WHERE id = '${B1}';`, /EPA_REGISTRATION_ASSIGN/);
  ownerRefused(`INSERT INTO public.product_brands (product_id, brand_name, epa_registration, is_rup, created_by, updated_by) VALUES ('${P5}', '[PROVER] X', '${N2}', false, '${ADMIN}', '${ADMIN}');`, /EPA_REGISTRATION_FACT_CONFLICT: restricted use/);
  ownerOk(`INSERT INTO public.product_brands (product_id, brand_name, epa_registration, created_by, updated_by) VALUES ('${P5}', '[PROVER] Y', '${N2}', '${ADMIN}', '${ADMIN}');`);
  assert.equal(scalar(`SELECT signal_word || '|' || is_rup FROM public.product_brands WHERE brand_name = '[PROVER] Y';`), 'Danger|true');
  ownerOk(`INSERT INTO public.product_brands (product_id, brand_name, epa_registration, created_by, updated_by) VALUES ('${P5}', '[PROVER] Z', '${N4}', '${ADMIN}', '${ADMIN}');`);
  assert.equal(scalar(`SELECT COALESCE(is_rup::text, 'null') FROM public.product_brands WHERE brand_name = '[PROVER] Z';`), 'null');
  console.log('[prover] case 6: after the seed a registered size\'s or brand\'s facts and number cannot be edited directly, a numberless size can, and a new size or brand takes its number\'s facts (a conflicting one or an unregistered number is refused)');

  // 7. set_epa_registration.
  refused(REP, SET(N1, 1, { phi_days: 30 }, 'k-rep'), /ADMIN_REQUIRED/);
  refused(ADMIN, SET(N1, 7, { phi_days: 30 }, 'k-st'), /EPA_REGISTRATION_STALE/);
  refused(ADMIN, SET(N1, 1, {}, 'k-empty'), /EPA_REGISTRATION_NO_CHANGES/);
  const set1 = okJ(ADMIN, SET(N1, 1, { signal_word: 'Caution', phi_days: 30 }, 'k-set1'));
  assert.equal(set1.registration_version, 2); assert.equal(set1.event_type, 'updated'); assert.equal(set1.affected_count, 3);
  assert.deepEqual(okJ(ADMIN, SET(N1, 1, { signal_word: 'Caution', phi_days: 30 }, 'k-set1')), set1);
  for (const pid of [P1, P3, P6]) assert.deepEqual(product(pid), { n: N1, sw: 'Caution', rup: false, rei: 4, phi: 30 });
  const set2 = okJ(ADMIN, SET('400-4', null, { rup_status: 'no', signal_word: 'Caution' }, 'k-set2'));
  assert.equal(set2.event_type, 'created');
  refused(ADMIN, SET('0400-4', null, { rup_status: 'no' }, 'k-set3'), /EPA_REGISTRATION_NUMBER_INVALID/);
  console.log('[prover] case 7: Edit registration refuses a non-admin, an old version and no change; it bumps the version, copies the facts to every size, replays under its key, and creates a new number');

  // 8. Change EPA number (size and brand).
  let ap = okJ(ADMIN, `SELECT public.preview_epa_assignment('products', '${P5}', '400-4');`);
  assert.equal(ap.current_number, null); assert.equal(ap.new_version, 1);
  const ASSIGN = (t, tid, n, facts, fp, v, key) => `SELECT public.assign_epa_registration('${t}', '${tid}', '${n}', ${facts ? J(facts) : 'NULL'}, ${q(fp)}, ${v ?? 'NULL'}, 'label says so', NULL, ${q(key)});`;
  refused(ADMIN, ASSIGN('products', P5, '400-4', null, 'old', 1, 'k-a0'), /EPA_REGISTRATION_STALE/);
  const a1 = okJ(ADMIN, ASSIGN('products', P5, '400-4', null, ap.target_fingerprint, 1, 'k-a1'));
  assert.equal(a1.new_number, '400-4');
  assert.deepEqual(product(P5), { n: '400-4', sw: 'Caution', rup: false, rei: null, phi: null });
  ap = okJ(ADMIN, `SELECT public.preview_epa_assignment('products', '${P5}', '500-5');`);
  refused(ADMIN, ASSIGN('products', P5, '500-5', null, ap.target_fingerprint, null, 'k-a2'), /EPA_REGISTRATION_FACTS_REQUIRED/);
  okJ(ADMIN, ASSIGN('products', P5, '500-5', { rup_status: 'yes', signal_word: 'Danger' }, ap.target_fingerprint, null, 'k-a3'));
  assert.deepEqual(product(P5), { n: '500-5', sw: 'Danger', rup: true, rei: null, phi: null });
  ap = okJ(ADMIN, `SELECT public.preview_epa_assignment('product_brands', '${B1}', '${N1}');`);
  okJ(ADMIN, ASSIGN('product_brands', B1, N1, null, ap.target_fingerprint, 2, 'k-a4'));
  assert.equal(scalar(`SELECT epa_registration || '|' || signal_word || '|' || is_rup FROM public.product_brands WHERE id = '${B1}';`), `${N1}|Caution|false`);
  console.log('[prover] case 8: Change EPA number moves a size or brand to a registered number (taking its facts), requires the new label\'s facts for an unregistered one, and refuses a stale preview');

  // 9. New product through the product tools: a new number needs its facts and becomes a registration.
  const NEW_PARENT = { name: '[PROVER] Brand new', product_form: 'liquid', generic_epa_registration: '600-6', category: 'Herbicide' };
  const NEW_SIZE = { product_name: '[PROVER] Brand new 1 gal', sku: 'E2-NW', inventory_unit: 'Gal' };
  refused(ADMIN, `SELECT public.create_product_with_parent(${J(NEW_PARENT)}, ${J(NEW_SIZE)}, 'k-np1');`, /EPA_REGISTRATION_FACTS_REQUIRED/);
  ok(ADMIN, `SELECT public.create_product_with_parent(${J(NEW_PARENT)}, ${J({ ...NEW_SIZE, is_rup: false, signal_word: 'Caution' })}, 'k-np2');`);
  assert.equal(reg('600-6').rup_status, 'no'); assert.equal(reg('600-6').signal_word, 'Caution');
  assert.equal(scalar("SELECT signal_word FROM public.products WHERE sku = 'E2-NW';"), 'Caution');
  console.log('[prover] case 9: creating a product with a new EPA number needs its label facts and records the registration in the same step');

  // 10. Label drafts commit through the registration.
  const draft = (phi, n, key) => ok(ADMIN, `SELECT public.create_label_draft('${P1}', NULL, NULL, ${phi}, ${q(n)}, NULL, NULL, 'label pdf', 'high', 'pending', '${key}');`);
  const COMMIT = (d, key, force = true, phi = 'NULL') => `SELECT public.commit_label_draft('${d}', 'accepted', NULL, NULL, ${phi}, NULL, NULL, NULL, ${force}, '${key}');`;
  const d1 = draft(21, N1, 'dk1');
  refused(ADMIN, COMMIT(d1, 'ck0', true, 22), /LABEL_DRAFT_CHANGED/);
  ok(ADMIN, COMMIT(d1, 'ck1'));
  assert.equal(reg(N1).phi_days, 21); assert.equal(reg(N1).registration_version, 3);
  assert.equal(product(P3).phi, 21);
  assert.equal(scalar(`SELECT count(*) FROM public.epa_registration_events WHERE epa_registration = '${N1}' AND event_type = 'draft_committed';`), '1');
  const d2 = draft(25, '100-1', 'dk2');
  refused(ADMIN, COMMIT(d2, 'ck2'), /LABEL_DRAFT_EPA_CHANGE/);
  const d3 = draft(28, N1, 'dk3');
  okJ(ADMIN, SET(N1, 3, { rei_hours: 8 }, 'k-set4'));
  refused(ADMIN, COMMIT(d3, 'ck3', false), /LABEL_DRAFT_STALE/);
  // An edit of a different registration cannot refresh this draft and clear its staleness.
  refused(ADMIN, SET(N2, 1, { rei_hours: 13 }, 'k-set5', d3), /LABEL_DRAFT_NOT_PENDING/);
  console.log('[prover] case 10: an accepted label draft updates the registration (and so every size), refuses edited values, a different number and a stale draft, and only an edit of its own number refreshes a draft');

  // 11. Invoice line capture.
  ownerOk(line(L5, INV1, P4, 3));
  assert.equal(capture(L5), `${N2}|yes|Danger|registration:${N2}@1|true`);
  ownerRefused(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, sale_rup_status, sale_facts_captured_at, sale_facts_source)
    VALUES ('${L6}', '${INV1}', '${P1}', 'x', 1, 'Gal', 1500, 1500, 'no', now(), 'product:${P1}');`, /INVOICE_LINE_SALE_CAPTURE/);
  // A capture with no source is never whole (a NULL in the CHECK must not pass it).
  {
    const r = psql(`SET session_replication_role = replica; UPDATE public.invoice_items SET sale_facts_source = NULL WHERE id = '${L5}';`,
      { allowFailure: true, user: 'supabase_admin' });
    assert.notEqual(r.status, 0, 'a capture with no source was accepted');
    assert.match(`${r.stdout}
${r.stderr}`, /invoice_items_sale_capture_whole/);
  }
  ownerRefused(`UPDATE public.invoice_items SET sale_rup_status = 'no' WHERE id = '${L5}';`, /INVOICE_LINE_SALE_CAPTURE/);
  // Never block a sale (Mason, 2026-11-09). A size whose number has no registration (guards prevent it; forced
  // here) still saves: it keeps the number and captures from the product.
  raw(`UPDATE public.products SET epa_registration = '999-9' WHERE id = '${P2}';`);
  ownerOk(line(L6, INV1, P2, 1));
  assert.equal(capture(L6), `999-9|no|product:${P2}|true`);
  raw(`DELETE FROM public.invoice_items WHERE id = '${L6}'; UPDATE public.products SET epa_registration = NULL WHERE id = '${P2}';`);
  // A numberless size's line cannot borrow a registered number (its brand's or any other): the number is dropped.
  ownerOk(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration)
    VALUES ('${L6}', '${INV1}', '${P2}', 'x', 1, 'Gal', 1500, 1500, '${N3}');`);
  assert.equal(capture(L6), `no|product:${P2}|true`);
  raw(`DELETE FROM public.invoice_items WHERE id = '${L6}';`);
  // Decision (a): a line sells under its size's number; another writer's number is replaced, not refused.
  ownerOk(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration)
    VALUES ('${L6}', '${INV1}', '${P1}', 'x', 1, 'Gal', 1500, 1500, '${N2}');`);
  assert.ok(capture(L6).startsWith(`${N1}|`), capture(L6));
  raw(`DELETE FROM public.invoice_items WHERE id = '${L6}';`);
  ownerOk(`UPDATE public.invoice_items SET unit_price_cents = 1600, extended_cents = 3200 WHERE id = '${L1}';`);
  assert.equal(capture(L1), `${N1}|no|Warning|seed-assumed:registration:${N1}@1|true`);
  ownerOk(`UPDATE public.invoice_items SET quantity = 3, extended_cents = 4800 WHERE id = '${L1}';`);
  assert.equal(capture(L1), `${N1}|no|Caution|registration:${N1}@4|true`);
  ownerOk(`UPDATE public.invoice_items SET quantity = 2, extended_cents = 3000 WHERE id = '${L2}';`);
  assert.equal(capture(L2), `no|product:${P2}|true`);
  // A quantity change on a Yes line takes today's facts but never lowers the Yes.
  raw(`UPDATE public.epa_registrations SET signal_word = 'Warning', rup_status = 'no' WHERE epa_registration = '${N2}';`);
  ownerOk(`UPDATE public.invoice_items SET quantity = 4, extended_cents = 6000 WHERE id = '${L5}';`);
  assert.equal(capture(L5), `${N2}|yes|Warning|registration:${N2}@1|true`);
  raw(`UPDATE public.epa_registrations SET signal_word = 'Danger', rup_status = 'yes' WHERE epa_registration = '${N2}';`);
  ownerOk(`UPDATE public.invoice_items SET quantity = 3, extended_cents = 4500 WHERE id = '${L5}';`);
  assert.equal(capture(L5), `${N2}|yes|Danger|registration:${N2}@1|true`);
  // A Yes line keeps the number it was sold under on a quantity change, even after its size moved to another number.
  raw(`UPDATE public.products SET epa_registration = '${N3}' WHERE id = '${P4}';`);
  ownerOk(`UPDATE public.invoice_items SET quantity = 5, extended_cents = 7500 WHERE id = '${L5}';`);
  assert.ok(capture(L5).startsWith(`${N2}|yes|`), capture(L5));
  raw(`UPDATE public.products SET epa_registration = '${N2}' WHERE id = '${P4}'; UPDATE public.invoice_items SET quantity = 3, extended_cents = 4500 WHERE id = '${L5}';`);
  console.log('[prover] case 11: a new line captures its number\'s registration; a sent capture is refused; an unregistered or different number never blocks the line; a price edit keeps the capture and a quantity edit re-captures');

  // 12. Posting writes the restricted-use record once.
  raw(`UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${INV1}';`);
  const GEN = (key) => `SELECT public.generate_rup_sales_records('${INV1}', '${key}');`;
  // L4 has no number and its product became restricted-use in case 8: posting goes through, with no blank-number record.
  assert.equal(ok(ADMIN, GEN('g0')), '1');
  assert.equal(scalar(`SELECT count(*) || '|' || count(*) FILTER (WHERE epa_registration IS NULL) FROM public.rup_sales_records WHERE invoice_id = '${INV1}';`), '1|0');
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
  raw(`UPDATE public.invoice_items SET extended_cents = 4500 WHERE id = '${L5}';
    INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration) VALUES ('${L6}', '${INV1}', '${P4}', 'x', 1, 'Gal', 1600, 1600, '${N2}');`);
  // A line with no capture (posted before the seed, unposted after) never blocks posting: it records under its stored number
  // with that number's registration facts, and Sales to check lists it (Codex App P2 on #1688: a split group cannot be re-saved).
  assert.equal(ok(ADMIN, GEN('g4')), '1');
  assert.equal(scalar(`SELECT epa_registration || '|' || quantity || '|' || signal_word FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 1600;`), `${N2}|1.0000|Danger`);
  raw(`DELETE FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND unit_price_cents = 1600; DELETE FROM public.invoice_items WHERE id = '${L6}';`);
  // The same product and number sold at a second price gets its own record; neither merges price nor total.
  raw(`UPDATE public.invoices SET status = 'draft', posted_at = NULL WHERE id = '${INV1}';`);
  ownerOk(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents) VALUES ('${L7}', '${INV1}', '${P4}', 'x', 2, 'Gal', 1700, 3400);`);
  raw(`UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${INV1}';`);
  assert.equal(ok(ADMIN, GEN('g5')), '1');
  assert.equal(scalar(`SELECT string_agg(quantity || '@' || unit_price_cents || '=' || total_cents, ',' ORDER BY unit_price_cents) FROM public.rup_sales_records WHERE invoice_id = '${INV1}' AND voided_at IS NULL;`),
    '3.0000@1500=4500,2.0000@1700=3400');
  assert.equal(ok(ADMIN, GEN('g6')), '0');
  console.log('[prover] case 12: posting never refuses a numberless restricted-use line (it gets no record), writes one restricted-use record per sold number, unit and price, skips it on a repeat, refuses a record that disagrees, and posts a line with no capture from its stored number');

  // 13. Sales to check.
  refused(REP, 'SELECT public.get_epa_sales_to_check();', /ADMIN_REQUIRED/);
  assert.equal(okJ(ADMIN, 'SELECT public.get_epa_sales_to_check();').some((x) => x.line_id === L4), false);  // drafts are not listed
  raw(`UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${INV3}';`);
  const check = Object.fromEntries(okJ(ADMIN, 'SELECT public.get_epa_sales_to_check();').map((x) => [x.line_id, x.reasons]));
  assert.deepEqual(check[L3], ['restricted_use_to_record', 'posted_before_seed']);
  assert.deepEqual(check[L2], ['no_epa_number']);
  assert.deepEqual(check[L4], ['seed_assumed', 'no_epa_number']);
  assert.equal(check[L5], undefined);
  assert.equal(check[L7], undefined);
  // A posted line under a number with no registration is listed for follow-up.
  raw(`UPDATE public.products SET epa_registration = '999-9' WHERE id = '${P2}'; UPDATE public.invoices SET status = 'draft', posted_at = NULL WHERE id = '${INV3}';`);
  ownerOk(line(L6, INV3, P2, 1));
  raw(`UPDATE public.products SET epa_registration = NULL WHERE id = '${P2}'; UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = '${INV3}';`);
  assert.deepEqual(Object.fromEntries(okJ(ADMIN, 'SELECT public.get_epa_sales_to_check();').map((x) => [x.line_id, x.reasons]))[L6], ['no_registration']);
  raw(`DELETE FROM public.invoice_items WHERE id = '${L6}';`);
  // A record covers only its own price: with the second-price record voided, that line is listed and L5 is not.
  raw(`UPDATE public.rup_sales_records SET voided_at = now() WHERE invoice_id = '${INV1}' AND unit_price_cents = 1700;`);
  const check2 = Object.fromEntries(okJ(ADMIN, 'SELECT public.get_epa_sales_to_check();').map((x) => [x.line_id, x.reasons]));
  assert.ok(check2[L7]?.includes('restricted_use_to_record'), JSON.stringify(check2[L7]));
  assert.equal(check2[L5], undefined);
  // A sale captured Yes stays on the list after its registration turns No.
  raw(`UPDATE public.epa_registrations SET rup_status = 'no' WHERE epa_registration = '${N2}';`);
  const check3 = Object.fromEntries(okJ(ADMIN, 'SELECT public.get_epa_sales_to_check();').map((x) => [x.line_id, x.reasons]));
  assert.ok(check3[L7]?.includes('restricted_use_to_record'), JSON.stringify(check3[L7]));
  raw(`UPDATE public.epa_registrations SET rup_status = 'yes' WHERE epa_registration = '${N2}';`);
  assert.equal(scalar(`SELECT public._epa_registration_unrecorded_posted_lines('${N2}') @> '[{"invoice_item_id": "${L7}"}]' AND NOT public._epa_registration_unrecorded_posted_lines('${N2}') @> '[{"invoice_item_id": "${L5}"}]';`), 't');
  // 14. save_invoice: a quantity change on a kept Yes line takes today's facts and keeps the Yes.
  raw(`INSERT INTO public.invoices (id, customer_id, order_id, invoice_number, status, invoice_date, created_by)
      VALUES ('${INV4}', '${CUST}', '${ORD}', 'E2-I4', 'draft', current_date, '${ADMIN}');`);
  ownerOk(line(L8, INV4, P4, 2));
  raw(`UPDATE public.epa_registrations SET signal_word = 'Warning', rup_status = 'no' WHERE epa_registration = '${N2}';`);
  ok(ADMIN, `SELECT public.save_invoice(${J({ id: INV4, customer_id: CUST, order_id: ORD, status: 'draft', invoice_date: scalar('SELECT current_date::text;') })},
    ${J([{ id: L8, product_id: P4, description: '[PROVER] line', quantity: 5, unit_size: 'Gal', unit_price_cents: 1500 }])}, 'k-save14');`);
  assert.equal(scalar(`SELECT quantity || '|' || sale_rup_status || '|' || sale_signal_word || '|' || sale_facts_source FROM public.invoice_items WHERE invoice_id = '${INV4}';`),
    `5.0000|yes|Warning|registration:${N2}@1`);
  // A kept line ignores a different number from the screen and keeps its sold number (never refused).
  ok(ADMIN, `SELECT public.save_invoice(${J({ id: INV4, customer_id: CUST, order_id: ORD, status: 'draft', invoice_date: scalar('SELECT current_date::text;') })},
    ${J([{ id: scalar(`SELECT id FROM public.invoice_items WHERE invoice_id = '${INV4}';`), product_id: P4, description: '[PROVER] line', quantity: 5, unit_size: 'Gal', unit_price_cents: 1500, epa_registration: N3 }])}, 'k-save14b');`);
  assert.equal(scalar(`SELECT epa_registration || '|' || sale_rup_status FROM public.invoice_items WHERE invoice_id = '${INV4}';`), `${N2}|yes`);
  // A legacy (uncaptured) kept line keeps the number it was stored under, not its product's current one.
  raw(`INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration)
    VALUES ('${L6}', '${INV4}', '${P4}', '[PROVER] legacy', 1, 'Gal', 1500, 1500, '${N1}');`);
  ok(ADMIN, `SELECT public.save_invoice(${J({ id: INV4, customer_id: CUST, order_id: ORD, status: 'draft', invoice_date: scalar('SELECT current_date::text;') })},
    ${J([{ id: scalar(`SELECT id FROM public.invoice_items WHERE invoice_id = '${INV4}' AND description = '[PROVER] line';`), product_id: P4, description: '[PROVER] line', quantity: 5, unit_size: 'Gal', unit_price_cents: 1500 },
         { id: L6, product_id: P4, description: '[PROVER] legacy', quantity: 1, unit_size: 'Gal', unit_price_cents: 1500, epa_registration: N1 }])}, 'k-save14c');`);
  assert.equal(scalar(`SELECT epa_registration FROM public.invoice_items WHERE invoice_id = '${INV4}' AND description = '[PROVER] legacy';`), N1);
  // save_invoice: a kept Yes line keeps its sold number on a quantity change after its size moved number.
  raw(`UPDATE public.products SET epa_registration = '${N3}' WHERE id = '${P4}';`);
  ok(ADMIN, `SELECT public.save_invoice(${J({ id: INV4, customer_id: CUST, order_id: ORD, status: 'draft', invoice_date: scalar('SELECT current_date::text;') })},
    ${J([{ id: scalar(`SELECT id FROM public.invoice_items WHERE invoice_id = '${INV4}' AND description = '[PROVER] line';`), product_id: P4, description: '[PROVER] line', quantity: 6, unit_size: 'Gal', unit_price_cents: 1500 }])}, 'k-save14d');`);
  assert.equal(scalar(`SELECT epa_registration || '|' || sale_rup_status FROM public.invoice_items WHERE invoice_id = '${INV4}';`), `${N2}|yes`);
  raw(`UPDATE public.products SET epa_registration = '${N2}' WHERE id = '${P4}';`);
  raw(`UPDATE public.epa_registrations SET signal_word = 'Danger', rup_status = 'yes' WHERE epa_registration = '${N2}';`);
  console.log('[prover] case 14: save_invoice re-captures a kept Yes line on a quantity change with the current facts and keeps the Yes');
  console.log('[prover] case 13: Sales to check lists a restricted-use sale posted before the seed, a numberless sale and a seed-assumed one, and not a recorded one');
  console.log('EPA_REGISTRATION_STEP2_PROOF_PASS');
}
try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
