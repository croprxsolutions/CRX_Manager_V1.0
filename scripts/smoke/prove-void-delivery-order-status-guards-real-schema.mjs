#!/usr/bin/env node
/**
 * Real-schema proof for KI-102 and KI-101 (20261107120000). Builds the checked-in schema baseline in a
 * network-disabled PostgreSQL container and replays migrations up to the candidate (the void body then equals
 * live's, md5 5ed655f5...). With invented rows, BEFORE the candidate:
 *   KI-102: an order is fully delivered, voided (stock goes back), then its delivery is voided: the stock goes
 *     back a second time and the voided order is reopened.
 *   KI-101: a part-delivered order is cancelled through the full-cancel path (as older cancels and the direct
 *     status grant can leave it), then its delivery is voided: the cancelled order is reopened and the
 *     reservation the cancel released comes back.
 * AFTER the candidate (a second apply refuses): the KI-102 void is refused and nothing moves; the KI-101 void
 * keeps the order cancelled, puts the goods back on the shelf, does not restore the reservation and leaves
 * nothing to deliver. Three normal voids (full, one of two deliveries, a closed-remainder order) give the same
 * stock and status before and after. A replayed void returns its receipt; grants stay postgres-only.
 *
 * Run: node scripts/smoke/prove-void-delivery-order-status-guards-real-schema.mjs   (needs local Docker image)
 * Prints VOID_DELIVERY_ORDER_STATUS_GUARDS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-void-order-status-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);  // a kept container still before the candidate
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261107120000_void_delivery_respects_voided_and_cancelled_orders.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations and DATA-11 rewrite live rows this disposable database does not have
// (DATA-11 also needs a live admin approver); they are recorded in the ledger (as live has them)
// instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(_void_delivery_replay_impl_20261015|_void_order_impl_20260714|FUNCTION public\.void_delivery\(|FUNCTION public\.void_order\()/i;
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

// Each phase (before / after the candidate) seeds its own rows.
let PHASE = Number(process.env.KI102_PHASE || 1);  // a reused container needs fresh rows
const id = (n) => `10200000-000${PHASE}-4000-8000-${n.padStart(12, '0')}`;
let ADMIN;
let CUSTOMER;
// One product and order per case; every product starts 100 on hand, 10 reserved for its order of 10.
//   name: planned quantity per delivery
const CASES = {
  voided: [10],       // KI-102: fully delivered, then the order is voided
  cancelled: [10],    // KI-101: 4 delivered, then the order is fully cancelled
  full: [10],         // normal: fully delivered, delivery voided
  second: [6, 4],     // normal: two deliveries, the second voided
  closed: [10],       // normal: 4 delivered, remainder closed (today's cancel of a part-delivered order)
};
const KEYS = Object.keys(CASES);
const P = (i) => id(`f${i + 1}`);
const O = (i) => id(`d${i + 1}`);
const OI = (i) => id(`e${i + 1}`);
const D = (i, j) => id(`b${i + 1}${j}`);
const DI = (i, j) => id(`9${i + 1}${j}`);

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function asAdmin(sql, options = {}) {
  return docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;\n${sql}\nCOMMIT;`, allowFailure: options.allowFailure });
}

function seed() {
  ADMIN = id('a1');
  CUSTOMER = id('c1');
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ki102-admin-${PHASE}@example.invalid', '{"full_name":"[PROVER] KI102 Admin ${PHASE}","role":"admin"}'::jsonb);`);
  const rows = KEYS.map((k, i) => {
    const deliveries = CASES[k].map((qty, j) => `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date)
        VALUES ('${D(i, j)}', 'PROVER-KI102-D${PHASE}-${i}-${j}', '${O(i)}', '${CUSTOMER}', '${ADMIN}', 'in_progress', current_date);
      INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
        VALUES ('${DI(i, j)}', '${D(i, j)}', '${OI(i)}', '${P(i)}', ${qty}, 'GL');`).join('\n      ');
    return `INSERT INTO public.products (id, product_name, sku, unit_size, current_cost, tier1_price, is_active)
        VALUES ('${P(i)}', '[PROVER] KI102 ${k}', 'KI102-${PHASE}-${i}', 'GL', 6.00, 10.00, true);
      INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
        VALUES ('${P(i)}', 'Main Warehouse', 100, 10, 'GL');
      INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
        VALUES ('${O(i)}', 'PROVER-KI102-${PHASE}-${i}', '${CUSTOMER}', current_date, 'confirmed', false, '${ADMIN}');
      INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
          total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
        VALUES ('${OI(i)}', '${O(i)}', '${P(i)}', '[PROVER] KI102 ${k}', 10, 6, 10, 100, 40, 40, 0, 10);
      ${deliveries}`;
  });
  // Invented rows only; triggers are skipped so the seed sets exactly the shapes under test.
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUSTOMER}', '[PROVER] KI102 Farm ${PHASE}', true);
    ${rows.join('\n    ')}`);
}

// on hand/reserved | order status | line delivered/remaining | void reversal rows
const state = (i) => scalar(`SELECT inv.quantity_available::numeric(12,2) || '/' || inv.quantity_prebooked::numeric(12,2)
    || ' ' || o.status || ' ' || oi.quantity_delivered::numeric(12,2) || '/' || oi.quantity_remaining::numeric(12,2)
    || ' x' || (SELECT count(*) FROM public.inventory_transactions t WHERE t.product_id = '${P(i)}' AND t.transaction_type = 'void_delivery_reversal')
  FROM public.inventory inv, public.orders o, public.order_items oi
  WHERE inv.product_id = '${P(i)}' AND inv.location = 'Main Warehouse' AND o.id = '${O(i)}' AND oi.id = '${OI(i)}';`);

function complete(i, j, qty) {
  asAdmin(`SELECT public.complete_delivery('${D(i, j)}', 'No proof — recorded by office', '${ADMIN}',
      jsonb_build_object('${DI(i, j)}', ${qty}), NULL, NULL, 'ki102-complete-${PHASE}-${i}-${j}', NULL,
      'no_proof', '[PROVER] no signature');`);
}
function voidDelivery(i, j, options = {}) {
  return asAdmin(`SELECT public.void_delivery('${D(i, j)}', '[PROVER] wrong delivery', '${ADMIN}', 'ki102-void-${PHASE}-${i}-${j}${options.suffix ?? ''}');`, { allowFailure: options.allowFailure });
}
function voidOrder(i) {
  asAdmin(`SELECT public.void_order('${O(i)}', '${ADMIN}', '[PROVER] wrong order', 'ki102-void-order-${PHASE}-${i}');`);
}
// The full-cancel path on a part-delivered order: how cancels before 2026-07-21 left such orders (today's
// cancel_order closes the remainder instead). Real code, called directly as the signed-in admin.
function legacyFullCancel(i) {
  psql(`BEGIN;\n${claims(ADMIN)}
    SELECT public._cancel_order_provenance_wrapper_20260719('${O(i)}', '${ADMIN}', NULL);
    SELECT set_config('app.admin_override', 'false', true);
    COMMIT;`);
}
function cancelOrder(i) {
  asAdmin(`SELECT public.cancel_order('${O(i)}', '${ADMIN}', 'ki102-cancel-${PHASE}-${i}');`);
}

// Runs every case; returns { case: [state after each step, ..., void outcome, state] }.
function runCases(label) {
  const out = {};
  const voidStep = (i, j) => {
    const r = voidDelivery(i, j, { allowFailure: true });
    return r.status === 0 ? 'void ok' : `void refused: ${(/ERROR:\s+([A-Z_]+)/.exec(r.stderr) || [null, r.stderr.trim()])[1]}`;
  };
  KEYS.forEach((k, i) => {
    const steps = [];
    if (k === 'second') {
      complete(i, 0, 6); complete(i, 1, 4); steps.push(state(i));
      steps.push(voidStep(i, 1), state(i));
    } else {
      complete(i, 0, k === 'cancelled' || k === 'closed' ? 4 : 10); steps.push(state(i));
      if (k === 'voided') { voidOrder(i); steps.push(state(i)); }
      if (k === 'cancelled') { legacyFullCancel(i); steps.push(state(i)); }
      if (k === 'closed') { cancelOrder(i); steps.push(state(i)); }
      steps.push(voidStep(i, 0), state(i));
    }
    out[k] = steps;
    console.log(`[prover] ${label} ${k}: ${steps.join(' -> ')}`);
  });
  return out;
}

function grantsLikeLive() {
  // The rebuild baseline leaves internal impls PUBLIC-executable; live has postgres only.
  psql(`REVOKE ALL ON FUNCTION public._void_delivery_replay_impl_20261015(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;`);
}

const IMPL = 'public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)';
// state format: on hand/reserved, order status, line delivered/remaining, void reversal rows
const NORMAL = {
  full: ['90.00/0.00 fulfilled 10.00/0.00 x0', 'void ok', '100.00/10.00 confirmed 0.00/10.00 x1'],
  second: ['90.00/0.00 fulfilled 10.00/0.00 x0', 'void ok', '94.00/4.00 partially_fulfilled 6.00/4.00 x1'],
  closed: ['96.00/6.00 partially_fulfilled 4.00/6.00 x0', '96.00/0.00 fulfilled 4.00/0.00 x0', 'void ok', '100.00/4.00 confirmed 0.00/4.00 x1'],
};

function main() {
  if (!REUSE) buildContainer();
  grantsLikeLive();
  // The replay reproduces live's body exactly (read live 2026-11-04; the candidate's preflight pins it too).
  assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = '${IMPL}'::regprocedure;`), '5ed655f54d8bf169b8986dbe2184c0d0');

  // BEFORE: both bugs reproduce on the replayed schema.
  seed();
  const before = runCases('before');
  assert.deepEqual(before.voided, ['90.00/0.00 fulfilled 10.00/0.00 x0', '100.00/0.00 voided 10.00/0.00 x1',
    'void ok', '110.00/10.00 confirmed 0.00/10.00 x2'], 'KI-102 before: stock back twice, voided order reopened');
  assert.deepEqual(before.cancelled, ['96.00/6.00 partially_fulfilled 4.00/6.00 x0', '96.00/0.00 cancelled 4.00/0.00 x0',
    'void ok', '100.00/4.00 partially_fulfilled 0.00/4.00 x1'], 'KI-101 before: cancelled order reopened, reservation back');
  for (const k of Object.keys(NORMAL)) assert.deepEqual(before[k], NORMAL[k], `${k} before`);
  console.log('[prover] BEFORE: KI-102 reproduces (110 on hand from 100, voided order reopened); KI-101 reproduces (cancelled order reopened, 4 reserved again)');

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /PREFLIGHT_VOID_ORDER_STATUS_GUARD_DRIFT/);
  assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = '${IMPL}'::regprocedure;`), '54809f64a1f7361a495e368585cd501a');
  console.log('[prover] candidate applied once; a second apply refuses at the preflight');

  PHASE += 1;
  seed();
  const after = runCases('after');
  assert.deepEqual(after.voided, ['90.00/0.00 fulfilled 10.00/0.00 x0', '100.00/0.00 voided 10.00/0.00 x1',
    'void refused: ORDER_VOIDED_DELIVERY_LOCKED', '100.00/0.00 voided 10.00/0.00 x1'], 'KI-102 after');
  assert.equal(scalar(`SELECT status FROM public.deliveries WHERE id = '${D(0, 0)}';`), 'completed');
  const ci = KEYS.indexOf('cancelled');
  assert.deepEqual(after.cancelled, ['96.00/6.00 partially_fulfilled 4.00/6.00 x0', '96.00/0.00 cancelled 4.00/0.00 x0',
    'void ok', '100.00/0.00 cancelled 0.00/0.00 x1'], 'KI-101 after');
  assert.equal(scalar(`SELECT requires_review::text || ' ' || (notes LIKE '%reservation not restored: the order is cancelled%')::text
    FROM public.inventory_transactions WHERE product_id = '${P(ci)}' AND transaction_type = 'void_delivery_reversal';`), 'false true');
  assert.equal(scalar(`SELECT status FROM public.deliveries WHERE id = '${D(ci, 0)}';`), 'voided');
  for (const k of Object.keys(NORMAL)) assert.deepEqual(after[k], NORMAL[k], `${k} after: unchanged`);
  console.log('[prover] AFTER: KI-102 void refused and nothing moved; KI-101 order stays cancelled, goods back on the shelf, reservation not restored; the three normal voids match BEFORE exactly');

  // A replay of a finished void returns its receipt and changes nothing; a fresh second void is refused.
  const fi = KEYS.indexOf('full');
  const replay = voidDelivery(fi, 0, { allowFailure: true });
  assert.equal(replay.status, 0, replay.stderr);
  const twice = voidDelivery(fi, 0, { suffix: '-again', allowFailure: true });
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /Only completed deliveries can be voided/);
  assert.equal(state(fi), NORMAL.full.at(-1));
  // Grants and settings unchanged: postgres-only EXECUTE, SECURITY DEFINER, pinned search_path.
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', '${IMPL}', 'EXECUTE') OR has_function_privilege('anon', '${IMPL}', 'EXECUTE')`), 'f');
  assert.equal(scalar(`SELECT prosecdef::text || ' ' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${IMPL}'::regprocedure;`), 'true search_path=public, pg_temp');
  console.log('[prover] a replayed void changes nothing, a second void is refused, grants unchanged');
  console.log('VOID_DELIVERY_ORDER_STATUS_GUARDS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
