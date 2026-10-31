-- Written 2026-10-29. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 1002, PLACEHOLDER: open drafts #1174/#1179 already claim
-- 1000/1001; the landing session assigns the final row). Re-read the live ledger before applying.
--
-- WHAT: a booking can only be "accepted" when an order exists for it (Mason 2026-10-27: "DB
--   safeguard against accepted with no order: yes"). In this app 'accepted' means converted to a
--   chemical sale (see _enforce_quote_status_transition), so an accepted quote with no order
--   is a booking whose holds were released with nothing to show for it (KNOWN_ISSUES KI-12, the
--   direct path). The screen never writes 'accepted' directly; this closes the
--   direct paths (save_quote with status 'accepted', or a plain row update / insert).
--
-- HOW: one constraint trigger, DEFERRABLE INITIALLY DEFERRED, so the check runs at commit.
--   convert_quote_to_order and the last draw_down_quote both set 'accepted' and create the order
--   in the same transaction, in either order, so they pass. At commit it re-reads the row: if the
--   status already moved on in the same transaction, nothing is checked.
--
-- NOT CHANGED: every existing function, trigger, policy and grant; rows already accepted (the
--   check fires only when a row becomes 'accepted'); Un-accept (accepted -> sent).
--
-- SAFE TO APPLY: new objects only, no data change. Live read before applying (read-only):
--   SELECT q.quote_number FROM quotes q WHERE q.status = 'accepted' AND q.deleted_at IS NULL
--     AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.quote_id = q.id AND o.deleted_at IS NULL);
--   Rows it lists stay as they are; they're for Mason to look at (KNOWN_ISSUES KI-12 already names
--   Q-2026-2059, accepted with no order since before #1105).

DO $preflight$
BEGIN
  IF to_regprocedure('public._enforce_quote_accepted_has_order()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_quote_accepted_requires_order') THEN
    RAISE EXCEPTION 'PREFLIGHT: quote_accepted_requires_order already exists; re-read live first';
  END IF;
END
$preflight$;

CREATE FUNCTION public._enforce_quote_accepted_has_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Deferred: re-read the committed-to-be state, not the row image from the statement.
  IF EXISTS (SELECT 1 FROM quotes q WHERE q.id = NEW.id AND q.status = 'accepted')
     AND NOT EXISTS (
       SELECT 1 FROM orders o WHERE o.quote_id = NEW.id AND o.deleted_at IS NULL
     ) THEN
    RAISE EXCEPTION 'QUOTE_ACCEPTED_WITHOUT_ORDER: quote % can only be accepted by converting it to an order', NEW.quote_number
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._enforce_quote_accepted_has_order() FROM PUBLIC, anon, authenticated;

CREATE CONSTRAINT TRIGGER trg_quote_accepted_requires_order
  AFTER INSERT OR UPDATE OF status ON public.quotes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'accepted')
  EXECUTE FUNCTION public._enforce_quote_accepted_has_order();

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_quote_accepted_requires_order'
      AND tgrelid = 'public.quotes'::regclass
      AND tgdeferrable AND tginitdeferred
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: deferred trigger trg_quote_accepted_requires_order missing';
  END IF;
  IF has_function_privilege('authenticated', 'public._enforce_quote_accepted_has_order()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: trigger function must not be callable by signed-in users';
  END IF;
END
$postflight$;
