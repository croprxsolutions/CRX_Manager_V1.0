-- KI-160 (part): two stock counts can never correct the same stock row twice.
-- Product Master repair step 2 (To-Do 0.17), contract docs/plans/2026-11-15-product-master-steps-1-3-CONTRACT.md, PR B.
--
-- WHY: _complete_cycle_count_impl adds each item's stored variance to current on-hand. Nothing stopped two
-- in-progress counts holding the same inventory row (or one count holding it twice), so two +10 corrections on a
-- shelf going 90 -> 100 ended at 110. A closed count could also be set back to in progress (or to completed) by a
-- direct admin update and completed or reversed again, applying its variance twice.
--
-- WHAT:
--   1. One in-progress count per warehouse (partial unique index).
--   2. A stock row may sit on only one item of any in-progress count (trigger on cycle_count_items, serialized by a
--      transaction advisory lock on the inventory row, so two concurrent inserts end with exactly one), and only on a
--      line for its own product at the count's warehouse (Complete adjusts that row).
--   3. A count's status only moves forward: in progress -> completed or cancelled, completed -> cancelled (trigger on
--      cycle_counts). That is exactly what complete, cancel and reverse do; the app has no reopen. A completed count
--      cannot be reversed while an open count holds one of its stock rows (the reversal would shift that count's
--      starting stock); same per-row lock as a line claim.
--   4. Signed-in users lose direct UPDATE on cycle_counts and cycle_count_items (table and every column). The app
--      never updates either table directly; saving a line (update_cycle_count_item), complete, cancel and reverse are
--      SECURITY DEFINER RPCs. Without this, an admin's direct write could mark a completed count cancelled with no
--      reversal, or set a line's stored variance to any number, which Complete then adds to on-hand.
--   5. Signed-in users may insert a count line with only the four columns the app sends (cycle_count_id, product_id,
--      inventory_id, expected_qty); the rest take their defaults (not counted, no variance). A direct insert could
--      otherwise arrive already counted with any variance. expected_qty is recomputed from on-hand when a line is saved.
-- The live grants before this file: UPDATE and INSERT on both tables to authenticated (table level), restored by the
-- rollback.
-- NOT HERE (left open in KI-160): the three-request count creation in CycleCounts.tsx (a failed create leaves an
-- empty open count, which Cancel clears).
--
-- EXISTING ROWS (live 2026-11-15, read-only): 17 counts, all cancelled; 0 in progress.
-- PREFLIGHT refuses if any warehouse has two in-progress counts, any stock row is on two in-progress items, or an
-- in-progress line's stock row is not its product at its count's warehouse.
-- ROLLBACK: scripts/smoke/one-open-count-reverse.sql (drops the two triggers, their functions and the index).

SET LOCAL lock_timeout = '10s';
-- Holds off count and line writes until commit, so the preflight's view stays true while the guards are created.
LOCK TABLE public.cycle_counts, public.cycle_count_items IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.cycle_counts WHERE status = 'in_progress'
             GROUP BY warehouse HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PREFLIGHT_OPEN_COUNTS: a warehouse has two in-progress counts; finish or cancel one first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cycle_count_items i JOIN public.cycle_counts c ON c.id = i.cycle_count_id
              WHERE c.status = 'in_progress' AND i.inventory_id IS NOT NULL
              GROUP BY i.inventory_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PREFLIGHT_OPEN_COUNTS: a stock row is on two in-progress count items; finish or cancel one first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cycle_count_items i JOIN public.cycle_counts c ON c.id = i.cycle_count_id
              WHERE c.status = 'in_progress' AND i.inventory_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.inventory s
                                 WHERE s.id = i.inventory_id AND s.product_id = i.product_id AND s.location = c.warehouse)) THEN
    RAISE EXCEPTION 'PREFLIGHT_OPEN_COUNTS: an in-progress count line is not its product at its count''s warehouse; cancel that count first';
  END IF;
  IF to_regprocedure('public._cycle_count_item_one_open_row()') IS NOT NULL
     OR to_regprocedure('public._cycle_count_no_reopen()') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_OPEN_COUNTS: the KI-160 functions already exist';
  END IF;
END;
$preflight$;

CREATE UNIQUE INDEX cycle_counts_one_open_per_warehouse
  ON public.cycle_counts (warehouse) WHERE status = 'in_progress';

CREATE FUNCTION public._cycle_count_item_one_open_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_other text;
BEGIN
  IF NEW.inventory_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.inventory_id IS NOT DISTINCT FROM OLD.inventory_id
         AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id) THEN
    RETURN NEW;
  END IF;
  -- The check below needs a fresh snapshot after the lock, which only READ COMMITTED (every app path) gives.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CYCLE_COUNT_ROW_CLAIM_ISOLATION: count lines can only be added in a read-committed transaction.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Lock the stock row first, as complete and reverse do (FOR UPDATE, then this trigger's lock), so a claim racing
  -- a reversal waits instead of deadlocking (the line's foreign key would take this same row lock later anyway).
  PERFORM 1 FROM public.inventory WHERE id = NEW.inventory_id FOR KEY SHARE;
  -- Serializes every claim on this stock row, so the check below sees a concurrent claim once it commits.
  PERFORM pg_advisory_xact_lock(hashtextextended('cycle_count_inventory:' || NEW.inventory_id::text, 0));
  SELECT c.count_number INTO v_other
    FROM public.cycle_count_items o
    JOIN public.cycle_counts c ON c.id = o.cycle_count_id
   WHERE o.inventory_id = NEW.inventory_id
     AND o.id IS DISTINCT FROM NEW.id
     AND c.status = 'in_progress'
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'CYCLE_COUNT_ROW_ALREADY_OPEN: This stock row is already on open count %; finish or cancel that count first.',
      COALESCE(v_other, '(no number)') USING ERRCODE = 'check_violation';
  END IF;
  -- Complete adjusts the line's stock row, so it must be this line's product at this count's warehouse.
  IF NOT EXISTS (SELECT 1 FROM public.inventory i JOIN public.cycle_counts c ON c.id = NEW.cycle_count_id
                  WHERE i.id = NEW.inventory_id AND i.product_id = NEW.product_id AND i.location = c.warehouse) THEN
    RAISE EXCEPTION 'CYCLE_COUNT_ROW_WRONG_PLACE: This stock row is not this product at this count''s warehouse.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._cycle_count_item_one_open_row() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_cycle_count_item_one_open_row
  BEFORE INSERT OR UPDATE OF inventory_id, product_id ON public.cycle_count_items
  FOR EACH ROW EXECUTE FUNCTION public._cycle_count_item_one_open_row();

CREATE FUNCTION public._cycle_count_no_reopen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_inv uuid;
  v_other text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'in_progress' AND NEW.status IN ('completed', 'cancelled')
              OR OLD.status = 'completed' AND NEW.status = 'cancelled') THEN
    RAISE EXCEPTION 'CYCLE_COUNT_REOPEN_FORBIDDEN: Count % is % and cannot become %; a count only moves forward. Start a new count instead.',
      OLD.count_number, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  -- Reversing a completed count moves its stock rows back. An open count already holding one of those rows
  -- would then complete against the wrong starting stock, so refuse until that count is finished or cancelled.
  IF OLD.status = 'completed' AND NEW.status = 'cancelled' THEN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'CYCLE_COUNT_ROW_CLAIM_ISOLATION: a count can only be reversed in a read-committed transaction.'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The same per-row lock a line claim takes, so a claim committing meanwhile is seen below.
    FOR v_inv IN SELECT DISTINCT inventory_id FROM public.cycle_count_items
                  WHERE cycle_count_id = OLD.id AND inventory_id IS NOT NULL ORDER BY inventory_id LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('cycle_count_inventory:' || v_inv::text, 0));
    END LOOP;
    SELECT c.count_number INTO v_other
      FROM public.cycle_count_items mine
      JOIN public.cycle_count_items o ON o.inventory_id = mine.inventory_id
      JOIN public.cycle_counts c ON c.id = o.cycle_count_id
     WHERE mine.cycle_count_id = OLD.id AND c.id <> OLD.id AND c.status = 'in_progress'
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'CYCLE_COUNT_REVERSE_BLOCKED: Count % shares stock with open count %; finish or cancel that count before reversing this one.',
        OLD.count_number, COALESCE(v_other, '(no number)') USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._cycle_count_no_reopen() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_cycle_count_no_reopen
  BEFORE UPDATE OF status ON public.cycle_counts
  FOR EACH ROW EXECUTE FUNCTION public._cycle_count_no_reopen();

REVOKE UPDATE ON public.cycle_counts FROM PUBLIC, anon, authenticated;
REVOKE UPDATE (id, count_number, warehouse, status, notes, initiated_by, started_at, completed_by, completed_at,
  created_at, item_revision) ON public.cycle_counts FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON public.cycle_count_items FROM PUBLIC, anon, authenticated;
REVOKE UPDATE (id, cycle_count_id, product_id, inventory_id, expected_qty, counted_qty, variance, variance_pct,
  is_counted, counted_by, counted_at, notes, created_at) ON public.cycle_count_items FROM PUBLIC, anon, authenticated;
REVOKE INSERT ON public.cycle_count_items FROM PUBLIC, anon, authenticated;
REVOKE INSERT (id, cycle_count_id, product_id, inventory_id, expected_qty, counted_qty, variance, variance_pct,
  is_counted, counted_by, counted_at, notes, created_at) ON public.cycle_count_items FROM PUBLIC, anon, authenticated;
GRANT INSERT (cycle_count_id, product_id, inventory_id, expected_qty) ON public.cycle_count_items TO authenticated;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_trigger
       WHERE (tgrelid, tgname) IN (('public.cycle_count_items'::regclass, 'trg_cycle_count_item_one_open_row'),
                                   ('public.cycle_counts'::regclass, 'trg_cycle_count_no_reopen'))
         AND tgenabled = 'O') <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_index
                     WHERE indexrelid = to_regclass('public.cycle_counts_one_open_per_warehouse')
                       AND indrelid = 'public.cycle_counts'::regclass AND indisunique
                       AND pg_get_expr(indpred, indrelid) LIKE '%in_progress%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc
                     WHERE oid = 'public._cycle_count_item_one_open_row()'::regprocedure AND prosecdef
                       AND proconfig @> ARRAY['search_path=public, pg_temp'])
     OR has_any_column_privilege('authenticated', 'public.cycle_counts', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.cycle_counts', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.cycle_count_items', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.cycle_count_items', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.cycle_count_items', 'INSERT')
     OR has_table_privilege('authenticated', 'public.cycle_count_items', 'INSERT')
     OR has_column_privilege('authenticated', 'public.cycle_count_items', 'variance', 'INSERT')
     OR has_column_privilege('authenticated', 'public.cycle_count_items', 'is_counted', 'INSERT')
     OR has_column_privilege('authenticated', 'public.cycle_count_items', 'counted_qty', 'INSERT')
     OR NOT has_column_privilege('authenticated', 'public.cycle_count_items', 'expected_qty', 'INSERT') THEN
    RAISE EXCEPTION 'POSTFLIGHT_OPEN_COUNTS: the KI-160 guards are not all in place';
  END IF;
END;
$postflight$;
