#!/usr/bin/env node
/**
 * Real-schema proof for KI-94 (20261106230000): voiding a delivery puts back exactly the reserved stock its
 * completion took. Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays
 * migrations up to the candidate, shows the bug on invented rows (3 reserved, 10 delivered, void leaves 10
 * reserved), applies the candidate (a second apply refuses), then completes and voids five cases: short,
 * fully reserved, part delivered, nothing reserved, and a legacy line with no record. Then applies the follow-up
 * 20261106233000 (a second apply refuses) and shows only the legacy void's ledger row is flagged for review.
 *
 * Run: node scripts/smoke/prove-void-delivery-exact-reservation-real-schema.mjs   (needs local Docker image)
 * Prints VOID_DELIVERY_EXACT_RESERVATION_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-ki94-void-reservation-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261106230000_void_delivery_restores_exact_reservation.sql');
const FOLLOWUP = path.join(MIGRATIONS, '20261106233000_void_delivery_flags_legacy_reservation.sql');
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
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(_complete_delivery_authorized_impl|_void_delivery_replay_impl_20261015|quantity_prebooked_released)/i;
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
  assert.equal(all[at + 1], FOLLOWUP, 'the legacy-flag follow-up must sort right after the candidate');
  for (const file of all.slice(at + 2)) {
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
let PHASE = Number(process.env.KI94_PHASE || 1);  // a reused container needs fresh rows
const id = (n) => `9494000${PHASE}-0000-4000-8000-${n.padStart(12, '0')}`;
let ADMIN = id('a1');
let CUSTOMER = id('c1');
// One product per case, so each case reads its own inventory row.
//   name: [reserved before, ordered, delivered]
const CASES = {
  short: ['3', '10', '10'],     // KI-94: 3 reserved, 10 delivered
  full: ['15', '10', '10'],     // fully reserved, with 5 more reserved for someone else
  partial: ['10', '10', '4'],   // part delivered
  none: ['0', '10', '10'],      // nothing reserved
  legacy: ['3', '10', '10'],    // completed before the fix: no record
};
const KEYS = Object.keys(CASES);
const n = (i, k) => id(`${k}${i + 1}`);
const P = (i) => n(i, 'f');
const O = (i) => n(i, 'd');
const OI = (i) => n(i, 'e');
const D = (i) => n(i, 'b');
const DI = (i) => n(i, '9');

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ki94-admin-${PHASE}@example.invalid', '{"full_name":"[PROVER] KI94 Admin ${PHASE}","role":"admin"}'::jsonb);`);
  const rows = KEYS.map((k, i) => {
    const [reserved, ordered] = CASES[k];
    return `INSERT INTO public.products (id, product_name, sku, unit_size, current_cost, tier1_price, is_active)
        VALUES ('${P(i)}', '[PROVER] KI94 ${k}', 'KI94-${PHASE}-${i}', 'GL', 6.00, 10.00, true);
      INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
        VALUES ('${P(i)}', 'Main Warehouse', 100, ${reserved}, 'GL');
      INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
        VALUES ('${O(i)}', 'PROVER-KI94-${PHASE}-${i}', '${CUSTOMER}', current_date, 'confirmed', false, '${ADMIN}');
      INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
          total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
        VALUES ('${OI(i)}', '${O(i)}', '${P(i)}', '[PROVER] KI94 ${k}', 10, 6, ${ordered}, ${ordered} * 10, ${ordered} * 4, 40, 0, ${ordered});
      INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date)
        VALUES ('${D(i)}', 'PROVER-KI94-D${PHASE}-${i}', '${O(i)}', '${CUSTOMER}', '${ADMIN}', 'in_progress', current_date);
      INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
        VALUES ('${DI(i)}', '${D(i)}', '${OI(i)}', '${P(i)}', ${ordered}, 'GL');`;
  });
  // Invented rows only; triggers are skipped so the seed sets exactly the shapes under test.
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUSTOMER}', '[PROVER] KI94 Farm ${PHASE}', true);
    ${rows.join('\n    ')}`);
}

const stock = (i) => scalar(`SELECT quantity_available::numeric(12,2) || '/' || quantity_prebooked::numeric(12,2)
  FROM public.inventory WHERE product_id = '${P(i)}' AND location = 'Main Warehouse';`);
const released = (i) => scalar(`SELECT coalesce(quantity_prebooked_released::numeric(12,2)::text, 'NULL') FROM public.delivery_items WHERE id = '${DI(i)}';`);
const f2 = (x) => Number(x).toFixed(2);

function complete(i) {
  const [, , delivered] = CASES[KEYS[i]];
  psql(`BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;
    SELECT public.complete_delivery('${D(i)}', 'No proof — recorded by office', '${ADMIN}',
      jsonb_build_object('${DI(i)}', ${delivered}), NULL, NULL, 'ki94-complete-${PHASE}-${i}', NULL,
      'no_proof', '[PROVER] no signature');
    COMMIT;`);
}
function voidDelivery(i, options = {}) {
  return docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;
    SELECT public.void_delivery('${D(i)}', '[PROVER] wrong delivery', '${ADMIN}', 'ki94-void-${PHASE}-${i}${options.suffix ?? ''}');
    COMMIT;`, allowFailure: options.allowFailure });
}

// Run every case; returns { case: { afterComplete, released, afterVoid } }.
function runCases(label) {
  const out = {};
  KEYS.forEach((k, i) => {
    complete(i);
    if (k === 'legacy') {
      // A line completed before the fix has no record.
      psql(`SET session_replication_role = replica; UPDATE public.delivery_items SET quantity_prebooked_released = NULL WHERE id = '${DI(i)}';`, { allowFailure: label === 'before' });
    }
    const afterComplete = stock(i);
    const rel = label === 'before' ? 'n/a' : released(i);
    voidDelivery(i);
    out[k] = { afterComplete, released: rel, afterVoid: stock(i) };
    console.log(`[prover] ${label} ${k}: reserved ${CASES[k][0]}, delivered ${CASES[k][2]} -> after complete ${afterComplete} (released ${rel}) -> after void ${out[k].afterVoid}`);
  });
  return out;
}

function grantsLikeLive() {
  // The rebuild baseline leaves internal impls PUBLIC-executable; live has postgres only.
  psql(`REVOKE ALL ON FUNCTION public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION public._void_delivery_replay_impl_20261015(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;`);
}

function main() {
  if (!REUSE) buildContainer();
  grantsLikeLive();
  // The replay reproduces live's two bodies exactly (the preflight pins them).
  assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)'::regprocedure;`), '35737fb8d9f2dff727f8230c60781747');
  assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._void_delivery_replay_impl_20261015(uuid,text,uuid,text)'::regprocedure;`), '3ef685c8f5bf778e3ae38aa2f89304da');

  // BEFORE: the bug is real on the replayed schema (the void over-restores the short case).
  seed();
  const before = runCases('before');
  assert.equal(before.short.afterVoid, `${f2(100)}/${f2(10)}`, 'before the fix a void of 3-reserved/10-delivered leaves 10 reserved');
  console.log('[prover] BEFORE: the bug reproduces (3 reserved, 10 delivered, void leaves 10 reserved)');

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /PREFLIGHT_VOID_EXACT_RESERVATION_DRIFT/);
  console.log('[prover] candidate applied once; a second apply refuses at the preflight');

  PHASE += 1;
  ADMIN = id('a1');
  CUSTOMER = id('c1');
  seed();
  const after = runCases('after');
  const expect = {
    short: { afterComplete: '90.00/0.00', released: '3.00', afterVoid: '100.00/3.00' },
    full: { afterComplete: '90.00/5.00', released: '10.00', afterVoid: '100.00/15.00' },
    partial: { afterComplete: '96.00/6.00', released: '4.00', afterVoid: '100.00/10.00' },
    none: { afterComplete: '90.00/0.00', released: '0.00', afterVoid: '100.00/0.00' },
    legacy: { afterComplete: '90.00/0.00', released: 'NULL', afterVoid: '100.00/10.00' },
  };
  assert.deepEqual(after, expect);
  console.log('[prover] AFTER: every void puts back exactly what completion took (legacy line keeps the old restore)');

  // The void ledger note states the reservation amount; on-hand quantity on the ledger is unchanged.
  assert.equal(scalar(`SELECT quantity::numeric(12,2) || ' ' || (notes LIKE '%reservation restored: 3%')::text FROM public.inventory_transactions
    WHERE product_id = '${P(0)}' AND transaction_type = 'void_delivery_reversal';`), '10.00 true');
  // A second void of the same delivery is refused (no double restore).
  const twice = voidDelivery(0, { suffix: '-again', allowFailure: true });
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /Only completed deliveries can be voided/);
  assert.equal(stock(0), '100.00/3.00');
  // A replay of the first void (same key) returns its receipt and changes nothing.
  const replay = voidDelivery(0, { allowFailure: true });
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(stock(0), '100.00/3.00');
  console.log('[prover] a second void is refused, a replayed void changes nothing');

  // FOLLOW-UP: only a legacy line's void row is flagged for review, with the note; quantities are unchanged.
  stageText('followup.sql', lf(FOLLOWUP));
  const flagFirst = apply('followup.sql');
  assert.equal(flagFirst.status, 0, flagFirst.output);
  const flagAgain = apply('followup.sql');
  assert.notEqual(flagAgain.status, 0, 'a second apply of the follow-up must refuse');
  assert.match(flagAgain.output, /PREFLIGHT_VOID_LEGACY_FLAG_DRIFT/);
  PHASE += 1;
  ADMIN = id('a1');
  CUSTOMER = id('c1');
  seed();
  assert.deepEqual(runCases('flagged'), expect);
  KEYS.forEach((k, i) => {
    assert.equal(scalar(`SELECT requires_review::text || ' ' || (notes LIKE '%completed before the KI-94 fix%')::text
      FROM public.inventory_transactions WHERE product_id = '${P(i)}' AND transaction_type = 'void_delivery_reversal';`),
    k === 'legacy' ? 'true true' : 'false false', `${k}: review flag`);
  });
  console.log('[prover] FOLLOW-UP: applied once (a second apply refuses); only the legacy void row is flagged for review');

  // The column refuses a negative amount; grants on the two impls are unchanged (postgres only).
  const neg = psql(`UPDATE public.delivery_items SET quantity_prebooked_released = -1 WHERE id = '${DI(0)}';`, { allowFailure: true });
  assert.notEqual(neg.status, 0);
  for (const sig of ['_complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)', '_void_delivery_replay_impl_20261015(uuid,text,uuid,text)']) {
    assert.equal(scalar(`SELECT has_function_privilege('authenticated', 'public.${sig}', 'EXECUTE') OR has_function_privilege('anon', 'public.${sig}', 'EXECUTE')`), 'f');
  }
  console.log('VOID_DELIVERY_EXACT_RESERVATION_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
