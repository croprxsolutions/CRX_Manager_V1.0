-- Written 2026-11-03. STATUS: NOT APPLIED (local candidate). Ledger record:
-- docs/reference/migrations.d/20261105120000_sale_lines_refuse_missing_price.md. Stamp sits above
-- 20261105090000 (PR #1381, the live high-water read 2026-11-03, with 20261104200000 also live).
-- Re-read the live ledger first.
--
-- idempotency-body-check: exempt -- this file adds a trigger function, not a callable RPC; no API
--   role may execute it. The hook only recognises check_idempotency().
--
-- WHAT: WP-PM-6b missing-price refusals. New products stay active with no price until an admin
--   sets one (Mason's call), so a sale line must never quietly bill such a product at $0. Job lines
--   already refuse it (20261022087000, CHEM_PRICE_REQUIRED) and blend tickets refuse it
--   (BLEND_TICKET_PRICE_MISSING). Quote, order and tier-priced invoice lines did not: save_quote,
--   the order writers and the field-app invoice all fall back to COALESCE(tier price, 0). One
--   trigger function now refuses, by product name, whichever path writes the row:
--     QUOTE_PRICE_MISSING   quote_items: no price_override and price_per_unit 0 or NULL.
--     ORDER_PRICE_MISSING   order_items: price_per_unit 0 or NULL, not a price-later line
--                           (pricing_pending) and not a copy of a quote line that the quote itself
--                           set at $0 for this same product (quote_item_id; the quote line was
--                           checked when it was saved). A quote-copied line moved to another product
--                           or repriced to $0 is checked.
--     INVOICE_PRICE_MISSING invoice_items: price_source = 'tier' (priced from the product's tier
--                           price; this is the field-app path) and unit_price_cents 0 or NULL.
--   Each refuses only when the product states no price for the line's tier: its own tier price,
--   else tier 1. A stated $0 counts as a price, as getStatedTierPriceCents in src/lib/quoteCalc.ts
--   and the job rule. The tier is quotes.tier; for orders and invoices the line's
--   price_tier_at_sale, else the customer's assigned_tier, else 1.
--
-- HOW: BEFORE INSERT OR UPDATE OF the pricing columns, FOR EACH ROW. Named trigger_b_* so it runs
--   after trigger_a_guard_inactive_* and before zz_crx_below_cost_*, whose "below cost" refusal
--   would otherwise be the message for a missing price. SECURITY DEFINER so the caller's row-level
--   security cannot hide the product or customer and make a priced product look unpriced; no API
--   role may execute it. Only callers already allowed to write these rows reach the refusal, and its
--   text names only the product.
--
-- NOT CHANGED: every RPC and its body; RLS policies; grants on existing objects; existing rows. An
--   UPDATE that touches none of the listed columns (a delivery's quantity_delivered, a status, a
--   posting) does not fire the trigger, and an UPDATE that rewrites them with the same values (the
--   order editor re-sends every line on each save) passes without a check.
--
-- LIVE EVIDENCE (read-only execute_sql, 2026-11-03, counts only): rows the rule would catch today:
--   quote_items 0 (any quote); invoice_items with price_source 'tier' 0 (any invoice); order_items 2,
--   both on fulfilled orders; 0 quote-version snapshot lines. Those two stay as they are, and saving those orders with them unchanged
--   still works; changing their price to $0 again, their product, or their price-later flag is
--   refused until a price is entered. Active products with no tier price at all: 2.
--
-- LIMITS (accepted): checked when a line is written, like the job rule. A line saved at $0 for a
--   product whose price is later cleared stays as it is until rewritten. A blend-ticket order line
--   carries no quote_item_id, so a product with no list price that its quote deliberately gave at $0
--   is refused on the order; give the product a $0 price (a stated $0 is a price). save_quote and
--   save_invoice delete and re-insert lines, so a legacy $0 line for an unpriced product is checked
--   again when its quote or invoice is next saved (live count 0 for both). An over-draw line on a
--   booked quote is checked at the customer's tier, not the quote's. rollover_quote_to_season
--   drops price overrides, so rolling a giveaway line for an unpriced product is refused. A quote's
--   tier change is checked against its existing $0 lines (trigger on quotes.tier), because
--   save_quote writes the tier after the lines.
--
-- CALLERS (app callers of functions whose writes this now checks, 2026-11-03):
-- caller-analysis: save_quote :: QuoteBuilder.tsx; a line for a product with no price for the quote's tier and no typed price is refused with QUOTE_PRICE_MISSING; the screen shows the refusal on save
-- caller-analysis: create_direct_order :: NewOrder.tsx; a line at $0 for an unpriced product is refused with ORDER_PRICE_MISSING; the screen shows the refusal on save
-- caller-analysis: update_order_items :: OrderDetail.tsx; same rule when a line's price or product is rewritten
-- caller-analysis: create_rush_order :: NewOrder.tsx; price-later lines (pricing_pending) are not checked
-- caller-analysis: price_order :: OrderDetail.tsx; a price of 0 for an unpriced product is refused when pricing a pending line
-- caller-analysis: convert_quote_to_order :: QuoteBuilder.tsx; lines that still carry their quote line's product and $0 are not checked again
-- caller-analysis: create_order_from_blend_ticket :: BlendTicketDetail.tsx; already refuses a missing price first (BLEND_TICKET_PRICE_MISSING)
-- caller-analysis: bulk_import_order :: BulkOrderImport.tsx; an imported line at $0 for an unpriced product is refused with ORDER_PRICE_MISSING; the import shows the refusal
-- caller-analysis: draw_down_quote :: QuoteBuilder.tsx; draw-down lines copy their quote line; an over-draw extra line at $0 for an unpriced product is refused with ORDER_PRICE_MISSING
-- caller-analysis: save_invoice :: InvoiceDetail.tsx; a tier-priced line at $0 for an unpriced product is refused with INVOICE_PRICE_MISSING
-- caller-analysis: create_quick_delivery :: QuickDeliveryModal.tsx; a line for a product with no price for the customer's tier is refused with ORDER_PRICE_MISSING and nothing is saved
-- caller-analysis: create_quote_from_template :: QuoteBuilder.tsx; a template product with no price for the quote's tier is refused with QUOTE_PRICE_MISSING
-- caller-analysis: rollover_quote_to_season :: QuoteBuilder.tsx; a rolled line for a product with no price at today's tier is refused with QUOTE_PRICE_MISSING
-- caller-analysis: restore_quote_version :: QuoteBuilder.tsx; restored $0 lines for a product with no price are refused (live snapshot count 0)
-- caller-analysis: duplicate_quote :: Quotes.tsx, CustomerDetail.tsx; copied $0 lines for a product with no price are refused
-- caller-analysis: consolidate_draft_invoices :: OrderDetail.tsx; a moved tier-priced $0 line for an unpriced product is refused (live count 0)
-- caller-analysis: save_field_app_invoice :: FieldApplicationInvoice.tsx; a tier-priced line at $0 for an unpriced product is refused with INVOICE_PRICE_MISSING; the screen shows the refusal on save
--
-- ROLLBACK: DROP TRIGGER trigger_b_quote_item_price_required ON public.quote_items;
--   DROP TRIGGER trigger_b_order_item_price_required ON public.order_items;
--   DROP TRIGGER trigger_b_invoice_item_price_required ON public.invoice_items;
--   DROP TRIGGER trigger_b_quote_tier_price_required ON public.quotes;
--   DROP FUNCTION public._sale_line_price_required(). No data to restore.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE sale_line_price_required_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.sale_line_price_required_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.sale_line_price_required_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regproc('public._sale_line_price_required') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('trigger_b_quote_item_price_required',
                  'trigger_b_order_item_price_required', 'trigger_b_invoice_item_price_required',
                  'trigger_b_quote_tier_price_required')) THEN
    RAISE EXCEPTION 'SALE_LINE_PRICE_REQUIRED_EXISTS: this migration has already run';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name, data_type) IN (
           ('quote_items', 'quote_id', 'uuid'), ('quote_items', 'product_id', 'uuid'),
           ('quote_items', 'price_per_unit', 'numeric'), ('quote_items', 'price_override', 'numeric'),
           ('quotes', 'tier', 'integer'),
           ('order_items', 'order_id', 'uuid'), ('order_items', 'product_id', 'uuid'),
           ('order_items', 'quote_item_id', 'uuid'), ('order_items', 'price_per_unit', 'numeric'),
           ('order_items', 'pricing_pending', 'boolean'), ('order_items', 'price_tier_at_sale', 'smallint'),
           ('orders', 'customer_id', 'uuid'),
           ('invoice_items', 'invoice_id', 'uuid'), ('invoice_items', 'product_id', 'uuid'),
           ('invoice_items', 'unit_price_cents', 'bigint'), ('invoice_items', 'price_source', 'text'),
           ('invoice_items', 'price_tier_at_sale', 'smallint'),
           ('invoices', 'customer_id', 'uuid'),
           ('customers', 'assigned_tier', 'integer'),
           ('products', 'product_name', 'text'), ('products', 'tier1_price', 'numeric'),
           ('products', 'tier2_price', 'numeric'), ('products', 'tier3_price', 'numeric'))) <> 23 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: sale line, customer or product columns are not as read 2026-11-03';
  END IF;
END;
$preflight$;

CREATE FUNCTION public._sale_line_price_required()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tier integer;
  v_product_name text;
  v_stated numeric;
BEGIN
  -- save_quote writes a changed tier after it prices the lines, so the lines are checked again
  -- against the tier as it is written.
  IF TG_TABLE_NAME = 'quotes' THEN
    IF NEW.tier IS NOT DISTINCT FROM OLD.tier THEN
      RETURN NEW;
    END IF;
    SELECT p.product_name INTO v_product_name
      FROM quote_items qi JOIN products p ON p.id = qi.product_id
     WHERE qi.quote_id = NEW.id AND qi.price_override IS NULL AND round(COALESCE(qi.price_per_unit, 0), 2) = 0
       AND COALESCE(CASE COALESCE(NEW.tier, 1) WHEN 3 THEN p.tier3_price WHEN 2 THEN p.tier2_price ELSE p.tier1_price END,
                    p.tier1_price) IS NULL
     ORDER BY p.product_name LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION
        'QUOTE_PRICE_MISSING: % has no price for this quote''s tier, so its line would show $0. Type a price on the line, or set the product''s prices first (give it a $0 price if you give it away).',
        v_product_name USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Editors re-send every line; a rewrite with the same pricing values is not a new decision.
  IF TG_OP = 'UPDATE' AND (
       (TG_TABLE_NAME = 'quote_items'
        AND (to_jsonb(NEW) -> 'quote_id', to_jsonb(NEW) -> 'product_id', to_jsonb(NEW) -> 'price_per_unit', to_jsonb(NEW) -> 'price_override')
            IS NOT DISTINCT FROM
            (to_jsonb(OLD) -> 'quote_id', to_jsonb(OLD) -> 'product_id', to_jsonb(OLD) -> 'price_per_unit', to_jsonb(OLD) -> 'price_override'))
    OR (TG_TABLE_NAME = 'order_items'
        AND (to_jsonb(NEW) -> 'order_id', to_jsonb(NEW) -> 'product_id', to_jsonb(NEW) -> 'quote_item_id', to_jsonb(NEW) -> 'price_per_unit',
             to_jsonb(NEW) -> 'pricing_pending', to_jsonb(NEW) -> 'price_tier_at_sale')
            IS NOT DISTINCT FROM
            (to_jsonb(OLD) -> 'order_id', to_jsonb(OLD) -> 'product_id', to_jsonb(OLD) -> 'quote_item_id', to_jsonb(OLD) -> 'price_per_unit',
             to_jsonb(OLD) -> 'pricing_pending', to_jsonb(OLD) -> 'price_tier_at_sale'))
    OR (TG_TABLE_NAME = 'invoice_items'
        AND (to_jsonb(NEW) -> 'invoice_id', to_jsonb(NEW) -> 'product_id', to_jsonb(NEW) -> 'unit_price_cents', to_jsonb(NEW) -> 'price_source',
             to_jsonb(NEW) -> 'price_tier_at_sale')
            IS NOT DISTINCT FROM
            (to_jsonb(OLD) -> 'invoice_id', to_jsonb(OLD) -> 'product_id', to_jsonb(OLD) -> 'unit_price_cents', to_jsonb(OLD) -> 'price_source',
             to_jsonb(OLD) -> 'price_tier_at_sale'))) THEN
    RETURN NEW;
  END IF;
  -- Only a line that would show or bill $0 (to the cent) is checked.
  IF TG_TABLE_NAME = 'quote_items' THEN
    IF NEW.price_override IS NOT NULL OR round(COALESCE(NEW.price_per_unit, 0), 2) <> 0 THEN
      RETURN NEW;
    END IF;
    SELECT q.tier INTO v_tier FROM quotes q WHERE q.id = NEW.quote_id;
  ELSIF TG_TABLE_NAME = 'order_items' THEN
    IF COALESCE(NEW.pricing_pending, false) OR round(COALESCE(NEW.price_per_unit, 0), 2) <> 0 THEN
      RETURN NEW;
    END IF;
    -- A copy of a quote line the quote itself set at $0 for this product keeps that decision.
    IF NEW.quote_item_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM quote_items qi
          WHERE qi.id = NEW.quote_item_id AND qi.product_id = NEW.product_id
            AND COALESCE(qi.price_override, qi.price_per_unit, 0) = 0) THEN
      RETURN NEW;
    END IF;
    SELECT COALESCE(NEW.price_tier_at_sale::integer, c.assigned_tier) INTO v_tier
      FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = NEW.order_id;
  ELSE
    IF NEW.price_source IS DISTINCT FROM 'tier' OR COALESCE(NEW.unit_price_cents, 0) <> 0 THEN
      RETURN NEW;
    END IF;
    SELECT COALESCE(NEW.price_tier_at_sale::integer, c.assigned_tier) INTO v_tier
      FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.id = NEW.invoice_id;
  END IF;
  SELECT p.product_name,
         COALESCE(CASE COALESCE(v_tier, 1) WHEN 3 THEN p.tier3_price WHEN 2 THEN p.tier2_price ELSE p.tier1_price END,
                  p.tier1_price)
    INTO v_product_name, v_stated
    FROM products p WHERE p.id = NEW.product_id;
  IF NOT FOUND OR v_stated IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'quote_items' THEN
    RAISE EXCEPTION
      'QUOTE_PRICE_MISSING: % has no price for this quote''s tier, so its line would show $0. Type a price on the line, or set the product''s prices first (give it a $0 price if you give it away).',
      COALESCE(v_product_name, 'A product') USING ERRCODE = 'P0001';
  ELSIF TG_TABLE_NAME = 'order_items' THEN
    RAISE EXCEPTION
      'ORDER_PRICE_MISSING: % has no price for this customer''s tier, so its line would bill $0. Enter a price for the line, or set the product''s prices first (give it a $0 price if you give it away).',
      COALESCE(v_product_name, 'A product') USING ERRCODE = 'P0001';
  ELSE
    RAISE EXCEPTION
      'INVOICE_PRICE_MISSING: % has no price for this customer''s tier, so its line would bill $0. Enter a price for the line, or set the product''s prices first (give it a $0 price if you give it away).',
      COALESCE(v_product_name, 'A product') USING ERRCODE = 'P0001';
  END IF;
END;
$function$;

ALTER FUNCTION public._sale_line_price_required() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._sale_line_price_required() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trigger_b_quote_item_price_required
  BEFORE INSERT OR UPDATE OF quote_id, product_id, price_per_unit, price_override
  ON public.quote_items
  FOR EACH ROW EXECUTE FUNCTION public._sale_line_price_required();

CREATE TRIGGER trigger_b_order_item_price_required
  BEFORE INSERT OR UPDATE OF order_id, product_id, quote_item_id, price_per_unit, pricing_pending, price_tier_at_sale
  ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._sale_line_price_required();

CREATE TRIGGER trigger_b_quote_tier_price_required
  BEFORE UPDATE OF tier
  ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public._sale_line_price_required();

CREATE TRIGGER trigger_b_invoice_item_price_required
  BEFORE INSERT OR UPDATE OF invoice_id, product_id, unit_price_cents, price_source, price_tier_at_sale
  ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._sale_line_price_required();

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.sale_line_price_required_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.sale_line_price_required_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl
    INTO v_fn
    FROM pg_proc p WHERE p.oid = to_regprocedure('public._sale_line_price_required()');
  IF NOT FOUND OR NOT v_fn.prosecdef OR v_fn.owner <> 'postgres'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.acl IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: public._sale_line_price_required attributes are not as expected (acl %)', v_fn.acl;
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgname IN ('trigger_b_quote_item_price_required', 'trigger_b_order_item_price_required',
                          'trigger_b_invoice_item_price_required', 'trigger_b_quote_tier_price_required')
         AND t.tgenabled = 'O' AND t.tgfoid = to_regprocedure('public._sale_line_price_required()')
         AND NOT t.tgisinternal
         AND t.tgtype = CASE t.tgname WHEN 'trigger_b_quote_tier_price_required' THEN 19 ELSE 23 END  -- ROW, BEFORE, (INSERT,) UPDATE
         AND t.tgrelid = CASE t.tgname WHEN 'trigger_b_quote_item_price_required' THEN 'public.quote_items'::regclass
                                       WHEN 'trigger_b_order_item_price_required' THEN 'public.order_items'::regclass
                                       WHEN 'trigger_b_quote_tier_price_required' THEN 'public.quotes'::regclass
                                       ELSE 'public.invoice_items'::regclass END) <> 4 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a price-required trigger is missing or not enabled';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: quote, order and tier-priced invoice lines refuse an unpriced product at $0';
END;
$postflight$;
