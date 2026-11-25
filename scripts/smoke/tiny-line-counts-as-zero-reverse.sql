-- Rollback for 20270307200000_tiny_line_counts_as_zero.sql, proven by
-- scripts/smoke/prove-tiny-line-counts-as-zero-real-schema.mjs.
-- Drops the wrapper and gives the unchanged body its old name back, all or nothing. The forward migration wrote no
-- data; deliveries completed while it was on keep the zeros they were completed with. To use it live, copy it into a new migration through the gates (without BEGIN / COMMIT); never run it by
-- hand against a live database. While it is off, a line under 0.01 beside real lines is delivered and billed as sent.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $installed$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public._complete_delivery_body_impl_20270307(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM 'bbe9c44f7ade7d12f86bfe1c039d16ac'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
          WHERE oid = to_regprocedure('public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
        IS DISTINCT FROM '9a674fe5d2d569fb8202efe2886e104d' THEN
    RAISE EXCEPTION 'TINY_LINE_REVERSE: the tiny-line wrapper and its body are not installed as reviewed; re-plan the rollback';
  END IF;
END
$installed$;
DROP FUNCTION public._complete_delivery_authorized_impl_20270122(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone);
ALTER FUNCTION public._complete_delivery_body_impl_20270307(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone)
  RENAME TO _complete_delivery_authorized_impl_20270122;
COMMIT;
