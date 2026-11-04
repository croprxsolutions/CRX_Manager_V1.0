/**
 * Commission: create_commission_payment (a payout batch claims pending commissions once), and
 * void_commission_payment (a posted payout is undone and its commissions are pending again).
 */
import assert from 'node:assert/strict';
import { attempt, asUser, id, ref, refuse, scalar, seed, signIn, USERS } from './harness.mjs';

const CUST = id('7c1'); const ORDER = id('7e1');
// paid1 + paid2: in a posted payout (void test). free: pending, in no payout (create test).
const COM = { paid1: id('7a1'), paid2: id('7a2'), free: id('7a3') };
const PAYOUT = { posted: ref('payout-posted') };
const { admin: ADMIN, rep: REP } = USERS;

/** The three commissions and every payout touching them, read as postgres. */
const fp = () => `(SELECT string_agg(x, ' ' ORDER BY x) FROM (
  SELECT 'com' || right(c.id::text, 1) || '=' || c.status || ':' || c.commission_amount x
    FROM public.commissions c WHERE c.id IN ('${COM.paid1}', '${COM.paid2}', '${COM.free}')
  UNION ALL SELECT 'payouts=' || coalesce(string_agg(cp.status || ':' || cp.total_amount, ',' ORDER BY cp.status, cp.total_amount), '')
    FROM public.commission_payments cp WHERE EXISTS (SELECT 1 FROM public.commission_payment_items i
      WHERE i.commission_payment_id = cp.id AND i.commission_id IN ('${COM.paid1}', '${COM.paid2}', '${COM.free}'))) s)`;

function seedCommission() {
  const com = (k, dollars) => `INSERT INTO public.commissions (id, order_id, customer_id, recipient, recipient_user_id, split_percentage,
      commission_amount, order_profit, order_date, status)
    VALUES ('${COM[k]}', '${ORDER}', '${CUST}', '[UNDO] Rep', '${REP}', 100, ${dollars}, ${dollars}, CURRENT_DATE, 'pending');`;
  seed('commission', `INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${CUST}', '[UNDO] Commission Farm', '[UNDO]-COM-1');
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES ('${ORDER}', '[UNDO] COM-ORDER', '${CUST}', 'confirmed', false);
    ${com('paid1', '120.00')} ${com('paid2', '80.00')} ${com('free', '45.50')}
    INSERT INTO undo_paths.ids SELECT 'payout-posted', public.create_commission_payment(ARRAY['${COM.paid1}', '${COM.paid2}']::uuid[],
      'check', '[UNDO]-COM-CHK-1', CURRENT_DATE, NULL, '${ADMIN}', 'undo-seed-payout-create');
    SELECT public.post_commission_payment(${PAYOUT.posted}, '${ADMIN}', 'undo-seed-payout-post');`);
}

const show = (label, got) => { console.log(`  ${label}: ${got}`); return got; };

export function run() {
  seedCommission();
  // The app role cannot read undo_paths, so pin the RPC-chosen id as a literal before probing.
  PAYOUT.posted = `'${scalar(`SELECT ${PAYOUT.posted};`)}'::uuid`;
  const fixture = show('fixture', attempt(ADMIN, `v := ${fp()};`));

  // create_commission_payment: one unposted $45.50 payout claims the free commission; replay; again refused; rep refused.
  const create = (who, key) => `u := public.create_commission_payment(ARRAY['${COM.free}']::uuid[], 'check', '[UNDO]-COM-CHK-2',
    CURRENT_DATE, NULL, '${who}', '${key}');`;
  const cr = show('create payout', attempt(ADMIN, `
    f0 := ${fp()};
    ${signIn(REP)} ${refuse(create(REP, 'undo-com-rep'))} t2 := t || '|rep_unchanged=' || (f0 = ${fp()}); ${signIn(ADMIN)}
    ${asUser(create(ADMIN, 'undo-com-1'))} f1 := ${fp()}; r := to_jsonb(u);
    ${asUser(create(ADMIN, 'undo-com-1'))} f2 := ${fp()}; r2 := to_jsonb(u);
    ${refuse(create(ADMIN, 'undo-com-2'))}
    v := f1 || '|replay_same=' || (r = r2) || '|replay_unchanged=' || (f1 = f2) || '|again=' || t
      || '|again_unchanged=' || (f1 = ${fp()}) || '|rep=' || t2;`));

  // void_commission_payment: the posted $200.00 payout is voided and both commissions are pending again;
  // replay; void again refused; rep refused.
  const vd = (who, key) => `r := public.void_commission_payment(${PAYOUT.posted}, '[UNDO] wrong check', '${who}', '${key}');`;
  const vo = show('void payout', attempt(ADMIN, `
    f0 := ${fp()};
    ${signIn(REP)} ${refuse(vd(REP, 'undo-comv-rep'))} t2 := t || '|rep_unchanged=' || (f0 = ${fp()}); ${signIn(ADMIN)}
    ${asUser(vd(ADMIN, 'undo-comv-1'))} f1 := ${fp()}; r3 := r;
    ${asUser(vd(ADMIN, 'undo-comv-1'))} f2 := ${fp()};
    ${refuse(vd(ADMIN, 'undo-comv-2'))}
    v := f1 || '|replay_same=' || (r = r3) || '|replay_unchanged=' || (f1 = f2) || '|again=' || t || '|again_unchanged=' || (f1 = ${fp()})
      || '|rep=' || t2;`));

  assert.equal(fixture, 'ok|com1=paid:120.00 com2=paid:80.00 com3=pending:45.50 payouts=posted:200.00');
  // A new payout claims the $45.50 commission once; the commission stays pending until the payout is posted.
  assert.equal(cr, 'ok|com1=paid:120.00 com2=paid:80.00 com3=pending:45.50 payouts=posted:200.00,unposted:45.50|replay_same=true|replay_unchanged=true'
    + '|again=One or more commissions are already in an existing (non-voided) payment. Void that payment first or remove those commissions from the selection.'
    + '|again_unchanged=true|rep=Admin access required to create a commission payment|rep_unchanged=true');
  // Voiding the posted $200.00 payout puts both commissions back to pending at their exact amounts.
  assert.equal(vo, 'ok|com1=pending:120.00 com2=pending:80.00 com3=pending:45.50 payouts=voided:200.00|replay_same=true|replay_unchanged=true'
    + '|again=INVALID_COMMISSION_PAYMENT_STATUS: voided|again_unchanged=true|rep=INSUFFICIENT_ROLE|rep_unchanged=true');
}
