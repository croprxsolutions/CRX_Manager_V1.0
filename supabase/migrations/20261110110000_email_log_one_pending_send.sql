-- #1302 follow-up: at most one unconfirmed (pending) send of the same email.
--
-- Why: send-email checks for an unconfirmed send before it logs a new one, but the
-- check and the insert are two steps. Two clicks in the same instant, each with its
-- own retry key, can both pass the check and email the customer twice. This puts the
-- rule in the database, where the second insert (or the second retry claim of a
-- failed row) is refused with a unique violation (23505).
--
-- send_lock_key names the email: '<email_type>:<record>:<customer id or "none">',
-- written by send-email. Existing rows keep NULL (live 2026-11-05: 54 rows, all
-- 'sent', none 'pending'), and NULL never conflicts, so no existing row is changed.
-- The live send-email does not write this column yet, so every write it sends today
-- is still accepted; the follow-up send-email change starts filling it.

ALTER TABLE public.email_log ADD COLUMN IF NOT EXISTS send_lock_key text;

COMMENT ON COLUMN public.email_log.send_lock_key IS
  'Which email this row sends (<email_type>:<record>:<customer id or none>), set by send-email. At most one pending row per value (email_log_one_pending_send).';

CREATE UNIQUE INDEX IF NOT EXISTS email_log_one_pending_send
  ON public.email_log (send_lock_key)
  WHERE status = 'pending' AND send_lock_key IS NOT NULL;

-- Refuse to finish if IF NOT EXISTS skipped over a different column or index.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'email_log'
      AND column_name = 'send_lock_key' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'email_log.send_lock_key is missing or not text';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'email_log_one_pending_send'
      AND i.indrelid = 'public.email_log'::regclass
      AND i.indisunique
      AND pg_get_indexdef(i.indexrelid) LIKE '%(send_lock_key)%'
      AND pg_get_expr(i.indpred, i.indrelid) LIKE '%pending%'
  ) THEN
    RAISE EXCEPTION 'email_log_one_pending_send is missing or not the partial unique index on send_lock_key';
  END IF;
END $$;
