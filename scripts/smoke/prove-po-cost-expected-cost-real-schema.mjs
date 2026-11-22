#!/usr/bin/env node
/**
 * Real-schema proof for 20270214100000_po_cost_expected_cost_check.sql (KI-197;
 * contract docs/plans/2026-11-22-ki197-po-cost-stale-screen-CONTRACT.md).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), proves the candidate's body is the pinned old body plus
 * only the KI-197 blocks, applies it (autocommit refused, POSTFLIGHT_OK, re-apply refused), then as the signed-in
 * user (role authenticated) checks the contract's cases. Every probe rolls back except the two-session race at the end.
 *
 * Run: node scripts/smoke/prove-po-cost-expected-cost-real-schema.mjs   (needs Docker; never touches live)
 * Prints PO_COST_EXPECTED_COST_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, signIn, id, USERS, ROOT, NAME, docker, psql, scalar, claims } from './undo-paths/harness.mjs';

const CANDIDATE = '20270214100000_po_cost_expected_cost_check.sql';
const MIG = path.join(ROOT, 'supabase', 'migrations');
const candidate = readFileSync(path.join(MIG, CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const [PROD, PROD_B] = ['b1', 'b2'].map(id);
const [PO1, PO2, PO3] = ['c1', 'c2', 'c3'].map(id);
const [L1, L2, L3, L4, L5] = ['d1', 'd2', 'd3', 'd4', 'd5'].map(id);
const ADMIN2 = id('a5');

// One call of the function under test. `items`: JS array, serialized as the browser would.
const setCosts = (po, items, key, reason = null) =>
  `public.set_purchase_order_item_costs('${po}'::uuid, '${JSON.stringify(items)}'::jsonb, ${reason === null ? 'NULL' : `'${reason}'`}, NULL, '${key}')`;
const cents = (line) => `(SELECT unit_cost_cents FROM public.purchase_order_items WHERE id = '${line}')`;
const flag = (line) => `(SELECT cost_needs_review FROM public.purchase_order_items WHERE id = '${line}')`;
const total = (po) => `(SELECT total_cost_cents FROM public.purchase_orders WHERE id = '${po}')`;
// Admin corrections and confirms only (the seed's own inserts log 'entered' / 'catalog_default' rows).
const hist = (po) => `(SELECT count(*) FROM public.purchase_order_item_cost_changes WHERE purchase_order_id = '${po}' AND source IN ('set_by_admin', 'confirmed'))`;
const feed = (po) => `(SELECT count(*) FROM public.activity_feed WHERE related_entity_id = '${po}')`;
const snapshot = (po) => `concat_ws(',', ${cents(L1)}, ${cents(L2)}, ${cents(L3)}, ${flag(L3)}, ${total(po)}, ${hist(po)}, ${feed(po)})`;
const STALE = 'PO_COST_CHANGED_SINCE_LOADED: someone changed a line\'s cost after this screen loaded it; nothing was saved. Reload and check the new cost.';
const INVALID = 'PO_EXPECTED_COST_INVALID: expected_unit_cost_cents must be a whole number of cents';

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  const seeded = scalar(`SELECT count(*) FROM public.purchase_orders WHERE id = '${PO1}';`) === '1';
  if (!seeded) {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN2}', 'undo-admin2@example.invalid', '{"full_name":"[KI197] Admin 2","role":"admin"}'::jsonb) ON CONFLICT DO NOTHING;`);
  // Products with a catalog cost (the rep trigger prices a rep's line from it); pricing governance off for the seed only.
  psql(`BEGIN; ${claims(USERS.admin)}
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, inventory_unit, is_active) VALUES
      ('${PROD}', '[KI197] Chem', 'gal', 7.00, 12.00, 'liquid', 'Gal', true),
      ('${PROD_B}', '[KI197] Chem B', 'gal', 9.50, 14.00, 'liquid', 'Gal', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.purchase_orders (id, po_number, vendor, status, submitted_date, created_by) VALUES
      ('${PO1}', 'KI197-PO-1', 'Acme', 'submitted', CURRENT_DATE - 2, '${USERS.admin}'),
      ('${PO2}', 'KI197-PO-2', 'Acme', 'submitted', CURRENT_DATE - 1, '${USERS.admin}'),
      ('${PO3}', 'KI197-PO-3', 'Beta', 'submitted', CURRENT_DATE - 1, '${USERS.admin}');
    INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, quantity_ordered, unit_cost, quantity_received, unit_size, product_name) VALUES
      ('${L1}', '${PO1}', '${PROD}', 5, 10.00, 0, 'gal', '[KI197] Chem'),
      ('${L2}', '${PO1}', '${PROD_B}', 4, 20.00, 0, 'gal', '[KI197] Chem B'),
      ('${L4}', '${PO2}', '${PROD_B}', 10, 9.50, 5, 'gal', '[KI197] Chem B'),
      ('${L5}', '${PO3}', '${PROD}', 1, 5.00, 0, 'gal', '[KI197] Chem');
    COMMIT;`);
  // A rep's line: priced and flagged by the rep trigger (signed in as the rep, no API role needed for the seed).
  psql(`BEGIN; ${claims(USERS.rep)}
    INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, quantity_ordered, unit_cost, quantity_received, unit_size, product_name)
      VALUES ('${L3}', '${PO1}', '${PROD}', 2, 99.00, 0, 'gal', '[KI197] Chem');
    COMMIT;`);
  psql(`BEGIN; ${claims(USERS.admin)}
    UPDATE public.purchase_orders SET total_cost = 140.00 WHERE id = '${PO1}';
    UPDATE public.purchase_orders SET total_cost = 95.00, status = 'partially_received' WHERE id = '${PO2}';
    UPDATE public.purchase_orders SET total_cost = 5.00, status = 'cancelled' WHERE id = '${PO3}';
    COMMIT;`);
  }
  assert.equal(scalar(`SELECT string_agg(unit_cost_cents || ':' || cost_needs_review, ',' ORDER BY id) FROM public.purchase_order_items WHERE purchase_order_id = '${PO1}';`),
    '1000:false,2000:false,700:true', 'seed: two admin lines and one flagged rep line at catalog cost');
  assert.equal(scalar(`SELECT string_agg(status || ':' || total_cost_cents, ',' ORDER BY id) FROM public.purchase_orders WHERE id IN ('${PO1}','${PO2}','${PO3}');`),
    'submitted:14000,partially_received:9500,cancelled:500');
  const base = scalar(`SELECT ${snapshot(PO1)};`);
  console.log(`[seed] PO1 lines 1000/2000/700(rep, flagged), total 14000; received PO2; cancelled PO3 (snapshot ${base})`);

  // 0. The candidate body = the pinned 20261021140000 body + only the KI-197 lines.
  const oldFile = readFileSync(path.join(MIG, '20261021140000_po_cost_admin_only_and_corrections.sql'), 'utf8').replaceAll('\r\n', '\n');
  const fnOf = (text, head) => text.slice(text.indexOf(head), text.indexOf('$function$;', text.indexOf(head)));
  const oldLines = fnOf(oldFile, 'CREATE FUNCTION public.set_purchase_order_item_costs(').split('\n').slice(1);
  const newLines = fnOf(candidate, 'CREATE OR REPLACE FUNCTION public.set_purchase_order_item_costs(').split('\n').slice(1);
  const added = [...newLines];
  const OLD_SELECT = '    SELECT poi.id, poi.unit_cost_cents, poi.quantity_received, poi.cost_needs_review INTO v_line';
  for (const line of oldLines) {
    const at = added.indexOf(line === OLD_SELECT ? `${OLD_SELECT.replace(' INTO v_line', '')}, poi.product_id INTO v_line` : line);
    assert.ok(at >= 0, `old line missing from the new body: ${line}`);
    added.splice(at, 1);
  }
  assert.ok(added.every((l) => l.trim() === '' || /expected|KI-197|SQL does not promise|follow-up makes|replace a newer cost|reads as 0|PO_COST_CHANGED|USING ERRCODE|END IF;|RAISE EXCEPTION 'PO_EXPECTED|v_line\.product_id|\[0-9a-f\]/.test(l)),
    `unexpected added lines:\n${added.filter((l) => l.trim()).join('\n')}`);
  console.log(`[body] new body = old body + ${added.filter((l) => l.trim()).length} KI-197 lines`);

  // Apply: autocommit refused, once in a transaction, a second time refused by the md5 pin.
  if (scalar("SELECT count(*) FROM pg_proc WHERE proname = 'set_purchase_order_item_costs' AND prosrc LIKE '%PO_COST_CHANGED_SINCE_LOADED%';") === '0') {
  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /PREFLIGHT_FAIL: set_purchase_order_item_costs changed since/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');
  }

  const ok = (body, expected, msg) => assert.equal(attempt(USERS.admin, body), `ok|${expected}`, msg);

  // 1. Matching expected: saved as today.
  ok(`${asUser(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1100, expected_unit_cost_cents: 1000 }], 'k1')};`)}
    v := (r->>'lines_changed') || '|' || ${snapshot(PO1)};`,
  `1|1100,2000,700,t,${5 * 1100 + 4 * 2000 + 2 * 700},1,1`, 'matching expected saves, one history row, total follows');
  console.log('[match] expected = stored -> saved, one history row, total recomputed');

  // 2. Stale, the stale line LAST after an earlier change and an earlier confirm: nothing at all changes.
  ok(`${asUser(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1200, expected_unit_cost_cents: 1000 }], 'k2a')};`)}
    ${signIn(ADMIN2)} f0 := ${snapshot(PO1)};
    ${refuse(`r := ${setCosts(PO1, [
      { id: L2, unit_cost_cents: 2100, expected_unit_cost_cents: 2000 },
      { id: L3, unit_cost_cents: 700, expected_unit_cost_cents: 700 },
      { id: L1, unit_cost_cents: 1100, expected_unit_cost_cents: 1000 }], 'k2b')};`)}
    v := t || '|' || (f0 = ${snapshot(PO1)})::text || '|' || f0;`,
  `${STALE}|true|1200,2000,700,t,${5 * 1200 + 4 * 2000 + 2 * 700},1,1`,
  'a stale line refuses the whole call; the earlier change and confirm are not saved');
  ok(`${asUser(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1200, expected_unit_cost_cents: 1000 }], 'k2c')};`)}
    f0 := ${snapshot(PO1)};
    ${refuse(`r := ${setCosts(PO1, [
      { id: L1, unit_cost_cents: 1100, expected_unit_cost_cents: 1000 },
      { id: L2, unit_cost_cents: 2100, expected_unit_cost_cents: 2000 }], 'k2d')};`)}
    v := t || '|' || (f0 = ${snapshot(PO1)})::text;`,
  `${STALE}|true`, 'a stale FIRST line refuses the whole call; the later matching line is not saved');
  console.log('[stale] stale line last or first -> PO_COST_CHANGED_SINCE_LOADED; cents, flag, total, history, activity unchanged');

  // 2b. Sol round 1: Edit Purchase Order swapped the line's product in place (same id, same cost). A correction made
  //     for the product the admin saw is refused; the cost of the new product is not touched.
  const SWAP = 'PO_COST_CHANGED_SINCE_LOADED: someone changed a line\'s product after this screen loaded it; nothing was saved. Reload and check the line.';
  ok(`SET LOCAL session_replication_role = replica;
    UPDATE public.purchase_order_items SET product_id = '${PROD_B}' WHERE id = '${L1}';
    SET LOCAL session_replication_role = origin;
    ${refuse(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1200, expected_unit_cost_cents: 1000, expected_product_id: PROD }], 'k2e')};`)}
    v := t || '|' || ${cents(L1)};
    ${asUser(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1200, expected_unit_cost_cents: 1000, expected_product_id: PROD_B }], 'k2f')};`)}
    v := v || '|' || ${cents(L1)};`,
  `${SWAP}|1000|1200`, 'a swapped product refuses; the product the line now holds saves');
  for (const bad of ['123', '"not-a-uuid"', 'null', 'true']) {
    const sql = `public.set_purchase_order_item_costs('${PO1}'::uuid, '[{"id":"${L1}","unit_cost_cents":1100,"expected_product_id":${bad}}]'::jsonb, NULL, NULL, 'k2g')`;
    ok(`${refuse(`r := ${sql};`)} v := t || '|' || ${cents(L1)};`,
      'PO_EXPECTED_PRODUCT_INVALID: expected_product_id must be a product id|1000', `expected_product_id ${bad} must be refused`);
  }
  console.log('[swap] product swapped in place -> refused, cost unchanged; matching product saves; bad product ids refused');

  // 3. Another admin already set the requested cost: still refused (expected $10, requested $11, stored $11).
  ok(`${asUser(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1100 }], 'k3a')};`)}
    ${refuse(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1100, expected_unit_cost_cents: 1000 }], 'k3b')};`)}
    v := t || '|' || ${hist(PO1)};`, `${STALE}|1`, 'stale request for the already-stored cost is refused');
  console.log('[same-target] expected 1000, requested 1100, stored 1100 -> refused');

  // 4. No expected field (older screen): saved as today.
  ok(`${asUser(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1300 }], 'k4')};`)} v := (r->>'lines_changed') || '|' || ${cents(L1)};`,
    '1|1300', 'absent expected = old behavior');
  console.log('[legacy] no expected field -> saved');

  // 5. Rep line confirm: stale expected refused (flag stays), matching confirms.
  ok(`${refuse(`r := ${setCosts(PO1, [{ id: L3, unit_cost_cents: 700, expected_unit_cost_cents: 650 }], 'k5a')};`)}
    t2 := t || '|' || ${flag(L3)};
    ${asUser(`r := ${setCosts(PO1, [{ id: L3, unit_cost_cents: 700, expected_unit_cost_cents: 700 }], 'k5b')};`)}
    v := t2 || '|' || (r->>'lines_confirmed') || '|' || ${flag(L3)} || '|' ||
      (SELECT source FROM public.purchase_order_item_cost_changes WHERE purchase_order_item_id = '${L3}' ORDER BY created_at DESC LIMIT 1);`,
  `${STALE}|true|1|false|confirmed`, 'stale confirm refused; matching confirm clears the flag');
  console.log('[confirm] stale confirm refused (flag kept); matching confirm -> confirmed');

  // 6. Invalid expected values, each refused by name before anything is saved; 1000.0 is a whole number.
  for (const bad of ['"1000"', 'null', '10.5', '-1', '9007199254740992', '1e400', 'true', '[1000]', '{"c":1}']) {
    const sql = `public.set_purchase_order_item_costs('${PO1}'::uuid, '[{"id":"${L1}","unit_cost_cents":1100,"expected_unit_cost_cents":${bad}}]'::jsonb, NULL, NULL, 'k6')`;
    ok(`${refuse(`r := ${sql};`)} v := t || '|' || ${cents(L1)};`, `${INVALID}|1000`, `expected ${bad} must be refused`);
  }
  ok(`${asUser(`r := public.set_purchase_order_item_costs('${PO1}'::uuid, '[{"id":"${L1}","unit_cost_cents":1100,"expected_unit_cost_cents":1000.0}]'::jsonb, NULL, NULL, 'k6b');`)}
    v := ${cents(L1)};`, '1100', '1000.0 is accepted as 1000');
  console.log('[invalid] string, null, fraction, negative, too large, 1e400, boolean, array, object refused; 1000.0 accepted');

  // 7. Replay after the cost moved returns the first result; the same key with only expected changed is refused.
  ok(`${asUser(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1100, expected_unit_cost_cents: 1000 }], 'k7')};`)}
    ${asUser(`r2 := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1400, expected_unit_cost_cents: 1100 }], 'k7b')};`)}
    ${asUser(`r3 := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1100, expected_unit_cost_cents: 1000 }], 'k7')};`)}
    ${refuse(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1100, expected_unit_cost_cents: 999 }], 'k7')};`)}
    v := (r3 = r)::text || '|' || ${cents(L1)} || '|' || ${hist(PO1)} || '|' || (t ~ '^IDEMPOTENCY_')::text;`,
  'true|1400|2|true', 'replay returns the first result; a changed expectation under the same key is refused');
  console.log('[replay] same key after the cost moved -> first result, no new history; same key, other expected -> refused');

  // 8. Two admins, different lines, both baselines right: both saved, total includes both.
  ok(`${asUser(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1100, expected_unit_cost_cents: 1000 }], 'k8a')};`)}
    ${signIn(ADMIN2)}
    ${asUser(`r2 := ${setCosts(PO1, [{ id: L2, unit_cost_cents: 2100, expected_unit_cost_cents: 2000 }], 'k8b')};`)}
    v := ${cents(L1)} || ',' || ${cents(L2)} || ',' || ${total(PO1)} || ',' || ${hist(PO1)};`,
  `1100,2100,${5 * 1100 + 4 * 2100 + 2 * 700},2`, 'disjoint lines both save');
  console.log('[disjoint] two admins, two lines -> both saved, total includes both');

  // 9. Existing controls still apply with a matching expectation.
  ok(`${refuse(`r := ${setCosts(PO2, [{ id: L4, unit_cost_cents: 1000, expected_unit_cost_cents: 950 }], 'k9a')};`)}
    t2 := t;
    ${asUser(`r := ${setCosts(PO2, [{ id: L4, unit_cost_cents: 1000, expected_unit_cost_cents: 950 }], 'k9b', 'vendor invoice price')};`)}
    v := t2 || '|' || ${cents(L4)};`,
  'PO_COST_REASON_REQUIRED: say why the cost of a received line is changing|1000', 'received line still needs a reason');
  ok(`${refuse(`r := ${setCosts(PO3, [{ id: L5, unit_cost_cents: 600, expected_unit_cost_cents: 500 }], 'k9c')};`)} v := t;`,
    'PO_CANCELLED: cannot change cost on a cancelled purchase order', 'cancelled PO still refused');
  for (const [uid, who] of [[USERS.rep, 'sales rep'], [USERS.driver, 'driver']]) {
    assert.match(attempt(uid, `${refuse(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1, expected_unit_cost_cents: 1000 }], 'k9d')};`)} v := t || '|' || ${cents(L1)};`),
      /^ok\|.*\|1000$/, `${who} must be refused`);
    assert.doesNotMatch(attempt(uid, `${refuse(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1, expected_unit_cost_cents: 1000 }], 'k9d')};`)} v := t;`), /NOT REFUSED/);
  }
  assert.equal(scalar(`SELECT has_function_privilege('anon', 'public.set_purchase_order_item_costs(uuid,jsonb,text,uuid,text)', 'EXECUTE')::text;`), 'false');
  console.log('[controls] received line needs a reason; cancelled PO refused; rep and driver refused; anon cannot execute');

  // 10. Race: session A holds the lock with a committed-later change; session B starts from the same baseline,
  //     waits on the lock, then reads A's committed cost and is refused. Real separate connections.
  // Session A's script is copied into the container and run with -f, so no stdin has to stream while this process
  // blocks on session B (a streamed stdin stalled A mid-transaction).
  const raceFile = path.join(tmpdir(), `${NAME}-race-a.sql`);
  writeFileSync(raceFile, `BEGIN; ${claims(USERS.admin)} SET LOCAL ROLE authenticated;
    SELECT ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1500, expected_unit_cost_cents: 1000 }], `race-a-${Date.now()}`)};
    RESET ROLE; SELECT pg_sleep(4); COMMIT;`, 'utf8');
  try { docker(['cp', raceFile, `${NAME}:/tmp/race-a.sql`]); } finally { unlinkSync(raceFile); }
  const sessionA = spawn('docker', [...PSQL, '-f', '/tmp/race-a.sql'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  let aErr = '';
  sessionA.stderr.on('data', (d) => { aErr += d; });
  const aDone = new Promise((resolve) => sessionA.on('close', resolve));
  // Wait until A holds the advisory lock, then start B.
  for (let i = 0; i < 100 && scalar("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 73492009 AND granted;") !== '1'; i += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.equal(scalar("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 73492009 AND granted;"), '1', 'session A never took the lock');
  assert.equal(sessionA.exitCode, null, 'session A must still hold the lock when session B starts');
  const b = attempt(ADMIN2, `${refuse(`r := ${setCosts(PO1, [{ id: L1, unit_cost_cents: 1100, expected_unit_cost_cents: 1000 }], `race-b-${Date.now()}`)};`)} v := t || '|' || ${cents(L1)};`);
  const aCode = await aDone;
  assert.equal(aCode, 0, `session A failed: ${aErr}`);
  assert.equal(b, `ok|${STALE}|1500`, 'the waiting session reads the committed winner and is refused');
  assert.equal(scalar(`SELECT ${cents(L1)} || ':' || (SELECT count(*) FROM public.purchase_order_item_cost_changes WHERE purchase_order_item_id = '${L1}' AND changed_by = '${USERS.admin}' AND source = 'set_by_admin');`), '1500:1');
  console.log('[race] two real sessions: one winner (1500, one history row), the waiting one refused');

  // The registered smoke chain (rolled back).
  const smoke = docker([...PSQL], { input: readFileSync(path.join(ROOT, 'scripts', 'smoke', 'smoke-po-cost-expected-cost.sql'), 'utf8'), allowFailure: true });
  assert.match(smoke.stderr, /SMOKE_PASS_ROLLBACK/, `smoke chain failed:
${smoke.stderr}`);
  console.log('[smoke] smoke-po-cost-expected-cost.sql -> SMOKE_PASS_ROLLBACK');

  console.log('PO_COST_EXPECTED_COST_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
