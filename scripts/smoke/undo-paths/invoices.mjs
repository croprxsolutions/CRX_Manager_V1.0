/**
 * Invoices: unpost_invoice, apply_write_off -> reverse_write_off, batch_void_invoices, delete_invoices.
 */
import assert from 'node:assert/strict';
import { attempt, asUser, id, refuse, seed, signIn, USERS } from './harness.mjs';

const CUST = id('1c1');
const INV = { posted: id('1e1'), writeOff: id('1e2'), toVoid: id('1e3'), draft: id('1e4'), paid: id('1e5') };
const { admin: ADMIN, rep: REP, driver: DRIVER } = USERS;

/** One invoice's money and lifecycle columns, read as postgres. */
const fp = (inv) => `(SELECT row(status, total_amount_cents, paid_amount_cents, prepay_applied_cents, write_off_cents,
  balance_cents, posted_by IS NOT NULL, voided_at IS NOT NULL, deleted_at IS NOT NULL)::text FROM public.invoices WHERE id = '${inv}')`;
const audits = (inv, op) => `(SELECT count(*) FROM public.financial_audit_log WHERE entity_id = '${inv}' AND operation_type = '${op}')`;

function seedInvoices() {
  const draft = (key, number, cents) => `INSERT INTO public.invoices (id, customer_id, invoice_number, invoice_type, status, total_amount_cents, created_by, invoice_date)
    VALUES ('${INV[key]}', '${CUST}', '[UNDO] ${number}', 'chemical_sale', 'draft', ${cents}, '${ADMIN}', CURRENT_DATE);`;
  const post = (key) => `UPDATE public.invoices SET status = 'posted', posted_by = '${ADMIN}', posted_at = now() WHERE id = '${INV[key]}';`;
  seed('invoices', `INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${CUST}', '[UNDO] Invoice Farm', '[UNDO]-INV-1');
    ${draft('posted', 'INV-POSTED', 50000)} ${post('posted')}
    ${draft('writeOff', 'INV-WRITEOFF', 40000)} ${post('writeOff')}
    ${draft('toVoid', 'INV-VOID', 30000)} ${post('toVoid')}
    ${draft('paid', 'INV-PAID', 25000)} ${post('paid')}
    ${draft('draft', 'INV-DRAFT', 20000)}
    -- A $10.00 payment on the paid invoice, so voiding or unposting it must be refused.
    PERFORM 1;`.replace('PERFORM 1;', `SELECT public.allocate_payment('${CUST}', 1000, 'check', '[UNDO]-PAY-1', NULL, CURRENT_DATE, '[UNDO] payment',
      jsonb_build_array(jsonb_build_object('invoice_id', '${INV.paid}', 'amount_cents', 1000)), '${ADMIN}', 'undo-seed-pay-1');`));
}

const show = (label, got) => { console.log(`  ${label}: ${got}`); return got; };

export function run() {
  seedInvoices();

  // unpost_invoice: posted -> unposted, money untouched; same key replays; again refused; driver refused.
  const unpost = (key) => `public.unpost_invoice('${INV.posted}', '${ADMIN}', '${key}')`;
  const u = show('unpost', attempt(ADMIN, `
    f0 := ${fp(INV.posted)};
    ${signIn(DRIVER)} ${refuse(`r := public.unpost_invoice('${INV.posted}', '${DRIVER}', 'undo-unpost-driver');`)} t2 := t; ${signIn(ADMIN)}
    t2 := t2 || '|driver_unchanged=' || (f0 = ${fp(INV.posted)});
    ${asUser(`r := ${unpost('undo-unpost-1')};`)} f1 := ${fp(INV.posted)};
    ${asUser(`r2 := ${unpost('undo-unpost-1')};`)} f2 := ${fp(INV.posted)};
    ${refuse(`r3 := ${unpost('undo-unpost-2')};`)}
    v := f0 || ' -> ' || f1 || '|replay_same=' || (r = r2) || '|replay_unchanged=' || (f1 = f2) || '|audits=' || ${audits(INV.posted, 'invoice_unposted')}
      || '|again=' || t || '|driver=' || t2;`));

  // apply_write_off then reverse_write_off: balance returns exactly; replay; reverse twice; rep refused.
  const wo = show('write-off', attempt(ADMIN, `
    f0 := ${fp(INV.writeOff)};
    ${asUser(`u := public.apply_write_off('${INV.writeOff}', 7500, '[UNDO] small balance', '${ADMIN}', 'undo-wo-apply');`)}
    f1 := ${fp(INV.writeOff)};
    ${signIn(REP)} ${refuse(`r3 := public.reverse_write_off(u, '[UNDO] reverse', '${REP}', 'undo-wo-rep');`)} t2 := t; ${signIn(ADMIN)}
    ${asUser(`r := public.reverse_write_off(u, '[UNDO] reverse', '${ADMIN}', 'undo-wo-reverse');`)} f2 := ${fp(INV.writeOff)};
    ${asUser(`r2 := public.reverse_write_off(u, '[UNDO] reverse', '${ADMIN}', 'undo-wo-reverse');`)}
    ${refuse(`r3 := public.reverse_write_off(u, '[UNDO] reverse', '${ADMIN}', 'undo-wo-reverse-2');`)}
    v := f0 || ' -> ' || f1 || ' -> ' || f2 || '|replay_same=' || (r = r2) || '|replay_unchanged=' || (f2 = ${fp(INV.writeOff)})
      || '|reversed_at=' || (SELECT (reversed_at IS NOT NULL)::text FROM public.write_offs WHERE id = u)
      || '|again=' || t || '|rep=' || t2;`));

  // batch_void_invoices: voids; replay; void again; rep refused; an invoice with a payment is refused.
  const bv = (ids, key) => `public.batch_void_invoices(ARRAY[${ids.map((k) => `'${INV[k]}'`).join(',')}]::uuid[], '[UNDO] void', '${ADMIN}', '${key}')`;
  const vd = show('batch void', attempt(ADMIN, `
    ${signIn(REP)} ${refuse(`r := public.batch_void_invoices(ARRAY['${INV.toVoid}']::uuid[], '[UNDO] void', '${REP}', 'undo-bv-rep');`)} t2 := t; ${signIn(ADMIN)}
    f0 := ${fp(INV.toVoid)};
    ${asUser(`n := ${bv(['toVoid'], 'undo-bv-1')};`)} t := n::text; f1 := ${fp(INV.toVoid)};
    ${asUser(`n := ${bv(['toVoid'], 'undo-bv-1')};`)} t := t || '/' || n; f2 := ${fp(INV.toVoid)};
    ${asUser(`n := ${bv(['toVoid'], 'undo-bv-2')};`)} t := t || '/' || n;
    v := f0 || ' -> ' || f1 || '|counts=' || t || '|replay_unchanged=' || (f1 = f2) || '|again_unchanged=' || (f1 = ${fp(INV.toVoid)})
      || '|rep=' || t2;`));
  const vp = show('batch void paid', attempt(ADMIN, `
    f0 := ${fp(INV.paid)};
    ${refuse(`n := ${bv(['paid'], 'undo-bv-paid')};`)}
    v := t || '|unchanged=' || (f0 = ${fp(INV.paid)});`));

  // delete_invoices: a draft is soft-deleted; replay; delete again; rep refused.
  const del = (key) => `public.delete_invoices(ARRAY['${INV.draft}']::uuid[], '${ADMIN}', '${key}')`;
  const dl = show('delete', attempt(ADMIN, `
    ${signIn(REP)} ${refuse(`n := public.delete_invoices(ARRAY['${INV.draft}']::uuid[], '${REP}', 'undo-del-rep');`)} t2 := t; ${signIn(ADMIN)}
    f0 := ${fp(INV.draft)};
    ${asUser(`n := ${del('undo-del-1')};`)} t := n::text; f1 := ${fp(INV.draft)};
    ${asUser(`n := ${del('undo-del-1')};`)} t := t || '/' || n; f2 := ${fp(INV.draft)};
    ${asUser(`n := ${del('undo-del-2')};`)} t := t || '/' || n;
    v := f0 || ' -> ' || f1 || '|counts=' || t || '|replay_unchanged=' || (f1 = f2) || '|rep=' || t2;`));

  // Posted -> unposted with every cent where it was; one audit row however often it is retried.
  assert.equal(u, 'ok|(posted,50000,0,0,0,50000,t,f,f) -> (unposted,50000,0,0,0,50000,f,f,f)|replay_same=true|replay_unchanged=true|audits=1'
    + '|again=Invoice [UNDO] INV-POSTED is not posted (status: unposted); there is nothing to unpost'
    + '|driver=Not authorized: requires admin,sales_rep role|driver_unchanged=true');
  // A $75.00 write-off takes the balance to $325.00; reversing it puts back exactly $400.00.
  assert.equal(wo, 'ok|(posted,40000,0,0,0,40000,t,f,f) -> (posted,40000,0,0,7500,32500,t,f,f) -> (posted,40000,0,0,0,40000,t,f,f)'
    + '|replay_same=true|replay_unchanged=true|reversed_at=true|again=Write-off has already been reversed|rep=Admin access required to reverse write-offs');
  // A void zeroes the invoice (by design, so it stops counting toward what is owed); a replay and a
  // second void with a new key change nothing.
  assert.equal(vd, 'ok|(posted,30000,0,0,0,30000,t,f,f) -> (voided,0,0,0,0,0,t,t,f)|counts=1/1/0|replay_unchanged=true|again_unchanged=true'
    + '|rep=Only admin users can void invoices');
  assert.match(vp, /^ok\|INVOICE_HAS_APPLIED_PAYMENTS: .*\|unchanged=true$/);
  // A deleted draft keeps its money columns; deleting it again deletes nothing.
  assert.equal(dl, 'ok|(draft,20000,0,0,0,20000,f,f,f) -> (draft,20000,0,0,0,20000,f,f,t)|counts=1/1/0|replay_unchanged=true'
    + '|rep=Permission denied: requires admin role');
}
