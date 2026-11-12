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

  it('maps return-credit and customer-scope tokens to operator guidance', () => {
    expect(sanitizeError('CUSTOMER_SCOPE_DENIED')).toBe('You can only work with customers assigned to you');
    expect(sanitizeError('REP_CANNOT_REASSIGN')).toBe('Only an admin can change which sales rep a customer is assigned to');
    expect(sanitizeError('PO_COST_REASON_REQUIRED: say why the cost of a received line is changing'))
      .toBe('Say why the cost of a received line is changing');
    expect(sanitizeError('PO_CANCELLED: cannot change cost on a cancelled purchase order'))
      .toBe('This purchase order is cancelled, so its cost cannot change');
    expect(sanitizeError('PO_COST_BELOW_BILLED: this correction would leave the active vendor bills more than 5% over the purchase order total; void or adjust the bill first'))
      .toBe('This would put the purchase order more than 5% below its vendor bills. Void or adjust the bill first');
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
});
