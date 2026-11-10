/**
 * Sanitize database/RPC error messages before displaying to users.
 * Strips PostgreSQL constraint names, table names, and column references
 * that could leak schema information.
 */

const CONSTRAINT_PATTERNS: Array<[RegExp, string]> = [
  // KI-85: stock may be placed only at Main Warehouse until transfers exist; nothing was received or added.
  [/^UNKNOWN_STORAGE_LOCATION\b/, 'Nothing was saved. Stock can go only into Main Warehouse until transfers between warehouses exist. Choose Main Warehouse and try again'],
  [/^PRODUCT_CATEGORY_RETIRED\b/, 'This category is retired. Choose an active category'],
  [/^PRODUCT_CATEGORY_NAME_REQUIRED\b/, 'Enter a category name'],
  [/^PRODUCT_CATEGORY_FIELDS_REQUIRED\b/, 'Choose a category status and sort order'],
  [/^PRODUCT_CATEGORY_NAME_TOO_LONG\b/, 'Use 100 characters or fewer for a category name'],
  [/^PRODUCT_CATEGORY_ALREADY_EXISTS\b/, 'Use the existing category name'],
  [/^PRODUCT_SETUP_INVALID: product name\b/, 'Enter a product name without outside spaces'],
  [/^PRODUCT_SETUP_INVALID: SKU\b/, 'Enter an SKU without outside spaces, or leave it blank'],
  [/^PRODUCT_SETUP_INVALID: rate per acre\b/, 'Rate Per Acre must be zero or greater'],
  [/^PRODUCT_SETUP_INVALID: EPA number\b/, 'Enter a valid EPA number format'],
  [/^PRODUCT_SETUP_INVALID: REI hours\b/, 'REI hours must be zero or greater'],
  [/^PRODUCT_SETUP_INVALID: PHI days\b/, 'PHI days must be zero or greater'],
  [/product_setup_category_fk/, 'Choose a category from the product category list'],
  [/product_setup_name_check/, 'Enter a product name without spaces at either end'],
  [/product_setup_sku_check/, 'Enter a SKU without spaces at either end, or leave it blank'],
  [/products_sku_unique/, 'Another product already has this SKU'],
  [/products_container_type_check/, 'Choose a container type: Jug, Drum, Pallet, Mini-Bulk, Shuttle, Bag, Tote, Ea or Jar'],
  [/products_active_name_unique/, 'Another active product already has this name'],
  [/product_setup_rate_check/, 'Rate Per Acre must be zero or greater'],
  [/product_setup_epa_check/, 'Enter an EPA number like 524-475 or 100-1234-5905. This checks format only'],
  [/product_setup_rei_check/, 'REI (hours) must be zero or greater'],
  [/product_setup_phi_check/, 'PHI (days) must be zero or greater'],
  // A retry key is bound to the person and the exact request that first used it; the database
  // refuses it for anything else and changes nothing.
  [/^IDEMPOTENCY_INTENT_MISMATCH\b/,
   'Nothing was changed. This retry belonged to a different, earlier request. Refresh the page to see what that request did, then try again'],
  [/^IDEMPOTENCY_ACTOR_MISMATCH\b/,
   'Nothing was changed. This retry belongs to another user. Reload the page and try again'],
  // The first attempt committed under this key, usually a lost reply followed by an edit.
  [/^IDEMPOTENCY_ARGUMENT_MISMATCH\b/,
   'This attempt was not saved, but an earlier attempt with different details may have saved. Check the record before entering it again'],
  // KI-27: this stuck request was cleared, so the database refuses to save it now.
  [/^IDEMPOTENCY_REQUEST_RETIRED\b/,
   'Nothing was changed. This request was cleared after it got stuck. Check the record, then enter it again as a new request if it is still needed'],
  [/^IDEMPOTENCY_(?:RESULT_INVALID|RECEIPT_MISSING)\b/,
   'Nothing was changed now: the outcome of this request could not be confirmed. Refresh the page before trying again'],
  // A completion retried under a fresh key after an earlier attempt already completed the record.
  [/^Delivery must be in_progress to complete \(current status: completed\)/,
   'This delivery is already completed. Refresh the page to see it'],
  // Goal 5 (migration 20261022075000): a completion needs its proof saved first. Nothing changed.
  [/^COMPLETION_EVIDENCE_REQUIRED\b/,
   'This version of the app is out of date. Reload the app, then open the delivery to check whether it is already completed before completing it again'],
  // Every evidence refusal: THIS attempt changed nothing. An earlier attempt may still have completed
  // the delivery (a lost reply), so the pages reload it after any refusal.
  [/^COMPLETION_EVIDENCE_INVALID\b/,
   'This attempt made no change (no stock or invoice change): the proof sent with it was not accepted. The delivery may already be completed by an earlier attempt; check it before trying again'],
  [/^COMPLETION_EVIDENCE_LOCKED\b/,
   'This attempt made no change (no stock or invoice change): the proof saved with a completed delivery cannot be changed or removed. The delivery may already be completed by an earlier attempt; check it before trying again'],
  [/^COMPLETION_EVIDENCE_NOT_RECORDED\b/,
   'This attempt made no change (no stock or invoice change): the proof could not be recorded. The delivery may already be completed by an earlier attempt; check it before trying again'],
  [/^SIGNATURE_IMAGE_MISSING\b/,
   'This attempt made no change (no stock or invoice change): the signature did not reach the server. Check your signal, then try again'],
  [/^PAPER_TICKET_PHOTO_MISSING\b/,
   'This attempt made no change (no stock or invoice change): no photo of the signed paper ticket is saved on it. Take the photo, then tap Complete'],
  [/^LEFT_AT_SITE_PHOTO_MISSING\b/,
   'This attempt made no change (no stock or invoice change): no photo of where it was left is saved on it. Take the photo, then tap Complete'],
  [/^LEFT_AT_SITE_SIGNER_MISMATCH\b/,
   'This attempt made no change (no stock or invoice change): a delivery left at the site is signed "No one present — left at site". Reload the stop and try again'],
  [/^NO_PROOF_ADMIN_ONLY\b/,
   'This attempt made no change (no stock or invoice change): only an admin can record a delivery without proof. The delivery may already be completed by an earlier attempt; check it before trying again'],
  [/^NO_PROOF_REASON_REQUIRED\b/,
   'This attempt made no change (no stock or invoice change): write why there is no proof, 10 to 500 characters'],
  [/^NO_PROOF_SIGNER_MISMATCH\b/,
   'This attempt made no change (no stock or invoice change): a delivery recorded without proof is signed "No proof — recorded by office". Reload the page and try again'],
  [/^Job must be in_progress before completion\. Current status: completed\./,
   'This job is already completed. Refresh the page to see it'],
  [/^GENERIC_FIELD_CUTOVER_(?:IN_PROGRESS|ISOLATION|STALE_CALL)(?::|$)/,
   'No invoice was changed. An invoice update is finishing; wait a moment, then try Save again'],
  [/^FIELD_APPLICATION_VIA_SAVE_INVOICE_NOT_ALLOWED(?::|$)/,
   'Create this field invoice from its job, blend ticket, or the Field Application screen'],
  [/^CUSTOMER_SCOPE_DENIED\b/i,
   'You can only work with customers assigned to you'],
  // Reps work with any customer (2026-10-13, migration 20261013220000) with these exceptions.
  [/^REP_CANNOT_REASSIGN\b/i,
   'Only an admin can change which sales rep a customer is assigned to'],
  // Admin-only since 2026-10-14 (migration 20261027080200).
  [/^COMMISSION_SPLIT_ADMIN_ONLY\b/i,
   "Only an admin can set or change a customer's default commission split"],
  // Admin-only since 2026-11-01 (migration 20261111100000).
  [/^TIER_ADMIN_ONLY\b/i,
   "Only an admin can set or change a customer's price tier"],
  [/^CREDIT_LIMIT_ADMIN_ONLY\b/i,
   "Only an admin can set or change a customer's credit limit"],
  [/^QUOTE_TIER_PLANNED_VIA_SAVE_QUOTE\b/i,
   "A booking's tier and planned flag change only by saving the quote"],
  [/^SALESMAN_SCOPE_DENIED\b/i,
   "Sales reps work under their own name: choose yourself as the salesman, or ask an admin to handle another salesman's work"],
  [/^INVOICE_SCOPE_DENIED\b/i,
   'You can only change or post invoices under your own name'],
  [/^CUSTOMER_HAS_OPEN_INVOICES\b/i,
   'This customer has posted or overdue invoices. Resolve them before deactivating the customer'],
  // Purchase-order cost corrections (20261021140000, Mason 2026-10-20).
  [/^PO_COST_REASON_REQUIRED\b/i,
   'Say why the cost of a received line is changing'],
  [/^PO_COST_REASON_TOO_LONG\b/i,
   'Keep the reason to 500 characters'],
  [/^PO_CANCELLED\b/i,
   'This purchase order is cancelled, so its cost cannot change'],
  [/^PO_COST_BELOW_BILLED\b/i,
   'This would put the purchase order more than 5% below its vendor bills. Void or adjust the bill first'],
  [/^PREPAY_BALANCE_SERVER_ONLY\b/i,
   'A prepay balance changes only through prepayments and payments'],
  [/^RETURN_NOT_FOUND\b/i,
   'This return could not be found'],
  [/^RETURN_CREDIT_UNIT_MISMATCH\b/i,
   'The returned item unit does not match its original sale. Review the return before retrying'],
  [/^RETURN_CREDIT_INVENTORY_UNIT_MISMATCH\b/i,
   "This return's stock unit does not match the warehouse inventory unit. Review the product and return units before retrying"],
  [/^RETURN_CREDIT_UNLINKED_COST_LINE\b/i,
   'An existing credit cannot be matched safely to this return. Review the credit memo before retrying'],
  [/^RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED\b/i,
   'Void or unapply the related return credit before moving this sale invoice out of a recognized status or deleting it'],
  [/^RETURN_CREDIT_SOURCE_POST_REQUIRES_REISSUE\b/i,
   'This invoice cannot be posted because an earlier return credit was issued before enough product was invoiced. Void or unapply that credit, post this invoice, then reissue the credit'],
  [/^RETURN_CREDIT_HEADER_IMMUTABLE\b/i,
   'Use Void on the return credit memo before changing or deleting it'],
  [/^RETURN_CREDIT_PARENT_IMMUTABLE\b/i,
   'Void or unapply the return credit before deleting its return record'],
  [/^RETURN_CREDIT_LINE_TOTAL_MISMATCH\b/i,
   'The return credit lines did not match the credit total, so no changes were saved'],
  [/^RETURN_CREDIT_CUTOVER_IN_PROGRESS\b/i,
   'Return credits are briefly paused while an accounting update finishes. Retry in a moment'],
  [/^ORDER_INVOICE_TERMINAL\b/i,
   'This order invoice is already final and cannot be changed'],
  [/^BILL_SPLIT_FROZEN\b/,
   "Nothing was changed. A delivery on this sale is complete and invoiced, so its bill split is locked. Void that delivery's invoices to change the split. Unpost a posted group first, so the sale keeps its commission"],
  [/^BILL_SPLIT_HAS_DRAFT\b/,
   "Nothing was changed. A draft invoice bills this sale to one customer. Remove that draft to change the bill split"],
  [/^BILL_SPLIT_LINES_LOCKED\b/,
   "Nothing was saved. A Bill Split invoice's product lines follow the split. Void the group to change them; charges can still be added"],
  [/^ORDER_HAS_BILL_SPLIT\b/,
   "Nothing was billed. This sale has a bill split, so it is billed per payer. Refresh the page, then choose Create Invoice on the delivery"],
  [/^ORDER_ITEM_SHARES_OVER_100\b/,
   "Nothing was changed. A line's shares can't total more than 100%"],
  [/^BILL_SPLIT_GROUP_DELETE_PARTIAL\b/,
   "Nothing was deleted. A Bill Split group's drafts go together: select every payer's draft to delete them"],
  [/^BILL_SPLIT_SLIVER_LOCKED\b/,
   "Nothing was saved. This payer's draft has a product line with no quantity, so it can't be edited. Post it as drafted, or void the group"],
  [/^BILL_SPLIT_CUSTOMER_INACTIVE\b/,
   "Nothing was changed. This customer is inactive, so they can't be added to a bill split. Reactivate them first"],
  [/^GROUP_UNPOST_REQUIRED\b/,
   "Nothing was unposted. This invoice is part of a split group, so the whole group unposts together. Refresh the page and try again"],
  [/^BILL_SPLIT_QUANTITY_TOO_SMALL\b/,
   "Nothing was billed. A payer's share of a product is under 0.0001 of a unit. Change the bill split so each payer gets at least 0.0001"],
  [/^BILL_SPLIT_QUANTITY_TOO_FINE\b/,
   "Nothing was billed. A delivered amount has more than 4 decimal places, which an invoice line can't hold. Correct it with Fix Delivery, then choose Create Invoice"],
  [/^RETURN_QUANTITY_TOO_FINE\b/,
   "Nothing was returned. A return holds 2 decimal places. Enter a quantity like 0.70"],
  [/^PRICING_INCOMPLETE: price the order before its Bill Split\b/,
   "Nothing was billed. This sale still needs prices. Price it, then choose Create Invoice on the delivery"],
  [/^SPLIT_INVOICE_PROVENANCE_IMMUTABLE\b/,
   "Nothing was changed. This split invoice is locked to its group. Void the group and create a replacement"],
  [/^ORDER_SHARES_OVER_100\b/,
   "Nothing was changed. The bill split can't total more than 100%"],
  [/^ORDER_SHARES_ORDER_IMMUTABLE\b/,
   "Nothing was changed. A bill split row can't move to another order"],
  [/^ORDER_ITEM_SHARES_BUSY\b/,
   "Nothing was changed. A delivery on this sale is being completed. Try again in a moment"],
  [/^ORDER_ITEM_SHARES_LINE_MOVED\b/,
   "Nothing was changed. This line moved to another order. Refresh the page and try again"],
  [/^ORDER_ITEM_SHARES_LINE_MOVE\b/,
   "Nothing was changed. This line has its own bill split. Remove its shares before moving it to another order"],
  [/^ORDER_ITEM_SHARES_LINE_IMMUTABLE\b/,
   "Nothing was changed. A line share can't move to another line"],
  [/^BILL_SPLIT_NOTHING_TO_BILL\b/,
   "Nothing was billed. This delivery has no delivered quantity"],
  // create_invoice_from_order refuses an order split across fields (20261022021000): it is billed
  // per field owner. The page offers that path once it sees the order's field allocations.
  [/^ORDER_HAS_FIELD_SPLIT\b/,
   "Nothing was billed. This order's lines are split across fields, so it is billed by field. Refresh the page, then choose Create Invoice again"],
  [/^ORDER_INVOICE_EXCEEDS_DELIVERED\b/,
   'Nothing was changed. Product quantities across all invoices for this order cannot exceed completed deliveries. Refresh the invoice and bill only delivered goods. Record advance payments as prepay'],
  // create_invoice_from_order (20261230100000, KI-76): a line with no unit can't be billed or credited.
  [/^ORDER_LINE_UNIT_MISSING\b/,
   'Nothing was billed. A line on this order has no unit. Set each line\'s unit on the order before billing it'],
  // Posting (20261230100000, KI-76): a sale line still has no unit, so it could never be credited.
  [/^INVOICE_LINE_UNIT_MISSING\b/,
   'Nothing was posted. A line on this invoice has no unit. Set the unit on the product, save the draft invoice, then post it again'],
  [/^ORDER_INVOICE_LINE_INVALID\b/,
   'Nothing was changed. This order invoice has an incomplete or invalid line. Each sale line needs a product and nonnegative quantity; each non-product line needs a charge type. Remove and re-add an incomplete line'],
  // cancel_delivery / batch cancel (20261102140000): a completed delivery is undone only by an admin's void.
  [/^DELIVERY_COMPLETED_USE_VOID\b/,
   'Nothing was changed. This delivery is already completed, so it cannot be cancelled. An admin can void it instead'],
  // enforce_delivery_void_needs_invoice_void: a delivery with an active posted invoice cannot be voided or cancelled
  [/^DELIVERY_HAS_POSTED_INVOICE\b/,
   'Nothing was changed. This delivery, or its order, has an active invoice that is posted, paid, overdue or reversed (unposted). Void that invoice first, then void or cancel the delivery. For a completed delivery, an admin can use Fix Delivery to do both at once'],
  // fix_delivery (20261106150000): the server re-checks the preview and refuses if anything changed.
  [/^FIX_DELIVERY_REFUSED\b/,
   'Nothing was changed. Something on this delivery now blocks a fix. The reasons are shown on the Fix Delivery screen'],
  [/^FIX_DELIVERY_PREVIEW_STALE\b/,
   'Nothing was changed. This delivery, its invoices or the order\'s drafts changed while you were looking. Check the updated plan and try again'],
  [/^DELIVERY_ORDER_BUSY_RETRY\b/,
   'Nothing was changed. This order is being updated elsewhere. Wait a moment and retry'],
  // void_delivery (20261107120000, KI-102): voiding the order already put this delivery's stock back.
  [/^ORDER_VOIDED_DELIVERY_LOCKED\b/,
   'Nothing was changed. This delivery\'s order is voided, which already put its stock back, so the delivery cannot be voided too. Fix its invoice from the invoice page if needed'],
  // guard_invoice_terminal_order: an invoice made from an order must be for that order's customer
  // (since 20261021150000 a governed field split may bill another owner; KNOWN_ISSUES.md 2026-10-22).
  [/^INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID\b/,
   "Nothing was billed. An invoice made from an order can only be for that order's customer, and this one would bill someone else. Ask an admin to review the order's field split"],
  // void_order refuses rather than erase money already recorded on the order's draft invoice.
  [/^ORDER_VOID_DRAFT_HAS_APPLIED_MONEY\b/,
   'Nothing was changed. This order\'s draft invoice already has a payment, prepay, write-off or credit recorded. Reverse that first, then void the order'],
  [/^ORDER_LIFECYCLE_BUSY_RETRY\b/i,
   'This order is being updated elsewhere. Wait a moment and retry'],
  [/^RETURN_CREDIT_LEDGER_IMMUTABLE\b/i,
   'Void or unapply the return credit before changing its source or cost lines'],
  [/^RETURN_CREDIT_ISOLATION_UNSUPPORTED\b/i,
   'This return credit could not be serialized safely. Retry the operation'],
  [/^RETURN_CREDIT_HEADER_RESULT_INVALID\b/i,
   'The return credit could not be completed safely. Retry the operation'],
  [/^RETURN_CREDIT_SOURCE_CONCURRENT\b/i,
   'A related invoice or return credit is being changed elsewhere. Wait a moment and try again'],
  [/^RETURN_CREDIT_VOID_RELEASE_FAILED\b/i,
   'The return credit could not be voided safely, so no changes were saved. Refresh and try again; contact support if it repeats'],
  [/^RETURN_CREDIT_UNAPPLY_RELEASE_FAILED\b/i,
   'The return credit could not be unapplied safely, so no changes were saved. Refresh and try again; contact support if it repeats'],
  [/^RETURN_CREDIT_COGS_LEDGER_MISSING\b/i,
   'An existing return credit is missing its protected cost source. Void or unapply it and contact support before retrying'],
  [/^RETURN_CREDIT_REVERSAL_EXCEEDS_RECOGNIZED\b/i,
   'This return would reverse more product cost than the related sales invoices recorded. No changes were saved; review the source invoices and earlier return credits'],
  // Split-billed orders (20261021155000): each payer returns only what its own invoices billed.
  [/^RETURN_QUANTITY_EXCEEDS_BILLED_SHARE\b/i,
   'This order was split between payers. This customer can return only the quantity billed to them, less their other open returns. No changes were saved'],
  [/^RETURN_SPLIT_SHARE_NOT_BILLED\b/i,
   'This customer was not billed for this product on the split order, so they cannot return it. No changes were saved'],
  [/^RETURN_CREDIT_EXCEEDS_BILLED_SHARE\b/i,
   "This return would credit more than this customer was billed for the product on the split order. Check the customer's split invoice and earlier returns. No changes were saved"],
  [/^RETURN_SPLIT_INVOICE_NOT_VISIBLE\b/i,
   "This order was split between payers, and you cannot view this customer's split invoice, so you cannot start their return. Ask an admin to create it. No changes were saved"],
  [/^RETURN_SPLIT_SHARE_REPRICED\b/i,
   "An earlier return of this product was cancelled or rejected after this one was made, so this return's credit is out of date. Cancel this return and create it again to price it correctly. No changes were saved"],
  [/^RETURN_SPLIT_CREDIT_UNBACKED\b/i,
   "This return credit could not be matched to the customer's own split invoice line, so no credit was issued. Check that the split invoice is still posted"],
  [/^RETURN_ORDER_CUSTOMER_MISMATCH\b/i,
   'This customer was not billed on that order. Pick the order\'s customer, or a payer billed on the order\'s posted split invoice'],
  [/invoice_items_return_credit_source_item_fk/i,
   'This source invoice line is retained as return-credit accounting history and cannot be deleted or re-saved. Keep the source invoice unchanged, or permanently delete the already-voided credit memo before editing it'],
  [/duplicate key value violates unique constraint "[^"]+"/i,
   'A record with this information already exists'],
  [/violates foreign key constraint "[^"]+"/i,
   'This record references data that does not exist or has been removed'],
  [/violates check constraint "[^"]+"/i,
   'The provided value is not valid'],
  [/null value in column "[^"]+" of relation "[^"]+"/i,
   'A required field is missing'],
  [/value too long for type character varying\(\d+\)/i,
   'The provided value is too long'],
  [/invalid input syntax for type [^:]+:/i,
   'Invalid input format'],
  [/relation "[^"]+" does not exist/i,
   'An internal error occurred. Please try again.'],
  [/function [^\s]+\([^)]*\) does not exist/i,
   'An internal error occurred. Please try again.'],
  // PostgreSQL writes these identifiers UNQUOTED — `permission denied for table
  // orders`, not `... for table "orders"`. The original pattern here required
  // quotes, so every real permission error passed straight through this function
  // and the table/function/schema name was shown to the operator. That was a live
  // disclosure for every caller of sanitizeError, not only the ones added in the
  // 2026-09-02 sweep; those merely lost the canned-literal accident that had been
  // hiding it. The repo's own fixtures already used the real unquoted form
  // (criticalAction.test.ts, applicatorSheetPrintData.test.ts,
  // previousApplications.test.ts) — only this module's own test used the quoted
  // form, so the pattern was written against the test's fiction rather than
  // against what the database emits.
  //
  // Match the REGION (`permission denied for <anything>`) rather than enumerating
  // object types: Postgres has many (table, view, materialized view, foreign
  // table, sequence, function, procedure, schema, database, large object, ...) and
  // an enumeration silently reopens the hole for whichever one is missing. A bare
  // `permission denied` with no `for <object>` is left alone, so a hand-written
  // RAISE EXCEPTION like 'Permission denied to edit this order' still reaches the
  // operator intact.
  [/permission denied for \S/i,
   'You do not have permission to perform this action'],
  // PostgREST schema-cache misses name the function, table, column or
  // relationship it could not resolve — e.g. `Could not find the function
  // public.save_job(p_a, p_b) in the schema cache`. Same region approach.
  [/could not find .+ in the schema cache/i,
   'An internal error occurred. Please try again.'],
];

// The exact reasons 20261010120000 (and 20261108160000, typed charge lines) write after `DELIVERY_INVOICE_EXCEEDS_DELIVERED: `.
const DOC_NUMBER = String.raw`[A-Za-z0-9][A-Za-z0-9-]{0,40}`;
const QUANTITY = String.raw`\d{1,12}(?:\.\d{1,8})?`;
const DELIVERY_CAP_REASONS: Array<{ shape: RegExp; labelGroup?: number }> = [
  { shape: new RegExp(`^invoice ${DOC_NUMBER} bills ${QUANTITY} of (.{1,120}), but delivery ${DOC_NUMBER} allows ${QUANTITY}$`), labelGroup: 1 },
  { shape: new RegExp(`^invoice ${DOC_NUMBER} bills (.{1,120}) from an order line delivery ${DOC_NUMBER} did not carry$`), labelGroup: 1 },
  { shape: new RegExp(`^invoice ${DOC_NUMBER} has a line with no product and no charge type, or a negative quantity; a delivery invoice bills the products delivery ${DOC_NUMBER} delivered, plus typed charges \\(freight, application fee, service, other\\)$`) },
  { shape: new RegExp(`^invoice ${DOC_NUMBER} cannot be posted before delivery ${DOC_NUMBER} is completed$`) },
  { shape: new RegExp(`^invoice ${DOC_NUMBER} names a delivery that does not exist$`) },
];

/** The delivery-cap reason when it is one of the known shapes and its product label is plain text; else null. */
function deliveryCapReason(message: string): string | null {
  const reason = /^DELIVERY_INVOICE_EXCEEDS_DELIVERED:\s*(.+?)\s*$/.exec(message)?.[1];
  if (!reason) return null;
  for (const { shape, labelGroup } of DELIVERY_CAP_REASONS) {
    const match = shape.exec(reason);
    if (!match) continue;
    const label = labelGroup ? match[labelGroup] : '';
    const hasControl = [...label].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
    const unsafe = /[<>]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|relation "|column "|constraint "|table "/i;
    return hasControl || unsafe.test(label) ? null : reason;
  }
  return null;
}

export function sanitizeError(error: unknown): string {
  if (!error) return 'An unexpected error occurred';

  // Handle Error instances, plain objects with .message (PostgrestError from Supabase), and strings
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && 'message' in error && typeof (error as Record<string, unknown>).message === 'string'
        ? (error as Record<string, unknown>).message as string
        : 'An unexpected error occurred';

  if (/^PRODUCT_INACTIVE(?::|$)/.test(message)) {
    return message.slice('PRODUCT_INACTIVE'.length).replace(/^:\s*/, '').trim()
      || 'This product is turned off. Ask an admin to reactivate it.';
  }
  if (/^PRODUCT_DEACTIVATION_BLOCKED(?::|$)/.test(message)) {
    return message.slice('PRODUCT_DEACTIVATION_BLOCKED'.length).replace(/^:\s*/, '').trim()
      || 'This product cannot be turned off while required work is open. Review its blockers.';
  }
  // Rate lock (20261107060000), product parents (20261108120000), tote fill (20261117130000) and weights (20261207100000), chemistry (20261209100000), crop + timing choices (20261229120000): the server text after the token is the operator's answer.
  const rateRefusal = message.match(/^(?:PRODUCT_RATES_LOCKED|PRODUCT_RATES_STALE|PRODUCT_RATE_INVALID|PRODUCT_RATE_DUPLICATE_PRODUCT|PRODUCT_RATE_LOCK_UNCHANGED|PRODUCT_RATE_CORRECTION_NO_CHANGE|PRODUCT_RATE_UNIT_INVALID|PRODUCT_RATES_NOT_LOCKED|PRODUCT_RATE_PREVIEW_CHANGED|PRODUCT_RATES_READ_ONLY_IN_PRICE_WORKBOOK|REASON_TOO_LONG|PRODUCT_PARENT_[A-Z_]+|TOTE_FILL_[A-Z_]+|PRODUCT_WEIGHT_[A-Z_]+|CHEMISTRY_[A-Z_]+|INGREDIENT_[A-Z_]+|COST_REFERENCE_[A-Z_]+|USE_TIMING_[A-Z_]+|REASON_REQUIRED|EVIDENCE_REQUIRED|EVIDENCE_TOO_LONG):\s*(.+)$/s)?.[1];
  if (rateRefusal) {
    return `Nothing was saved. ${rateRefusal.charAt(0).toUpperCase()}${rateRefusal.slice(1)}`;
  }
  // Setup save and import (20261107080000, 20261107130000): a table check refused one product; name it, then explain the check.
  const refusedRow = message.match(/^PRODUCT_SETUP_ROW_REFUSED:\s*(.+?):\s+(.+)$/s);
  if (refusedRow) return `Nothing was saved. ${refusedRow[1]}: ${sanitizeError(refusedRow[2])}`;
  const setupRefusal = message.match(/^(?:PRODUCT_SETUP_STALE|PRODUCT_SETUP_INVALID|PRODUCT_SETUP_DUPLICATE_PRODUCT|PRODUCT_SETUP_ROW_SHAPE_INVALID|PRODUCT_SETUP_DUPLICATE|PRODUCT_SETUP_ROWS_REQUIRED):\s*(.+)$/s)?.[1];
  if (setupRefusal && !CONSTRAINT_PATTERNS.some(([pattern]) => pattern.test(message))) {
    return `Nothing was saved. ${setupRefusal.charAt(0).toUpperCase()}${setupRefusal.slice(1)}`;
  }
  if (/^PRODUCT_ACTIVE_REVIEW_STALE(?::|$)/.test(message)) {
    return 'Product details changed since the review. Review the selection again.';
  }

  const returnStatus = message.match(/^RETURN_NOT_APPROVED:([a-z_]+)$/i)?.[1];
  if (returnStatus) {
    const statusLabel = returnStatus.replace(/_/g, ' ');
    if (returnStatus === 'requested') {
      return `This return must be approved before it can be received (current status: ${statusLabel})`;
    }
    if (returnStatus === 'received') return 'This return is already received';
    return `This return is ${statusLabel} and cannot be received`;
  }
  if (/^RETURN_NOT_APPROVED\b/i.test(message)) {
    return 'This return must be approved before it can be received';
  }

  // Filed-season refusals reach the GENERIC editor too: a job- or blend-built field invoice stays
  // on InvoiceDetail (the per-acre redirect needs BOTH job_id and blend_ticket_id null), and that
  // page reports save errors through sanitizeError. FieldApplicationInvoice maps these tokens in
  // its own fieldAppError, which is why only the generic editor showed the raw token prefix.
  // Keep the server's season and allowed-date-range text after the colon and strip only the
  // token -- that text is the operator's answer, and it carries no schema identifiers.
  // (CodeRabbit on PR #786.)
  // The server reports the FIRST conflicting group member, which can be a sibling rather than the
  // invoice being edited, so its season is shown as the conflicting invoice's, never as "this
  // invoice". Any other detail shape falls through to the generic sentence below. (CodeRabbit on #832.)
  const seasonDateDetail = message.match(
    /^INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED:\s*this invoice is filed in season (\d+), so its transaction date must stay between (\S+) and (\S+)\s*$/s,
  );
  if (seasonDateDetail) {
    return 'No invoice was changed. This date conflicts with the filed season of this invoice or '
      + `another invoice in its split group. The conflicting invoice is filed in season ${seasonDateDetail[1]} `
      + `(${seasonDateDetail[2]} through ${seasonDateDetail[3]}). Keep the original transaction date; `
      + 'every group member must keep its filed season';
  }
  if (/^INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED(?::|$)/.test(message)) {
    return 'No invoice was changed. This date conflicts with the filed season of this invoice or '
      + 'another invoice in its split group. Keep the original transaction date; every group '
      + 'member must keep its filed season';
  }
  // The server text here names the invoice by id rather than by number, so it is not appended.
  if (/^INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED(?::|$)/.test(message)) {
    return 'No invoice was changed. The filed season of a field-application invoice cannot be changed';
  }
  // delivery_external_billings guard (20261007150000): the delivery, or a delivery on this order,
  // was already billed outside CRX (e.g. in Chem Man), so a CRX invoice would bill it twice.
  if (/^DELIVERY_BILLED_OUTSIDE_CRX(?::|$)/.test(message)) {
    return 'No invoice was created. This delivery (or a delivery on this order) was already billed '
      + 'outside CRX, so CRX will not bill it again';
  }
  if (/^BILLED_OUTSIDE_DELIVERY_ORDER_LOCKED(?::|$)/.test(message)) {
    return 'Nothing was changed. This delivery was billed outside CRX, so it cannot be moved to another order';
  }
  // Delivery-invoice cap (20261010120000): a delivery's invoice billed more than, or something other
  // than, what that delivery delivered. The server reason is shown only when it is exactly one of the
  // shapes the database writes, with plain document numbers, quantities and a product label that
  // carries no identifier; anything else gets the generic sentence.
  const deliveryCapDetail = deliveryCapReason(message);
  if (deliveryCapDetail?.includes(' has a line with no product and no charge type')) {
    return 'Nothing was changed. Every line on this invoice needs a product, or a charge type (freight, application fee, service or other), and no quantity can be negative'
      + ` (${deliveryCapDetail.split(' has a line')[0]})`;
  }
  if (deliveryCapDetail?.includes(' cannot be posted before delivery ')) {
    return `Nothing was posted. This invoice is for one delivery, so it can be posted only after that delivery is completed (${deliveryCapDetail})`;
  }
  if (deliveryCapDetail || /^DELIVERY_INVOICE_EXCEEDS_DELIVERED(?::|$)/.test(message)) {
    return 'Nothing was changed. This invoice is for one delivery, so it can bill only the products and '
      + 'quantities that delivery delivered'
      + (deliveryCapDetail ? ` (${deliveryCapDetail})` : '');
  }
  // 20261010120000: an order is billed either per delivery or by whole-order invoices, never both.
  if (/^ORDER_INVOICE_OVERLAPS_DELIVERY_INVOICE(?::|$)/.test(message)) {
    return message.includes('already billed per delivery')
      ? 'Nothing was saved. This order is already billed delivery by delivery, so a whole-order invoice would bill those goods twice. Invoice each remaining delivery instead'
      : 'Nothing was saved. This order already has a whole-order invoice, so a delivery invoice would bill those goods twice';
  }
  // Reviewed-version binding (20261022022000): the saved invoice changed after the screen loaded it.
  // The server sentence names the invoice by number and says what to do, so it is kept.
  const changedSinceLoaded = message.match(/^INVOICE_CHANGED_SINCE_LOADED:\s*(.+)$/s);
  if (changedSinceLoaded) return `Nothing was posted. ${changedSinceLoaded[1].trim()}`;
  if (/^INVOICE_CHANGED_SINCE_LOADED$/.test(message)) {
    return 'Nothing was posted. This invoice was changed after this screen loaded it. Reload it, check it, then post again.';
  }
  // job_chemicals trigger (20261022087000): a billable job line whose product states no price was sent at $0.
  // The server sentence names the product and says what to do, so it is kept.
  const chemPriceRequired = message.match(/^CHEM_PRICE_REQUIRED:\s*(.+)$/s);
  if (chemPriceRequired) return `Nothing was saved. ${chemPriceRequired[1].trim()}`;
  // Sale-line triggers (20261105190000, WP-PM-6b): the same rule on quote, order and tier-priced invoice lines.
  const salePriceMissing = message.match(/^(?:QUOTE|ORDER|INVOICE)_PRICE_MISSING:\s*(.+)$/s);
  if (salePriceMissing) return `Nothing was saved. ${salePriceMissing[1].trim()}`;
  if (/^INVOICE_POSTED_LOCKED(?::|$)/.test(message)) {
    return 'This invoice was posted, so its lines, billing shares and field locations cannot change. Unpost it first, then edit.';
  }
  if (/^INVOICE_GROUP_BUSY(?::|$)/.test(message)) {
    return 'This split invoice group is being posted or saved right now. Nothing was changed. Try again in a moment.';
  }
  if (/^INVOICE_VERSION_REQUIRED(?::|$)/.test(message)) {
    return 'Nothing was posted. This screen is out of date. Reload the page, then post again.';
  }
  if (/^ORDER_DELETED_(STATUS|LINES|DELIVERIES)_LOCKED(?::|$)/.test(message)) {
    return 'Nothing was changed. This order has been deleted, so it cannot be changed or restored';
  }

  for (const [pattern, replacement] of CONSTRAINT_PATTERNS) {
    if (pattern.test(message)) {
      return replacement;
    }
  }

  // Catch-all for messages that reference schema identifiers
  if (/relation "|column "|constraint "|table "/i.test(message)) {
    return 'An internal error occurred. Please try again.';
  }

  // Rate limit error from our custom ERRCODE
  if (message.includes('Rate limit exceeded')) {
    return 'Too many requests. Please wait a moment and try again.';
  }

  // Pass through safe messages (user-facing RPC RAISE EXCEPTION text)
  return message;
}
