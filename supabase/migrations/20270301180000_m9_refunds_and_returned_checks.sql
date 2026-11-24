-- Written 2026-11-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270301180000_m9_refunds_and_returned_checks.md.
-- Re-read the live ledger before applying.
--
-- WHY (M9, billing plan 4 Nov / audit 1.3; design docs/plans/2026-11-23-m9-refunds-returned-checks-DESIGN.md):
--   A refund paid back to a customer outside CRX (a QuickBooks check) can only be entered today by editing the
--   prepay credit down, which leaves no refund record and rewrites the credit's original amount. Nothing checks the
--   customer's stored prepay against the credits (reconcile_prepay_balances silently resets it). A bounced check
--   from a closed month cannot be recorded at all (Mason's decision 18: record a "returned check" in the open month;
--   the invoices it paid are unpaid again; any prepay it funded comes off; the closed month stays closed).
--
-- WHAT:
--   1. money_reversals (one row per refund or returned check, dated in an open month) and money_reversal_lines (what
--      it took from each prepay credit, each invoice payment, each prepay application). Append-only; written only by
--      the functions below; only active admins may read them (reps see the statement rows, never the reasons).
--   2. _recompute_prepay_credit_balance: balance = original - applications + reversed applications - reversal lines
--      (one inserted term pair; the old formula when a credit has no lines); API roles lose EXECUTE on it (a trigger
--      function needs none). A statement-level trigger on money_reversal_lines recomputes each credit its new lines
--      name once. original_amount_cents is never changed, so Month-End's prepay-check figure is not moved.
--   3. record_outside_refund(customer, amount, paid_on?, reference, reason, credit?, performed_by, key,
--      allow_duplicate_reference?): active admin, key required. The entry is dated today (an open month); paid_on is
--      the day the check was written outside CRX (any past date, kept). Draws oldest credit first (or only the one
--      picked), read and locked in one statement; refused above what is available, for a second refund with the
--      same reference unless the admin confirms it, or if the draw does not cover the amount.
--   4. record_returned_check(payment?, bank date, reason, performed_by, key, credit?): one of a Record Payment made by
--      check (NOT_A_CHECK_PAYMENT otherwise; undated refused; bank date not before its payment date) or a Prepayment
--      Manager check (every bucket its one entry wrote, from that entry's audit row; face value = their total). The
--      entry is dated today, an open month (decision 18); the bank's date is kept. Reopens the invoices the check
--      paid (paid -> overdue when past due, else posted), reverses its prepay applications (the rows stay), takes the
--      rest off the credits and the unused part off the stored balance. Refused when its prepay was refunded or it
--      was already returned. Lock order is void_payment's: payment, credits, month, invoices (one sorted pass),
--      customer. The payment rows, allocation lines, applications and periods are never written.
--   Both pass one integrity gate (_m9_check_records_20270225), after their locks and before any write. On the records
--   they touch: same customer everywhere, the check's buckets complete (each in one entry, none left out) and their
--   total the entry's total, no deleted or amount-edited credit, the payment's totals agree with its rows, each
--   invoice's paid and prepay amounts agree with its active rows. On the WHOLE customer: every credit's source payment
--   is this customer's (active, or voided to $0), every application is on this customer's invoices, every credit
--   agrees with its rows and the stored balance is the credits' total. Anything else is refused
--   RECORD_NEEDS_HAND_CHECK: <code>. Round 5: every credit has a known source (an overpayment linked to its payment, or
--   an unlinked check), every active payment behind them adds up, an entry's buckets are one receipt (one reference,
--   one entry time) and no allocation row is $0 or negative. Round 6: an unlinked check credit needs exactly one creation
--   entry, that entry is the customer's and the check's reference, a source payment's credits are all its customer's,
--   and no active payment puts $0 or less on an invoice a return touches. Round 8: every Prepayment Manager entry
--   naming a check credit of the customer is one whole receipt of this customer (its buckets, reference, one entry
--   time, its recorded total, no sibling outside it), for refunds too (CHECK_ENTRY_MISMATCH); a refund or return on
--   any bucket freezes the amounts of all its siblings (edit / delete guard). Round 9: an entry is matched only as an
--   array of distinct ids (CHECK_ENTRY_MALFORMED otherwise), and a refund locks every credit of the customer first.
--   Round 11: a Prepayment Manager check's amounts are locked (edit refuses PREPAY_CHECK_AMOUNT_LOCKED; notes and
--   reference still change); delete_prepay_credit deletes the whole check (every bucket of its entry, one audit row,
--   refused if any bucket was applied or reversed), and the gate skips an entry deleted whole.
--   Round 14: an overpayment's amount is locked too (edit and delete refuse PREPAY_OVERPAYMENT_LOCKED; its payment is
--   voided instead), so no Prepayment Manager action can break its payment's totals.
--   A return also refuses a draft, void, cancelled or deleted invoice
--   (RETURN_INVOICE_NOT_OPEN).
--   5. get_prepay_balance_check(customer?): read-only; received - applied - refunded - returned = expected, against
--      the stored balance and the credits' balances, plus each credit against its own rows (credit_mismatches);
--      never fixes anything.
--   6. Month-End: _month_payments_received nets returned checks out of payments received on their entry date (not
--      counted as payments) and counts one payment per Prepayment Manager entry (two checks entered together are two); _month_close_figures adds refunds {count,total_cents} and returned_checks figures (so the
--      review token covers them) and refunds_paid_cents / returned_checks_cents on the close receipt.
--   7. Statement (_get_customer_statement_scoped_impl): a "Returned check <ref>" row puts back what the check paid; a
--      "Refund paid (outside CRX) <ref>" row with $0 effect (no staff reason on the statement). statement_customer_has_later_balance_activity: a later returned
--      check makes an older A/R date unrebuildable (flagged) when it touched an invoice of that date, as a void does;
--      the credit-timestamp test is left as it was (round 10: a returned credit still trips it, so an application an
--      invoice void removed after the cutoff is never hidden).
--   8. Guards: void_payment refuses a set that is not a payment (NOT_A_PAYMENT), a returned payment and one whose
--      prepay was refunded, and locks its invoices in one
--      id-ordered pass; edit_prepay_credit refuses a
--      balance change and delete_prepay_credit refuses any credit a refund or returned check names (line, header or
--      its returned payment). void_invoice refuses an invoice a returned check paid (INVOICE_HAS_RETURNED_PAYMENT; for
--      an active admin, anyone else gets the void's own refusal);
--      underneath, a reversed application can never be deleted (FK, no cascade). No prepay "restore" RPC exists.
--   Audit: financial_audit_log_operation_type_check gains 'prepay_refunded_outside' and 'payment_returned'.
--
-- NOT CHANGED: who may call each replaced function (except the recompute trigger function, which API roles can no
-- longer EXECUTE), its arguments, defaults, other grants and security; every other Month-End figure; saved close
-- receipts; any existing row.
-- caller-analysis: record_outside_refund / record_returned_check / get_prepay_balance_check :: new; no caller yet (the
-- screen stage adds them). The replaced functions keep their signatures and wrappers.
-- caller-analysis: _recompute_prepay_credit_balance :: EXECUTE revoked from PUBLIC, anon and authenticated; it is only
-- ever run by its triggers (a trigger fires without the EXECUTE privilege); service_role keeps it.
-- ROLLBACK (its own reviewed migration, only while no money_reversals row exists): re-create the nine replaced
-- functions from the bodies pinned in this file's preflight (latest defining migrations: 20260728231350 / baseline
-- for the recompute, 20261204100000 for void_payment, baseline for edit/delete, 20270224120000 for the two Month-End
-- helpers, 20260803221244 for the tripwire, 20261204110000 for the statement, 20260827041100 for void_invoice),
-- restore the audit CHECK list and the recompute's EXECUTE grants, drop the two tables first (their triggers go with
-- them), then the three RPCs and the five helpers. void_payment, edit and delete also set customers.updated_at when they change the cached balance.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE m9_refunds_returned_checks_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

CREATE TEMP TABLE m9_old_audit_check ON COMMIT DROP AS
SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
 WHERE conrelid = 'public.financial_audit_log'::regclass AND conname = 'financial_audit_log_operation_type_check';

CREATE TEMP TABLE m9_pins ON COMMIT DROP AS
SELECT * FROM (VALUES
      ('public._recompute_prepay_credit_balance()', '62822c67b972a855aed23f9e9bac1d75', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 0, 'v', 'a2f62dc650a114afe1ab0b81295fef46', '{postgres=X/postgres,service_role=X/postgres}'),
      ('public._void_payment_replay_impl_20261015(uuid,text,uuid,text)', '249d13c9887436709119b442a8928ad3', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres}', 2, 'v', '7910e4a6a9893a37ebaf962b554b792b', '{postgres=X/postgres}'),
      ('public._edit_prepay_credit_replay_impl_20261015(uuid,bigint,text,text,text,uuid,text)', '366db16a403a0f508b28aadc8862475c', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres}', 6, 'v', '18d4a819523ca319527e843b3e424fb7', '{postgres=X/postgres}'),
      ('public._delete_prepay_credit_replay_impl_20261015(uuid,text,uuid,text)', 'bcb90bd23619af6f1e45c69bb2db4169', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres}', 2, 'v', '5f19865fc627436289921c95e41840c3', '{postgres=X/postgres}'),
      ('public._month_payments_received_20270208(date,date)', 'b090a4ff1e6711f2565414c794e96d3a', false, '{"search_path=public, pg_temp"}', '{postgres=X/postgres,service_role=X/postgres}', 0, 's', '532523ad705b958f78ca89573fdc9581', '{postgres=X/postgres,service_role=X/postgres}'),
      ('public._month_close_figures_20270208(date,date)', 'b20bcd3b5e5fd21adf8988cbbec80832', false, '{"search_path=public, pg_temp"}', '{postgres=X/postgres,service_role=X/postgres}', 0, 's', 'a2dba31d0f27815de1dc4a1136b3a0c9', '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.statement_customer_has_later_balance_activity(uuid,date)', '92ec7763565786356e95f722e1745885', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres}', 0, 's', '61a64a802b7bad6922e8a723889eef1d', '{postgres=X/postgres}'),
      ('public._get_customer_statement_scoped_impl(uuid,date,date)', 'ee463c1bee06baa4b71943695da3bacf', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres}', 2, 's', 'b95b52d29fae2109a041dd966c38488c', '{postgres=X/postgres}'),
      ('public.void_invoice(uuid,text,text)', '2b1be1b706614f9a909581b0493d679f', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 1, 'v', '35c25993ab446dfdae1f1de696c26a67', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
) AS t(sig, md5, secdef, cfg, acl, ndefaults, vol, sigmd5, post_acl);

-- Grants compared as a set (the order of entries carries no meaning).
CREATE FUNCTION pg_temp.m9_acl(p_acl text) RETURNS text LANGUAGE sql IMMUTABLE AS $acl$
  SELECT string_agg(x, ',' ORDER BY x) FROM unnest(string_to_array(btrim(p_acl, '{}'), ',')) AS x
$acl$;

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.m9_refunds_returned_checks_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.m9_refunds_returned_checks_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'M9_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regclass('public.money_reversals') IS NOT NULL OR to_regclass('public.money_reversal_lines') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                 AND proname IN ('record_outside_refund', 'record_returned_check', 'get_prepay_balance_check',
                                 '_money_reversals_append_only_20270225', '_prepay_credit_reversed_20270225',
                                 '_prepay_credit_computed_balance_20270225', '_recompute_prepay_credits_from_lines_20270225',
                                 '_m9_check_records_20270225')) THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public._month_close_figures_20270208(date,date)') IS NULL THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: 20270224120000_month_close_payments_received_recheck is not applied';
  END IF;
  -- Every function replaced below, exactly as the latest migration defining it left it (body, owner, security,
  -- search_path, grants, defaults, volatility).
  SELECT string_agg(f.sig, ', ') INTO v_bad
    FROM pg_temp.m9_pins f
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.sig)
        AND md5(replace(p.prosrc, chr(13), '')) = f.md5
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef = f.secdef
        AND p.proconfig::text = f.cfg
        AND pg_temp.m9_acl(p.proacl::text) = pg_temp.m9_acl(f.acl)
        AND p.pronargdefaults = f.ndefaults
        AND p.provolatile::text = f.vol
        -- arguments with their default expressions, and the result
        AND md5(pg_get_function_arguments(p.oid) || ' => ' || pg_get_function_result(p.oid)) = f.sigmd5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: drifted: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('_recompute_prepay_credit_balance', '_void_payment_replay_impl_20261015', '_edit_prepay_credit_replay_impl_20261015', '_delete_prepay_credit_replay_impl_20261015', '_month_payments_received_20270208', '_month_close_figures_20270208', 'statement_customer_has_later_balance_activity', '_get_customer_statement_scoped_impl', 'void_invoice')) <> 9 THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: an unexpected overload of a replaced function exists';
  END IF;
  IF (SELECT md5(pg_get_constraintdef(oid)) FROM pg_constraint
       WHERE conrelid = 'public.financial_audit_log'::regclass AND conname = 'financial_audit_log_operation_type_check')
     IS DISTINCT FROM '424d2bb072159b9064b143ecf260e88c' THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: financial_audit_log_operation_type_check drifted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_recompute_prepay_credit_balance'
                  AND tgrelid = 'public.prepay_applications'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                  AND tgtype = 13 AND tgqual IS NULL  -- AFTER INSERT OR DELETE, FOR EACH ROW, no WHEN
                  AND tgfoid = 'public._recompute_prepay_credit_balance()'::regprocedure) THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: the prepay recompute trigger is missing or disabled';
  END IF;
END
$preflight$;

-- 1. The record of money going back out (refunds) or never arriving (returned checks) -----------------------------
CREATE TABLE public.money_reversals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('outside_refund', 'returned_check')),
  customer_id       uuid NOT NULL REFERENCES public.customers(id),
  entry_date        date NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  reference         text,
  reason            text NOT NULL CHECK (reason ~ '\S'),
  allocation_set_id uuid REFERENCES public.allocation_sets(id),
  prepay_credit_id  uuid REFERENCES public.prepay_credits(id),
  -- The day it happened outside CRX: the bank returned the check (required) or the refund was paid (optional). It may
  -- fall in a closed month; entry_date is the open-month day it was recorded (always today, Chicago).
  occurred_on       date,
  performed_by      uuid NOT NULL REFERENCES public.profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT money_reversals_source CHECK (
    (kind = 'outside_refund' AND allocation_set_id IS NULL AND prepay_credit_id IS NULL)
    OR (kind = 'returned_check' AND num_nonnulls(allocation_set_id, prepay_credit_id) = 1)),
  CONSTRAINT money_reversals_occurred_on CHECK ((kind <> 'returned_check' OR occurred_on IS NOT NULL)
    AND (occurred_on IS NULL OR occurred_on <= entry_date))
);
COMMENT ON TABLE public.money_reversals IS
  'M9: a refund paid outside CRX (outside_refund) or a returned/bounced check (returned_check), dated in an open month (entry_date). Append-only; written only by record_outside_refund / record_returned_check.';
-- A check comes back once: one return per Record Payment and one per Prepayment Manager check credit.
CREATE UNIQUE INDEX money_reversals_one_return_per_payment ON public.money_reversals (allocation_set_id)
  WHERE kind = 'returned_check' AND allocation_set_id IS NOT NULL;
CREATE UNIQUE INDEX money_reversals_one_return_per_credit ON public.money_reversals (prepay_credit_id)
  WHERE kind = 'returned_check' AND prepay_credit_id IS NOT NULL;
CREATE INDEX money_reversals_customer_date ON public.money_reversals (customer_id, entry_date);
CREATE INDEX money_reversals_entry_date ON public.money_reversals (entry_date);

CREATE TABLE public.money_reversal_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reversal_id           uuid NOT NULL REFERENCES public.money_reversals(id),
  line_kind             text NOT NULL CHECK (line_kind IN ('prepay_credit', 'invoice_payment', 'prepay_application')),
  prepay_credit_id      uuid REFERENCES public.prepay_credits(id),
  invoice_id            uuid REFERENCES public.invoices(id),
  -- No cascade: a reversed application can never be deleted (an invoice void that would delete it is refused).
  prepay_application_id uuid REFERENCES public.prepay_applications(id),
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT money_reversal_lines_shape CHECK (
    (line_kind = 'prepay_credit' AND prepay_credit_id IS NOT NULL AND invoice_id IS NULL AND prepay_application_id IS NULL)
    OR (line_kind = 'invoice_payment' AND invoice_id IS NOT NULL AND prepay_credit_id IS NULL AND prepay_application_id IS NULL)
    OR (line_kind = 'prepay_application' AND prepay_application_id IS NOT NULL AND prepay_credit_id IS NOT NULL AND invoice_id IS NOT NULL))
);
COMMENT ON TABLE public.money_reversal_lines IS
  'M9: what one money_reversals row took from each prepay credit (prepay_credit), each invoice payment (invoice_payment) and each prepay application (prepay_application). Counted by _recompute_prepay_credit_balance. Append-only.';
CREATE UNIQUE INDEX money_reversal_lines_one_per_application ON public.money_reversal_lines (prepay_application_id)
  WHERE prepay_application_id IS NOT NULL;
CREATE INDEX money_reversal_lines_reversal ON public.money_reversal_lines (reversal_id);
CREATE INDEX money_reversal_lines_credit ON public.money_reversal_lines (prepay_credit_id) WHERE prepay_credit_id IS NOT NULL;
CREATE INDEX money_reversal_lines_invoice ON public.money_reversal_lines (invoice_id) WHERE invoice_id IS NOT NULL;

CREATE FUNCTION public._money_reversals_append_only_20270225()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'MONEY_REVERSAL_IMMUTABLE: % rows cannot be changed or deleted', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$function$;
ALTER FUNCTION public._money_reversals_append_only_20270225() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._money_reversals_append_only_20270225() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER money_reversals_append_only BEFORE UPDATE OR DELETE ON public.money_reversals
  FOR EACH ROW EXECUTE FUNCTION public._money_reversals_append_only_20270225();
CREATE TRIGGER money_reversal_lines_append_only BEFORE UPDATE OR DELETE ON public.money_reversal_lines
  FOR EACH ROW EXECUTE FUNCTION public._money_reversals_append_only_20270225();
CREATE TRIGGER money_reversal_lines_truncate_refused BEFORE TRUNCATE ON public.money_reversal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public._money_reversals_append_only_20270225();
CREATE TRIGGER money_reversals_truncate_refused BEFORE TRUNCATE ON public.money_reversals
  FOR EACH STATEMENT EXECUTE FUNCTION public._money_reversals_append_only_20270225();

ALTER TABLE public.money_reversals OWNER TO postgres;
ALTER TABLE public.money_reversal_lines OWNER TO postgres;
-- Reads: active admins only (Sol round 4: the reason and amounts of another customer's refund are not a rep's to
-- read; the statement shows reps the rows through its own SECURITY DEFINER read). No API role writes.
ALTER TABLE public.money_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.money_reversal_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.money_reversals, public.money_reversal_lines FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.money_reversals, public.money_reversal_lines TO authenticated, service_role;
CREATE POLICY money_reversals_admin_read ON public.money_reversals FOR SELECT TO authenticated
  USING (public.is_admin());
CREATE POLICY money_reversal_lines_admin_read ON public.money_reversal_lines FOR SELECT TO authenticated
  USING (public.is_admin());


-- Is this credit part of a refund or a returned check (a line on it, or the returned payment that minted it)? Every
-- bucket of a returned Prepayment Manager check carries a line. Used by the edit / delete guards.
CREATE FUNCTION public._prepay_credit_reversed_20270225(p_credit_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.money_reversal_lines l WHERE l.prepay_credit_id = p_credit_id)
      OR EXISTS (SELECT 1 FROM public.money_reversals r
                   JOIN public.prepay_credits pc ON pc.id = p_credit_id
                  WHERE r.kind = 'returned_check' AND r.allocation_set_id IS NOT NULL
                    AND r.allocation_set_id = pc.allocation_set_id)
      -- or a sibling bucket of its Prepayment Manager entry (one check is one receipt: refunding or returning any
      -- bucket freezes the amounts of all of them)
      OR EXISTS (SELECT 1 FROM public.financial_audit_log fal
                   CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END) b(id)
                  WHERE fal.operation_type = 'prepay_credit_created'
                    AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array'
                    AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' AND fal.new_values -> 'credit_ids' @> jsonb_build_array(p_credit_id::text)
                    AND (EXISTS (SELECT 1 FROM public.money_reversal_lines l WHERE l.prepay_credit_id::text = b.id)
                         OR EXISTS (SELECT 1 FROM public.money_reversals r WHERE r.prepay_credit_id::text = b.id)))
$function$;
ALTER FUNCTION public._prepay_credit_reversed_20270225(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._prepay_credit_reversed_20270225(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- A credit's balance from its rows (the recompute trigger's formula), for the drift refusals and the check.
CREATE FUNCTION public._prepay_credit_computed_balance_20270225(p_credit_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT pc.original_amount_cents
         - COALESCE((SELECT sum(applied_amount_cents) FROM public.prepay_applications WHERE prepay_credit_id = pc.id), 0)
         + COALESCE((SELECT sum(amount_cents) FROM public.money_reversal_lines
                      WHERE prepay_credit_id = pc.id AND line_kind = 'prepay_application'), 0)
         - COALESCE((SELECT sum(amount_cents) FROM public.money_reversal_lines
                      WHERE prepay_credit_id = pc.id AND line_kind = 'prepay_credit'), 0)
    FROM public.prepay_credits pc WHERE pc.id = p_credit_id
$function$;
ALTER FUNCTION public._prepay_credit_computed_balance_20270225(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._prepay_credit_computed_balance_20270225(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- The line trigger: once per INSERT statement, each credit the new lines name gets the recompute's balance (so a
-- return with many applications recomputes each credit once, not once per line).
CREATE FUNCTION public._recompute_prepay_credits_from_lines_20270225()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  UPDATE public.prepay_credits pc
     SET balance_cents = public._prepay_credit_computed_balance_20270225(pc.id), updated_at = now()
   WHERE pc.id IN (SELECT DISTINCT n.prepay_credit_id FROM m9_new_lines n WHERE n.prepay_credit_id IS NOT NULL);
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public._recompute_prepay_credits_from_lines_20270225() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._recompute_prepay_credits_from_lines_20270225() FROM PUBLIC, anon, authenticated, service_role;

-- The integrity gate: a refund or a return runs it, after its locks and before it writes, on exactly the records it
-- touches. Anything that does not agree is refused RECORD_NEEDS_HAND_CHECK with a reason code; the office handles it.
CREATE FUNCTION public._m9_check_records_20270225(
  p_customer_id uuid, p_allocation_set_id uuid, p_credit_ids uuid[], p_bucket_ids uuid[], p_invoice_ids uuid[],
  p_customer_debit bigint)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_code text;
BEGIN
  v_code := CASE
    -- every linked payment, allocation, invoice, credit and application is this customer's
    WHEN EXISTS (SELECT 1 FROM public.allocation_sets a WHERE a.id = p_allocation_set_id AND a.customer_id IS DISTINCT FROM p_customer_id)
      OR EXISTS (SELECT 1 FROM public.invoice_line_allocations l LEFT JOIN public.invoices i ON i.id = l.invoice_id
                  WHERE l.allocation_set_id = p_allocation_set_id
                    AND (l.bill_to_customer_id IS DISTINCT FROM p_customer_id OR i.customer_id IS DISTINCT FROM p_customer_id))
      OR EXISTS (SELECT 1 FROM public.prepay_credits pc WHERE pc.id = ANY (p_credit_ids) AND pc.customer_id IS DISTINCT FROM p_customer_id)
      OR EXISTS (SELECT 1 FROM public.prepay_applications pa JOIN public.invoices i ON i.id = pa.invoice_id
                  WHERE pa.prepay_credit_id = ANY (p_credit_ids) AND i.customer_id IS DISTINCT FROM p_customer_id)
      THEN 'CUSTOMER_MISMATCH'
    -- a Prepayment Manager check: every bucket its entry lists exists, is this customer's and is a check
    WHEN p_bucket_ids IS NOT NULL
         AND (cardinality(p_bucket_ids) = 0
              OR (SELECT count(*) FROM public.prepay_credits pc
                   WHERE pc.id = ANY (p_bucket_ids) AND pc.customer_id = p_customer_id
                     AND pc.source_type = 'check' AND pc.allocation_set_id IS NULL) <> cardinality(p_bucket_ids)
              -- the buckets are one receipt: one reference and one entry time
              OR (SELECT count(DISTINCT (pc.created_at, pc.source_reference)) FROM public.prepay_credits pc
                   WHERE pc.id = ANY (p_bucket_ids)) <> 1
              -- the entry is this customer's, for this check's reference
              OR EXISTS (SELECT 1 FROM public.financial_audit_log fal JOIN public.prepay_credits pc ON pc.id = p_bucket_ids[1]
                          WHERE fal.operation_type = 'prepay_credit_created' AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' AND fal.new_values -> 'credit_ids' @> jsonb_build_array(pc.id::text)
                            AND (fal.entity_id IS DISTINCT FROM p_customer_id
                                 OR (fal.new_values ->> 'reference_number') IS DISTINCT FROM pc.source_reference))
              -- each bucket is in exactly one entry
              OR EXISTS (SELECT 1 FROM unnest(p_bucket_ids) b(id)
                          WHERE (SELECT count(*) FROM public.financial_audit_log fal
                                  WHERE fal.operation_type = 'prepay_credit_created' AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' AND fal.new_values -> 'credit_ids' @> jsonb_build_array(b.id::text)) <> 1)
              -- no check bucket entered with them (same customer, reference and entry time) is missing from every entry
              OR EXISTS (SELECT 1 FROM public.prepay_credits o JOIN public.prepay_credits b ON b.id = ANY (p_bucket_ids)
                          WHERE o.customer_id = p_customer_id AND o.source_type = 'check' AND o.allocation_set_id IS NULL
                            AND o.created_at = b.created_at AND o.source_reference IS NOT DISTINCT FROM b.source_reference
                            AND NOT EXISTS (SELECT 1 FROM public.financial_audit_log fal
                                             WHERE fal.operation_type = 'prepay_credit_created' AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' AND fal.new_values -> 'credit_ids' @> jsonb_build_array(o.id::text))))
      THEN 'CHECK_BUCKETS'
    WHEN EXISTS (SELECT 1 FROM public.financial_audit_log fal
                  WHERE fal.operation_type = 'prepay_deleted'
                    AND (fal.entity_id = ANY (p_credit_ids)
                         -- a Prepayment Manager check deleted whole names every bucket
                         OR (jsonb_typeof(fal.new_values -> 'credit_ids') = 'array'
                             AND EXISTS (SELECT 1 FROM unnest(p_credit_ids) c(id)
                                          WHERE fal.new_values -> 'credit_ids' @> jsonb_build_array(c.id::text)))))
      THEN 'CREDIT_DELETED'
    WHEN EXISTS (SELECT 1 FROM public.financial_audit_log fal
                  WHERE fal.operation_type = 'prepay_edited' AND fal.entity_id = ANY (p_credit_ids)
                    AND (fal.old_values ->> 'original_amount_cents') IS DISTINCT FROM (fal.new_values ->> 'original_amount_cents'))
      THEN 'CREDIT_AMOUNT_EDITED'
    -- the check's face value (its buckets' amounts) is the total its entry recorded
    WHEN p_bucket_ids IS NOT NULL
         AND (SELECT fal.new_values -> 'total_cents' FROM public.financial_audit_log fal
               WHERE fal.operation_type = 'prepay_credit_created' AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' AND fal.new_values -> 'credit_ids' @> jsonb_build_array(p_bucket_ids[1]::text))
             IS DISTINCT FROM (SELECT to_jsonb(sum(pc.original_amount_cents)) FROM public.prepay_credits pc WHERE pc.id = ANY (p_bucket_ids))
      THEN 'CHECK_FACE_VALUE'
    -- a Record Payment: its allocated total is its invoice allocation rows, and those plus its prepay are the check
    WHEN EXISTS (SELECT 1 FROM public.allocation_sets a
                  WHERE a.id = p_allocation_set_id
                    AND (EXISTS (SELECT 1 FROM public.invoice_line_allocations l WHERE l.allocation_set_id = a.id
                                  AND (l.invoice_id IS NULL OR l.amount_cents <= 0))
                         OR COALESCE(a.total_allocated_cents, 0) IS DISTINCT FROM
                            (SELECT COALESCE(sum(l.amount_cents), 0) FROM public.invoice_line_allocations l WHERE l.allocation_set_id = a.id)
                         OR a.total_payment_cents IS DISTINCT FROM COALESCE(a.total_allocated_cents, 0)
                            + (SELECT COALESCE(sum(pc.original_amount_cents), 0) FROM public.prepay_credits pc
                                WHERE pc.allocation_set_id = a.id AND pc.source_type = 'overpayment')))
      THEN 'PAYMENT_TOTALS'
    -- each invoice touched: paid = its active payments' allocations less returned checks; prepay applied = its
    -- applications less the ones returned checks reversed
    WHEN EXISTS (SELECT 1 FROM public.invoices i
                  WHERE i.id = ANY (p_invoice_ids)
                    AND i.paid_amount_cents IS DISTINCT FROM
                        COALESCE((SELECT sum(l.amount_cents) FROM public.invoice_line_allocations l
                                    JOIN public.allocation_sets a ON a.id = l.allocation_set_id
                                   WHERE l.invoice_id = i.id AND a.is_active AND a.entity_type = 'payment'), 0)
                        - COALESCE((SELECT sum(r.amount_cents) FROM public.money_reversal_lines r
                                      WHERE r.invoice_id = i.id AND r.line_kind = 'invoice_payment'), 0))
      THEN 'INVOICE_PAID_MISMATCH'
    -- no active payment puts $0 or less on a touched invoice (a return must never drive paid below zero)
    WHEN EXISTS (SELECT 1 FROM public.invoice_line_allocations l JOIN public.allocation_sets a ON a.id = l.allocation_set_id
                  WHERE l.invoice_id = ANY (p_invoice_ids) AND a.is_active AND a.entity_type = 'payment' AND l.amount_cents <= 0)
      THEN 'INVOICE_NEGATIVE_ALLOCATION'
    WHEN EXISTS (SELECT 1 FROM public.invoices i
                  WHERE i.id = ANY (p_invoice_ids)
                    AND i.prepay_applied_cents IS DISTINCT FROM
                        COALESCE((SELECT sum(pa.applied_amount_cents) FROM public.prepay_applications pa WHERE pa.invoice_id = i.id), 0)
                        - COALESCE((SELECT sum(r.amount_cents) FROM public.money_reversal_lines r
                                      WHERE r.invoice_id = i.id AND r.line_kind = 'prepay_application'), 0))
      THEN 'INVOICE_PREPAY_MISMATCH'
    -- The whole customer (Sol round 4), not only what this touches: every credit's source payment is this customer's
    -- active payment (a voided one has $0 left), every application of its credits is on its own invoices, every credit
    -- agrees with its rows, and the stored balance is the credits' total.
    WHEN EXISTS (SELECT 1 FROM public.prepay_credits pc JOIN public.allocation_sets a ON a.id = pc.allocation_set_id
                  WHERE pc.customer_id = p_customer_id
                    AND (a.customer_id IS DISTINCT FROM p_customer_id OR a.entity_type IS DISTINCT FROM 'payment'
                         OR (NOT a.is_active AND (pc.original_amount_cents <> 0 OR pc.balance_cents <> 0))))
      THEN 'CREDIT_SOURCE_MISMATCH'
    -- every credit came from a Record Payment (overpayment, linked) or a Prepayment Manager check (check, unlinked)
    WHEN EXISTS (SELECT 1 FROM public.prepay_credits pc
                  WHERE pc.customer_id = p_customer_id
                    AND NOT ((pc.source_type = 'overpayment' AND pc.allocation_set_id IS NOT NULL)
                             OR (pc.source_type = 'check' AND pc.allocation_set_id IS NULL
                                 -- a Prepayment Manager check is proven by exactly one creation entry
                                 AND (SELECT count(*) FROM public.financial_audit_log fal
                                       WHERE fal.operation_type = 'prepay_credit_created'
                                         AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' AND fal.new_values -> 'credit_ids' @> jsonb_build_array(pc.id::text)) = 1)))
      THEN 'CREDIT_SOURCE_UNKNOWN'
    -- every Prepayment Manager entry naming one of the customer's check credits is one whole receipt of this
    -- customer: its buckets are all this customer's unlinked checks with the entry's reference and one entry time,
    -- they add up to the entry's recorded total, and no other check credit of that receipt sits outside it
    WHEN EXISTS (
      SELECT 1 FROM public.financial_audit_log fal
       WHERE fal.operation_type = 'prepay_credit_created'
         AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array'
         -- a check deleted whole (delete_prepay_credit, every bucket at $0) is no longer a receipt
         AND NOT (EXISTS (SELECT 1 FROM public.financial_audit_log d
                           WHERE d.operation_type = 'prepay_deleted' AND d.new_values ->> 'whole_check' = 'true'
                             AND jsonb_typeof(d.new_values -> 'credit_ids') = 'array'
                             AND (d.new_values -> 'credit_ids') @> (fal.new_values -> 'credit_ids')
                             AND (d.new_values -> 'credit_ids') <@ (fal.new_values -> 'credit_ids'))
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END) b(id)
                                    JOIN public.prepay_credits pc ON pc.id::text = b.id
                                   WHERE pc.original_amount_cents <> 0 OR pc.balance_cents <> 0))
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END) b(id)
                       JOIN public.prepay_credits pc ON pc.id::text = b.id
                      WHERE pc.customer_id = p_customer_id AND pc.source_type = 'check' AND pc.allocation_set_id IS NULL)
         AND (fal.entity_id IS DISTINCT FROM p_customer_id
              -- each bucket listed once
              OR jsonb_array_length(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END)
                 <> (SELECT count(DISTINCT b.id) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END) b(id))
              OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END) b(id)
                           LEFT JOIN public.prepay_credits pc ON pc.id::text = b.id
                          WHERE pc.id IS NULL OR pc.customer_id IS DISTINCT FROM p_customer_id
                             OR pc.source_type IS DISTINCT FROM 'check' OR pc.allocation_set_id IS NOT NULL
                             OR pc.source_reference IS DISTINCT FROM (fal.new_values ->> 'reference_number'))
              OR (SELECT count(DISTINCT pc.created_at) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END) b(id)
                    JOIN public.prepay_credits pc ON pc.id::text = b.id) <> 1
              OR fal.new_values -> 'total_cents' IS DISTINCT FROM
                 (SELECT to_jsonb(sum(pc.original_amount_cents)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END) b(id)
                    JOIN public.prepay_credits pc ON pc.id::text = b.id)
              OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END) b(id)
                           JOIN public.prepay_credits pc ON pc.id::text = b.id
                           JOIN public.prepay_credits o ON o.customer_id = pc.customer_id AND o.source_type = 'check'
                                AND o.allocation_set_id IS NULL AND o.created_at = pc.created_at
                                AND o.source_reference IS NOT DISTINCT FROM pc.source_reference
                          WHERE NOT (jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' AND fal.new_values -> 'credit_ids' @> jsonb_build_array(o.id::text)))))
      THEN 'CHECK_ENTRY_MISMATCH'
    -- a Prepayment Manager entry recorded for this customer lists its buckets as an array of distinct ids
    WHEN EXISTS (SELECT 1 FROM public.financial_audit_log fal
                  WHERE fal.operation_type = 'prepay_credit_created' AND fal.entity_type = 'prepay_credit'
                    AND fal.entity_id = p_customer_id AND fal.new_values ? 'credit_ids'
                    AND (jsonb_typeof(fal.new_values -> 'credit_ids') IS DISTINCT FROM 'array'
                         OR jsonb_array_length(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END)
                            <> (SELECT count(DISTINCT b.id) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END) b(id))))
      THEN 'CHECK_ENTRY_MALFORMED'
    -- every active payment behind the customer's credits adds up (its invoice rows plus its prepay are the check)
    WHEN EXISTS (SELECT 1 FROM public.allocation_sets a
                  WHERE a.is_active
                    AND a.id IN (SELECT pc.allocation_set_id FROM public.prepay_credits pc WHERE pc.customer_id = p_customer_id)
                    AND (EXISTS (SELECT 1 FROM public.invoice_line_allocations l WHERE l.allocation_set_id = a.id
                                  AND (l.invoice_id IS NULL OR l.amount_cents <= 0))
                         OR EXISTS (SELECT 1 FROM public.prepay_credits pc WHERE pc.allocation_set_id = a.id
                                     AND pc.customer_id IS DISTINCT FROM a.customer_id)
                         OR COALESCE(a.total_allocated_cents, 0) IS DISTINCT FROM
                            (SELECT COALESCE(sum(l.amount_cents), 0) FROM public.invoice_line_allocations l WHERE l.allocation_set_id = a.id)
                         OR a.total_payment_cents IS DISTINCT FROM COALESCE(a.total_allocated_cents, 0)
                            + (SELECT COALESCE(sum(pc.original_amount_cents), 0) FROM public.prepay_credits pc
                                WHERE pc.allocation_set_id = a.id AND pc.source_type = 'overpayment')))
      THEN 'SOURCE_PAYMENT_TOTALS'
    WHEN EXISTS (SELECT 1 FROM public.prepay_applications pa
                   JOIN public.prepay_credits pc ON pc.id = pa.prepay_credit_id
                   JOIN public.invoices i ON i.id = pa.invoice_id
                  WHERE pc.customer_id = p_customer_id AND i.customer_id IS DISTINCT FROM p_customer_id)
      THEN 'APPLICATION_CUSTOMER_MISMATCH'
    WHEN EXISTS (SELECT 1 FROM public.prepay_credits pc
                  WHERE (pc.customer_id = p_customer_id OR pc.id = ANY (p_credit_ids))
                    AND pc.balance_cents IS DISTINCT FROM public._prepay_credit_computed_balance_20270225(pc.id))
      THEN 'CREDIT_DRIFT'
    WHEN (SELECT COALESCE(c.prepay_balance_cents, 0) FROM public.customers c WHERE c.id = p_customer_id)
         IS DISTINCT FROM (SELECT COALESCE(sum(pc.balance_cents), 0) FROM public.prepay_credits pc WHERE pc.customer_id = p_customer_id)
      THEN 'STORED_BALANCE_MISMATCH'
    WHEN (SELECT COALESCE(c.prepay_balance_cents, 0) FROM public.customers c WHERE c.id = p_customer_id) < p_customer_debit
      THEN 'STORED_BALANCE_LOW'
  END;
  IF v_code IS NOT NULL THEN
    RAISE EXCEPTION 'RECORD_NEEDS_HAND_CHECK: % (the records this touches do not agree; record it by hand)', v_code;
  END IF;
END;
$function$;
ALTER FUNCTION public._m9_check_records_20270225(uuid, uuid, uuid[], uuid[], uuid[], bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._m9_check_records_20270225(uuid, uuid, uuid[], uuid[], uuid[], bigint) FROM PUBLIC, anon, authenticated, service_role;

-- 2. The prepay credit balance counts reversal lines; the same trigger runs when a line is written ----------------
-- Audit operation types for the two new writers (the current list plus two).
ALTER TABLE public.financial_audit_log DROP CONSTRAINT financial_audit_log_operation_type_check;
ALTER TABLE public.financial_audit_log ADD CONSTRAINT financial_audit_log_operation_type_check
  CHECK ((operation_type = ANY (ARRAY['invoice_created'::text, 'invoice_posted'::text, 'invoice_unposted'::text, 'invoice_voided'::text, 'invoice_cancelled'::text, 'invoice_updated'::text, 'invoice_deleted'::text, 'invoice_marked_overdue'::text, 'payment_recorded'::text, 'payment_allocation'::text, 'payment_voided'::text, 'payment_allocated'::text, 'split_modified'::text, 'split_invoices_generated'::text, 'prepay_created'::text, 'prepay_applied'::text, 'prepay_credit_created'::text, 'prepay_batch_applied'::text, 'prepay_edited'::text, 'prepay_deleted'::text, 'prepay_reconciliation'::text, 'batch_prepay_apply'::text, 'write_off_recorded'::text, 'write_off_reversed'::text, 'write_off_applied'::text, 'finance_charge'::text, 'finance_charge_generated'::text, 'finance_charge_voided'::text, 'credit_memo_created'::text, 'credit_memo_applied'::text, 'credit_memo_unapplied'::text, 'return_created'::text, 'return_approved'::text, 'return_received'::text, 'return_credit_issued'::text, 'order_created'::text, 'order_updated'::text, 'order_voided'::text, 'order_cancelled'::text, 'order_restored'::text, 'delivery_created'::text, 'delivery_updated'::text, 'delivery_cancelled'::text, 'delivery_voided'::text, 'delivery_restored'::text, 'quote_converted'::text, 'blend_ticket_linked'::text, 'blend_ticket_unlinked'::text, 'commission_payment_created'::text, 'commission_payment_posted'::text, 'commission_payment_voided'::text, 'batch_post'::text, 'batch_void'::text, 'batch_payment'::text, 'period_reopened'::text, 'quote_status_reverted'::text, 'blend_ticket_approval_reversed'::text, 'cycle_count_completed'::text, 'vendor_bill_created'::text, 'vendor_bill_voided'::text, 'vendor_bill_updated'::text, 'vendor_payment_recorded'::text, 'vendor_payment_voided'::text, 'rup_sales_voided'::text, 'receiving_reversed'::text, 'payment_deleted'::text, 'allocation_set_deleted'::text, 'prepay_refunded_outside'::text, 'payment_returned'::text])));

CREATE OR REPLACE FUNCTION public._recompute_prepay_credit_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid;
BEGIN
  v_target := COALESCE(NEW.prepay_credit_id, OLD.prepay_credit_id);

  UPDATE prepay_credits
     SET balance_cents = original_amount_cents - COALESCE(
           (SELECT SUM(applied_amount_cents)
              FROM prepay_applications
             WHERE prepay_credit_id = v_target),
           0
         )
         -- M9: an application reversed by a returned check counts back; a refund or returned-check line takes off.
         + COALESCE(
           (SELECT SUM(amount_cents)
              FROM money_reversal_lines
             WHERE prepay_credit_id = v_target AND line_kind = 'prepay_application'),
           0
         )
         - COALESCE(
           (SELECT SUM(amount_cents)
              FROM money_reversal_lines
             WHERE prepay_credit_id = v_target AND line_kind = 'prepay_credit'),
           0
         ),
         updated_at = now()
   WHERE id = v_target;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public._void_payment_replay_impl_20261015(p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_set              record;
  v_alloc            record;
  v_actor            uuid;
  v_reversed_cents   bigint := 0;
  v_invoice_count    int    := 0;
  v_prepay_reversed  bigint := 0;
  v_old_balance      bigint;
  v_credit           record;
  v_app              record;
  v_apps_reversed_cents bigint := 0;
  v_existing         jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'void_payment';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_set FROM allocation_sets WHERE id = p_allocation_set_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation set not found: %', p_allocation_set_id; END IF;
  IF NOT v_set.is_active THEN RAISE EXCEPTION 'Payment already voided'; END IF;

  -- M9: a check recorded as returned (bounced) is not voided as well, and a payment whose prepay was partly refunded
  -- cannot be voided (its credit would go below $0). The credits are locked first, as a refund locks them.
  -- Only a payment is voided here (an order or invoice allocation set is not money received).
  IF v_set.entity_type IS DISTINCT FROM 'payment' THEN
    RAISE EXCEPTION 'NOT_A_PAYMENT: this allocation set is not a payment; only a payment can be voided';
  END IF;
  PERFORM 1 FROM prepay_credits
   WHERE allocation_set_id = p_allocation_set_id AND source_type = 'overpayment' ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM money_reversals WHERE kind = 'returned_check' AND allocation_set_id = p_allocation_set_id) THEN
    RAISE EXCEPTION 'PAYMENT_RETURNED: this check is recorded as returned (bounced); it cannot also be voided';
  END IF;
  IF EXISTS (SELECT 1 FROM money_reversal_lines l JOIN prepay_credits pc ON pc.id = l.prepay_credit_id
              WHERE pc.allocation_set_id = p_allocation_set_id AND pc.source_type = 'overpayment') THEN
    RAISE EXCEPTION 'PAYMENT_PREPAY_REFUNDED: part of this payment''s prepay was refunded to the customer; it cannot be voided';
  END IF;

  PERFORM check_period_open(COALESCE(v_set.payment_date, (now() AT TIME ZONE 'America/Chicago')::date));

  -- M9: every invoice this void touches (its payment lines and its prepay's applications), locked in one id-ordered
  -- pass, the order record_returned_check takes them in.
  PERFORM 1 FROM invoices
   WHERE id IN (SELECT ila.invoice_id FROM invoice_line_allocations ila
                 WHERE ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
                UNION
                SELECT pa.invoice_id FROM prepay_applications pa JOIN prepay_credits pc ON pc.id = pa.prepay_credit_id
                 WHERE pc.allocation_set_id = p_allocation_set_id AND pc.source_type = 'overpayment')
   ORDER BY id FOR UPDATE;

  FOR v_alloc IN
    SELECT ila.invoice_id, SUM(ila.amount_cents) AS total_amount
    FROM invoice_line_allocations ila
    WHERE ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
    GROUP BY ila.invoice_id
  LOOP
    UPDATE invoices
    SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        status = CASE
          WHEN status IN ('paid', 'posted') THEN
            -- CREDIT-APPLY: include credit_applied_cents in the settled recompute
            CASE WHEN (total_amount_cents - (GREATEST(paid_amount_cents - v_alloc.total_amount, 0) + prepay_applied_cents + write_off_cents + credit_applied_cents)) <= 0
                 THEN 'paid' ELSE 'posted' END
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;
    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count  := v_invoice_count + 1;
  END LOOP;

  FOR v_credit IN
    SELECT id, balance_cents
    FROM prepay_credits
    WHERE source_type = 'overpayment'
      AND customer_id = v_set.customer_id
      AND allocation_set_id = p_allocation_set_id
    FOR UPDATE
  LOOP
    FOR v_app IN
      SELECT pa.invoice_id, pa.applied_amount_cents
      FROM prepay_applications pa
      WHERE pa.prepay_credit_id = v_credit.id
    LOOP
      PERFORM 1 FROM invoices WHERE id = v_app.invoice_id FOR UPDATE;
      UPDATE invoices
      SET prepay_applied_cents = GREATEST(prepay_applied_cents - v_app.applied_amount_cents, 0),
          status = CASE
            WHEN status IN ('paid', 'posted') THEN
              CASE WHEN (total_amount_cents - (paid_amount_cents + GREATEST(prepay_applied_cents - v_app.applied_amount_cents, 0) + write_off_cents + credit_applied_cents)) <= 0
                   THEN 'paid' ELSE 'posted' END
            ELSE status
          END,
          updated_at = now()
      WHERE id = v_app.invoice_id;
      v_apps_reversed_cents := v_apps_reversed_cents + v_app.applied_amount_cents;
    END LOOP;

    DELETE FROM prepay_applications WHERE prepay_credit_id = v_credit.id;

    UPDATE prepay_credits
    SET balance_cents = 0, original_amount_cents = 0, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now()
    WHERE id = v_credit.id;
    v_prepay_reversed := v_prepay_reversed + v_credit.balance_cents;
  END LOOP;

  IF v_prepay_reversed > 0 THEN
    UPDATE customers SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0), updated_at = now() /* M9: the cached balance changed */ WHERE id = v_set.customer_id;
  END IF;

  UPDATE allocation_sets SET is_active = false, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now() WHERE id = p_allocation_set_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
  ) VALUES (
    'payment_voided', 'allocation_set', p_allocation_set_id, v_actor,
    jsonb_build_object('total_payment_cents', v_set.total_payment_cents, 'total_allocated_cents', v_set.total_allocated_cents, 'payment_method', v_set.payment_method, 'check_number', v_set.check_number, 'customer_id', v_set.customer_id),
    jsonb_build_object('reason', p_reason, 'invoices_reversed', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed, 'prepay_applications_reversed_cents', v_apps_reversed_cents),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'void_payment', to_jsonb(p_allocation_set_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'reversed_cents', v_reversed_cents, 'invoices_affected', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed, 'prepay_applications_reversed_cents', v_apps_reversed_cents);
END;
$function$;

CREATE OR REPLACE FUNCTION public._edit_prepay_credit_replay_impl_20261015(p_credit_id uuid, p_new_balance_cents bigint DEFAULT NULL::bigint, p_reference_number text DEFAULT NULL::text, p_bucket_label text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_delta       bigint;
  v_actor       uuid;
  v_actor_role  text;
  v_existing    jsonb;
  v_sum_applied bigint;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'edit_prepay_credit';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'credit_id', p_credit_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Codex P1 fix (2026-05-16): IS DISTINCT FROM treats NULL (deactivated user
  -- or missing profile row) as "not admin" and raises. Prior `!= 'admin'`
  -- evaluated to NULL when subquery was empty and silently allowed mutation.
  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor AND is_active = true;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Admin access required to edit prepay credits';
  END IF;

  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id; END IF;

  -- M9: a credit with a refund or a returned check recorded on it keeps its amounts (the edit would rewrite its
  -- original amount and erase them). Reference, label and notes can still change; the screen always sends the
  -- balance, so an unchanged balance is treated as no balance change.
  -- A Prepayment Manager check's amounts are locked too (its creation entry records them; a mistyped check is deleted
  -- whole and entered again). So is an overpayment's: its payment records it (an edit would break the payment's totals
  -- and stop the customer's refunds and returns); the payment is voided instead.
  IF public._prepay_credit_reversed_20270225(p_credit_id)
     OR (v_credit.source_type = 'check' AND v_credit.allocation_set_id IS NULL)
     OR v_credit.source_type = 'overpayment' THEN
    IF p_new_balance_cents IS NOT NULL AND p_new_balance_cents IS DISTINCT FROM v_credit.balance_cents THEN
      IF public._prepay_credit_reversed_20270225(p_credit_id) THEN
        RAISE EXCEPTION 'PREPAY_CREDIT_HAS_REVERSALS: this credit has a refund or returned check recorded; its balance cannot be edited';
      END IF;
      IF v_credit.source_type = 'overpayment' THEN
        RAISE EXCEPTION 'PREPAY_OVERPAYMENT_LOCKED: an overpayment''s amount comes from its payment and cannot be edited; void the payment to undo it';
      END IF;
      RAISE EXCEPTION 'PREPAY_CHECK_AMOUNT_LOCKED: a prepayment check''s amount cannot be edited; delete the whole check and enter it again';
    END IF;
    p_new_balance_cents := NULL;
  END IF;

  v_old_balance := v_credit.balance_cents;

  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications WHERE prepay_credit_id = p_credit_id;

  UPDATE prepay_credits SET
    balance_cents    = COALESCE(p_new_balance_cents, balance_cents),
    original_amount_cents = CASE
      WHEN p_new_balance_cents IS NOT NULL THEN p_new_balance_cents + v_sum_applied
      ELSE original_amount_cents
    END,
    reference_number = COALESCE(p_reference_number, reference_number),
    bucket_label     = COALESCE(p_bucket_label, bucket_label),
    notes            = COALESCE(p_notes, notes),
    updated_at       = now()
  WHERE id = p_credit_id;

  IF p_new_balance_cents IS NOT NULL AND p_new_balance_cents != v_old_balance THEN
    v_delta := p_new_balance_cents - v_old_balance;
    UPDATE customers
    SET prepay_balance_cents = GREATEST(prepay_balance_cents + v_delta, 0), updated_at = now() /* M9: the cached balance changed */
    WHERE id = v_credit.customer_id;
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_edited', 'prepay', p_credit_id, v_actor,
    jsonb_build_object(
      'balance_cents', v_old_balance,
      'original_amount_cents', v_credit.original_amount_cents,
      'sum_applied_cents', v_sum_applied,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object(
      'balance_cents', COALESCE(p_new_balance_cents, v_old_balance),
      'original_amount_cents', CASE
        WHEN p_new_balance_cents IS NOT NULL THEN p_new_balance_cents + v_sum_applied
        ELSE v_credit.original_amount_cents
      END,
      'reference_number', COALESCE(p_reference_number, v_credit.reference_number),
      'bucket_label', COALESCE(p_bucket_label, v_credit.bucket_label)
    ),
    COALESCE(p_new_balance_cents - v_old_balance, 0),
    'Edited prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text)
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'edit_prepay_credit', jsonb_build_object('credit_id', p_credit_id));
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'credit_id', p_credit_id,
    'old_balance_cents', v_old_balance,
    'new_balance_cents', COALESCE(p_new_balance_cents, v_old_balance)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._delete_prepay_credit_replay_impl_20261015(p_credit_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_actor       uuid;
  v_actor_role  text;
  v_existing    jsonb;
  v_sum_applied bigint;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'delete_prepay_credit';
    IF v_existing IS NOT NULL THEN
      -- M9: a whole-check delete saved its full receipt; a retry answers with it.
      IF v_existing ? 'credit_ids' THEN RETURN v_existing || jsonb_build_object('idempotent', true); END IF;
      RETURN jsonb_build_object('success', true, 'credit_id', p_credit_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Codex P1 fix (2026-05-16): null-safe admin check via IS DISTINCT FROM.
  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor AND is_active = true;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Admin access required to delete prepay credits';
  END IF;

  -- M9: the customer's credits first, in id order (a refund's order), so a whole-check delete cannot deadlock with it.
  PERFORM 1 FROM prepay_credits
   WHERE customer_id = (SELECT pc.customer_id FROM prepay_credits pc WHERE pc.id = p_credit_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id; END IF;

  -- M9: a credit with a refund or a returned check recorded on it cannot be deleted (the delete would rewrite its
  -- original amount and erase them).
  IF public._prepay_credit_reversed_20270225(p_credit_id) THEN
    RAISE EXCEPTION 'PREPAY_CREDIT_HAS_REVERSALS: this credit has a refund or returned check recorded; it cannot be deleted';
  END IF;
  -- M9: an overpayment comes from its payment (a delete would break the payment's totals and stop the customer's
  -- refunds and returns); the payment is voided instead, which removes its credit.
  IF v_credit.source_type = 'overpayment' THEN
    RAISE EXCEPTION 'PREPAY_OVERPAYMENT_LOCKED: an overpayment comes from its payment and cannot be deleted; void the payment to undo it';
  END IF;
  -- M9: a Prepayment Manager check is deleted whole: every bucket its creation entry lists, together, in one audit
  -- row, refused when any bucket was applied or has a refund / returned-check line. Its amounts go to $0 (the entry
  -- stays; the gate skips an entry deleted whole).
  IF v_credit.source_type = 'check' AND v_credit.allocation_set_id IS NULL THEN
    DECLARE
      v_ids    uuid[];
      v_total  bigint;
      v_before jsonb;
      v_result jsonb;
    BEGIN
      IF (SELECT count(*) FROM financial_audit_log fal
           WHERE fal.operation_type = 'prepay_credit_created' AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array'
             AND fal.new_values -> 'credit_ids' @> jsonb_build_array(p_credit_id::text)) <> 1 THEN
        RAISE EXCEPTION 'RECORD_NEEDS_HAND_CHECK: CHECK_BUCKETS (this prepayment check''s entry cannot be identified; delete it by hand)';
      END IF;
      SELECT array_agg(DISTINCT b.id::uuid) INTO v_ids
        FROM financial_audit_log fal
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array'
                                                          THEN fal.new_values -> 'credit_ids' END) AS b(id)
       WHERE fal.operation_type = 'prepay_credit_created' AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array'
         AND fal.new_values -> 'credit_ids' @> jsonb_build_array(p_credit_id::text);
      PERFORM 1 FROM prepay_credits WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;
      IF (SELECT count(*) FROM prepay_credits WHERE id = ANY (v_ids) AND customer_id = v_credit.customer_id
             AND source_type = 'check' AND allocation_set_id IS NULL) <> cardinality(v_ids) THEN
        RAISE EXCEPTION 'RECORD_NEEDS_HAND_CHECK: CHECK_BUCKETS (this prepayment check''s buckets do not agree; delete it by hand)';
      END IF;
      IF EXISTS (SELECT 1 FROM prepay_applications WHERE prepay_credit_id = ANY (v_ids)) THEN
        RAISE EXCEPTION 'PREPAY_CHECK_APPLIED: part of this check was applied to an invoice; it cannot be deleted';
      END IF;
      IF EXISTS (SELECT 1 FROM unnest(v_ids) c(id) WHERE public._prepay_credit_reversed_20270225(c.id)) THEN
        RAISE EXCEPTION 'PREPAY_CREDIT_HAS_REVERSALS: this check has a refund or returned check recorded; it cannot be deleted';
      END IF;
      IF EXISTS (SELECT 1 FROM prepay_credits WHERE id = ANY (v_ids) AND balance_cents IS DISTINCT FROM original_amount_cents) THEN
        RAISE EXCEPTION 'RECORD_NEEDS_HAND_CHECK: CREDIT_DRIFT (a bucket of this check does not match its amount; delete it by hand)';
      END IF;
      SELECT COALESCE(sum(balance_cents), 0) INTO v_total FROM prepay_credits WHERE id = ANY (v_ids);
      IF v_total = 0 THEN RAISE EXCEPTION 'Prepay credit already has zero balance'; END IF;
      -- The month the check was received in must be open (its Month-End receipt would move), under the month lock;
      -- then the customer (lock order: credits, month, customer, as a refund).
      PERFORM check_period_open((v_credit.created_at AT TIME ZONE 'America/Chicago')::date);
      PERFORM 1 FROM customers WHERE id = v_credit.customer_id FOR UPDATE;
      -- The entry must be one whole receipt of this customer, by the refund / return gate's own rules.
      PERFORM public._m9_check_records_20270225(v_credit.customer_id, NULL, v_ids, v_ids, ARRAY[]::uuid[], 0);
      -- The before-image, read before anything is zeroed.
      SELECT jsonb_agg(jsonb_build_object('id', id, 'original_amount_cents', original_amount_cents,
                                          'balance_cents', balance_cents, 'bucket_label', bucket_label) ORDER BY id)
        INTO v_before FROM prepay_credits WHERE id = ANY (v_ids);
      IF (SELECT COALESCE(prepay_balance_cents, 0) FROM customers WHERE id = v_credit.customer_id) < v_total THEN
        RAISE EXCEPTION 'RECORD_NEEDS_HAND_CHECK: STORED_BALANCE_LOW (the customer''s stored prepay is below this check; delete it by hand)';
      END IF;
      UPDATE prepay_credits
         SET balance_cents = 0, original_amount_cents = 0,
             notes = COALESCE(notes, '') || ' [DELETED: ' || p_reason || ']', updated_at = now()
       WHERE id = ANY (v_ids);
      UPDATE customers SET prepay_balance_cents = prepay_balance_cents - v_total, updated_at = now()
       WHERE id = v_credit.customer_id;
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
      ) VALUES (
        'prepay_deleted', 'prepay', p_credit_id, v_actor,
        jsonb_build_object('total_cents', v_total, 'reference_number', v_credit.source_reference, 'buckets', v_before),
        jsonb_build_object('whole_check', true, 'credit_ids', to_jsonb(v_ids), 'balance_cents', 0, 'original_amount_cents', 0,
                           'reason', p_reason),
        -1 * v_total,
        'Deleted prepayment check ' || COALESCE(v_credit.source_reference, v_credit.id::text) || ' (' || cardinality(v_ids)
          || ' bucket(s)) — ' || p_reason
      );
      v_result := jsonb_build_object('success', true, 'credit_id', p_credit_id, 'credit_ids', to_jsonb(v_ids),
                                     'deleted_balance_cents', v_total);
      IF p_idempotency_key IS NOT NULL THEN
        -- The whole receipt is kept, so a retry with the same key answers exactly as this call did.
        INSERT INTO idempotency_keys (idempotency_key, operation, result)
        VALUES (p_idempotency_key, 'delete_prepay_credit', v_result);
      END IF;
      RETURN v_result;
    END;
  END IF;

  v_old_balance := v_credit.balance_cents;
  IF v_old_balance = 0 THEN RAISE EXCEPTION 'Prepay credit already has zero balance'; END IF;

  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications WHERE prepay_credit_id = p_credit_id;

  UPDATE prepay_credits
  SET balance_cents         = 0,
      original_amount_cents = v_sum_applied,
      notes                 = COALESCE(notes, '') || ' [DELETED: ' || p_reason || ']',
      updated_at            = now()
  WHERE id = p_credit_id;

  UPDATE customers
  SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_old_balance, 0), updated_at = now() /* M9: the cached balance changed */
  WHERE id = v_credit.customer_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_deleted', 'prepay', p_credit_id, v_actor,
    jsonb_build_object(
      'balance_cents', v_old_balance,
      'original_amount_cents', v_credit.original_amount_cents,
      'sum_applied_cents', v_sum_applied,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object('balance_cents', 0, 'original_amount_cents', v_sum_applied, 'reason', p_reason),
    -1 * v_old_balance,
    'Deleted prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'delete_prepay_credit', jsonb_build_object('credit_id', p_credit_id));
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'credit_id', p_credit_id, 'deleted_balance_cents', v_old_balance
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._month_payments_received_20270208(p_start date, p_end date)
 RETURNS TABLE(payment_count bigint, total_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH received AS (
    -- Record Payment: the whole check, including a part kept as prepay; a voided payment is inactive.
    SELECT COALESCE(a.total_payment_cents, a.total_allocated_cents, 0)::numeric AS cents, false AS m9_return
      FROM public.allocation_sets a
     WHERE a.entity_type = 'payment'
       AND a.is_active
       AND a.payment_date BETWEEN p_start AND p_end
    UNION ALL
    -- Prepayment Manager checks at their current amount; the bucket splits of one check (one call: one created_at and
    -- one source_reference, never edited) are one payment.
    SELECT sum(pc.original_amount_cents)::numeric, false AS m9_return
      FROM public.prepay_credits pc
     WHERE pc.source_type = 'check'
       AND pc.allocation_set_id IS NULL
       AND pc.original_amount_cents > 0
       AND (pc.created_at AT TIME ZONE 'America/Chicago')::date BETWEEN p_start AND p_end
     GROUP BY pc.customer_id, pc.created_at, pc.source_reference,
              -- M9: one payment per Prepayment Manager entry (its audit row), so two checks entered together count twice
              (SELECT fal.id FROM public.financial_audit_log fal
                WHERE fal.operation_type = 'prepay_credit_created' AND fal.new_values -> 'credit_ids' ? pc.id::text LIMIT 1)
    UNION ALL
    -- Legacy payments table (none live), not deleted; dollars kept exact and rounded once on the total.
    SELECT p.amount * 100, false AS m9_return
      FROM public.payments p
     WHERE p.deleted_at IS NULL
       AND p.payment_date BETWEEN p_start AND p_end
    UNION ALL
    -- M9: a returned (bounced) check comes off the month it was recorded in (always an open month), never the month
    -- it was received in; it is not a payment, so it is not counted.
    SELECT -mr.amount_cents::numeric, true
      FROM public.money_reversals mr
     WHERE mr.kind = 'returned_check'
       AND mr.entry_date BETWEEN p_start AND p_end
  )
  SELECT count(*) FILTER (WHERE NOT m9_return)::bigint, round(COALESCE(sum(cents), 0))::bigint FROM received;
$function$;

CREATE OR REPLACE FUNCTION public._month_close_figures_20270208(p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_payments record;
BEGIN
  SELECT * INTO v_payments FROM public._month_payments_received_20270208(p_period_start, p_period_end);
  RETURN jsonb_build_object(
    'period_start', p_period_start,
    'period_end', p_period_end,
    'invoices', jsonb_build_object(
      'posted_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL),
      'total_amount_cents', COALESCE((SELECT sum(total_amount_cents - public._invoice_sales_tax_cents_20270109(id)) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL), 0),
      'total_cost_cents', COALESCE((SELECT sum(CASE
        WHEN inv.invoice_type = 'credit_memo'
         AND EXISTS (SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = inv.id)
          THEN inv.total_cost_cents
        -- (KI-126) a fee line's cost is already extended by acres
        ELSE (SELECT COALESCE(sum(CASE WHEN ii.is_application_fee THEN ii.cost_cents
                                       ELSE ROUND(ii.cost_cents * ii.quantity)::bigint END), 0)
              FROM public.invoice_items ii WHERE ii.invoice_id = inv.id)
      END) FROM public.invoices inv WHERE inv.invoice_date BETWEEN p_period_start AND p_period_end AND inv.status IN ('posted', 'overdue', 'paid') AND inv.deleted_at IS NULL), 0),
      'draft_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('draft', 'unposted') AND deleted_at IS NULL),
      'voided_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'voided' AND deleted_at IS NULL)
    ),
    -- (KI-129) money received: Record Payment, prepayment checks and live legacy rows
    'payments', jsonb_build_object('count', v_payments.payment_count, 'total_cents', v_payments.total_cents),
    -- M9: refunds paid outside CRX and returned checks recorded in the dates (returned checks are already netted out
    -- of payments received above).
    'refunds', (SELECT jsonb_build_object('count', count(*), 'total_cents', COALESCE(sum(mr.amount_cents), 0))
                  FROM public.money_reversals mr
                 WHERE mr.kind = 'outside_refund' AND mr.entry_date BETWEEN p_period_start AND p_period_end),
    'returned_checks', (SELECT jsonb_build_object('count', count(*), 'total_cents', COALESCE(sum(mr.amount_cents), 0))
                  FROM public.money_reversals mr
                 WHERE mr.kind = 'returned_check' AND mr.entry_date BETWEEN p_period_start AND p_period_end),
    'orders', jsonb_build_object('count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 'total_cents', COALESCE((SELECT sum((total_price * 100)::bigint) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 0)),
    'deliveries', jsonb_build_object('count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status NOT IN ('cancelled', 'voided') AND deleted_at IS NULL), 'completed_count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status = 'completed' AND deleted_at IS NULL)),
    'applications', jsonb_build_object('count', (SELECT count(*) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 'total_acres', COALESCE((SELECT sum(total_acres) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 0)),
    -- (KI-125) commission matched to the share of its sale billed in this period
    'commissions', (SELECT jsonb_build_object('earned_cents', r.earned_cents, 'paid_count', r.paid_count, 'basis', 'billed_share')
                       FROM public._report_commission_cents_20270203(p_period_start, p_period_end) r),
    'close_receipt', jsonb_build_object(
      'invoices_posted', (
        SELECT count(*) FROM public.invoices
         WHERE invoice_date BETWEEN p_period_start AND p_period_end
           AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL),
      'total_invoiced_cents', COALESCE((
        SELECT sum(total_amount_cents) FROM public.invoices
         WHERE invoice_date BETWEEN p_period_start AND p_period_end
           AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL), 0),
      'payments_received_cents', v_payments.total_cents,
      'refunds_paid_cents', COALESCE((SELECT sum(mr.amount_cents) FROM public.money_reversals mr
         WHERE mr.kind = 'outside_refund' AND mr.entry_date BETWEEN p_period_start AND p_period_end), 0),
      'returned_checks_cents', COALESCE((SELECT sum(mr.amount_cents) FROM public.money_reversals mr
         WHERE mr.kind = 'returned_check' AND mr.entry_date BETWEEN p_period_start AND p_period_end), 0),
      'orders_count', (
        SELECT count(*) FROM public.orders
         WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL),
      'deliveries_count', (
        SELECT count(*) FROM public.deliveries
         WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.statement_customer_has_later_balance_activity(p_customer_id uuid, p_as_of_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.invoices i
      JOIN public.invoice_line_allocations ila ON ila.invoice_id = i.id
      JOIN public.allocation_sets aset ON aset.id = ila.allocation_set_id
      WHERE i.customer_id = p_customer_id
        AND i.invoice_date <= p_as_of_date
        AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        AND aset.entity_type = 'payment'
        AND (
          (aset.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
          OR (aset.updated_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
          OR aset.payment_date > p_as_of_date
          OR EXISTS (
            SELECT 1
            FROM public.financial_audit_log fal
            WHERE fal.operation_type = 'payment_voided'
              AND fal.entity_type = 'allocation_set'
              AND fal.entity_id = aset.id
              AND (fal.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
          )
        )
    )
    OR EXISTS (
      -- prepay_applications are immutable while present, but a payment void
      -- deletes them. The parent credit's update timestamp is therefore the
      -- durable customer-level tripwire for both a later application and its
      -- later removal.
      SELECT 1
      FROM public.prepay_credits pc
      WHERE pc.customer_id = p_customer_id
        AND (
          (pc.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
          OR (pc.updated_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
        )
        AND EXISTS (
          SELECT 1
          FROM public.invoices i
          WHERE i.customer_id = p_customer_id
            AND i.invoice_date <= p_as_of_date
            AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.invoices i
      JOIN public.prepay_applications pa ON pa.invoice_id = i.id
      WHERE i.customer_id = p_customer_id
        AND i.invoice_date <= p_as_of_date
        AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        AND (pa.applied_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
    )
    OR EXISTS (
      SELECT 1
      FROM public.invoices i
      JOIN public.write_offs wo ON wo.invoice_id = i.id
      WHERE i.customer_id = p_customer_id
        AND i.invoice_date <= p_as_of_date
        AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        AND (
          (wo.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
          OR (wo.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
        )
    )
    OR EXISTS (
      -- A payment void can reverse cash allocations and can delete affected
      -- prepay_applications. Its audit row is durable, but it does not retain
      -- every target invoice id, so a customer-wide rejection is the only
      -- truthful historical behavior after such a reversal.
      SELECT 1
      FROM public.financial_audit_log fal
      JOIN public.allocation_sets aset ON aset.id = fal.entity_id
      WHERE fal.operation_type = 'payment_voided'
        AND fal.entity_type = 'allocation_set'
        AND aset.entity_type = 'payment'
        AND aset.customer_id = p_customer_id
        AND (fal.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
        AND EXISTS (
          SELECT 1
          FROM public.invoices i
          WHERE i.customer_id = p_customer_id
            AND i.invoice_date <= p_as_of_date
            AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        )
    )
    OR EXISTS (
      -- M9: a returned (bounced) check recorded after the cutoff changed the invoices it paid; the balance of those
      -- invoices as of the cutoff cannot be rebuilt from today's rows.
      SELECT 1
      FROM public.money_reversals mr
      JOIN public.money_reversal_lines l ON l.reversal_id = mr.id
      JOIN public.invoices i ON i.id = l.invoice_id
      WHERE mr.customer_id = p_customer_id
        AND mr.kind = 'returned_check'
        AND (mr.entry_date > p_as_of_date OR (mr.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
        AND i.invoice_date <= p_as_of_date
        AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
    );
$function$;

CREATE OR REPLACE FUNCTION public._get_customer_statement_scoped_impl(p_customer_id uuid, p_start_date date DEFAULT (((now() AT TIME ZONE 'America/Chicago'::text))::date - '90 days'::interval)::date, p_end_date date DEFAULT ((now() AT TIME ZONE 'America/Chicago'::text))::date)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, amount_cents bigint, running_balance bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = auth.uid()
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  IF p_start_date > p_end_date THEN
    RAISE EXCEPTION 'INVALID_STATEMENT_DATE_RANGE';
  END IF;

  RETURN QUERY
  WITH all_txns AS (
    SELECT
      i.invoice_date::date AS txn_date,
      CASE WHEN i.invoice_type = 'credit_memo' THEN 'credit' ELSE 'invoice' END AS txn_type,
      i.invoice_number AS ref_num,
      CASE WHEN i.invoice_type = 'credit_memo'
           THEN 'Credit Memo ' || i.invoice_number
           ELSE 'Invoice ' || i.invoice_number END AS descr,
      i.total_amount_cents AS amt,
      10 AS source_rank,
      i.id AS sort_id
    FROM public.invoices i
    WHERE i.customer_id = p_customer_id
      AND i.status IN ('posted', 'paid', 'overdue')
      AND i.deleted_at IS NULL

    UNION ALL

    SELECT
      p.payment_date::date,
      'payment',
      COALESCE(p.reference_number, ''),
      'Payment - ' || p.payment_method,
      -(p.amount * 100)::bigint,
      20,
      p.id
    FROM public.payments p
    LEFT JOIN public.orders o ON o.id = p.order_id
    WHERE COALESCE(o.customer_id, p.customer_id) = p_customer_id
      AND p.deleted_at IS NULL

    UNION ALL

    SELECT
      COALESCE(a.payment_date, (a.created_at AT TIME ZONE 'America/Chicago')::date),
      'payment',
      COALESCE(a.reference_number, a.check_number, ''),
      'Payment - ' || COALESCE(a.payment_method, 'other'),
      -COALESCE(a.total_allocated_cents, 0),
      21,
      a.id
    FROM public.allocation_sets a
    WHERE a.entity_type = 'payment'
      AND a.is_active = true
      AND a.customer_id = p_customer_id
      AND COALESCE(a.total_allocated_cents, 0) > 0

    UNION ALL

    SELECT
      (pa.applied_at AT TIME ZONE 'America/Chicago')::date,
      'prepay',
      '',
      'Prepay Applied',
      -pa.applied_amount_cents,
      30,
      pa.id
    FROM public.prepay_applications pa
    INNER JOIN public.prepay_credits pc ON pc.id = pa.prepay_credit_id
    WHERE pc.customer_id = p_customer_id

    UNION ALL

    SELECT
      (wo.created_at AT TIME ZONE 'America/Chicago')::date,
      'write_off',
      i.invoice_number,
      'Write-off - ' || wo.reason,
      -wo.amount_cents,
      40,
      wo.id
    FROM public.write_offs wo
    INNER JOIN public.invoices i ON i.id = wo.invoice_id
    WHERE wo.customer_id = p_customer_id
      AND wo.reversed_at IS NULL

    UNION ALL

    -- M9: a returned (bounced) check puts back what it paid (cash and prepay) on the day it was recorded; the
    -- original payment and prepay rows stay.
    SELECT
      mr.entry_date,
      'returned_check',
      COALESCE(mr.reference, ''),
      'Returned check ' || COALESCE(mr.reference, ''),
      COALESCE((SELECT sum(l.amount_cents) FROM public.money_reversal_lines l
                 WHERE l.reversal_id = mr.id AND l.line_kind IN ('invoice_payment', 'prepay_application')), 0)::bigint,
      45,
      mr.id
    FROM public.money_reversals mr
    WHERE mr.customer_id = p_customer_id
      AND mr.kind = 'returned_check'

    UNION ALL

    -- M9: a refund paid outside CRX comes out of prepay, not out of what is owed: shown, $0.00 effect.
    SELECT
      mr.entry_date,
      'refund',
      COALESCE(mr.reference, ''),
      'Refund paid (outside CRX) ' || COALESCE(mr.reference, ''),
      0::bigint,
      46,
      mr.id
    FROM public.money_reversals mr
    WHERE mr.customer_id = p_customer_id
      AND mr.kind = 'outside_refund'
  ),
  opening AS (
    SELECT COALESCE(SUM(a.amt), 0)::bigint AS amt
      FROM all_txns a
     WHERE a.txn_date < p_start_date
  ),
  statement_txns AS (
    SELECT
      p_start_date AS txn_date,
      'opening_balance'::text AS txn_type,
      ''::text AS ref_num,
      'Opening Balance'::text AS descr,
      o.amt,
      0 AS source_rank,
      '00000000-0000-0000-0000-000000000000'::uuid AS sort_id
    FROM opening o
    WHERE o.amt <> 0

    UNION ALL

    SELECT a.txn_date, a.txn_type, a.ref_num, a.descr, a.amt,
           a.source_rank, a.sort_id
      FROM all_txns a
     WHERE a.txn_date BETWEEN p_start_date AND p_end_date
  )
  SELECT
    t.txn_date,
    t.txn_type,
    t.ref_num,
    t.descr,
    t.amt,
    SUM(t.amt) OVER (
      ORDER BY t.txn_date, t.source_rank, t.sort_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )::bigint
  FROM statement_txns t
  ORDER BY t.txn_date, t.source_rank, t.sort_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_invoice(p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_return_credit boolean;
BEGIN
  -- M9: an invoice a returned (bounced) check paid keeps that history (the payment's allocation and the reversed
  -- prepay application rows stay), so it cannot be voided; say so before the void reaches them.
  -- Only for a caller the void itself would authorize (an active admin); anyone else gets the void's own refusal.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin')
     AND EXISTS (SELECT 1 FROM public.money_reversal_lines l
              WHERE l.invoice_id = p_invoice_id AND l.line_kind IN ('invoice_payment', 'prepay_application')) THEN
    RAISE EXCEPTION 'INVOICE_HAS_RETURNED_PAYMENT: a returned (bounced) check paid this invoice; it stays on the customer''s history and the invoice cannot be voided';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public.returns r
    WHERE r.credit_invoice_id = p_invoice_id
  ) INTO v_is_return_credit;

  IF v_is_return_credit THEN
    PERFORM set_config('app.crx_return_credit_void', '1', true);
  END IF;

  BEGIN
    PERFORM public._void_invoice_return_credit_guard_impl_20260826(
      p_invoice_id,
      p_void_reason,
      p_idempotency_key
    );
  EXCEPTION WHEN OTHERS THEN
    IF v_is_return_credit THEN
      PERFORM set_config('app.crx_return_credit_void', '0', true);
    END IF;
    RAISE;
  END;

  IF v_is_return_credit THEN
    PERFORM set_config('app.crx_return_credit_void', '0', true);
    IF EXISTS (
      SELECT 1
      FROM public.returns r
      WHERE r.credit_invoice_id = p_invoice_id
    ) THEN
      RAISE EXCEPTION 'RETURN_CREDIT_VOID_RELEASE_FAILED';
    END IF;
  END IF;
END;
$function$;

CREATE TRIGGER trg_recompute_prepay_credits_m9 AFTER INSERT ON public.money_reversal_lines
  REFERENCING NEW TABLE AS m9_new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public._recompute_prepay_credits_from_lines_20270225();

-- A trigger function needs no EXECUTE grant to fire; no API role may call this SECURITY DEFINER one directly.
REVOKE EXECUTE ON FUNCTION public._recompute_prepay_credit_balance() FROM PUBLIC, anon, authenticated;

-- 3. Refund paid outside CRX ---------------------------------------------------------------------------------------
CREATE FUNCTION public.record_outside_refund(
  p_customer_id uuid,
  p_amount_cents bigint,
  p_paid_on date,
  p_reference text,
  p_reason text,
  p_credit_id uuid DEFAULT NULL::uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_allow_duplicate_reference boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
  v_today       date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_reference   text := NULLIF(regexp_replace(p_reference, '^\s+|\s+$', '', 'g'), '');
  v_reason      text := NULLIF(regexp_replace(p_reason, '^\s+|\s+$', '', 'g'), '');
  v_fingerprint text;
  v_replay      jsonb;
  v_ids         uuid[] := ARRAY[]::uuid[];
  v_draw_ids    uuid[] := ARRAY[]::uuid[];
  v_draw_cents  bigint[] := ARRAY[]::bigint[];
  v_available   bigint := 0;
  v_farm        text;
  v_left        bigint;
  v_take        bigint;
  v_credit      record;
  v_i           integer;
  v_reversal_id uuid;
  v_lines       jsonb := '[]'::jsonb;
  v_result      jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- FOR SHARE holds off a deactivation or demotion until this call commits.
  PERFORM 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE: only an active admin can record a refund'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '\S' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: record_outside_refund requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'customer_id', p_customer_id, 'amount_cents', p_amount_cents, 'paid_on', p_paid_on,
    'reference', v_reference, 'reason', v_reason, 'credit_id', p_credit_id,
    'allow_duplicate_reference', COALESCE(p_allow_duplicate_reference, false))::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'record_outside_refund', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;

  IF p_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_REQUIRED: choose the customer'; END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT: the refund must be more than $0.00'; END IF;
  -- The entry is dated today (an open month), like a returned check; p_paid_on is the day the check was written
  -- outside CRX, kept for the record.
  IF NOT isfinite(p_paid_on) THEN RAISE EXCEPTION 'BAD_VALUE: the paid-on date must be a real date'; END IF;
  IF p_paid_on > v_today THEN
    RAISE EXCEPTION 'PAID_ON_IN_FUTURE: paid-on date % is after today (%) in Central time', p_paid_on, v_today;
  END IF;
  IF v_reference IS NULL THEN RAISE EXCEPTION 'REFERENCE_REQUIRED: enter how it was paid (for example "QuickBooks check 1042")'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'REASON_REQUIRED: enter why the refund was paid'; END IF;
  IF length(v_reference) > 200 OR length(v_reason) > 2000 THEN
    RAISE EXCEPTION 'BAD_VALUE: reference at most 200 characters, reason at most 2000';
  END IF;
  IF p_credit_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.prepay_credits WHERE id = p_credit_id AND customer_id = p_customer_id) THEN
    RAISE EXCEPTION 'CREDIT_NOT_FOUND: that prepay credit is not this customer''s';
  END IF;

  -- Lock order (void_payment's): credits, then the month, then the customer. EVERY credit of the customer is locked,
  -- in id order, in one statement (Sol r8): an edit or delete of a sibling bucket of the drawn one locks its credit
  -- before its guard, so it waits here and then sees this refund; an apply or void that would restore an older credit
  -- waits too, so the set drawn below is the set counted.
  FOR v_credit IN
    SELECT id, balance_cents FROM public.prepay_credits
     WHERE customer_id = p_customer_id
     ORDER BY id FOR UPDATE
  LOOP
    IF v_credit.balance_cents > 0 AND (p_credit_id IS NULL OR v_credit.id = p_credit_id) THEN
      v_ids := v_ids || v_credit.id;
      v_available := v_available + v_credit.balance_cents;
    END IF;
  END LOOP;
  PERFORM public.check_period_open(v_today);
  SELECT farm_name INTO v_farm FROM public.customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: %', p_customer_id; END IF;
  IF p_amount_cents > v_available THEN
    RAISE EXCEPTION 'PREPAY_REFUND_EXCEEDS_AVAILABLE: refund $% is more than the $% prepay %',
      round(p_amount_cents / 100.0, 2), round(v_available / 100.0, 2),
      CASE WHEN p_credit_id IS NOT NULL THEN 'on that credit' ELSE 'available' END;
  END IF;
  -- One outside check is one refund: the same reference again (any amount) is refused unless the admin confirms.
  IF NOT COALESCE(p_allow_duplicate_reference, false) AND EXISTS (
       SELECT 1 FROM public.money_reversals
        WHERE kind = 'outside_refund' AND customer_id = p_customer_id AND lower(reference) = lower(v_reference)) THEN
    RAISE EXCEPTION 'REFUND_DUPLICATE_REFERENCE: a refund with reference "%" is already recorded for this customer; confirm it is a second payment to record it',
      v_reference;
  END IF;
  -- The draw: oldest credit first (or only the one picked).
  v_left := p_amount_cents;
  FOR v_credit IN
    SELECT id, balance_cents FROM public.prepay_credits WHERE id = ANY (v_ids) ORDER BY created_at, id
  LOOP
    EXIT WHEN v_left = 0;
    v_take := LEAST(v_credit.balance_cents, v_left);
    v_draw_ids := v_draw_ids || v_credit.id;
    v_draw_cents := v_draw_cents || v_take;
    v_left := v_left - v_take;
  END LOOP;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'REFUND_DRAW_INCOMPLETE: $% of the refund could not be drawn from the credits; nothing was saved',
      round(v_left / 100.0, 2);
  END IF;
  -- The integrity gate, on exactly the credits drawn and the customer's stored balance.
  PERFORM public._m9_check_records_20270225(p_customer_id, NULL, v_draw_ids, NULL, ARRAY[]::uuid[], p_amount_cents);

  INSERT INTO public.money_reversals (kind, customer_id, entry_date, occurred_on, amount_cents, reference, reason, performed_by)
  VALUES ('outside_refund', p_customer_id, v_today, p_paid_on, p_amount_cents, v_reference, v_reason, v_actor)
  RETURNING id INTO v_reversal_id;
  -- One line per credit drawn; the line trigger lowers each credit.
  INSERT INTO public.money_reversal_lines (reversal_id, line_kind, prepay_credit_id, amount_cents)
  SELECT v_reversal_id, 'prepay_credit', d.id, d.cents FROM unnest(v_draw_ids, v_draw_cents) AS d(id, cents);
  FOR v_i IN 1 .. cardinality(v_draw_ids) LOOP
    v_lines := v_lines || jsonb_build_object('prepay_credit_id', v_draw_ids[v_i], 'amount_cents', v_draw_cents[v_i]);
  END LOOP;

  UPDATE public.customers
     SET prepay_balance_cents = prepay_balance_cents - p_amount_cents, updated_at = now()
   WHERE id = p_customer_id;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'prepay_refunded_outside', 'customer', p_customer_id, v_actor, 'admin',
    jsonb_build_object('reversal_id', v_reversal_id, 'entry_date', v_today, 'paid_on', p_paid_on, 'reference', v_reference,
                       'reason', v_reason, 'credits', v_lines),
    -p_amount_cents,
    'Refund paid outside CRX $' || round(p_amount_cents / 100.0, 2) || ' to ' || COALESCE(v_farm, 'customer') || ' (' || v_reference || ')');
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('prepay_refunded_outside', 'Refund paid (outside CRX) $' || round(p_amount_cents / 100.0, 2) || ' - ' || v_reference,
          v_actor, 'money_reversal', v_reversal_id, p_customer_id);

  v_result := jsonb_build_object(
    'reversal_id', v_reversal_id, 'kind', 'outside_refund', 'customer_id', p_customer_id, 'entry_date', v_today,
    'paid_on', p_paid_on, 'amount_cents', p_amount_cents, 'credits', v_lines,
    'prepay_balance_debited_cents', p_amount_cents,
    'prepay_balance_cents', (SELECT prepay_balance_cents FROM public.customers WHERE id = p_customer_id));
  PERFORM public.save_idempotency(p_idempotency_key, 'record_outside_refund', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'record_outside_refund', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.record_outside_refund(uuid, bigint, date, text, text, uuid, uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_outside_refund(uuid, bigint, date, text, text, uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_outside_refund(uuid, bigint, date, text, text, uuid, uuid, text, boolean) TO authenticated, service_role;

-- 4. Returned (bounced) check: a Record Payment by check, or a Prepayment Manager check (all its buckets) -----------
CREATE FUNCTION public.record_returned_check(
  p_allocation_set_id uuid,
  p_returned_date date,
  p_reason text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_credit_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor        uuid := auth.uid();
  v_today        date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_reason       text := NULLIF(regexp_replace(p_reason, '^\s+|\s+$', '', 'g'), '');
  v_fingerprint  text;
  v_replay       jsonb;
  v_set          record;
  v_customer     uuid;
  v_amount       bigint;
  v_reference    text;
  v_credit_ids   uuid[];
  v_bucket_ids   uuid[];
  v_refunded     bigint;
  v_before       bigint;
  v_reversal_id  uuid;
  v_invoice_ids  uuid[];
  v_inv          record;
  v_balance      bigint;
  v_left         bigint;
  v_invoice_cents bigint := 0;
  v_app_cents    bigint := 0;
  v_removed      bigint := 0;
  v_reopened     integer := 0;
  v_credit_id    uuid;
  v_result       jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE: only an active admin can record a returned check'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '\S' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: record_returned_check requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'allocation_set_id', p_allocation_set_id, 'credit_id', p_credit_id,
    'returned_date', p_returned_date, 'reason', v_reason)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'record_returned_check', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;

  IF num_nonnulls(p_allocation_set_id, p_credit_id) <> 1 THEN
    RAISE EXCEPTION 'RETURNED_CHECK_SOURCE: give the payment or the prepayment check, exactly one';
  END IF;
  -- p_returned_date is the day the bank returned the check (it may fall in a closed month); the entry itself is dated
  -- today, which is always in an open month (decision 18).
  IF p_returned_date IS NULL THEN RAISE EXCEPTION 'RETURNED_DATE_REQUIRED: enter the date the bank returned the check'; END IF;
  IF NOT isfinite(p_returned_date) THEN RAISE EXCEPTION 'BAD_VALUE: the returned date must be a real date'; END IF;
  IF p_returned_date > v_today THEN
    RAISE EXCEPTION 'RETURNED_DATE_IN_FUTURE: returned date % is after today (%) in Central time', p_returned_date, v_today;
  END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'REASON_REQUIRED: enter why the check came back'; END IF;
  IF length(v_reason) > 2000 THEN RAISE EXCEPTION 'BAD_VALUE: reason at most 2000 characters'; END IF;

  -- 1. Lock order (void_payment's): the payment, its credits, the month, the invoices (one sorted pass), the customer.
  --    The payment and the credits are locked but never written.
  IF p_allocation_set_id IS NOT NULL THEN
    SELECT * INTO v_set FROM public.allocation_sets WHERE id = p_allocation_set_id FOR UPDATE;
    IF NOT FOUND OR v_set.entity_type IS DISTINCT FROM 'payment' THEN
      RAISE EXCEPTION 'PAYMENT_NOT_FOUND: %', p_allocation_set_id;
    END IF;
    IF NOT v_set.is_active THEN RAISE EXCEPTION 'PAYMENT_VOIDED: this payment was voided; nothing to return'; END IF;
    IF v_set.payment_method IS DISTINCT FROM 'check' THEN
      RAISE EXCEPTION 'NOT_A_CHECK_PAYMENT: only a payment made by check can be returned (this one is %)',
        COALESCE(v_set.payment_method, 'not recorded');
    END IF;
    -- An undated payment was never counted as a receipt by Month-End, so it cannot be netted out of one.
    IF v_set.payment_date IS NULL OR NOT isfinite(v_set.payment_date) THEN
      RAISE EXCEPTION 'PAYMENT_UNDATED: this payment has no payment date; record this bounce by hand';
    END IF;
    IF p_returned_date < v_set.payment_date THEN
      RAISE EXCEPTION 'RETURNED_BEFORE_RECEIVED: the check was received on %; the bank cannot have returned it before that', v_set.payment_date;
    END IF;
    v_customer := v_set.customer_id;
    v_amount := COALESCE(v_set.total_payment_cents, 0);
    v_reference := COALESCE(NULLIF(v_set.check_number, ''), NULLIF(v_set.reference_number, ''));
    SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_credit_ids FROM public.prepay_credits
     WHERE allocation_set_id = p_allocation_set_id AND source_type = 'overpayment';
  ELSE
    -- A Prepayment Manager check is every bucket its one entry wrote: the entry's audit row lists them (a check
    -- number or entry time alone can repeat). The gate refuses a missing, foreign or changed bucket.
    IF (SELECT count(*) FROM public.financial_audit_log fal
         WHERE fal.operation_type = 'prepay_credit_created' AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' AND fal.new_values -> 'credit_ids' @> jsonb_build_array(p_credit_id::text)) <> 1 THEN
      RAISE EXCEPTION 'RECORD_NEEDS_HAND_CHECK: CHECK_BUCKETS (this prepayment check''s entry cannot be identified; record it by hand)';
    END IF;
    SELECT array_agg(b.id::uuid ORDER BY b.id::uuid) INTO v_bucket_ids
      FROM public.financial_audit_log fal
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' THEN fal.new_values -> 'credit_ids' END) AS b(id)
     WHERE fal.operation_type = 'prepay_credit_created' AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array' AND fal.new_values -> 'credit_ids' @> jsonb_build_array(p_credit_id::text);
    v_credit_ids := v_bucket_ids;
    SELECT customer_id, COALESCE(NULLIF(source_reference, ''), NULLIF(reference_number, ''))
      INTO v_customer, v_reference FROM public.prepay_credits WHERE id = p_credit_id;
  END IF;
  PERFORM 1 FROM public.prepay_credits WHERE id = ANY (v_credit_ids) ORDER BY id FOR UPDATE;
  IF p_credit_id IS NOT NULL THEN
    -- The check's face value: what Month-End counted for it (its buckets' amounts; never edited, see the gate).
    SELECT COALESCE(sum(original_amount_cents), 0) INTO v_amount FROM public.prepay_credits WHERE id = ANY (v_credit_ids);
  END IF;
  IF EXISTS (SELECT 1 FROM public.money_reversals r
              WHERE r.kind = 'returned_check'
                AND (r.allocation_set_id = p_allocation_set_id OR r.prepay_credit_id = ANY (v_credit_ids)))
     OR EXISTS (SELECT 1 FROM public.money_reversal_lines l JOIN public.money_reversals r ON r.id = l.reversal_id
                 WHERE r.kind = 'returned_check' AND l.prepay_credit_id = ANY (v_credit_ids)) THEN
    RAISE EXCEPTION 'CHECK_ALREADY_RETURNED: this check is already recorded as returned';
  END IF;
  SELECT COALESCE(sum(l.amount_cents), 0) INTO v_refunded
    FROM public.money_reversal_lines l JOIN public.money_reversals r ON r.id = l.reversal_id
   WHERE l.prepay_credit_id = ANY (v_credit_ids) AND l.line_kind = 'prepay_credit' AND r.kind = 'outside_refund';
  IF v_refunded > 0 THEN
    RAISE EXCEPTION 'CHECK_PREPAY_REFUNDED: $% of this check''s prepay was already refunded to the customer; record this bounce by hand',
      round(v_refunded / 100.0, 2);
  END IF;
  SELECT COALESCE(sum(balance_cents), 0) INTO v_before FROM public.prepay_credits WHERE id = ANY (v_credit_ids);

  -- 2. The month lock: the entry is dated today (open).
  PERFORM public.check_period_open(v_today);

  -- 3. Every invoice the check paid, directly or through its prepay, locked once in id order; then the customer.
  SELECT COALESCE(array_agg(x ORDER BY x), ARRAY[]::uuid[]) INTO v_invoice_ids FROM (
    SELECT ila.invoice_id AS x FROM public.invoice_line_allocations ila
     WHERE p_allocation_set_id IS NOT NULL AND ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
    UNION
    SELECT pa.invoice_id FROM public.prepay_applications pa WHERE pa.prepay_credit_id = ANY (v_credit_ids)) s;
  PERFORM 1 FROM public.invoices WHERE id = ANY (v_invoice_ids) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.customers WHERE id = v_customer FOR UPDATE;
  -- A return changes only invoices that are posted, paid or overdue and not deleted.
  SELECT i.invoice_number, i.status, i.deleted_at IS NOT NULL AS deleted INTO v_inv FROM public.invoices i
   WHERE i.id = ANY (v_invoice_ids) AND (i.status NOT IN ('posted', 'paid', 'overdue') OR i.deleted_at IS NOT NULL)
   ORDER BY i.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'RETURN_INVOICE_NOT_OPEN: invoice % is % (a returned check cannot change a draft, void, cancelled or deleted invoice); record this bounce by hand',
      v_inv.invoice_number, CASE WHEN v_inv.deleted THEN 'deleted' ELSE v_inv.status END;
  END IF;

  -- The integrity gate, on exactly the payment, credits, buckets, invoices and stored balance this return touches.
  PERFORM public._m9_check_records_20270225(v_customer, p_allocation_set_id, v_credit_ids, v_bucket_ids, v_invoice_ids, v_before);
  IF COALESCE(v_amount, 0) <= 0 THEN RAISE EXCEPTION 'NOTHING_TO_RETURN: this check has no amount'; END IF;

  INSERT INTO public.money_reversals (kind, customer_id, entry_date, occurred_on, amount_cents, reference, reason,
                                     allocation_set_id, prepay_credit_id, performed_by)
  VALUES ('returned_check', v_customer, v_today, p_returned_date, v_amount, v_reference, v_reason,
          p_allocation_set_id, p_credit_id, v_actor)
  RETURNING id INTO v_reversal_id;

  -- Each invoice gives back what the check paid on it, directly and through its prepay (the application rows stay;
  -- a reversal line counts each one back on its credit). A paid invoice that now owes money reopens as overdue when
  -- its due date has passed, else posted (reverse_write_off's rule).
  FOR v_inv IN
    WITH cash AS (
      SELECT invoice_id, sum(amount_cents)::bigint AS cents FROM public.invoice_line_allocations
       WHERE p_allocation_set_id IS NOT NULL AND allocation_set_id = p_allocation_set_id AND invoice_id IS NOT NULL
       GROUP BY invoice_id
    ), prepay AS (
      SELECT invoice_id, sum(applied_amount_cents)::bigint AS cents FROM public.prepay_applications
       WHERE prepay_credit_id = ANY (v_credit_ids) GROUP BY invoice_id
    )
    SELECT i.id, i.status, i.due_date, COALESCE(c.cents, 0) AS cash, COALESCE(p.cents, 0) AS prepay
      FROM public.invoices i LEFT JOIN cash c ON c.invoice_id = i.id LEFT JOIN prepay p ON p.invoice_id = i.id
     WHERE i.id = ANY (v_invoice_ids) ORDER BY i.id
  LOOP
    UPDATE public.invoices
       SET paid_amount_cents = paid_amount_cents - v_inv.cash,
           prepay_applied_cents = prepay_applied_cents - v_inv.prepay,
           updated_at = now()
     WHERE id = v_inv.id
    RETURNING balance_cents INTO v_balance;
    IF v_inv.status = 'paid' AND v_balance > 0 THEN
      UPDATE public.invoices
         SET status = CASE WHEN v_inv.due_date IS NOT NULL AND v_inv.due_date < v_today THEN 'overdue' ELSE 'posted' END,
             updated_at = now()
       WHERE id = v_inv.id;
      v_reopened := v_reopened + 1;
    END IF;
    IF v_inv.cash > 0 THEN
      INSERT INTO public.money_reversal_lines (reversal_id, line_kind, invoice_id, amount_cents)
      VALUES (v_reversal_id, 'invoice_payment', v_inv.id, v_inv.cash);
      v_invoice_cents := v_invoice_cents + v_inv.cash;
    END IF;
    v_app_cents := v_app_cents + v_inv.prepay;
  END LOOP;
  -- Every application of the check's prepay, in one statement (the line trigger recomputes each credit once).
  INSERT INTO public.money_reversal_lines (reversal_id, line_kind, prepay_credit_id, invoice_id, prepay_application_id, amount_cents)
  SELECT v_reversal_id, 'prepay_application', pa.prepay_credit_id, pa.invoice_id, pa.id, pa.applied_amount_cents
    FROM public.prepay_applications pa WHERE pa.prepay_credit_id = ANY (v_credit_ids) ORDER BY pa.invoice_id, pa.id;

  -- 4. Whatever is left on the credits comes off (each ends at $0).
  FOREACH v_credit_id IN ARRAY v_credit_ids LOOP
    SELECT balance_cents INTO v_left FROM public.prepay_credits WHERE id = v_credit_id;
    IF v_left > 0 THEN
      INSERT INTO public.money_reversal_lines (reversal_id, line_kind, prepay_credit_id, amount_cents)
      VALUES (v_reversal_id, 'prepay_credit', v_credit_id, v_left);
      v_removed := v_removed + v_left;
    END IF;
  END LOOP;

  -- 5. The customer's stored prepay drops by what was unapplied before (the applied part came off when applied).
  IF v_before > 0 THEN
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents - v_before, updated_at = now() WHERE id = v_customer;
  END IF;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'payment_returned', CASE WHEN p_allocation_set_id IS NOT NULL THEN 'allocation_set' ELSE 'prepay_credit' END,
    COALESCE(p_allocation_set_id, p_credit_id), v_actor, 'admin',
    jsonb_build_object('reversal_id', v_reversal_id, 'bank_returned_date', p_returned_date, 'entry_date', v_today,
                       'reason', v_reason, 'credit_ids', to_jsonb(v_credit_ids), 'invoice_ids', to_jsonb(v_invoice_ids),
                       'invoices_reopened', v_reopened, 'invoice_payment_cents', v_invoice_cents,
                       'prepay_applications_reversed_cents', v_app_cents, 'prepay_removed_cents', v_removed,
                       'prepay_balance_debited_cents', v_before),
    -v_amount,
    'Returned check ' || COALESCE(v_reference, '') || ' $' || round(v_amount / 100.0, 2) || ' - ' || v_reason);
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('payment_returned', 'Returned check ' || COALESCE(v_reference, '') || ' $' || round(v_amount / 100.0, 2),
          v_actor, 'money_reversal', v_reversal_id, v_customer);

  v_result := jsonb_build_object(
    'reversal_id', v_reversal_id, 'kind', 'returned_check', 'customer_id', v_customer,
    'allocation_set_id', p_allocation_set_id, 'prepay_credit_id', p_credit_id, 'credit_ids', to_jsonb(v_credit_ids),
    'bank_returned_date', p_returned_date, 'entry_date', v_today,
    'amount_cents', v_amount, 'invoices_reopened', v_reopened, 'invoice_payment_cents', v_invoice_cents,
    'prepay_applications_reversed_cents', v_app_cents, 'prepay_removed_cents', v_removed,
    'prepay_balance_debited_cents', v_before,
    'prepay_balance_cents', (SELECT prepay_balance_cents FROM public.customers WHERE id = v_customer));
  PERFORM public.save_idempotency(p_idempotency_key, 'record_returned_check', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'record_returned_check', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.record_returned_check(uuid, date, text, uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_returned_check(uuid, date, text, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_returned_check(uuid, date, text, uuid, text, uuid) TO authenticated, service_role;

-- 5. Prepay balance check (read-only; never fixes) -------------------------------------------------------------------
CREATE FUNCTION public.get_prepay_balance_check(p_customer_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only an active admin can run the prepay balance check';
  END IF;
  RETURN (
    WITH cust AS (
      SELECT c.id, c.farm_name, COALESCE(c.prepay_balance_cents, 0)::bigint AS stored
        FROM public.customers c
       WHERE CASE WHEN p_customer_id IS NOT NULL THEN c.id = p_customer_id
                  ELSE COALESCE(c.prepay_balance_cents, 0) <> 0
                       OR EXISTS (SELECT 1 FROM public.prepay_credits pc WHERE pc.customer_id = c.id) END
    ), credits AS (
      SELECT pc.customer_id, sum(pc.original_amount_cents)::bigint AS received, sum(pc.balance_cents)::bigint AS on_credits
        FROM public.prepay_credits pc JOIN cust ON cust.id = pc.customer_id GROUP BY pc.customer_id
    ), applied AS (
      SELECT pc.customer_id, sum(pa.applied_amount_cents)::bigint AS cents
        FROM public.prepay_applications pa JOIN public.prepay_credits pc ON pc.id = pa.prepay_credit_id
        JOIN cust ON cust.id = pc.customer_id GROUP BY pc.customer_id
    ), lines AS (
      SELECT pc.customer_id,
             COALESCE(sum(l.amount_cents) FILTER (WHERE l.line_kind = 'prepay_application'), 0)::bigint AS reversed,
             COALESCE(sum(l.amount_cents) FILTER (WHERE l.line_kind = 'prepay_credit' AND r.kind = 'outside_refund'), 0)::bigint AS refunded,
             COALESCE(sum(l.amount_cents) FILTER (WHERE l.line_kind = 'prepay_credit' AND r.kind = 'returned_check'), 0)::bigint AS voided
        FROM public.money_reversal_lines l
        JOIN public.money_reversals r ON r.id = l.reversal_id
        JOIN public.prepay_credits pc ON pc.id = l.prepay_credit_id
        JOIN cust ON cust.id = pc.customer_id
       GROUP BY pc.customer_id
    ), mismatches AS (
      -- Per credit: the stored balance against its own rows, so offsetting errors on two credits still show.
      SELECT m.customer_id, jsonb_agg(jsonb_build_object('prepay_credit_id', m.id, 'balance_cents', m.balance_cents,
                                                         'computed_cents', m.computed) ORDER BY m.id) AS list
        FROM (SELECT pc.customer_id, pc.id, pc.balance_cents, public._prepay_credit_computed_balance_20270225(pc.id) AS computed
                FROM public.prepay_credits pc JOIN cust ON cust.id = pc.customer_id) m
       WHERE m.balance_cents IS DISTINCT FROM m.computed
       GROUP BY m.customer_id
    ), rows AS (
      SELECT cust.id, cust.farm_name, cust.stored,
             COALESCE(cr.received, 0) AS received,
             COALESCE(ap.cents, 0) - COALESCE(ln.reversed, 0) AS applied,
             COALESCE(ln.refunded, 0) AS refunded,
             COALESCE(ln.voided, 0) AS voided,
             COALESCE(cr.on_credits, 0) AS on_credits,
             mm.list AS mismatches
        FROM cust
        LEFT JOIN credits cr ON cr.customer_id = cust.id
        LEFT JOIN applied ap ON ap.customer_id = cust.id
        LEFT JOIN lines ln ON ln.customer_id = cust.id
        LEFT JOIN mismatches mm ON mm.customer_id = cust.id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'customer_id', id, 'farm_name', farm_name,
             'received_cents', received, 'applied_cents', applied, 'refunded_cents', refunded, 'voided_cents', voided,
             'expected_cents', received - applied - refunded - voided,
             'stored_cents', stored, 'credits_cents', on_credits,
             'difference_cents', stored - (received - applied - refunded - voided),
             'credit_mismatches', COALESCE(mismatches, '[]'::jsonb),
             'ok', stored = received - applied - refunded - voided AND on_credits = received - applied - refunded - voided
                   AND mismatches IS NULL)
             ORDER BY farm_name, id), '[]'::jsonb)
      FROM rows);
END;
$function$;
ALTER FUNCTION public.get_prepay_balance_check(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_prepay_balance_check(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_prepay_balance_check(uuid) TO authenticated, service_role;

-- 6. Postflight -----------------------------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.m9_strip(p_text text, p_blocks text[]) RETURNS text LANGUAGE plpgsql AS $strip$
DECLARE b text;
BEGIN
  FOREACH b IN ARRAY p_blocks LOOP p_text := replace(p_text, b, ''); END LOOP;
  RETURN p_text;
END
$strip$;

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  -- Each replaced body minus its inserted M9 blocks is byte-identical to the pinned body; nothing else changed.
  SELECT string_agg(f.sig, ', ') INTO v_bad
    FROM pg_temp.m9_pins f
    JOIN (VALUES
      ('public._recompute_prepay_credit_balance()', ARRAY[$m9blk$
         -- M9: an application reversed by a returned check counts back; a refund or returned-check line takes off.
         + COALESCE(
           (SELECT SUM(amount_cents)
              FROM money_reversal_lines
             WHERE prepay_credit_id = v_target AND line_kind = 'prepay_application'),
           0
         )
         - COALESCE(
           (SELECT SUM(amount_cents)
              FROM money_reversal_lines
             WHERE prepay_credit_id = v_target AND line_kind = 'prepay_credit'),
           0
         )$m9blk$]),
      ('public._void_payment_replay_impl_20261015(uuid,text,uuid,text)', ARRAY[$m9blk$
  -- M9: a check recorded as returned (bounced) is not voided as well, and a payment whose prepay was partly refunded
  -- cannot be voided (its credit would go below $0). The credits are locked first, as a refund locks them.
  -- Only a payment is voided here (an order or invoice allocation set is not money received).
  IF v_set.entity_type IS DISTINCT FROM 'payment' THEN
    RAISE EXCEPTION 'NOT_A_PAYMENT: this allocation set is not a payment; only a payment can be voided';
  END IF;
  PERFORM 1 FROM prepay_credits
   WHERE allocation_set_id = p_allocation_set_id AND source_type = 'overpayment' ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM money_reversals WHERE kind = 'returned_check' AND allocation_set_id = p_allocation_set_id) THEN
    RAISE EXCEPTION 'PAYMENT_RETURNED: this check is recorded as returned (bounced); it cannot also be voided';
  END IF;
  IF EXISTS (SELECT 1 FROM money_reversal_lines l JOIN prepay_credits pc ON pc.id = l.prepay_credit_id
              WHERE pc.allocation_set_id = p_allocation_set_id AND pc.source_type = 'overpayment') THEN
    RAISE EXCEPTION 'PAYMENT_PREPAY_REFUNDED: part of this payment''s prepay was refunded to the customer; it cannot be voided';
  END IF;
$m9blk$] || ARRAY[$m9blk$, updated_at = now() /* M9: the cached balance changed */$m9blk$] || ARRAY[$m9blk$
  -- M9: every invoice this void touches (its payment lines and its prepay's applications), locked in one id-ordered
  -- pass, the order record_returned_check takes them in.
  PERFORM 1 FROM invoices
   WHERE id IN (SELECT ila.invoice_id FROM invoice_line_allocations ila
                 WHERE ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
                UNION
                SELECT pa.invoice_id FROM prepay_applications pa JOIN prepay_credits pc ON pc.id = pa.prepay_credit_id
                 WHERE pc.allocation_set_id = p_allocation_set_id AND pc.source_type = 'overpayment')
   ORDER BY id FOR UPDATE;
$m9blk$]),
      ('public._edit_prepay_credit_replay_impl_20261015(uuid,bigint,text,text,text,uuid,text)', ARRAY[$m9blk$
  -- M9: a credit with a refund or a returned check recorded on it keeps its amounts (the edit would rewrite its
  -- original amount and erase them). Reference, label and notes can still change; the screen always sends the
  -- balance, so an unchanged balance is treated as no balance change.
  -- A Prepayment Manager check's amounts are locked too (its creation entry records them; a mistyped check is deleted
  -- whole and entered again). So is an overpayment's: its payment records it (an edit would break the payment's totals
  -- and stop the customer's refunds and returns); the payment is voided instead.
  IF public._prepay_credit_reversed_20270225(p_credit_id)
     OR (v_credit.source_type = 'check' AND v_credit.allocation_set_id IS NULL)
     OR v_credit.source_type = 'overpayment' THEN
    IF p_new_balance_cents IS NOT NULL AND p_new_balance_cents IS DISTINCT FROM v_credit.balance_cents THEN
      IF public._prepay_credit_reversed_20270225(p_credit_id) THEN
        RAISE EXCEPTION 'PREPAY_CREDIT_HAS_REVERSALS: this credit has a refund or returned check recorded; its balance cannot be edited';
      END IF;
      IF v_credit.source_type = 'overpayment' THEN
        RAISE EXCEPTION 'PREPAY_OVERPAYMENT_LOCKED: an overpayment''s amount comes from its payment and cannot be edited; void the payment to undo it';
      END IF;
      RAISE EXCEPTION 'PREPAY_CHECK_AMOUNT_LOCKED: a prepayment check''s amount cannot be edited; delete the whole check and enter it again';
    END IF;
    p_new_balance_cents := NULL;
  END IF;
$m9blk$] || ARRAY[$m9blk$, updated_at = now() /* M9: the cached balance changed */$m9blk$]),
      ('public._delete_prepay_credit_replay_impl_20261015(uuid,text,uuid,text)', ARRAY[$m9blk$      -- M9: a whole-check delete saved its full receipt; a retry answers with it.
      IF v_existing ? 'credit_ids' THEN RETURN v_existing || jsonb_build_object('idempotent', true); END IF;
$m9blk$] || ARRAY[$m9blk$
  -- M9: a credit with a refund or a returned check recorded on it cannot be deleted (the delete would rewrite its
  -- original amount and erase them).
  IF public._prepay_credit_reversed_20270225(p_credit_id) THEN
    RAISE EXCEPTION 'PREPAY_CREDIT_HAS_REVERSALS: this credit has a refund or returned check recorded; it cannot be deleted';
  END IF;
  -- M9: an overpayment comes from its payment (a delete would break the payment's totals and stop the customer's
  -- refunds and returns); the payment is voided instead, which removes its credit.
  IF v_credit.source_type = 'overpayment' THEN
    RAISE EXCEPTION 'PREPAY_OVERPAYMENT_LOCKED: an overpayment comes from its payment and cannot be deleted; void the payment to undo it';
  END IF;
  -- M9: a Prepayment Manager check is deleted whole: every bucket its creation entry lists, together, in one audit
  -- row, refused when any bucket was applied or has a refund / returned-check line. Its amounts go to $0 (the entry
  -- stays; the gate skips an entry deleted whole).
  IF v_credit.source_type = 'check' AND v_credit.allocation_set_id IS NULL THEN
    DECLARE
      v_ids    uuid[];
      v_total  bigint;
      v_before jsonb;
      v_result jsonb;
    BEGIN
      IF (SELECT count(*) FROM financial_audit_log fal
           WHERE fal.operation_type = 'prepay_credit_created' AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array'
             AND fal.new_values -> 'credit_ids' @> jsonb_build_array(p_credit_id::text)) <> 1 THEN
        RAISE EXCEPTION 'RECORD_NEEDS_HAND_CHECK: CHECK_BUCKETS (this prepayment check''s entry cannot be identified; delete it by hand)';
      END IF;
      SELECT array_agg(DISTINCT b.id::uuid) INTO v_ids
        FROM financial_audit_log fal
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(fal.new_values -> 'credit_ids') = 'array'
                                                          THEN fal.new_values -> 'credit_ids' END) AS b(id)
       WHERE fal.operation_type = 'prepay_credit_created' AND jsonb_typeof(fal.new_values -> 'credit_ids') = 'array'
         AND fal.new_values -> 'credit_ids' @> jsonb_build_array(p_credit_id::text);
      PERFORM 1 FROM prepay_credits WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;
      IF (SELECT count(*) FROM prepay_credits WHERE id = ANY (v_ids) AND customer_id = v_credit.customer_id
             AND source_type = 'check' AND allocation_set_id IS NULL) <> cardinality(v_ids) THEN
        RAISE EXCEPTION 'RECORD_NEEDS_HAND_CHECK: CHECK_BUCKETS (this prepayment check''s buckets do not agree; delete it by hand)';
      END IF;
      IF EXISTS (SELECT 1 FROM prepay_applications WHERE prepay_credit_id = ANY (v_ids)) THEN
        RAISE EXCEPTION 'PREPAY_CHECK_APPLIED: part of this check was applied to an invoice; it cannot be deleted';
      END IF;
      IF EXISTS (SELECT 1 FROM unnest(v_ids) c(id) WHERE public._prepay_credit_reversed_20270225(c.id)) THEN
        RAISE EXCEPTION 'PREPAY_CREDIT_HAS_REVERSALS: this check has a refund or returned check recorded; it cannot be deleted';
      END IF;
      IF EXISTS (SELECT 1 FROM prepay_credits WHERE id = ANY (v_ids) AND balance_cents IS DISTINCT FROM original_amount_cents) THEN
        RAISE EXCEPTION 'RECORD_NEEDS_HAND_CHECK: CREDIT_DRIFT (a bucket of this check does not match its amount; delete it by hand)';
      END IF;
      SELECT COALESCE(sum(balance_cents), 0) INTO v_total FROM prepay_credits WHERE id = ANY (v_ids);
      IF v_total = 0 THEN RAISE EXCEPTION 'Prepay credit already has zero balance'; END IF;
      -- The month the check was received in must be open (its Month-End receipt would move), under the month lock;
      -- then the customer (lock order: credits, month, customer, as a refund).
      PERFORM check_period_open((v_credit.created_at AT TIME ZONE 'America/Chicago')::date);
      PERFORM 1 FROM customers WHERE id = v_credit.customer_id FOR UPDATE;
      -- The entry must be one whole receipt of this customer, by the refund / return gate's own rules.
      PERFORM public._m9_check_records_20270225(v_credit.customer_id, NULL, v_ids, v_ids, ARRAY[]::uuid[], 0);
      -- The before-image, read before anything is zeroed.
      SELECT jsonb_agg(jsonb_build_object('id', id, 'original_amount_cents', original_amount_cents,
                                          'balance_cents', balance_cents, 'bucket_label', bucket_label) ORDER BY id)
        INTO v_before FROM prepay_credits WHERE id = ANY (v_ids);
      IF (SELECT COALESCE(prepay_balance_cents, 0) FROM customers WHERE id = v_credit.customer_id) < v_total THEN
        RAISE EXCEPTION 'RECORD_NEEDS_HAND_CHECK: STORED_BALANCE_LOW (the customer''s stored prepay is below this check; delete it by hand)';
      END IF;
      UPDATE prepay_credits
         SET balance_cents = 0, original_amount_cents = 0,
             notes = COALESCE(notes, '') || ' [DELETED: ' || p_reason || ']', updated_at = now()
       WHERE id = ANY (v_ids);
      UPDATE customers SET prepay_balance_cents = prepay_balance_cents - v_total, updated_at = now()
       WHERE id = v_credit.customer_id;
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
      ) VALUES (
        'prepay_deleted', 'prepay', p_credit_id, v_actor,
        jsonb_build_object('total_cents', v_total, 'reference_number', v_credit.source_reference, 'buckets', v_before),
        jsonb_build_object('whole_check', true, 'credit_ids', to_jsonb(v_ids), 'balance_cents', 0, 'original_amount_cents', 0,
                           'reason', p_reason),
        -1 * v_total,
        'Deleted prepayment check ' || COALESCE(v_credit.source_reference, v_credit.id::text) || ' (' || cardinality(v_ids)
          || ' bucket(s)) — ' || p_reason
      );
      v_result := jsonb_build_object('success', true, 'credit_id', p_credit_id, 'credit_ids', to_jsonb(v_ids),
                                     'deleted_balance_cents', v_total);
      IF p_idempotency_key IS NOT NULL THEN
        -- The whole receipt is kept, so a retry with the same key answers exactly as this call did.
        INSERT INTO idempotency_keys (idempotency_key, operation, result)
        VALUES (p_idempotency_key, 'delete_prepay_credit', v_result);
      END IF;
      RETURN v_result;
    END;
  END IF;
$m9blk$] || ARRAY[$m9blk$  -- M9: the customer's credits first, in id order (a refund's order), so a whole-check delete cannot deadlock with it.
  PERFORM 1 FROM prepay_credits
   WHERE customer_id = (SELECT pc.customer_id FROM prepay_credits pc WHERE pc.id = p_credit_id) ORDER BY id FOR UPDATE;
$m9blk$] || ARRAY[$m9blk$, updated_at = now() /* M9: the cached balance changed */$m9blk$]),
      ('public._month_payments_received_20270208(date,date)', ARRAY[$m9blk$, false AS m9_return$m9blk$] || ARRAY[$m9blk$, false AS m9_return$m9blk$] || ARRAY[$m9blk$, false AS m9_return$m9blk$] || ARRAY[$m9blk$,
              -- M9: one payment per Prepayment Manager entry (its audit row), so two checks entered together count twice
              (SELECT fal.id FROM public.financial_audit_log fal
                WHERE fal.operation_type = 'prepay_credit_created' AND fal.new_values -> 'credit_ids' ? pc.id::text LIMIT 1)$m9blk$] || ARRAY[$m9blk$
    UNION ALL
    -- M9: a returned (bounced) check comes off the month it was recorded in (always an open month), never the month
    -- it was received in; it is not a payment, so it is not counted.
    SELECT -mr.amount_cents::numeric, true
      FROM public.money_reversals mr
     WHERE mr.kind = 'returned_check'
       AND mr.entry_date BETWEEN p_start AND p_end$m9blk$] || ARRAY[$m9blk$ FILTER (WHERE NOT m9_return)$m9blk$]),
      ('public._month_close_figures_20270208(date,date)', ARRAY[$m9blk$    -- M9: refunds paid outside CRX and returned checks recorded in the dates (returned checks are already netted out
    -- of payments received above).
    'refunds', (SELECT jsonb_build_object('count', count(*), 'total_cents', COALESCE(sum(mr.amount_cents), 0))
                  FROM public.money_reversals mr
                 WHERE mr.kind = 'outside_refund' AND mr.entry_date BETWEEN p_period_start AND p_period_end),
    'returned_checks', (SELECT jsonb_build_object('count', count(*), 'total_cents', COALESCE(sum(mr.amount_cents), 0))
                  FROM public.money_reversals mr
                 WHERE mr.kind = 'returned_check' AND mr.entry_date BETWEEN p_period_start AND p_period_end),
$m9blk$] || ARRAY[$m9blk$      'refunds_paid_cents', COALESCE((SELECT sum(mr.amount_cents) FROM public.money_reversals mr
         WHERE mr.kind = 'outside_refund' AND mr.entry_date BETWEEN p_period_start AND p_period_end), 0),
      'returned_checks_cents', COALESCE((SELECT sum(mr.amount_cents) FROM public.money_reversals mr
         WHERE mr.kind = 'returned_check' AND mr.entry_date BETWEEN p_period_start AND p_period_end), 0),
$m9blk$]),
      ('public.statement_customer_has_later_balance_activity(uuid,date)', ARRAY[$m9blk$
    OR EXISTS (
      -- M9: a returned (bounced) check recorded after the cutoff changed the invoices it paid; the balance of those
      -- invoices as of the cutoff cannot be rebuilt from today's rows.
      SELECT 1
      FROM public.money_reversals mr
      JOIN public.money_reversal_lines l ON l.reversal_id = mr.id
      JOIN public.invoices i ON i.id = l.invoice_id
      WHERE mr.customer_id = p_customer_id
        AND mr.kind = 'returned_check'
        AND (mr.entry_date > p_as_of_date OR (mr.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
        AND i.invoice_date <= p_as_of_date
        AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
    )$m9blk$]),
      ('public._get_customer_statement_scoped_impl(uuid,date,date)', ARRAY[$m9blk$
    UNION ALL

    -- M9: a returned (bounced) check puts back what it paid (cash and prepay) on the day it was recorded; the
    -- original payment and prepay rows stay.
    SELECT
      mr.entry_date,
      'returned_check',
      COALESCE(mr.reference, ''),
      'Returned check ' || COALESCE(mr.reference, ''),
      COALESCE((SELECT sum(l.amount_cents) FROM public.money_reversal_lines l
                 WHERE l.reversal_id = mr.id AND l.line_kind IN ('invoice_payment', 'prepay_application')), 0)::bigint,
      45,
      mr.id
    FROM public.money_reversals mr
    WHERE mr.customer_id = p_customer_id
      AND mr.kind = 'returned_check'

    UNION ALL

    -- M9: a refund paid outside CRX comes out of prepay, not out of what is owed: shown, $0.00 effect.
    SELECT
      mr.entry_date,
      'refund',
      COALESCE(mr.reference, ''),
      'Refund paid (outside CRX) ' || COALESCE(mr.reference, ''),
      0::bigint,
      46,
      mr.id
    FROM public.money_reversals mr
    WHERE mr.customer_id = p_customer_id
      AND mr.kind = 'outside_refund'
$m9blk$]),
      ('public.void_invoice(uuid,text,text)', ARRAY[$m9blk$  -- M9: an invoice a returned (bounced) check paid keeps that history (the payment's allocation and the reversed
  -- prepay application rows stay), so it cannot be voided; say so before the void reaches them.
  -- Only for a caller the void itself would authorize (an active admin); anyone else gets the void's own refusal.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin')
     AND EXISTS (SELECT 1 FROM public.money_reversal_lines l
              WHERE l.invoice_id = p_invoice_id AND l.line_kind IN ('invoice_payment', 'prepay_application')) THEN
    RAISE EXCEPTION 'INVOICE_HAS_RETURNED_PAYMENT: a returned (bounced) check paid this invoice; it stays on the customer''s history and the invoice cannot be voided';
  END IF;
$m9blk$])
    ) AS b(sig, blocks) ON b.sig = f.sig
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.sig)
        AND md5(pg_temp.m9_strip(replace(p.prosrc, chr(13), ''), b.blocks)) = f.md5
        AND (SELECT bool_and(position(blk IN replace(p.prosrc, chr(13), '')) > 0) FROM unnest(b.blocks) blk)
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef = f.secdef
        AND p.proconfig::text = f.cfg
        AND pg_temp.m9_acl(p.proacl::text) = pg_temp.m9_acl(f.post_acl)
        AND p.pronargdefaults = f.ndefaults
        AND p.provolatile::text = f.vol
        AND md5(pg_get_function_arguments(p.oid) || ' => ' || pg_get_function_result(p.oid)) = f.sigmd5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M9_POSTFLIGHT: not the expected body or contract: %', v_bad;
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'financial_audit_log_operation_type_check'
       AND conrelid = 'public.financial_audit_log'::regclass) IS DISTINCT FROM $m9chk$CHECK ((operation_type = ANY (ARRAY['invoice_created'::text, 'invoice_posted'::text, 'invoice_unposted'::text, 'invoice_voided'::text, 'invoice_cancelled'::text, 'invoice_updated'::text, 'invoice_deleted'::text, 'invoice_marked_overdue'::text, 'payment_recorded'::text, 'payment_allocation'::text, 'payment_voided'::text, 'payment_allocated'::text, 'split_modified'::text, 'split_invoices_generated'::text, 'prepay_created'::text, 'prepay_applied'::text, 'prepay_credit_created'::text, 'prepay_batch_applied'::text, 'prepay_edited'::text, 'prepay_deleted'::text, 'prepay_reconciliation'::text, 'batch_prepay_apply'::text, 'write_off_recorded'::text, 'write_off_reversed'::text, 'write_off_applied'::text, 'finance_charge'::text, 'finance_charge_generated'::text, 'finance_charge_voided'::text, 'credit_memo_created'::text, 'credit_memo_applied'::text, 'credit_memo_unapplied'::text, 'return_created'::text, 'return_approved'::text, 'return_received'::text, 'return_credit_issued'::text, 'order_created'::text, 'order_updated'::text, 'order_voided'::text, 'order_cancelled'::text, 'order_restored'::text, 'delivery_created'::text, 'delivery_updated'::text, 'delivery_cancelled'::text, 'delivery_voided'::text, 'delivery_restored'::text, 'quote_converted'::text, 'blend_ticket_linked'::text, 'blend_ticket_unlinked'::text, 'commission_payment_created'::text, 'commission_payment_posted'::text, 'commission_payment_voided'::text, 'batch_post'::text, 'batch_void'::text, 'batch_payment'::text, 'period_reopened'::text, 'quote_status_reverted'::text, 'blend_ticket_approval_reversed'::text, 'cycle_count_completed'::text, 'vendor_bill_created'::text, 'vendor_bill_voided'::text, 'vendor_bill_updated'::text, 'vendor_payment_recorded'::text, 'vendor_payment_voided'::text, 'rup_sales_voided'::text, 'receiving_reversed'::text, 'payment_deleted'::text, 'allocation_set_deleted'::text, 'prepay_refunded_outside'::text, 'payment_returned'::text])))$m9chk$ THEN
    RAISE EXCEPTION 'M9_POSTFLIGHT: financial_audit_log_operation_type_check is not the expected list';
  END IF;
  -- Every operation type the old list allowed is still allowed.
  IF EXISTS (SELECT m[1] FROM pg_temp.m9_old_audit_check o, regexp_matches(o.def, '''([a-z_]+)''::text', 'g') AS m
             EXCEPT
             SELECT m[1] FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') AS m
              WHERE c.conrelid = 'public.financial_audit_log'::regclass AND c.conname = 'financial_audit_log_operation_type_check') THEN
    RAISE EXCEPTION 'M9_POSTFLIGHT: the new audit list dropped an operation type';
  END IF;
  SELECT string_agg(sig, ', ') INTO v_bad FROM (VALUES
      ('public.record_outside_refund(uuid,bigint,date,text,text,uuid,uuid,text,boolean)', true),
      ('public.record_returned_check(uuid,date,text,uuid,text,uuid)', true),
      ('public.get_prepay_balance_check(uuid)', true),
      ('public._money_reversals_append_only_20270225()', false),
      ('public._prepay_credit_reversed_20270225(uuid)', false),
      ('public._prepay_credit_computed_balance_20270225(uuid)', false),
      ('public._recompute_prepay_credits_from_lines_20270225()', false),
      ('public._m9_check_records_20270225(uuid,uuid,uuid[],uuid[],uuid[],bigint)', false)) AS n(sig, callable)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(n.sig)
        AND p.proowner = 'postgres'::regrole
        AND p.proconfig::text = '{"search_path=public, pg_temp"}'
        AND pg_temp.m9_acl(p.proacl::text) = pg_temp.m9_acl(CASE WHEN n.callable
              THEN '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' ELSE '{postgres=X/postgres}' END));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M9_POSTFLIGHT: new function contract: %', v_bad;
  END IF;
  IF has_table_privilege('authenticated', 'public.money_reversals', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.money_reversal_lines', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('anon', 'public.money_reversals', 'SELECT')
     OR has_table_privilege('anon', 'public.money_reversal_lines', 'SELECT') THEN
    RAISE EXCEPTION 'M9_POSTFLIGHT: an API role can write the reversal tables or anon can read them';
  END IF;
END
$postflight$;

DROP FUNCTION pg_temp.m9_strip(text, text[]);
DROP FUNCTION pg_temp.m9_acl(text);
