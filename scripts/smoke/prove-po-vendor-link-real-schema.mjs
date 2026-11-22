#!/usr/bin/env node
/**
 * Real-schema proof for 20270214130000_po_vendor_link.sql (KI-144; contract
 * docs/plans/2026-11-22-ki144-po-vendor-link-CONTRACT.md; Mason 2026-11-22: "Keep original name").
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds vendors and POs (one closed), shows a rename
 * breaking a bill before the fix, applies the candidate (autocommit refused, POSTFLIGHT_OK, re-apply refused), then
 * checks the backfill, the trigger and the bill check through the real create_vendor_bill and save_purchase_order as the
 * signed-in admin. Every probe after the seed rolls back.
 *
 * Run: node scripts/smoke/prove-po-vendor-link-real-schema.mjs   (needs Docker; never touches live)
 * Prints PO_VENDOR_LINK_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, id, USERS, ROOT, NAME, docker, psql, scalar, claims } from './undo-paths/harness.mjs';

const CANDIDATE = '20270214130000_po_vendor_link.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const PROD = id('b1');
const [VA, VB, VD, VN] = ['e1', 'e2', 'e3', 'e4'].map(id);
const [PO1, PO2, PO3, PO4, PO5] = ['c1', 'c2', 'c3', 'c4', 'c5'].map(id);
let n = 0;
const bill = (vendor, po, cents = 5000) =>
  `public.create_vendor_bill(p_vendor_id => '${vendor}'::uuid, p_purchase_order_id => '${po}'::uuid, p_bill_number => 'KI144-${(n += 1)}', p_subtotal_cents => ${cents}, p_idempotency_key => 'ki144-${n}')`;
const billed = (vendor, po) => attempt(USERS.admin, `${asUser(`u := ${bill(vendor, po)};`)} v := (u IS NOT NULL)::text;`);
const billRefused = (vendor, po) => attempt(USERS.admin, `${refuse(`u := ${bill(vendor, po)};`)} v := t;`);
const link = (po) => `(SELECT coalesce(vendor_id::text, 'NULL') FROM public.purchase_orders WHERE id = '${po}')`;
const links = () => scalar(`SELECT string_agg(coalesce(vendor_id::text, 'NULL'), ',' ORDER BY id) FROM public.purchase_orders WHERE id IN ('${PO1}','${PO2}','${PO3}','${PO4}','${PO5}');`);
const RENAME_A = `UPDATE public.vendors SET name = 'KI144 Acme Supply Co' WHERE id = '${VA}';`;

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  // A = "KI144 Acme Supply"; B = "KI144 Bolt Chem" whose approved alias is ALSO "KI144 Acme Supply" (exact name must
  // win); D deleted; PO1 A (submitted), PO2 A with case/space noise, PO3 the deleted vendor, PO4 no vendor, PO5 B closed.
  psql(`BEGIN; ${claims(USERS.admin)}
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, inventory_unit, is_active)
      VALUES ('${PROD}', '[KI144] Chem', 'gal', 10.00, 15.00, 'liquid', 'Gal', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.vendors (id, name) VALUES ('${VA}', 'KI144 Acme Supply'), ('${VB}', 'KI144 Bolt Chem'), ('${VD}', 'KI144 Old Co');
    UPDATE public.vendors SET deleted_at = now() WHERE id = '${VD}';
    INSERT INTO public.vendor_aliases (vendor_id, alias_raw, alias_display, source, review_status, reviewed_at)
      VALUES ('${VB}', 'KI144 Acme Supply', 'KI144 Acme Supply', 'manual', 'approved', now());
    INSERT INTO public.purchase_orders (id, po_number, vendor, status, submitted_date, created_by, closed_at, closed_by, close_reason) VALUES
      ('${PO1}', 'KI144-PO-1', 'KI144 Acme Supply', 'submitted', CURRENT_DATE, '${USERS.admin}', NULL, NULL, NULL),
      ('${PO2}', 'KI144-PO-2', '  ki144 ACME supply ', 'submitted', CURRENT_DATE, '${USERS.admin}', NULL, NULL, NULL),
      ('${PO3}', 'KI144-PO-3', 'KI144 Old Co', 'submitted', CURRENT_DATE, '${USERS.admin}', NULL, NULL, NULL),
      ('${PO4}', 'KI144-PO-4', 'KI144 Nobody Inc', 'submitted', CURRENT_DATE, '${USERS.admin}', NULL, NULL, NULL),
      ('${PO5}', 'KI144-PO-5', 'KI144 Bolt Chem', 'closed', CURRENT_DATE, '${USERS.admin}', now(), '${USERS.admin}', 'short');
    INSERT INTO public.purchase_order_items (purchase_order_id, product_id, quantity_ordered, unit_cost, quantity_received, unit_size, product_name)
      SELECT po, '${PROD}', 10, 10.00, CASE WHEN po = '${PO5}' THEN 10 ELSE 0 END, 'gal', '[KI144] Chem'
        FROM unnest(ARRAY['${PO1}','${PO2}','${PO3}','${PO4}','${PO5}']::uuid[]) po;
    UPDATE public.purchase_orders SET total_cost = 100.00 WHERE id IN ('${PO1}','${PO2}','${PO3}','${PO4}','${PO5}');
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(status || ':' || total_cost_cents, ',' ORDER BY id) FROM public.purchase_orders WHERE id IN ('${PO1}','${PO5}');`),
    'submitted:10000,closed:10000');

  // Before: renaming A breaks billing A on its own PO; today's name check.
  assert.equal(billed(VA, PO1), 'ok|true', 'before: A bills its PO');
  assert.match(attempt(USERS.admin, `${RENAME_A} ${refuse(`u := ${bill(VA, PO1)};`)} v := t;`), /^ok\|VENDOR_PO_MISMATCH/, 'before: rename breaks the bill');
  console.log('[before] after renaming the vendor, a bill for it on its own PO was refused (VENDOR_PO_MISMATCH)');

  const feedBefore = scalar('SELECT count(*) FROM public.activity_feed;');
  const po5Before = scalar(`SELECT (to_jsonb(po) - 'vendor_id')::text FROM public.purchase_orders po WHERE id = '${PO5}';`);
  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  assert.equal(scalar(`SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.purchase_orders'::regclass AND attname = 'vendor_id';`), '0');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /PREFLIGHT_FAIL: purchase_orders.vendor_id already exists/, 're-apply must refuse');
  console.log('[apply] autocommit refused (nothing added), applied once with POSTFLIGHT_OK, re-apply refused');

  // Backfill: exact name beats B's alias; case/space noise links; deleted vendor and unknown text stay NULL; closed PO
  // linked with every other column, the guard and the activity feed unchanged.
  assert.equal(links(), [VA, VA, 'NULL', 'NULL', VB].join(','));
  assert.equal(scalar(`SELECT (to_jsonb(po) - 'vendor_id')::text FROM public.purchase_orders po WHERE id = '${PO5}';`), po5Before, 'closed PO otherwise unchanged');
  assert.equal(scalar('SELECT count(*) FROM public.activity_feed;'), feedBefore, 'backfill wrote no activity');
  assert.equal(scalar("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trigger_0_guard_closed_po';"), 'O');
  console.log('[backfill] exact name wins over another vendor\'s alias; noisy text linked; deleted/unknown stay NULL; closed PO linked, guard back on');

  // Bills.
  assert.match(attempt(USERS.admin, `${RENAME_A} ${asUser(`u := ${bill(VA, PO1)};`)} v := (u IS NOT NULL)::text || '|' ||
      (SELECT vendor FROM public.purchase_orders WHERE id = '${PO1}') || '|' || ${link(PO1)};`),
    new RegExp(`^ok\\|true\\|KI144 Acme Supply\\|${VA}$`), 'renamed vendor bills its old PO; PO keeps the original name and link');
  assert.equal(billRefused(VB, PO1),
    'ok|VENDOR_PO_MISMATCH: bill vendor "KI144 Bolt Chem" is not this purchase order\'s vendor "KI144 Acme Supply" (named "KI144 Acme Supply" on the PO)');
  assert.match(attempt(USERS.admin, `${RENAME_A} ${refuse(`u := ${bill(VB, PO1)};`)} v := t;`),
    /is not this purchase order's vendor "KI144 Acme Supply Co" \(named "KI144 Acme Supply" on the PO\)/, 'message names the current and printed names');
  // Unlinked PO: the old name rule, unchanged. A vendor created later with that name bills it; another vendor cannot.
  assert.equal(attempt(USERS.admin, `SET LOCAL session_replication_role = replica; INSERT INTO public.vendors (id, name) VALUES ('${VN}', 'KI144 Nobody Inc');
      SET LOCAL session_replication_role = origin; ${asUser(`u := ${bill(VN, PO4)};`)} v := (u IS NOT NULL)::text || '|' || ${link(PO4)};`), 'ok|true|NULL');
  assert.match(billRefused(VA, PO4), /^ok\|VENDOR_PO_MISMATCH: bill vendor "KI144 Acme Supply" does not match PO vendor "KI144 Nobody Inc"$/);
  console.log('[bill] renamed vendor bills its old PO (name on PO kept); other vendor refused naming both; unlinked PO keeps the name rule');

  // Trigger: insert, real save_purchase_order, text change, other edits, case-only edit after a rename, forged link.
  assert.equal(attempt(USERS.admin, `INSERT INTO public.purchase_orders (po_number, vendor, status, created_by, vendor_id)
      VALUES ('KI144-PO-6', 'KI144 Bolt Chem', 'draft', '${USERS.admin}', '${VA}') RETURNING coalesce(vendor_id::text, 'NULL') INTO v;`), `ok|${VB}`,
  'insert links from the text; a supplied vendor_id is overwritten');
  assert.equal(attempt(USERS.admin, `${asUser(`r := public.save_purchase_order(NULL, '{"vendor":"KI144 Bolt Chem","status":"draft"}'::jsonb,
      '[{"product_id":"${PROD}","product_name":"[KI144] Chem","unit_size":"gal","quantity_ordered":2,"unit_cost_cents":1000}]'::jsonb, '${USERS.admin}', 'ki144-save-1');`)}
      v := (SELECT coalesce(po.vendor_id::text, 'NULL') FROM public.purchase_orders po WHERE po.po_number = r->>'po_number' OR po.id::text = coalesce(r->>'po_id', r->>'id'));`),
  `ok|${VB}`, 'the real PO save links the vendor');
  assert.equal(attempt(USERS.admin, `UPDATE public.purchase_orders SET vendor = 'KI144 Bolt Chem' WHERE id = '${PO1}'; v := ${link(PO1)};
      UPDATE public.purchase_orders SET notes = 'x' WHERE id = '${PO1}'; v := v || ',' || ${link(PO1)};
      UPDATE public.purchase_orders SET vendor_id = '${VA}' WHERE id = '${PO1}'; v := v || ',' || ${link(PO1)};`),
  `ok|${VB},${VB},${VB}`, 'text change follows; other edit keeps; forged link overwritten');
  assert.equal(attempt(USERS.admin, `${RENAME_A} UPDATE public.purchase_orders SET vendor = 'ki144 acme  SUPPLY' WHERE id = '${PO1}';
      v := ${link(PO1)} || '|' || (SELECT vendor FROM public.purchase_orders WHERE id = '${PO1}');`),
  `ok|${VA}|ki144 acme  SUPPLY`, 'case/space-only edit after a rename keeps the link');
  // Closed PO: a forged link change is put back before the guard compares the row; a real edit is still refused.
  assert.equal(attempt(USERS.admin, `UPDATE public.purchase_orders SET vendor_id = '${VA}', updated_at = now() WHERE id = '${PO5}'; v := ${link(PO5)};`),
    `ok|${VB}`);
  assert.match(attempt(USERS.admin, `UPDATE public.purchase_orders SET notes = 'x' WHERE id = '${PO5}'; v := 'NOT REFUSED';`), /PO_CLOSED/);
  console.log('[trigger] insert and real save link; text change follows; notes/forged link/case-only edit keep it; closed PO guard intact');

  // Access: the table's standing read grants (anon has no row policy, so no rows); never writable by signed-in users.
  assert.equal(scalar(`SELECT has_column_privilege('authenticated', 'public.purchase_orders', 'vendor_id', 'SELECT')::text || has_column_privilege('authenticated', 'public.purchase_orders', 'vendor_id', 'UPDATE')::text || has_column_privilege('anon', 'public.purchase_orders', 'vendor_id', 'SELECT')::text;`),
    'truefalsetrue');
  assert.match(attempt(USERS.rep, `${refuse(`u := ${bill(VA, PO1)};`)} v := t;`), /NOT_AUTHORIZED/);
  console.log('[access] vendor_id has the standard PO column read grants (anon sees no rows), not writable; a rep still cannot create a bill');

  console.log('\nPO_VENDOR_LINK_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
