-- Written 2026-11-03. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261105160000_quote_sent_requires_version.md. Re-read the live
-- ledger before applying.
--
-- WHAT: a quote leaves draft for sent or revised only with a sent version on record, so every
--   sent quote has the version the customer was sent. One function, two triggers:
--   1. A quote moves to sent or revised (from draft, or reopened from cancelled, declined,
--      expired or accepted) only when a quote_versions row exists for it, for every caller
--      (save_quote and the admin override included). The send records its version before it
--      sets the status, and a rewind or reopen of a quote that was sent finds its version, so
--      they keep working. Checked before the admin override.
--   2. New trigger enforce_quote_insert_status: a quote inserted by a signed-in or anonymous
--      session starts as a draft. Every quote-creating function already inserts draft (read live
--      2026-11-03: save_quote, duplicate_quote, create_quote_from_template,
--      rollover_quote_to_season); those run as the definer, as do the rolled-back smoke fixtures
--      that insert older quote shapes.
--   Every other line of _enforce_quote_status_transition is its current live body (pinned below).
--
-- NOT CHANGED: every other status transition, the admin override for them, grants, RLS, the send,
--   the rewind, save_quote, _assert_quote_prices_as_sent. No data is written. Live 2026-11-03: 0
--   sent or revised quotes without a version, and every accepted quote has one (the preflight
--   re-checks sent and revised).
--
-- ROLLBACK (its own reviewed migration): DROP TRIGGER enforce_quote_insert_status ON public.quotes;
--   re-emit _enforce_quote_status_transition from its pinned live body (md5 below); drop the
--   quotes:sent-requires-version rows from quote-price-lock-boundary.sql.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('_enforce_quote_status_transition', 'public._enforce_quote_status_transition()',
          'c2749a6c84fc32d95e12d9af885616e5')
      ) AS pin(fn, sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc o
             WHERE o.pronamespace = 'public'::regnamespace AND o.proname = pin.fn) <> 1
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
        OR p.proowner <> 'postgres'::regrole
        OR p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_QUOTE_FUNCTION_DRIFT: the re-emitted function differs from its pinned body, owner, mode or search_path';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'enforce_quote_insert_status') THEN
    RAISE EXCEPTION 'PREFLIGHT: trigger enforce_quote_insert_status already exists; re-read live first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.quotes q
              WHERE q.status IN ('sent', 'revised')
                AND NOT EXISTS (SELECT 1 FROM public.quote_versions v WHERE v.quote_id = q.id)) THEN
    RAISE EXCEPTION 'PREFLIGHT: a sent or revised quote has no version; resolve it before applying';
  END IF;
END
$preflight$;

-- 1. The status rule.
CREATE OR REPLACE FUNCTION public._enforce_quote_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- A quote inserted by a browser session starts as a draft; it becomes sent only through the
  -- send (20261105160000). Definer-rights code runs as its owner and inserts draft.
  IF TG_OP = 'INSERT' THEN
    IF current_user IN ('anon', 'authenticated') AND NEW.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'QUOTE_SEND_REQUIRED: a new quote must start as a draft'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status THEN RETURN NEW; END IF;

  -- A quote is sent or revised only with the version the customer was sent (20261105160000).
  -- The send records its version before it sets the status. Checked before the admin override.
  IF NEW.status IN ('sent', 'revised')
     AND NOT EXISTS (SELECT 1 FROM quote_versions WHERE quote_id = NEW.id) THEN
    RAISE EXCEPTION 'QUOTE_SEND_REQUIRED: send the quote to the customer to mark it %', NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  IF _is_admin_override() THEN RETURN NEW; END IF;

  -- U5 (Codex round-2 P2): a DIRECT status UPDATE to 'closed_short' (RLS lets
  -- admin/sales write quotes.status without the RPC) must honor the same
  -- active-jobs refusal as close_quote_as_short — otherwise the release trigger
  -- would drop this booking's holds while live jobs still expect to apply the
  -- product. The RPC passes this check trivially (it refuses first).
  -- NOTE (invoker-rights dependency): this EXISTS runs under the CALLER's jobs
  -- RLS. Safe today because everyone who passes quotes_update (admin / owning
  -- sales_rep) has UNFILTERED jobs SELECT. If jobs_select is ever row-scoped
  -- for sales_rep, this guard silently weakens — re-check then.
  IF NEW.status = 'closed_short' AND EXISTS (
    SELECT 1 FROM jobs
    WHERE quote_id = NEW.id AND deleted_at IS NULL
      AND status IN ('scheduled', 'in_progress')
  ) THEN
    RAISE EXCEPTION 'BOOKING_HAS_ACTIVE_JOBS: cancel or complete the booking''s scheduled/in-progress jobs before closing it as short';
  END IF;

  IF (OLD.status = 'draft' AND NEW.status IN ('sent', 'cancelled'))
  OR (OLD.status = 'sent' AND NEW.status IN ('revised', 'accepted', 'declined', 'expired', 'cancelled'))
  OR (OLD.status = 'revised' AND NEW.status IN ('sent', 'accepted', 'declined', 'expired', 'cancelled'))
  OR (OLD.status = 'accepted' AND NEW.status = 'sent')
  -- LAYER2<<< a booking we fulfilled by APPLYING product (job applications)
  -- closes to its own terminal status, distinct from 'accepted' (= convert-to-
  -- order, a chemical sale). Reachable only from an open booking. (owner 2026-07-03)
  OR (OLD.status IN ('sent', 'revised') AND NEW.status = 'closed_by_application')
  -- >>>LAYER2
  -- U5<<< a booking the customer ABANDONED (walked away / drew only part) closes
  -- to its own terminal 'closed_short', releasing the un-fulfilled remainder.
  -- Reachable only from an open booking, terminal (no outgoing edge). (#1)
  OR (OLD.status IN ('sent', 'revised') AND NEW.status = 'closed_short')
  -- >>>U5
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid quote status transition: % → %', OLD.status, NEW.status;
END;
$function$;

CREATE TRIGGER enforce_quote_insert_status
  BEFORE INSERT ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public._enforce_quote_status_transition();

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('_enforce_quote_status_transition', 'public._enforce_quote_status_transition()',
          ARRAY['PUBLIC', 'anon', 'authenticated', 'postgres', 'service_role'],
          'NOT EXISTS (SELECT 1 FROM quote_versions WHERE quote_id = NEW.id)')
      ) AS pin(fn, sig, execs, marker)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc o
             WHERE o.pronamespace = 'public'::regnamespace AND o.proname = pin.fn) <> 1
        OR position(pin.marker IN p.prosrc) = 0
        OR p.proowner <> 'postgres'::regrole
        OR p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END COLLATE "C"
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM pin.execs
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: the re-emitted function lost its change, owner, mode, search_path or grants';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.quotes'::regclass AND NOT tgisinternal
         AND tgfoid = 'public._enforce_quote_status_transition()'::regprocedure
         AND tgenabled IN ('O', 'A')
         AND ((tgname = 'enforce_quote_status_transition' AND tgtype = 19
               AND tgattr::text = (SELECT attnum::text FROM pg_attribute
                                    WHERE attrelid = 'public.quotes'::regclass AND attname = 'status'))
           OR (tgname = 'enforce_quote_insert_status' AND tgtype = 7))) <> 2 THEN
    RAISE EXCEPTION 'POSTFLIGHT: both quote status triggers must be enabled, on their events, and call _enforce_quote_status_transition';
  END IF;
  -- Again under CREATE TRIGGER's table lock: a status change committed after the preflight read is
  -- visible now, and any later one waits for this transaction and then meets the new rule.
  IF EXISTS (SELECT 1 FROM public.quotes q
              WHERE q.status IN ('sent', 'revised')
                AND NOT EXISTS (SELECT 1 FROM public.quote_versions v WHERE v.quote_id = q.id)) THEN
    RAISE EXCEPTION 'POSTFLIGHT: a sent or revised quote has no version; resolve it before applying';
  END IF;
END
$postflight$;
