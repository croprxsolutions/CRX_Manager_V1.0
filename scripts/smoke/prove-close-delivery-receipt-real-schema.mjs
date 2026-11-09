#!/usr/bin/env node
/**
 * Real-schema proof for 20261221100000_close_delivery_receipt (KI-25 follow-up): Email Confirmation pauses a
 * delivery's queued customer receipt on the office list before its hand send, and "handled" closes it, so the server
 * sender never emails it afterwards. Builds the checked-in schema baseline in a network-disabled PostgreSQL container,
 * replays every migration before the candidate (the receipt queue 20261113140000 included), applies the candidate (a
 * second apply refuses), then on invented rows: pending, needs_check and claimed-but-unconfirmed rows pause or close
 * and the worker's confirm and finish then send nothing; a confirmed in-flight send is refused (and closes once its
 * lease is over, the answer saying a send was authorized); every driver, assigned or not, is refused;
 * sent / cancelled / missing rows change nothing; who may call it; the key is bound to caller and request; and both
 * orders of a same-instant close and confirm wait for each other with no double send.
 *
 * Run: node scripts/smoke/prove-close-delivery-receipt-real-schema.mjs   (needs local Docker image)
 * Prints CLOSE_DELIVERY_RECEIPT_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki25-close-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261221100000_close_delivery_receipt.sql');
const FOLLOW_UPS = [];
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
  // DATA-11 rewrites live rows only (every product gets one preferred link); the proof seeds that state.
  '20261105170000_data11_preferred_vendor_links.sql',
  // KI-01 part C changes job and storage access only; its preflight needs live's storage.objects policies, which this
  // database does not have. Its own proof is prove-job-access-ends-with-the-job-real-schema.mjs.
  '20261217100000_job_access_ends_with_the_job.sql',
  // Its KI-73 follow-up (applicator spray-record fields) needs part C applied; same reason.
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(close_delivery_receipt|delivery_receipt_queue|confirm_delivery_receipt_send|finish_delivery_receipt|claim_delivery_receipts|check_idempotency_intent|_bind_replay_receipt_20261015|_replay_fingerprint_20261015)\b/i;
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
  for (const file of all.slice(at + 1).filter((f) => !FOLLOW_UPS.includes(f))) {
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
const id = (n) => `25c10000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const DRIVER = id('a2');
const REP = id('a3');
const DRIVER2 = id('a4');
const OLD_ADMIN = id('a5'); // inactive
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
  // The baseline auth.users is a stub; later profile triggers write the real column set.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;`, { user: 'supabase_admin' });
  const users = [[ADMIN, 'admin'], [DRIVER, 'driver'], [REP, 'sales_rep'], [DRIVER2, 'driver'], [OLD_ADMIN, 'admin']];
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ${users.map(([u, r], i) =>
    `('${u}', 'ki25close-${i}@example.invalid', '{"full_name":"[PROVER] ${r} ${i}","role":"${r}"}'::jsonb)`).join(', ')};`);
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id = '${DRIVER2}';
    UPDATE public.profiles SET role = 'admin', is_active = false WHERE id = '${OLD_ADMIN}';`);
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
const confirm = (c, key) =>
  worker(`SELECT public.confirm_delivery_receipt_send('${c.id}', '${c.claim_token}'${key ? `, '${key}'` : ''})`, { allowFailure: true });

// The office call, as the app sends it (named arguments). uid null = anon.
function close(uid, i, reason, key, { allowFailure = true } = {}) {
  return q(`BEGIN;\n${uid ? claims(uid) : ''}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};
    SELECT public.close_delivery_receipt(p_delivery_id => '${D(i)}', p_reason => ${reason === null ? 'NULL' : `'${reason}'`},
      p_idempotency_key => ${key === null ? 'NULL' : `'${key}'`})::text;
    COMMIT;`, { allowFailure });
}
function closed(uid, i, reason, key) {
  const r = close(uid, i, reason, key);
  assert.equal(r.status, 0, r.err);
  const out = JSON.parse(r.out);
  assert.ok('queued_at' in out, 'every answer names the receipt it is about');
  delete out.queued_at;
  return out;
}
function refused(r, pattern) {
  assert.notEqual(r.status, 0, 'the call must be refused');
  assert.match(r.err, pattern);
}
// The office list's own filter (src/lib/receiptsToCheck.ts): needs_check, or owed and over an hour old.
const listed = (i) => q(`SELECT count(*) FROM public.delivery_receipt_queue WHERE delivery_id = '${D(i)}'
  AND (status = 'needs_check' OR (status IN ('pending', 'sending') AND created_at < now() - interval '1 hour'));`).out;
// Holds a transaction open for 4 s (session 1) while session 2 runs; session 2 must wait for it.
async function race(name, holderSql, second) {
  stageText(name, `${holderSql}\nSELECT pg_sleep(4);\nCOMMIT;\n`);
  const holder = spawn('docker', [...psqlArgs(), '-f', `/tmp/${name}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  holder.stdout.on('data', (d) => { out += d; });
  holder.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => holder.on('close', resolve));
  // Session 1 has taken its lock once it reaches its pg_sleep (the statement after the locking call), however slow
  // Docker is; wait for that rather than for a fixed delay (Luna LOW).
  let sleeping = false;
  for (let i = 0; i < 100 && !sleeping; i += 1) {
    sleeping = scalar("SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE 'SELECT pg_sleep(4)%' AND pid <> pg_backend_pid();") === '1';
    if (!sleeping) wait(100);
  }
  assert.ok(sleeping, `${name}: session 1 never reached its sleep`);
  const started = Date.now();
  const result = second();
  const waited = Date.now() - started;
  assert.equal(await done, 0, out);
  assert.ok(waited >= 1000, `${name}: session 2 should have waited for session 1 (waited ${waited} ms)`);
  return result;
}

async function main() {
  buildContainer();
  seedUsers();
  // The sender is switched on (its two Vault secrets), so an asked-for receipt is owed (pending).
  psql(`SELECT vault.create_secret('http://127.0.0.1:9/functions/v1/send-delivery-receipts', 'delivery_receipt_worker_url');
    SELECT vault.create_secret('[PROVER] not a real secret', 'delivery_receipt_worker_secret');`);
  for (const i of [1, 3, 4, 5, 6, 7, 8, 9]) seedDelivery(i);
  seedDelivery(2, CUST_NOEMAIL);
  for (const i of [1, 2, 3, 4, 6, 7, 8, 9]) { const r = complete(i, { emailReceipt: 'true' }); assert.equal(r.status, 0, r.err); }
  assert.equal(complete(5).status, 0);  // no receipt asked for
  assert.equal(row(1, 'status'), 'pending');
  assert.equal(row(2, 'status'), 'needs_check');
  assert.equal(queued(5), '0');

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /PREFLIGHT_CLOSE_DELIVERY_RECEIPT_DRIFT/);
  const sig = 'public.close_delivery_receipt(uuid,text,text)';
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', '${sig}', 'EXECUTE')::text || has_function_privilege('anon', '${sig}', 'EXECUTE')::text
    || has_function_privilege('service_role', '${sig}', 'EXECUTE')::text;`), 'truefalsefalse');
  console.log('[prover] candidate applied once; a second apply refuses; EXECUTE for authenticated only');

  // Who may call it, and what it needs. Nothing changes on a refusal.
  refused(close(null, 1, 'handled', 'k-anon'), /permission denied/);
  refused(close(ADMIN, 1, 'handled', null), /IDEMPOTENCY_KEY_REQUIRED/);
  refused(close(ADMIN, 1, 'whatever', 'k-bad'), /RECEIPT_CLOSE_INVALID/);
  refused(close(OLD_ADMIN, 1, 'handled', 'k-old'), /INSUFFICIENT_ROLE/);
  // Delivery 1 has no assigned driver: a driver must be refused, not let through by a NULL comparison.
  assert.equal(scalar(`SELECT count(*) FROM public.deliveries WHERE id = '${D(1)}' AND assigned_driver IS NULL;`), '1');
  refused(close(DRIVER, 1, 'handled', 'k-drv-h'), /INSUFFICIENT_ROLE/);
  refused(close(DRIVER, 1, 'manual_send', 'k-drv-m'), /INSUFFICIENT_ROLE/);
  assert.equal(row(1, 'status'), 'pending');
  console.log('[prover] anon, no key, a bad reason, an inactive admin and a driver on an unassigned delivery are refused');

  const answer = (i, outcome, previous, extra = {}) =>
    ({ delivery_id: D(i), outcome, previous_status: previous, sent_at: null, send_authorized_at: null, ...extra });

  // Email Confirmation on a pending receipt: paused on the office list (the worker never claims it), so a hand send
  // that fails is not lost; after the hand send works, 'handled' closes it and it leaves the list.
  const r1 = closed(ADMIN, 1, 'manual_send', 'k-1');
  assert.deepEqual(r1, answer(1, 'paused', 'pending'));
  assert.match(row(1, "status || '|' || last_error"), /^needs_check\|Email Confirmation started by \[PROVER\] admin 0; the server will not send it/);
  assert.equal(listed(1), '1');
  due(1); assert.equal(claim().filter((c) => c.delivery_id === D(1)).length, 0);
  // A retry with the same key re-checks the receipt as it is now (here: already paused); the key is bound to its
  // caller and request.
  assert.deepEqual(closed(ADMIN, 1, 'manual_send', 'k-1'), answer(1, 'paused', 'needs_check'));
  refused(close(ADMIN, 1, 'handled', 'k-1'), /IDEMPOTENCY_INTENT_MISMATCH/);
  refused(close(REP, 1, 'manual_send', 'k-1'), /IDEMPOTENCY_ACTOR_MISMATCH/);
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE operation = 'close_delivery_receipt' AND request_actor_id IS NULL;"), '0');
  assert.deepEqual(closed(ADMIN, 1, 'handled', 'k-1h'), answer(1, 'closed', 'needs_check'));
  assert.equal(listed(1), '0');
  assert.equal(row(1, "status || '|' || last_error"), 'cancelled|Marked handled by [PROVER] admin 0; the server will not send it.');
  // Already closed: nothing to do.
  assert.deepEqual(closed(REP, 1, 'handled', 'k-1b'), { delivery_id: D(1), outcome: 'none', previous_status: 'cancelled', sent_at: null, send_authorized_at: null });
  // A late retry of the first Email Confirmation key no longer gets its old go-ahead: the receipt is closed now (Sol HIGH, #1678).
  assert.equal(closed(ADMIN, 1, 'manual_send', 'k-1').outcome, 'none');
  // The receipt is queued again, as a second completion does (new created_at): a late retry of either old key changes
  // nothing and is refused, so it neither cancels the new receipt nor gives a go-ahead to send it (Sol HIGH, round 8).
  psql(`SET session_replication_role = replica; UPDATE public.delivery_receipt_queue SET status = 'pending', last_error = NULL, created_at = now() WHERE delivery_id = '${D(1)}';`);
  refused(close(ADMIN, 1, 'handled', 'k-1h'), /DELIVERY_RECEIPT_CHANGED/);
  refused(close(ADMIN, 1, 'manual_send', 'k-1'), /DELIVERY_RECEIPT_CHANGED/);
  assert.equal(row(1, 'status'), 'pending');
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key IN ('k-1', 'k-1h');"), '2');
  // A fresh press (new key) acts on the new receipt.
  assert.deepEqual(closed(ADMIN, 1, 'handled', 'k-1n'), answer(1, 'closed', 'pending'));
  assert.equal(row(1, 'status'), 'cancelled');
  console.log('[prover] Email Confirmation pauses a pending receipt on the list; handled then closes it; keys are bound; a retry re-checks the same receipt and never acts on a re-queued one');

  // A needs_check receipt (no email on file) on the office list, marked handled by a sales rep: it leaves the list.
  assert.equal(listed(2), '1');
  // Two Email Confirmations in a row keep the original reason, once (Taha, LOW).
  assert.deepEqual(closed(REP, 2, 'manual_send', 'k-2a'), answer(2, 'paused', 'needs_check'));
  assert.deepEqual(closed(REP, 2, 'manual_send', 'k-2b'), answer(2, 'paused', 'needs_check'));
  assert.match(row(2, "status || '|' || last_error"), /^needs_check\|Email Confirmation started by \[PROVER\] sales_rep 2; the server will not send it\. If the customer did not get it, send it again\. Was: The customer has no email on file/);
  assert.equal(row(2, "(length(last_error) - length(replace(last_error, ' Was: ', ''))) / 6"), '1');
  assert.deepEqual(closed(REP, 2, 'handled', 'k-2'), answer(2, 'closed', 'needs_check'));
  assert.equal(listed(2), '0');
  assert.match(row(2, "status || '|' || last_error"), /^cancelled\|Marked handled by \[PROVER\] sales_rep 2; the server will not send it\. Was: The customer has no email on file/);
  console.log('[prover] a needs_check receipt marked handled leaves the list');

  // Claimed but not yet confirmed: pausing clears the claim, so the worker's confirm says stale and nothing is sent.
  due(3);
  const c3 = claim().find((c) => c.delivery_id === D(3));
  assert.ok(c3, 'receipt 3 must be claimed');
  assert.deepEqual(closed(ADMIN, 3, 'manual_send', 'k-3'), answer(3, 'paused', 'sending'));
  assert.equal(confirm(c3).out, 'stale');
  assert.equal(finish(c3, 'sent', "NULL, 'prov-3', 'ki25-farm@example.invalid'").out, 'stale');
  assert.equal(row(3, "status || '|' || coalesce(sent_at::text, '-')"), 'needs_check|-');
  console.log('[prover] a claimed receipt pauses; the worker then gets stale from confirm and finish and sends nothing');

  // Confirmed and possibly being emailed now: refused, row unchanged, and no answer saved for the key.
  due(4);
  const c4 = claim().find((c) => c.delivery_id === D(4));
  assert.equal(confirm(c4).out, 'send');
  refused(close(ADMIN, 4, 'manual_send', 'k-4'), /DELIVERY_RECEIPT_SENDING/);
  refused(close(REP, 4, 'handled', 'k-4h'), /DELIVERY_RECEIPT_SENDING/);
  assert.equal(row(4, 'status'), 'sending');
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key IN ('k-4', 'k-4h');"), '0');
  // The send finishes: the same key now answers 'sent' with when (never the address), and changes nothing.
  assert.equal(finish(c4, 'sent', "NULL, 'prov-4', 'ki25-farm@example.invalid'").out, 'sent');
  const r4 = closed(ADMIN, 4, 'manual_send', 'k-4');
  assert.equal(r4.outcome, 'sent');
  assert.ok(r4.sent_at && r4.send_authorized_at);
  assert.ok(!('sent_to' in r4), 'the answer never carries the address');
  assert.equal(row(4, 'status'), 'sent');
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE operation = 'close_delivery_receipt' AND result::text LIKE '%@%';"), '0');
  console.log('[prover] a confirmed in-flight send is refused; once sent, the call answers sent and changes nothing');

  // A confirmed send whose 10-minute lease ran out (the worker died): it can be closed, and the answer says a send
  // was authorized, so the screen can warn.
  due(6);
  const c6 = claim().find((c) => c.delivery_id === D(6));
  assert.equal(confirm(c6).out, 'send');
  psql(`UPDATE public.delivery_receipt_queue SET claimed_at = now() - interval '11 minutes' WHERE delivery_id = '${D(6)}';`);
  const r6 = closed(REP, 6, 'handled', 'k-6');
  assert.equal(r6.outcome, 'closed');
  assert.ok(r6.send_authorized_at, 'the answer must say a send may have gone out');
  assert.equal(confirm(c6).out, 'stale');
  console.log('[prover] a confirmed send past its lease can be closed, and the answer says a send may have gone out');

  // No receipt was ever asked for: nothing to close.
  assert.deepEqual(closed(ADMIN, 5, 'manual_send', 'k-5'), { delivery_id: D(5), outcome: 'none', previous_status: null, sent_at: null, send_authorized_at: null });
  assert.equal(queued(5), '0');

  // Office only: even this delivery's own driver may not pause or close its receipt (Sol HIGH, PR #1678).
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET assigned_driver = '${DRIVER2}' WHERE id = '${D(7)}';`);
  const before7 = row(7, "status || '|' || coalesce(last_error, '')");
  refused(close(DRIVER, 7, 'manual_send', 'k-7x'), /INSUFFICIENT_ROLE/);
  refused(close(DRIVER2, 7, 'manual_send', 'k-7'), /INSUFFICIENT_ROLE/);
  refused(close(DRIVER2, 7, 'handled', 'k-7h'), /INSUFFICIENT_ROLE/);
  assert.equal(row(7, "status || '|' || coalesce(last_error, '')"), before7);
  assert.deepEqual(closed(REP, 7, 'manual_send', 'k-7r').outcome, 'paused');
  assert.deepEqual(closed(REP, 7, 'handled', 'k-7rh').outcome, 'closed');
  console.log('[prover] no row answers none; drivers are refused even on their own delivery; the office may pause and close');

  // A delivery that is no longer completed (removed here) gives no go-ahead for a hand send, not even on a replayed key;
  // closing it is still allowed (Sol HIGH, #1678).
  psql(`SET session_replication_role = replica; UPDATE public.deliveries SET deleted_at = now() WHERE id = '${D(7)}';`);
  refused(close(REP, 7, 'manual_send', 'k-7r'), /DELIVERY_NOT_COMPLETED/);  // its earlier answer was 'paused'
  refused(close(ADMIN, 7, 'manual_send', 'k-7n'), /DELIVERY_NOT_COMPLETED/);
  // Closing it is still allowed, and a long earlier message is kept whole under the new note (Sol LOW).
  const long = 'x'.repeat(499) + 'Z';
  psql(`SET session_replication_role = replica; UPDATE public.delivery_receipt_queue SET status = 'needs_check', last_error = '${long}' WHERE delivery_id = '${D(7)}';`);
  assert.equal(closed(ADMIN, 7, 'handled', 'k-7h2').outcome, 'closed');
  assert.match(row(7, 'last_error'), /^Marked handled by .* Was: x{499}Z$/);
  console.log('[prover] a removed delivery gives no hand-send go-ahead, even on a replay; a long earlier message is kept whole');

  // Same instant, close first: the worker's confirm waits for the close, then sees it and says stale.
  due(8);
  const c8 = claim().find((c) => c.delivery_id === D(8));
  const confirm8 = await race('close-first.sql',
    `BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;\nSELECT public.close_delivery_receipt('${D(8)}', 'manual_send', 'k-8');`,
    () => confirm(c8));
  assert.equal(confirm8.out, 'stale');
  assert.equal(row(8, 'status'), 'needs_check');
  // Same instant, confirm first: the close waits for it, then refuses (a send may be going out).
  due(9);
  const c9 = claim().find((c) => c.delivery_id === D(9));
  const close9 = await race('confirm-first.sql',
    `BEGIN;\nSET LOCAL ROLE service_role;\nSELECT public.confirm_delivery_receipt_send('${c9.id}', '${c9.claim_token}');`,
    () => close(ADMIN, 9, 'manual_send', 'k-9'));
  refused(close9, /DELIVERY_RECEIPT_SENDING/);
  assert.equal(row(9, 'status'), 'sending');
  console.log('[prover] same-instant close and confirm wait for each other in both orders; never both');

  // The live smoke chain (smoke-close-delivery-receipt-chain.sql) passes here too, with a sent receipt present.
  stageText('chain.sql', `BEGIN;\n${lf(path.join(ROOT, 'scripts', 'smoke', 'smoke-close-delivery-receipt-chain.sql'))}\nROLLBACK;\n`);
  const chain = apply('chain.sql');
  assert.match(chain.output, /SMOKE_PASS_ROLLBACK/, chain.output);
  assert.doesNotMatch(chain.output, /SMOKE_FAIL|SMOKE_SETUP/, chain.output);
  console.log('[prover] the live smoke chain passes (SMOKE_PASS_ROLLBACK)');

  console.log('CLOSE_DELIVERY_RECEIPT_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
