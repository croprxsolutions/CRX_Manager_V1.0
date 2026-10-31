-- STATUS: NOT APPLIED
-- Retire the eight-argument allocate_payment overload authored in 20260222200000.
-- No migration on file drops it, but it is absent live: the only live overload has
-- ten arguments (read-only catalog check, 2026-10-31). This is a no-op on production
-- and records that retirement before 20261029160200 replaces the ten-argument function.
DROP FUNCTION IF EXISTS public.allocate_payment(uuid, bigint, jsonb, text, text, text, uuid, text);
