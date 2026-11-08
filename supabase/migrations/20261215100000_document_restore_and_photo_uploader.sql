-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261215100000_document_restore_and_photo_uploader.md.
--
-- WHAT (KI-07, KI-26, KI-77):
--   1. KI-07. An active admin may RESTORE a removed customer document. guard_customer_document_update
--      (BEFORE UPDATE on customer_documents) refused every change to a soft-deleted row. It now allows
--      exactly one change to one: deleted_at and deleted_by both cleared, every other column unchanged
--      (updated_at aside, which its own trigger sets), and only when is_admin() is true for the caller.
--      Everything else the guard did is unchanged, word for word. Reps still cannot: their UPDATE policy
--      sees only live rows, and is_admin() is false for them. The service role and the dashboard have no
--      signed-in user, so is_admin() is false there too and they cannot restore through this path.
--      The screen restores with a direct UPDATE under the existing admin policy (no new function).
--   2. KI-77 / KI-26. Delivery photo proof is tied to who took it, the way signatures are
--      (complete_delivery accepts only a signature image whose storage owner_id is the caller). A NEW
--      trigger delivery_photos_uploader_guard (BEFORE INSERT OR UPDATE on delivery_photos):
--        * INSERT by a signed-in user: uploaded_by must be that user, and the file the row names must be
--          in the delivery-photos bucket with storage owner_id = that user (Storage sets owner_id from the
--          uploader's sign-in; no app role can write it). uploaded_at is set to the server clock.
--        * UPDATE by anyone: delivery_id, storage_path, uploaded_by and uploaded_at never change.
--      Rows inserted with no signed-in user (service role, dashboard, migrations) are not checked: the
--      KI-77 note already says storage-rule guarantees do not cover those tools.
--
-- NOT CHANGED: every policy, grant, other function and row. Existing photo rows are not re-checked or
-- edited (their uploaded_by stays as written); no file or row is deleted.
-- The app already uploads the file first and then inserts the row with uploaded_by = the signed-in
-- profile (DeliveryDetail, FieldStop, the Deliveries list's ticket photo), so no screen changes for part 2.
--
-- ROLLBACK (its own reviewed migration): DROP TRIGGER delivery_photos_uploader_guard ON
--   public.delivery_photos; DROP FUNCTION public._guard_delivery_photo_uploader(); and re-create
--   guard_customer_document_update from 20260717013415 (its search_path from 20260722111620).
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.guard_customer_document_update()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
                     WHERE tgrelid = 'public.customer_documents'::regclass
                       AND tgname = 'customer_documents_guard_editable_fields'
                       AND tgfoid = 'public.guard_customer_document_update()'::regprocedure
                       AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'DOC_RESTORE_PREFLIGHT: the customer document guard trigger is missing or moved';
  END IF;
  IF to_regprocedure('public._guard_delivery_photo_uploader()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_photos'::regclass
                  AND tgname = 'delivery_photos_uploader_guard') THEN
    RAISE EXCEPTION 'PHOTO_UPLOADER_PREFLIGHT: this file has already been applied';
  END IF;
  -- The checks below read storage.objects.owner_id as text, as complete_delivery does.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'storage' AND table_name = 'objects'
                    AND column_name = 'owner_id' AND data_type = 'text') THEN
    RAISE EXCEPTION 'PHOTO_UPLOADER_PREFLIGHT: storage.objects.owner_id text is required';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. KI-07: an admin may restore a removed document.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_customer_document_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.customer_id IS DISTINCT FROM NEW.customer_id
     OR OLD.contact_id IS DISTINCT FROM NEW.contact_id
     OR OLD.storage_path IS DISTINCT FROM NEW.storage_path
     OR OLD.filename IS DISTINCT FROM NEW.filename
     OR OLD.mime_type IS DISTINCT FROM NEW.mime_type
     OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
     OR OLD.uploaded_by IS DISTINCT FROM NEW.uploaded_by
     OR OLD.source IS DISTINCT FROM NEW.source
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION
      'customer document identity and provenance are immutable';
  END IF;

  IF OLD.deleted_at IS NOT NULL THEN
    -- KI-07 restore: an active admin clears both removal columns and changes nothing else.
    IF NEW.deleted_at IS NULL
       AND NEW.deleted_by IS NULL
       AND public.is_admin()
       AND (to_jsonb(NEW) - ARRAY['deleted_at', 'deleted_by', 'updated_at'])
         = (to_jsonb(OLD) - ARRAY['deleted_at', 'deleted_by', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'soft-deleted customer documents cannot be modified';
  END IF;

  IF NEW.deleted_at IS NULL AND NEW.deleted_by IS NOT NULL THEN
    RAISE EXCEPTION 'deleted_by requires deleted_at';
  END IF;

  IF NEW.deleted_at IS NOT NULL
     AND NEW.deleted_by IS DISTINCT FROM (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'soft-delete attribution must match the acting user';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_customer_document_update() IS
  'Makes document identity and provenance immutable and enforces one-way attributable soft deletes; an active admin may restore a removed document by clearing deleted_at and deleted_by together (20261215100000, KI-07).';

-- ---------------------------------------------------------------------------------------------
-- 2. KI-77 / KI-26: a delivery photo names the person who uploaded its file.
-- ---------------------------------------------------------------------------------------------
-- DEFINER so the file check sees storage.objects whatever the caller's storage read rules are.
CREATE FUNCTION public._guard_delivery_photo_uploader()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
       OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
       OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
       OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
      RAISE EXCEPTION 'DELIVERY_PHOTO_PROVENANCE_LOCKED: a delivery photo''s delivery, file, uploader and upload time cannot change'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- No signed-in user: service role, dashboard or a migration (KI-77 accepted limit).
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.uploaded_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'DELIVERY_PHOTO_UPLOADER_MISMATCH: a delivery photo is recorded under the person who uploads it'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o
                  WHERE o.bucket_id = 'delivery-photos'
                    AND o.name = NEW.storage_path
                    AND o.owner_id = v_actor::text) THEN
    RAISE EXCEPTION 'DELIVERY_PHOTO_FILE_NOT_YOURS: the photo file must be one you uploaded'
      USING ERRCODE = '23514';
  END IF;
  NEW.uploaded_at := now();
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public._guard_delivery_photo_uploader() OWNER TO postgres;
-- A trigger function: nobody calls it directly.
REVOKE ALL ON FUNCTION public._guard_delivery_photo_uploader() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._guard_delivery_photo_uploader() IS
  'Trigger (20261215100000, KI-77/KI-26): a signed-in insert must name the caller as uploaded_by and a delivery-photos file the caller owns; uploaded_at is the server clock; delivery_id, storage_path, uploaded_by and uploaded_at never change.';

CREATE TRIGGER delivery_photos_uploader_guard
  BEFORE INSERT OR UPDATE ON public.delivery_photos
  FOR EACH ROW EXECUTE FUNCTION public._guard_delivery_photo_uploader();

-- ---------------------------------------------------------------------------------------------
-- Postflight: both changes are in place exactly as intended.
-- ---------------------------------------------------------------------------------------------
DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.guard_customer_document_update()'::regprocedure
                    AND NOT p.prosecdef
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND p.prosrc LIKE '%KI-07 restore%') THEN
    RAISE EXCEPTION 'DOC_RESTORE_POSTFLIGHT: guard_customer_document_update is not as intended';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public._guard_delivery_photo_uploader()'::regprocedure
                    AND p.prosecdef
                    AND p.proowner = 'postgres'::regrole
                    AND p.proconfig = ARRAY['search_path=public, pg_temp'])
     OR has_function_privilege('authenticated', 'public._guard_delivery_photo_uploader()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._guard_delivery_photo_uploader()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._guard_delivery_photo_uploader()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PHOTO_UPLOADER_POSTFLIGHT: the photo guard function is not as intended';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.delivery_photos'::regclass
                    AND tgname = 'delivery_photos_uploader_guard'
                    AND tgfoid = 'public._guard_delivery_photo_uploader()'::regprocedure
                    AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'PHOTO_UPLOADER_POSTFLIGHT: the photo guard trigger is not as intended';
  END IF;
END
$postflight$;
