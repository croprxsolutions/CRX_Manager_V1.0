-- Written 2026-11-11. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261231120000_sales_tax_checkbox.md.
-- Re-read the live ledger before applying.
--
-- WHAT (billing plan M4a; Mason 2026-11-04 and 2026-11-09, scenario B10):
--   1. app_settings 'sales_tax_rate': one rate, 6.25, editable by an admin on Settings. Only a plain percentage
--      (0 to 99.999, at most three decimals) is accepted, so a typo can never stop an invoice being drafted.
--   2. orders.sales_tax: the sale's checkbox, off by default. Changed only through set_order_sales_tax (an admin,
--      or the sale's own rep), which also applies it to the sale's chemical-sale drafts. Posted and unposted
--      invoices keep the tax they were posted with. Every payer on a split follows the one box (Mason 2026-11-09).
--   3. invoice_sales_tax_rates: a row means the invoice is taxed, at the rate it records. A chemical-sale invoice
--      drafted from a taxed sale records the Settings rate at once; a draft keeps it (a later Settings change
--      applies to new drafts, or when the box is ticked again after being unticked).
--   4. A taxed chemical-sale draft gets one computed line, charge_type 'sales_tax':
--      round((product and charge lines - standing discount) x rate / 100) to the cent, half up.
--      It is written with the standing discount, in the same statement, by the same commit-time recompute
--      (_recompute_standing_discount_20261231, re-emitted and pinned), so every writer and the split fingerprint
--      are covered exactly as for the discount. Each payer's invoice computes its own: a split is exact per payer.
--   5. Guards, as for the discount: the line only on a chemical sale; posting refuses a stale tax line.
--   6. Returns credit the tax paid: a billed product line's cents now also carry its share of the invoice's tax
--      line (running-total rounding over the taxed lines, so the shares add up exactly), and a taxed invoice's
--      lines are priced from what was billed (_standing_discount_net_cents_20261231 and _return_customer_line_share,
--      re-emitted and pinned). The credit memo's lines carry the tax inside their amounts.
--
-- NOT CHANGED: every writer function and existing guard, the posting functions, commission and sales reports (tax
-- is not revenue; they read the order), field application invoices, misc-charge invoices.
--
-- ROLLBACK (its own reviewed migration): drop this migration's triggers, functions and set_order_sales_tax,
--   delete the 'sales_tax' lines from draft invoices and re-total them, restore the two invoice_items CHECKs and the
--   three re-emitted functions to their 20261231110000 text, drop invoice_sales_tax_rates, orders.sales_tax, the
--   app_settings CHECK and the 'sales_tax_rate' row.
--
-- ORDERING: after 20261231110000_standing_grower_discount (it re-emits three of its functions).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE sales_tax_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.sales_tax_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.sales_tax_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'sales_tax')
     OR to_regclass('public.invoice_sales_tax_rates') IS NOT NULL
     OR to_regprocedure('public.set_order_sales_tax(uuid, boolean, text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.app_settings WHERE setting_key = 'sales_tax_rate') THEN
    RAISE EXCEPTION 'SALES_TAX_PREFLIGHT: already applied (orders.sales_tax, the rate table, the call or the setting exists)';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'invoice_items_charge_type_check'
        AND conrelid = 'public.invoice_items'::regclass)
     IS DISTINCT FROM 'CHECK (((charge_type IS NULL) OR (charge_type = ANY (ARRAY[''freight''::text, ''application_fee''::text, ''service''::text, ''other''::text, ''standing_discount''::text]))))'
  THEN
    RAISE EXCEPTION 'SALES_TAX_PREFLIGHT: invoice_items_charge_type_check drifted';
  END IF;
  -- The three functions re-emitted below, exactly as 20261231110000 left them.
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM (VALUES
      ('public._recompute_standing_discount_20261231(uuid)', '43e18f21d2160ebe90d697a10361f653', true,
       ARRAY['postgres=X/postgres', 'service_role=X/postgres']),
      ('public._standing_discount_net_cents_20261231(uuid)', 'c32bdc89050f6376d0e8268a2cf532f6', false,
       ARRAY['postgres=X/postgres']),
      ('public._return_customer_line_share(uuid,uuid,uuid,uuid)', '3b23be5175e7a44c9cd0e540f1438c66', false,
       ARRAY['postgres=X/postgres'])) AS f(name, md5, secdef, acl)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.name)
        AND md5(replace(p.prosrc, chr(13), '')) = f.md5
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef = f.secdef
        AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
        AND p.proacl = f.acl::aclitem[]);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SALES_TAX_PREFLIGHT: drifted from 20261231110000: %', v_bad;
  END IF;
END
$preflight$;

-- 1. The Settings rate ----------------------------------------------------------------------------------
INSERT INTO public.app_settings (setting_key, setting_value, description)
VALUES ('sales_tax_rate', '6.25', 'Sales tax rate, percent, for chemical sales with the sales tax box ticked (billing plan M4a).');

ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_sales_tax_rate_chk
  CHECK (setting_key <> 'sales_tax_rate' OR setting_value ~ '^[0-9]{1,2}(\.[0-9]{1,3})?$');

-- The Settings rate, refused if missing (an admin deleted the row) rather than taxing at nothing.
CREATE FUNCTION public._sales_tax_setting_rate_20261231()
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rate numeric;
BEGIN
  SELECT setting_value::numeric INTO v_rate FROM app_settings WHERE setting_key = 'sales_tax_rate';
  IF v_rate IS NULL THEN
    RAISE EXCEPTION 'SALES_TAX_RATE_MISSING: set the sales tax rate in Settings first' USING ERRCODE = '55000';
  END IF;
  RETURN v_rate;
END
$function$;

REVOKE ALL ON FUNCTION public._sales_tax_setting_rate_20261231() FROM PUBLIC, anon, authenticated;

-- 2. The sale's checkbox ----------------------------------------------------------------------------------
-- Readable like every other order column; no INSERT or UPDATE grant: the box changes only through
-- set_order_sales_tax, which applies it to the sale's drafts.
ALTER TABLE public.orders ADD COLUMN sales_tax boolean NOT NULL DEFAULT false;
GRANT SELECT (sales_tax) ON public.orders TO authenticated;
GRANT REFERENCES (sales_tax) ON public.orders TO authenticated;
GRANT SELECT (sales_tax) ON public.orders TO anon;

COMMENT ON COLUMN public.orders.sales_tax IS
  'Sales tax box (billing plan M4a): this sale''s chemical-sale invoices carry a sales tax line. Set through set_order_sales_tax.';

-- 3. Which invoices are taxed, and at what rate ------------------------------------------------------------
CREATE TABLE public.invoice_sales_tax_rates (
  invoice_id uuid PRIMARY KEY REFERENCES public.invoices(id) ON DELETE CASCADE,
  rate_pct numeric(5,3) NOT NULL
    CONSTRAINT invoice_sales_tax_rates_range CHECK (rate_pct >= 0 AND rate_pct < 100),
  set_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.invoice_sales_tax_rates IS
  'A chemical-sale invoice taxed at this rate (billing plan M4a): recorded from Settings when drafted from a taxed sale, or when its sale''s box is ticked.';

ALTER TABLE public.invoice_sales_tax_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_sales_tax_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.invoice_sales_tax_rates TO authenticated;
GRANT ALL ON public.invoice_sales_tax_rates TO service_role;

CREATE POLICY invoice_sales_tax_rates_select ON public.invoice_sales_tax_rates
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_sales_tax_rates.invoice_id));

-- Recorded at once (not at commit), from the sale's box: a chemical sale drafted from a taxed sale, or a draft moved
-- to another sale or type, which follows its new sale's box.
CREATE FUNCTION public._sales_tax_record_rate_20261231()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Every save names these columns; only a real move or type switch of a draft counts.
    IF NEW.status <> 'draft'
       OR (OLD.order_id IS NOT DISTINCT FROM NEW.order_id AND OLD.invoice_type IS NOT DISTINCT FROM NEW.invoice_type) THEN
      RETURN NULL;
    END IF;
    DELETE FROM invoice_sales_tax_rates WHERE invoice_id = NEW.id;
  END IF;
  IF NEW.invoice_type = 'chemical_sale'
     AND EXISTS (SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.sales_tax) THEN
    INSERT INTO invoice_sales_tax_rates (invoice_id, rate_pct)
    VALUES (NEW.id, public._sales_tax_setting_rate_20261231())
    ON CONFLICT (invoice_id) DO NOTHING;
  END IF;
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public._sales_tax_record_rate_20261231() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER invoices_sales_tax_rate_20261231
  AFTER INSERT OR UPDATE OF order_id, invoice_type ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._sales_tax_record_rate_20261231();

-- A draft moved to another sale is recomputed at commit (the discount's trigger covers customer, status and type).
CREATE CONSTRAINT TRIGGER invoices_sales_tax_20261231
  AFTER UPDATE OF order_id ON public.invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._standing_discount_after_invoice_change_20261231();

-- 4. The computed line ---------------------------------------------------------------------------------------
-- (Its shape is the charge-line CHECK as 20261231110000 left it: a description, quantity 1, no cost, positive.)
ALTER TABLE public.invoice_items DROP CONSTRAINT invoice_items_charge_type_check;
ALTER TABLE public.invoice_items ADD CONSTRAINT invoice_items_charge_type_check
  CHECK (charge_type IS NULL OR charge_type = ANY (ARRAY['freight', 'application_fee', 'service', 'other', 'standing_discount', 'sales_tax']));

-- What an invoice's tax line should be, given its discount cents: cents (0 = no line), label and rate. The tax base is
-- every line but the two computed ones (products and charges), less the discount. Read-only.
CREATE FUNCTION public._sales_tax_expected_20261231(p_invoice_id uuid, p_discount_cents bigint,
                                                    OUT o_cents bigint, OUT o_label text, OUT o_pct numeric)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base bigint;
BEGIN
  o_pct := (SELECT rate_pct FROM invoice_sales_tax_rates WHERE invoice_id = p_invoice_id);
  SELECT COALESCE(sum(extended_cents), 0) - COALESCE(p_discount_cents, 0) INTO v_base
    FROM invoice_items
   WHERE invoice_id = p_invoice_id AND charge_type IS DISTINCT FROM 'standing_discount' AND charge_type IS DISTINCT FROM 'sales_tax';
  o_cents := CASE WHEN COALESCE(o_pct, 0) > 0 AND v_base > 0 THEN round(v_base * o_pct / 100) ELSE 0 END;
  o_label := format('Sales tax %s%%', trim_scale(COALESCE(o_pct, 0)));
END
$function$;

REVOKE ALL ON FUNCTION public._sales_tax_expected_20261231(uuid, bigint) FROM PUBLIC, anon, authenticated;

-- The discount's recompute (20261231110000) re-emitted to write the tax line with it, changes marked (tax):
-- the discount first, then the tax on what is left, both lines and the total in ONE statement.
CREATE OR REPLACE FUNCTION public._recompute_standing_discount_20261231(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv record;
  v_cents bigint := 0;
  v_label text;
  v_pct numeric;
  v_tax bigint := 0;        -- (tax)
  v_tax_label text;         -- (tax)
  v_tax_pct numeric;        -- (tax)
  v_same boolean;
  v_new_total bigint;
  v_old_computed bigint;
  v_after int;              -- (tax) the computed lines go right after the last other line
BEGIN
  SELECT i.id, i.customer_id, i.invoice_type, i.status, i.deleted_at, i.total_amount_cents, i.created_by INTO v_inv
    FROM invoices i
   WHERE i.id = p_invoice_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- A chemical sale records the rate it is drafted at once, whatever its status (one drafted and posted in the
  -- same transaction too), so a later customer change never moves it, not even on unposting.
  IF v_inv.invoice_type = 'chemical_sale'
     AND NOT EXISTS (SELECT 1 FROM invoice_standing_discount_rates WHERE invoice_id = v_inv.id) THEN
    INSERT INTO invoice_standing_discount_rates (invoice_id, rate_pct, set_by)
    SELECT v_inv.id, COALESCE(c.standing_discount_pct, 0), NULL FROM customers c WHERE c.id = v_inv.customer_id
    ON CONFLICT (invoice_id) DO NOTHING;
  END IF;

  IF v_inv.status NOT IN ('draft', 'unposted') OR v_inv.deleted_at IS NOT NULL THEN
    RETURN;
  END IF;

  IF v_inv.invoice_type <> 'chemical_sale' THEN
    -- Any other draft is left exactly as its writer made it, unless it carries a stray discount or tax line (switched
    -- away from a chemical sale): then only those lines' amounts come back out of its total, whatever the total means
    -- for that type (a field application's is not the sum of its lines).
    IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_inv.id
                     AND charge_type IN ('standing_discount', 'sales_tax')) THEN
      RETURN;
    END IF;
    SELECT COALESCE(sum(extended_cents), 0) INTO v_old_computed
      FROM invoice_items WHERE invoice_id = v_inv.id AND charge_type IN ('standing_discount', 'sales_tax');
    v_new_total := v_inv.total_amount_cents - v_old_computed;
    -- One statement (see below): the line-change event it queues finds no stray line and stops.
    WITH del AS (DELETE FROM invoice_items WHERE invoice_id = v_inv.id AND charge_type IN ('standing_discount', 'sales_tax'))
    UPDATE invoices SET total_amount_cents = v_new_total WHERE id = v_inv.id;
    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, old_values, new_values,
                                     total_impact_cents, description)
    VALUES ('invoice_updated', 'invoice', v_inv.id, COALESCE(auth.uid(), v_inv.created_by),
            CASE WHEN auth.uid() IS NULL THEN 'system' ELSE (SELECT role FROM profiles WHERE id = auth.uid()) END,
            jsonb_build_object('total_amount_cents', v_inv.total_amount_cents),
            jsonb_build_object('total_amount_cents', v_new_total, 'standing_discount_cents', 0, 'sales_tax_cents', 0),
            v_new_total - v_inv.total_amount_cents, 'Standing discount and sales tax removed (not a chemical sale)');
    RETURN;
  END IF;

  SELECT e.o_cents, e.o_label, e.o_pct INTO v_cents, v_label, v_pct FROM public._standing_discount_expected_20261231(v_inv.id) e;
  -- (tax) on what is left after the discount.
  SELECT e.o_cents, e.o_label, e.o_pct INTO v_tax, v_tax_label, v_tax_pct FROM public._sales_tax_expected_20261231(v_inv.id, v_cents) e;

  -- Nothing to change (cents, labels, places and total): keep the existing lines and their ids, so a plain re-save is
  -- quiet. Sorted by charge type: 'sales_tax' before 'standing_discount'. The discount sits right after the last other
  -- line and the tax right after that, so a moved line is put back.
  -- (Worked out first: plpgsql ends an IF condition at its first THEN, a CASE's included.)
  v_after := (SELECT COALESCE(max(sort_order), 0) FROM invoice_items
               WHERE invoice_id = v_inv.id AND charge_type IS DISTINCT FROM 'standing_discount'
                 AND charge_type IS DISTINCT FROM 'sales_tax');
  v_same := (SELECT COALESCE(array_agg(charge_type || '|' || extended_cents || '|' || description || '|' || sort_order
                                       ORDER BY charge_type, id), '{}'::text[])
               FROM invoice_items WHERE invoice_id = v_inv.id AND charge_type IN ('standing_discount', 'sales_tax'))
            = (CASE WHEN v_tax > 0
                    THEN ARRAY['sales_tax|' || v_tax || '|' || v_tax_label || '|' || (v_after + CASE WHEN v_cents > 0 THEN 2 ELSE 1 END)]
                    ELSE '{}'::text[] END
               || CASE WHEN v_cents > 0 THEN ARRAY['standing_discount|' || -v_cents || '|' || v_label || '|' || (v_after + 1)] ELSE '{}'::text[] END)
        AND (SELECT total_amount_cents FROM invoices WHERE id = v_inv.id)
            = (SELECT COALESCE(sum(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_inv.id);
  IF v_same THEN
    RETURN;
  END IF;

  -- The lines and the total change in ONE statement. Its own line-change events fire only after the whole
  -- statement (at commit, or at its end when constraints are IMMEDIATE), find the lines and total right, and stop:
  -- no session flag, so nothing a caller sets can make the recompute skip a draft.
  v_new_total := (SELECT COALESCE(sum(extended_cents), 0) FROM invoice_items
                   WHERE invoice_id = v_inv.id AND charge_type IS DISTINCT FROM 'standing_discount'
                     AND charge_type IS DISTINCT FROM 'sales_tax') - v_cents + v_tax;
  WITH del AS (
    DELETE FROM invoice_items WHERE invoice_id = v_inv.id AND charge_type IN ('standing_discount', 'sales_tax')
  ), ins AS (
    INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents,
                               sort_order, charge_type)
    SELECT v_inv.id, c.label, 1, c.cents, c.cents, 0, v_after + c.k, c.charge_type
      FROM (VALUES (v_label, -v_cents, 1, 'standing_discount'),
                   (v_tax_label, v_tax, CASE WHEN v_cents > 0 THEN 2 ELSE 1 END, 'sales_tax')) AS c(label, cents, k, charge_type)
     WHERE c.cents <> 0
  )
  UPDATE invoices SET total_amount_cents = v_new_total WHERE id = v_inv.id;
  -- The writers logged the draft's total before these lines went in; this entry records the change, so the trail adds up.
  IF v_new_total IS DISTINCT FROM v_inv.total_amount_cents THEN
    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, old_values, new_values,
                                     total_impact_cents, description)
    VALUES ('invoice_updated', 'invoice', v_inv.id, COALESCE(auth.uid(), v_inv.created_by),
            -- With no signed-in user (a background or service write) the entry says so; actor_user_id is required,
            -- so it names the invoice's creator, and actor_role 'system' marks that they did not make this change.
            CASE WHEN auth.uid() IS NULL THEN 'system' ELSE (SELECT role FROM profiles WHERE id = auth.uid()) END,
            jsonb_build_object('total_amount_cents', v_inv.total_amount_cents),
            jsonb_build_object('total_amount_cents', v_new_total, 'standing_discount_cents', v_cents, 'rate_pct', v_pct,
                               'sales_tax_cents', v_tax, 'sales_tax_rate_pct', v_tax_pct),
            v_new_total - v_inv.total_amount_cents,
            COALESCE(NULLIF(concat_ws(', ', CASE WHEN v_cents > 0 THEN v_label END, CASE WHEN v_tax > 0 THEN v_tax_label END), ''),
                     'Standing discount and sales tax removed'));
  END IF;
END
$function$;

-- 5. Guards: the line only on a chemical sale; no stale line at posting ---------------------------------------
CREATE FUNCTION public.guard_sales_tax_line_scope_20261231()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (SELECT invoice_type FROM invoices WHERE id = NEW.invoice_id) IS DISTINCT FROM 'chemical_sale' THEN
    RAISE EXCEPTION 'SALES_TAX_LINE_SCOPE: a sales tax line belongs only on a chemical-sale invoice'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_sales_tax_line_scope_20261231() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER invoice_items_sales_tax_scope_20261231
  BEFORE INSERT OR UPDATE OF charge_type, invoice_id ON public.invoice_items
  FOR EACH ROW WHEN (NEW.charge_type = 'sales_tax')
  EXECUTE FUNCTION public.guard_sales_tax_line_scope_20261231();

-- Posting refuses an invoice whose tax line doesn't match its rate (a chemical sale) or that carries one (any other
-- type). Every writer today commits a draft before anyone posts it, so this catches a future path that changes a
-- draft and posts it in one transaction.
CREATE FUNCTION public.guard_sales_tax_current_on_post_20261231()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_discount bigint := 0;
  v_tax bigint := 0;
  v_label text;
  v_pct numeric;
BEGIN
  IF NEW.invoice_type = 'chemical_sale' THEN
    SELECT e.o_cents INTO v_discount FROM public._standing_discount_expected_20261231(NEW.id) e;
    SELECT e.o_cents, e.o_label, e.o_pct INTO v_tax, v_label, v_pct FROM public._sales_tax_expected_20261231(NEW.id, v_discount) e;
  END IF;
  IF (SELECT COALESCE(array_agg(extended_cents::text || '|' || description), '{}'::text[]) FROM invoice_items
       WHERE invoice_id = NEW.id AND charge_type = 'sales_tax')
     IS DISTINCT FROM (CASE WHEN v_tax > 0 THEN ARRAY[v_tax::text || '|' || v_label] ELSE '{}'::text[] END) THEN
    RAISE EXCEPTION 'SALES_TAX_STALE: this draft''s sales tax is out of date; save it again, then post'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_sales_tax_current_on_post_20261231() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER invoices_sales_tax_current_on_post_20261231
  BEFORE UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (OLD.status IN ('draft', 'unposted') AND NEW.status IN ('posted', 'paid', 'overdue') AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION public.guard_sales_tax_current_on_post_20261231();

-- 6. The box on a sale ----------------------------------------------------------------------------------------
CREATE FUNCTION public.set_order_sales_tax(p_order_id uuid, p_sales_tax boolean, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_order orders%ROWTYPE;
  v_fingerprint text;
  v_replay jsonb;
  v_rate numeric;
  v_inv invoices%ROWTYPE;
  v_header jsonb;
  v_items jsonb;
  v_drafts int := 0;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_ALLOWED: sign in to change a sale''s sales tax' USING ERRCODE = '42501';
  END IF;
  IF p_sales_tax IS NULL THEN
    RAISE EXCEPTION 'SALES_TAX_INVALID: the sales tax box is on or off' USING ERRCODE = '22023';
  END IF;

  -- Replay-safe: the same key, caller and request returns the first answer; a different request is refused.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('order_id', p_order_id, 'sales_tax', p_sales_tax));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'set_order_sales_tax', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay -> 'result';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND deleted_at IS NULL FOR UPDATE;
  -- An admin, or the sale's own rep (IS TRUE: a NULL refuses).
  IF NOT FOUND OR NOT (public.is_admin() IS TRUE OR (public.is_sales_rep() IS TRUE AND v_order.salesman_id = v_actor)) THEN
    RAISE EXCEPTION 'SALES_TAX_NOT_ALLOWED: only an admin or the sale''s own rep can change its sales tax' USING ERRCODE = '42501';
  END IF;
  IF v_order.status IN ('cancelled', 'voided') THEN
    RAISE EXCEPTION 'SALES_TAX_ORDER_CLOSED: a cancelled or voided sale can''t change' USING ERRCODE = '22023';
  END IF;

  UPDATE orders SET sales_tax = p_sales_tax WHERE id = p_order_id;
  IF p_sales_tax THEN
    v_rate := public._sales_tax_setting_rate_20261231();
  END IF;

  -- Its chemical-sale drafts follow the box (posted and unposted invoices keep what they were posted with). A draft
  -- already taxed keeps its rate.
  FOR v_inv IN
    SELECT * FROM invoices
     WHERE order_id = p_order_id AND invoice_type = 'chemical_sale' AND status = 'draft' AND deleted_at IS NULL
     ORDER BY id
     FOR UPDATE
  LOOP
    IF p_sales_tax THEN
      INSERT INTO invoice_sales_tax_rates (invoice_id, rate_pct) VALUES (v_inv.id, v_rate) ON CONFLICT (invoice_id) DO NOTHING;
    ELSE
      DELETE FROM invoice_sales_tax_rates WHERE invoice_id = v_inv.id;
    END IF;
    -- Re-saved as the invoice screen would (as set_invoice_standing_discount does), so a split payer's draft keeps its
    -- fingerprint: save_invoice's split guard refreshes it, and the recompute goes in just before. A fresh key of its
    -- own per draft: keys are unique across operations.
    v_header := jsonb_build_object('id', v_inv.id, 'customer_id', v_inv.customer_id, 'invoice_type', v_inv.invoice_type,
      'status', v_inv.status, 'season', v_inv.season, 'salesman_id', v_inv.salesman_id, 'invoice_date', v_inv.invoice_date,
      'due_date', v_inv.due_date, 'payment_terms', v_inv.payment_terms, 'purchase_order_ref', v_inv.purchase_order_ref,
      'header_notes', v_inv.header_notes, 'footer_notes', v_inv.footer_notes);
    SELECT COALESCE(jsonb_agg(to_jsonb(it) ORDER BY it.sort_order, it.id), '[]'::jsonb)
      INTO v_items FROM invoice_items it WHERE it.invoice_id = v_inv.id;
    PERFORM public.save_invoice(v_header, v_items, 'set_order_sales_tax:' || gen_random_uuid()::text);
    PERFORM public._recompute_standing_discount_20261231(v_inv.id);
    v_drafts := v_drafts + 1;
  END LOOP;

  v_result := jsonb_build_object('order_id', p_order_id, 'sales_tax', p_sales_tax, 'drafts_updated', v_drafts);
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, old_values, new_values,
                                   total_impact_cents, description)
  VALUES ('order_updated', 'order', p_order_id, v_actor, (SELECT role FROM profiles WHERE id = v_actor),
          jsonb_build_object('sales_tax', v_order.sales_tax), v_result, 0,
          CASE WHEN p_sales_tax THEN 'Sales tax on' ELSE 'Sales tax off' END);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_order_sales_tax', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_order_sales_tax', v_fingerprint);
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.set_order_sales_tax(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_order_sales_tax(uuid, boolean, text) TO authenticated;

-- 7. Returns credit the tax paid -------------------------------------------------------------------------------
-- 20261231110000's billed cents re-emitted, change marked (tax): a billed product line's cents after its share of
-- its invoice's discount line, plus (tax) its share of its invoice's tax line. The tax is spread over the taxed lines
-- (product lines after their discount share, and charge lines) in proportion to their cents, rounded on running
-- totals, so the shares add up to the tax line exactly. A line on an invoice with neither is its own cents. Read-only.
CREATE OR REPLACE FUNCTION public._standing_discount_net_cents_20261231(p_invoice_item_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH me AS (
    SELECT invoice_id, extended_cents FROM public.invoice_items WHERE id = p_invoice_item_id
  ), d AS (
    SELECT sum(x.extended_cents)::numeric AS cents
      FROM public.invoice_items x, me
     WHERE x.invoice_id = me.invoice_id AND x.charge_type = 'standing_discount'
  ), lines AS (
    SELECT x.id, x.extended_cents,
           sum(x.extended_cents) OVER (ORDER BY x.id) AS running,
           sum(x.extended_cents) OVER () AS base
      FROM public.invoice_items x, me
     WHERE x.invoice_id = me.invoice_id AND x.product_id IS NOT NULL AND x.charge_type IS NULL
  ), net AS (
    SELECT l.id, l.extended_cents + COALESCE((
      SELECT (round(d.cents * l.running / l.base) - round(d.cents * (l.running - l.extended_cents) / l.base))::bigint
        FROM d WHERE d.cents IS NOT NULL AND l.base > 0), 0) AS cents
      FROM lines l
  ), t AS (                                                                     -- (tax)
    SELECT sum(x.extended_cents)::numeric AS cents
      FROM public.invoice_items x, me
     WHERE x.invoice_id = me.invoice_id AND x.charge_type = 'sales_tax'
  ), taxed AS (                                                                 -- (tax)
    SELECT n.id, n.cents FROM net n
    UNION ALL
    SELECT x.id, x.extended_cents
      FROM public.invoice_items x, me
     WHERE x.invoice_id = me.invoice_id
       AND x.charge_type IS DISTINCT FROM 'standing_discount' AND x.charge_type IS DISTINCT FROM 'sales_tax'
       AND NOT (x.product_id IS NOT NULL AND x.charge_type IS NULL)
  ), taxed_run AS (                                                             -- (tax)
    SELECT id, cents, sum(cents) OVER (ORDER BY id) AS running, sum(cents) OVER () AS base FROM taxed
  )
  SELECT COALESCE((SELECT n.cents FROM net n WHERE n.id = p_invoice_item_id), me.extended_cents)
    + COALESCE((                                                                -- (tax)
      SELECT (round(t.cents * r.running / r.base) - round(t.cents * (r.running - r.cents) / r.base))::bigint
        FROM taxed_run r, t
       WHERE r.id = p_invoice_item_id AND t.cents IS NOT NULL AND r.base > 0), 0)
    FROM me;
$function$;

-- The return share (20261231110000) re-emitted with one change, marked (tax): a line billed on an invoice with a tax
-- line is priced from what was billed (share mode), as one with a discount line is.
CREATE OR REPLACE FUNCTION public._return_customer_line_share(p_order_id uuid, p_order_item_id uuid, p_customer_id uuid, p_exclude_return_id uuid)
 RETURNS TABLE(share_mode boolean, billed_qty numeric, billed_cents bigint, other_returned_qty numeric, other_returned_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ord AS (
    SELECT o.customer_id,
           COALESCE(o.needs_split_billing, false)
             OR EXISTS (
               SELECT 1 FROM public.order_item_field_allocations oifa
                 JOIN public.order_items alloc_oi ON alloc_oi.id = oifa.order_item_id
                WHERE alloc_oi.order_id = o.id
             )
             OR EXISTS (SELECT 1 FROM public.split_invoice_provenance p WHERE p.order_id = o.id)
             AS split_evidence
      FROM public.orders o WHERE o.id = p_order_id
  ), billed AS (
    -- after the invoice's discount, with its share of the invoice's tax
    SELECT i.id AS invoice_id, i.customer_id, i.invoice_group_id, ii.quantity,
           public._standing_discount_net_cents_20261231(ii.id) AS extended_cents
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.order_items oi ON oi.id = ii.order_item_id
     WHERE ii.order_item_id = p_order_item_id
       AND ii.product_id = oi.product_id
       AND ii.unit_size IS NOT DISTINCT FROM coalesce(oi.unit_size, 'ea')
       AND ii.quantity > 0
       AND i.order_id = p_order_id
       AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL
       AND i.status IN ('posted', 'overdue', 'paid')
  ), own AS (
    SELECT b.quantity, b.extended_cents
      FROM billed b
     WHERE b.customer_id = p_customer_id
       AND (
         p_customer_id IS NOT DISTINCT FROM (SELECT customer_id FROM ord)
         OR EXISTS (
           SELECT 1 FROM public.split_invoice_provenance p
            WHERE p.invoice_id = b.invoice_id
              AND p.order_id = p_order_id
              AND p.customer_id = p_customer_id
              AND p.invoice_group_id = b.invoice_group_id
         )
       )
  ), other_returns AS (
    SELECT ri.quantity, ri.extended_cents
      FROM public.return_items ri
      JOIN public.returns r ON r.id = ri.return_id
     WHERE ri.order_item_id = p_order_item_id
       AND r.order_id = p_order_id
       AND r.customer_id = p_customer_id
       AND r.deleted_at IS NULL
       AND r.status NOT IN ('rejected', 'cancelled')
       AND r.id IS DISTINCT FROM p_exclude_return_id
  )
  SELECT
    p_customer_id IS DISTINCT FROM (SELECT customer_id FROM ord)
      OR COALESCE((SELECT split_evidence FROM ord), false)
      -- this line is on one of the customer's invoices with a discount or (tax) a tax line (any live invoice, so a
      -- return raised before the invoice posts is held until it does, rather than priced at the full price)
      OR EXISTS (
        SELECT 1 FROM public.invoice_items di
          JOIN public.invoices i ON i.id = di.invoice_id
         WHERE di.order_item_id = p_order_item_id
           AND i.order_id = p_order_id
           AND i.customer_id = p_customer_id
           AND i.invoice_type <> 'credit_memo'
           AND i.deleted_at IS NULL
           AND i.status NOT IN ('voided', 'cancelled')
           AND EXISTS (SELECT 1 FROM public.invoice_items dl
                        WHERE dl.invoice_id = i.id AND dl.charge_type IN ('standing_discount', 'sales_tax'))),
    coalesce((SELECT sum(quantity) FROM own), 0),
    coalesce((SELECT sum(extended_cents) FROM own), 0)::bigint,
    coalesce((SELECT sum(quantity) FROM other_returns), 0),
    coalesce((SELECT sum(extended_cents) FROM other_returns), 0)::bigint;
$function$;
