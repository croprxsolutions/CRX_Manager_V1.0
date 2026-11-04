#!/usr/bin/env node
// Disposable, network-disabled real-schema proof for Fix delivery (20261106150000).
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a fresh throwaway container: no option points the seed (which commits rows) at an existing database.
const NAME = `crx-fix-delivery-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.argv.includes('--keep') || process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const VERBOSE = process.env.CRX_PROVER_VERBOSE === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261106150000_fix_delivery_one_screen.sql');
// Storage/photo files the container cannot replay; none touches billing (asserted in plan()).
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  // DATA-11 rewrites live rows only (every product gets one preferred link); nothing here bills.
  '20261105170000_data11_preferred_vendor_links.sql',
]);
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
  // Every earlier migration is applied live (ledger read 2026-11-03); the storage-only PARKED files are skipped.
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/CREATE.*FUNCTION.*(invoice|deliver)/i.test(lf(file)), `${name} changes a billing function`);
  }
  return before;
}
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs', '--with-live-rows'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  const files = plan();
  let replayed = 0;
  // Each ledger-only stem is ledgered once: when the replay reaches it or passes it, or at the end.
  const ledgered = new Set();
  const ledgerOnce = (only) => {
    if (ledgered.has(only)) return;
    ledger(path.basename(only, '.sql'));
    ledgered.add(only);
  };
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only <= base) ledgerOnce(only);
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
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
    if (replayed % 25 === 0) console.log(`[replay] ${replayed}: ${base}`);
  }
  for (const only of LEDGER_ONLY) ledgerOnce(only);
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const id = (n) => `7e330000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN=id(1), REP=id(2), CUSTOMER=id(3), PRODUCT=id(4);
const ORDER=id(10), LINE=id(11), DELIVERY=id(12), INV=id(13), COMM=id(14), ORDER_INV=id(15), RET=id(16), PAYOUT=id(17), LINE2=id(18), CM=id(19), ALLOC=id(20);
function asUser(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
    SELECT set_config('request.jwt.claim.sub', '${uid}', true); SET LOCAL ROLE authenticated;`;
}
function probe(sql) {
  const r=psql(`BEGIN; ${sql} SELECT 'PROBE_OK'; ROLLBACK;`, {allowFailure:true});
  return {ok:r.status===0, error:r.stderr, output:r.stdout};
}
function allowed(sql,label) { const r=probe(sql); assert.ok(r.ok,`${label}: ${r.error}`); console.log(`[allowed] ${label}`); }
function refused(sql,label,pattern) {
  const r=probe(sql); assert.ok(!r.ok,`${label} unexpectedly succeeded`);
  assert.match(r.error,pattern,`${label}: wrong refusal: ${r.error}`); console.log(`[refused] ${label}`);
}
// Runs as the table owner so the assertion reads the real rows, not what RLS lets the caller see.
function check(cond,msg) { return `RESET ROLE; DO $chk$ BEGIN IF NOT (${cond}) THEN RAISE EXCEPTION 'PROOF_FAIL: ${msg}'; END IF; END $chk$;`; }
// The token the admin's preview showed on the seeded state; a change after it makes the fix stale.
let TOKEN = '';
const fix = (key, reason='[PROVER] wrong amount', token=TOKEN) =>
  `${asUser(ADMIN)} SELECT public.fix_delivery('${DELIVERY}','${reason}','${token}','${key}');`;
const stock = `(SELECT quantity_available FROM public.inventory WHERE product_id='${PRODUCT}' AND location='Main Warehouse')`;

function seed() {
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY,user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid);
    GRANT ALL ON auth.refresh_tokens,auth.sessions TO postgres;`,{user:'supabase_admin'});
  psql(`BEGIN;
    INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
      ('${ADMIN}','fix-admin@example.invalid','{"full_name":"[PROVER] Admin","role":"admin"}'),
      ('${REP}','fix-rep@example.invalid','{"full_name":"[PROVER] Rep","role":"sales_rep"}');
    UPDATE public.profiles SET created_at=now()-interval '10 minutes' WHERE id IN ('${ADMIN}','${REP}');
    ${asUser(ADMIN)} RESET ROLE;
    INSERT INTO public.customers (id,farm_name,is_active,assigned_sales_rep) VALUES ('${CUSTOMER}','[PROVER] Fix Delivery',true,'${REP}');
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id,product_name,unit_size,current_cost,tier1_price,product_form,is_active) VALUES
      ('${PRODUCT}','[PROVER] Product','gal',6,10,'liquid',true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.inventory (product_id,location,quantity_available,quantity_prebooked) VALUES ('${PRODUCT}','Main Warehouse',100,0);
    SELECT set_config('app.crx_below_cost_operation','create_direct_order',true);
    INSERT INTO public.orders (id,order_number,customer_id,salesman_id,status,order_date) VALUES
      ('${ORDER}','PROVER-FIX-ORDER','${CUSTOMER}','${REP}','confirmed',CURRENT_DATE);
    INSERT INTO public.order_items (id,order_id,product_id,product_name,unit_size,price_per_unit,total_units_needed,quantity_delivered,total_price,cost_per_unit) VALUES
      ('${LINE}','${ORDER}','${PRODUCT}','[PROVER] Product','gal',10,10,10,100,6);
    -- Historical fixture only; real deliveries complete through the RPCs.
    ALTER TABLE public.deliveries DISABLE TRIGGER require_delivery_completion_evidence;
    INSERT INTO public.deliveries (id,delivery_number,order_id,customer_id,status,scheduled_date,signed_by,completed_at,created_by) VALUES
      ('${DELIVERY}','PROVER-FIX-DEL','${ORDER}','${CUSTOMER}','completed',CURRENT_DATE,'[PROVER]',now(),'${ADMIN}');
    ALTER TABLE public.deliveries ENABLE TRIGGER require_delivery_completion_evidence;
    ALTER TABLE public.delivery_items DISABLE TRIGGER enforce_delivery_items_parent_lock;
    INSERT INTO public.delivery_items (delivery_id,order_item_id,product_id,quantity,quantity_delivered,unit_size) VALUES ('${DELIVERY}','${LINE}','${PRODUCT}',10,10,'gal');
    ALTER TABLE public.delivery_items ENABLE TRIGGER enforce_delivery_items_parent_lock;
    INSERT INTO public.invoices (id,invoice_number,order_id,delivery_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id) VALUES
      ('${INV}','PROVER-FIX-I1','${ORDER}','${DELIVERY}','${CUSTOMER}','chemical_sale','draft',CURRENT_DATE,'${ADMIN}','${REP}');
    INSERT INTO public.invoice_items (invoice_id,product_id,order_item_id,description,quantity,unit_price_cents,extended_cents,cost_cents,unit_size)
      VALUES ('${INV}','${PRODUCT}','${LINE}','[PROVER] chemical',10,1000,10000,600,'gal');
    UPDATE public.invoices SET total_amount_cents=10000 WHERE id='${INV}';
    UPDATE public.invoices SET status='posted', posted_at=now() WHERE id='${INV}';
    INSERT INTO public.commissions (id,order_id,customer_id,recipient,recipient_user_id,split_percentage,commission_amount,order_profit,order_date,status)
      VALUES ('${COMM}','${ORDER}','${CUSTOMER}','[PROVER] Rep','${REP}',100,40,40,CURRENT_DATE,'pending');
    COMMIT;`);
  assert.equal(scalar(`SELECT status FROM public.invoices WHERE id='${INV}';`), 'posted', 'seed invoice must be posted');
  assert.equal(scalar(`SELECT role FROM public.profiles WHERE id='${ADMIN}';`), 'admin', 'seed admin role');
  console.log(`[prover] seeded: order ${scalar(`SELECT status FROM public.orders WHERE id='${ORDER}';`)}, stock ${scalar(`SELECT ${stock};`)}`);
}

function scenarios() {
  allowed(`${asUser(ADMIN)} CREATE TEMP TABLE pv ON COMMIT DROP AS SELECT public.preview_fix_delivery('${DELIVERY}') p;
    ${check(`(SELECT (p->>'can_fix')::boolean AND jsonb_array_length(p->'invoices')=1 AND p->'invoices'->0->>'action'='void' FROM pv)`, 'preview plans one invoice void')}`,
    'admin preview shows one invoice to void and no refusals');
  allowed(`RESET ROLE; ALTER TABLE public.delivery_items DISABLE TRIGGER USER;
    UPDATE public.delivery_items SET quantity=100 WHERE delivery_id='${DELIVERY}';
    ALTER TABLE public.delivery_items ENABLE TRIGGER USER;
    ${asUser(ADMIN)} CREATE TEMP TABLE pq ON COMMIT DROP AS SELECT public.preview_fix_delivery('${DELIVERY}') p;
    ${check(`(SELECT (p->'items'->0->>'quantity')::numeric=10 FROM pq)`, 'preview shows the delivered quantity')}`,
    'the preview shows the quantity that goes back into stock, not the planned one');
  refused(`${asUser(REP)} SELECT public.preview_fix_delivery('${DELIVERY}');`, 'a sales rep cannot preview a fix', /Admin access required/);
  refused(`${asUser(REP)} SELECT public.fix_delivery('${DELIVERY}','x','x','k-rep');`, 'a sales rep cannot fix a delivery', /Admin access required/);
  refused(`${asUser(ADMIN)} SELECT public.fix_delivery('${DELIVERY}','x','x',NULL);`, 'a key is required', /IDEMPOTENCY_KEY_REQUIRED/);
  refused(`${asUser(ADMIN)} SELECT public.fix_delivery('${DELIVERY}','  ','x','k-blank');`, 'a reason is required', /Reason is required/);
  refused(`${asUser(ADMIN)} SELECT public.fix_delivery('${DELIVERY}',E'\\r\\n\\t','x','k-blank-ws');`, 'a carriage-return, newline and tab reason counts as blank', /Reason is required/);
  refused(`${asUser(ADMIN)} SELECT public._fix_delivery_plan('${DELIVERY}');`, 'the plan helper is not callable by app roles', /permission denied/);

  // An ordinary void cancels a commission with no replacement: past months keep counting it, even next to
  // a different live commission for the same rep (a separate $10 is not a copy of the $40). Rolled back.
  allowed(`RESET ROLE; ALTER TABLE public.commissions DISABLE TRIGGER USER; UPDATE public.commissions SET status='cancelled' WHERE id='${COMM}';
    INSERT INTO public.commissions (order_id, customer_id, recipient, recipient_user_id, split_percentage, commission_amount, order_profit, order_date, season, order_number, customer_name, status)
      SELECT order_id, customer_id, recipient, recipient_user_id, split_percentage, 10, order_profit, order_date, season, order_number, customer_name, 'paid' FROM public.commissions WHERE id='${COMM}';
    ALTER TABLE public.commissions ENABLE TRIGGER USER;
    ${check(`(SELECT amount FROM public._get_bottom_line_pnl_cost_impl_20261019(CURRENT_DATE, CURRENT_DATE) WHERE line_item='Commissions')=50`, 'P&L keeps a cancelled commission nothing replaced')}
    ${asUser(ADMIN)} DO $m$ BEGIN IF (public.get_monthly_summary(CURRENT_DATE, CURRENT_DATE)->'commissions'->>'earned_cents')::bigint <> 5000 THEN RAISE EXCEPTION 'PROOF_FAIL: month-end dropped a cancelled commission nothing replaced'; END IF; END $m$;`,
    'a cancelled commission with no live copy still counts in past months, next to a different live one');
  const before = Number(scalar(`SELECT ${stock};`));
  allowed(`${fix('k-ok')}
    ${check(`(SELECT status FROM public.invoices WHERE id='${INV}')='voided'`, 'invoice voided')}
    ${check(`(SELECT status FROM public.deliveries WHERE id='${DELIVERY}')='voided'`, 'delivery voided')}
    ${check(`(SELECT quantity_delivered FROM public.order_items WHERE id='${LINE}')=0`, 'order line reopened')}
    ${check(`(SELECT status FROM public.orders WHERE id='${ORDER}')='confirmed'`, 'order back to confirmed')}
    ${check(`${stock}=${before + 10}`, 'stock restored once')}
    ${check(`(SELECT status FROM public.commissions WHERE id='${COMM}')='cancelled'`, 'old commission kept as cancelled history')}
    ${check(`(SELECT count(*) FROM public.commissions WHERE order_id='${ORDER}' AND status='pending' AND commission_amount=40 AND recipient_user_id='${REP}')=1`, 'rep keeps one pending commission')}
    ${check(`EXISTS (SELECT 1 FROM public.activity_feed WHERE event_type='delivery_fixed' AND related_entity_id='${DELIVERY}')`, 'activity recorded')}
    ${check(`(SELECT amount FROM public._get_bottom_line_pnl_cost_impl_20261019(CURRENT_DATE, CURRENT_DATE) WHERE line_item='Commissions')=40`, 'P&L counts the commission once')}
    ${asUser(ADMIN)} DO $m$ BEGIN IF (public.get_monthly_summary(CURRENT_DATE, CURRENT_DATE)->'commissions'->>'earned_cents')::bigint <> 4000 THEN RAISE EXCEPTION 'PROOF_FAIL: month-end counts the commission twice'; END IF; END $m$;`,
    'fix undoes invoice and delivery together, restores stock once, keeps the commission');

  allowed(`${fix('k-replay')} ${fix('k-replay')}
    ${check(`(SELECT count(*) FROM public.commissions WHERE order_id='${ORDER}' AND status='pending')=1`, 'replay did not add a second commission')}
    ${check(`${stock}=${before + 10}`, 'replay did not restore stock twice')}`,
    'an exact retry replays the stored result and changes nothing more');
  refused(`${fix('k-intent')} ${fix('k-intent','[PROVER] edited reason')}`, 'reusing a key with an edited reason is refused', /IDEMPOTENCY_INTENT_MISMATCH/);
  refused(fix('k-stale','[PROVER] wrong amount','not-the-preview'), 'a stale preview token is refused', /FIX_DELIVERY_PREVIEW_STALE/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER;
    INSERT INTO public.invoices (id,invoice_number,order_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id)
      VALUES ('${ORDER_INV}','PROVER-FIX-ORDER-DRAFT','${ORDER}','${CUSTOMER}','chemical_sale','draft',CURRENT_DATE,'${ADMIN}','${REP}');
    ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${fix('k-new-draft')}`, 'an order draft added after the preview makes it stale', /FIX_DELIVERY_PREVIEW_STALE/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER; UPDATE public.invoices SET total_amount_cents=20000 WHERE id='${INV}'; ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${fix('k-new-amount')}`, 'an invoice amount changed after the preview makes it stale', /FIX_DELIVERY_PREVIEW_STALE/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER; UPDATE public.invoices SET invoice_date=invoice_date - 1 WHERE id='${INV}'; ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${fix('k-new-date')}`, 'an invoice re-dated after the preview makes it stale', /FIX_DELIVERY_PREVIEW_STALE/);
  refused(`RESET ROLE; ALTER TABLE public.deliveries DISABLE TRIGGER USER; UPDATE public.deliveries SET completed_at=completed_at - interval '1 hour' WHERE id='${DELIVERY}'; ALTER TABLE public.deliveries ENABLE TRIGGER USER;
    ${fix('k-new-completed')}`, 'a delivery completion time changed after the preview makes it stale', /FIX_DELIVERY_PREVIEW_STALE/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER; UPDATE public.invoices SET credit_applied_cents=500 WHERE id='${INV}'; ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${fix('k-new-credit')}`, 'a credit applied after the preview makes it stale', /FIX_DELIVERY_PREVIEW_STALE/);
  refused(`RESET ROLE; SELECT set_config('app.crx_below_cost_operation','create_direct_order',true);
    INSERT INTO public.order_items (id,order_id,product_id,product_name,unit_size,price_per_unit,total_units_needed,quantity_delivered,total_price,cost_per_unit) VALUES
      ('${LINE2}','${ORDER}','${PRODUCT}','[PROVER] Product','gal',10,10,10,100,6);
    ALTER TABLE public.delivery_items DISABLE TRIGGER USER;
    UPDATE public.delivery_items SET order_item_id='${LINE2}' WHERE delivery_id='${DELIVERY}';
    ALTER TABLE public.delivery_items ENABLE TRIGGER USER;
    ${fix('k-moved-line')}`, 'a delivery line moved to another order line after the preview makes it stale', /FIX_DELIVERY_PREVIEW_STALE/);
  refused(`RESET ROLE; INSERT INTO public.orders (id,order_number,customer_id,salesman_id,status,order_date) VALUES
      (gen_random_uuid(),'PROVER-FIX-ORDER-B','${CUSTOMER}','${REP}','confirmed',CURRENT_DATE);
    ALTER TABLE public.deliveries DISABLE TRIGGER USER;
    UPDATE public.deliveries SET order_id=(SELECT id FROM public.orders WHERE order_number='PROVER-FIX-ORDER-B') WHERE id='${DELIVERY}';
    ALTER TABLE public.deliveries ENABLE TRIGGER USER;
    ${fix('k-moved-order')}`, 'a delivery moved to another order after the preview makes it stale', /FIX_DELIVERY_PREVIEW_STALE/);

  refused(`RESET ROLE; ALTER TABLE public.orders DISABLE TRIGGER USER; UPDATE public.orders SET status='voided' WHERE id='${ORDER}'; ALTER TABLE public.orders ENABLE TRIGGER USER;
    ${asUser(ADMIN)} SELECT public.fix_delivery('${DELIVERY}','[PROVER] wrong amount',(SELECT public.preview_fix_delivery('${DELIVERY}')->>'plan_token'),'k-order-voided');`,
    'a voided order refuses the fix', /FIX_DELIVERY_REFUSED: This delivery's order is voided/);
  refused(`RESET ROLE; ALTER TABLE public.orders DISABLE TRIGGER USER; UPDATE public.orders SET status='fulfilled' WHERE id='${ORDER}'; ALTER TABLE public.orders ENABLE TRIGGER USER;
    ${fix('k-order-status')}`, 'an order status change after the preview makes it stale', /FIX_DELIVERY_PREVIEW_STALE/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER; UPDATE public.invoices SET paid_amount_cents=100 WHERE id='${INV}'; ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${fix('k-paid')}`, 'a payment on the invoice refuses the fix', /FIX_DELIVERY_REFUSED: A payment is applied/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER; UPDATE public.invoices SET write_off_cents=500 WHERE id='${INV}'; ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${fix('k-write-off')}`, 'a write-off on the posted invoice refuses the fix', /FIX_DELIVERY_REFUSED: A write-off is recorded on this invoice/);
  refused(`RESET ROLE; ALTER TABLE public.write_offs DISABLE TRIGGER USER;
    INSERT INTO public.write_offs (invoice_id,customer_id,amount_cents,reason,approved_by,created_by) VALUES ('${INV}','${CUSTOMER}',500,'[PROVER]','${ADMIN}','${ADMIN}');
    ALTER TABLE public.write_offs ENABLE TRIGGER USER;
    ${fix('k-write-off-row')}`, 'an active write-off row refuses the fix', /FIX_DELIVERY_REFUSED: A write-off is recorded on this invoice/);
  refused(`RESET ROLE; ALTER TABLE public.deliveries DISABLE TRIGGER USER; UPDATE public.deliveries SET completed_at=now() - interval '40 days' WHERE id='${DELIVERY}'; ALTER TABLE public.deliveries ENABLE TRIGGER USER;
    ALTER TABLE public.accounting_periods DISABLE TRIGGER USER;
    INSERT INTO public.accounting_periods (period_start,period_end,status) VALUES
      (date_trunc('month',(now() - interval '40 days')::date)::date,(date_trunc('month',(now() - interval '40 days')::date)+interval '1 month - 1 day')::date,'closed');
    ALTER TABLE public.accounting_periods ENABLE TRIGGER USER;
    ${fix('k-closed-delivery')}`, 'a delivery completed in a closed month refuses the fix', /FIX_DELIVERY_REFUSED: This delivery was completed in a closed month/);
  refused(`RESET ROLE; ALTER TABLE public.deliveries DISABLE TRIGGER USER;
    UPDATE public.deliveries SET completed_at=(date_trunc('month',CURRENT_DATE)::timestamp AT TIME ZONE 'UTC') + interval '2 hours' WHERE id='${DELIVERY}';
    ALTER TABLE public.deliveries ENABLE TRIGGER USER;
    ALTER TABLE public.accounting_periods DISABLE TRIGGER USER;
    INSERT INTO public.accounting_periods (period_start,period_end,status) VALUES
      ((date_trunc('month',CURRENT_DATE) - interval '1 month')::date,(date_trunc('month',CURRENT_DATE) - interval '1 day')::date,'closed');
    ALTER TABLE public.accounting_periods ENABLE TRIGGER USER;
    ${fix('k-closed-chicago')}`, 'a 02:00 UTC completion on the 1st counts as the prior Chicago day, in a closed month', /FIX_DELIVERY_REFUSED: This delivery was completed in a closed month/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER; UPDATE public.invoices SET invoice_group_id=gen_random_uuid() WHERE id='${INV}'; ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${fix('k-split')}`, 'a split-group invoice refuses the fix', /FIX_DELIVERY_REFUSED: This delivery or its order has a split invoice/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER;
    INSERT INTO public.invoices (id,invoice_number,order_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id,invoice_group_id)
      VALUES ('${ORDER_INV}','PROVER-FIX-ORDER-SPLIT','${ORDER}','${CUSTOMER}','chemical_sale','draft',CURRENT_DATE,'${ADMIN}','${REP}',gen_random_uuid());
    ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${asUser(ADMIN)} SELECT public.fix_delivery('${DELIVERY}','[PROVER] wrong amount',(SELECT public.preview_fix_delivery('${DELIVERY}')->>'plan_token'),'k-order-split');`,
    'an order-level split draft refuses the fix', /FIX_DELIVERY_REFUSED: This delivery or its order has a split invoice/);
  allowed(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER;
    INSERT INTO public.invoices (id,invoice_number,order_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id)
      VALUES ('${ORDER_INV}','PROVER-FIX-ORDER-DRAFT2','${ORDER}','${CUSTOMER}','chemical_sale','draft',CURRENT_DATE,'${ADMIN}','${REP}');
    ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${asUser(ADMIN)} SELECT public.fix_delivery('${DELIVERY}','[PROVER] wrong amount',(SELECT public.preview_fix_delivery('${DELIVERY}')->>'plan_token'),'k-order-draft-count');
    ${check(`(SELECT status FROM public.invoices WHERE id='${ORDER_INV}')='cancelled'`, 'order draft cancelled')}
    ${check(`EXISTS (SELECT 1 FROM public.activity_feed WHERE event_type='delivery_fixed' AND related_entity_id='${DELIVERY}' AND description LIKE '%and cancelled 1 order draft invoice(s)%')`, 'activity counts the order draft')}`,
    'the activity entry counts the order draft the fix cancels');
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER;
    INSERT INTO public.invoices (id,invoice_number,order_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id,posted_at)
      VALUES ('${ORDER_INV}','PROVER-FIX-ORDER-INV','${ORDER}','${CUSTOMER}','chemical_sale','posted',CURRENT_DATE,'${ADMIN}','${REP}',now());
    ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${fix('k-order-inv')}`, 'an order-level posted invoice refuses the fix', /FIX_DELIVERY_REFUSED: This order is billed on one invoice/);
  // The delivery moves to last month (open) so only the invoice's closed month refuses.
  refused(`RESET ROLE; ALTER TABLE public.deliveries DISABLE TRIGGER USER; UPDATE public.deliveries SET completed_at=now() - interval '40 days' WHERE id='${DELIVERY}'; ALTER TABLE public.deliveries ENABLE TRIGGER USER;
    ALTER TABLE public.accounting_periods DISABLE TRIGGER USER;
    INSERT INTO public.accounting_periods (period_start,period_end,status) VALUES (date_trunc('month',CURRENT_DATE)::date,(date_trunc('month',CURRENT_DATE)+interval '1 month - 1 day')::date,'closed');
    ALTER TABLE public.accounting_periods ENABLE TRIGGER USER;
    ${fix('k-closed')}`, 'an invoice in a closed month refuses the fix', /FIX_DELIVERY_REFUSED: The invoice, or a credit applied to it, is dated in a closed month/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER;
    INSERT INTO public.invoices (id,invoice_number,order_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id,total_amount_cents,posted_at)
      VALUES ('${CM}','PROVER-FIX-CM','${ORDER}','${CUSTOMER}','credit_memo','posted',CURRENT_DATE - 40,'${ADMIN}','${REP}',-500,now());
    ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ALTER TABLE public.credit_memo_applications DISABLE TRIGGER USER;
    INSERT INTO public.credit_memo_applications (credit_memo_id,target_invoice_id,amount_cents,applied_by,applied_at)
      VALUES ('${CM}','${INV}',500,'${ADMIN}',now() - interval '40 days');
    ALTER TABLE public.credit_memo_applications ENABLE TRIGGER USER;
    ALTER TABLE public.accounting_periods DISABLE TRIGGER USER;
    INSERT INTO public.accounting_periods (period_start,period_end,status) VALUES
      (date_trunc('month',(now() - interval '40 days')::date)::date,(date_trunc('month',(now() - interval '40 days')::date)+interval '1 month - 1 day')::date,'closed');
    ALTER TABLE public.accounting_periods ENABLE TRIGGER USER;
    ${asUser(ADMIN)} CREATE TEMP TABLE pc ON COMMIT DROP AS SELECT public.preview_fix_delivery('${DELIVERY}') p;
    ${check(`(SELECT NOT (p->>'can_fix')::boolean FROM pc)`, 'the preview already refuses')}
    ${fix('k-closed-credit')}`, 'a credit applied to the invoice in a closed month refuses the fix at preview', /FIX_DELIVERY_REFUSED: The invoice, or a credit applied to it, is dated in a closed month/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER;
    INSERT INTO public.invoices (id,invoice_number,order_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id,total_amount_cents,posted_at)
      VALUES ('${CM}','PROVER-FIX-CM','${ORDER}','${CUSTOMER}','credit_memo','posted',CURRENT_DATE,'${ADMIN}','${REP}',-500,now());
    ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ALTER TABLE public.credit_memo_applications DISABLE TRIGGER USER;
    INSERT INTO public.credit_memo_applications (credit_memo_id,target_invoice_id,amount_cents,applied_by,applied_at)
      VALUES ('${CM}','${INV}',500,'${ADMIN}',(date_trunc('month',CURRENT_DATE)::timestamp AT TIME ZONE 'UTC') + interval '2 hours');
    ALTER TABLE public.credit_memo_applications ENABLE TRIGGER USER;
    ALTER TABLE public.accounting_periods DISABLE TRIGGER USER;
    INSERT INTO public.accounting_periods (period_start,period_end,status) VALUES
      ((date_trunc('month',CURRENT_DATE) - interval '1 month')::date,(date_trunc('month',CURRENT_DATE) - interval '1 day')::date,'closed');
    ALTER TABLE public.accounting_periods ENABLE TRIGGER USER;
    ${fix('k-closed-credit-chicago')}`, 'a credit applied 02:00 UTC on the 1st counts in the prior, closed Chicago month', /FIX_DELIVERY_REFUSED: The invoice, or a credit applied to it, is dated in a closed month/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER;
    INSERT INTO public.invoices (id,invoice_number,order_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id,total_amount_cents,prepay_applied_cents)
      VALUES ('${ORDER_INV}','PROVER-FIX-ORDER-DRAFT','${ORDER}','${CUSTOMER}','chemical_sale','draft',CURRENT_DATE,'${ADMIN}','${REP}',5000,2000);
    ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${fix('k-draft-money')}`, 'an order draft holding prepay refuses the fix', /FIX_DELIVERY_REFUSED: A draft or unposted invoice on this delivery or order has a payment/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER;
    INSERT INTO public.invoices (id,invoice_number,order_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id,total_amount_cents)
      VALUES ('${ORDER_INV}','PROVER-FIX-ORDER-DRAFT','${ORDER}','${CUSTOMER}','chemical_sale','draft',CURRENT_DATE,'${ADMIN}','${REP}',5000);
    ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ALTER TABLE public.write_offs DISABLE TRIGGER USER;
    INSERT INTO public.write_offs (invoice_id,customer_id,amount_cents,reason,approved_by,created_by) VALUES ('${ORDER_INV}','${CUSTOMER}',500,'[PROVER]','${ADMIN}','${ADMIN}');
    ALTER TABLE public.write_offs ENABLE TRIGGER USER;
    ${fix('k-draft-write-off-row')}`, 'an order draft with an active write-off row refuses the fix', /FIX_DELIVERY_REFUSED: A draft or unposted invoice on this delivery or order has a payment/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER;
    INSERT INTO public.invoices (id,invoice_number,order_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id,total_amount_cents)
      VALUES ('${ORDER_INV}','PROVER-FIX-ORDER-DRAFT','${ORDER}','${CUSTOMER}','chemical_sale','draft',CURRENT_DATE,'${ADMIN}','${REP}',5000);
    ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ALTER TABLE public.allocation_sets DISABLE TRIGGER USER; ALTER TABLE public.invoice_line_allocations DISABLE TRIGGER USER;
    INSERT INTO public.allocation_sets (id,entity_type,entity_id,is_active) VALUES ('${ALLOC}','payment',gen_random_uuid(),true);
    INSERT INTO public.invoice_line_allocations (allocation_set_id,invoice_id,bill_to_customer_id,split_percentage,amount_cents)
      VALUES ('${ALLOC}','${ORDER_INV}','${CUSTOMER}',100,1000);
    ALTER TABLE public.allocation_sets ENABLE TRIGGER USER; ALTER TABLE public.invoice_line_allocations ENABLE TRIGGER USER;
    ${fix('k-draft-alloc')}`, 'an order draft with an active payment allocation refuses the fix', /FIX_DELIVERY_REFUSED: A draft or unposted invoice on this delivery or order has a payment/);
  refused(`RESET ROLE; ALTER TABLE public.invoices DISABLE TRIGGER USER; UPDATE public.invoices SET status='draft', posted_at=NULL, prepay_applied_cents=2000 WHERE id='${INV}'; ALTER TABLE public.invoices ENABLE TRIGGER USER;
    ${fix('k-own-draft-money')}`, "the delivery's own draft invoice holding prepay refuses the fix", /FIX_DELIVERY_REFUSED: A draft or unposted invoice on this delivery or order has a payment/);
  refused(`RESET ROLE; INSERT INTO public.idempotency_keys (idempotency_key,operation,result)
      VALUES ('k-pre-used:void_invoice:${INV}','void_invoice','{"success":true}');
    ${fix('k-pre-used')}`,
    'an inner invoice key already used by another request refuses the fix', /IDEMPOTENCY_INTENT_MISMATCH/);
  refused(`RESET ROLE; INSERT INTO public.idempotency_keys (idempotency_key,operation,result)
      VALUES ('k-pre-used-del:void_delivery','void_delivery','{"success":true}');
    ${fix('k-pre-used-del')}`,
    'an inner delivery key already used by another request refuses the fix', /IDEMPOTENCY_INTENT_MISMATCH/);
  refused(`RESET ROLE; ALTER TABLE public.delivery_external_billings DISABLE TRIGGER USER;
    INSERT INTO public.delivery_external_billings (delivery_id,reason) VALUES ('${DELIVERY}','[PROVER] billed in Chem Man');
    ALTER TABLE public.delivery_external_billings ENABLE TRIGGER USER;
    ${fix('k-external')}`, 'a delivery billed outside CRX refuses the fix', /FIX_DELIVERY_REFUSED: This delivery was billed outside CRX/);
  refused(`RESET ROLE; ALTER TABLE public.returns DISABLE TRIGGER USER; ALTER TABLE public.return_items DISABLE TRIGGER USER;
    INSERT INTO public.returns (id,return_number,customer_id,order_id,status,requested_by) VALUES ('${RET}','PROVER-FIX-RET','${CUSTOMER}','${ORDER}','requested','${ADMIN}');
    INSERT INTO public.return_items (return_id,product_id,order_item_id,quantity) VALUES ('${RET}','${PRODUCT}','${LINE}',1);
    ALTER TABLE public.returns ENABLE TRIGGER USER; ALTER TABLE public.return_items ENABLE TRIGGER USER;
    ${fix('k-return')}`, 'an open return on the delivery refuses the fix', /FIX_DELIVERY_REFUSED: A return is open or done on this delivery/);
  refused(`RESET ROLE; ALTER TABLE public.commission_payments DISABLE TRIGGER USER; ALTER TABLE public.commission_payment_items DISABLE TRIGGER USER;
    INSERT INTO public.commission_payments (id,payment_number,recipient_id,total_amount) VALUES ('${PAYOUT}','PROVER-FIX-PAY','${REP}',40);
    INSERT INTO public.commission_payment_items (commission_payment_id,commission_id,amount) VALUES ('${PAYOUT}','${COMM}',40);
    ALTER TABLE public.commission_payments ENABLE TRIGGER USER; ALTER TABLE public.commission_payment_items ENABLE TRIGGER USER;
    ${fix('k-payout')}`, 'a commission already in a payout batch refuses the fix', /FIX_DELIVERY_REFUSED: This order's commission is in a payout batch/);
  refused(`RESET ROLE; ALTER TABLE public.commissions DISABLE TRIGGER USER; UPDATE public.commissions SET recipient_user_id=NULL WHERE id='${COMM}'; ALTER TABLE public.commissions ENABLE TRIGGER USER;
    ${fix('k-norep')}`, 'a commission with no linked rep user refuses the fix', /FIX_DELIVERY_REFUSED: This order's commission has no sales rep user linked/);

  // All or nothing: if the delivery step fails after the invoice void, the invoice void is undone too.
  allowed(`RESET ROLE; CREATE FUNCTION public.prover_boom() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN RAISE EXCEPTION 'PROVER_BOOM'; END $b$;
    CREATE TRIGGER prover_boom BEFORE UPDATE OF status ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.prover_boom();
    ${asUser(ADMIN)} DO $d$ BEGIN
      PERFORM public.fix_delivery('${DELIVERY}','[PROVER] wrong amount','${TOKEN}','k-boom');
      RAISE EXCEPTION 'PROOF_FAIL: fix succeeded despite the delivery failure';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%PROVER_BOOM%' THEN RAISE; END IF; END $d$;
    ${check(`(SELECT status FROM public.invoices WHERE id='${INV}')='posted'`, 'invoice stayed posted after the failed fix')}
    ${check(`(SELECT status FROM public.commissions WHERE id='${COMM}')='pending'`, 'commission untouched after the failed fix')}`,
    'a failure in the delivery step rolls back the invoice void (all or nothing)');

  // Lost response: the fix commits, then the browser retries the same key in a new transaction. Last,
  // because it keeps the fixed state.
  const committedBefore = Number(scalar(`SELECT ${stock};`));
  psql(`BEGIN; ${fix('k-committed')} COMMIT;`);
  allowed(`${fix('k-committed')}
    ${check(`(SELECT count(*) FROM public.commissions WHERE order_id='${ORDER}' AND status='pending')=1`, 'committed retry did not add a second commission')}
    ${check(`${stock}=${committedBefore + 10}`, 'committed retry did not restore stock twice')}
    ${check(`(SELECT status FROM public.invoices WHERE id='${INV}')='voided'`, 'invoice stays voided')}`,
    'a retry after the fix committed replays the stored result and changes nothing more');
  // The re-entered delivery's invoice is voided later too, cancelling the copy: still counted once.
  allowed(`RESET ROLE; ALTER TABLE public.commissions DISABLE TRIGGER USER; UPDATE public.commissions SET status='cancelled' WHERE order_id='${ORDER}';
    ALTER TABLE public.commissions ENABLE TRIGGER USER;
    ${check(`(SELECT count(*) FROM public.commissions WHERE order_id='${ORDER}' AND status='cancelled')=2`, 'original and copy both cancelled')}
    ${check(`(SELECT amount FROM public._get_bottom_line_pnl_cost_impl_20261019(CURRENT_DATE, CURRENT_DATE) WHERE line_item='Commissions')=40`, 'P&L counts a cancelled original and cancelled copy once')}
    ${asUser(ADMIN)} DO $m$ BEGIN IF (public.get_monthly_summary(CURRENT_DATE, CURRENT_DATE)->'commissions'->>'earned_cents')::bigint <> 4000 THEN RAISE EXCEPTION 'PROOF_FAIL: month-end counts a cancelled original and copy twice'; END IF; END $m$;`,
    'when the copy is cancelled later too, the commission still counts once');
  // Editing the reopened order recalculates the pending copy's amount: the original stays replaced.
  allowed(`RESET ROLE;
    ${check(`(SELECT count(*) FROM public.commissions WHERE order_id='${ORDER}' AND replaces_commission_id='${COMM}' AND status='pending')=1`, 'the copy names the original it replaces')}
    ALTER TABLE public.commissions DISABLE TRIGGER USER; UPDATE public.commissions SET commission_amount=30 WHERE replaces_commission_id='${COMM}';
    ALTER TABLE public.commissions ENABLE TRIGGER USER;
    ${check(`(SELECT amount FROM public._get_bottom_line_pnl_cost_impl_20261019(CURRENT_DATE, CURRENT_DATE) WHERE line_item='Commissions')=30`, 'P&L counts only the edited copy')}
    ${asUser(ADMIN)} DO $m$ BEGIN IF (public.get_monthly_summary(CURRENT_DATE, CURRENT_DATE)->'commissions'->>'earned_cents')::bigint <> 3000 THEN RAISE EXCEPTION 'PROOF_FAIL: month-end counts the original again after an order edit'; END IF; END $m$;`,
    'an order edit that changes the copy\'s amount does not make the original count again');
}

try {
  buildContainer();
  stageText('candidate.sql', lf(CANDIDATE)); const r = apply('candidate.sql');
  if (r.status !== 0) throw new Error(`candidate apply failed:\n${r.output}`);
  console.log('[prover] candidate applied');
  seed();
  TOKEN = scalar(`SELECT public._fix_delivery_plan('${DELIVERY}')->>'plan_token';`);
  assert.match(TOKEN, /^[0-9a-f]{32}$/, 'the preview carries a plan token');
  scenarios();
  console.log('[prover] PASS: fix_delivery real-schema proof');
} finally {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
  else console.log(`[prover] kept container ${NAME}`);
}

