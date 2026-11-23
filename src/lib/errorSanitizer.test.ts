import { describe, it, expect } from 'vitest';
import { sanitizeError } from './errorSanitizer';

describe('sanitizeError', () => {
  it('keeps the product and order details from active-status refusals', () => {
    expect(sanitizeError('PRODUCT_INACTIVE: Atrazine 4L is turned off; an admin must reactivate it before reopening order ORD-42'))
      .toBe('Atrazine 4L is turned off; an admin must reactivate it before reopening order ORD-42');
    expect(sanitizeError('PRODUCT_DEACTIVATION_BLOCKED: Atrazine 4L: order ORD-42; purchase order PO-9'))
      .toBe('Atrazine 4L: order ORD-42; purchase order PO-9');
  });

  it('turns a crop + timing refusal into plain words (USE-1)', () => {
    expect(sanitizeError({ message: 'USE_TIMING_PAIR_TWICE: "Post-Emerge Wheet" and "Post-Emerge Wheat" are the same crop and timing; keep one.' }))
      .toBe('Nothing was saved. "Post-Emerge Wheet" and "Post-Emerge Wheat" are the same crop and timing; keep one.');
    expect(sanitizeError(new Error('USE_TIMING_LABEL_TAKEN: "Post-Emergence" is already a choice')))
      .toBe('Nothing was saved. "Post-Emergence" is already a choice');
  });

  it('uses a safe fallback when an active-status refusal has no detail', () => {
    expect(sanitizeError('PRODUCT_INACTIVE:   '))
      .toBe('This product is turned off. Ask an admin to reactivate it.');
    expect(sanitizeError('PRODUCT_DEACTIVATION_BLOCKED'))
      .toBe('This product cannot be turned off while required work is open. Review its blockers.');
  });

  it('explains product setup refusals without leaking constraint names', () => {
    expect(sanitizeError({ message: 'PRODUCT_CATEGORY_RETIRED: choose an active category' }))
      .toBe('This category is retired. Choose an active category');
    expect(sanitizeError({ message: 'new row violates check constraint "product_setup_epa_check"' }))
      .toContain('This checks format only');
    expect(sanitizeError({ message: 'insert or update violates foreign key constraint "product_setup_category_fk"' }))
      .toBe('Choose a category from the product category list');
  });
  // RAISE texts of 20261108120000_product_parents.sql (PAR-1).
  it.each([
    ['PRODUCT_PARENT_VALUE: category belongs to parent "Atrazine 4L"; edit it on the parent (reload the app if you do not see a Parent panel)',
      'Nothing was saved. Category belongs to parent "Atrazine 4L"; edit it on the parent (reload the app if you do not see a Parent panel)'],
    ['PRODUCT_PARENT_STALE: parent "Atrazine 4L" changed since you opened it; reload and try again',
      'Nothing was saved. Parent "Atrazine 4L" changed since you opened it; reload and try again'],
    ['PRODUCT_PARENT_EPA_CORRECTION_OFF: EPA number correction is switched off until registrations (REG-1) are built',
      'Nothing was saved. EPA number correction is switched off until registrations (REG-1) are built'],
    ['EVIDENCE_REQUIRED: say what shows it', 'Nothing was saved. Say what shows it'],
    // RAISE texts of 20261117130000_tote_fill_from_bulk.sql (BLK-1a).
    ['TOTE_FILL_STOCK_MOVED: stock of the tote or its bulk has moved since this fill; adjust stock instead',
      'Nothing was saved. Stock of the tote or its bulk has moved since this fill; adjust stock instead'],
    ['TOTE_FILL_TOTE_UNIT: "UAN 265 Tote" is stocked in Gal; a tote must be stocked as Ea or Unit (correct its stock unit first)',
      'Nothing was saved. "UAN 265 Tote" is stocked in Gal; a tote must be stocked as Ea or Unit (correct its stock unit first)'],
    // RAISE texts of 20261207100000_product_weights.sql (DM-2).
    ['PRODUCT_WEIGHT_OUT_OF_RANGE: weight per gallon must be above 0 and at most 20 lb/gal (this is 30.0000 lb/gal)',
      'Nothing was saved. Weight per gallon must be above 0 and at most 20 lb/gal (this is 30.0000 lb/gal)'],
    ['PRODUCT_WEIGHT_STALE: the weight of "TEST UAN" changed since you opened it; reload',
      'Nothing was saved. The weight of "TEST UAN" changed since you opened it; reload'],
  ])('explains the parent refusal %s by name', (raw, expected) => {
    expect(sanitizeError({ code: 'P0001', message: raw })).toBe(expected);
  });
  it('explains an UNKNOWN_STORAGE_LOCATION refusal without the raw token (KI-85)', () => {
    const message = sanitizeError({ message: 'UNKNOWN_STORAGE_LOCATION: stock can be received only into Main Warehouse until stock transfers between warehouses exist' });
    expect(message).toContain('only into Main Warehouse');
    expect(message).not.toContain('UNKNOWN_STORAGE_LOCATION');
  });
  // The RAISE text of 20261022087000_job_chemicals_refuse_unpriced_zero_price_line.sql with the product filled in.
  it('explains a CHEM_PRICE_REQUIRED save refusal without the raw token', () => {
    const sentence = "Atrazine 4L has no price for this customer's tier, so its line would bill $0. Enter a price for the line (on a quote, the quote line's price), tick Customer supplied if the grower supplied it, or give the product a $0 price if you give it away.";
    expect(sanitizeError({ code: 'P0001', message: `CHEM_PRICE_REQUIRED: ${sentence}` }))
      .toBe(`Nothing was saved. ${sentence}`);
  });

  it.each([
    ['DELIVERY_LINE_NOT_ON_ORDER', "this delivery line is not a line of the delivery's order."],
    ['DELIVERY_LINE_PRODUCT_MISMATCH', 'this delivery line is for a different product than its order line.'],
    ['DELIVERY_LINE_UNIT_MISMATCH', 'this delivery line is in "Gal" but its order line is in "Qt".'],
    ['DELIVERY_LINE_DUPLICATE', 'this order line is already on the delivery.'],
    ['DELIVERY_ORDER_LOCKED', 'a delivery with lines cannot be moved to another order.'],
  ])('explains a delivery-line refusal %s (20270126110000) without the raw token', (token, sentence) => {
    expect(sanitizeError({ code: '23514', message: `${token}: ${sentence}` })).toBe(`Nothing was saved. ${sentence}`);
  });
  it.each([
    ['DELIVERY_QUANTITIES_STALE', "this delivery's lines changed since the screen loaded them; reload it and enter the quantities again."],
    ['DELIVERY_QUANTITIES_INVALID', 'every delivered quantity must be a number; reload the delivery and enter the quantities again.'],
    ['DELIVERY_NOTHING_DELIVERED', 'every product on it has a delivered quantity of zero. If nothing was delivered, call the office.'],
  ])('explains a refused partial completion %s (20270203120000) without the raw token', (token, sentence) => {
    expect(sanitizeError({ code: '23514', message: `${token}: ${sentence}` }))
      .toBe(`The delivery was not completed. ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`);
  });
  it('starts the explained refusal with a capital letter (Taha, #2324)', () => {
    expect(sanitizeError({ code: '23514', message: 'DELIVERY_NOTHING_DELIVERED: every product on it has a delivered quantity of zero.' }))
      .toBe('The delivery was not completed. Every product on it has a delivered quantity of zero.');
  });
  it.each([
    ['DELIVERY_OVER_ORDER', 'Atrazine 4L — only 0 left to schedule (ordered 10, delivered 10, on other open deliveries 0: none). Cancel another delivery for this order, or reduce one that has not started, first.'],
    ['ORDER_LINE_BELOW_DELIVERIES', 'Atrazine 4L cannot go below 10 (delivered 0, on open deliveries 10: DEL-1 (10)). Cancel those deliveries, or reduce ones that have not started, first.'],
    ['ORDER_LINE_QUANTITY_NOT_FINITE', 'Atrazine 4L — ordered and delivered quantities must be finite numbers.'],
    ['ORDER_LINE_CHECK_ISOLATION', 'delivery and order quantities can only change in a read-committed transaction.'],
  ])('explains an order-quantity refusal %s (F05) without the raw token', (token, sentence) => {
    expect(sanitizeError({ code: '23514', message: `${token}: ${sentence}` })).toBe(`Nothing was saved. ${sentence}`);
  });
  it('explains the older New Delivery cross-load refusal in words, without the raw token or line id', () => {
    const message = 'ITEM_OVER_REMAINING_INCL_ACTIVE: order_item_id 2b680d4a-7765-4f02-b9a4-b5cef819709b has 2 units on other active deliveries; only 0 available (2 remaining on order minus 2 active)';
    const shown = sanitizeError({ code: 'P0001', message });
    expect(shown).toBe('Nothing was saved. Other open deliveries for this order already hold 2 of this product, so only 0 more can be scheduled. Lower the quantity, or cancel or reduce another delivery for this order first.');
    expect(shown).not.toMatch(/ITEM_OVER|2b680d4a/);
  });
  it.each(['delivery_items_quantity_finite_chk', 'delivery_items_quantity_delivered_finite_chk'])('explains the finite-quantity check %s on delivery lines in plain words', (name) => {
    const shown = sanitizeError({ code: '23514', message: `new row for relation "delivery_items" violates check constraint "${name}"` });
    expect(shown).toBe('Nothing was saved. Delivery quantities must be ordinary numbers. Reload the delivery and enter them again');
  });
  it('keeps a mixed-case product name as written (Sol r5 LOW)', () => {
    const sentence = 'pH Plus — this would deliver more than was ordered. Call the office before completing this delivery.';
    expect(sanitizeError({ code: '23514', message: `DELIVERY_EXCEEDS_ORDER: ${sentence}` })).toBe(`The delivery was not completed. ${sentence}`);
  });
  it('explains a completion past the order (F05) without the raw token', () => {
    const sentence = 'Atrazine 4L — this would deliver more than was ordered. Call the office before completing this delivery.';
    expect(sanitizeError({ code: '23514', message: `DELIVERY_EXCEEDS_ORDER: ${sentence}` })).toBe(`The delivery was not completed. ${sentence}`);
  });
  it('explains a not-a-number count (20270126110000)', () => {
    expect(sanitizeError({ code: '23514', message: 'CYCLE_COUNT_QTY_INVALID: the counted quantity must be a number.' }))
      .toBe('Nothing was saved. the counted quantity must be a number.');
  });
  it('keeps a delivery-line sentence that starts with "s" whole', () => {
    expect(sanitizeError({ code: '23514', message: 'DELIVERY_LINE_DUPLICATE:same order line twice.' })).toBe('Nothing was saved. same order line twice.');
  });
  it('explains the delivery-line unique index (20270126110000) as a duplicate line', () => {
    expect(sanitizeError({ code: '23505', message: 'duplicate key value violates unique constraint "delivery_items_one_line_per_order_line"' }))
      .toMatch(/^Nothing was saved. This order line is already on the delivery/);
  });
  it('explains a unit-rule refusal (20270121110000) without the raw token', () => {
    const sentence = 'this purchase order line is in "Gallon" but the product is stocked in "Gal". Enter the quantity in Gal.';
    expect(sanitizeError({ code: '23514', message: `LINE_UNIT_NOT_STOCK_UNIT: ${sentence}` }))
      .toBe(`Nothing was saved. ${sentence}`);
  });
  it.each([
    ['PRODUCT_STOCK_UNIT_UNKNOWN', '"Tote" is not a known unit; pick a stock unit from the list.'],
    ['PRODUCT_UNIT_HAS_STOCK', 'this product\'s stock unit cannot change to "Qt" while it has stock counted in "Gal". Bring its stock to zero (or convert it) first.'],
    ['STOCK_ROW_UNIT_NOT_STOCK_UNIT', 'this stock row is in "Qt" but the product is stocked in "Gal".'],
    ['PRODUCT_UNIT_HAS_HISTORY', 'this product\'s stock unit cannot change to "Qt" because it already has orders, purchases, deliveries, returns, stock movements or holds (order ORD-0001, return RMA-0001). Set up a new product for the new unit.'],
  ])('explains a %s refusal without the raw token', (token, sentence) => {
    expect(sanitizeError({ code: '23514', message: `${token}: ${sentence}` })).toBe(`Nothing was saved. ${sentence}`);
  });
  // The RAISE texts and index of 20270119130000_one_open_count_per_stock_row.sql (KI-160).
  it.each([
    ['CYCLE_COUNT_ROW_ALREADY_OPEN', 'This stock row is already on open count CC-0018; finish or cancel that count first.'],
    ['CYCLE_COUNT_ROW_WRONG_PLACE', "This stock row is not this product at this count's warehouse."],
    ['CYCLE_COUNT_REOPEN_FORBIDDEN', 'Count CC-0017 is cancelled and cannot become in_progress; a count only moves forward. Start a new count instead.'],
    ['CYCLE_COUNT_REVERSE_BLOCKED', 'Count CC-0017 shares stock with open count CC-0018; finish or cancel that count before reversing this one.'],
  ])('explains a %s refusal without the raw token', (token, sentence) => {
    expect(sanitizeError({ code: '23514', message: `${token}: ${sentence}` })).toBe(`Nothing was saved. ${sentence}`);
  });
  it('explains a second open count at one warehouse', () => {
    expect(sanitizeError({ code: '23505', message: 'duplicate key value violates unique constraint "cycle_counts_one_open_per_warehouse"' }))
      .toBe('Nothing was saved. This warehouse already has an open count; finish or cancel it first');
  });

  // The RAISE texts of 20261105190000_sale_lines_refuse_missing_price.sql with the product filled in.
  it.each([
    ['QUOTE_PRICE_MISSING', "Atrazine 4L has no price for this quote's tier, so its line would show $0. Type a price on the line, or set the product's prices first (give it a $0 price if you give it away)."],
    ['ORDER_PRICE_MISSING', "Atrazine 4L has no price for this customer's tier, so its line would bill $0. Enter a price for the line, or set the product's prices first (give it a $0 price if you give it away)."],
    ['INVOICE_PRICE_MISSING', "Atrazine 4L has no price for this customer's tier, so its line would bill $0. Enter a price for the line, or set the product's prices first (give it a $0 price if you give it away)."],
  ])('explains a %s refusal by product name without the raw token', (code, sentence) => {
    expect(sanitizeError({ code: 'P0001', message: `${code}: ${sentence}` })).toBe(`Nothing was saved. ${sentence}`);
  });

  it.each(['IN_PROGRESS', 'ISOLATION', 'STALE_CALL'])('explains exhausted %s cutover refusals without raw database tokens', (token) => {
    expect(sanitizeError({ code: '40001', message: `GENERIC_FIELD_CUTOVER_${token}: diagnostic detail` }))
      .toBe('No invoice was changed. An invoice update is finishing; wait a moment, then try Save again');
    expect(sanitizeError(`GENERIC_FIELD_CUTOVER_${token}_UNKNOWN`))
      .toBe(`GENERIC_FIELD_CUTOVER_${token}_UNKNOWN`);
  });

  // The two strings below are the real RAISE text from
  // supabase/migrations/20260914101000_field_app_invoice_cross_season_edit_guard.sql (lines 265,
  // 288) with the format placeholders filled, so this proves the production message is handled
  // rather than a string invented for the test. Before this mapping existed, the generic invoice
  // editor fell through to `return message` and showed the raw token. (CodeRabbit on PR #786.)
  it('explains a filed-season date refusal and keeps the allowed range', () => {
    const detail = 'this invoice is filed in season 2026, so its transaction date must stay '
      + 'between 2025-10-01 and 2026-09-30';
    const shown = sanitizeError(`INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED: ${detail}`);
    expect(shown).not.toContain('INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED');
    expect(shown).toContain('filed season');
    // The date range is the operator's actual answer, so it must survive sanitizing.
    expect(shown).toContain('2025-10-01');
    expect(shown).toContain('2026-09-30');
    // The reported member can be a sibling, so its season is never attributed to "this invoice".
    expect(shown).toContain('The conflicting invoice is filed in season 2026');
    expect(shown).not.toContain('this invoice is filed in season');
  });

  it('never echoes an unrecognised filed-season detail verbatim', () => {
    const shown = sanitizeError('INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED: unexpected server wording');
    expect(shown).not.toContain('unexpected server wording');
    expect(shown).toContain('every group member must keep its filed season');
  });

  it('explains a bare filed-season date refusal with no detail after the token', () => {
    const shown = sanitizeError('INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED');
    expect(shown).not.toContain('INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED');
    expect(shown).toContain('Keep the original transaction date');
  });

  it('explains an immutable filed season without echoing the invoice id', () => {
    const id = '3f0c1d2e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
    const shown = sanitizeError(
      `INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED: field-application invoice ${id} is permanently filed in season 2026`
    );
    expect(shown).not.toContain('INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED');
    expect(shown).not.toContain(id);
    expect(shown).toBe('No invoice was changed. The filed season of a field-application invoice cannot be changed');
  });

  it('explains a refused invoice for a delivery billed outside CRX', () => {
    const shown = sanitizeError('DELIVERY_BILLED_OUTSIDE_CRX: this delivery was billed outside CRX, so CRX will not invoice it again');
    expect(shown).not.toContain('DELIVERY_BILLED_OUTSIDE_CRX');
    expect(shown).toBe('No invoice was created. This delivery (or a delivery on this order) was already billed outside CRX, so CRX will not bill it again');
  });

  it('explains a refused move of a delivery billed outside CRX', () => {
    const shown = sanitizeError('BILLED_OUTSIDE_DELIVERY_ORDER_LOCKED: delivery DEL-00060 was billed outside CRX, so it cannot be moved to another order');
    expect(shown).not.toContain('BILLED_OUTSIDE_DELIVERY_ORDER_LOCKED');
    expect(shown).toBe('Nothing was changed. This delivery was billed outside CRX, so it cannot be moved to another order');
  });

  it('explains the cumulative order delivery cap without exposing server details', () => {
    expect(sanitizeError('ORDER_INVOICE_EXCEEDS_DELIVERED: internal detail'))
      .toBe('Nothing was changed. Product quantities across all invoices for this order cannot exceed completed deliveries. Refresh the invoice and bill only delivered goods. Record advance payments as prepay');
  });

  it('tells the user to void the posted invoice before voiding or cancelling its delivery', () => {
    expect(sanitizeError('DELIVERY_HAS_POSTED_INVOICE: void the posted invoice for delivery D-1 before voiding or cancelling it'))
      .toBe('Nothing was changed. This delivery, or its order, has an active invoice that is posted, paid, overdue or reversed (unposted). Void that invoice first, then void or cancel the delivery. For a completed delivery, an admin can use Fix Delivery to do both at once');
  });

  it('maps the Fix Delivery refusals to plain English', () => {
    expect(sanitizeError('FIX_DELIVERY_REFUSED: A payment is applied')).toMatch(/^Nothing was changed\. Something on this delivery now blocks a fix/);
    expect(sanitizeError('FIX_DELIVERY_PREVIEW_STALE: x')).toMatch(/its invoices or the order.s drafts changed/);
    expect(sanitizeError('DELIVERY_ORDER_BUSY_RETRY')).toMatch(/being updated elsewhere/);
    expect(sanitizeError('ORDER_VOIDED_DELIVERY_LOCKED: delivery DEL-1 belongs to a voided order'))
      .toMatch(/^Nothing was changed\. This delivery's order is voided/);
  });

  it('tells the user a completed delivery is voided, not cancelled', () => {
    expect(sanitizeError('DELIVERY_COMPLETED_USE_VOID: a completed delivery cannot be cancelled; an admin must void it instead'))
      .toBe('Nothing was changed. This delivery is already completed, so it cannot be cancelled. An admin can void it instead');
  });

  it('explains an order line with no unit (KI-76)', () => {
    expect(sanitizeError("ORDER_LINE_UNIT_MISSING: order SO-1 has a line with no unit (Roundup). Set each line's unit on the order, then create the invoice again"))
      .toBe("Nothing was billed. A line on this order has no unit. Set each line's unit on the order before billing it");
  });

  it('explains an invoice line with no unit at posting (KI-76)', () => {
    expect(sanitizeError('INVOICE_LINE_UNIT_MISSING: invoice INV-1 has a line with no unit (Roundup). Set the unit on the product, save the draft invoice, then post it again'))
      .toBe('Nothing was posted. A line on this invoice has no unit. Set the unit on the product, save the draft invoice, then post it again');
  });

  it('explains an incomplete order invoice line separately from the delivered cap', () => {
    expect(sanitizeError('ORDER_INVOICE_LINE_INVALID: a non-product line requires a charge type'))
      .toBe('Nothing was changed. This order invoice has an incomplete or invalid line. Each sale line needs a product and nonnegative quantity; each non-product line needs a charge type. Remove and re-add an incomplete line');
  });

  it('explains a delivery invoice that bills beyond its delivery', () => {
    expect(sanitizeError('DELIVERY_INVOICE_EXCEEDS_DELIVERED: invoice CS-2026-0055 bills 8.0000 of Capreno, but delivery DEL-00074 allows 6'))
      .toBe('Nothing was changed. This invoice is for one delivery, so it can bill only the products and quantities that delivery delivered (invoice CS-2026-0055 bills 8.0000 of Capreno, but delivery DEL-00074 allows 6)');
    expect(sanitizeError('DELIVERY_INVOICE_EXCEEDS_DELIVERED: invoice CS-2026-0200 cannot be posted before delivery DEL-00090 is completed'))
      .toBe('Nothing was posted. This invoice is for one delivery, so it can be posted only after that delivery is completed (invoice CS-2026-0200 cannot be posted before delivery DEL-00090 is completed)');
    expect(sanitizeError('DELIVERY_INVOICE_EXCEEDS_DELIVERED: invoice CS-2026-0055 bills [PROVER] linked from an order line delivery DEL-00074 did not carry'))
      .toBe('Nothing was changed. This invoice is for one delivery, so it can bill only the products and quantities that delivery delivered (invoice CS-2026-0055 bills [PROVER] linked from an order line delivery DEL-00074 did not carry)');
    // A known shape whose product label carries an identifier, or an unknown shape, shows no detail.
    for (const unsafe of [
      'DELIVERY_INVOICE_EXCEEDS_DELIVERED: invoice CS-2026-0055 bills 8 of 6f000000-0000-4000-8000-000000000001, but delivery DEL-00074 allows 6',
      'DELIVERY_INVOICE_EXCEEDS_DELIVERED: invoice CS-2026-0055 bills 8 of relation "invoice_items", but delivery DEL-00074 allows 6',
      'DELIVERY_INVOICE_EXCEEDS_DELIVERED: invoice CS-2026-0055 bills anything at all here',
    ]) {
      expect(sanitizeError(unsafe)).toBe('Nothing was changed. This invoice is for one delivery, so it can bill only the products and quantities that delivery delivered');
    }
    const unknown = sanitizeError('DELIVERY_INVOICE_EXCEEDS_DELIVERED: relation "x" 6f000000-0000-4000-8000-000000000001');
    expect(unknown).toBe('Nothing was changed. This invoice is for one delivery, so it can bill only the products and quantities that delivery delivered');
    expect(unknown).not.toContain('DELIVERY_INVOICE_EXCEEDS_DELIVERED');
  });

  it('explains a delivery invoice line with no product and no charge type (billing plan M1)', () => {
    expect(sanitizeError('DELIVERY_INVOICE_EXCEEDS_DELIVERED: invoice CS-2026-0281 has a line with no product and no charge type, or a negative quantity; a delivery invoice bills the products delivery DEL-00001 delivered, plus typed charges (freight, application fee, service, other)'))
      .toBe('Nothing was changed. Every line on this invoice needs a product, or a charge type (freight, application fee, service or other), and no quantity can be negative (invoice CS-2026-0281)');
  });

  it('explains an order billed both per delivery and whole-order', () => {
    expect(sanitizeError('ORDER_INVOICE_OVERLAPS_DELIVERY_INVOICE: this order is already billed per delivery (invoice CS-2026-0055), so a whole-order invoice would bill those goods again; invoice each remaining delivery instead'))
      .toBe('Nothing was saved. This order is already billed delivery by delivery, so a whole-order invoice would bill those goods twice. Invoice each remaining delivery instead');
    expect(sanitizeError('ORDER_INVOICE_OVERLAPS_DELIVERY_INVOICE: this order already has a whole-order invoice (CS-2026-0300), so a delivery invoice would bill those goods again'))
      .toBe('Nothing was saved. This order already has a whole-order invoice, so a delivery invoice would bill those goods twice');
  });

  it('explains a refused change to a deleted order', () => {
    expect(sanitizeError('ORDER_DELETED_STATUS_LOCKED: order ORD-1 is deleted, so it cannot be restored or have its status changed'))
      .toBe('Nothing was changed. This order has been deleted, so it cannot be changed or restored');
    expect(sanitizeError('ORDER_DELETED_DELIVERIES_LOCKED: order ORD-1 is deleted, so its deliveries cannot change'))
      .toBe('Nothing was changed. This order has been deleted, so it cannot be changed or restored');
    expect(sanitizeError('ORDER_DELETED_LINES_LOCKED: order ORD-1 is deleted'))
      .toBe('Nothing was changed. This order has been deleted, so it cannot be changed or restored');
  });

  it('does not swallow a longer token that merely starts the same way', () => {
    expect(sanitizeError('INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED_SOMETHING_ELSE'))
      .toBe('INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED_SOMETHING_ELSE');
    expect(sanitizeError('INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED_SOMETHING_ELSE'))
      .toBe('INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED_SOMETHING_ELSE');
  });

  it('directs generic field creation to its supported creators', () => {
    expect(sanitizeError('FIELD_APPLICATION_VIA_SAVE_INVOICE_NOT_ALLOWED: use dedicated creators'))
      .toBe('Create this field invoice from its job, blend ticket, or the Field Application screen');
  });

  it('explains that only a field application invoice is edited on the field application screen', () => {
    expect(sanitizeError('FIELD_APP_INVOICE_REQUIRED: invoice 00000000-0000-4000-8000-000000000001 is not a field application invoice'))
      .toBe('Nothing was saved. This invoice is not a field application invoice, so it cannot be edited here. Open it from Invoices instead');
  });

  it('passes the grower-share rounding refusal through with its product name', () => {
    expect(sanitizeError('FIELD_APP_GROWER_SHARE_ROUNDING: cannot cost "Dry X" in the grower share — 0.00003125 ton is too small to record to 4 decimals without its cost changing by more than $0.50. Record this product in a smaller sold unit before invoicing this field application.'))
      .toBe('Nothing was saved. Cannot cost "Dry X" in the grower share — 0.00003125 ton is too small to record to 4 decimals without its cost changing by more than $0.50. Record this product in a smaller sold unit before invoicing this field application.');
  });

  it('passes a rep\'s grower-share below-cost refusal through without a cost', () => {
    expect(sanitizeError('FIELD_APP_GROWER_SHARE_BELOW_COST: the grower\'s per-acre price on this invoice does not cover the cost of the chemicals included in it. Raise the per-acre price, bill the chemicals on their own lines, or ask an admin to save this invoice.'))
      .toBe('Nothing was saved. The grower\'s per-acre price on this invoice does not cover the cost of the chemicals included in it. Raise the per-acre price, bill the chemicals on their own lines, or ask an admin to save this invoice.');
  });

  it('maps return-credit and customer-scope tokens to operator guidance', () => {
    expect(sanitizeError('CUSTOMER_SCOPE_DENIED')).toBe('You can only work with customers assigned to you');
    expect(sanitizeError('REP_CANNOT_REASSIGN')).toBe('Only an admin can change which sales rep a customer is assigned to');
    expect(sanitizeError('PO_COST_REASON_REQUIRED: say why the cost of a received line is changing'))
      .toBe('Say why the cost of a received line is changing');
    expect(sanitizeError('PO_CANCELLED: cannot change cost on a cancelled purchase order'))
      .toBe('This purchase order is cancelled, so its cost cannot change');
    expect(sanitizeError('PO_COST_BELOW_BILLED: this correction would put the active vendor bills more than 5% over what arrived on the purchase order or over its ordered total; void or adjust the bill first'))
      .toBe('This would put the vendor bills more than 5% over what has arrived on the purchase order, or over its ordered total. Void or adjust the bill first');
    expect(sanitizeError('COMMISSION_SPLIT_ADMIN_ONLY: only an admin can change a customer\'s default commission split'))
      .toBe("Only an admin can set or change a customer's default commission split");
    expect(sanitizeError('COMMISSION_SPLIT_ADMIN_ONLY: only an admin can set a customer\'s default commission split'))
      .toBe("Only an admin can set or change a customer's default commission split");
    expect(sanitizeError('TIER_ADMIN_ONLY: only an admin can change a customer\'s price tier'))
      .toBe("Only an admin can set or change a customer's price tier");
    expect(sanitizeError('CREDIT_LIMIT_ADMIN_ONLY: only an admin can change a customer\'s credit limit'))
      .toBe("Only an admin can set or change a customer's credit limit");
    expect(sanitizeError('QUOTE_TIER_PLANNED_VIA_SAVE_QUOTE: a booking\'s tier and planned flag change only by saving the quote'))
      .toBe("A booking's tier and planned flag change only by saving the quote");
    expect(sanitizeError('SALESMAN_SCOPE_DENIED')).toBe("Sales reps work under their own name: choose yourself as the salesman, or ask an admin to handle another salesman's work");
    expect(sanitizeError('INVOICE_SCOPE_DENIED')).toBe('You can only change or post invoices under your own name');
    // Replay-binding refusals (20261016060000): nothing changed, and the operator is told why.
    const intent = sanitizeError({ message: 'IDEMPOTENCY_INTENT_MISMATCH', details: '{"result":{"id":"x"}}' });
    expect(intent).toContain('Nothing was changed');
    expect(intent).toContain('different, earlier request');
    expect(intent).toContain('Refresh');
    const retired = sanitizeError({ message: 'IDEMPOTENCY_REQUEST_RETIRED: idempotency_key adjust_inventory_batch:u:1:2 belongs to a request that was cleared after it got stuck; it cannot be saved' });
    expect(retired).toContain('Nothing was changed');
    expect(retired).toContain('This request was cleared');
    expect(retired).not.toMatch(/adjust_inventory|IDEMPOTENCY/);
    const actor = sanitizeError('IDEMPOTENCY_ACTOR_MISMATCH');
    expect(actor).toContain('Nothing was changed');
    expect(actor).toContain('another user');
    expect(actor).toContain('Reload');
    // The raw text carries the key; the first attempt committed, so "nothing changed" would be false.
    const edited = sanitizeError({ message: 'IDEMPOTENCY_ARGUMENT_MISMATCH: key allocate_payment:u:1 was already used for different allocate_payment arguments' });
    expect(edited).toContain('earlier attempt');
    expect(edited).toContain('may have saved');
    expect(edited).not.toMatch(/allocate_payment|IDEMPOTENCY/);
    for (const token of ['IDEMPOTENCY_RECEIPT_MISSING', 'IDEMPOTENCY_RESULT_INVALID']) {
      const receipt = sanitizeError(token);
      expect(receipt).toContain('Nothing was changed now');
      expect(receipt).toContain('could not be confirmed');
      expect(receipt).toContain('Refresh');
    }
    expect(sanitizeError('CUSTOMER_HAS_OPEN_INVOICES: this customer has posted or overdue invoices; resolve them before deactivating it'))
      .toBe('This customer has posted or overdue invoices. Resolve them before deactivating the customer');
    expect(sanitizeError({ message: 'CUSTOMER_HAS_OPEN_WORK: nothing was deactivated. Smith Farms still has 2 open order(s), 1 open quote(s). Finish or cancel that work, bill it, credit its returns and use up or refund its prepay first' }))
      .toBe('Nothing was deactivated. Smith Farms still has 2 open order(s), 1 open quote(s). Finish or cancel that work, bill it, credit its returns and use up or refund its prepay first.');
    expect(sanitizeError('CUSTOMER_HAS_OPEN_WORK')).toContain('spray jobs, returns or prepay money). Finish, bill or settle it before deactivating it.');
    expect(sanitizeError({ message: 'JOB_LINE_BELOW_COST: Roundup ‮Pro is priced below its cost on this job. Nothing was invoiced; its price must be corrected before this job can be invoiced.' }))
      .toBe('Roundup Pro is priced below its cost on this job. Nothing was invoiced; its price must be corrected before this job can be invoiced.');
    expect(sanitizeError('JOB_LINE_BELOW_COST')).toContain('priced below its cost');
    expect(sanitizeError('JOB_DELETED: this job was deleted')).toBe("This job was deleted, so it can't be invoiced. Nothing was invoiced.");
    expect(sanitizeError('JOB_FIELD_NO_BILLING_SPLIT: North 40 has no billing split. Nothing was invoiced; set who pays for it (100% or a shared split) in Field Setup first.'))
      .toBe('North 40 has no billing split. Nothing was invoiced; set who pays for it (100% or a shared split) in Field Setup first.');
    expect(sanitizeError('JOB_LINE_PRICE_NOT_WHOLE_CENTS: Roundup is priced per "Gal" on this job, which comes to a fraction of a cent per "Qt" (the unit it is sold in), and rounding that changes the line by more than $0.50. Nothing was invoiced; change the job price per "Gal" so it converts to whole cents per "Qt" (for example $41.52).'))
      .toBe('Roundup is priced per "Gal" on this job, which comes to a fraction of a cent per "Qt" (the unit it is sold in), and rounding that changes the line by more than $0.50. Nothing was invoiced; change the job price per "Gal" so it converts to whole cents per "Qt" (for example $41.52).');
    expect(sanitizeError('JOB_LINE_UNIT_UNCONVERTIBLE: Roundup is recorded on this job in "Ea", which can\'t be converted to the unit it is sold in ("Gal"). Nothing was invoiced; correct the unit on the job or the product first.'))
      .toBe('Roundup is recorded on this job in "Ea", which can\'t be converted to the unit it is sold in ("Gal"). Nothing was invoiced; correct the unit on the job or the product first.');
    expect(sanitizeError('JOB_LINE_ROUNDING: Round‮up can\'t be recorded to 4 decimals in Gal without its amount changing by more than $0.50.'))
      .toBe("Roundup can't be recorded to 4 decimals in Gal without its amount changing by more than $0.50.");
    expect(sanitizeError('JOB_LINE_COST_MISSING: Roundup has no cost recorded.')).toBe('Roundup has no cost recorded.');
    expect(sanitizeError('JOB_LINE_QUANTITY_INVALID')).toContain('check its quantity, unit and cost');
    expect(sanitizeError("JOB_INVOICED_LOCKED: This job has been invoiced, so its chemicals, fields and billing split can't be changed. Nothing was saved; void the job's invoice first to change them."))
      .toBe("This job has been invoiced, so its chemicals, fields and billing split can't be changed. Nothing was saved; void the job's invoice first to change them.");
    expect(sanitizeError("JOB_COMPLETED_CHEMICALS_LOCKED: This job is complete, so its chemicals can't be changed: completion already took them from stock. Nothing was saved."))
      .toBe("This job is complete, so its chemicals can't be changed: completion already took them from stock. Nothing was saved.");
    expect(sanitizeError('JOB_LINE_BELOW_COST: Round​up\nPro\u0007 is priced below its cost on this job.'))
      .toBe('Roundup Pro is priced below its cost on this job.');
    expect(sanitizeError('CUSTOMER_HAS_OPEN_WORK: nothing was deactivated. \u202Esmraf\u202C\u061C still has open invoices. Settle them first'))
      .toBe('Nothing was deactivated. smraf still has open invoices. Settle them first.');
    expect(sanitizeError({ message: 'CUSTOMER_INACTIVE_NEW_WORK: nothing was saved. This customer is inactive. An admin or sales rep must reactivate the customer before new orders, deliveries, stock holds or spray jobs are added' }))
      .toBe('Nothing was saved. This customer is inactive. An admin or sales rep must reactivate the customer before new orders, deliveries, stock holds or spray jobs are added');
    expect(sanitizeError('CUSTOMER_INACTIVE_NEW_WORK')).toContain('must reactivate the customer');
    expect(sanitizeError({ message: 'new row for relation "inventory_holds" violates check constraint "inventory_holds_source_needs_customer"' }))
      .toBe('Nothing was saved. A stock hold for a spray job or quote must name its customer');
    expect(sanitizeError({ message: 'WORK_CUSTOMER_MOVE_NOT_ALLOWED: nothing was saved. Only an admin or sales rep can move an order, delivery, stock hold or spray job to another customer or order, or reopen a delivery' }))
      .toBe('Nothing was saved. Only an admin or sales rep can move an order, delivery, stock hold or spray job to another customer or order, or reopen a delivery');
    // The hold-rule name inside some other message is not mistaken for the rule.
    expect(sanitizeError({ message: 'Product inventory_holds_source_needs_customer not found' }))
      .not.toBe('Nothing was saved. A stock hold for a spray job or quote must name its customer');
    expect(sanitizeError('PREPAY_BALANCE_SERVER_ONLY: a prepay balance changes only through prepayments and payments'))
      .toBe('A prepay balance changes only through prepayments and payments');
    expect(sanitizeError('RETURN_CREDIT_UNIT_MISMATCH')).toContain('original sale');
    expect(sanitizeError('RETURN_CREDIT_INVENTORY_UNIT_MISMATCH')).toContain('warehouse inventory unit');
    expect(sanitizeError('RETURN_CREDIT_UNLINKED_COST_LINE')).toContain('Review the credit memo');
    expect(sanitizeError('RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED')).toBe(
      'Void or unapply the related return credit before moving this sale invoice out of a recognized status or deleting it'
    );
    expect(sanitizeError('RETURN_CREDIT_SOURCE_POST_REQUIRES_REISSUE')).toContain('cannot be posted');
    expect(sanitizeError('RETURN_CREDIT_HEADER_IMMUTABLE')).toContain('Use Void');
    expect(sanitizeError('RETURN_CREDIT_PARENT_IMMUTABLE')).toContain('Void or unapply');
    expect(sanitizeError('RETURN_CREDIT_LINE_TOTAL_MISMATCH')).toContain('no changes were saved');
    expect(sanitizeError('RETURN_CREDIT_CUTOVER_IN_PROGRESS')).toContain('briefly paused');
    expect(sanitizeError('ORDER_INVOICE_TERMINAL')).toContain('already final');
    expect(sanitizeError(
      'ORDER_HAS_FIELD_SPLIT: this order is split across fields; bill it per field owner through create_split_invoices_from_order'
    )).toBe("Nothing was billed. This order's lines are split across fields, so it is billed by field. Refresh the page, then choose Create Invoice again");
    expect(sanitizeError("BILL_SPLIT_FROZEN: delivery DEL-1 is complete, so this sale's bill split can't change. Void the delivery to change it."))
      .toContain('its bill split is locked');
    expect(sanitizeError('BILL_SPLIT_HAS_DRAFT: draft invoice CS-1 bills this sale to one customer.')).toBe(
      "Nothing was changed. A draft invoice bills this sale to one customer. Remove that draft to change the bill split"
    );
    expect(sanitizeError('ORDER_ITEM_SHARES_BUSY: a delivery on this sale is being completed; try again')).toBe(
      'Nothing was changed. A delivery on this sale is being completed. Try again in a moment',
    );
    expect(sanitizeError('ORDER_ITEM_SHARES_LINE_MOVED: the line moved to another order; try again')).toBe(
      'Nothing was changed. This line moved to another order. Refresh the page and try again',
    );
    expect(sanitizeError('ORDER_ITEM_SHARES_LINE_MOVE: this line has its own bill split')).toBe(
      'Nothing was changed. This line has its own bill split. Remove its shares before moving it to another order',
    );
    expect(sanitizeError('STANDING_DISCOUNT_SPLIT_LOCKED: this invoice is part of a field split, which can\'t be edited')).toBe(
      "Nothing was changed. This draft can't be edited (it's part of a field split, or a Bill Split payer's draft with a product line that has no quantity), so its discount can't change. Void the group and redraft it",
    );
    expect(sanitizeError("BILLING_M4_OFF: sales tax isn't switched on yet; it turns on with commission")).toBe(
      "Nothing was changed. Sales tax and standing discounts aren't switched on yet; they turn on with commission",
    );
    expect(sanitizeError("BILL_SPLIT_SLIVER_LOCKED: this payer's draft has a product line with no quantity")).toBe(
      "Nothing was saved. This payer's draft has a product line with no quantity, so it can't be edited. Post it as drafted, or void the group",
    );
    expect(sanitizeError("BILL_SPLIT_CUSTOMER_INACTIVE: an inactive customer can't be added")).toBe(
      "Nothing was changed. This customer is inactive, so they can't be added to a bill split. Reactivate them first",
    );
    expect(sanitizeError('GROUP_UNPOST_REQUIRED')).toBe(
      'Nothing was unposted. This invoice is part of a split group, so the whole group unposts together. Refresh the page and try again',
    );
    expect(sanitizeError('BILL_SPLIT_LINES_LOCKED: follow the split')).toBe(
      "Nothing was saved. A Bill Split invoice's product lines follow the split. Void the group to change them; charges can still be added"
    );
    expect(sanitizeError('BILL_SPLIT_GROUP_DELETE_PARTIAL: select every payer')).toBe(
      "Nothing was deleted. A Bill Split group's drafts go together: select every payer's draft to delete them"
    );
    expect(sanitizeError('BILL_SPLIT_QUANTITY_TOO_SMALL: delivery D-1')).toBe(
      "Nothing was billed. A payer's share of a product is under 0.0001 of a unit. Change the bill split so each payer gets at least 0.0001"
    );
    expect(sanitizeError('BILL_SPLIT_QUANTITY_TOO_FINE: delivery D-1 delivered 1.23456')).toBe(
      "Nothing was billed. A delivered amount has more than 4 decimal places, which an invoice line can't hold. Correct it with Fix Delivery, then choose Create Invoice"
    );
    expect(sanitizeError('RETURN_QUANTITY_TOO_FINE: a return holds 2 decimal places')).toBe(
      'Nothing was returned. A return holds 2 decimal places. Enter a quantity like 0.70'
    );
    expect(sanitizeError('PRICING_INCOMPLETE: price the order before its Bill Split invoices are drafted')).toBe(
      'Nothing was billed. This sale still needs prices. Price it, then choose Create Invoice on the delivery'
    );
    expect(sanitizeError('SPLIT_INVOICE_PROVENANCE_IMMUTABLE: x')).toBe(
      'Nothing was changed. This split invoice is locked to its group. Void the group and create a replacement'
    );
    expect(sanitizeError('ORDER_SHARES_OVER_100: order x')).toBe("Nothing was changed. The bill split can't total more than 100%");
    expect(sanitizeError('ORDER_SHARES_ORDER_IMMUTABLE: x')).toBe("Nothing was changed. A bill split row can't move to another order");
    expect(sanitizeError('ORDER_ITEM_SHARES_LINE_IMMUTABLE: x')).toBe("Nothing was changed. A line share can't move to another line");
    expect(sanitizeError('BILL_SPLIT_NOTHING_TO_BILL: delivery D-1')).toBe(
      'Nothing was billed. This delivery has no delivered quantity'
    );
    expect(sanitizeError('ORDER_HAS_BILL_SPLIT: this sale has a bill split, so it cannot be billed as one invoice'))
      .toContain('billed per payer');
    expect(sanitizeError("ORDER_ITEM_SHARES_OVER_100: a line's shares can't total more than 100%"))
      .toContain('more than 100%');
    expect(sanitizeError('INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID: invoice and order customer must match'))
      .toContain("only be for that order's customer");
    expect(sanitizeError(
      'ORDER_VOID_DRAFT_HAS_APPLIED_MONEY: draft invoice INV-1 carries a recorded payment, prepay, write-off or credit; reverse it before voiding the order'
    )).toContain('Reverse that first, then void the order');
    expect(sanitizeError('ORDER_LIFECYCLE_BUSY_RETRY')).toContain('Wait a moment');
    expect(sanitizeError('RETURN_CREDIT_LEDGER_IMMUTABLE')).toContain('source or cost lines');
    expect(sanitizeError('RETURN_CREDIT_HEADER_RESULT_INVALID')).toContain('could not be completed safely');
    expect(sanitizeError('RETURN_CREDIT_SOURCE_CONCURRENT')).toBe(
      'A related invoice or return credit is being changed elsewhere. Wait a moment and try again'
    );
    expect(sanitizeError('RETURN_CREDIT_VOID_RELEASE_FAILED')).toContain('no changes were saved');
    expect(sanitizeError('RETURN_CREDIT_UNAPPLY_RELEASE_FAILED')).toContain('no changes were saved');
    expect(sanitizeError('RETURN_CREDIT_COGS_LEDGER_MISSING')).toContain('protected cost source');
    expect(sanitizeError('RETURN_CREDIT_REVERSAL_EXCEEDS_RECOGNIZED')).toContain('No changes were saved');
    expect(sanitizeError('RETURN_CREDIT_REVERSAL_EXCEEDS_RECOGNIZED:RMA-2026-0007:[{"product_id":"secret"}]'))
      .not.toContain('secret');
    expect(sanitizeError('RETURN_NOT_APPROVED:requested')).toContain('must be approved');
    expect(sanitizeError('RETURN_NOT_APPROVED:received')).toBe('This return is already received');
    expect(sanitizeError('RETURN_NOT_APPROVED:credited')).toBe('This return is credited and cannot be received');
  });

  it('returns generic message for null/undefined', () => {
    expect(sanitizeError(null)).toBe('An unexpected error occurred');
    expect(sanitizeError(undefined)).toBe('An unexpected error occurred');
  });

  it('handles Error objects', () => {
    expect(sanitizeError(new Error('Something went wrong'))).toBe('Something went wrong');
  });

  it('handles plain strings', () => {
    expect(sanitizeError('Failed to save')).toBe('Failed to save');
  });

  it('sanitizes duplicate key constraint violations', () => {
    expect(sanitizeError(
      'duplicate key value violates unique constraint "orders_order_number_key"'
    )).toBe('A record with this information already exists');
  });

  it('names a repeated product SKU', () => {
    expect(sanitizeError(
      'duplicate key value violates unique constraint "products_sku_unique"'
    )).toBe('Another product already has this SKU');
  });

  it('names a repeated active product name', () => {
    expect(sanitizeError(
      'duplicate key value violates unique constraint "products_active_name_unique"'
    )).toBe('Another active product already has this name');
  });

  it('sanitizes foreign key constraint violations', () => {
    expect(sanitizeError(
      'insert or update on table "invoices" violates foreign key constraint "invoices_customer_id_fkey"'
    )).toBe('This record references data that does not exist or has been removed');

    expect(sanitizeError(
      'update or delete on table "invoice_items" violates foreign key constraint "invoice_items_return_credit_source_item_fk" on table "invoice_items"'
    )).toBe('This source invoice line is retained as return-credit accounting history and cannot be deleted or re-saved. Keep the source invoice unchanged, or permanently delete the already-voided credit memo before editing it');
  });

  it('sanitizes check constraint violations', () => {
    expect(sanitizeError(
      'new row for relation "payments" violates check constraint "payments_amount_cents_check"'
    )).toBe('The provided value is not valid');
  });

  it('sanitizes not-null constraint violations', () => {
    expect(sanitizeError(
      'null value in column "customer_id" of relation "invoices" violates not-null constraint'
    )).toBe('A required field is missing');
  });

  it('sanitizes value too long errors', () => {
    expect(sanitizeError(
      'value too long for type character varying(255)'
    )).toBe('The provided value is too long');
  });

  it('sanitizes invalid input syntax errors', () => {
    expect(sanitizeError(
      'invalid input syntax for type uuid: "not-a-uuid"'
    )).toBe('Invalid input format');
  });

  it('explains a blank number instead of a generic format error (#2156)', () => {
    expect(sanitizeError('invalid input syntax for type numeric: ""'))
      .toBe('Nothing was saved. A quantity or amount was left blank; enter a number and try again');
    expect(sanitizeError('invalid input syntax for type numeric: "abc"')).toBe('Invalid input format');
  });

  it('sanitizes relation does not exist errors', () => {
    expect(sanitizeError(
      'relation "nonexistent_table" does not exist'
    )).toBe('An internal error occurred. Please try again.');
  });

  it('sanitizes function does not exist errors', () => {
    expect(sanitizeError(
      'function save_quote(p_data jsonb) does not exist'
    )).toBe('An internal error occurred. Please try again.');
  });

  it('sanitizes permission denied errors', () => {
    expect(sanitizeError(
      'permission denied for table "invoices"'
    )).toBe('You do not have permission to perform this action');

    expect(sanitizeError(
      'permission denied for sequence "invoices_id_seq"'
    )).toBe('You do not have permission to perform this action');
  });

  // REGRESSION GUARD. Until 2026-09-02 the permission pattern required QUOTED
  // identifiers, but PostgreSQL emits them unquoted — so every real permission
  // error passed through this function and showed the operator the table name.
  // The two quoted cases above are the form this test file invented; the cases
  // below are the form the database actually produces, and the rest of the repo's
  // fixtures (criticalAction.test.ts, applicatorSheetPrintData.test.ts,
  // previousApplications.test.ts) already used them. Do not "simplify" these back
  // into the quoted-only pattern.
  it('sanitizes permission denied errors with UNQUOTED identifiers (real Postgres form)', () => {
    for (const raw of [
      'permission denied for table orders',
      'permission denied for table job_field_shares',
      'permission denied for schema public',
      'permission denied for sequence invoices_id_seq',
      'permission denied for function save_job',
      'permission denied for materialized view mv_inventory_rollup',
    ]) {
      expect(sanitizeError(raw)).toBe('You do not have permission to perform this action');
      expect(sanitizeError(raw)).not.toContain('orders');
      expect(sanitizeError(raw)).not.toContain('job_field_shares');
    }
  });

  it('sanitizes PostgREST schema-cache misses that name the missing object', () => {
    expect(sanitizeError(
      'Could not find the function public.save_job(p_job_payload, p_performed_by) in the schema cache'
    )).toBe('An internal error occurred. Please try again.');

    expect(sanitizeError(
      "Could not find a relationship between 'orders' and 'order_items' in the schema cache"
    )).toBe('An internal error occurred. Please try again.');
  });

  // The redaction above is deliberately scoped to Postgres's structural
  // `permission denied for <object>` form. A hand-written RAISE EXCEPTION that
  // happens to use the words "permission denied" still reaches the operator,
  // because those are written to be read.
  it('still passes through a hand-written permission refusal that names no object', () => {
    expect(sanitizeError(
      'Permission denied to edit this order — ask the assigned rep.'
    )).toBe('Permission denied to edit this order — ask the assigned rep.');
  });

  it('sanitizes generic schema identifier leaks', () => {
    expect(sanitizeError(
      'column "secret_column" is ambiguous'
    )).toBe('An internal error occurred. Please try again.');
  });

  it('sanitizes rate limit errors', () => {
    expect(sanitizeError(
      'Rate limit exceeded. Please wait before retrying.'
    )).toBe('Too many requests. Please wait a moment and try again.');
  });

  it('passes through safe user-facing RPC error messages', () => {
    expect(sanitizeError('Not authorized to allocate payments')).toBe('Not authorized to allocate payments');
    expect(sanitizeError('Payment amount must be positive')).toBe('Payment amount must be positive');
    expect(sanitizeError('Invoice is already voided')).toBe('Invoice is already voided');
    expect(sanitizeError('Delivery is not in a cancellable state')).toBe('Delivery is not in a cancellable state');
  });

  it('handles plain objects with message property (PostgrestError from Supabase)', () => {
    // Supabase RPC errors return plain objects {message, details, hint, code}
    expect(sanitizeError({
      message: 'Insufficient inventory for Product X: need 100 units, only 0 available',
      details: 'some details',
      hint: null,
      code: 'P0001',
    })).toBe('Insufficient inventory for Product X: need 100 units, only 0 available');

    expect(sanitizeError({
      message: 'Delivery not found',
      code: 'P0001',
    })).toBe('Delivery not found');

    // Plain objects with message that match constraint patterns should still be sanitized
    expect(sanitizeError({
      message: 'duplicate key value violates unique constraint "orders_order_number_key"',
      code: '23505',
    })).toBe('A record with this information already exists');
  });

  it('handles non-string non-Error types', () => {
    expect(sanitizeError(42)).toBe('An unexpected error occurred');
    expect(sanitizeError({})).toBe('An unexpected error occurred');
    expect(sanitizeError([])).toBe('An unexpected error occurred');
  });
});

describe('product setup and import refusals (20261107090000)', () => {
  it('keeps the server text, which names the products', () => {
    expect(sanitizeError({ message: 'PRODUCT_SETUP_DUPLICATE: the SKU or name is already used by a product or twice in this file: Chem' }))
      .toBe('Nothing was saved. The SKU or name is already used by a product or twice in this file: Chem');
  });

  it('explains the sales tax box refusals (billing plan M4a)', () => {
    expect(sanitizeError('SALES_TAX_NOT_ALLOWED: only an admin or the sale\'s own rep can change its sales tax'))
      .toBe("Only an admin or the sale's own rep can turn sales tax on or off for this sale. No changes were saved");
    expect(sanitizeError('SALES_TAX_RATE_MISSING: set the sales tax rate in Settings first'))
      .toBe('Set the sales tax rate in Settings first. No changes were saved');
    expect(sanitizeError('SALES_TAX_STALE: this draft\'s sales tax is out of date; save it again, then post'))
      .toBe("This draft's sales tax is out of date. Save it again, then post");
    expect(sanitizeError("SALES_TAX_BOX_MISMATCH: this draft is untaxed but its sale's sales tax box is on; switch the box over and back, ending at the setting you want, to re-apply it to the sale's drafts (a split draft that can't be edited: set the box back to match it, or void the group and redraft it), then post"))
      .toBe("This draft's sales tax doesn't match its sale's Sales tax box. Switch the box over and back, ending at the setting you want, to re-apply it to the sale's drafts (a split draft that can't be edited: set the box back to match it, or void and redraft its group), then post");
    expect(sanitizeError('SALES_TAX_ORDER_CLOSED: a cancelled or voided sale can\'t change'))
      .toBe("This sale is cancelled or voided, so its sales tax can't change");
  });
});

describe('sanitizeError #2063 blend-billed refusal', () => {
  // The exact sentence 20270224130000 raises (no ticket number since Sol round 3).
  const sentence = (shown: string) => 'a blend ticket for this job is already billed (%); billing the job here too would double-bill the customer. If you meant to bill the job here, ask an admin to void or delete that blend-ticket invoice first.'.replace('%', shown);
  it('keeps the server sentence whole for an invoice the caller may open', () => {
    expect(sanitizeError('BLEND_TICKET_ALREADY_BILLED: ' + sentence('invoice INV-1001')))
      .toBe(sentence('invoice INV-1001'));
  });
  it('keeps the server sentence whole for an invoice the caller cannot open', () => {
    expect(sanitizeError('BLEND_TICKET_ALREADY_BILLED: ' + sentence('an invoice you cannot open')))
      .toBe(sentence('an invoice you cannot open'));
  });
});

describe('customer receipt refusals (KI-25)', () => {
  it('drops the database code and keeps plain words', () => {
    expect(sanitizeError(new Error('DELIVERY_NOT_COMPLETED: this delivery is not completed any more; do not send its receipt')))
      .toBe('Nothing was sent. This delivery is not completed any more, so its receipt must not be sent.');
    expect(sanitizeError(new Error("DELIVERY_RECEIPT_CHANGED: this delivery's receipt was queued again since; reload the page")))
      .toBe("Nothing was changed. This delivery's receipt was queued again since. Reload the page.");
  });
  it('leaves the invoice-posting DELIVERY_NOT_COMPLETED sentence alone', () => {
    const msg = 'DELIVERY_NOT_COMPLETED: delivery D-42 for invoice INV-1002 has been deleted. Void this invoice instead of posting it.';
    expect(sanitizeError(new Error(msg))).not.toMatch(/receipt/);
  });
});
