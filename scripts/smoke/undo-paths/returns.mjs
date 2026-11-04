/**
 * Returns: receive_return (stock comes back) and issue_return_credit (the customer is credited once).
 */
import assert from 'node:assert/strict';
import { attempt, asUser, id, ref, refuse, scalar, seed, signIn, USERS } from './harness.mjs';

const CUST = id('5c1'); const PROD = id('5d2'); const ORDER = id('5e1'); const LINE = id('5f1'); const DEL = id('5a1');
// receive: approved, waiting to be received. credit: already received, waiting for its credit.
const RET = { receive: ref('ret-receive'), credit: ref('ret-credit') };
const { admin: ADMIN, rep: REP, driver: DRIVER } = USERS;
const NO_PROOF_SIGNER = 'No proof — recorded by office';

/** Stock, stock movements, both returns and the customer's live invoices, read as postgres. */
const fp = () => `(SELECT string_agg(x, ' ' ORDER BY x) FROM (
  SELECT 'stock=' || quantity_available || '/' || quantity_prebooked x FROM public.inventory WHERE product_id = '${PROD}'
  UNION ALL SELECT 'moves=' || coalesce(string_agg(transaction_type || ':' || quantity, ',' ORDER BY transaction_type, quantity), '') FROM public.inventory_transactions WHERE product_id = '${PROD}'
  UNION ALL SELECT 'ret' || CASE WHEN r.id = ${RET.receive} THEN 'R' ELSE 'C' END || '=' || r.status || ':' || coalesce(r.total_credit_cents, 0)
    FROM public.returns r WHERE r.id IN (${RET.receive}, ${RET.credit})
  UNION ALL SELECT 'inv=' || coalesce(string_agg(invoice_type || ':' || status || ':' || total_amount_cents, ',' ORDER BY invoice_type, status), '')
    FROM public.invoices WHERE customer_id = '${CUST}' AND deleted_at IS NULL AND status NOT IN ('voided', 'cancelled')) s)`;

function seedReturns() {
  const ret = (k, qty) => `INSERT INTO undo_paths.ids SELECT 'ret-${k}', (public.create_return(
      jsonb_build_object('customer_id', '${CUST}', 'order_id', '${ORDER}', 'reason', 'overstock'),
      jsonb_build_array(jsonb_build_object('order_item_id', '${LINE}', 'quantity', ${qty}, 'condition', 'unopened', 'restock', true, 'sort_order', 0)),
      'undo-seed-ret-${k}')->>'return_id')::uuid;
    SELECT public.approve_return(${RET[k]}, '${ADMIN}', 'undo-seed-ret-approve-${k}');`;
  seed('returns', `INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${CUST}', '[UNDO] Return Farm', '[UNDO]-RET-1');
    INSERT INTO public.products (id, product_name, unit_size, epa_registration, product_form)
      VALUES ('${PROD}', '[UNDO] Return Product', 'GL', '999999-99997', 'liquid');
    DO $price$
    DECLARE v jsonb;
    BEGIN
      v := public.preview_product_pricing_changes('product_page', NULL,
        jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'row_version', 1, 'pricing_mode', 'price_driven',
          'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
        '${ADMIN}', 'undo-seed-ret-pricing-preview');
      PERFORM public.apply_product_pricing_change_set((v->>'change_set_id')::uuid, v->>'request_fingerprint', '${ADMIN}', 'undo-seed-ret-pricing-apply');
    END
    $price$;
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES ('${PROD}', 'Main Warehouse', 40, 10, 'GL');
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES ('${ORDER}', '[UNDO] RET-ORDER', '${CUST}', 'confirmed', false);
    INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size)
      VALUES ('${LINE}', '${ORDER}', '${PROD}', '[UNDO] return line', 10, 6, 10, 100, 40, 40, 0, 10, 'GL');
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, scheduled_date, status, created_by)
      VALUES ('${DEL}', '[UNDO] DEL-RET', '${ORDER}', '${CUST}', CURRENT_DATE, 'scheduled', '${ADMIN}');
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
      VALUES ('${DEL}', '${LINE}', '${PROD}', 10, 0, 'GL');
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${DEL}';
    SELECT public.complete_delivery(p_delivery_id => '${DEL}', p_signed_by => '${NO_PROOF_SIGNER}', p_performed_by => '${ADMIN}',
      p_idempotency_key => 'undo-seed-ret-complete', p_evidence => 'no_proof', p_evidence_ref => '[UNDO] fixture');
    UPDATE public.invoices SET status = 'posted', posted_by = '${ADMIN}', posted_at = now() WHERE delivery_id = '${DEL}';
    ${ret('receive', 3)} ${ret('credit', 4)}
    SELECT public.receive_return(${RET.credit}, '${ADMIN}', 'undo-seed-ret-receive-credit');`);
}

const show = (label, got) => { console.log(`  ${label}: ${got}`); return got; };

export function run() {
  seedReturns();
  // The app role cannot read undo_paths, so pin the RPC-chosen ids as literals before probing.
  for (const k of Object.keys(RET)) RET[k] = `'${scalar(`SELECT ${RET[k]};`)}'::uuid`;
  const fixture = show('fixture', attempt(ADMIN, `v := ${fp()};`));

  // receive_return: 3 units come back into stock once; replay; again refused; driver refused.
  const rcv = (who, key) => `r := public.receive_return(${RET.receive}, '${who}', '${key}');`;
  const rc = show('receive', attempt(ADMIN, `
    f0 := ${fp()};
    ${signIn(DRIVER)} ${refuse(rcv(DRIVER, 'undo-rcv-driver'))} t2 := t || '|driver_unchanged=' || (f0 = ${fp()}); ${signIn(ADMIN)}
    ${asUser(rcv(ADMIN, 'undo-rcv-1'))} f1 := ${fp()}; r3 := r;
    ${asUser(rcv(ADMIN, 'undo-rcv-1'))} f2 := ${fp()};
    ${refuse(rcv(ADMIN, 'undo-rcv-2'))}
    v := f1 || '|replay_same=' || (r = r3) || '|replay_unchanged=' || (f1 = f2) || '|again=' || t || '|again_unchanged=' || (f1 = ${fp()})
      || '|driver=' || t2;`));

  // issue_return_credit: one credit memo for the 4 returned units; replay; again refused; rep refused.
  const crd = (who, key) => `r := public.issue_return_credit(${RET.credit}, '${who}', '${key}');`;
  const cr = show('credit', attempt(ADMIN, `
    f0 := ${fp()};
    ${signIn(REP)} ${refuse(crd(REP, 'undo-crd-rep'))} t2 := t || '|rep_unchanged=' || (f0 = ${fp()}); ${signIn(ADMIN)}
    ${asUser(crd(ADMIN, 'undo-crd-1'))} f1 := ${fp()}; r3 := r;
    ${asUser(crd(ADMIN, 'undo-crd-1'))} f2 := ${fp()};
    ${refuse(crd(ADMIN, 'undo-crd-2'))}
    v := f1 || '|replay_same=' || (r = r3) || '|replay_unchanged=' || (f1 = f2) || '|again=' || t || '|again_unchanged=' || (f1 = ${fp()})
      || '|rep=' || t2;`));

  // 40 on hand / 10 reserved; delivering 10 left 30/0; receiving the 4-unit return made it 34.
  assert.equal(fixture, 'ok|inv=chemical_sale:posted:10000 moves=delivered:10,returned:4.00 retC=received:0 retR=approved:0 stock=34.00/0');
  // Receiving puts the 3 returned units back exactly once and moves no money.
  assert.equal(rc, 'ok|inv=chemical_sale:posted:10000 moves=delivered:10,returned:3.00,returned:4.00 retC=received:0 retR=received:0 stock=37.00/0'
    + '|replay_same=true|replay_unchanged=true|again=RETURN_NOT_APPROVED:received|again_unchanged=true|driver=INSUFFICIENT_ROLE|driver_unchanged=true');
  // Crediting 4 units at $10.00 posts one $40.00 credit memo and moves no stock.
  assert.equal(cr, 'ok|inv=chemical_sale:posted:10000,credit_memo:posted:-4000 moves=delivered:10,returned:4.00 retC=credited:4000 retR=approved:0 stock=34.00/0'
    + '|replay_same=true|replay_unchanged=true|again=RETURN_NOT_CREDITABLE|again_unchanged=true|rep=ADMIN_REQUIRED|rep_unchanged=true');
}
