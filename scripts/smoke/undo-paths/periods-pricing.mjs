/**
 * Periods: close_accounting_period -> reopen_accounting_period.
 * Pricing: update_order_items and price_order below-cost approval (admin only, reason required,
 * one approval row however often it is retried) and raising the price back.
 */
import assert from 'node:assert/strict';
import { attempt, asUser, id, refuse, scalar, seed, signIn, USERS } from './harness.mjs';

const CUST = id('6c1'); const PROD = id('6d2'); const ORDER = id('6e1'); const LINE = id('6f1');
const PEND_ORDER = id('6e2'); const PEND_LINE = id('6f2');
// A month long past, so no fixture of any area falls inside it.
const PERIOD_END = '2001-01-31';
const { admin: ADMIN, rep: REP } = USERS;

/** The period's status and whether a date inside it is open, read as postgres. */
const periodFp = `(SELECT string_agg(status || ':' || (closed_at IS NOT NULL), ',') FROM public.accounting_periods WHERE period_end = '${PERIOD_END}')`;
/** One order line's money and its below-cost approvals, read as postgres. */
const lineFp = (line) => `(SELECT row(oi.price_per_unit, oi.cost_per_unit, oi.total_units_needed, oi.total_price, oi.profit,
  (SELECT count(*) FROM public.below_cost_approvals a WHERE a.line_id = oi.id),
  (SELECT coalesce(sum(a.total_shortfall_cents), 0) FROM public.below_cost_approvals a WHERE a.line_id = oi.id))::text
  FROM public.order_items oi WHERE oi.id = '${line}')`;

function seedPeriodsPricing() {
  seed('periods-pricing', `SELECT public.close_accounting_period('${PERIOD_END}', '${ADMIN}', 'undo-seed-close-period');
    INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${CUST}', '[UNDO] Pricing Farm', '[UNDO]-PRC-1');
    INSERT INTO public.products (id, product_name, unit_size, epa_registration, product_form)
      VALUES ('${PROD}', '[UNDO] Pricing Product', 'GL', '999999-99996', 'liquid');
    DO $price$
    DECLARE v jsonb;
    BEGIN
      v := public.preview_product_pricing_changes('product_page', NULL,
        jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'row_version', 1, 'pricing_mode', 'price_driven',
          'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
        '${ADMIN}', 'undo-seed-prc-pricing-preview');
      PERFORM public.apply_product_pricing_change_set((v->>'change_set_id')::uuid, v->>'request_fingerprint', '${ADMIN}', 'undo-seed-prc-pricing-apply');
    END
    $price$;
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES
      ('${ORDER}', '[UNDO] PRC-ORDER', '${CUST}', 'confirmed', false),
      ('${PEND_ORDER}', '[UNDO] PRC-PENDING', '${CUST}', 'confirmed', false);
    UPDATE public.orders SET pricing_status = 'needs_pricing' WHERE id = '${PEND_ORDER}';
    INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size, pricing_pending)
      VALUES ('${LINE}', '${ORDER}', '${PROD}', '[UNDO] priced line', 10, 6, 5, 50, 20, 40, 0, 5, 'GL', false),
             ('${PEND_LINE}', '${PEND_ORDER}', '${PROD}', '[UNDO] pending line', 0, 6, 5, 0, 0, 0, 0, 5, 'GL', true);`);
}

const show = (label, got) => { console.log(`  ${label}: ${got}`); return got; };

export function run() {
  seedPeriodsPricing();
  const periodId = scalar(`SELECT id FROM public.accounting_periods WHERE period_end = '${PERIOD_END}';`);

  // reopen_accounting_period: closed -> open once; replay; reopen again refused; rep refused.
  const reopen = (who, key) => `r := public.reopen_accounting_period('${periodId}', '[UNDO] late invoice', '${who}', '${key}');`;
  const rp = show('reopen period', attempt(ADMIN, `
    f0 := ${periodFp};
    ${signIn(REP)} ${refuse(reopen(REP, 'undo-reopen-rep'))} t2 := t || '|rep_unchanged=' || (f0 = ${periodFp}); ${signIn(ADMIN)}
    ${asUser(reopen(ADMIN, 'undo-reopen-1'))} f1 := ${periodFp}; r3 := r;
    ${asUser(reopen(ADMIN, 'undo-reopen-1'))} f2 := ${periodFp};
    ${refuse(reopen(ADMIN, 'undo-reopen-2'))}
    v := f0 || ' -> ' || f1 || '|replay_same=' || (r = r3) || '|replay_unchanged=' || (f1 = f2) || '|again=' || t
      || '|audits=' || (SELECT count(*) FROM public.financial_audit_log WHERE entity_id = '${periodId}' AND new_values->>'status' = 'open')
      || '|rep=' || t2;`));

  // update_order_items below cost: rep refused; admin needs a reason; with one, a single approval row records the
  // $1.00 x 5 shortfall; replay adds nothing; raising the price back adds no approval.
  const upd = (who, price, reason, key) => `r := public.update_order_items('${ORDER}', jsonb_build_array(jsonb_build_object('id', '${LINE}',
    'product_id', '${PROD}', 'product_name', '[UNDO] priced line', 'unit_size', 'GL', 'price_per_unit', ${price}, 'total_units_needed', 5
    ${reason ? `, 'below_cost_reason', '${reason}'` : ''})), '${who}', '${key}', n);`;
  // n holds the order's row_version, read as postgres just before each change.
  const version = `n := (SELECT row_version FROM public.orders WHERE id = '${ORDER}');`;
  const up = show('below cost (update_order_items)', attempt(ADMIN, `
    f0 := ${lineFp(LINE)}; ${version}
    ${signIn(REP)} ${refuse(upd(REP, 5, '[UNDO] match competitor', 'undo-upd-rep'))} t2 := split_part(t, ':', 1) || '|rep_unchanged=' || (f0 = ${lineFp(LINE)}); ${signIn(ADMIN)}
    ${refuse(upd(ADMIN, 5, null, 'undo-upd-noreason'))} t2 := t2 || '|no_reason=' || split_part(t, ':', 1);
    ${asUser(upd(ADMIN, 5, '[UNDO] match competitor', 'undo-upd-1'))} f1 := ${lineFp(LINE)}; r3 := r;
    ${asUser(upd(ADMIN, 5, '[UNDO] match competitor', 'undo-upd-1'))} f2 := ${lineFp(LINE)}; r2 := r;
    ${version} ${asUser(upd(ADMIN, 10, null, 'undo-upd-back'))}
    v := f0 || ' -> ' || f1 || ' -> ' || ${lineFp(LINE)} || '|replay_same=' || (r3 = r2) || '|replay_unchanged=' || (f1 = f2) || '|rep=' || t2;`));

  // price_order on a pricing-pending line: the same gate.
  const prc = (who, price, reason, key) => `r := public.price_order('${PEND_ORDER}', jsonb_build_array(jsonb_build_object('order_item_id', '${PEND_LINE}',
    'price', ${price} ${reason ? `, 'below_cost_reason', '${reason}'` : ''})), '${who}', '${key}');`;
  const po = show('below cost (price_order)', attempt(ADMIN, `
    f0 := ${lineFp(PEND_LINE)};
    ${signIn(REP)} ${refuse(prc(REP, 4, '[UNDO] damaged jugs', 'undo-prc-rep'))} t2 := split_part(t, ':', 1) || '|rep_unchanged=' || (f0 = ${lineFp(PEND_LINE)}); ${signIn(ADMIN)}
    ${refuse(prc(ADMIN, 4, null, 'undo-prc-noreason'))} t2 := t2 || '|no_reason=' || split_part(t, ':', 1);
    ${asUser(prc(ADMIN, 4, '[UNDO] damaged jugs', 'undo-prc-1'))} f1 := ${lineFp(PEND_LINE)}; r3 := r;
    ${asUser(prc(ADMIN, 4, '[UNDO] damaged jugs', 'undo-prc-1'))} f2 := ${lineFp(PEND_LINE)};
    v := f0 || ' -> ' || f1 || '|replay_same=' || (r3 = r) || '|replay_unchanged=' || (f1 = f2) || '|rep=' || t2;`));

  assert.equal(rp, 'ok|closed:true -> open:false|replay_same=true|replay_unchanged=true|again=Accounting period is not closed (status: open)'
    + '|audits=1|rep=INSUFFICIENT_ROLE|rep_unchanged=true');
  // $10.00 -> $5.00 against a $6.00 cost on 5 units: one approval for the $5.00 shortfall; back to $10.00 restores
  // the $50.00 line and its $20.00 profit without another approval.
  assert.equal(up, 'ok|(10,6,5,50.00,20.00,0,0) -> (5,6.0000000000000000,5,25.00,-5.00,1,500) -> (10,6.0000000000000000,5,50.00,20.00,1,500)'
    + '|replay_same=true|replay_unchanged=true|rep=BELOW_COST_ADMIN_REQUIRED|rep_unchanged=true|no_reason=BELOW_COST_REASON_REQUIRED');
  // Pricing a pending line at $4.00 against $6.00 cost on 5 units: one approval for the $10.00 shortfall.
  assert.equal(po, 'ok|(0,6,5,0.00,-30.00,0,0) -> (4,6.0000000000000000,5,20.00,-10.00,1,1000)'
    + '|replay_same=true|replay_unchanged=true|rep=BELOW_COST_ADMIN_REQUIRED|rep_unchanged=true|no_reason=BELOW_COST_REASON_REQUIRED');
}
