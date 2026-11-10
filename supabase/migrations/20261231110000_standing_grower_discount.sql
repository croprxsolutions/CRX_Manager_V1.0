-- Written 2026-11-09. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261231110000_standing_grower_discount.md.
-- Re-read the live ledger before applying.
--
-- WHAT (billing plan M4b; Mason 2026-11-04, scenario B11; split rule Taha 2026-11-07):
--   1. customers.standing_discount_pct: a standing grower discount, 0 to 100, default 0. Admin only
--      (STANDING_DISCOUNT_ADMIN_ONLY), like price tiers and credit limits (Mason, 2026-11-01).
--   2. A chemical-sale draft gets one computed line, charge_type 'standing_discount':
--      minus round(product lines x pct / 100) to the cent, half up. Product lines only, not charges.
--      The invoice total is its lines' sum, as every chemical-sale writer already sets it.
--   3. The line is recomputed at commit (a deferred constraint trigger), whichever writer touched the
--      draft: delivery completion, Bill Split, Create Invoice, quick delivery, save_invoice,
--      consolidation, pricing. A line sent back by the screen is replaced, never counted twice.
--      Each payer's invoice uses its own customer's discount, so a split is exact per payer.
--   4. Each invoice keeps the rate it was first drafted at (recorded in invoice_standing_discount_rates). A
--      customer's new rate applies to new sales; the office changes one draft through section 6. Posted invoices
--      never change, and unposting keeps the posted amounts. Posting refuses a draft whose discount line is stale.
--      Only a chemical sale carries the line: it is refused elsewhere and removed from a draft switched away.
--   5. Split invoices (Bill Split, field split) take the discount just before their content fingerprint.
--   6. invoice_standing_discount_rates: the office's rate for one sale (Mason 2026-11-09: "easy for the
--      office to change or remove it on a sale before it's posted"). No row follows the customer; 0 removes it.
--      Written only by set_invoice_standing_discount (an active admin, a chemical-sale draft, replay-safe), which
--      re-saves the draft through save_invoice so a split payer's fingerprint stays right. A side table, so the
--      invoices table, its view and its column grants are untouched.
--
-- NOT CHANGED: every writer function and existing guard, the posting functions themselves (only a BEFORE trigger is
--   added), commission (still worked out on the order before any discount; Mason 2026-11-09: after the discount,
--   built with the week 4 commission PR, and this goes live only with it), returns and credit memos (a return of
--   a discounted sale is handled with that PR too), field application invoices.
--
-- ROLLBACK (its own reviewed migration): drop this migration's triggers and functions, delete the
--   'standing_discount' lines from draft invoices and re-total them, restore the two invoice_items
--   CHECKs to their 20261108160000 text, drop invoice_standing_discount_rates and set_invoice_standing_discount,
--   drop customers.standing_discount_pct.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE standing_discount_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.standing_discount_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.standing_discount_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'standing_discount_pct') THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_PREFLIGHT: customers.standing_discount_pct already exists';
  END IF;
  IF to_regclass('public.invoice_standing_discount_rates') IS NOT NULL
     OR to_regprocedure('public.set_invoice_standing_discount(uuid, numeric, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_PREFLIGHT: the per-sale rate table or its call already exists';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'invoice_items_charge_type_check'
        AND conrelid = 'public.invoice_items'::regclass)
     IS DISTINCT FROM 'CHECK (((charge_type IS NULL) OR (charge_type = ANY (ARRAY[''freight''::text, ''application_fee''::text, ''service''::text, ''other''::text]))))'
  THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_PREFLIGHT: invoice_items_charge_type_check drifted';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'invoice_items_charge_line_shape_chk'
        AND conrelid = 'public.invoice_items'::regclass)
     IS DISTINCT FROM 'CHECK (((charge_type IS NULL) OR ((product_id IS NULL) AND (order_item_id IS NULL) AND (return_credit_source_item_id IS NULL) AND (description ~ ''[^[:space:]]''::text) AND (quantity = (1)::numeric) AND (cost_cents = 0) AND (is_application_fee IS NOT TRUE) AND (unit_price_cents > 0) AND (extended_cents = unit_price_cents))))'
  THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_PREFLIGHT: invoice_items_charge_line_shape_chk drifted';
  END IF;
END
$preflight$;

-- 1. The customer's standing discount ------------------------------------------------------------
ALTER TABLE public.customers
  ADD COLUMN standing_discount_pct numeric(5,2) NOT NULL DEFAULT 0
    CONSTRAINT customers_standing_discount_pct_range CHECK (standing_discount_pct >= 0 AND standing_discount_pct <= 100);

COMMENT ON COLUMN public.customers.standing_discount_pct IS
  'Standing grower discount, percent off product lines on chemical-sale invoices (billing plan M4b). Admin only.';

CREATE FUNCTION public.guard_customer_standing_discount_20261231()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Any signed-in non-admin is refused, on every path (the API, save_customer, Bulk Customer Import).
  -- No signed-in user is a migration or the service role.
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.standing_discount_pct <> 0)
     OR (TG_OP = 'UPDATE' AND NEW.standing_discount_pct IS DISTINCT FROM OLD.standing_discount_pct) THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_ADMIN_ONLY: only an admin can set a customer''s standing discount'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_customer_standing_discount_20261231() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER customers_guard_standing_discount_20261231
  BEFORE INSERT OR UPDATE OF standing_discount_pct ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_standing_discount_20261231();

-- The office's rate for one sale (section 6 writes it).
CREATE TABLE public.invoice_standing_discount_rates (
  invoice_id uuid PRIMARY KEY REFERENCES public.invoices(id) ON DELETE CASCADE,
  rate_pct numeric(5,2) NOT NULL
    CONSTRAINT invoice_standing_discount_rates_range CHECK (rate_pct >= 0 AND rate_pct <= 100),
  set_by uuid REFERENCES public.profiles(id),   -- NULL: recorded from the customer's rate when first drafted
  set_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.invoice_standing_discount_rates IS
  'The standing discount rate one chemical-sale invoice was drafted at (set_by NULL: copied from the customer) or the office set (set_invoice_standing_discount).';

ALTER TABLE public.invoice_standing_discount_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_standing_discount_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.invoice_standing_discount_rates TO authenticated;
GRANT ALL ON public.invoice_standing_discount_rates TO service_role;

-- Readable by anyone who may read the invoice (the invoices policy applies inside the subquery).
CREATE POLICY invoice_standing_discount_rates_select ON public.invoice_standing_discount_rates
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_standing_discount_rates.invoice_id));

-- Every chemical-sale invoice already in the database keeps the rate it was billed at: today every customer's rate is
-- the new column's 0, so this records 0% and moves no invoice. Without it, an older draft or an unposted invoice would
-- take a customer's later rate the first time anything touched it.
INSERT INTO public.invoice_standing_discount_rates (invoice_id, rate_pct, set_by)
SELECT i.id, COALESCE(c.standing_discount_pct, 0), NULL
  FROM public.invoices i LEFT JOIN public.customers c ON c.id = i.customer_id
 WHERE i.invoice_type = 'chemical_sale'
ON CONFLICT (invoice_id) DO NOTHING;

-- 2. The computed line ---------------------------------------------------------------------------
ALTER TABLE public.invoice_items DROP CONSTRAINT invoice_items_charge_type_check;
ALTER TABLE public.invoice_items ADD CONSTRAINT invoice_items_charge_type_check
  CHECK (charge_type IS NULL OR charge_type = ANY (ARRAY['freight', 'application_fee', 'service', 'other', 'standing_discount']));

-- Charge lines stay positive; only the computed discount line is negative.
ALTER TABLE public.invoice_items DROP CONSTRAINT invoice_items_charge_line_shape_chk;
ALTER TABLE public.invoice_items ADD CONSTRAINT invoice_items_charge_line_shape_chk
  CHECK (charge_type IS NULL OR (
    product_id IS NULL AND order_item_id IS NULL AND return_credit_source_item_id IS NULL
    AND description ~ '[^[:space:]]' AND quantity = 1 AND cost_cents = 0 AND is_application_fee IS NOT TRUE
    AND extended_cents = unit_price_cents
    AND CASE WHEN charge_type = 'standing_discount' THEN unit_price_cents < 0 ELSE unit_price_cents > 0 END));

-- Recompute one invoice's discount line and total. A no-op unless it's a live chemical-sale draft.
-- What an invoice's discount line should be: cents (0 = no line) and its label. The invoice's recorded rate,
-- else (never yet drafted) the customer's. Product lines only. Read-only.
CREATE FUNCTION public._standing_discount_expected_20261231(p_invoice_id uuid, OUT o_cents bigint, OUT o_label text, OUT o_pct numeric)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base bigint;
BEGIN
  SELECT COALESCE((SELECT r.rate_pct FROM invoice_standing_discount_rates r WHERE r.invoice_id = i.id), c.standing_discount_pct)
    INTO o_pct
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
   WHERE i.id = p_invoice_id;
  SELECT COALESCE(sum(extended_cents), 0) INTO v_base
    FROM invoice_items WHERE invoice_id = p_invoice_id AND product_id IS NOT NULL AND charge_type IS NULL;
  o_cents := CASE WHEN COALESCE(o_pct, 0) > 0 AND v_base > 0 THEN round(v_base * o_pct / 100) ELSE 0 END;
  o_label := format('Standing discount %s%%', trim_scale(COALESCE(o_pct, 0)));
END
$function$;

REVOKE ALL ON FUNCTION public._standing_discount_expected_20261231(uuid) FROM PUBLIC, anon, authenticated;

-- Recompute one draft's discount line and total. A chemical-sale draft gets its line at its recorded rate (the
-- first time, the customer's rate is recorded for it); any other draft loses a discount line it should not have.
CREATE FUNCTION public._recompute_standing_discount_20261231(p_invoice_id uuid)
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
  v_same boolean;
  v_new_total bigint;
  v_old_discount bigint;
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
    -- Any other draft is left exactly as its writer made it, unless it carries a stray discount line (switched away
    -- from a chemical sale): then only that line's amount comes back out of its total, whatever the total means
    -- for that type (a field application's is not the sum of its lines).
    SELECT COALESCE(sum(extended_cents), 0) INTO v_old_discount
      FROM invoice_items WHERE invoice_id = v_inv.id AND charge_type = 'standing_discount';
    IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = v_inv.id AND charge_type = 'standing_discount')
       OR current_setting('app.crx_standing_discount_busy', true) = v_inv.id::text THEN
      RETURN;
    END IF;
    PERFORM set_config('app.crx_standing_discount_busy', v_inv.id::text, true);
    DELETE FROM invoice_items WHERE invoice_id = v_inv.id AND charge_type = 'standing_discount';
    v_new_total := v_inv.total_amount_cents - v_old_discount;
    UPDATE invoices SET total_amount_cents = v_new_total WHERE id = v_inv.id;
    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, old_values, new_values,
                                     total_impact_cents, description)
    VALUES ('invoice_updated', 'invoice', v_inv.id, COALESCE(auth.uid(), v_inv.created_by),
            CASE WHEN auth.uid() IS NULL THEN 'system' ELSE (SELECT role FROM profiles WHERE id = auth.uid()) END,
            jsonb_build_object('total_amount_cents', v_inv.total_amount_cents),
            jsonb_build_object('total_amount_cents', v_new_total, 'standing_discount_cents', 0),
            v_new_total - v_inv.total_amount_cents, 'Standing discount removed (not a chemical sale)');
    PERFORM set_config('app.crx_standing_discount_busy', '', true);
    RETURN;
  END IF;

  SELECT e.o_cents, e.o_label, e.o_pct INTO v_cents, v_label, v_pct FROM public._standing_discount_expected_20261231(v_inv.id) e;

  -- Nothing to change (cents, label and total): keep the existing line and its id, so a plain re-save is quiet.
  -- (Worked out first: plpgsql ends an IF condition at its first THEN, a CASE's included.)
  v_same := (SELECT COALESCE(array_agg((-(extended_cents::numeric))::text || '|' || description), '{}'::text[]) FROM invoice_items
              WHERE invoice_id = v_inv.id AND charge_type = 'standing_discount')
            = (CASE WHEN v_cents > 0 THEN ARRAY[v_cents || '|' || v_label] ELSE '{}'::text[] END)
        AND (SELECT total_amount_cents FROM invoices WHERE id = v_inv.id)
            = (SELECT COALESCE(sum(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_inv.id);
  IF v_same THEN
    RETURN;
  END IF;

  -- Its own writes queue line-change events for this invoice. Fired after it finishes (at commit) they
  -- find the line right and stop; fired inside it (constraints set IMMEDIATE) they'd recurse, so they
  -- see this marker and skip. A failure rolls the marker back with everything else.
  IF current_setting('app.crx_standing_discount_busy', true) = v_inv.id::text THEN
    RETURN;
  END IF;
  PERFORM set_config('app.crx_standing_discount_busy', v_inv.id::text, true);

  DELETE FROM invoice_items WHERE invoice_id = v_inv.id AND charge_type = 'standing_discount';
  IF v_cents > 0 THEN
    INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents,
                               sort_order, charge_type)
    VALUES (v_inv.id, v_label, 1, -v_cents, -v_cents, 0,
            (SELECT COALESCE(max(sort_order), 0) + 1 FROM invoice_items WHERE invoice_id = v_inv.id),
            'standing_discount');
  END IF;
  v_new_total := (SELECT COALESCE(sum(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_inv.id);
  UPDATE invoices SET total_amount_cents = v_new_total WHERE id = v_inv.id;
  -- The writers logged the draft's total before this line went in; this entry records the change, so the trail adds up.
  IF v_new_total IS DISTINCT FROM v_inv.total_amount_cents THEN
    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, old_values, new_values,
                                     total_impact_cents, description)
    VALUES ('invoice_updated', 'invoice', v_inv.id, COALESCE(auth.uid(), v_inv.created_by),
            -- With no signed-in user (a background or service write) the entry says so; actor_user_id is required,
            -- so it names the invoice's creator, and actor_role 'system' marks that they did not make this change.
            CASE WHEN auth.uid() IS NULL THEN 'system' ELSE (SELECT role FROM profiles WHERE id = auth.uid()) END,
            jsonb_build_object('total_amount_cents', v_inv.total_amount_cents),
            jsonb_build_object('total_amount_cents', v_new_total, 'standing_discount_cents', v_cents, 'rate_pct', v_pct),
            v_new_total - v_inv.total_amount_cents,
            CASE WHEN v_cents > 0 THEN v_label ELSE 'Standing discount removed' END);
  END IF;
  PERFORM set_config('app.crx_standing_discount_busy', '', true);
END
$function$;

REVOKE ALL ON FUNCTION public._recompute_standing_discount_20261231(uuid) FROM PUBLIC, anon, authenticated;

-- 3. At commit, after whichever writer touched the draft -----------------------------------------
CREATE FUNCTION public._standing_discount_after_line_change_20261231()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Every line change, the discount line's own included: a hand edit or delete of it is put right at
  -- commit. The recompute writes nothing when the line and total are already right, so its own
  -- delete and insert end in a no-op pass.
  IF TG_OP <> 'DELETE' THEN
    PERFORM public._recompute_standing_discount_20261231(NEW.invoice_id);
  END IF;
  IF TG_OP = 'DELETE' OR OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
    PERFORM public._recompute_standing_discount_20261231(OLD.invoice_id);
  END IF;
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public._standing_discount_after_line_change_20261231() FROM PUBLIC, anon, authenticated;

CREATE CONSTRAINT TRIGGER invoice_items_standing_discount_20261231
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._standing_discount_after_line_change_20261231();

CREATE FUNCTION public._standing_discount_after_invoice_change_20261231()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- A draft moved to another customer drops a rate it copied from the old one (an office rate stays), so the
  -- recompute records the new customer's.
  IF TG_OP = 'UPDATE' AND OLD.customer_id IS DISTINCT FROM NEW.customer_id THEN
    DELETE FROM invoice_standing_discount_rates WHERE invoice_id = NEW.id AND set_by IS NULL;
  END IF;
  PERFORM public._recompute_standing_discount_20261231(NEW.id);
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public._standing_discount_after_invoice_change_20261231() FROM PUBLIC, anon, authenticated;

-- A new draft records its customer's rate; a draft moved to another customer, switched in type or unposted is
-- checked again (an unposted invoice keeps its recorded rate, so its posted amounts don't move).
CREATE CONSTRAINT TRIGGER invoices_standing_discount_20261231
  AFTER INSERT OR UPDATE OF customer_id, status, invoice_type ON public.invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._standing_discount_after_invoice_change_20261231();

-- 4. Guards: the line only on a chemical sale; no stale line at posting -----------------------------
-- A 'standing_discount' line on any other invoice type is refused (it is the only negative charge line).
CREATE FUNCTION public.guard_standing_discount_line_scope_20261231()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.charge_type = 'standing_discount'
     AND (SELECT invoice_type FROM invoices WHERE id = NEW.invoice_id) IS DISTINCT FROM 'chemical_sale' THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_LINE_SCOPE: a standing discount line belongs only on a chemical-sale invoice'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_standing_discount_line_scope_20261231() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER invoice_items_standing_discount_scope_20261231
  BEFORE INSERT OR UPDATE OF charge_type, invoice_id ON public.invoice_items
  FOR EACH ROW WHEN (NEW.charge_type = 'standing_discount')
  EXECUTE FUNCTION public.guard_standing_discount_line_scope_20261231();

-- Posting a chemical sale refuses a discount line that doesn't match its rate: every writer today commits a draft
-- before anyone posts it, so this only catches a future path that writes lines and posts in one transaction.
CREATE FUNCTION public.guard_standing_discount_current_on_post_20261231()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cents bigint;
  v_label text;
  v_pct numeric;
BEGIN
  SELECT e.o_cents, e.o_label, e.o_pct INTO v_cents, v_label, v_pct FROM public._standing_discount_expected_20261231(NEW.id) e;
  IF (SELECT COALESCE(array_agg((-(extended_cents::numeric))::text || '|' || description), '{}'::text[]) FROM invoice_items
       WHERE invoice_id = NEW.id AND charge_type = 'standing_discount')
     IS DISTINCT FROM (CASE WHEN v_cents > 0 THEN ARRAY[v_cents || '|' || v_label] ELSE '{}'::text[] END) THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_STALE: this draft''s standing discount is out of date; save it again, then post'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_standing_discount_current_on_post_20261231() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER invoices_standing_discount_current_on_post_20261231
  BEFORE UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (OLD.status IN ('draft', 'unposted') AND NEW.status IN ('posted', 'paid', 'overdue')
        AND NEW.invoice_type = 'chemical_sale' AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION public.guard_standing_discount_current_on_post_20261231();

-- 5. Split invoices: the discount goes in before the fingerprint ---------------------------------
-- A Bill Split or field split invoice records its total and a content fingerprint (split_invoice_provenance),
-- and posting refuses one whose contents no longer match. Every writer of that fingerprint (the Bill Split
-- writer, create_split_invoices_from_order, save_invoice's split guard) goes through this table, so the
-- discount is applied just before the fingerprint is taken, and the fingerprint covers it.
CREATE FUNCTION public._standing_discount_before_fingerprint_20261231()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id AND invoice_type = 'chemical_sale'
               AND status IN ('draft', 'unposted') AND deleted_at IS NULL) THEN
    PERFORM public._recompute_standing_discount_20261231(NEW.invoice_id);
    NEW.total_amount_cents := (SELECT total_amount_cents FROM invoices WHERE id = NEW.invoice_id);
    NEW.content_claim := public._split_invoice_content_claim(NEW.invoice_id);
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public._standing_discount_before_fingerprint_20261231() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER split_invoice_provenance_standing_discount_20261231
  BEFORE INSERT OR UPDATE OF total_amount_cents, content_claim ON public.split_invoice_provenance
  FOR EACH ROW EXECUTE FUNCTION public._standing_discount_before_fingerprint_20261231();

-- 6. The office's rate on one sale -------------------------------------------------------------------
CREATE FUNCTION public.set_invoice_standing_discount(p_invoice_id uuid, p_pct numeric, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_inv invoices%ROWTYPE;
  v_fingerprint text;
  v_replay jsonb;
  v_header jsonb;
  v_items jsonb;
  v_result jsonb;
BEGIN
  -- IS NOT TRUE: a NULL from is_admin() refuses too.
  IF v_actor IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_ADMIN_ONLY: only an admin can change a sale''s standing discount' USING ERRCODE = '42501';
  END IF;
  IF p_pct IS NOT NULL AND (p_pct < 0 OR p_pct > 100 OR p_pct <> round(p_pct, 2)) THEN
    RAISE EXCEPTION 'STANDING_DISCOUNT_INVALID: a rate is 0 to 100%% with at most two decimals' USING ERRCODE = '22023';
  END IF;

  -- Replay-safe: the same key, caller and request returns the first answer; a different request is refused.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('invoice_id', p_invoice_id, 'rate_pct', p_pct));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'set_invoice_standing_discount', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay -> 'result';
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND OR v_inv.deleted_at IS NOT NULL OR v_inv.invoice_type <> 'chemical_sale'
     OR v_inv.status NOT IN ('draft', 'unposted') THEN
    RAISE EXCEPTION 'INVOICE_NOT_DRAFT: a standing discount changes only on a chemical-sale draft' USING ERRCODE = '22023';
  END IF;

  IF p_pct IS NULL THEN
    DELETE FROM invoice_standing_discount_rates WHERE invoice_id = v_inv.id;
  ELSE
    INSERT INTO invoice_standing_discount_rates (invoice_id, rate_pct, set_by, set_at)
    VALUES (v_inv.id, p_pct, v_actor, now())
    ON CONFLICT (invoice_id) DO UPDATE SET rate_pct = EXCLUDED.rate_pct, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
  END IF;

  -- Re-saved as the invoice screen would, so a split payer's draft keeps its fingerprint (save_invoice's split
  -- guard refreshes it, and the discount goes in just before). A fresh key of its own: keys are unique across
  -- operations, and a reused one could replay an older save that never refreshes the fingerprint.
  v_header := jsonb_build_object('id', v_inv.id, 'customer_id', v_inv.customer_id, 'invoice_type', v_inv.invoice_type,
    'status', v_inv.status, 'season', v_inv.season, 'salesman_id', v_inv.salesman_id, 'invoice_date', v_inv.invoice_date,
    'due_date', v_inv.due_date, 'payment_terms', v_inv.payment_terms, 'purchase_order_ref', v_inv.purchase_order_ref,
    'header_notes', v_inv.header_notes, 'footer_notes', v_inv.footer_notes);
  -- Every field of every line, so the re-save keeps acres, rates, price source and the rest exactly as they are.
  SELECT COALESCE(jsonb_agg(to_jsonb(it) ORDER BY it.sort_order, it.id), '[]'::jsonb)
    INTO v_items FROM invoice_items it WHERE it.invoice_id = v_inv.id;
  PERFORM public.save_invoice(v_header, v_items, 'set_invoice_standing_discount:' || gen_random_uuid()::text);
  PERFORM public._recompute_standing_discount_20261231(v_inv.id);

  v_result := jsonb_build_object('invoice_id', v_inv.id,
    'rate_pct', (SELECT rate_pct FROM invoice_standing_discount_rates WHERE invoice_id = v_inv.id),
    'total_amount_cents', (SELECT total_amount_cents FROM invoices WHERE id = v_inv.id));
  PERFORM public.save_idempotency(p_idempotency_key, 'set_invoice_standing_discount', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_invoice_standing_discount', v_fingerprint);
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.set_invoice_standing_discount(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_invoice_standing_discount(uuid, numeric, text) TO authenticated;
