#!/usr/bin/env node
/**
 * Real-schema proof for KI-25 (20261108100000): a customer receipt owed after a delivery completion is recorded in
 * the database in the same transaction, and the service_role worker calls send it at most once per claim.
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays migrations up to the
 * candidate, completes one delivery with today's call (key K), applies the candidate (a second apply refuses),
 * then shows on invented rows: K still replays with its saved fingerprint and records nothing; TRUE records one
 * receipt with the right content; NULL, FALSE, no_proof and a customer with no email record none; a replay records
 * none; and the worker calls claim, lease, back off, cap, stop at 23 hours, settle rows sent elsewhere, cancel
 * deliveries no longer completed, refuse stale claims, and stay service_role only. No email is sent.
 *
 * Run: node scripts/smoke/prove-delivery-receipt-queue-real-schema.mjs   (needs local Docker image)
 * Prints DELIVERY_RECEIPT_QUEUE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-ki25-receipt-queue-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261108100000_delivery_receipt_queue.sql');
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
const TOUCHED = /(public[.]complete_delivery[(]|delivery_receipt)/i;
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
let PHASE = Number(process.env.KI94_PHASE || 1);  // a reused container needs fresh rows

const id = (n) => `25250000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const DRIVER = id('a2');
const CUST = id('c1');        // has an email
const CUST_NOEMAIL = id('c2');
const P = (i) => id(`f${i}`);
const O = (i) => id(`d${i}`);
const OI = (i) => id(`e${i}`);
const D = (i) => id(`b${i}`);
const DI = (i) => id(`9${i}`);
const PH = (i) => id(`7${i}`);
const LEFT = 'No one present — left at site';

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function q(sql, options = {}) {
  const r = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: options.allowFailure });
  return { status: r.status, out: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '', err: r.stderr };
}
function seedUsers() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ki25-admin@example.invalid', '{"full_name":"[PROVER] KI25 Admin","role":"admin"}'::jsonb),
    ('${DRIVER}', 'ki25-driver@example.invalid', '{"full_name":"[PROVER] KI25 Driver","role":"driver"}'::jsonb);`);
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id = '${DRIVER}';
    INSERT INTO public.customers (id, farm_name, is_active, email, contact_name) VALUES
      ('${CUST}', '[PROVER] KI25 Farm', true, 'ki25-farm@example.invalid', 'Pat Prover'),
      ('${CUST_NOEMAIL}', '[PROVER] KI25 No Email Farm', true, NULL, NULL);`);
}
// One in-progress delivery of 10 GL with a left-at-site photo ready.
function seedDelivery(i, customer = CUST) {
  const photo = `delivery-photos/${D(i)}/drop.jpg`;
  psql(`SET session_replication_role = replica;
    INSERT INTO public.products (id, product_name, sku, unit_size, current_cost, tier1_price, is_active)
      VALUES ('${P(i)}', '[PROVER] KI25 product ${i}', 'KI25-${i}', 'GL', 6.00, 10.00, true);
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
      VALUES ('${P(i)}', 'Main Warehouse', 100, 10, 'GL');
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${O(i)}', 'PROVER-KI25-${i}', '${customer}', current_date, 'confirmed', false, '${ADMIN}');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
      VALUES ('${OI(i)}', '${O(i)}', '${P(i)}', '[PROVER] KI25 product ${i}', 10, 6, 10, 100, 40, 40, 0, 10);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date)
      VALUES ('${D(i)}', 'PROVER-KI25-D${i}', '${O(i)}', '${customer}', '${ADMIN}', 'in_progress', current_date);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${DI(i)}', '${D(i)}', '${OI(i)}', '${P(i)}', 10, 'GL');
    INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
      VALUES ('delivery-photos', '${photo}', '${ADMIN}', '{"mimetype":"image/jpeg","size":"5000"}'::jsonb);
    INSERT INTO public.delivery_photos (id, delivery_id, storage_path, image_url, caption, uploaded_by)
      VALUES ('${PH(i)}', '${D(i)}', '${photo}', '${photo}', 'Left at site — drop location', '${ADMIN}');`);
}
// Named arguments, as the app sends them. emailReceipt undefined = not sent at all.
function complete(i, { key = `ki25-complete-${i}`, emailReceipt, qty = 10, evidence = 'left_at_site', allowFailure = false } = {}) {
  const args = [
    `p_delivery_id => '${D(i)}'`,
    `p_signed_by => '${evidence === 'no_proof' ? 'No proof — recorded by office' : LEFT}'`,
    `p_performed_by => '${ADMIN}'`,
    `p_quantities => jsonb_build_object('${DI(i)}', ${qty})`,
    `p_idempotency_key => '${key}'`,
    `p_evidence => '${evidence}'`,
    `p_evidence_ref => '${evidence === 'no_proof' ? '[PROVER] no signature here' : PH(i)}'`,
  ];
  if (emailReceipt !== undefined) args.push(`p_email_receipt => ${emailReceipt}`);
  return q(`BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;
    SELECT public.complete_delivery(${args.join(', ')})::text;
    COMMIT;`, { allowFailure });
}
const queued = (i) => q(`SELECT count(*) FROM public.delivery_receipt_queue WHERE delivery_id = '${D(i)}';`).out;
const row = (i, cols) => q(`SELECT ${cols} FROM public.delivery_receipt_queue WHERE delivery_id = '${D(i)}';`).out;
function worker(sql, options) { return q(`BEGIN; SET LOCAL ROLE service_role; ${sql}; COMMIT;`, options); }
const claim = (key) => JSON.parse(worker(`SELECT public.claim_delivery_receipts(10${key ? `, '${key}'` : ''})::text`).out);
const finish = (c, outcome, extra = 'NULL, NULL, NULL') =>
  worker(`SELECT public.finish_delivery_receipt('${c.id}', '${c.claim_token}', '${outcome}', ${extra})`, { allowFailure: true });
// Makes one row due now and every other pending row not due, keeping their other fields.
const due = (i) => psql(`UPDATE public.delivery_receipt_queue SET next_attempt_at = now() - interval '1 second' WHERE delivery_id = '${D(i)}';
  UPDATE public.delivery_receipt_queue SET next_attempt_at = now() + interval '1 day' WHERE delivery_id <> '${D(i)}' AND status = 'pending';`);
const reset = (i, set) => psql(`UPDATE public.delivery_receipt_queue SET status = 'pending', claim_token = NULL, claimed_at = NULL,
  sent_at = NULL, last_error = NULL, ${set} WHERE delivery_id = '${D(i)}';`);
const fresh = (i) => { reset(i, 'attempts = 0, first_attempt_at = NULL'); due(i); };
const log = (key, status) => psql(`INSERT INTO public.email_log (recipient_email, email_type, subject, status, idempotency_key)
  VALUES ('ki25-farm@example.invalid', 'delivery_completed', '[PROVER]', '${status}', '${key}');`);

function main() {
  if (!REUSE) buildContainer();
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text)'::regprocedure;"),
    'c07f8ea8323f512549064a2ee6360dba', 'the replay must reproduce live complete_delivery before the candidate');
  seedUsers();

  // BEFORE: a completion with today's call whose reply the phone "lost".
  seedDelivery(0);
  const legacy = complete(0, { key: 'ki25-legacy-0' });
  assert.equal(legacy.status, 0, legacy.err);

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /PREFLIGHT_DELIVERY_RECEIPT_QUEUE_DRIFT/);
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean)'::regprocedure;"),
    'eed8da07fedbec14a198ca4f6e26c213');
  assert.equal(scalar("SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'deliver-receipt-queue';"),
    '*/2 * * * * SELECT public._wake_delivery_receipt_worker()');
  console.log('[prover] candidate applied once; a second apply refuses at the preflight; cron job scheduled');

  // Legacy replay: the same request (no p_email_receipt) returns the saved answer and records nothing.
  const replayLegacy = complete(0, { key: 'ki25-legacy-0' });
  assert.equal(replayLegacy.status, 0, replayLegacy.err);
  assert.equal(replayLegacy.out, legacy.out, 'a pre-migration completion must replay its saved answer');
  assert.equal(queued(0), '0');
  // FALSE asks for no receipt, exactly like the pre-migration request: it replays too (Luna, PR #1495).
  const replayFalse = complete(0, { key: 'ki25-legacy-0', emailReceipt: 'false' });
  assert.equal(replayFalse.status, 0, replayFalse.err);
  assert.equal(replayFalse.out, legacy.out, 'a pre-migration completion retried with FALSE must replay');
  assert.equal(queued(0), '0');
  // The same key asking for a receipt is a different request: refused, not replayed.
  const mismatched = complete(0, { key: 'ki25-legacy-0', emailReceipt: 'true', allowFailure: true });
  assert.notEqual(mismatched.status, 0, 'a key reused with a different email choice must be refused');
  assert.equal(queued(0), '0');
  console.log('[prover] a completion from before the migration still replays (and records no receipt)');

  // TRUE records one receipt with the right content, in the same transaction.
  seedDelivery(1);
  const done1 = complete(1, { emailReceipt: 'true' });
  assert.equal(done1.status, 0, done1.err);
  assert.equal(row(1, "status || '|' || attempts || '|' || requested_by || '|' || customer_id"), `pending|0|${ADMIN}|${CUST}`);
  assert.deepEqual(JSON.parse(row(1, 'receipt::text')), {
    lines: [{ qty: 10, name: '[PROVER] KI25 product 1' }],
    signed_by: LEFT,
    is_partial: false,
    delivered_on: scalar("SELECT to_char((now() AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD');"),
    delivery_number: 'PROVER-KI25-D1',
  });
  // A replay of that completion records nothing new, even after the row is gone.
  psql(`DELETE FROM public.delivery_receipt_queue WHERE delivery_id = '${D(1)}';`);
  const replay1 = complete(1, { emailReceipt: 'true' });
  assert.equal(replay1.status, 0, replay1.err);
  assert.equal(replay1.out, done1.out);
  assert.equal(queued(1), '0', 'a replay must not record a receipt');
  console.log('[prover] TRUE records one receipt with its content; a replay records none');

  // A part delivery is marked partial and lists what was delivered.
  seedDelivery(2);
  assert.equal(complete(2, { emailReceipt: 'true', qty: 4 }).status, 0);
  assert.equal(row(2, "(receipt->>'is_partial') || ' ' || (receipt->'lines'->0->>'qty')"), 'true 4');
  // Left out, FALSE, no_proof and a customer with no email record nothing.
  seedDelivery(3); assert.equal(complete(3).status, 0); assert.equal(queued(3), '0');
  seedDelivery(4); assert.equal(complete(4, { emailReceipt: 'false' }).status, 0); assert.equal(queued(4), '0');
  seedDelivery(5); assert.equal(complete(5, { emailReceipt: 'true', evidence: 'no_proof' }).status, 0); assert.equal(queued(5), '0');
  seedDelivery(6, CUST_NOEMAIL); assert.equal(complete(6, { emailReceipt: 'true' }).status, 0); assert.equal(queued(6), '0');
  console.log('[prover] part delivery marked partial; left out, FALSE, no_proof and no-email customers record nothing');

  // Access: staff read only; drivers see nothing; nobody but service_role runs the worker calls.
  const asUser = (uid, sql) => q(`BEGIN;\n${claims(uid)}\nSET LOCAL ROLE authenticated; ${sql}; COMMIT;`, { allowFailure: true });
  assert.equal(asUser(ADMIN, 'SELECT count(*) FROM public.delivery_receipt_queue').out, '1');
  assert.equal(asUser(DRIVER, 'SELECT count(*) FROM public.delivery_receipt_queue').out, '0');
  assert.match(asUser(ADMIN, "UPDATE public.delivery_receipt_queue SET status = 'sent'").err, /permission denied/);
  assert.match(asUser(ADMIN, 'SELECT public.claim_delivery_receipts(10)').err, /permission denied/);
  assert.match(asUser(ADMIN, "SELECT public.finish_delivery_receipt(gen_random_uuid(), gen_random_uuid(), 'sent', NULL, 'x', 'y')").err, /permission denied/);
  assert.match(asUser(ADMIN, `SELECT public._enqueue_delivery_receipt('${D(3)}', '${ADMIN}')`).err, /permission denied/);
  assert.match(worker(`SELECT public._enqueue_delivery_receipt('${D(3)}', '${ADMIN}')`, { allowFailure: true }).err, /permission denied/);
  assert.match(worker(`INSERT INTO public.delivery_receipt_queue (delivery_id, customer_id, receipt) VALUES ('${D(3)}', '${CUST}', '{"lines":[]}')`, { allowFailure: true }).err, /permission denied/);
  console.log('[prover] admins read; drivers see none; only service_role runs the worker calls; nobody writes the table');

  // Worker: claim, lease, retry backoff, stale claim, sent.
  psql(`INSERT INTO public.delivery_receipt_queue (delivery_id, customer_id, receipt) VALUES ('${D(1)}', '${CUST}', '{"lines":[]}');`);
  due(1);
  const batch = claim('ki25-claim-1');
  assert.equal(batch.length, 1);
  const c1 = batch[0];
  assert.equal(c1.delivery_id, D(1)); assert.equal(c1.attempt, 1); assert.equal(c1.to, 'ki25-farm@example.invalid');
  assert.equal(c1.contact_name, 'Pat Prover');
  assert.equal(claim().length, 0, 'a claimed row is leased');
  // A claim retried with its key (the answer was lost) gets the same claim back and uses no extra attempt.
  const replayClaim = claim('ki25-claim-1');
  assert.deepEqual(replayClaim.map((c) => [c.id, c.claim_token, c.attempt, c.to]), [[c1.id, c1.claim_token, 1, c1.to]]);
  assert.equal(row(1, 'attempts'), '1');
  assert.equal(finish(c1, 'retry', "'Resend 503', NULL, NULL, 'ki25-finish-1'").out, 'pending');
  // A finish retried with its key gets its first answer, not stale; a plain repeat is stale.
  assert.equal(finish(c1, 'retry', "'Resend 503', NULL, NULL, 'ki25-finish-1'").out, 'pending');
  assert.equal(finish(c1, 'retry', "'Resend 503', NULL, NULL").out, 'stale');
  assert.equal(claim('ki25-claim-1').length, 0, 'a replayed claim never returns a receipt it no longer holds');
  assert.equal(row(1, "attempts || ' ' || (next_attempt_at BETWEEN now() + interval '115 seconds' AND now() + interval '125 seconds')"), '1 true');
  assert.equal(finish(c1, 'sent', "NULL, 'msg-1', 'ki25-farm@example.invalid'").out, 'stale', 'a finished claim cannot finish again');
  due(1);
  const c2 = claim()[0];
  assert.equal(c2.attempt, 2);
  assert.match(finish(c2, 'sent').err, /RECEIPT_SENT_PROOF_REQUIRED/);
  assert.equal(finish({ ...c2, claim_token: id('99') }, 'sent', "NULL, 'msg-1', 'x@example.invalid'").out, 'stale');
  assert.match(finish(c2, 'sent', "NULL, 'msg-1', 'other@example.invalid'").err, /RECEIPT_SENT_TO_MISMATCH/);
  assert.equal(finish(c2, 'sent', "NULL, 'msg-1', 'ki25-farm@example.invalid'").out, 'sent');
  assert.equal(row(1, "status || ' ' || resend_message_id || ' ' || sent_to || ' ' || (sent_at IS NOT NULL) || ' ' || (claim_token IS NULL)"),
    'sent msg-1 ki25-farm@example.invalid true true');
  due(1); assert.equal(claim().length, 0, 'a sent receipt is never claimed again');
  console.log('[prover] claim leases a row; retry backs off 2 minutes; stale tokens change nothing; sent needs provider proof; keyed claim and finish replay');

  // An expired lease is reclaimed with a new token; the old token is then stale.
  due(2);
  const l1 = claim()[0];
  psql(`UPDATE public.delivery_receipt_queue SET claimed_at = now() - interval '11 minutes' WHERE id = '${l1.id}';`);
  const l2 = claim()[0];
  assert.equal(l2.id, l1.id); assert.notEqual(l2.claim_token, l1.claim_token); assert.equal(l2.attempt, 2);
  assert.equal(finish(l1, 'sent', "NULL, 'm', 'x@example.invalid'").out, 'stale');
  assert.equal(finish(l2, 'check', "'Resend 422 invalid address', NULL, NULL").out, 'needs_check');
  assert.equal(row(2, 'last_error'), 'Resend 422 invalid address');
  console.log('[prover] an expired lease is reclaimed and the old claim goes stale; check goes to needs_check');

  // Five attempts at most; the fifth retry and a sixth claim both stop at needs_check.
  reset(2, "attempts = 4, first_attempt_at = now() - interval '1 hour'");
  due(2);
  const c5 = claim()[0];
  assert.equal(c5.attempt, 5);
  assert.equal(finish(c5, 'retry', "'timeout', NULL, NULL").out, 'needs_check');
  assert.equal(row(2, 'last_error'), 'Tried 5 times. Last error: timeout');
  reset(2, "attempts = 5, first_attempt_at = now() - interval '1 hour'");
  due(2); assert.equal(claim().length, 0); assert.equal(row(2, 'status'), 'needs_check');
  // Past 23 hours since the first attempt: stop (the provider's duplicate guard lasts 24 hours).
  reset(2, "attempts = 1, first_attempt_at = now() - interval '23 hours 1 minute'");
  due(2); assert.equal(claim().length, 0); assert.match(row(2, "status || ' ' || last_error"), /^needs_check .*Stopped retrying/);
  console.log('[prover] five attempts at most; past 23 hours a retry stops at needs_check');

  // Settled without sending: another delivery_completed email sent (scoped or legacy key) or pending; the worker's
  // own rows do not count; no email now; delivery no longer completed.
  log(`delivery-receipt-queue:${id('55')}:attempt-1`, 'sent');
  fresh(2);
  const own = claim();
  assert.equal(own.length, 1, "the worker's own email rows do not settle the receipt");
  finish(own[0], 'retry');
  // A send before the receipt was owed (before this completion) does not settle it.
  psql(`UPDATE public.delivery_receipt_queue SET created_at = now() + interval '1 minute' WHERE delivery_id = '${D(2)}';`);
  log(`delivery_completed:delivery:${D(2)}:office-before-completion`, 'sent');
  fresh(2);
  const early = claim();
  assert.equal(early.length, 1, 'a confirmation sent before the receipt was owed does not settle it');
  finish(early[0], 'retry');
  psql(`UPDATE public.delivery_receipt_queue SET created_at = now() - interval '1 minute' WHERE delivery_id = '${D(2)}';`);
  log(`delivery_completed:delivery:${D(2)}:delivery-resend-${D(2)}-1730000000000`, 'sent');
  fresh(2); assert.equal(claim().length, 0); assert.equal(row(2, 'status'), 'sent_elsewhere');
  seedDelivery(7); assert.equal(complete(7, { emailReceipt: 'true' }).status, 0);
  log(`delivery-completed-${D(7)}`, 'pending');
  due(7); assert.equal(claim().length, 0); assert.match(row(7, "status || ' ' || last_error"), /^needs_check Another send/);
  log(`delivery_completed:delivery:${D(7)}:delivery-completed-${D(7)}`, 'sent');
  psql(`DELETE FROM public.email_log WHERE idempotency_key = 'delivery-completed-${D(7)}';`);
  fresh(7); assert.equal(claim().length, 0); assert.equal(row(7, 'status'), 'sent_elsewhere');
  seedDelivery(8); assert.equal(complete(8, { emailReceipt: 'true' }).status, 0);
  psql(`UPDATE public.customers SET email = '  ' WHERE id = '${CUST}';`);
  due(8); assert.equal(claim().length, 0); assert.match(row(8, "status || ' ' || last_error"), /^needs_check The customer has no email/);
  psql(`UPDATE public.customers SET email = 'ki25-farm@example.invalid' WHERE id = '${CUST}';`);
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET status = 'cancelled' WHERE id = '${D(8)}';`);
  fresh(8); assert.equal(claim().length, 0); assert.equal(row(8, 'status'), 'cancelled');
  console.log('[prover] settled without sending: sent elsewhere, pending elsewhere, no email now, delivery no longer completed');

  // A claim retried with its key returns the address that claim fixed, and re-checks: sent elsewhere or a
  // voided delivery since the claim settles the row instead of returning it.
  seedDelivery(9); assert.equal(complete(9, { emailReceipt: 'true' }).status, 0);
  due(9);
  const k1 = claim('ki25-claim-recheck-1');
  assert.equal(k1.length, 1);
  psql(`UPDATE public.customers SET email = ' KI25-Farm@example.invalid ' WHERE id = '${CUST}';`);
  assert.deepEqual(claim('ki25-claim-recheck-1').map((c) => [c.id, c.claim_token, c.attempt, c.to]),
    [[k1[0].id, k1[0].claim_token, 1, 'ki25-farm@example.invalid']], 'a retried claim keeps its address');
  psql(`UPDATE public.customers SET email = 'ki25-farm@example.invalid' WHERE id = '${CUST}';`);
  log(`delivery_completed:delivery:${D(9)}:office-confirmation-1`, 'sent');
  assert.equal(claim('ki25-claim-recheck-1').length, 0); assert.equal(row(9, 'status'), 'sent_elsewhere');
  psql(`DELETE FROM public.email_log WHERE idempotency_key = 'delivery_completed:delivery:${D(9)}:office-confirmation-1';`);
  fresh(9);
  assert.equal(claim('ki25-claim-recheck-2').length, 1);
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET status = 'cancelled' WHERE id = '${D(9)}';`);
  assert.equal(claim('ki25-claim-recheck-2').length, 0); assert.equal(row(9, 'status'), 'cancelled');
  // The customer's email changed since the claim: the retried claim does not send to the old address.
  seedDelivery(20); assert.equal(complete(20, { emailReceipt: 'true' }).status, 0);
  due(20);
  assert.equal(claim('ki25-claim-recheck-3').length, 1);
  psql(`UPDATE public.customers SET email = 'ki25-other@example.invalid' WHERE id = '${CUST}';`);
  assert.equal(claim('ki25-claim-recheck-3').length, 0);
  psql(`UPDATE public.customers SET email = 'ki25-farm@example.invalid' WHERE id = '${CUST}';`);
  assert.match(row(20, "status || ' ' || last_error"), /^needs_check The customer's email changed/);
  console.log('[prover] a retried claim keeps its address, re-checks sent-elsewhere and voided deliveries, and stops on a changed email');

  // A finish key is bound to its receipt, claim and outcome: reusing it elsewhere is refused, not answered.
  seedDelivery(10); assert.equal(complete(10, { emailReceipt: 'true' }).status, 0);
  seedDelivery(11); assert.equal(complete(11, { emailReceipt: 'true' }).status, 0);
  psql(`UPDATE public.delivery_receipt_queue SET next_attempt_at = now() - interval '1 second' WHERE delivery_id IN ('${D(10)}', '${D(11)}');`);
  const [fa, fb] = claim();
  assert.ok(fa && fb);
  assert.equal(finish(fa, 'sent', "NULL, 'msg-a', 'ki25-farm@example.invalid', 'ki25-finish-bound'").out, 'sent');
  assert.match(finish(fb, 'sent', "NULL, 'msg-b', 'ki25-farm@example.invalid', 'ki25-finish-bound'").err, /IDEMPOTENCY_KEY_REUSED/);
  assert.equal(q(`SELECT status FROM public.delivery_receipt_queue WHERE id = '${fb.id}';`).out, 'sending', 'B is untouched');
  assert.match(finish(fa, 'retry', "'x', NULL, NULL, 'ki25-finish-bound'").err, /IDEMPOTENCY_KEY_REUSED/);
  assert.equal(finish(fa, 'sent', "NULL, 'msg-a', 'ki25-farm@example.invalid', 'ki25-finish-bound'").out, 'sent');
  assert.equal(finish(fb, 'sent', "NULL, 'msg-b', 'ki25-farm@example.invalid', 'ki25-finish-b'").out, 'sent');
  console.log('[prover] a finish key reused for another receipt or outcome is refused');

  // A retried claim only answers while its lease holds; after that the row belongs to a fresh claim, which
  // runs the 23-hour check (a replay past it could send outside the provider's duplicate guard).
  seedDelivery(13); assert.equal(complete(13, { emailReceipt: 'true' }).status, 0);
  due(13);
  const e1 = claim('ki25-claim-expired');
  assert.equal(e1.length, 1);
  psql(`UPDATE public.delivery_receipt_queue SET claimed_at = now() - interval '11 minutes',
    first_attempt_at = now() - interval '23 hours 5 minutes' WHERE id = '${e1[0].id}';`);
  assert.equal(claim('ki25-claim-expired').length, 0, 'an expired claim is not replayed');
  assert.equal(row(13, 'status'), 'sending');
  assert.equal(claim().length, 0);
  assert.match(row(13, "status || ' ' || last_error"), /^needs_check .*Stopped retrying/);
  console.log('[prover] a retried claim past its lease returns nothing; the fresh claim stops it at 23 hours');

  // A finish replay is bound to its proof too.
  seedDelivery(14); assert.equal(complete(14, { emailReceipt: 'true' }).status, 0);
  due(14);
  const p1 = claim()[0];
  assert.equal(finish(p1, 'sent', "NULL, 'msg-p', 'ki25-farm@example.invalid', 'ki25-finish-proof'").out, 'sent');
  assert.match(finish(p1, 'sent', "NULL, 'msg-other', 'ki25-farm@example.invalid', 'ki25-finish-proof'").err, /IDEMPOTENCY_KEY_REUSED/);
  console.log('[prover] a finish replay with different send proof is refused');

  // This receipt's own attempt logged sent (its finish was lost) is recorded, never sent again; its own pending
  // attempt (outcome unknown) is retried under the provider's duplicate guard.
  seedDelivery(15); assert.equal(complete(15, { emailReceipt: 'true' }).status, 0);
  const q15 = row(15, 'id');
  log(`delivery-receipt-queue:${q15}:attempt-1`, 'pending');
  due(15);
  const o1 = claim();
  assert.equal(o1.length, 1, "the receipt's own pending attempt does not settle it");
  finish(o1[0], 'retry');
  psql(`UPDATE public.email_log SET status = 'sent', resend_message_id = 'msg-own'
    WHERE idempotency_key = 'delivery-receipt-queue:${q15}:attempt-1';`);
  due(15); assert.equal(claim().length, 0);
  assert.equal(row(15, "status || ' ' || resend_message_id || ' ' || sent_to"), 'sent msg-own ki25-farm@example.invalid');
  console.log("[prover] the receipt's own logged send is recorded sent, not sent twice");

  // The delivery now belongs to another customer: the office checks who gets the receipt.
  seedDelivery(16); assert.equal(complete(16, { emailReceipt: 'true' }).status, 0);
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET customer_id = '${CUST_NOEMAIL}' WHERE id = '${D(16)}';`);
  due(16); assert.equal(claim().length, 0);
  assert.match(row(16, "status || ' ' || last_error"), /^needs_check The delivery now belongs to another customer/);
  console.log('[prover] a delivery moved to another customer goes to the office list');

  // One sender at a time: while the worker holds a live claim, another send for that delivery (or a keyless one
  // for that customer) is refused at its pre-send log row; the worker's own row and other deliveries are not.
  seedDelivery(17); assert.equal(complete(17, { emailReceipt: 'true' }).status, 0);
  const sendRow = (key, customer = CUST) => psql(`INSERT INTO public.email_log (customer_id, recipient_email, email_type, subject, status, idempotency_key)
    VALUES ('${customer}', 'ki25-farm@example.invalid', 'delivery_completed', '[PROVER]', 'pending', ${key === null ? 'NULL' : `'${key}'`});`, { allowFailure: true });
  assert.equal(sendRow(`delivery_completed:delivery:${D(17)}:office-before-claim`).status, 0, 'no claim yet: the office may send');
  psql(`DELETE FROM public.email_log WHERE idempotency_key = 'delivery_completed:delivery:${D(17)}:office-before-claim';`);
  due(17);
  const s1 = claim();
  assert.equal(s1.length, 1);
  assert.match(sendRow(`delivery_completed:delivery:${D(17)}:office-1`).stderr, /DELIVERY_RECEIPT_SENDING/);
  assert.match(sendRow(null).stderr, /DELIVERY_RECEIPT_SENDING/);
  assert.equal(sendRow(`delivery-receipt-queue:${s1[0].id}:attempt-1`).status, 0, "the worker's own row is allowed");
  assert.match(sendRow(`delivery_completed:delivery:${D(17)}:receipt-queue/${s1[0].id}/attempt-1`).stderr, /DELIVERY_RECEIPT_SENDING/,
    "a staff send shaped like the old worker key is refused");
  assert.equal(sendRow(`delivery_completed:delivery:${D(16)}:office-1`, CUST_NOEMAIL).status, 0, 'another delivery is not blocked');
  // A send blocked by a live claim is allowed once the claim settles.
  assert.equal(finish(s1[0], 'sent', `NULL, 'msg-s', 'ki25-farm@example.invalid'`).out, 'sent');
  assert.equal(sendRow(`delivery_completed:delivery:${D(17)}:office-2`).status, 0);
  psql(`DELETE FROM public.email_log WHERE customer_id IS NOT NULL AND subject = '[PROVER]';`);
  console.log('[prover] a live claim refuses another send for that delivery or a keyless one for that customer');

  // A legacy key names its delivery: one for another delivery of the same customer does not hold this receipt.
  seedDelivery(18); assert.equal(complete(18, { emailReceipt: 'true' }).status, 0);
  psql(`INSERT INTO public.email_log (customer_id, recipient_email, email_type, subject, status, idempotency_key)
    VALUES ('${CUST}', 'ki25-farm@example.invalid', 'delivery_completed', '[PROVER]', 'sent', 'delivery-completed-${D(17)}');`);
  due(18);
  const g1 = claim();
  assert.equal(g1.length, 1, "another delivery's legacy-keyed email does not hold this receipt");
  finish(g1[0], 'retry');
  psql(`DELETE FROM public.email_log WHERE customer_id IS NOT NULL AND subject = '[PROVER]';`);
  console.log("[prover] another delivery's legacy-keyed confirmation does not hold this receipt");

  // A delivery confirmation with no key (send-email allows it) names no delivery: one sent to this customer
  // around the receipt may be it, so the receipt goes to the office list instead of sending. Runs last: the
  // row stays and would settle every later receipt for this customer.
  seedDelivery(12); assert.equal(complete(12, { emailReceipt: 'true' }).status, 0);
  psql(`INSERT INTO public.email_log (customer_id, recipient_email, email_type, subject, status, idempotency_key)
    VALUES ('${CUST}', 'ki25-farm@example.invalid', 'delivery_completed', '[PROVER]', 'sent', NULL);`);
  due(12); assert.equal(claim().length, 0);
  assert.match(row(12, "status || ' ' || last_error"), /^needs_check A delivery confirmation without a delivery reference/);
  console.log('[prover] a keyless delivery confirmation to the customer sends the receipt to the office list');

  // The timer: nothing due -> nothing posted; due but not switched on -> nothing posted; switched on -> one post.
  // pg_net's worker moves a queued call to net._http_response once tried (here: no network, so it fails).
  const posts = () => scalar('SELECT (SELECT count(*) FROM net.http_request_queue) + (SELECT count(*) FROM net._http_response);');
  psql("UPDATE public.delivery_receipt_queue SET next_attempt_at = now() + interval '1 day' WHERE status = 'pending';");
  psql('SELECT public._wake_delivery_receipt_worker();'); assert.equal(posts(), '0');
  fresh(2);
  psql('SELECT public._wake_delivery_receipt_worker();'); assert.equal(posts(), '0', 'no Vault secrets: the timer stays off');
  psql(`SELECT vault.create_secret('http://127.0.0.1:9/functions/v1/send-delivery-receipts', 'delivery_receipt_worker_url');
    SELECT vault.create_secret('[PROVER] not a real secret', 'delivery_receipt_worker_secret');`);
  // Read the call before pg_net's worker takes it: same transaction as the wake.
  assert.equal(q(`BEGIN; SELECT public._wake_delivery_receipt_worker();
    SELECT count(*) || ' ' || min(url) || ' ' || min(headers ->> 'x-receipt-worker-secret') FROM net.http_request_queue; COMMIT;`).out,
    '1 http://127.0.0.1:9/functions/v1/send-delivery-receipts [PROVER] not a real secret');
  assert.equal(posts(), '1');
  console.log('[prover] the timer posts only when a receipt is due and both secrets exist');

  // Grants on the replaced complete_delivery are unchanged.
  const sig = 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean)';
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', '${sig}', 'EXECUTE')::text || has_function_privilege('service_role', '${sig}', 'EXECUTE')::text || has_function_privilege('anon', '${sig}', 'EXECUTE')::text;`), 'truetruefalse');
  console.log('DELIVERY_RECEIPT_QUEUE_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
