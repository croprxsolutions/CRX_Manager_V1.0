#!/usr/bin/env node
/**
 * Real-schema proof for 20270201140000_adjust_inventory_key_printable_only.sql (#1912). Builds the checked-in
 * baseline plus every post-baseline migration on this checkout (the candidate included, so its preflight and
 * postflight ran) in a network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds one
 * stock row, and calls adjust_inventory as the signed-in admin:
 *   1. an app-shaped key ('adjust_inventory:<user>:<uuid>') and a batch row key ('<batch key>:<inventory id>')
 *      adjust stock; a same-key retry returns the first answer and writes nothing more;
 *   2. keys with a newline, tab, control character, space or non-ASCII letter, a blank key and NULL are refused
 *      with IDEMPOTENCY_KEY_REQUIRED, and nothing changes (no stock, ledger or receipt row);
 *   3. follow-up 20270224220000: no public function keeps the weak check, and each of the 20 functions with the
 *      strict check refuses a newline key, while a normal key gets past the key check (rolled back);
 *   4. a second apply of either migration is refused by its preflight;
 *   5. the registered full adjust_inventory chain passes on the new body, and a sales rep removes a customer document
 *      with a normal key (replay returns the same answer) while a newline key is refused.
 *
 * Run: node scripts/smoke/prove-adjust-inventory-key-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a built database: UNDO_PATHS_CONTAINER=<name> ADJUST_KEY_PROOF_REUSE=1 (left running).
 * Prints ADJUST_INVENTORY_KEY_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, scalar, attempt, asUser, refuse, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270201140000_adjust_inventory_key_printable_only.sql';
const FOLLOW_UP = '20270224220000_idempotency_keys_printable_only.sql';
const EXPECTED_STRICT_FUNCTIONS = [
  '_section9_create_vendor_bill_cumulative_impl',
  '_section9_receive_po_items_intent_impl_20260831',
  '_section9_record_vendor_payment_intent_impl_20260831',
  '_section9_update_vendor_bill_intent_impl_20260831',
  '_section9_void_vendor_bill_intent_impl_20260831',
  'adjust_inventory',
  'approve_return',
  'cancel_return',
  'create_commission_payment',
  'create_inventory_hold',
  'create_return',
  'create_vendor_bill',
  'issue_return_credit',
  'post_commission_payment',
  'receive_return',
  'reject_return',
  'reverse_receiving_record',
  'soft_delete_customer_document',
  'void_commission_payment',
  'void_vendor_payment',
];
const reuse = process.env.ADJUST_KEY_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PROD = '7c7a0000-0000-4000-8000-000019120001';
const INV = '7c7a0000-0000-4000-8000-000019120002';
const { admin: ADMIN } = USERS;
const APP_KEY = `adjust_inventory:${ADMIN}:0b6f8a52-4e3c-4a8e-9f2a-1d2c3b4a5e6f`;
const BATCH_KEY = `adjust_inventory_batch:${ADMIN}:5d1e2f3a-6b7c-4d8e-9fa0-b1c2d3e4f5a6:${INV}`;

const state = `(SELECT (SELECT quantity_available::text FROM public.inventory WHERE id = '${INV}')
  || '/ledger=' || (SELECT count(*) FROM public.inventory_transactions WHERE product_id = '${PROD}')
  || '/receipts=' || (SELECT count(*) FROM public.idempotency_keys WHERE operation = 'adjust_inventory'))`;
const adjust = (keySql) => `public.adjust_inventory('${INV}', 1, '[1912] key check', '${ADMIN}', ${keySql})`;
const show = (label, got) => { console.log(`[adjust-key] ${label}: ${got}`); return got; };

try {
  if (!reuse) { buildContainer(); seedUsers(); }
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${path.basename(CANDIDATE, '.sql')}';`), '1',
    'the candidate must have replayed (its preflight and postflight passed)');
  if (scalar(`SELECT count(*) FROM public.inventory WHERE id = '${INV}';`) === '0') {
    const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], { allowFailure: true, input: `
INSERT INTO public.products (id, product_name, is_active, product_form, inventory_unit) VALUES ('${PROD}', '[1912] product', true, 'liquid', 'Gal');
INSERT INTO public.inventory (id, product_id, location, quantity_available, quantity_prebooked, quantity_on_order) VALUES ('${INV}', '${PROD}', 'Main Warehouse', 10, 0, 0);` });
    assert.equal(r.status, 0, `seed failed:\n${r.stderr}`);
  }
  // The customer-document chain discovers two active reps, each with an active customer of their own.
  const REP2 = '7c7a0000-0000-4000-8000-000019120003';
  if (scalar(`SELECT count(*) FROM public.customers WHERE assigned_sales_rep = '${REP2}';`) === '0') {
    const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], { allowFailure: true, input: `
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${REP2}', 'adjust-key-rep2@example.invalid', '{"full_name":"[1912] Rep Two","role":"sales_rep"}'::jsonb);
INSERT INTO public.customers (id, farm_name, assigned_sales_rep, is_active) VALUES
  ('7c7a0000-0000-4000-8000-000019120004', '[1912] Rep Farm', '${USERS.rep}', true),
  ('7c7a0000-0000-4000-8000-000019120005', '[1912] Rep Two Farm', '${REP2}', true);` });
    assert.equal(r.status, 0, `rep/customer seed failed:\n${r.stderr}`);
  }

  // 1. Real app key shapes work; a same-key retry replays the first answer and writes nothing more.
  const c1 = show('normal keys', attempt(ADMIN, `
    f0 := ${state};
    ${asUser(`r := ${adjust(`'${APP_KEY}'`)};`)} f1 := ${state};
    ${asUser(`r2 := ${adjust(`'${APP_KEY}'`)};`)} f2 := ${state};
    ${asUser(`r3 := ${adjust(`'${BATCH_KEY}'`)};`)}
    v := f0 || ' -> ' || f1 || '|replay_same=' || (r = r2) || '|after_replay=' || f2 || '|batch=' || (r3->>'status') || '|end=' || ${state};`));
  assert.match(c1, /^ok\|10(\.0+)?\/ledger=0\/receipts=0 -> 11(\.0+)?\/ledger=1\/receipts=1\|replay_same=true\|after_replay=11(\.0+)?\/ledger=1\/receipts=1\|batch=adjusted\|end=12(\.0+)?\/ledger=2\/receipts=2$/);

  // 2. Every key with a character outside printable ASCII, a blank key and NULL is refused; nothing changes.
  const BAD = {
    newline: `'abc' || E'\\n'`,
    tab: `E'abc\\tdef'`,
    control: `E'abc\\x01'`,
    'carriage return': `E'abc\\r'`,
    space: `'abc def'`,
    'non-ASCII': `'cl' || chr(233)`,
    'newline after app key': `'${APP_KEY}' || E'\\n'`,
    blank: `'   '`,
    null: 'NULL',
  };
  for (const [label, keySql] of Object.entries(BAD)) {
    const got = show(`refuse ${label}`, attempt(ADMIN, `f0 := ${state}; ${refuse(`r := ${adjust(keySql)};`)}
      v := t || '|unchanged=' || (f0 = ${state});`));
    assert.equal(got, 'ok|IDEMPOTENCY_KEY_REQUIRED: adjust_inventory requires p_idempotency_key|unchanged=true', label);
  }

  // 3. Follow-up (20270224220000): no public function keeps the weak check, and each of the 20 functions with the
  //    strict check refuses 'abc' + newline with IDEMPOTENCY_KEY_REQUIRED, while the same call with a normal key
  //    gets past the key check (it fails later on the dummy arguments, or not at all). Every other argument is
  //    NULL except: the actor arguments (signed-in admin), a reason, and hold type 'manual', so earlier checks pass.
  //    Rolled back.
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%COLLATE "C" !~ ''[!-~]''%';`), '0',
    'no public function may keep the weak key check');
  const probe = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: `BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
DO $p$
DECLARE f record; v_args text; v_out text; v_bad text; k text; v_state text; v_bad_state text;
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text AS sig, p.proname, p.proargnames, p.pronargs, p.proargtypes::oid[] AS types
             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%COLLATE "C" ~ ''[^!-~]''%' ORDER BY 1
  LOOP
    FOREACH k IN ARRAY ARRAY['abc' || E'\\n', 'proof:' || gen_random_uuid()] LOOP
      SELECT string_agg(CASE
          WHEN f.proargnames[i] = 'p_idempotency_key' THEN quote_literal(k)
          WHEN f.proargnames[i] ~ '(_by|^p_actor_id)$' THEN quote_literal('${ADMIN}') || '::uuid'
          WHEN f.proargnames[i] ~ 'reason' THEN '''[1912] proof reason'''
          WHEN f.proargnames[i] = 'p_hold_type' THEN '''manual'''
          ELSE 'NULL::' || format_type(f.types[i - 1], NULL) END, ', ' ORDER BY i)
        INTO v_args FROM generate_series(1, f.pronargs) i;
      v_state := NULL;
      BEGIN
        EXECUTE format('SELECT public.%I(%s)', f.proname, v_args);
        v_out := 'returned';
      EXCEPTION WHEN OTHERS THEN v_out := SQLERRM; v_state := SQLSTATE;
      END;
      IF v_bad IS NULL THEN v_bad := v_out; ELSE
        -- A normal key passes only when it gets past the key check AND does not die of a structural error
        -- (class 42 syntax/undefined object, XX internal), which a broken body would raise.
        RAISE NOTICE 'PROBE|%|%|%', f.sig, v_bad LIKE 'IDEMPOTENCY_KEY_REQUIRED%',
          (v_out NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' AND coalesce(v_state, '00000') !~ '^(42|XX)');
        RAISE NOTICE 'OUTCOME|%|%|%', f.sig, coalesce(v_state, 'returned'), left(v_out, 80);
        v_bad := NULL;
      END IF;
    END LOOP;
  END LOOP;
END $p$;
ROLLBACK;` });
  const probes = [...probe.stderr.matchAll(/PROBE\|([^|]+)\|(\w+)\|(\w+)/g)].map((m) => [m[1], m[2], m[3]]);
  for (const [sig, bad, good] of probes) console.log(`[adjust-key] ${sig}: newline key refused=${bad}, normal key passes key check=${good}`);
  for (const m of probe.stderr.matchAll(/OUTCOME\|([^|]+)\|([^|]*)\|(.*)/g)) console.log(`[adjust-key] ${m[1]}: normal-key outcome ${m[2]} ${m[3]}`);
  assert.equal(probes.length, 20, 'expected 20 functions with the strict check (adjust_inventory + 19)');
  assert.deepEqual(probes.map(([sig]) => sig.replace(/\(.*$/, '').replace('public.', '')).sort(), EXPECTED_STRICT_FUNCTIONS, 'the set of functions with the strict check must be exactly the 20 named');
  assert.deepEqual(probes.filter(([, bad, good]) => bad !== 't' || good !== 't'), [], 'every function must refuse only the bad key');

  // 3b. The return sweep pins each return wrapper's exact body; its re-pinned hashes match the new bodies.
  const returnSweep = readFileSync(path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'return-credit-intent-binding.sql'), 'utf8').replace(/;\s*$/, '');
  const flagged = show('return-credit-intent-binding rows', scalar(`SELECT count(*) FROM (${returnSweep}) s;`));
  assert.equal(flagged, '0', 'the return sweep must pass on the new bodies');

  // 4. A second apply of either migration is refused by its preflight.
  const follow = readFileSync(path.join(ROOT, 'supabase', 'migrations', FOLLOW_UP), 'utf8').replaceAll('\r\n', '\n');
  for (const [file, sql, marker] of [[CANDIDATE, candidate, /ADJUST_INVENTORY_KEY_1912_BASELINE_DRIFT/], [FOLLOW_UP, follow, /IDEM_KEY_PRINTABLE_1912_BASELINE_DRIFT/]]) {
    const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], { input: sql, allowFailure: true });
    assert.notEqual(again.status, 0, `a second apply of ${file} must be refused`);
    assert.match(again.stderr, marker);
    console.log(`[adjust-key] second apply of ${file} refused by the preflight`);
  }
  // 4b. An unexpired receipt under a key the new rule refuses (here 'abc' + newline) stops the apply before anything
  //     changes; an expired one does not. Run on the already-applied database, so the receipt check must come first.
  for (const [label, expiry, want] of [['unexpired', "now() + interval '1 hour'", /IDEM_KEY_PRINTABLE_1912_WEAK_RECEIPT/], ['expired', "now() - interval '1 hour'", /IDEM_KEY_PRINTABLE_1912_BASELINE_DRIFT/]]) {
    const weak = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
      { input: `INSERT INTO public.idempotency_keys (idempotency_key, operation, result, expires_at) VALUES ('abc' || E'\n', 'proof_1912', '{}'::jsonb, ${expiry});
${follow}`, allowFailure: true });
    assert.notEqual(weak.status, 0, `${label} weak receipt case must stop at a preflight`);
    assert.match(weak.stderr, want, `${label} weak receipt case`);
    console.log(`[adjust-key] ${label} weak-key receipt: ${want.source.slice(0, 40)}`);
  }
  // 5a. The full adjust_inventory business chain (its own prover replays only up to 20260911120000) runs unchanged
  //     on the candidate body and must end in SMOKE_PASS_ROLLBACK, so nothing it plants persists.
  for (const chain of ['smoke-adjust-inventory-intent-binding.sql']) {
    const sql = readFileSync(path.join(ROOT, 'scripts', 'smoke', chain), 'utf8').replaceAll('\r\n', '\n');
    const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], { input: sql, allowFailure: true });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.notEqual(r.status, 0, `${chain} must end by rolling back:\n${out}`);
    assert.match(out, /ERROR:\s+SMOKE_PASS_ROLLBACK\b/, `${chain} failed on the candidate bodies:\n${out}`);
    assert.doesNotMatch(out, /SMOKE_FAIL|SMOKE_SETUP/, `${chain} reported a failure:\n${out}`);
    console.log(`[adjust-key] full chain ${chain}: SMOKE_PASS_ROLLBACK on the candidate bodies`);
  }

  // 5b. soft_delete_customer_document's business path on the candidate body, as a signed-in sales rep (any rep may
  //     work any customer since 20261013220000, so the older registered chain's cross-rep refusal no longer holds):
  //     a normal key removes the document stamped with the rep, the same key replays the same answer, and a newline
  //     key is refused with the other document left in place. Rolled back.
  const REP = USERS.rep;
  const CUST = '7c7a0000-0000-4000-8000-000019120004';
  const DOC1 = '7c7a0000-0000-4000-8000-000019120006';
  const DOC2 = '7c7a0000-0000-4000-8000-000019120007';
  const softDelete = (doc, keySql) => `public.soft_delete_customer_document('${doc}', '${CUST}', ${keySql})`;
  const doc = show('soft_delete_customer_document chain', attempt(REP, `
    PERFORM set_config('request.jwt.claim.sub', '${REP}', true);
    INSERT INTO public.customer_documents (id, customer_id, document_type, storage_path, filename, mime_type, size_bytes, uploaded_by, source) VALUES
      ('${DOC1}', '${CUST}', 'other', '${CUST}/${DOC1}-proof-one.pdf', '[1912]-one.pdf', 'application/pdf', 100, '${REP}', 'rep'),
      ('${DOC2}', '${CUST}', 'other', '${CUST}/${DOC2}-proof-two.pdf', '[1912]-two.pdf', 'application/pdf', 100, '${REP}', 'rep');
    ${asUser(`r := ${softDelete(DOC1, `'soft_delete_customer_document:${REP}:6a0f1b2c-3d4e-4f5a-8b6c-7d8e9fa0b1c2'`)};`)}
    ${asUser(`r2 := ${softDelete(DOC1, `'soft_delete_customer_document:${REP}:6a0f1b2c-3d4e-4f5a-8b6c-7d8e9fa0b1c2'`)};`)}
    ${refuse(`r3 := ${softDelete(DOC2, `'abc' || E'\\n'`)};`)}
    v := 'doc=' || (r->>'document_id' = '${DOC1}') || '|replay_same=' || (r = r2)
      || '|deleted_by_rep=' || (SELECT deleted_at IS NOT NULL AND deleted_by = '${REP}' FROM public.customer_documents WHERE id = '${DOC1}')
      || '|bad=' || t || '|doc2_kept=' || (SELECT deleted_at IS NULL FROM public.customer_documents WHERE id = '${DOC2}');`));
  assert.match(doc, /^ok\|doc=true\|replay_same=true\|deleted_by_rep=true\|bad=IDEMPOTENCY_KEY_REQUIRED[^|]*\|doc2_kept=true$/);
  console.log('\nADJUST_INVENTORY_KEY_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
