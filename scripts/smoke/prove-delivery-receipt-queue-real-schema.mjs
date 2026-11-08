#!/usr/bin/env node
/**
 * Real-schema proof for KI-25 (20261113140000): a customer receipt owed after a delivery completion is recorded in
 * the database in the same transaction, and the service_role worker calls send it at most once per claim.
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays migrations up to the
 * candidate, completes one delivery with today's call (key K), applies the candidate (a second apply refuses),
 * then shows on invented rows: K still replays with its saved fingerprint and records nothing; TRUE records one
 * receipt with the right content; NULL, FALSE and no_proof record none (no email: office list); a replay records
 * none; and the worker calls claim, confirm right before the send (waiting for an in-flight edit), lease, back
 * off, cap, stop at 23 hours, cancel or flag deliveries no longer completed, refuse stale claims, and stay
 * service_role only; email_log is untouched. Then the sender's own code (send-delivery-receipts/logic.ts) runs
 * against this schema with a stand-in provider that keeps Resend's duplicate guard: a failed first send, then a
 * lost finish, ends with exactly one receipt emailed. No real email is sent.
 *
 * Run: node scripts/smoke/prove-delivery-receipt-queue-real-schema.mjs   (needs local Docker image)
 * Prints DELIVERY_RECEIPT_QUEUE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleNodeEsm } from './bundle-node-esm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-ki25-receipt-queue-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
// Only this prover's own throwaway containers: the proof writes, disables triggers and deletes.
if (REUSE && !/^crx-ki25-receipt-queue-\d+-[0-9a-z]+$/.test(NAME)) {
  console.error(`CRX_PROVER_REUSE_CONTAINER must name a container this prover created (crx-ki25-receipt-queue-<pid>-<id>), not "${NAME}"`);
  process.exit(1);
}
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261113140000_delivery_receipt_queue.sql');
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
  docker(['run', '-d', '--name', NAME, '--label', 'crx-prover=ki25-receipt-queue', '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
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
const fresh = (i) => { reset(i, 'attempts = 0, send_authorized_at = NULL'); due(i); };
const confirm = (c, key) =>
  worker(`SELECT public.confirm_delivery_receipt_send('${c.id}', '${c.claim_token}'${key ? `, '${key}'` : ''})`, { allowFailure: true });

// The sender (supabase/functions/send-delivery-receipts/logic.ts, the exact code the Edge Function runs) against
// this schema, with a stand-in for Resend that keeps Resend's documented duplicate guard: a repeat of a key it
// already sent returns the first answer and sends nothing; the same key with a different body is a 409.
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
}
async function proveSender() {
  const bundle = path.join(tmpdir(), `ki25-sender-${process.pid}.mjs`);
  await bundleNodeEsm(path.join(ROOT, 'supabase', 'functions', 'send-delivery-receipts', 'logic.ts'), bundle);
  const { runReceiptBatch, sendViaResend } = await import(pathToFileURL(bundle).href);
  unlinkSync(bundle);

  const provider = { sentByKey: new Map(), delivered: [], failNext: 0 };
  const fakeFetch = async (_url, init) => {
    const key = init.headers['Idempotency-Key'];
    if (provider.failNext > 0) {
      provider.failNext -= 1;
      return new Response(JSON.stringify({ name: 'application_error', message: '[PROVER] outage' }), { status: 503 });
    }
    const seen = provider.sentByKey.get(key);
    if (seen) {
      if (seen.body !== init.body) return new Response(JSON.stringify({ name: 'invalid_idempotent_request' }), { status: 409 });
      return new Response(JSON.stringify({ id: seen.id }), { status: 200 });
    }
    const id = `prover-msg-${provider.delivered.length + 1}`;
    provider.sentByKey.set(key, { body: init.body, id });
    provider.delivered.push({ key, to: JSON.parse(init.body).to[0] });
    return new Response(JSON.stringify({ id }), { status: 200 });
  };
  let failFinish = false;
  const rpc = async (fn, args) => {
    if (failFinish && fn === 'finish_delivery_receipt') throw new Error('[PROVER] connection lost before finish');
    const named = Object.entries(args).map(([k, v]) => `${k} => ${sqlLiteral(v)}`).join(', ');
    const r = worker(`SELECT public.${fn}(${named})::text`, { allowFailure: true });
    if (r.status !== 0) throw new Error(`${fn}: ${r.err}`);
    return fn === 'claim_delivery_receipts' ? JSON.parse(r.out) : r.out;
  };
  let n = 0;
  const run = () => runReceiptBatch({ rpc, send: (req) => sendViaResend(req, '[PROVER] key', fakeFetch), from: 'noreply@example.invalid', newKey: () => `prover-${++n}` });

  // Only this proof's receipt is due.
  psql("UPDATE public.delivery_receipt_queue SET next_attempt_at = now() + interval '1 day' WHERE status = 'pending';");
  seedDelivery(40); assert.equal(complete(40, { emailReceipt: 'true' }).status, 0);
  assert.equal(row(40, 'status'), 'pending');

  // 1. The first send fails (provider outage): nothing delivered, the receipt waits to retry.
  provider.failNext = 1;
  assert.deepEqual(await run(), { claimed: 1, sent: 0, retry: 1, check: 0, skipped: 0, lost: 0 });
  assert.equal(row(40, "status || ' ' || attempts || ' ' || (next_attempt_at > now())"), 'pending 1 true');
  assert.equal(provider.delivered.length, 0);
  assert.equal((await run()).claimed, 0, 'backing off: not claimed again at once');

  // 2. Due again: the email goes out, but the answer is lost before finish (twice, so the one retry fails too).
  due(40);
  failFinish = true;
  assert.deepEqual(await run(), { claimed: 1, sent: 0, retry: 0, check: 0, skipped: 0, lost: 1 });
  failFinish = false;
  assert.equal(provider.delivered.length, 1);
  assert.equal(row(40, 'status'), 'sending');
  assert.equal((await run()).claimed, 0, 'the lease holds it while the first worker may still finish');

  // 3. The lease runs out; the next run resends the identical request, the provider answers from its guard.
  psql(`UPDATE public.delivery_receipt_queue SET claimed_at = now() - interval '11 minutes' WHERE delivery_id = '${D(40)}';`);
  assert.deepEqual(await run(), { claimed: 1, sent: 1, retry: 0, check: 0, skipped: 0, lost: 0 });
  assert.equal(row(40, "status || ' ' || resend_message_id || ' ' || sent_to"), 'sent prover-msg-1 ki25-farm@example.invalid');
  assert.equal((await run()).claimed, 0);

  // Exactly one email reached the customer for this delivery.
  assert.deepEqual(provider.delivered, [{ key: `delivery-receipt/${row(40, 'id')}`, to: 'ki25-farm@example.invalid' }]);
  console.log('[prover] sender: a failed first send, then a lost finish, ends with exactly one receipt emailed and the row sent');
}

async function main() {
  if (!REUSE) buildContainer();
  else {
    // A reused container must be one this prover built: its label, no network.
    const seen = docker(['inspect', '-f', '{{index .Config.Labels "crx-prover"}} {{.HostConfig.NetworkMode}}', NAME]).stdout.trim();
    if (seen !== 'ki25-receipt-queue none') throw new Error(`refusing to reuse ${NAME}: not a container this prover built (${seen})`);
  }
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

  // Before the sender is switched on (its two Vault secrets), an asked-for receipt goes to the office list;
  // then switch it on for the rest of the proof (the timer test switches it off again).
  seedDelivery(25); assert.equal(complete(25, { emailReceipt: 'true' }).status, 0);
  assert.match(row(25, "status || ' ' || last_error"), /^needs_check The receipt sender is not switched on/);
  psql(`SELECT vault.create_secret('http://127.0.0.1:9/functions/v1/send-delivery-receipts', 'delivery_receipt_worker_url');
    SELECT vault.create_secret('[PROVER] not a real secret', 'delivery_receipt_worker_secret');`);
  console.log('[prover] before the sender is switched on, a receipt goes to the office list');

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

  // TRUE records one receipt with the right content (frozen, contact name included), in the same transaction.
  seedDelivery(1);
  const done1 = complete(1, { emailReceipt: 'true' });
  assert.equal(done1.status, 0, done1.err);
  assert.equal(row(1, "status || '|' || attempts || '|' || requested_by || '|' || customer_id"), `pending|0|${ADMIN}|${CUST}`);
  assert.deepEqual(JSON.parse(row(1, 'receipt::text')), {
    lines: [{ qty: 10, name: '[PROVER] KI25 product 1' }],
    signed_by: LEFT,
    is_partial: false,
    contact_name: 'Pat Prover',
    delivered_on: scalar("SELECT to_char((now() AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD');"),
    delivery_number: 'PROVER-KI25-D1',
  });
  // An owed receipt cannot be deleted (a completed delivery already cannot be; a cancelled one waits for the claim).
  assert.match(psql(`DELETE FROM public.delivery_receipt_queue WHERE delivery_id = '${D(1)}';`, { allowFailure: true }).stderr, /DELIVERY_RECEIPT_OWED/);
  // A receipt without its lines list is refused by the table.
  assert.match(psql(`UPDATE public.delivery_receipt_queue SET receipt = '{}' WHERE delivery_id = '${D(1)}';`, { allowFailure: true }).stderr, /check constraint/);
  // A replay of that completion records nothing new, even after the row is gone (removed with triggers off).
  psql(`SET session_replication_role = replica; DELETE FROM public.delivery_receipt_queue WHERE delivery_id = '${D(1)}';`);
  const replay1 = complete(1, { emailReceipt: 'true' });
  assert.equal(replay1.status, 0, replay1.err);
  assert.equal(replay1.out, done1.out);
  assert.equal(queued(1), '0', 'a replay must not record a receipt');
  console.log('[prover] TRUE records one receipt with its content; a replay records none');

  // A part delivery is marked partial and lists what was delivered.
  seedDelivery(2);
  assert.equal(complete(2, { emailReceipt: 'true', qty: 4 }).status, 0);
  assert.equal(row(2, "(receipt->>'is_partial') || ' ' || (receipt->'lines'->0->>'qty')"), 'true 4');
  // Left out, FALSE and no_proof record nothing; a customer with no email goes to the office list.
  seedDelivery(3); assert.equal(complete(3).status, 0); assert.equal(queued(3), '0');
  seedDelivery(4); assert.equal(complete(4, { emailReceipt: 'false' }).status, 0); assert.equal(queued(4), '0');
  seedDelivery(5); assert.equal(complete(5, { emailReceipt: 'true', evidence: 'no_proof' }).status, 0); assert.equal(queued(5), '0');
  seedDelivery(6, CUST_NOEMAIL); assert.equal(complete(6, { emailReceipt: 'true' }).status, 0);
  assert.equal(row(6, "status || ' ' || last_error"), 'needs_check The customer has no email on file; the receipt was not sent.');
  console.log('[prover] part delivery marked partial; left out, FALSE and no_proof record nothing; no email goes to the office list');

  // Access: staff read only; drivers see nothing; nobody but service_role runs the worker calls.
  const asUser = (uid, sql) => q(`BEGIN;\n${claims(uid)}\nSET LOCAL ROLE authenticated; ${sql}; COMMIT;`, { allowFailure: true });
  assert.equal(asUser(ADMIN, 'SELECT count(*) FROM public.delivery_receipt_queue').out, '3', 'D2 pending, D6 and D25 to check');
  assert.equal(asUser(DRIVER, 'SELECT count(*) FROM public.delivery_receipt_queue').out, '0');
  assert.match(asUser(ADMIN, "UPDATE public.delivery_receipt_queue SET status = 'sent'").err, /permission denied/);
  assert.match(asUser(ADMIN, 'SELECT public.claim_delivery_receipts(10)').err, /permission denied/);
  assert.match(asUser(ADMIN, 'SELECT public.confirm_delivery_receipt_send(gen_random_uuid(), gen_random_uuid())').err, /permission denied/);
  assert.match(asUser(ADMIN, "SELECT public.finish_delivery_receipt(gen_random_uuid(), gen_random_uuid(), 'sent', NULL, 'x', 'y')").err, /permission denied/);
  assert.match(asUser(ADMIN, `SELECT public._enqueue_delivery_receipt('${D(3)}', '${ADMIN}')`).err, /permission denied/);
  assert.match(worker(`SELECT public._enqueue_delivery_receipt('${D(3)}', '${ADMIN}')`, { allowFailure: true }).err, /permission denied/);
  assert.match(worker(`INSERT INTO public.delivery_receipt_queue (delivery_id, customer_id, receipt) VALUES ('${D(3)}', '${CUST}', '{"lines":[]}')`, { allowFailure: true }).err, /permission denied/);
  // The email log is not touched: no receipt trigger on it, and the office may still send while a receipt is owed
  // (a duplicate is accepted, Mason 2026-11-05).
  assert.equal(scalar(`SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.email_log'::regclass AND p.proname ILIKE '%receipt%';`), '0');
  assert.equal(psql(`INSERT INTO public.email_log (customer_id, recipient_email, email_type, subject, status, idempotency_key)
    VALUES ('${CUST}', 'ki25-farm@example.invalid', 'delivery_completed', '[PROVER]', 'pending', 'delivery_completed:delivery:${D(2)}:office-1');`, { allowFailure: true }).status, 0,
    'an office send while a receipt is owed is allowed');
  psql("DELETE FROM public.email_log WHERE subject = '[PROVER]';");
  console.log('[prover] admins read; drivers see none; only service_role runs the worker calls; nobody writes the table; email_log untouched');

  // Worker: claim, confirm, lease, retry backoff, stale claim, sent.
  psql(`INSERT INTO public.delivery_receipt_queue (delivery_id, customer_id, receipt) VALUES ('${D(1)}', '${CUST}', '{"lines":[]}');`);
  due(1);
  const batch = claim('ki25-claim-1');
  assert.equal(batch.length, 1);
  const c1 = batch[0];
  assert.equal(c1.delivery_id, D(1)); assert.equal(c1.attempt, 1); assert.equal(c1.to, 'ki25-farm@example.invalid');
  assert.equal(claim().length, 0, 'a claimed row is leased');
  // A claim retried with its key (the answer was lost) gets the same claim back and uses no extra attempt.
  const replayClaim = claim('ki25-claim-1');
  assert.deepEqual(replayClaim.map((c) => [c.id, c.claim_token, c.attempt, c.to]), [[c1.id, c1.claim_token, 1, c1.to]]);
  assert.equal(row(1, 'attempts'), '1');
  assert.equal(row(1, 'send_authorized_at IS NULL'), 't');
  assert.equal(confirm(c1).out, 'send');
  assert.equal(row(1, 'send_authorized_at IS NOT NULL'), 't');
  assert.equal(finish(c1, 'retry', "'Resend 503', NULL, NULL, 'ki25-finish-1'").out, 'pending');
  assert.equal(confirm(c1).out, 'stale', 'a finished claim cannot be confirmed again');
  // A finish retried with its key gets its first answer, not stale; a plain repeat is stale.
  assert.equal(finish(c1, 'retry', "'Resend 503', NULL, NULL, 'ki25-finish-1'").out, 'pending');
  assert.match(finish(c1, 'retry', "'invalid address', NULL, NULL, 'ki25-finish-1'").err, /IDEMPOTENCY_KEY_REUSED/, 'the key binds its detail');
  assert.equal(finish(c1, 'retry', "'Resend 503', NULL, NULL").out, 'stale');
  assert.equal(claim('ki25-claim-1').length, 0, 'a replayed claim never returns a receipt it no longer holds');
  assert.equal(row(1, "attempts || ' ' || (next_attempt_at BETWEEN now() + interval '115 seconds' AND now() + interval '125 seconds')"), '1 true');
  assert.equal(finish(c1, 'sent', "NULL, 'msg-1', 'ki25-farm@example.invalid'").out, 'stale', 'a finished claim cannot finish again');
  due(1);
  const c2 = claim()[0];
  assert.equal(c2.attempt, 2);
  assert.equal(confirm(c2).out, 'send');
  assert.match(finish(c2, 'sent').err, /RECEIPT_SENT_PROOF_REQUIRED/);
  assert.equal(finish({ ...c2, claim_token: id('99') }, 'sent', "NULL, 'msg-1', 'x@example.invalid'").out, 'stale');
  assert.match(finish(c2, 'sent', "NULL, 'msg-1', 'other@example.invalid'").err, /RECEIPT_SENT_TO_MISMATCH/);
  assert.equal(finish(c2, 'sent', "NULL, 'msg-1', 'ki25-farm@example.invalid'").out, 'sent');
  assert.equal(row(1, "status || ' ' || resend_message_id || ' ' || sent_to || ' ' || (sent_at IS NOT NULL) || ' ' || (claim_token IS NULL)"),
    'sent msg-1 ki25-farm@example.invalid true true');
  due(1); assert.equal(claim().length, 0, 'a sent receipt is never claimed again');
  console.log('[prover] claim leases a row; confirm authorizes the send; retry backs off 2 minutes; stale tokens change nothing; sent needs provider proof; keyed claim and finish replay');

  // An expired lease is reclaimed with a new token; the old token is then stale for confirm and finish.
  due(2);
  const l1 = claim()[0];
  psql(`UPDATE public.delivery_receipt_queue SET claimed_at = now() - interval '11 minutes' WHERE id = '${l1.id}';`);
  assert.equal(confirm(l1).out, 'stale', 'confirm refuses a claim past its lease');
  assert.equal(row(2, 'status'), 'sending');
  const l2 = claim()[0];
  assert.equal(l2.id, l1.id); assert.notEqual(l2.claim_token, l1.claim_token); assert.equal(l2.attempt, 2);
  assert.equal(confirm(l1).out, 'stale');
  assert.equal(finish(l1, 'sent', "NULL, 'm', 'x@example.invalid'").out, 'stale');
  assert.equal(finish(l2, 'check', "'Resend 422 invalid address', NULL, NULL").out, 'needs_check');
  assert.equal(row(2, 'last_error'), 'Resend 422 invalid address');
  console.log('[prover] an expired lease is reclaimed and the old claim goes stale; check goes to needs_check');

  // Five attempts at most; the fifth retry and a sixth claim both stop at needs_check.
  reset(2, "attempts = 4, send_authorized_at = now() - interval '1 hour'");
  due(2);
  const c5 = claim()[0];
  assert.equal(c5.attempt, 5);
  assert.equal(finish(c5, 'retry', "'timeout', NULL, NULL").out, 'needs_check');
  assert.equal(row(2, 'last_error'), 'Tried 5 times. Last error: timeout');
  reset(2, "attempts = 5, send_authorized_at = now() - interval '1 hour'");
  due(2); assert.equal(claim().length, 0); assert.equal(row(2, 'status'), 'needs_check');
  // Past 23 hours since the first authorized send: stop (the provider's duplicate guard lasts 24 hours).
  reset(2, "attempts = 1, send_authorized_at = now() - interval '23 hours 1 minute'");
  due(2); assert.equal(claim().length, 0); assert.match(row(2, "status || ' ' || last_error"), /^needs_check .*Stopped retrying/);
  console.log('[prover] five attempts at most; past 23 hours a retry stops at needs_check');

  // Settled at claim without sending: no email now; delivery no longer completed and nothing ever authorized.
  seedDelivery(8); assert.equal(complete(8, { emailReceipt: 'true' }).status, 0);
  psql(`UPDATE public.customers SET email = '  ' WHERE id = '${CUST}';`);
  due(8); assert.equal(claim().length, 0); assert.match(row(8, "status || ' ' || last_error"), /^needs_check The customer has no email/);
  psql(`UPDATE public.customers SET email = 'ki25-farm@example.invalid' WHERE id = '${CUST}';`);
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET status = 'cancelled' WHERE id = '${D(8)}';`);
  fresh(8); assert.equal(claim().length, 0); assert.equal(row(8, 'status'), 'cancelled');
  console.log('[prover] settled at claim without sending: no email now, delivery no longer completed');

  // Confirm, right before the send. A retried claim keeps its address; confirm accepts the same address with
  // extra spacing (letter case counts: another case is another address), binds its key, and re-checks on a retry.
  seedDelivery(9); assert.equal(complete(9, { emailReceipt: 'true' }).status, 0);
  due(9);
  const k1 = claim('ki25-claim-recheck-1');
  assert.equal(k1.length, 1);
  psql(`UPDATE public.customers SET email = ' ki25-farm@example.invalid ' WHERE id = '${CUST}';`);
  assert.deepEqual(claim('ki25-claim-recheck-1').map((c) => [c.id, c.claim_token, c.attempt, c.to]),
    [[k1[0].id, k1[0].claim_token, 1, 'ki25-farm@example.invalid']], 'a retried claim keeps its address');
  psql(`UPDATE public.delivery_receipt_queue SET claimed_at = now() - interval '9 minutes' WHERE id = '${k1[0].id}';`);
  assert.equal(confirm(k1[0], 'ki25-confirm-1').out, 'send');
  assert.equal(row(9, "claimed_at > now() - interval '1 minute'"), 't', 'confirm renews the lease');
  psql(`UPDATE public.customers SET email = 'ki25-farm@example.invalid' WHERE id = '${CUST}';`);
  assert.match(confirm({ ...k1[0], id: id('98') }, 'ki25-confirm-1').err, /IDEMPOTENCY_KEY_REUSED/);
  assert.equal(confirm(k1[0], 'ki25-confirm-1').out, 'send', 'a retried confirm re-checks');
  // After a 'send', a void is never "cancelled, nothing sent": the office checks.
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET status = 'cancelled' WHERE id = '${D(9)}';`);
  assert.equal(confirm(k1[0], 'ki25-confirm-1').out, 'needs_check');
  assert.match(row(9, "status || ' ' || last_error"), /^needs_check The delivery is no longer completed, but an earlier send/);
  // That office follow-up cannot be deleted (directly or by a delete of its voided delivery cascading to it).
  assert.match(psql(`DELETE FROM public.delivery_receipt_queue WHERE delivery_id = '${D(9)}';`, { allowFailure: true }).stderr, /DELIVERY_RECEIPT_OWED/);
  console.log('[prover] confirm renews the lease, binds its key, re-checks on retry; a void after a send goes to the office list');

  // A void before any send was authorized cancels; completing the delivery again owes a fresh receipt.
  seedDelivery(20); assert.equal(complete(20, { emailReceipt: 'true' }).status, 0);
  due(20);
  const x1 = claim(); assert.equal(x1.length, 1);
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET status = 'cancelled' WHERE id = '${D(20)}';`);
  assert.equal(confirm(x1[0]).out, 'cancelled');
  assert.equal(row(20, "status || ' ' || last_error"), 'cancelled The delivery is no longer completed; no receipt was sent.');
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET status = 'completed' WHERE id = '${D(20)}';
    SELECT public._enqueue_delivery_receipt('${D(20)}', '${ADMIN}');`);
  assert.equal(row(20, "status || ' ' || attempts || ' ' || (attempt_to IS NULL) || ' ' || (claim_token IS NULL)"), 'pending 0 true true');
  psql(`UPDATE public.delivery_receipt_queue SET next_attempt_at = now() + interval '1 day' WHERE delivery_id = '${D(20)}';`);
  // A sent receipt is not reopened by another completion.
  psql(`SELECT public._enqueue_delivery_receipt('${D(1)}', '${ADMIN}');`);
  assert.equal(row(1, 'status'), 'sent');
  console.log('[prover] a void before any send cancels; a completed-again delivery owes a fresh receipt; a sent one stays sent');

  // The customer's email changed after the claim, or the delivery moved: confirm sends nothing; the office checks.
  seedDelivery(13); assert.equal(complete(13, { emailReceipt: 'true' }).status, 0);
  due(13); const e1 = claim(); assert.equal(e1.length, 1);
  psql(`UPDATE public.customers SET email = 'ki25-other@example.invalid' WHERE id = '${CUST}';`);
  assert.equal(confirm(e1[0]).out, 'needs_check');
  psql(`UPDATE public.customers SET email = 'ki25-farm@example.invalid' WHERE id = '${CUST}';`);
  assert.match(row(13, "status || ' ' || last_error"), /^needs_check The customer's email changed before the receipt was sent/);
  seedDelivery(16); assert.equal(complete(16, { emailReceipt: 'true' }).status, 0);
  due(16); const m1 = claim(); assert.equal(m1.length, 1);
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET customer_id = '${CUST_NOEMAIL}' WHERE id = '${D(16)}';`);
  assert.equal(confirm(m1[0]).out, 'needs_check');
  assert.match(row(16, "status || ' ' || last_error"), /^needs_check The delivery now belongs to another customer/);
  // The same move found at claim time goes to the office list too.
  seedDelivery(12); assert.equal(complete(12, { emailReceipt: 'true' }).status, 0);
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET customer_id = '${CUST_NOEMAIL}' WHERE id = '${D(12)}';`);
  due(12); assert.equal(claim().length, 0);
  assert.match(row(12, "status || ' ' || last_error"), /^needs_check The delivery now belongs to another customer/);
  console.log('[prover] a changed email or a moved delivery stops the send at confirm (or at claim)');

  // Confirm cannot keep renewing past the 23 hours since the first authorized send.
  seedDelivery(15); assert.equal(complete(15, { emailReceipt: 'true' }).status, 0);
  due(15); const t1 = claim(); assert.equal(confirm(t1[0]).out, 'send');
  psql(`UPDATE public.delivery_receipt_queue SET send_authorized_at = now() - interval '23 hours 1 minute' WHERE delivery_id = '${D(15)}';`);
  assert.equal(confirm(t1[0]).out, 'needs_check');
  assert.match(row(15, "status || ' ' || last_error"), /^needs_check Stopped retrying/);
  console.log('[prover] confirm stops at 23 hours after the first authorized send');

  // Confirm waits for an in-flight void of the delivery and then sees it.
  seedDelivery(19); assert.equal(complete(19, { emailReceipt: 'true' }).status, 0);
  due(19); const w1 = claim(); assert.equal(w1.length, 1);
  docker(['exec', '-d', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-c',
    `BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.deliveries SET status = 'cancelled' WHERE id = '${D(19)}'; SELECT pg_sleep(4); COMMIT;`]);
  wait(1500);
  assert.equal(scalar(`SELECT status FROM public.deliveries WHERE id = '${D(19)}';`), 'completed', 'the void has not committed yet');
  assert.equal(confirm(w1[0]).out, 'cancelled', 'confirm waited for the void to commit');
  console.log('[prover] confirm waits for an in-flight void and does not send');

  // A retry after an authorized send is sent only to that send's address; one after no authorized send uses
  // the customer's current address.
  seedDelivery(24); assert.equal(complete(24, { emailReceipt: 'true' }).status, 0);
  due(24);
  const a1 = claim(); assert.equal(a1.length, 1);
  assert.equal(confirm(a1[0]).out, 'send');
  finish(a1[0], 'retry');
  psql(`UPDATE public.customers SET email = 'ki25-other@example.invalid' WHERE id = '${CUST}';`);
  due(24); assert.equal(claim().length, 0);
  assert.match(row(24, "status || ' ' || last_error"), /^needs_check The customer's email changed after a send that may have gone out/);
  psql(`UPDATE public.customers SET email = 'ki25-farm@example.invalid' WHERE id = '${CUST}';`);
  seedDelivery(18); assert.equal(complete(18, { emailReceipt: 'true' }).status, 0);
  due(18);
  const b1 = claim(); assert.equal(b1.length, 1);
  finish(b1[0], 'retry');
  psql(`UPDATE public.customers SET email = 'KI25-New@example.invalid' WHERE id = '${CUST}';`);
  due(18);
  const b2 = claim();
  assert.deepEqual(b2.map((c) => [c.id, c.to]), [[b1[0].id, 'KI25-New@example.invalid']]);
  assert.equal(finish(b2[0], 'check', "'[PROVER] done', NULL, NULL").out, 'needs_check');
  psql(`UPDATE public.customers SET email = 'ki25-farm@example.invalid' WHERE id = '${CUST}';`);
  console.log('[prover] a retry after a send keeps its address; one after no send uses the current address');

  // A finish key is bound to its receipt, claim and outcome: reusing it elsewhere is refused, not answered.
  seedDelivery(10); assert.equal(complete(10, { emailReceipt: 'true' }).status, 0);
  seedDelivery(11); assert.equal(complete(11, { emailReceipt: 'true' }).status, 0);
  psql(`UPDATE public.delivery_receipt_queue SET next_attempt_at = now() - interval '1 second' WHERE delivery_id IN ('${D(10)}', '${D(11)}');`);
  const [fa, fb] = claim();
  assert.ok(fa && fb);
  // Only a claim confirm said 'send' to can record a send.
  assert.match(finish(fa, 'sent', "NULL, 'msg-a', 'ki25-farm@example.invalid', 'ki25-finish-unconfirmed'").err, /RECEIPT_SEND_NOT_CONFIRMED/);
  assert.equal(q(`SELECT status FROM public.delivery_receipt_queue WHERE id = '${fa.id}';`).out, 'sending', 'an unconfirmed send changes nothing');
  assert.equal(confirm(fa).out, 'send'); assert.equal(confirm(fb).out, 'send');
  assert.equal(finish(fa, 'sent', "NULL, 'msg-a', 'ki25-farm@example.invalid', 'ki25-finish-bound'").out, 'sent');
  assert.match(finish(fb, 'sent', "NULL, 'msg-b', 'ki25-farm@example.invalid', 'ki25-finish-bound'").err, /IDEMPOTENCY_KEY_REUSED/);
  assert.equal(q(`SELECT status FROM public.delivery_receipt_queue WHERE id = '${fb.id}';`).out, 'sending', 'B is untouched');
  assert.match(finish(fa, 'retry', "'x', NULL, NULL, 'ki25-finish-bound'").err, /IDEMPOTENCY_KEY_REUSED/);
  assert.equal(finish(fa, 'sent', "NULL, 'msg-a', 'ki25-farm@example.invalid', 'ki25-finish-bound'").out, 'sent');
  assert.match(finish(fa, 'sent', "NULL, 'msg-other', 'ki25-farm@example.invalid', 'ki25-finish-bound'").err, /IDEMPOTENCY_KEY_REUSED/, 'bound to its proof');
  assert.equal(finish(fb, 'sent', "NULL, 'msg-b', 'ki25-farm@example.invalid', 'ki25-finish-b'").out, 'sent');
  console.log('[prover] an unconfirmed claim cannot record a send; a finish key reused for another receipt, outcome or proof is refused');

  // A retried claim only answers while its lease holds; after that the row belongs to a fresh claim, which
  // runs the 23-hour check.
  seedDelivery(27); assert.equal(complete(27, { emailReceipt: 'true' }).status, 0);
  due(27);
  const r1 = claim('ki25-claim-expired');
  assert.equal(r1.length, 1);
  assert.equal(confirm(r1[0]).out, 'send');
  psql(`UPDATE public.delivery_receipt_queue SET claimed_at = now() - interval '11 minutes',
    send_authorized_at = now() - interval '23 hours 5 minutes' WHERE id = '${r1[0].id}';`);
  assert.equal(claim('ki25-claim-expired').length, 0, 'an expired claim is not replayed');
  assert.equal(row(27, 'status'), 'sending');
  assert.equal(claim().length, 0);
  assert.match(row(27, "status || ' ' || last_error"), /^needs_check .*Stopped retrying/);
  console.log('[prover] a retried claim past its lease returns nothing; the fresh claim stops it at 23 hours');

  // While a confirmed send may be in flight, its delivery cannot be voided, soft-deleted or moved and the
  // customer's email cannot change (exactly, case included); other edits and later edits are allowed.
  const refused = (sql) => psql(sql, { allowFailure: true });
  seedDelivery(21); assert.equal(complete(21, { emailReceipt: 'true' }).status, 0);
  due(21);
  const v1 = claim();
  assert.equal(confirm(v1[0]).out, 'send');
  const h1 = refused(`UPDATE public.customers SET email = 'ki25-other@example.invalid' WHERE id = '${CUST}';`);
  assert.notEqual(h1.status, 0); assert.match(h1.stderr, /DELIVERY_RECEIPT_SENDING/, 'email change refused mid-send');
  const h2 = refused(`UPDATE public.deliveries SET customer_id = '${CUST_NOEMAIL}' WHERE id = '${D(21)}';`);
  assert.notEqual(h2.status, 0); assert.match(h2.stderr, /DELIVERY_RECEIPT_SENDING/, 'move to another customer refused mid-send');
  const h3 = refused(`SET app.admin_override = 'true'; UPDATE public.deliveries SET status = 'voided' WHERE id = '${D(21)}';`);
  assert.notEqual(h3.status, 0); assert.match(h3.stderr, /DELIVERY_RECEIPT_SENDING/, 'void refused mid-send');
  assert.equal(q(`SELECT status || ' ' || (deleted_at IS NULL) FROM public.deliveries WHERE id = '${D(21)}';`).out, 'completed true');
  // Addresses compare exactly: a change of capital letters is a change of address.
  const h4 = refused(`UPDATE public.customers SET email = upper(email) WHERE id = '${CUST}';`);
  assert.notEqual(h4.status, 0); assert.match(h4.stderr, /DELIVERY_RECEIPT_SENDING/, 'case-only email change refused mid-send');
  psql(`UPDATE public.customers SET contact_name = contact_name WHERE id = '${CUST}';`); // other edits are fine
  // A change that bypasses triggers (replica mode) is still caught by finish: office list, send kept.
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET status = 'cancelled' WHERE id = '${D(21)}';`);
  assert.equal(finish(v1[0], 'sent', `NULL, 'msg-v', 'ki25-farm@example.invalid'`).out, 'needs_check');
  assert.match(row(21, "status || ' ' || resend_message_id || ' ' || (sent_at IS NOT NULL) || ' ' || last_error"), /^needs_check msg-v true The receipt was emailed, but/);
  // Once the send is finished, the email can change.
  psql(`UPDATE public.customers SET email = 'ki25-other@example.invalid' WHERE id = '${CUST}'; UPDATE public.customers SET email = 'ki25-farm@example.invalid' WHERE id = '${CUST}';`);
  // An unconfirmed claim does not hold edits (confirm will see them), and the hold ends with the lease.
  seedDelivery(22); assert.equal(complete(22, { emailReceipt: 'true' }).status, 0);
  due(22);
  const v2 = claim();
  psql(`UPDATE public.customers SET email = 'ki25-other@example.invalid' WHERE id = '${CUST}';`);
  assert.equal(confirm(v2[0]).out, 'needs_check', 'confirm sees an edit made before it');
  psql(`UPDATE public.customers SET email = 'ki25-farm@example.invalid' WHERE id = '${CUST}';`);
  seedDelivery(23); assert.equal(complete(23, { emailReceipt: 'true' }).status, 0);
  due(23);
  const v3 = claim();
  assert.equal(confirm(v3[0]).out, 'send');
  psql(`UPDATE public.delivery_receipt_queue SET claimed_at = now() - interval '11 minutes' WHERE id = '${v3[0].id}';`);
  psql(`UPDATE public.customers SET email = 'ki25-other@example.invalid' WHERE id = '${CUST}'; UPDATE public.customers SET email = 'ki25-farm@example.invalid' WHERE id = '${CUST}';`);
  assert.equal(finish(v3[0], 'sent', `NULL, 'msg-x', 'ki25-farm@example.invalid'`).out, 'sent', 'its own finish still records the send');
  console.log('[prover] mid-send, a void, a move to another customer and an email change are refused; replica-mode changes reach the office list; holds end at finish or lease');

  // A row settled without sending does not use up the batch: a limit-1 claim still returns the next valid receipt.
  seedDelivery(28); assert.equal(complete(28, { emailReceipt: 'true' }).status, 0);
  seedDelivery(29); assert.equal(complete(29, { emailReceipt: 'true' }).status, 0);
  psql(`UPDATE public.delivery_receipt_queue SET next_attempt_at = now() + interval '1 day' WHERE status = 'pending';
    UPDATE public.delivery_receipt_queue SET next_attempt_at = now() - interval '2 minutes' WHERE delivery_id = '${D(28)}';
    UPDATE public.delivery_receipt_queue SET next_attempt_at = now() - interval '1 minute' WHERE delivery_id = '${D(29)}';
    SET session_replication_role = replica; UPDATE public.deliveries SET status = 'cancelled' WHERE id = '${D(28)}';`);
  const one = JSON.parse(worker(`SELECT public.claim_delivery_receipts(1)::text`).out);
  assert.deepEqual(one.map((c) => c.delivery_id), [D(29)], 'the settled row did not use up the limit of 1');
  assert.equal(row(28, 'status'), 'cancelled');
  assert.equal(finish(one[0], 'check', "'[PROVER] done', NULL, NULL").out, 'needs_check');
  console.log('[prover] rows settled without sending do not use up the claim limit');

  // The timer: nothing due -> nothing posted; due but not switched on -> nothing posted; switched on -> one post.
  // pg_net's worker moves a queued call to net._http_response once tried (here: no network, so it fails).
  const posts = () => scalar('SELECT (SELECT count(*) FROM net.http_request_queue) + (SELECT count(*) FROM net._http_response);');
  psql("UPDATE public.delivery_receipt_queue SET next_attempt_at = now() + interval '1 day' WHERE status = 'pending';");
  assert.equal(scalar("SELECT count(*) FROM public.delivery_receipt_queue WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes';"), '0');
  psql(`DELETE FROM vault.secrets WHERE name IN ('delivery_receipt_worker_url', 'delivery_receipt_worker_secret');
    DELETE FROM net.http_request_queue; DELETE FROM net._http_response;`);
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
  // The timer never changes a row (no sweep): a long-overdue receipt stays where it is for the office list.
  psql(`UPDATE public.delivery_receipt_queue SET next_attempt_at = now() - interval '2 hours' WHERE delivery_id = '${D(2)}';`);
  psql('SELECT public._wake_delivery_receipt_worker();');
  assert.equal(row(2, 'status'), 'pending');
  console.log('[prover] the timer posts only when a receipt is due and both secrets exist, and changes no row');

  await proveSender();

  // Grants on the replaced complete_delivery are unchanged.
  const sig = 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean)';
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', '${sig}', 'EXECUTE')::text || has_function_privilege('service_role', '${sig}', 'EXECUTE')::text || has_function_privilege('anon', '${sig}', 'EXECUTE')::text;`), 'truetruefalse');
  console.log('DELIVERY_RECEIPT_QUEUE_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
