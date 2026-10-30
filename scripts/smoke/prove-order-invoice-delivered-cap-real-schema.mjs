#!/usr/bin/env node
// Disposable, network-disabled real-schema proof for Goal 3 quantity caps.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const reuseIndex = process.argv.indexOf('--reuse');
const reusedContainer = reuseIndex >= 0 ? process.argv[reuseIndex + 1] : process.env.CRX_PROVER_REUSE_CONTAINER;
const NAME = reusedContainer || `crx-order-cap-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(reusedContainer);
const KEEP = process.argv.includes('--keep') || process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const VERBOSE = process.env.CRX_PROVER_VERBOSE === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261029160000_cap_order_invoices_at_delivered.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
// A later or parked file that (re)defines anything the candidate replaces or relies on.
const TOUCHED = /invoice_items|invoices|deliveries|delivery_items|order_items/i;
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
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  const before = all.slice(0, at);
  for (const file of all.slice(at + 1)) {
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches what it changes; re-think this proof`);
  }
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
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
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

const id = (n) => `7e320000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN=id(1), REP=id(2), CUSTOMER=id(3), PRODUCT=id(4), OTHER=id(5);
const ORDER=id(10), LINE=id(11), DELIVERY=id(12), INV=id(13), SIBLING=id(14);
const EMPTY_ORDER=id(20), EMPTY_LINE=id(21);
const CAP_ERROR=/ORDER_INVOICE_EXCEEDS_DELIVERED/;
const LINE_INVALID=/ORDER_INVOICE_LINE_INVALID/;
function asUser(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
    SELECT set_config('request.jwt.claim.sub', '${uid}', true); SET LOCAL ROLE authenticated;`;
}
function probe(sql) {
  const r=psql(`BEGIN; ${sql} SELECT 'PROBE_OK'; ROLLBACK;`, {allowFailure:true});
  return {ok:r.status===0, error:r.stderr, output:r.stdout};
}
function allowed(sql,label) { const r=probe(sql); assert.ok(r.ok,`${label}: ${r.error}`); console.log(`[allowed] ${label}`); }
function refused(sql,label,pattern=CAP_ERROR) {
  const r=probe(sql); assert.ok(!r.ok,`${label} unexpectedly succeeded`);
  assert.match(r.error,pattern,`${label}: wrong refusal: ${r.error}`); console.log(`[refused] ${label}`);
}
function insertLine(invoice,qty,product=PRODUCT,line=LINE) {
  return `INSERT INTO public.invoice_items (invoice_id,product_id,order_item_id,description,quantity,unit_price_cents,extended_cents,cost_cents,unit_size)
    VALUES ('${invoice}','${product}',${line ? `'${line}'` : 'NULL'},'[PROVER] chemical',${qty},1000,round((${qty})*1000),600,'gal');`;
}
function save(invoice,qty,uid) {
  return `CREATE TEMP TABLE args ON COMMIT DROP AS SELECT
    jsonb_build_object('id',i.id,'customer_id',i.customer_id,'invoice_type',i.invoice_type,'order_id',i.order_id,'delivery_id',i.delivery_id,'invoice_date',i.invoice_date::text) inv,
    (SELECT jsonb_agg(jsonb_build_object('id',ii.id,'order_item_id',ii.order_item_id,'product_id',ii.product_id,'description',ii.description,
      'quantity',${qty},'unit_price_cents',ii.unit_price_cents,'extended_cents',round((${qty})*ii.unit_price_cents),'cost_cents',ii.cost_cents,'sort_order',ii.sort_order,'unit_size',ii.unit_size))
      FROM public.invoice_items ii WHERE ii.invoice_id=i.id) items FROM public.invoices i WHERE i.id='${invoice}';
    GRANT SELECT ON args TO authenticated; ${asUser(uid)} SELECT public.save_invoice(inv,items,gen_random_uuid()::text) FROM args;`;
}
function seed() {
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY,user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid);
    GRANT ALL ON auth.refresh_tokens,auth.sessions TO postgres;`,{user:'supabase_admin'});
  psql(`BEGIN;
    INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
      ('${ADMIN}','order-cap-admin@example.invalid','{"full_name":"[PROVER] Admin","role":"admin"}'),
      ('${REP}','order-cap-rep@example.invalid','{"full_name":"[PROVER] Rep","role":"sales_rep"}');
    UPDATE public.profiles SET created_at=now()-interval '10 minutes' WHERE id IN ('${ADMIN}','${REP}');
    ${asUser(ADMIN)} RESET ROLE;
    INSERT INTO public.customers (id,farm_name,is_active,assigned_sales_rep) VALUES ('${CUSTOMER}','[PROVER] Order Cap',true,'${REP}');
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id,product_name,unit_size,current_cost,tier1_price,product_form,is_active) VALUES
      ('${PRODUCT}','[PROVER] Product','gal',6,10,'liquid',true),('${OTHER}','[PROVER] Other','gal',6,10,'liquid',true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    SELECT set_config('app.crx_below_cost_operation','create_direct_order',true);
    INSERT INTO public.orders (id,order_number,customer_id,salesman_id,status,order_date) VALUES
      ('${ORDER}','PROVER-ORDER-CAP','${CUSTOMER}','${REP}','confirmed',CURRENT_DATE),
      ('${EMPTY_ORDER}','PROVER-ORDER-EMPTY','${CUSTOMER}','${REP}','confirmed',CURRENT_DATE);
    INSERT INTO public.order_items (id,order_id,product_id,product_name,unit_size,price_per_unit,total_units_needed,quantity_delivered,total_price,cost_per_unit) VALUES
      ('${LINE}','${ORDER}','${PRODUCT}','[PROVER] Product','gal',10,10,6,100,6),
      ('${EMPTY_LINE}','${EMPTY_ORDER}','${PRODUCT}','[PROVER] Product','gal',10,10,0,100,6);
    -- Historical fixture only; the separate pipeline proof completes new deliveries through RPCs.
    ALTER TABLE public.deliveries DISABLE TRIGGER require_delivery_completion_evidence;
    INSERT INTO public.deliveries (id,delivery_number,order_id,customer_id,status,scheduled_date,signed_by,completed_at,created_by) VALUES
      ('${DELIVERY}','PROVER-CAP-DELIVERED','${ORDER}','${CUSTOMER}','completed',CURRENT_DATE,'[PROVER]',now(),'${ADMIN}');
    ALTER TABLE public.deliveries ENABLE TRIGGER require_delivery_completion_evidence;
    ALTER TABLE public.delivery_items DISABLE TRIGGER enforce_delivery_items_parent_lock;
    INSERT INTO public.delivery_items (delivery_id,order_item_id,product_id,quantity,quantity_delivered,unit_size) VALUES ('${DELIVERY}','${LINE}','${PRODUCT}',10,6,'gal');
    ALTER TABLE public.delivery_items ENABLE TRIGGER enforce_delivery_items_parent_lock;
    INSERT INTO public.invoices (id,invoice_number,order_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id) VALUES
      ('${INV}','PROVER-ORDER-I1','${ORDER}','${CUSTOMER}','chemical_sale','draft',CURRENT_DATE,'${ADMIN}','${REP}'),
      ('${SIBLING}','PROVER-ORDER-I2','${ORDER}','${CUSTOMER}','chemical_sale','draft',CURRENT_DATE,'${ADMIN}','${REP}');
    ${insertLine(INV,4)} UPDATE public.invoices SET total_amount_cents=4000 WHERE id='${INV}'; COMMIT;`);
}
// Owner decision 2026-10-29: a delivery with an active posted invoice cannot be voided or
// cancelled until that invoice is voided. Every case runs inside a rolled-back probe.
const SCHED=id(15), SCHED_INV=id(16), OTHER_DELIVERY=id(17);
const POSTED_REFUSAL=/DELIVERY_HAS_POSTED_INVOICE/;
function voidDelivery(uid=ADMIN) {
  return `${asUser(uid)} SELECT public.void_delivery('${DELIVERY}','[PROVER] invoice-first proof',NULL,gen_random_uuid()::text);`;
}
function cancelScheduled(uid=ADMIN) {
  return `${asUser(uid)} SELECT public.cancel_delivery('${SCHED}','[PROVER] invoice-first proof',NULL,gen_random_uuid()::text);`;
}
// Cancel cases use the empty order: the main order already carries whole-order invoices,
// which the existing overlap guard would refuse beside a delivery-linked invoice.
function scheduledDelivery(invoiceStatus,link='self') {
  const target = link==='self' ? SCHED : link==='other' ? OTHER_DELIVERY : null;
  return `RESET ROLE;
    INSERT INTO public.deliveries (id,delivery_number,order_id,customer_id,status,scheduled_date,created_by)
      VALUES ('${SCHED}','PROVER-CAP-SCHEDULED','${EMPTY_ORDER}','${CUSTOMER}','scheduled',CURRENT_DATE,'${ADMIN}'),
             ('${OTHER_DELIVERY}','PROVER-CAP-OTHER','${EMPTY_ORDER}','${CUSTOMER}','scheduled',CURRENT_DATE,'${ADMIN}');
    INSERT INTO public.invoices (id,invoice_number,order_id,delivery_id,customer_id,invoice_type,status,invoice_date,created_by,salesman_id,posted_at)
      VALUES ('${SCHED_INV}','PROVER-ORDER-I3','${EMPTY_ORDER}',${target ? `'${target}'` : 'NULL'},'${CUSTOMER}','chemical_sale','draft',CURRENT_DATE,'${ADMIN}','${REP}',NULL);
    ${invoiceStatus==='draft' ? '' : `ALTER TABLE public.invoices DISABLE TRIGGER zz_cap_delivery_invoice_header; -- legacy shape: posted before completion
      UPDATE public.invoices SET status='${invoiceStatus}', posted_at=now() WHERE id='${SCHED_INV}';
      ALTER TABLE public.invoices ENABLE TRIGGER zz_cap_delivery_invoice_header;`}`;
}
function invoiceFirst() {
  const post=`RESET ROLE; UPDATE public.invoices SET status='posted', posted_at=now() WHERE id='${INV}';`;
  refused(`${post} ${voidDelivery()}`,'void_delivery refuses while an order-level posted invoice is active',POSTED_REFUSAL);
  refused(`${post} ${asUser(ADMIN)} SELECT public.cancel_delivery('${DELIVERY}','[PROVER] invoice-first proof',NULL,gen_random_uuid()::text);`,'cancel_delivery refuses a completed delivery while a posted invoice is active',POSTED_REFUSAL);
  for (const status of ['paid','overdue']) {
    refused(`RESET ROLE; UPDATE public.invoices SET status='posted', posted_at=now() WHERE id='${INV}'; UPDATE public.invoices SET status='${status}' WHERE id='${INV}'; ${voidDelivery()}`,`void_delivery refuses a ${status} invoice`,POSTED_REFUSAL);
  }
  allowed(`${post} RESET ROLE; UPDATE public.invoices SET status='voided', posted_at=coalesce(posted_at,now()), void_reason='[PROVER] invoice first' WHERE id='${INV}'; ${voidDelivery()}`,'void_delivery proceeds once the invoice is voided');
  allowed(voidDelivery(),'void_delivery still proceeds with only draft invoices (they are cancelled)');
  allowed(`${scheduledDelivery('draft')} ${cancelScheduled()}`,'cancel_delivery proceeds with only its own draft invoice');
  refused(`${scheduledDelivery('posted')} ${cancelScheduled()}`,'cancel_delivery refuses while its posted invoice is active',POSTED_REFUSAL);
  allowed(`${scheduledDelivery('posted')} RESET ROLE; UPDATE public.invoices SET status='voided', posted_at=coalesce(posted_at,now()), void_reason='[PROVER] invoice first' WHERE id='${SCHED_INV}'; ${cancelScheduled()}`,'cancel_delivery proceeds once its invoice is voided');
  allowed(`${scheduledDelivery('posted','none')} ${cancelScheduled()}`,'cancel of a never-completed delivery ignores an unlinked order-level posted invoice');
  allowed(`${scheduledDelivery('posted','other')} ${cancelScheduled()}`,'cancel ignores a posted invoice linked to a different delivery');
  allowed(`RESET ROLE; ALTER TABLE public.deliveries DISABLE TRIGGER zz_delivery_void_needs_invoice_void;
    UPDATE public.invoices SET status='posted', posted_at=now() WHERE id='${INV}'; ${voidDelivery()}`,'MUTATION: disabling the delivery trigger permits void with a posted invoice');
}
async function race() {
  const run=(sql)=>{
    const child=spawn('docker',[...psqlArgs(),'-A','-t'],{cwd:ROOT}); let out='',err='';
    child.stdout.on('data',(d)=>{out+=d;}); child.stderr.on('data',(d)=>{err+=d;}); child.stdin.end(sql);
    return {out:()=>out,done:new Promise((resolve)=>child.on('close',(code)=>resolve({code,err})))};
  };
  const a=run(`BEGIN; ${insertLine(SIBLING,2)} SELECT 'A_READY'; SELECT pg_sleep(3); COMMIT;`);
  for(let i=0;!a.out().includes('A_READY');i++) { assert.ok(i<300,'writer A never reached overlap'); await new Promise((resolve)=>setTimeout(resolve,100)); }
  const b=run(`BEGIN; ${insertLine(INV,2,PRODUCT,null)} COMMIT;`);
  const [ar,br]=await Promise.all([a.done,b.done]); assert.equal(ar.code,0,ar.err); assert.notEqual(br.code,0);
  assert.match(br.err,/ORDER_INVOICE_EXCEEDS_DELIVERED|ORDER_LIFECYCLE_BUSY_RETRY/);
  refused(insertLine(INV,2,PRODUCT,null),'racing writer retry sees committed reservation');
  assert.equal(scalar(`SELECT sum(ii.quantity) FROM public.invoice_items ii JOIN public.invoices i ON i.id=ii.invoice_id WHERE i.order_id='${ORDER}';`),'6.0000');
  console.log('[race] exactly one writer committed; billing stayed at six delivered units');

  // Exercise the actual editor RPCs on different invoices. Either save alone fits
  // six units (4+1 or 3+3); together they would bill seven.
  psql(`${asUser(ADMIN)} RESET ROLE;
    UPDATE public.invoice_items SET quantity=3 WHERE invoice_id='${INV}';
    UPDATE public.invoice_items SET quantity=1 WHERE invoice_id='${SIBLING}';`);
  const sa=run(`BEGIN; ${save(INV,4,ADMIN)} SELECT 'A_READY'; SELECT pg_sleep(3); COMMIT;`);
  for(let i=0;!sa.out().includes('A_READY');i++) { assert.ok(i<300,'save A never reached overlap'); await new Promise((resolve)=>setTimeout(resolve,100)); }
  const sb=run(`BEGIN; ${save(SIBLING,3,REP)} COMMIT;`);
  const [sar,sbr]=await Promise.all([sa.done,sb.done]); assert.equal(sar.code,0,sar.err); assert.notEqual(sbr.code,0);
  assert.match(sbr.err,/ORDER_INVOICE_EXCEEDS_DELIVERED|ORDER_LIFECYCLE_BUSY_RETRY/);
  refused(save(SIBLING,3,REP),'racing save retry sees committed reservation');
  assert.equal(scalar(`SELECT sum(ii.quantity) FROM public.invoice_items ii JOIN public.invoices i ON i.id=ii.invoice_id WHERE i.order_id='${ORDER}';`),'5.0000');
  console.log('[race] concurrent real save_invoice calls cannot overbill; retry is capped');
}
async function main() {
  if(!REUSE) buildContainer();
  if(process.env.CRX_PROVER_BUILD_ONLY==='1') {console.log(`[built] ${NAME}`);return;}
  if (!process.argv.includes('--after')) {
    seed();
    allowed(`${asUser(ADMIN)} SELECT public.create_invoice_from_order('${EMPTY_ORDER}','${ADMIN}','chemical_sale','before-cap');`,'BEFORE: undelivered order reproduces gap');
  } else {
    psql(`${asUser(ADMIN)} RESET ROLE;
      DELETE FROM public.invoice_items WHERE invoice_id='${SIBLING}';
      UPDATE public.invoice_items SET quantity=4 WHERE invoice_id='${INV}';
      UPDATE public.invoices SET salesman_id='${REP}' WHERE id IN ('${INV}','${SIBLING}');`);
  }
  stageText('candidate.sql',lf(CANDIDATE));
  let applied=apply('candidate.sql'); assert.equal(applied.status,0,applied.output);
  applied=apply('candidate.sql'); assert.equal(applied.status,0,applied.output);
  for(const user of [ADMIN,REP]) {
    refused(`${asUser(user)} SELECT public.create_invoice_from_order('${EMPTY_ORDER}','${user}','chemical_sale',gen_random_uuid()::text);`,'undelivered order RPC');
    allowed(save(INV,4,user),'real save_invoice keeps delivered quantity');
    refused(save(INV,7,user),'real save_invoice refuses excess quantity');
  }
  allowed(insertLine(SIBLING,2),'second invoice uses remainder');
  refused(insertLine(SIBLING,3),'sibling invoices exceed delivered total');
  allowed(`${insertLine(SIBLING,2)} UPDATE public.invoice_items SET quantity=2.0005 WHERE invoice_id='${SIBLING}' AND product_id='${PRODUCT}';`,'rounding slack: 4-place split shares may exceed delivered by under 0.001');
  refused(`${insertLine(SIBLING,2)} UPDATE public.invoice_items SET quantity=2.002 WHERE invoice_id='${SIBLING}' AND product_id='${PRODUCT}';`,'rounding slack does not allow a real excess');
  refused(insertLine(INV,3,PRODUCT,null),'unlinked duplicate counts');
  refused(insertLine(SIBLING,1,OTHER,null),'added undelivered product');
  refused(`INSERT INTO public.invoice_items (invoice_id,order_item_id,description,quantity,unit_price_cents,extended_cents,cost_cents)
    VALUES ('${SIBLING}','${LINE}','[PROVER] malformed product',100,1000,100000,0);`,'order-linked product identity is required',LINE_INVALID);
  allowed(`INSERT INTO public.invoice_items (invoice_id,description,quantity,unit_price_cents,extended_cents,cost_cents,charge_type)
    VALUES ('${SIBLING}','[PROVER] Freight',1,1000,1000,0,'freight');`,'non-product charge still allowed');
  for (const user of [ADMIN,REP]) {
    refused(`${asUser(user)} SELECT public.save_invoice(
      jsonb_build_object('customer_id','${CUSTOMER}','order_id','${EMPTY_ORDER}','invoice_type','chemical_sale','invoice_date',CURRENT_DATE::text),
      jsonb_build_array(jsonb_build_object('description','[PROVER] untyped sale','quantity',10,'unit_price_cents',1000,'extended_cents',10000)),
      gen_random_uuid()::text);`,'real save_invoice requires explicit non-product charge type',LINE_INVALID);
  }
  refused(`INSERT INTO public.invoice_items (invoice_id,description,quantity,unit_price_cents,extended_cents,cost_cents,charge_type)
    VALUES ('${SIBLING}','[PROVER] Freight',1,1000,1000,0,'freight');
    UPDATE public.invoice_items SET charge_type=NULL WHERE invoice_id='${SIBLING}';`,'charge type cannot be cleared',LINE_INVALID);
  refused(insertLine(SIBLING,-1),'negative sale cannot offset billing',LINE_INVALID);
  allowed(`UPDATE public.invoice_items SET quantity=3 WHERE invoice_id='${INV}';`,'lower quantity');
  allowed(`UPDATE public.invoice_items SET unit_price_cents=1100 WHERE invoice_id='${INV}';`,'price-only edit');
  invoiceFirst();
  refused(`ALTER TABLE public.invoice_items DISABLE TRIGGER zz_cap_order_invoice_items;
    ${insertLine(SIBLING,3)} ALTER TABLE public.invoice_items ENABLE TRIGGER zz_cap_order_invoice_items;
    ${asUser(ADMIN)} SELECT public.post_invoice('${SIBLING}',public.invoice_postable_version(v),gen_random_uuid()::text)
      FROM public.invoices_postable v WHERE v.id='${SIBLING}';`,'posting rechecks imported excess');
  refused(`UPDATE public.invoices SET deleted_at=now() WHERE id='${SIBLING}'; ${insertLine(SIBLING,3)}
    UPDATE public.invoices SET deleted_at=NULL WHERE id='${SIBLING}';`,'restore rechecks aggregate');
  allowed(`ALTER TABLE public.invoice_items DISABLE TRIGGER zz_cap_order_invoice_items; ${insertLine(SIBLING,3)}`,'MUTATION: disabling item trigger permits excess');
  allowed(lf(path.join(ROOT,'scripts/smoke/smoke-order-invoice-delivered-cap-pipeline.sql')),'full split, return-credit and quick-delivery pipeline');
  await race(); console.log('ORDER_INVOICE_DELIVERED_CAP_PROOF_PASS');
}
try {await main();} finally {if(!KEEP) docker(['rm','-f',NAME],{allowFailure:true}); else console.log(`[kept] ${NAME}`);}


