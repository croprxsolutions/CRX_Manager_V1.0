-- Written 2026-11-10. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270102160000_rup_capture_fk_on_update_cascade.md. Re-read the live ledger before applying.
--
-- WHY: after the REG-1 seed, the capture trigger (20261231210000) writes one invoice_line_rup_captures row per invoice
--   line as the line is inserted. Re-saving a draft or unposted invoice whose lines came from an order
--   (_save_invoice_scoped_impl, 20261118110000) deletes the lines, inserts them again, then moves each order-linked line
--   back to its old id (UPDATE invoice_items SET id = source_item_id). The capture's link to its line was ON UPDATE NO
--   ACTION and not deferrable, so that id move is refused: once the seed runs, every re-save of an order-linked invoice
--   would fail. Found by the Brand PR B session (#1765, section 14.6). Before the seed nothing is captured, so nothing
--   fails today.
--
-- WHAT: the same link, ON UPDATE CASCADE (ON DELETE CASCADE kept). The capture follows its line to the restored id.
--   The foreign-key action fires before trg_zz_capture_invoice_line_rup (triggers fire by name; "RI_..." sorts first),
--   so the capture trigger then finds the line's capture in place, with the same product and number, and keeps it.
--
-- NOT CHANGED: every function, trigger and grant; rup_sales_records (only posted invoices hold active records and a
--   re-save only touches draft or unposted ones); no row is written.
--
-- ROLLBACK (its own reviewed migration): restore the link as ON DELETE CASCADE only (re-breaks the re-save after the seed).
--
-- ORDERING: after 20261231210000_rup_records_by_line (it creates the link). Independent of the seed (20261231220000).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE rup_capture_fk_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.rup_capture_fk_tx') IS NULL THEN
    RAISE EXCEPTION 'RUP_CAPTURE_FK_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.rup_capture_fk_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'RUP_CAPTURE_FK_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'invoice_line_rup_captures_invoice_item_id_fkey'
                    AND conrelid = 'public.invoice_line_rup_captures'::regclass
                    AND confrelid = 'public.invoice_items'::regclass
                    AND contype = 'f' AND confupdtype = 'a' AND confdeltype = 'c' AND NOT condeferrable) THEN
    RAISE EXCEPTION 'PREFLIGHT_RUP_CAPTURE_FK_DRIFT: the capture link is not the one 20261231210000 created (or this file already ran)';
  END IF;
END
$preflight$;

-- Taken up front, in the order a save takes them (lines, then their captures), so a save running during the apply
-- waits instead of deadlocking (drift review M1). Dropping the link takes these locks on both tables anyway.
LOCK TABLE public.invoice_items IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.invoice_line_rup_captures IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.invoice_line_rup_captures
  DROP CONSTRAINT invoice_line_rup_captures_invoice_item_id_fkey,
  ADD CONSTRAINT invoice_line_rup_captures_invoice_item_id_fkey FOREIGN KEY (invoice_item_id)
    REFERENCES public.invoice_items(id) ON DELETE CASCADE ON UPDATE CASCADE;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.invoice_line_rup_captures'::regclass AND contype = 'f') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname = 'invoice_line_rup_captures_invoice_item_id_fkey'
                       AND conrelid = 'public.invoice_line_rup_captures'::regclass
                       AND confrelid = 'public.invoice_items'::regclass
                       AND confupdtype = 'c' AND confdeltype = 'c' AND NOT condeferrable AND convalidated) THEN
    RAISE EXCEPTION 'POSTFLIGHT_RUP_CAPTURE_FK_WRONG';
  END IF;
END
$postflight$;
