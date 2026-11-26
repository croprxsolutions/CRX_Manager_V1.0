#!/usr/bin/env node
/**
 * Real-schema proof for 20270308150000_credit_tax_ledger_timing.sql (#2091).
 *
 * Builds the checked-in production baseline in a network-disabled PostgreSQL container and replays every
 * migration before the candidate (scripts/smoke/undo-paths/harness.mjs), seeds invented users, customers and a
 * product, then:
 *   1. BEFORE: the two-session race records 0 tax for a credit that refunded the sale's tax; the covering chains
 *      (smoke-credit-tax-ledger and the return and tax chains) pass;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight;
 *   3. APPLY (committed): POSTFLIGHT_OK;
 *   4. AFTER: the race records exactly the tax the credit refunded; every covering chain still passes;
 *   5. RE-APPLY: refused by the preflight;
 *   6. ROLLBACK: re-emitting the pinned body restores the BEFORE behaviour (0 again).
 *
 * The race: transaction A begins (its credit is stamped at A's start), transaction B posts the taxed sale and
 * commits, then A makes, receives and credits a return of the whole sale and reaches its commit point. The credit
 * refunds the sale's tax; the ledger must record that same tax, as a refund.
 *
 * Run: node scripts/smoke/prove-credit-tax-ledger-timing-real-schema.mjs   (needs Docker)
 * Prints CREDIT_TAX_LEDGER_TIMING_PROOF_PASS on success. UNDO_PATHS_CONTAINER=<name> names the container.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  NAME, ROOT, USERS, buildContainer, claims, docker, psql, removeContainer, scalar, seedUsers,
} from './undo-paths/harness.mjs';

const CANDIDATE = '20270308150000_credit_tax_ledger_timing.sql';
const SMOKE = path.join(ROOT, 'scripts', 'smoke');
const COVERING = ['smoke-credit-tax-ledger.sql', 'smoke-sales-tax.sql', 'smoke-split-payer-return-credit.sql', 'smoke-billing-m4-switch.sql', 'smoke-standing-grower-discount.sql'];
const FUNCTIONS = ['public._freeze_credit_sales_tax_20270109(uuid)'];
const pid = (s) => `7d000000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const lf = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const { admin } = USERS;
const pgArgs = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t'];

function stage(name, text) { docker(['exec', '-i', NAME, 'sh', '-c', `cat > /tmp/${name}`], { input: text }); }

function seed() {
  seedUsers();
  // A second admin and rep and a second customer, so the covering chains have what they need.
  for (const [user, role] of [[pid('a5'), 'admin'], [pid('a6'), 'sales_rep']]) {
    psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${user}', '${user}@example.invalid',
      '{"full_name":"[PROVER] ${role} 2","role":"${role}"}'::jsonb) ON CONFLICT (id) DO NOTHING;`);
  }
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, is_active, created_at) VALUES
      ('${pid('c1')}', '[PROVER] Return Tax Farm', true, now() - interval '3 minutes'),
      ('${pid('c2')}', '[PROVER] Payer Farm', true, now() - interval '2 minutes') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${pid('f1')}', '[PROVER] Return Tax Herbicide', 'RTX-1', 'liquid', 'gal', 'gal', 'oz', 'gal', 24, 30, 30, 30, 1, true)
      ON CONFLICT (id) DO NOTHING;
    UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
    INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
      WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');
    INSERT INTO public.inventory (product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order)
      SELECT '${pid('f1')}', 'Main Warehouse', 'gal', 100000, 0, 0
       WHERE NOT EXISTS (SELECT 1 FROM public.inventory WHERE product_id = '${pid('f1')}');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
}

/** Run a chain file in a rolled-back transaction. */
function chain(file) {
  stage('chain.sql', lf(path.join(SMOKE, file)));
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q'],
    { input: 'BEGIN;\n\\i /tmp/chain.sql\nROLLBACK;\n', allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  // pass only when the chain's terminal (last) error is its own pass marker
  const errors = out.split(/\r?\n/).filter((l) => /ERROR:/.test(l));
  const pass = errors.length > 0 && /ERROR:\s+SMOKE_PASS_ROLLBACK\b/.test(errors.at(-1));
  return { pass, fail: pass ? '' : (/SMOKE_FAIL[^\n]*/.exec(out)?.[0] ?? /ERROR:[^\n]*/.exec(out)?.[0] ?? out.slice(-600)) };
}

/** The #2091 race on a fresh taxed sale: returns { credit, tax, ledger } in cents. */
let raceNo = 0;
async function race(qty = 10, finish = 'ROLLBACK') {
  raceNo += 1;
  const tag = `race-${raceNo}-${Date.now().toString(36)}`;
  // Committed: a taxed sale of 10, delivered, with its taxed draft.
  psql(`BEGIN;\n${claims(admin)}
    UPDATE public.billing_m4_switch SET enabled = true;
    UPDATE public.customers SET standing_discount_pct = 0 WHERE id = '${pid('c1')}';
    DO $s$
    DECLARE v_order uuid; v_delivery uuid;
    BEGIN
      INSERT INTO orders (order_number, customer_id, order_date, status, salesman_id)
        VALUES ('${tag}', '${pid('c1')}', CURRENT_DATE, 'confirmed', '${admin}') RETURNING id INTO v_order;
      PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true);
      INSERT INTO order_items (order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
        total_units_needed, total_price, quantity_delivered, quantity_remaining)
        VALUES (v_order, '${pid('f1')}', '[PROVER] Race line', 'gal', 25.37, 24, 10, 253.70, 0, 10);
      PERFORM set_config('app.crx_below_cost_operation', '', true);
      PERFORM set_order_sales_tax(v_order, true, '${tag}-tax');
      INSERT INTO deliveries (delivery_number, order_id, customer_id, status, scheduled_date, created_by)
        VALUES ('${tag}', v_order, '${pid('c1')}', 'scheduled', CURRENT_DATE, '${admin}') RETURNING id INTO v_delivery;
      INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
        SELECT v_delivery, oi.id, oi.product_id, 10, 'gal' FROM order_items oi WHERE oi.order_id = v_order;
      PERFORM confirm_delivery(v_delivery, '${admin}', '${tag}-confirm');
      PERFORM complete_delivery(v_delivery, 'No proof — recorded by office', '${admin}', NULL, NULL, NULL,
        '${tag}-complete', NULL, 'no_proof', 'Real-schema proof; return tax race');
    END $s$;
    COMMIT;`);
  const invoice = scalar(`SELECT i.id FROM invoices i JOIN orders o ON o.id = i.order_id
    WHERE o.order_number = '${tag}' AND i.invoice_type <> 'credit_memo';`);
  assert.ok(invoice, 'the race sale has no draft');
  // A: starts first (its credit is stamped at this start), waits, then returns and credits the whole sale.
  // A and B hand off through the database, not sleeps: A starts its transaction and names itself, B waits for that,
  // posts and commits, A waits (up to 120 s) until it sees the posted sale.
  const sessionA = `SET application_name = '${tag}-a';\nBEGIN;\n${claims(admin)}\nSELECT now();
    DO $w$ BEGIN
      FOR i IN 1..600 LOOP
        EXIT WHEN EXISTS (SELECT 1 FROM invoices WHERE id = '${invoice}' AND status IN ('posted', 'overdue', 'paid'));
        PERFORM pg_sleep(0.2);
      END LOOP;
    END $w$;
    DO $a$
    DECLARE v_order uuid; v_ret uuid; v_credit uuid;
    BEGIN
      SELECT id INTO v_order FROM orders WHERE order_number = '${tag}';
      v_ret := (create_return(jsonb_build_object('customer_id', '${pid('c1')}', 'order_id', v_order, 'reason', 'damaged'),
        (SELECT jsonb_agg(jsonb_build_object('order_item_id', oi.id, 'quantity', ${qty}, 'condition', 'unopened', 'restock', false))
           FROM order_items oi WHERE oi.order_id = v_order), '${tag}-ret') ->> 'return_id')::uuid;
      PERFORM approve_return(v_ret, '${admin}', '${tag}-ap');
      PERFORM receive_return(v_ret, '${admin}', '${tag}-rc');
      PERFORM issue_return_credit(v_ret, '${admin}', '${tag}-ic');
      SET CONSTRAINTS ALL IMMEDIATE;
      SELECT credit_invoice_id INTO v_credit FROM returns WHERE id = v_ret;
      RAISE NOTICE 'RACE|%|%|%|%|%', (SELECT -total_amount_cents FROM invoices WHERE id = v_credit),
        (SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = '${invoice}' AND charge_type = 'sales_tax'),
        COALESCE((SELECT -sum(tax_cents) FROM credit_memo_sales_tax WHERE invoice_id = v_credit), -1),
        -- the race happened in the order it needs: the sale posted after the credit's transaction began
        (SELECT s.posted_at > c.posted_at FROM invoices s, invoices c WHERE s.id = '${invoice}' AND c.id = v_credit),
        round((SELECT total_amount_cents FROM invoices WHERE id = '${invoice}') * ${qty} / 10.0)::bigint;
    END $a$;
    ${finish};`;
  const sessionB = `DO $w$ BEGIN
      FOR i IN 1..600 LOOP
        EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${tag}-a' AND xact_start IS NOT NULL);
        PERFORM pg_sleep(0.2);
      END LOOP;
    END $w$;\nBEGIN;\n${claims(admin)}
    SELECT post_invoice('${invoice}', _invoice_post_version('${invoice}'), '${tag}-post');\nCOMMIT;`;
  const run = (sql) => new Promise((resolve) => {
    const child = execFile('docker', [...pgArgs, '-v', 'ON_ERROR_STOP=1'], { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, out: `${stdout}\n${stderr}` }));
    child.stdin.end(sql);
  });
  const [ra, rb] = await Promise.all([run(sessionA), run(sessionB)]);
  assert.ok(!rb.error, `B could not post the sale: ${rb.out}`);
  assert.ok(!ra.error, `A could not credit the return: ${ra.out}`);
  const m = /RACE\|(-?\d+)\|(\d+)\|(-?\d+)\|(t|f)\|(-?\d+)/.exec(ra.out);
  assert.ok(m, `A printed no result: ${ra.out}`);
  assert.equal(m[4], 't', 'the sale must post after the credit transaction began (re-run: Docker started the sessions out of order)');
  // the credit is a negative memo of exactly qty/10 of the posted sale (signs checked: m[1] is -total)
  assert.equal(m[1], m[5], `the credit must be exactly ${qty}/10 of the posted sale: ${ra.out}`);
  return { credit: Number(m[1]), tax: Number(m[2]), ledger: Number(m[3]), tag };
}

function covering(phase, required) {
  const passed = new Set();
  for (const name of COVERING) {
    const r = chain(name);
    if (r.pass) passed.add(name);
    else if (required?.has(name)) assert.fail(`${phase}: ${name} passed before the candidate and fails after it: ${r.fail}`);
    else console.log(`[prover] ${phase}: ${name} does not pass in this database (not required): ${r.fail}`);
  }
  console.log(`[prover] ${phase}: ${passed.size}/${COVERING.length} covering chains pass: ${[...passed].join(', ')}`);
  return passed;
}

async function main() {
  buildContainer({ stopBefore: CANDIDATE });
  seed();
  // 1. BEFORE
  const r1 = await race();
  assert.ok(r1.tax > 0 && r1.credit > 0, `BEFORE race: ${JSON.stringify(r1)}`);
  assert.equal(r1.ledger, 0, `BEFORE race: the ledger should have recorded 0 tax: ${JSON.stringify(r1)}`);
  console.log(`[case] 1 BEFORE: the credit refunded ${r1.credit} cents including ${r1.tax} cents tax; the ledger recorded ${r1.ledger}`);
  const passedBefore = covering('BEFORE');
  for (const name of COVERING) assert.ok(passedBefore.has(name), `BEFORE: ${name} must pass in this database`);
  const md5s = () => FUNCTIONS.map((f) => scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = '${f}'::regprocedure;`)).join(',');
  const oldMd5 = md5s();
  const oldBodies = FUNCTIONS.map((f) => docker(pgArgs, { input: `SELECT pg_get_functiondef('${f}'::regprocedure);` }).stdout.trim());
  // 2. AUTOCOMMIT
  stage('cand.sql', lf(path.join(ROOT, 'supabase', 'migrations', CANDIDATE)));
  const auto = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/cand.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0);
  assert.match(`${auto.stdout}\n${auto.stderr}`, /CREDIT_TAX_LEDGER_TIMING_NOT_IN_TRANSACTION|"pg_temp\.credit_tax_ledger_timing_tx" does not exist/);
  assert.equal(md5s(), oldMd5, 'AUTOCOMMIT: the function changed');
  console.log('[case] 2 AUTOCOMMIT: run statement by statement, the file stops at its preflight and changes nothing');
  // 3. APPLY
  const applied = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/cand.sql'], { allowFailure: true });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.match(applied.stderr, /CREDIT_TAX_LEDGER_TIMING_POSTFLIGHT_OK/);
  console.log('[case] 3 APPLY: committed, POSTFLIGHT_OK');
  // 4. AFTER
  const r2 = await race();
  assert.ok(r2.tax > 0 && r2.credit > 0, `AFTER race: ${JSON.stringify(r2)}`);
  assert.equal(r2.ledger, r2.tax, `AFTER race: the ledger must record the tax the credit refunded: ${JSON.stringify(r2)}`);
  console.log(`[case] 4 AFTER: the credit refunded ${r2.credit} cents including ${r2.tax} cents tax; the ledger recorded ${r2.ledger}`);
  covering('AFTER', passedBefore);
  // 5. RE-APPLY
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/cand.sql'], { allowFailure: true });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /CREDIT_TAX_LEDGER_TIMING_PREFLIGHT: already applied/);
  console.log('[case] 5 RE-APPLY: refused by the preflight');
  // 6. ROLLBACK
  psql(`BEGIN;\n${oldBodies.join(';\n')};\nCOMMIT;`);
  assert.equal(md5s(), oldMd5, 'ROLLBACK: the body is not the pinned one');
  const r3 = await race();
  assert.equal(r3.ledger, 0, `ROLLBACK race: ${JSON.stringify(r3)}`);
  console.log('[case] 6 ROLLBACK: re-emitting the pinned body restores the BEFORE behaviour (0-tax ledger)');
  console.log('CREDIT_TAX_LEDGER_TIMING_PROOF_PASS');
}

try { await main(); } finally { if (process.env.CRX_PROVER_KEEP_CONTAINER !== '1') removeContainer(); }
