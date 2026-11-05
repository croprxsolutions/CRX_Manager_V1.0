#!/usr/bin/env node
/**
 * Real-schema proof for KI-93 (20261107050000): blend tickets go through application records only.
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays migrations
 * up to the candidate, and with invented rows checks through the real RPCs:
 *   BEFORE: a ticket's order delivers and the ticket also gets an application record (the bug); saved
 *           successes of create-order, link and Unlink exist for the replay checks.
 *   APPLY:  a ticket still linked stops the apply; the candidate applies once.
 *   AFTER:  create order from ticket, link and Unlink refuse first thing (also as an exact replay of a
 *           saved success, and as a driver) and leave no order, line, link, reservation, stock ledger,
 *           retry receipt, activity or audit row; a direct link-row insert or update is refused by the
 *           table guard alone, also under the old create-order impl; a ticket cannot be set linked by
 *           hand; one ticket: application record takes stock once, a second is refused, a direct
 *           invoice works, reversing puts the stock back; the blend guards smoke chain passes its steps.
 *   MUTATION: without the table guard a direct link-row insert succeeds again.
 *
 * Run: node scripts/smoke/prove-blend-tickets-application-records-only-real-schema.mjs   (needs local Docker image)
 * CRX_PROVER_KEEP_CONTAINER=1 keeps the container; CRX_PROVER_REUSE_CONTAINER=<name> reuses one (the
 * BEFORE and APPLY stages are skipped once the candidate is in).
 * Prints BLEND_TICKETS_APPLICATION_RECORDS_ONLY_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-bt-appl-only-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261107050000_blend_tickets_application_records_only.sql');
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
const TOUCHED = /(_blend_ticket_orders_disabled|trigger_a_blend_ticket_orders_disabled|FUNCTION public\.(create_order_from_blend_ticket|link_blend_ticket_to_order|unlink_blend_ticket_from_order)\()/i;
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

// A reused container gets fresh rows each run.
const RUN = (Date.now() % 0xffff).toString(16).padStart(4, '0');
const id = (n) => `93${RUN}00-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), DRIVER: id('a2') };
const CUST = id('c1');
const PROD = id('f1');
const ORDER = id('d1');
const ORDER_ITEM = id('e1');
// A is reused by rolled-back cases; F and G carry the committed BEFORE successes.
const T = { A: id('b1'), B: id('b2'), C: id('b3'), D: id('b4'), E: id('b5'), F: id('b6'), G: id('b7') };
const TN = (k) => `PV93${RUN}-${k}`;
function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${U.ADMIN}', 'bt-appl-admin-${RUN}@example.invalid', '{"full_name":"[PROVER] Admin ${RUN}","role":"admin"}'::jsonb),
      ('${U.DRIVER}', 'bt-appl-driver-${RUN}@example.invalid', '{"full_name":"[PROVER] Driver ${RUN}","role":"driver"}'::jsonb);`);
  // Invented rows only; triggers are skipped so the seed sets exactly the shapes under test.
  const tickets = Object.entries(T).map(([k, t]) => `('${t}', '${TN(k)}', '${U.ADMIN}', 'completed', 'approved', '${CUST}', 2027, DATE '2026-11-01', 1)`).join(',\n      ');
  const lines = Object.values(T).map((t) => `(gen_random_uuid(), '${t}', '${PROD}', '[PROVER] Blend Chem', 10, 'gal', 1, 10, 'gal/ac')`).join(',\n      ');
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${U.ADMIN}';
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id = '${U.DRIVER}';
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active) VALUES ('${CUST}', '[PROVER] Blend Farm ${RUN}', 1, true);
    INSERT INTO public.products (id, product_name, is_active, tier1_price, tier2_price, tier3_price, current_cost, inventory_unit, unit_size, product_form)
      VALUES ('${PROD}', '[PROVER] Blend Chem ${RUN}', true, 20, 20, 20, 5, 'gal', 'gal', 'liquid');
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES ('${PROD}', 'Main Warehouse', 100, 0, 0);
    INSERT INTO public.blend_tickets (id, ticket_number, uploaded_by, status, review_status, customer_id, season, ticket_date, total_acres) VALUES
      ${tickets};
    INSERT INTO public.blend_ticket_products (id, blend_ticket_id, product_id, product_name, quantity, unit, sequence_order, rate_per_acre, rate_per_acre_unit) VALUES
      ${lines};
    INSERT INTO public.fields (id, customer_id, field_name) VALUES ('${id('f9')}', '${CUST}', '[PROVER] Ticket Field ${RUN}');
    INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, planned_acres)
      SELECT t, '${id('f9')}', '${CUST}', 1 FROM unnest(ARRAY['${Object.values(T).join("','")}']::uuid[]) t;
    INSERT INTO public.orders (id, order_number, customer_id, status, season) VALUES ('${ORDER}', 'PV93${RUN}-O1', '${CUST}', 'confirmed', 2027);
    INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit, total_units_needed, quantity_remaining, unit_size)
      VALUES ('${ORDER_ITEM}', '${ORDER}', '${PROD}', '[PROVER] Blend Chem', 20, 5, 10, 10, 'gal');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  // Prover-only helpers: stage one order line on an in-progress delivery (triggers off, as the seed),
  // then complete it through complete_delivery, and void a delivery through void_delivery, as the
  // signed-in caller. Only the image's superuser may switch triggers off, so it owns the stager.
  psql(`CREATE OR REPLACE FUNCTION public.pv93_stage(p_line uuid, p_qty numeric) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
    DECLARE d uuid := gen_random_uuid(); di uuid := gen_random_uuid(); v_line record; v_order record;
    BEGIN
      SELECT * INTO v_line FROM public.order_items WHERE id = p_line;
      IF NOT FOUND THEN RAISE EXCEPTION 'pv93_stage: no line %', p_line; END IF;
      SELECT * INTO v_order FROM public.orders WHERE id = v_line.order_id;
      PERFORM set_config('session_replication_role', 'replica', true);
      INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date)
        VALUES (d, 'PV93-D-' || left(d::text, 8), v_order.id, v_order.customer_id, auth.uid(), 'in_progress', current_date);
      INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
        VALUES (di, d, p_line, v_line.product_id, p_qty, 'gal');
      PERFORM set_config('session_replication_role', 'origin', true);
      RETURN jsonb_build_object('d', d, 'di', di);
    END $f$;
    GRANT EXECUTE ON FUNCTION public.pv93_stage(uuid, numeric) TO postgres;`, { user: 'supabase_admin' });
  psql(`CREATE OR REPLACE FUNCTION public.pv93_deliver(p_line uuid, p_qty numeric) RETURNS uuid LANGUAGE plpgsql AS $f$
    DECLARE v_staged jsonb := public.pv93_stage(p_line, p_qty); v_before numeric;
    BEGIN
      SELECT quantity_delivered INTO v_before FROM public.order_items WHERE id = p_line;
      PERFORM public.complete_delivery((v_staged ->> 'd')::uuid, 'No proof — recorded by office', auth.uid(),
        jsonb_build_object(v_staged ->> 'di', p_qty), NULL, NULL, 'pv93-c-' || (v_staged ->> 'd'), NULL, 'no_proof', '[PROVER] no signature');
      IF (SELECT quantity_delivered FROM public.order_items WHERE id = p_line) < v_before + p_qty THEN
        RAISE EXCEPTION 'pv93_deliver: the line did not deliver';
      END IF;
      RETURN (v_staged ->> 'd')::uuid;
    END $f$;
    CREATE OR REPLACE FUNCTION public.pv93_void(p_delivery uuid) RETURNS void LANGUAGE plpgsql AS $f$
    BEGIN
      PERFORM public.void_delivery(p_delivery, '[PROVER] wrong delivery', auth.uid(), 'pv93-v-' || p_delivery);
    END $f$;`);
  console.log(`[prover] seeded run ${RUN}: an admin, a driver, a customer, one stocked product (100 gal on hand), an open order and seven approved blend tickets (10 gal each)`);
}

let keyN = 0;
const key = () => `pv93-${RUN}-${(keyN += 1)}`;
const AS_ADMIN = `SELECT set_config('request.jwt.claim.sub', '${U.ADMIN}', false);`;
const ok = (call, what) => `IF NOT (${call}::jsonb ->> 'success')::boolean THEN RAISE EXCEPTION '${what} answered success=false'; END IF;`;
const appRecord = (t) => `PERFORM public.create_application_record_from_blend_ticket('${t}', '${U.ADMIN}', '${key()}');`;
const createOrderCall = (t, k) => `public.create_order_from_blend_ticket('${t}', 'PV93${RUN}-N${(keyN += 1)}', DATE '2026-11-02', NULL, '${U.ADMIN}', '${k}')`;
const linkCall = (t, k) => `public.link_blend_ticket_to_order('${t}', '${ORDER}', NULL, '${U.ADMIN}', '${k}')`;
const unlinkCall = (t, k) => `public.unlink_blend_ticket_from_order('${t}', '${U.ADMIN}', '${k}')`;
const reverse = (t) => `PERFORM public.reverse_application_record((SELECT id FROM public.application_records WHERE source_type = 'blend_ticket' AND source_id = '${t}' LIMIT 1), '${key()}');`;
const LINK_LINE = (t) => `(SELECT order_item_id FROM public.blend_ticket_to_order_items WHERE blend_ticket_id = '${t}' LIMIT 1)`;
const deliver = (line, qty) => `PERFORM public.pv93_deliver(${line}, ${qty});`;
const STOCK = `(SELECT quantity_available::numeric(12,2) || '/' || quantity_prebooked::numeric(12,2) FROM public.inventory WHERE product_id = '${PROD}' AND location = 'Main Warehouse')`;
const onHand = (s) => s.split('/')[0];
const minus = (s, n) => (Number(onHand(s)) - n).toFixed(2);
// Everything a create-order, link or Unlink call could leave behind.
const SNAP = `SELECT (SELECT count(*) FROM public.orders) || '/' || (SELECT count(*) FROM public.order_items)
  || '/' || (SELECT count(*) FROM public.blend_ticket_to_order_items) || '/' || (SELECT count(*) FROM public.inventory_transactions)
  || '/' || (SELECT count(*) FROM public.idempotency_keys) || '/' || (SELECT count(*) FROM public.activity_feed)
  || '/' || (SELECT count(*) FROM public.financial_audit_log) || '/' || ${STOCK}
  || '/' || (SELECT string_agg(order_link_status || payment_status, ',' ORDER BY id) FROM public.blend_tickets WHERE id IN ('${T.A}', '${T.F}', '${T.G}'));`;

// The first step must succeed; the second is caught. Returns the second step's outcome and the
// stock (on hand/booked) after both, all in one rolled-back transaction.
function twoSteps(first, second, prefix = '', user = 'postgres') {
  const r = docker([...psqlArgs(user)], {
    input: `BEGIN;\n${prefix}\n${AS_ADMIN}\nDO $two$
DECLARE m text := 'ALLOWED';
BEGIN
  ${first}
  BEGIN
    ${second}
  EXCEPTION WHEN OTHERS THEN m := SQLERRM;
  END;
  RAISE NOTICE 'SECOND=%', m;
  RAISE NOTICE 'STOCK=%', ${STOCK};
END
$two$;\nROLLBACK;`,
    allowFailure: true,
  });
  assert.equal(r.status, 0, `the first step failed:\n${r.stderr}`);
  return { second: /SECOND=(.*)/.exec(r.stderr)[1].trim(), stock: /STOCK=(.*)/.exec(r.stderr)[1].trim() };
}
function commit(sql) { psql(`BEGIN;\n${AS_ADMIN}\nDO $c$ BEGIN ${sql} END $c$;\nCOMMIT;`); }
// One RPC call in its own committed transaction, as the app sends it (optionally as a signed-in user).
// Returns its error and whether anything at all changed.
function committedCall(call, asUser = '') {
  const before = scalar(SNAP);
  const r = docker([...psqlArgs()], {
    input: `${asUser ? `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${asUser}', false);` : AS_ADMIN}\nSELECT ${call};`,
    allowFailure: true,
  });
  return { error: /ERROR:\s*(.*)/.exec(r.stderr)?.[1] ?? 'ALLOWED', unchanged: scalar(SNAP) === before };
}

// The blend guards smoke chain borrows real rows; this database is schema-only, so seed them once
// (a sales rep, an applicator, a field, a second customer, an unbatched commission).
let chainSeeded = false;
function chain(file) {
  if (!chainSeeded) {
    // Live's auth schema has these; the image's does not (as prove-stock-replay-binding-batch2 seeds them).
    psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
      CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
      CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
      GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;
      ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS owner uuid;`, { user: 'supabase_admin' });
    const sales = id('a3');
    const applicator = id('a4');
    psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        ('${sales}', 'bt-appl-sales-${RUN}@example.invalid', '{"full_name":"[PROVER] Sales ${RUN}","role":"sales_rep"}'::jsonb),
        ('${applicator}', 'bt-appl-applicator-${RUN}@example.invalid', '{"full_name":"[PROVER] Applicator ${RUN}","role":"applicator"}'::jsonb);`);
    psql(`SET session_replication_role = replica;
      UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${sales}';
      UPDATE public.profiles SET role = 'applicator', is_active = true WHERE id = '${applicator}';
      INSERT INTO public.fields (customer_id, field_name) VALUES ('${CUST}', '[PROVER] Field ${RUN}');
      INSERT INTO public.customers (id, farm_name, assigned_tier, is_active) VALUES ('${id('c2')}', '[PROVER] Second Farm ${RUN}', 1, true);
      INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT 'gal', 128, 'liquid'
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = 'gal');
      UPDATE public.commissions SET order_date = current_date - 1 WHERE order_date IS NULL OR order_date >= current_date;  -- dated before any Chicago payment date; also a reused container's older seed
      INSERT INTO public.commissions (id, customer_id, order_id, order_date, status, commission_amount) VALUES ('${id('c9')}', '${CUST}', '${ORDER}', current_date - 1, 'pending', 10);
      UPDATE public.commission_earned_state_ledger SET order_date = current_date - 1 WHERE order_date >= current_date;
      -- The chain pays it to the first active admin, so that admin earned it.
      INSERT INTO public.commission_earned_state_ledger (commission_id, event_kind, effective_at, recipient_id, recipient_group_key,
          recipient_name, source_type, source_number, customer_name, order_date, amount_cents, is_earned)
        SELECT c.id, 'baseline', now() - interval '1 day', a.id, a.id::text, '[PROVER]', 'order', 'PV93', '[PROVER]', current_date - 1, 1000, true
          FROM public.commissions c, (SELECT id FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1) a
         WHERE c.status = 'pending' AND NOT EXISTS (SELECT 1 FROM public.commission_earned_state_ledger s WHERE s.commission_id = c.id);
      SET session_replication_role = origin;`, { user: 'supabase_admin' });
    chainSeeded = true;
  }
  stageText('chain.sql', lf(file));
  // The chain compares dates with the Chicago business date; after 7 pm Central, UTC is already tomorrow.
  const r = docker([...psqlArgs()], { input: "BEGIN;\nSET LOCAL TimeZone = 'America/Chicago';\n\\i /tmp/chain.sql\nROLLBACK;\n", allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  return /SMOKE_PASS_ROLLBACK/.test(out) ? '' : (/SMOKE_FAIL[^\n]*/.exec(out)?.[0] ?? /ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-400));
}


const DISABLED = /BLEND_TICKET_ORDERS_DISABLED: blend tickets are recorded through application records only/;
const CHAIN = path.join(ROOT, 'scripts', 'smoke', 'smoke-gauntlet-core-blend-guards.sql');
const directLink = (t) => `INSERT INTO public.blend_ticket_to_order_items (blend_ticket_id, order_id, order_item_id, blend_ticket_product_id, created_by)
  SELECT '${t}', '${ORDER}', '${ORDER_ITEM}', id, '${U.ADMIN}' FROM public.blend_ticket_products WHERE blend_ticket_id = '${t}';`;
const KEYS = {};

async function main() {
  const applied = () => scalar("SELECT to_regprocedure('public._blend_ticket_orders_disabled()') IS NOT NULL;") === 't';
  if (!REUSE) buildContainer();
  seed();
  const A = T.A;

  if (!applied()) {
    // BEFORE: the bug. The ticket's order delivers 10 gal, and the ticket also gets an application record.
    const base = scalar(`SELECT ${STOCK};`);
    const bug = twoSteps(`IF NOT (${createOrderCall(A, key())}::jsonb ->> 'success')::boolean THEN RAISE EXCEPTION 'order failed'; END IF;
      ${deliver(LINK_LINE(A), 10)}`, appRecord(A));
    assert.equal(bug.second, 'ALLOWED', `BEFORE: the application record was refused: ${bug.second}`);
    assert.equal(onHand(bug.stock), minus(base, 20), 'BEFORE: delivery then application record');
    console.log(`[prover] BEFORE: one 10 gal ticket's order delivered and the ticket also got an application record (on hand ${onHand(base)} -> ${onHand(bug.stock)})`);

    // Saved successes, committed, for the replay checks: F made an order then was unlinked; G was linked then unlinked.
    Object.assign(KEYS, { createF: key(), unlinkF: key(), linkG: key(), unlinkG: key() });
    commit(`${ok(createOrderCall(T.F, KEYS.createF), 'order')} ${ok(unlinkCall(T.F, KEYS.unlinkF), 'unlink')}
      ${ok(linkCall(T.G, KEYS.linkG), 'link')} ${ok(unlinkCall(T.G, KEYS.unlinkG), 'unlink')}`);
    console.log('[prover] BEFORE: committed a successful create-order + Unlink (ticket F) and link + Unlink (ticket G), keeping their retry receipts');
    const before = chain(CHAIN);
    assert.match(before, /SMOKE_FAIL\([a-z-]+\):.*(succeeded|accepted|wrong|ORDERS_DISABLED)/i, `BEFORE: the chain's order-path steps should fail on the old schema: ${before}`);
    console.log(`[prover] BEFORE: the updated blend guards smoke chain fails on the old schema: ${before.slice(0, 140)}`);

    stageText('candidate.sql', lf(CANDIDATE));
    const stop = docker([...psqlArgs()], { input: `BEGIN;\n${AS_ADMIN}\nDO $e$ BEGIN ${ok(createOrderCall(A, key()), 'order')} END $e$;\n\\i /tmp/candidate.sql\nROLLBACK;`, allowFailure: true }).stderr;
    assert.match(stop, /PREFLIGHT_BLEND_TICKET_ORDERS_IN_USE/, `a linked ticket did not stop the apply:\n${stop}`);
    const first = apply('candidate.sql');
    assert.equal(first.status, 0, `candidate failed:\n${first.output}`);
    assert.match(first.output, /POSTFLIGHT_OK/);
    assert.notEqual(apply('candidate.sql').status, 0, 'a second run must refuse');
    console.log('[prover] a ticket still linked to an order stops the apply; the candidate applies once (POSTFLIGHT_OK) and a second run is refused');
  } else {
    console.log('[prover] reused container: the candidate is already in, BEFORE and APPLY skipped');
  }
  assert.equal(scalar(`SELECT string_agg(p.proname || ':' || p.prosecdef || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
      || ':' || has_function_privilege('anon', p.oid, 'EXECUTE'), ',' ORDER BY p.proname) FROM pg_proc p
     WHERE p.oid IN ('public.create_order_from_blend_ticket(uuid,text,date,text,uuid,text)'::regprocedure,
       'public.link_blend_ticket_to_order(uuid,uuid,jsonb,uuid,text)'::regprocedure, 'public.unlink_blend_ticket_from_order(uuid,uuid,text)'::regprocedure);`),
    'create_order_from_blend_ticket:true:true:false,link_blend_ticket_to_order:true:true:false,unlink_blend_ticket_from_order:true:true:false',
    'the three RPCs must keep their security mode and grants');

  // 1. Each order-path RPC refuses first thing, as the office and as a driver, and changes nothing.
  for (const [label, call] of [['create order', createOrderCall(A, key())], ['link', linkCall(A, key())], ['unlink', unlinkCall(A, key())]]) {
    for (const who of ['', U.DRIVER]) {
      const r = committedCall(call, who);
      assert.match(r.error, DISABLED, `1: ${label}${who ? ' as a driver' : ''}: ${r.error}`);
      assert.ok(r.unchanged, `1: ${label}${who ? ' as a driver' : ''} left something behind (orders, lines, links, stock ledger, receipts, activity, audit, stock or ticket state)`);
    }
  }
  console.log('[prover] 1. create order from ticket, link and Unlink each refuse ("BLEND_TICKET_ORDERS_DISABLED ...") for the office and a driver, and leave no order, line, link, stock ledger row, retry receipt, activity, audit row, stock or ticket change');

  // 2. An exact replay of a success saved before the change refuses too, instead of answering the old success.
  if (KEYS.createF) {
    for (const [label, call] of [['create order', createOrderCall(T.F, KEYS.createF)], ['Unlink', unlinkCall(T.F, KEYS.unlinkF)],
      ['link', linkCall(T.G, KEYS.linkG)], ['Unlink', unlinkCall(T.G, KEYS.unlinkG)]]) {
      const r = committedCall(call);
      assert.match(r.error, DISABLED, `2: replay of a saved ${label} success: ${r.error}`);
      assert.ok(r.unchanged, `2: replay of a saved ${label} success changed something`);
    }
    console.log('[prover] 2. exact replays of saved create-order, link and Unlink successes refuse; none answers its old success');
  }

  // 3. The table guard alone: a direct link-row insert or update, and the old create-order impl, are refused.
  const ins = twoSteps('', directLink(A));
  assert.match(ins.second, DISABLED, `3: direct link-row insert: ${ins.second}`);
  const impl = twoSteps('', `PERFORM public._create_order_from_blend_ticket_replay_impl_20261015('${A}', 'PV93${RUN}-IMPL', DATE '2026-11-02', NULL, '${U.ADMIN}', '${key()}');`);
  assert.match(impl.second, DISABLED, `3: the old create-order impl: ${impl.second}`);
  const upd = docker([...psqlArgs('supabase_admin')], { input: `BEGIN;\nSET session_replication_role = replica;\n${directLink(A)}\nSET session_replication_role = origin;\nUPDATE public.blend_ticket_to_order_items SET notes = 'x' WHERE blend_ticket_id = '${A}';\nROLLBACK;`, allowFailure: true });
  assert.match(upd.stderr, DISABLED, `3: link-row update: ${upd.stderr}`);
  console.log('[prover] 3. a direct link-row insert or update, and the old internal create-order function, are refused by the table guard');

  // 4. A ticket cannot be marked linked by hand (the existing header lock refuses it without link rows).
  const hand = twoSteps('', `UPDATE public.blend_tickets SET order_link_status = 'linked' WHERE id = '${A}';`);
  assert.match(hand.second, /BLEND_TICKET_LINK_STATE_INVALID/, `4: hand-set linked status: ${hand.second}`);
  console.log(`[prover] 4. setting a ticket to linked by hand is refused: "${hand.second.slice(0, 80)}"`);

  // 5. The workflow that stays, on one ticket: application record -> stock out once -> a second is refused ->
  //    direct invoice; reversing puts the stock back.
  const base = scalar(`SELECT ${STOCK};`);
  const once = twoSteps(appRecord(A), appRecord(A));
  assert.match(once.second, /Application record\(s\) already exist for this blend ticket/, `5: second application record: ${once.second}`);
  assert.equal(onHand(once.stock), minus(base, 10), '5: the application record took stock more or less than once');
  const billed = twoSteps(appRecord(A), `PERFORM public.create_invoice_from_blend_ticket('${A}', '${U.ADMIN}', '${key()}');
    IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE blend_ticket_id = '${A}') THEN RAISE EXCEPTION 'NO_INVOICE'; END IF;`);
  assert.equal(billed.second, 'ALLOWED', `5: direct invoice of an applied ticket: ${billed.second}`);
  assert.equal(onHand(billed.stock), minus(base, 10), '5: invoicing moved stock');
  const reversed = twoSteps(appRecord(A), reverse(A));
  assert.equal(reversed.second, 'ALLOWED', `5: reversing the application record: ${reversed.second}`);
  assert.equal(onHand(reversed.stock), onHand(base), '5: reversal did not put the stock back');
  console.log(`[prover] 5. one ticket: application record takes 10 gal once (on hand ${onHand(base)} -> ${onHand(once.stock)}), a second is refused, a direct invoice works, reversing puts it back (${onHand(reversed.stock)})`);

  // MUTATION: without the table guard, a direct link-row insert succeeds again.
  const m = twoSteps('', directLink(A), 'DROP TRIGGER trigger_a_blend_ticket_orders_disabled ON public.blend_ticket_to_order_items;');
  assert.equal(m.second, 'ALLOWED', `MUTATION: still refused without the table guard: ${m.second}`);
  console.log('[prover] MUTATION: with the table guard dropped, a direct link-row insert goes through again');

  const after = chain(CHAIN);
  // This schema-only image's storage stub lacks live's grants, so the chain stops at its Storage
  // section, after every blend, order-path, Unlink and application-record step. Live runs it whole.
  assert.match(after, /permission denied for table objects/, `AFTER: the blend guards smoke chain fails before its Storage section: ${after}`);
  console.log('[prover] AFTER: the blend guards smoke chain passes every blend, order-path refusal and application-record step (it stops at the Storage section this image cannot emulate; live runs it whole: npm run smoke:live -- --spec create_blend_ticket)');
  console.log('BLEND_TICKETS_APPLICATION_RECORDS_ONLY_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
