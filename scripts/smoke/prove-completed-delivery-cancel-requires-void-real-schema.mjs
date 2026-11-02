#!/usr/bin/env node
/**
 * Full-chain proof for 20261102140000_completed_delivery_cancel_requires_void.
 *
 * Builds the checked-in production baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every ordered post-baseline migration up to the candidate (whose preflight pins both live
 * bodies, owner, grants and settings), seeds an admin, a rep, an order with one scheduled, one
 * in-progress and two completed deliveries (each completion writes its draft invoice), and a quick
 * delivery on its own order, then runs one rolled-back matrix BEFORE and AFTER the candidate:
 *   - an admin or a rep cancelling a completed delivery through the public RPC (as an old offline or
 *     stale request would) is refused with DELIVERY_COMPLETED_USE_VOID, and no stock, stock movement,
 *     invoice, delivery, order or order line changes (before: it was cancelled and the stock put back);
 *   - a mixed batch skips the completed delivery and cancels the others; a stale batch of only a
 *     completed delivery cancels nothing (before: both cancelled it);
 *   - scheduled, in-progress and quick-delivery cancels, a same-key replay, an already-cancelled
 *     refusal and a forged actor answer exactly as before;
 *   - a receipt stored BEFORE the candidate for a completed delivery's cancel still replays the same
 *     success afterwards and changes nothing;
 *   - grants, owners and settings are unchanged, and a second apply is refused by the preflight.
 *
 * Run: node scripts/smoke/prove-completed-delivery-cancel-requires-void-real-schema.mjs   (needs Docker)
 * Prints COMPLETED_DELIVERY_CANCEL_REQUIRES_VOID_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-cancel-void-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261102140000_completed_delivery_cancel_requires_void.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
const SIGS = [
  'public.cancel_delivery(uuid,text,uuid,text)',
  'public.batch_cancel_deliveries(uuid[],text,uuid,text)',
  'public._cancel_delivery_replay_impl_20261015(uuid,text,uuid,text)',
  'public._batch_cancel_deliveries_replay_impl_20261015(uuid[],text,uuid,text)',
];
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';

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
  try { docker(['cp', staged, `${NAME}:/tmp/${name}`]); } finally { unlinkSync(staged); }
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
  for (const file of all.slice(at + 1)) assert.ok(!/cancel_deliver/.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches the cancel functions; re-think this proof`);
  return all.slice(0, at);
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
  let replayed = 0;
  for (const [i, file] of plan().entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  console.log(`[prover] replayed ${replayed} post-baseline migrations`);
}

const id = (n) => `7c730000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1'); const REP = id('b1'); const CUST = id('c1'); const PROD = id('d1');
const ORDER = id('e1'); const QORDER = id('e2');
// S scheduled, P in progress, C1/C2 completed (C2 is cancelled with a stored receipt before the candidate), Q quick.
const DEL = { S: id('f1'), P: id('f2'), C1: id('f3'), C2: id('f4'), Q: id('f5') };
const NO_PROOF_SIGNER = 'No proof — recorded by office';
function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function seed() {
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  const line = (n, order) => `INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
    VALUES ('${id(`10${n}`)}', '${order}', '${PROD}', '[PROVER] line ${n}', 10, 6, 2, 20, 8, 40, 0, 2);`;
  const delivery = (key, n, order, quick) => `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, scheduled_date, status, created_by, is_quick_delivery)
      VALUES ('${DEL[key]}', '[PROVER] CCV-${key}', '${order}', '${CUST}', CURRENT_DATE, 'scheduled', '${ADMIN}', ${quick});
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
      VALUES ('${DEL[key]}', '${id(`10${n}`)}', '${PROD}', 2, 0, 'GL');`;
  const complete = (key) => `UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${DEL[key]}';
    SELECT public.complete_delivery(p_delivery_id => '${DEL[key]}', p_signed_by => '${NO_PROOF_SIGNER}', p_performed_by => '${ADMIN}',
      p_idempotency_key => 'seed-complete-${key}', p_evidence => 'no_proof', p_evidence_ref => '[PROVER] fixture');`;
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${ADMIN}', 'cancel-void-a@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
      ('${REP}', 'cancel-void-r@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);
    ${claims(ADMIN)}
    INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${CUST}', '[PROVER] Cancel Farm', '[PROVER]-CCV-1');
    INSERT INTO public.products (id, product_name, unit_size, epa_registration, product_form)
      VALUES ('${PROD}', '[PROVER] Cancel Product', 'GL', '999999-99999', 'liquid');
    DO $price$
    DECLARE v jsonb;
    BEGIN
      v := public.preview_product_pricing_changes('product_page', NULL,
        jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'row_version', 1, 'pricing_mode', 'price_driven',
          'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
        '${ADMIN}', 'seed-pricing-preview');
      PERFORM public.apply_product_pricing_change_set((v->>'change_set_id')::uuid, v->>'request_fingerprint', '${ADMIN}', 'seed-pricing-apply');
    END
    $price$;
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES ('${PROD}', 'Main Warehouse', 100, 10, 'GL');
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES
      ('${ORDER}', '[PROVER] CCV-ORDER', '${CUST}', 'confirmed', false),
      ('${QORDER}', '[PROVER] CCV-QUICK', '${CUST}', 'confirmed', false);
    ${line(1, ORDER)} ${line(2, ORDER)} ${line(3, ORDER)} ${line(4, ORDER)} ${line(5, QORDER)}
    ${delivery('S', 1, ORDER, false)} ${delivery('P', 2, ORDER, false)} ${delivery('C1', 3, ORDER, false)}
    ${delivery('C2', 4, ORDER, false)} ${delivery('Q', 5, QORDER, true)}
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${DEL.P}';
    ${complete('C1')} ${complete('C2')}
    COMMIT;`);
  // A definer helper (container only) so a probe signed in as the caller still sees every row it compares.
  psql(`CREATE FUNCTION public.prover_cancel_fp() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fp$
    SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) FROM (
      SELECT row(i.quantity_available, i.quantity_prebooked)::text t FROM inventory i WHERE i.product_id = '${PROD}'
      UNION ALL SELECT row(x.transaction_type, x.quantity, x.delivery_id)::text FROM inventory_transactions x WHERE x.product_id = '${PROD}'
      UNION ALL SELECT row(v.id, v.status, v.total_amount_cents, v.deleted_at)::text FROM invoices v WHERE v.customer_id = '${CUST}'
      UNION ALL SELECT row(d.id, d.status)::text FROM deliveries d WHERE d.customer_id = '${CUST}'
      UNION ALL SELECT row(o.id, o.status)::text FROM orders o WHERE o.customer_id = '${CUST}'
      UNION ALL SELECT row(oi.id, oi.quantity_delivered, oi.quantity_remaining)::text FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.customer_id = '${CUST}'
    ) s $fp$;
    GRANT EXECUTE ON FUNCTION public.prover_cancel_fp() TO authenticated;`);
  const state = scalar(`SELECT string_agg(delivery_number || '=' || status, ',' ORDER BY delivery_number) FROM public.deliveries WHERE customer_id = '${CUST}';`);
  assert.equal(state, '[PROVER] CCV-C1=completed,[PROVER] CCV-C2=completed,[PROVER] CCV-P=in_progress,[PROVER] CCV-Q=scheduled,[PROVER] CCV-S=scheduled');
  const drafts = scalar(`SELECT count(*) FROM public.invoices WHERE customer_id = '${CUST}' AND status = 'draft' AND delivery_id IN ('${DEL.C1}', '${DEL.C2}');`);
  console.log(`[prover] seeded: ${state}; draft invoices on the completed deliveries: ${drafts}`);
}

/** One signed-in call; rolled back unless `commit`. Returns the probe's v text or <sqlstate>|<message>. */
function attempt(uid, stmt, { commit = false } = {}) {
  const sql = `BEGIN;
${claims(uid)}
SET LOCAL ROLE authenticated;
DO $probe$
DECLARE v text; r jsonb; r2 jsonb; fp0 text := public.prover_cancel_fp();
BEGIN
  ${stmt}
  RAISE NOTICE 'RESULT|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|%|%', SQLSTATE, SQLERRM;
END
$probe$;
${commit ? 'COMMIT' : 'ROLLBACK'};
`;
  const res = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: true });
  assert.equal(res.status, 0, `probe failed to run:\n${res.stderr}\n--- SQL ---\n${sql}`);
  const m = /RESULT\|([^\n]*)/.exec(res.stderr);
  assert.ok(m, `probe printed no RESULT:\n${res.stderr}`);
  return m[1].trimEnd();
}
const cancel = (del, uid, key) => `public.cancel_delivery('${del}', '[PROVER] customer called', '${uid}', '${key}')`;
// Refusals are caught inside the probe so it can also report whether anything changed.
const tryCancel = (del, uid, key) => `BEGIN r := ${cancel(del, uid, key)}; v := 'cancelled:items_restored=' || (r->>'items_restored') || ',drafts_cancelled=' || (r->>'draft_invoices_cancelled');
  EXCEPTION WHEN OTHERS THEN v := 'refused:' || SQLERRM; END;
  v := v || '|unchanged=' || (fp0 = public.prover_cancel_fp())::text;`;
const statuses = `(SELECT string_agg(delivery_number || '=' || status, ',' ORDER BY delivery_number) FROM public.deliveries WHERE customer_id = '${CUST}')`;
// Two statements: one expression would read the statuses from the snapshot taken before the call.
const batch = (ids, key) => `v := public.batch_cancel_deliveries(ARRAY[${ids.map((k) => `'${DEL[k]}'`).join(', ')}]::uuid[], '[PROVER] batch', '${REP}', '${key}')::text;
  v := v || '|' || ${statuses} || '|stock=' || (SELECT quantity_available || '/' || quantity_prebooked FROM public.inventory WHERE product_id = '${PROD}');`;
const CASES = {
  'admin cancels completed': [ADMIN, tryCancel(DEL.C1, ADMIN, 'k-admin-c1')],
  'rep cancels completed': [REP, tryCancel(DEL.C1, REP, 'k-rep-c1')],
  'mixed batch': [REP, batch(['S', 'P', 'C1'], 'k-batch-mixed')],
  'stale batch of a completed delivery': [REP, `${batch(['C1'], 'k-batch-stale')} v := v || '|unchanged=' || (fp0 = public.prover_cancel_fp())::text;`],
  'cancel scheduled': [ADMIN, `r := ${cancel(DEL.S, ADMIN, 'k-s')}; v := r::text || '|' || ${statuses};`],
  'cancel in progress': [REP, `r := ${cancel(DEL.P, REP, 'k-p')}; v := r::text || '|' || ${statuses};`],
  'cancel quick delivery': [REP, `r := ${cancel(DEL.Q, REP, 'k-q')}; v := (r->>'prebooked_released') || '|' || (SELECT status FROM public.orders WHERE id = '${QORDER}')
    || '|stock=' || (SELECT quantity_available || '/' || quantity_prebooked FROM public.inventory WHERE product_id = '${PROD}');`],
  'same-key replay': [ADMIN, `r := ${cancel(DEL.S, ADMIN, 'k-replay')}; r2 := ${cancel(DEL.S, ADMIN, 'k-replay')};
    v := (r = r2)::text || '|' || (SELECT count(*) FROM public.activity_feed WHERE related_entity_id = '${DEL.S}' AND event_type = 'delivery_cancelled');`],
  'already cancelled': [ADMIN, `r := ${cancel(DEL.S, ADMIN, 'k-twice-1')}; r2 := ${cancel(DEL.S, ADMIN, 'k-twice-2')};`],
  'forged actor': [REP, `r := ${cancel(DEL.S, ADMIN, 'k-forged')};`],
};
function matrix(phase) {
  const out = {};
  for (const [label, [uid, stmt]] of Object.entries(CASES)) out[label] = attempt(uid, stmt);
  console.log(`[prover] ${phase}:`);
  for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${v}`);
  return out;
}
const META = `SELECT string_agg(oid::regprocedure::text || ' ' || pg_get_userbyid(proowner) || ' ' || proacl::text || ' ' || prosecdef || ' ' || proconfig::text, E'\\n' ORDER BY oid::regprocedure::text)
  FROM pg_proc WHERE oid IN (${SIGS.map((s) => `'${s}'::regprocedure`).join(', ')});`;
const HIST = `r := ${cancel(DEL.C2, ADMIN, 'k-hist')}; v := r::text || '|unchanged=' || (fp0 = public.prover_cancel_fp())::text;`;

function main() {
  buildContainer();
  seed();
  // A receipt written by the OLD body for a completed delivery's cancel (C2), kept across the candidate.
  const hist = attempt(ADMIN, HIST, { commit: true });
  assert.match(hist, /^ok\|\{.*"success": true.*"items_restored": 1.*\|unchanged=false$/);
  const before = matrix('BEFORE');
  // Fail-first: the old bodies cancel a completed delivery and put its stock back.
  assert.match(before['admin cancels completed'], /^ok\|cancelled:items_restored=1,drafts_cancelled=1\|unchanged=false$/);
  assert.match(before['rep cancels completed'], /^ok\|cancelled:items_restored=1,drafts_cancelled=1\|unchanged=false$/);
  const D = (s, p, c1) => `[PROVER] CCV-C1=${c1},[PROVER] CCV-C2=cancelled,[PROVER] CCV-P=${p},[PROVER] CCV-Q=scheduled,[PROVER] CCV-S=${s}`;
  // Stock after both completions and C2's cancel: 98 available / 8 prebooked; cancelling C1 puts 2 back on each.
  assert.equal(before['mixed batch'], `ok|3|${D('cancelled', 'cancelled', 'cancelled')}|stock=100/10`);
  assert.equal(before['stale batch of a completed delivery'], `ok|1|${D('scheduled', 'in_progress', 'cancelled')}|stock=100/10|unchanged=false`);
  const metaBefore = scalar(META);

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  const after = matrix('AFTER');
  const refused = 'ok|refused:DELIVERY_COMPLETED_USE_VOID: a completed delivery cannot be cancelled; an admin must void it instead|unchanged=true';
  assert.equal(after['admin cancels completed'], refused);
  assert.equal(after['rep cancels completed'], refused);
  assert.equal(after['mixed batch'], `ok|2|${D('cancelled', 'cancelled', 'completed')}|stock=98/8`);
  assert.equal(after['stale batch of a completed delivery'], `ok|0|${D('scheduled', 'in_progress', 'completed')}|stock=98/8|unchanged=true`);
  const changed = ['admin cancels completed', 'rep cancels completed', 'mixed batch', 'stale batch of a completed delivery'];
  for (const [label, got] of Object.entries(after)) {
    if (!changed.includes(label)) assert.equal(got, before[label], `${label} changed`);
  }
  assert.match(after['forged actor'], /actor mismatch/);
  console.log('[prover] scheduled, in-progress, quick-delivery, replay, already-cancelled and forged-actor cases are unchanged');

  const replay = attempt(ADMIN, HIST);
  assert.equal(replay, hist.replace(/\|unchanged=false$/, '|unchanged=true'), 'the stored completed-delivery receipt must replay the same success and change nothing');
  console.log(`[prover] the receipt stored before the candidate still replays unchanged: ${replay}`);

  assert.equal(scalar(META), metaBefore, 'owner, grants or security settings changed');
  console.log(`[prover] owners, grants and settings are unchanged:\n${metaBefore}`);

  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must be refused by the preflight');
  assert.match(again.output, /PREFLIGHT_FAIL/);
  console.log('[prover] a second apply is refused by the preflight');

  console.log('COMPLETED_DELIVERY_CANCEL_REQUIRES_VOID_PROOF_PASS');
}

try { main(); }
finally { docker(['rm', '-f', NAME], { allowFailure: true }); }
