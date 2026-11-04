/**
 * Payables: record_vendor_payment -> void_vendor_payment, and void_vendor_bill.
 */
import assert from 'node:assert/strict';
import { attempt, asUser, id, ref, refuse, scalar, seed, signIn, USERS } from './harness.mjs';

const VENDOR = id('4b1');
const BILL = { paid: ref('bill-paid'), plain: ref('bill-plain') };
const PAY = { one: ref('pay-one') };
const { admin: ADMIN, rep: REP } = USERS;

/** One bill's money and status, plus its live (unvoided) payments, read as postgres. */
const fp = (bill) => `(SELECT row(status, total_cents, paid_cents, balance_cents, voided_at IS NOT NULL,
  (SELECT count(*) FROM public.vendor_payments p WHERE p.vendor_bill_id = b.id AND p.voided_at IS NULL))::text
  FROM public.vendor_bills b WHERE id = ${BILL[bill]})`;

function seedPayables() {
  const bill = (k, cents) => `INSERT INTO undo_paths.ids SELECT 'bill-${k}', public.create_vendor_bill('${VENDOR}', NULL, '[UNDO] BILL-${k}',
      CURRENT_DATE, CURRENT_DATE + 30, 'net_30', ${cents}, 0, NULL, 'undo-seed-bill-${k}', false, NULL);`;
  seed('payables', `INSERT INTO public.vendors (id, name) VALUES ('${VENDOR}', '[UNDO] Payables Vendor');
    ${bill('paid', 100000)} ${bill('plain', 50000)}
    INSERT INTO undo_paths.ids SELECT 'pay-one', public.record_vendor_payment(${BILL.paid}, 30000, CURRENT_DATE, 'check', '[UNDO]-CHK-1',
      NULL, 'undo-seed-vpay-1');`);
}

const show = (label, got) => { console.log(`  ${label}: ${got}`); return got; };

export function run() {
  seedPayables();
  // The app role cannot read undo_paths, so pin the RPC-chosen ids as literals before probing.
  for (const m of [BILL, PAY]) for (const k of Object.keys(m)) m[k] = `'${scalar(`SELECT ${m[k]};`)}'::uuid`;
  const fixture = show('fixture', attempt(ADMIN, `v := ${fp('paid')} || ' ' || ${fp('plain')};`));

  // A bill with a live payment cannot be voided until the payment is voided.
  const vpaid = show('void paid bill', attempt(ADMIN, `
    f0 := ${fp('paid')};
    ${refuse(`PERFORM public.void_vendor_bill(${BILL.paid}, '[UNDO] wrong vendor', 'undo-vb-paid');`)}
    v := t || '|unchanged=' || (f0 = ${fp('paid')});`));

  // void_vendor_payment: $300.00 comes off paid, the bill is unpaid again; replay; again; rep refused.
  const vp = (who, key) => `r := public.void_vendor_payment(${PAY.one}, '[UNDO] bounced', '${key}');`;
  const pay = show('void payment', attempt(ADMIN, `
    f0 := ${fp('paid')};
    ${signIn(REP)} ${refuse(vp(REP, 'undo-vp-rep'))} t2 := t || '|rep_unchanged=' || (f0 = ${fp('paid')}); ${signIn(ADMIN)}
    ${asUser(vp(ADMIN, 'undo-vp-1'))} f1 := ${fp('paid')}; r3 := r;
    ${asUser(vp(ADMIN, 'undo-vp-1'))} f2 := ${fp('paid')};
    ${refuse(vp(ADMIN, 'undo-vp-2'))}
    v := f0 || ' -> ' || f1 || '|replay_same=' || (r = r3) || '|replay_unchanged=' || (f1 = f2) || '|again=' || t
      || '|again_unchanged=' || (f1 = ${fp('paid')}) || '|rep=' || t2;`));

  // void_vendor_bill: the bill is voided with its money columns kept; replay; again; rep refused.
  const vb = (key) => `PERFORM public.void_vendor_bill(${BILL.plain}, '[UNDO] duplicate', '${key}');`;
  const bill = show('void bill', attempt(ADMIN, `
    f0 := ${fp('plain')};
    ${signIn(REP)} ${refuse(vb('undo-vb-rep'))} t2 := t || '|rep_unchanged=' || (f0 = ${fp('plain')}); ${signIn(ADMIN)}
    ${asUser(vb('undo-vb-1'))} f1 := ${fp('plain')};
    ${asUser(vb('undo-vb-1'))} f2 := ${fp('plain')};
    ${refuse(vb('undo-vb-2'))}
    v := f0 || ' -> ' || f1 || '|replay_unchanged=' || (f1 = f2) || '|again=' || t || '|again_unchanged=' || (f1 = ${fp('plain')})
      || '|rep=' || t2;`));

  assert.equal(fixture, 'ok|(partially_paid,100000,30000,70000,f,1) (unpaid,50000,0,50000,f,0)');
  assert.equal(vpaid, 'ok|BILL_HAS_ACTIVE_PAYMENTS: bill has 1 active payment(s); void each payment first|unchanged=true');
  // Voiding the $300.00 payment puts the full $1,000.00 back as owed.
  assert.equal(pay, 'ok|(partially_paid,100000,30000,70000,f,1) -> (unpaid,100000,0,100000,f,0)|replay_same=true|replay_unchanged=true'
    + '|again=PAYMENT_ALREADY_VOIDED|again_unchanged=true|rep=NOT_AUTHORIZED: only admins can void vendor payments|rep_unchanged=true');
  // A voided bill keeps its amounts for the record; payables screens leave voided bills out.
  assert.equal(bill, 'ok|(unpaid,50000,0,50000,f,0) -> (voided,50000,0,50000,t,0)|replay_unchanged=true|again=BILL_ALREADY_VOIDED'
    + '|again_unchanged=true|rep=NOT_AUTHORIZED: admin role required to void vendor bills|rep_unchanged=true');
}
