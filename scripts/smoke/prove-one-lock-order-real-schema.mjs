#!/usr/bin/env node
/**
 * Real-schema race proof for C3 (#2190; contract docs/plans/2026-11-22-one-lock-order-CONTRACT.md).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds invented rows, and forces each interleaving with
 * concurrent sessions and a "blocker" session that holds one row for a few seconds. Every case runs on the current
 * bodies (BEFORE) and, when the candidate migration exists, again on a fresh fixture set after applying it (AFTER).
 *
 * Run: node scripts/smoke/prove-one-lock-order-real-schema.mjs   (needs Docker; never touches live)
 * Prints ONE_LOCK_ORDER_BEFORE_PASS, then ONE_LOCK_ORDER_BEFORE_PASS (today) and ONE_LOCK_ORDER_PROOF_PASS (only after every case incl. 6-9) once the candidate exists and passes.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, seed, attempt, asUser, refuse, USERS, ROOT, NAME, docker, scalar, psql, claims } from './undo-paths/harness.mjs';

const CANDIDATE = '20270214100000_one_lock_order.sql';
const candidatePath = path.join(ROOT, 'supabase', 'migrations', CANDIDATE);
const HAVE_CANDIDATE = existsSync(candidatePath);
const { admin: ADMIN } = USERS;
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];

// Invented ids: 7c7a0000-0000-4000-8000-c3<set><code>; uuid order follows <code>, so product A1 < B1 and P3 < Q3.
const u = (set, code) => `7c7a0000-0000-4000-8000-00000c3${set}${code}`;
const ids = (s) => ({
  CUST: u(s, '0f01'),
  A1: u(s, '0a01'), B1: u(s, '0a02'), P2: u(s, '0b01'), P3: u(s, '0c01'), Q3: u(s, '0c02'), R4: u(s, '0d01'),
  O1x: u(s, '1001'), O1y: u(s, '1002'), O2: u(s, '1003'), O3a: u(s, '1004'), O3b: u(s, '1005'), O4: u(s, '1006'), O5: u(s, '1007'),
  // order lines
  L1xA: u(s, '2001'), L1xB: u(s, '2002'), L1yA: u(s, '2003'), L1yB: u(s, '2004'), L2a: u(s, '2005'), L2b: u(s, '2006'),
  L3aQ: u(s, '2007'), L3aP: u(s, '2008'), L3bP: u(s, '2009'), L3bQ: u(s, '200a'), L4: u(s, '200b'), L5: u(s, '200c'),
  // deliveries
  X1: u(s, '3001'), Y1: u(s, '3002'), S2: u(s, '3003'), D2: u(s, '3004'), V3: u(s, '3005'), C3: u(s, '3006'),
  F4: u(s, '3007'), S5: u(s, '3008'), S6: u(s, '3009'),
});

const deliver = (key, del, qty) => `PERFORM public.complete_delivery(p_delivery_id => ${del.includes(' ') || !del.includes('-') ? del : `'${del}'`}, p_signed_by => 'No proof — recorded by office',
    p_performed_by => '${ADMIN}', p_quantities => ${qty ?? 'NULL'}, p_idempotency_key => '${key}', p_evidence => 'no_proof', p_evidence_ref => '[C3] fixture');`;
const callComplete = (key, del) => `SELECT public.complete_delivery(p_delivery_id => '${del}', p_signed_by => 'No proof — recorded by office',
    p_performed_by => '${ADMIN}', p_idempotency_key => '${key}', p_evidence => 'no_proof', p_evidence_ref => '[C3] race test run');`;
const partial = (del, line, n) => `jsonb_build_object((SELECT id FROM public.delivery_items WHERE delivery_id = '${del}' AND order_item_id = '${line}')::text, ${n})`;

function seedSet(s) {
  const I = ids(s);
  const product = (pid, n) => `('${pid}', '[C3${s}] Product ${n}', 'Gal', '99999-${s.charCodeAt(0)}${String(n).padStart(2, '0')}', 'liquid', 'Gal')`;
  const products = [I.A1, I.B1, I.P2, I.P3, I.Q3, I.R4];
  const order = (oid, n) => `('${oid}', '[C3${s}] O${n}', '${I.CUST}', 'confirmed', false)`;
  const line = (lid, oid, pid, units) => `INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size)
    VALUES ('${lid}', '${oid}', '${pid}', '[C3] line', 10, 6, ${units}, ${units * 10}, ${units * 4}, 40, 0, ${units}, 'Gal');`;
  const delivery = (did, oid, items) => `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, scheduled_date, status, created_by)
      VALUES ('${did}', '[C3${s}] ${did.slice(-4)}', '${oid}', '${I.CUST}', CURRENT_DATE, 'scheduled', '${ADMIN}');
    ${items.map(([lid, pid, q]) => `INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
      VALUES ('${did}', '${lid}', '${pid}', ${q}, 0, 'Gal');`).join('\n')}`;
  const start = (did) => `UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${did}';`;
  seed(`lane-c3-${s}`, `INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${I.CUST}', '[C3${s}] Farm', '[C3${s}]-1');
    INSERT INTO public.products (id, product_name, unit_size, epa_registration, product_form, inventory_unit) VALUES
      ${products.map((p, n) => product(p, n)).join(',\n      ')};
    DO $price$ DECLARE v jsonb; BEGIN
      v := public.preview_product_pricing_changes('product_page', NULL, jsonb_build_array(${products.map((p) => `jsonb_build_object('product_id', '${p}', 'row_version', 1,
        'pricing_mode', 'price_driven', 'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')`).join(', ')}), '${ADMIN}', 'c3${s}-p-preview');
      PERFORM public.apply_product_pricing_change_set((v->>'change_set_id')::uuid, v->>'request_fingerprint', '${ADMIN}', 'c3${s}-p-apply');
    END $price$;
    -- A1 deliberately has no Main Warehouse row (case 1).
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES
      ${[I.B1, I.P2, I.P3, I.Q3, I.R4].map((p) => `('${p}', 'Main Warehouse', 100, 0, 'Gal')`).join(', ')};
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES
      ${[[I.O1x, '1x'], [I.O1y, '1y'], [I.O2, 2], [I.O3a, '3a'], [I.O3b, '3b'], [I.O4, 4], [I.O5, 5]].map(([o, n]) => order(o, n)).join(', ')};
    ${line(I.L1xA, I.O1x, I.A1, 5)} ${line(I.L1xB, I.O1x, I.B1, 5)} ${line(I.L1yA, I.O1y, I.A1, 7)} ${line(I.L1yB, I.O1y, I.B1, 7)}
    ${line(I.L2a, I.O2, I.P2, 10)} ${line(I.L2b, I.O2, I.P2, 3)}
    ${line(I.L3aQ, I.O3a, I.Q3, 4)} ${line(I.L3aP, I.O3a, I.P3, 4)} ${line(I.L3bP, I.O3b, I.P3, 6)} ${line(I.L3bQ, I.O3b, I.Q3, 6)}
    ${line(I.L4, I.O4, I.R4, 10)} ${line(I.L5, I.O5, I.R4, 10)}
    ${delivery(I.X1, I.O1x, [[I.L1xA, I.A1, 5], [I.L1xB, I.B1, 5]])} ${start(I.X1)}
    ${delivery(I.Y1, I.O1y, [[I.L1yA, I.A1, 7], [I.L1yB, I.B1, 7]])} ${start(I.Y1)}
    ${delivery(I.S2, I.O2, [[I.L2a, I.P2, 10]])} ${delivery(I.D2, I.O2, [[I.L2b, I.P2, 3]])}
    ${delivery(I.V3, I.O3a, [[I.L3aQ, I.Q3, 4], [I.L3aP, I.P3, 4]])} ${delivery(I.C3, I.O3b, [[I.L3bP, I.P3, 6], [I.L3bQ, I.Q3, 6]])}
    ${delivery(I.F4, I.O4, [[I.L4, I.R4, 10]])} ${delivery(I.S5, I.O5, [[I.L5, I.R4, 5]])} ${delivery(I.S6, I.O5, [[I.L5, I.R4, 5]])}
    ${[I.S2, I.D2, I.V3, I.F4, I.S5, I.S6].map(start).join(' ')} ${start(I.C3)}
    DO $c$ DECLARE r jsonb; g uuid; BEGIN
      ${deliver(`c3${s}-s2`, I.S2, partial(I.S2, I.L2a, 6))}
      ${deliver(`c3${s}-d2`, I.D2)}
      ${deliver(`c3${s}-v3`, I.V3)}
      ${deliver(`c3${s}-f4`, I.F4, partial(I.F4, I.L4, 6))}
      ${deliver(`c3${s}-s5`, I.S5, partial(I.S5, I.L5, 3))}
      ${deliver(`c3${s}-s6`, I.S6, partial(I.S6, I.L5, 3))}
      -- X2: the follow-up of S2 (4 of P2), in progress. G4: the follow-up of F4, delivers 2 of 4 (2 pending on G4).
      r := public.create_followup_delivery('${I.S2}', CURRENT_DATE, '${ADMIN}', 'c3${s}-x2');
      INSERT INTO undo_paths.ids VALUES ('c3${s}-X2', (r->>'delivery_id')::uuid);
      UPDATE public.deliveries SET status = 'in_progress' WHERE id = (r->>'delivery_id')::uuid;
      r := public.create_followup_delivery('${I.F4}', CURRENT_DATE, '${ADMIN}', 'c3${s}-g4');
      g := (r->>'delivery_id')::uuid; INSERT INTO undo_paths.ids VALUES ('c3${s}-G4', g);
      UPDATE public.deliveries SET status = 'in_progress' WHERE id = g;
      ${deliver(`c3${s}-g4k`, 'g', `jsonb_build_object((SELECT id FROM public.delivery_items WHERE delivery_id = g)::text, 2)`)}
      -- S6: scheduled with key c3<set>-t6 (receipt saved), then S6 voided.
      r := public.create_followup_delivery('${I.S6}', CURRENT_DATE, '${ADMIN}', 'c3${s}-t6');
      INSERT INTO undo_paths.ids VALUES ('c3${s}-T6', (r->>'delivery_id')::uuid);
      PERFORM public.void_delivery('${I.S6}', '[C3] fixture void', '${ADMIN}', 'c3${s}-v6');
    END $c$;`);
  return I;
}
const idOf = (name) => scalar(`SELECT id FROM undo_paths.ids WHERE name = '${name}';`);
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Starts one psql session tagged `label` (application_name); resolves when it ends. */
const ended = new Map();
function start(label, sql) {
  return new Promise((resolve) => {
    const c = spawn('docker', PSQL, { cwd: ROOT });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => { const r = { label, code, out: out.trim(), ok: out.includes(`DONE ${label}`) }; ended.set(label, r); resolve(r); });
    c.stdin.end(`SET application_name = '${label}';\n${sql}\nSELECT 'DONE ${label}';\n`);
  });
}
/** An app call: signed in as the admin, run as the `authenticated` role, committed. */
const session = (label, body) => start(label, `BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;\n${body}\nCOMMIT;`);
/** Holds `lockSql` (as postgres) for `ms`, then commits. */
const blocker = (label, lockSql, ms) => start(label, `BEGIN;\n${lockSql}\nSELECT pg_sleep(${ms / 1000});\nCOMMIT;`);
/** What `label` is waiting on right now ('' when running or gone). */
const waitOf = (label) => scalar(`SELECT coalesce(string_agg(wait_event_type || ':' || wait_event, ','), '') FROM pg_stat_activity WHERE application_name = '${label}';`);
/** Waits (bounded) until `label` is blocked on a lock; returns that wait (e.g. Lock:transactionid, Lock:advisory). */
async function blockedOn(label, ms = 8000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 100))) {
    const w = waitOf(label);
    if (w.startsWith('Lock:')) return w;
    if (ended.has(label)) return 'ended';
  }
  throw new Error(`${label} never blocked on a lock (last wait: ${waitOf(label) || 'none'})`);
}
/** Waits until `label` is inside its pg_sleep (it holds what it locked). */
async function sleeping(label, ms = 8000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 100))) if (waitOf(label) === 'Timeout:PgSleep') return;
  throw new Error(`${label} never reached its hold`);
}
const deadlocked = (...rs) => rs.some((r) => /deadlock detected/i.test(r.out));
const summary = (rs) => rs.map((r) => `${r.label}:${r.ok ? 'ok' : (r.out.match(/ERROR:\s*([^\n]*)/)?.[1] ?? r.out).slice(0, 90)}`).join(' | ');
const onHand = (pid) => scalar(`SELECT string_agg(quantity_available::numeric(12,2)::text, ',') FROM public.inventory WHERE product_id = '${pid}' AND location = 'Main Warehouse';`);
const voidCall = (del, key) => `SELECT public.void_delivery('${del}', '[C3] race test', '${ADMIN}', '${key}');`;

/** #2190: Y's first lock pass runs while A has no row; A appears; Z (other order) locks A then waits for B; Y then wants A. */
async function case1(I, p) {
  const h = blocker(`${p}-h1`, `SELECT 1 FROM public.inventory WHERE product_id = '${I.B1}' AND location = 'Main Warehouse' FOR UPDATE;`, 4000);
  await sleeping(`${p}-h1`);
  const y = session(`${p}-Y`, callComplete(`c3-${p}-y`, I.Y1)); const yWait = await blockedOn(`${p}-Y`);
  psql(`INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES ('${I.A1}', 'Main Warehouse', 0, 0, 'Gal');`);
  const z = session(`${p}-Z`, callComplete(`c3-${p}-z`, I.X1)); const zWait = await blockedOn(`${p}-Z`);
  const rs = await Promise.all([y, z]); await h;
  const rows = scalar(`SELECT count(*) FROM public.inventory WHERE product_id = '${I.A1}' AND location = 'Main Warehouse';`);
  return { rs, zWait, line: `Y waited ${yWait}, Z waited ${zWait} | ${summary(rs)} | A rows=${rows} A=${onHand(I.A1)} B=${onHand(I.B1)}` };
}
/** Completion X2 (order O2) holds P2 and is held on its remainder row; void D2 (same order) takes O2 and wants P2. */
async function case2(I, p, set) {
  const x2 = idOf(`c3${set}-X2`); const p0 = Number(onHand(I.P2));
  const h = blocker(`${p}-h2`, `SELECT 1 FROM public.delivery_remainders WHERE followup_delivery_id = '${x2}' FOR UPDATE;`, 4000);
  await sleeping(`${p}-h2`);
  const x = session(`${p}-complete2`, callComplete(`c3-${p}-x2`, x2)); const xWait = await blockedOn(`${p}-complete2`);
  const v = session(`${p}-void2`, voidCall(I.D2, `c3-${p}-vd2`)); const vWait = await blockedOn(`${p}-void2`);
  const rs = await Promise.all([x, v]); await h;
  return { rs, vWait, expectP2: (p0 - 4 + 3).toFixed(2), line: `void waited ${vWait} | ${summary(rs)} | P2 ${p0} -> ${onHand(I.P2)}` };
}
/** Void V3 (order O3a: Q3, P3 lines) held on its Q3 order line; completion C3 (order O3b: P3, Q3) starts. */
async function case3(I, p) {
  const p0 = Number(onHand(I.P3)); const q0 = Number(onHand(I.Q3));
  const h = blocker(`${p}-h3`, `SELECT 1 FROM public.order_items WHERE id = '${I.L3aQ}' FOR UPDATE;`, 4000);
  await sleeping(`${p}-h3`);
  const v = session(`${p}-void3`, voidCall(I.V3, `c3-${p}-v3`)); await blockedOn(`${p}-void3`);
  // Which stock rows does the void already hold? (A NOWAIT probe fails on a held row.)
  const held = ['P3', 'Q3'].filter((k) => /could not obtain lock/.test(docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
    { input: `SELECT 1 FROM public.inventory WHERE product_id = '${I[k]}' AND location = 'Main Warehouse' FOR UPDATE NOWAIT;`, allowFailure: true }).stderr)).join('+') || 'none';
  const c = session(`${p}-complete3`, callComplete(`c3-${p}-c3`, I.C3)); const cWait = await blockedOn(`${p}-complete3`);
  const rs = await Promise.all([v, c]); await h;
  return { rs, held, cWait, expect: [(p0 + 4 - 6).toFixed(2), (q0 + 4 - 6).toFixed(2)].join('/'),
    got: `${onHand(I.P3)}/${onHand(I.Q3)}`, line: `void held ${held} before the completion; completion waited ${cWait} | ${summary(rs)} | P3/Q3 ${p0}/${q0} -> ${onHand(I.P3)}/${onHand(I.Q3)}` };
}
/** Void of ancestor F4 holds O4 (held on its order line); dispatch schedules a follow-up of G4 meanwhile. */
async function case4(I, p, set) {
  const g4 = idOf(`c3${set}-G4`);
  const h = blocker(`${p}-h4`, `SELECT 1 FROM public.order_items WHERE id = '${I.L4}' FOR UPDATE;`, 4000);
  await sleeping(`${p}-h4`);
  const v = session(`${p}-voidF4`, voidCall(I.F4, `c3-${p}-vf4`)); await blockedOn(`${p}-voidF4`);
  const f = session(`${p}-schedG4`, `SELECT public.create_followup_delivery('${g4}', CURRENT_DATE, '${ADMIN}', 'c3-${p}-h4');`);
  const fWait = await blockedOn(`${p}-schedG4`);
  const rs = await Promise.all([v, f]); await h;
  const created = scalar(`SELECT count(*) FROM public.delivery_remainders WHERE original_delivery_id = '${g4}' AND status = 'scheduled';`);
  return { rs, fWait, created, line: `scheduler waited ${fWait} | ${summary(rs)} | follow-ups of G4=${created}` };
}

async function runCases(I, p, set) {
  const out = {};
  for (const [name, fn] of Object.entries({ case1, case2, case3, case4 })) {
    out[name] = await fn(I, p, set);
    console.log(`[${p}] ${name}: ${out[name].line}`);
  }
  // 5. A pending row left on a voided source (legacy shape): scheduling from it (rolled back).
  out.s5 = attempt(ADMIN, `${asUser(`PERFORM public.void_delivery('${I.S5}', '[C3] probe void', '${ADMIN}', 'c3-${p}-v5');`)}
    INSERT INTO public.delivery_remainders (original_delivery_id, order_id, order_item_id, customer_id, product_id, quantity_remaining, unit_size, status)
      VALUES ('${I.S5}', '${I.O5}', '${I.L5}', '${I.CUST}', '${I.R4}', 2, 'Gal', 'pending');
    f0 := (SELECT count(*) FROM public.deliveries)::text;
    ${refuse(`r := public.create_followup_delivery('${I.S5}', CURRENT_DATE, '${ADMIN}', 'c3-${p}-s5f');`)}
    v := left(t, 70) || ' new_deliveries=' || ((SELECT count(*) FROM public.deliveries) - f0::bigint);`);
  // 5b. The receipt saved before S6 was voided is still answered for its key.
  out.s6 = attempt(ADMIN, `${asUser(`r := public.create_followup_delivery('${I.S6}', CURRENT_DATE, '${ADMIN}', 'c3${set}-t6');`)}
    v := ((r->>'delivery_id')::uuid = '${idOf(`c3${set}-T6`)}')::text;`);
  console.log(`[${p}] case5 voided source: ${out.s5} | replay of the saved key returns its delivery: ${out.s6}`);
  return out;
}

const reuse = process.env.UNDO_PATHS_REUSE === '1';
const [BEFORE_SET, AFTER_SET] = (process.env.C3_SETS || 'b,a').split(',');

async function main() {
  if (!reuse) { buildContainer({ stopBefore: HAVE_CANDIDATE ? CANDIDATE : undefined }); seedUsers(); }
  psql('CREATE SCHEMA IF NOT EXISTS undo_paths; CREATE TABLE IF NOT EXISTS undo_paths.ids (name text PRIMARY KEY, id uuid NOT NULL);');
  const applied = scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${CANDIDATE.replace('.sql', '')}';`) === '1';
  if (!applied) {
    const b = await runCases(seedSet(BEFORE_SET), `before${BEFORE_SET}`, BEFORE_SET);
    assert.ok(deadlocked(...b.case1.rs), `case 1 must deadlock on the two-pass lock today: ${b.case1.line}`);
    assert.ok(deadlocked(...b.case2.rs) || b.case2.rs.some((r) => /DELIVERY_ORDER_BUSY_RETRY/.test(r.out)), `case 2: today the void collides with the running completion (deadlock or busy-retry refusal): ${b.case2.line}`);
    if (b.case3.held === 'Q3') assert.ok(deadlocked(...b.case3.rs), `case 3 (void holds Q3 only) must deadlock: ${b.case3.line}`);
    else console.log(`[before] case3: the void visited P3 first on this plan (held ${b.case3.held}); no inversion to show`);
    assert.ok(b.case4.rs.every((r) => r.ok) && b.case4.created === '1' && b.case4.fWait !== 'Lock:advisory', `case 4: today the scheduler runs alongside the void: ${b.case4.line}`);
    assert.match(b.s5, /^ok\|NOT REFUSED new_deliveries=1/, `case 5: today a voided source with a pending row can still be scheduled: ${b.s5}`);
    assert.equal(b.s6, 'ok|true');
    console.log('ONE_LOCK_ORDER_BEFORE_PASS');
  }
  if (!HAVE_CANDIDATE) { console.log(`(no ${CANDIDATE} yet: AFTER cases skipped; ONE_LOCK_ORDER_PROOF_PASS not printed)`); return; }
  if (!applied) {
    const apply = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
      { input: readFileSync(candidatePath, 'utf8').replaceAll('\r\n', '\n'), allowFailure: true });
    assert.equal(apply.status, 0, `candidate failed:\n${apply.stdout}\n${apply.stderr}`);
    psql(`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${CANDIDATE.slice(0, 14)}', '${CANDIDATE.replace('.sql', '')}');`);
  }
  const a = await runCases(seedSet(AFTER_SET), `after${AFTER_SET}`, AFTER_SET);
  for (const c of ['case1', 'case2', 'case3', 'case4']) {
    assert.ok(!deadlocked(...a[c].rs), `${c} must not deadlock: ${a[c].line}`);
    assert.ok(a[c].rs.every((r) => r.ok), `${c}: both operations finish: ${a[c].line}`);
  }
  assert.equal(a.case1.zWait, 'Lock:advisory', 'case 1: the second completion waits its turn');
  assert.match(a.case1.line, /A rows=1 A=-12\.00 B=88\.00/, 'case 1: one A row (created at 0) down 5 + 7; B down 5 + 7 from 100');
  assert.equal(a.case2.vWait, 'Lock:advisory', 'case 2: the void waits its turn');
  assert.match(a.case2.line, new RegExp(`-> ${a.case2.expectP2.replace('.', '\\.')}$`), `case 2: P2 = start - 4 + 3: ${a.case2.line}`);
  assert.equal(a.case3.cWait, 'Lock:advisory', 'case 3: the completion waits its turn');
  assert.equal(a.case3.got, a.case3.expect, `case 3: P3 and Q3 = start + 4 (void) - 6 (completion): ${a.case3.line}`);
  assert.equal(a.case4.fWait, 'Lock:advisory', 'case 4: the scheduler waits for the void before reading anything');
  assert.equal(a.case4.created, '1', 'case 4: after the void commits, G4 is still a live completed delivery, so its follow-up is created');
  assert.match(a.s5, /FOLLOWUP_SOURCE_NOT_LIVE.* new_deliveries=0/, `case 5: a voided source is refused and nothing is written: ${a.s5}`);
  assert.equal(a.s6, 'ok|true', 'case 5b: the saved receipt is still answered');
  // Cases 6 (jobs, with #2170), 7 (batch cancel), 8 (per-entry fingerprints) and 9 (apply/reverse) land with the migration.
  console.log('ONE_LOCK_ORDER_AFTER_CASES_1_5_PASS');
}

main().then(() => { if (!reuse) removeContainer(); }, (e) => { console.error(e); if (!reuse) removeContainer(); process.exit(1); });
