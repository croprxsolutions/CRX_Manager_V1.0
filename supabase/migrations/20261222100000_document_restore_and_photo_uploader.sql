-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261222100000_document_restore_and_photo_uploader.md.
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
--      A NEW table customer_document_restores, written only by the NEW trigger
--      customer_documents_record_restore, keeps who removed and who restored each document, since the
--      restore clears deleted_by. soft_delete_customer_document gains one check: a retried removal whose
--      document an admin has restored since raises CUSTOMER_DOCUMENT_RESTORED instead of replaying "removed".
--   2. KI-77 / KI-26. Delivery photo proof is tied to who uploaded the file, the way signatures are
--      (complete_delivery accepts only a signature image whose storage owner_id is the caller). A NEW
--      trigger delivery_photos_uploader_guard (BEFORE INSERT OR UPDATE on delivery_photos):
--        * INSERT by a signed-in user: uploaded_by must be that user, and the file the row names must be
--          in the delivery-photos bucket with storage owner_id = that user (Storage sets owner_id from the
--          uploader's sign-in; no app role can write it). uploaded_at is set to the file's upload time.
--        * UPDATE by anyone: delivery_id, storage_path, uploaded_by and uploaded_at never change.
--      Rows inserted with no signed-in user (service role, dashboard, migrations) are not checked: the
--      KI-77 note already says storage-rule guarantees do not cover those tools.
--
-- NOT CHANGED: every existing policy, grant, other function and row. Existing photo rows are not re-checked or
-- edited (their uploaded_by stays as written); no file or row is deleted.
-- The app already uploads the file first and then inserts the row with uploaded_by = the signed-in
-- profile (DeliveryDetail, FieldStop, the Deliveries list's ticket photo), so no screen changes for part 2.
--
-- ROLLBACK (its own reviewed migration): DROP TRIGGER delivery_photos_uploader_guard ON
--   public.delivery_photos; DROP FUNCTION public._guard_delivery_photo_uploader(); DROP TRIGGER
--   customer_documents_record_restore ON public.customer_documents; DROP FUNCTION
--   public._record_customer_document_restore(); keep table customer_document_restores (it holds records);
--   re-create soft_delete_customer_document from 20261013220000; and re-create
--   guard_customer_document_update and its COMMENT from 20260717013415 (its search_path from 20260722111620).
--
-- ORDERING: apply after every older pending migration.
--
-- idempotency-body-check: exempt — soft_delete_customer_document (re-emitted from 20261013220000 with
-- one added replay check) DOES enforce p_idempotency_key: it requires the key, calls
-- public.check_idempotency_intent (advisory lock + actor/intent comparison + replay) BEFORE any
-- mutation, and writes its bound receipt with a direct INSERT INTO public.idempotency_keys
-- (request_actor_id, request_fingerprint), as 20260921180000 documents.

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
  -- The body being replaced is the one 20260921180000 pinned; anything else is drift to look at first.
  IF (SELECT md5(replace(prosrc, E'\r\n', E'\n')) FROM pg_proc WHERE oid = 'public.guard_customer_document_update()'::regprocedure)
     IS DISTINCT FROM '49056708bdd24900db157ef617d763b3' THEN
    RAISE EXCEPTION 'DOC_RESTORE_PREFLIGHT: guard_customer_document_update is not the expected 20260717013415 body';
  END IF;
  IF to_regprocedure('public._guard_delivery_photo_uploader()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_photos'::regclass
                  AND tgname = 'delivery_photos_uploader_guard') THEN
    RAISE EXCEPTION 'PHOTO_UPLOADER_PREFLIGHT: this file has already been applied';
  END IF;
  IF to_regclass('public.customer_document_restores') IS NOT NULL
     OR to_regprocedure('public._record_customer_document_restore()') IS NOT NULL THEN
    RAISE EXCEPTION 'DOC_RESTORE_PREFLIGHT: the restore record table or its trigger function already exists';
  END IF;
  IF to_regprocedure('public.soft_delete_customer_document(uuid, uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'DOC_RESTORE_PREFLIGHT: soft_delete_customer_document(uuid, uuid, text) is missing';
  END IF;
  -- The checks below read storage.objects.owner_id as text, as complete_delivery does.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'storage' AND table_name = 'objects'
                    AND column_name = 'owner_id' AND data_type = 'text') THEN
    RAISE EXCEPTION 'PHOTO_UPLOADER_PREFLIGHT: storage.objects.owner_id text is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'storage' AND table_name = 'objects'
                    AND column_name = 'created_at' AND data_type = 'timestamp with time zone') THEN
    RAISE EXCEPTION 'PHOTO_UPLOADER_PREFLIGHT: storage.objects.created_at timestamptz is required';
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
  'Makes document identity and provenance immutable and enforces one-way attributable soft deletes; an active admin may restore a removed document by clearing deleted_at and deleted_by together (20261222100000, KI-07).';

-- 1b. A restore clears deleted_at and deleted_by, so the database keeps its own record of each
--     restore: who removed the document and when, and who restored it and when. Written only by the
--     trigger below; nobody can insert, change or delete a row through the API.
CREATE TABLE public.customer_document_restores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.customer_documents(id),
  customer_id uuid NOT NULL,
  removed_at timestamptz NOT NULL,
  removed_by uuid,
  restored_at timestamptz NOT NULL DEFAULT now(),
  restored_by uuid NOT NULL
);
CREATE INDEX customer_document_restores_document_id_idx ON public.customer_document_restores (document_id);
ALTER TABLE public.customer_document_restores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_document_restores FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.customer_document_restores TO authenticated;
CREATE POLICY customer_document_restores_admin_select ON public.customer_document_restores
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
COMMENT ON TABLE public.customer_document_restores IS
  'One row per restore of a removed customer document (20261222100000, KI-07): the removal it undid and who restored it. Written only by trigger customer_documents_record_restore; admins read it.';

-- DEFINER so the trigger can write the record the restoring admin cannot write directly.
CREATE FUNCTION public._record_customer_document_restore()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.customer_document_restores (document_id, customer_id, removed_at, removed_by, restored_by)
  VALUES (NEW.id, NEW.customer_id, OLD.deleted_at, OLD.deleted_by, auth.uid());
  RETURN NULL;
END;
$function$;

ALTER FUNCTION public._record_customer_document_restore() OWNER TO postgres;
-- A trigger function: nobody calls it directly.
REVOKE ALL ON FUNCTION public._record_customer_document_restore() FROM PUBLIC, anon, authenticated, service_role;

-- Fires only after guard_customer_document_update accepted the restore (an active admin, so auth.uid() is set).
CREATE TRIGGER customer_documents_record_restore
  AFTER UPDATE OF deleted_at ON public.customer_documents
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION public._record_customer_document_restore();

-- 1c. soft_delete_customer_document: unchanged from 20261013220000 except one check in the replay
--     branch, so a retried removal never reports "removed" for a document an admin restored since.
--     CREATE OR REPLACE keeps its owner and grants.
CREATE OR REPLACE FUNCTION public.soft_delete_customer_document(p_document_id uuid, p_customer_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_is_admin boolean;
  v_fingerprint text;
  v_replay jsonb;
  v_customer_id uuid;
  v_deleted_at timestamptz;
  v_result jsonb;
  v_helper_detail text;
BEGIN
  -- Who is calling. All of this runs BEFORE any receipt is looked at.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Authentication required';
  END IF;

  -- Same predicates as is_admin() / is_sales_rep(): active profiles only.
  -- FOR SHARE holds off a concurrent deactivation or role change until this
  -- (permanent) removal has committed or rolled back.
  SELECT p.role = 'admin'
    INTO v_is_admin
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.role IN ('admin', 'sales_rep')
     AND p.is_active = true
     FOR SHARE;
  IF v_is_admin IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: Only active admins and sales reps can remove customer documents';
  END IF;

  IF p_idempotency_key IS NULL
     OR length(p_idempotency_key) > 255
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: soft_delete_customer_document requires a p_idempotency_key of at most 255 characters';
  END IF;

  IF p_document_id IS NULL OR p_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  -- The actor, the document AND its customer are the whole request. The
  -- customer is in the fingerprint as well as the WHERE clause, so the same
  -- key cannot be replayed against a different customer.
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'customer_id', p_customer_id,
    'document_id', p_document_id
  )::text, 'UTF8'), 'sha256'), 'hex');

  -- Takes pg_advisory_xact_lock on the key for the rest of this transaction
  -- and replays only a receipt bound to THIS actor and THIS document.
  -- The helper's IDEMPOTENCY_INTENT_MISMATCH carries the committed receipt in
  -- DETAIL. Here that receipt names an earlier document and customer the
  -- caller may no longer be allowed to see (a key reused on another document
  -- after a reassignment), so it is re-raised with the same message and
  -- SQLSTATE but no DETAIL. The page keys per document and never hits this.
  --
  -- The scrub is STRUCTURAL: no path below re-raises the helper's exception, so
  -- the DETAIL can never reach a client, and leak safety does NOT depend on the
  -- helper's message text. That is deliberate. An earlier revision of this
  -- round classified by message and called bare RAISE for the non-mismatch
  -- case; a later re-emit of the helper that renamed or prefixed its 22023
  -- message would then have leaked the receipt (rls-security-reviewer M1,
  -- 2026-09-23). The message is now used ONLY to pick which token to answer
  -- with, so a drifted message mislabels a fault and leaks nothing.
  --
  -- starts_with(), NOT LIKE: `_` is a LIKE single-character wildcard, so
  -- 'IDEMPOTENCY_INTENT_MISMATCH%' also matches 'IDEMPOTENCYxINTENTyMISMATCH'
  -- (measured on live 2026-09-23, both operators, same round).
  --
  -- Read from the live installed definition 2026-09-23: the helper's only 22023
  -- raises are its two IDEMPOTENCY_INTENT_MISMATCH branches, and
  -- IDEMPOTENCY_ACTOR_MISMATCH and IDEMPOTENCY_CROSS_OP_KEY_REUSE carry no
  -- ERRCODE (P0001), so the FAULT branch is unreachable today. The prover
  -- drives it anyway with a shadow helper, because a security branch no test
  -- can reach is a branch whose first execution is its first test.
  BEGIN
    v_replay := public.check_idempotency_intent(
      p_idempotency_key, 'soft_delete_customer_document', v_actor, v_fingerprint
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    -- Keep the diagnostic on the SERVER side of the boundary, where it is not
    -- an oracle. Without this a real key collision leaves no record anywhere.
    GET STACKED DIAGNOSTICS v_helper_detail = PG_EXCEPTION_DETAIL;
    RAISE LOG 'soft_delete_customer_document: idempotency helper raised 22023 (%); detail: %',
      SQLERRM, coalesce(v_helper_detail, '(none)');
    IF starts_with(SQLERRM, 'IDEMPOTENCY_INTENT_MISMATCH') THEN
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH: This idempotency key was already used for a different request'
        USING ERRCODE = '22023';
    END IF;
    -- Any OTHER 22023 is an internal fault, not a client replay problem. A
    -- distinct token keeps the page from showing "we do not know whether your
    -- removal happened" for a failure that provably happened before the UPDATE.
    RAISE EXCEPTION 'IDEMPOTENCY_HELPER_FAULT: The idempotency check failed before anything was removed'
      USING ERRCODE = '22023';
  END;
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object'
       OR v_replay -> 'result' ->> 'customer_id' IS NULL
       OR v_replay -> 'result' ->> 'document_id' IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID: The stored receipt for this request is unusable';
    END IF;
    -- The fingerprint already binds BOTH ids, so these can only fail for a
    -- receipt written by an older version of this function or inserted by hand
    -- as postgres. Both are checked, not just the customer: a receipt naming
    -- another document would otherwise return a success envelope claiming that
    -- OTHER document was removed (migration-drift-reviewer L1, 2026-09-23).
    IF (v_replay -> 'result' ->> 'customer_id')::uuid IS DISTINCT FROM p_customer_id
       OR (v_replay -> 'result' ->> 'document_id')::uuid IS DISTINCT FROM p_document_id THEN
      RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
    END IF;
    -- Reps remove documents of ANY customer (Mason, 2026-10-13); the replay's
    -- assigned-rep re-check is removed by 20261013220000.
    -- KI-07 (20261222100000): an admin may have restored the document after this removal
    -- committed. Replaying the old receipt would tell the caller it is removed while it is live.
    IF NOT EXISTS (SELECT 1 FROM public.customer_documents d
                    WHERE d.id = p_document_id AND d.deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'CUSTOMER_DOCUMENT_RESTORED: An admin restored this document after your removal; it is still on file';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- One statement: find the active document and lock it (document FOR UPDATE,
  -- customer FOR SHARE). Reps remove documents of ANY customer (Mason,
  -- 2026-10-13; 20261013220000 removed the assignment test). Missing and
  -- removed are one error.
  SELECT d.customer_id
    INTO v_customer_id
    FROM public.customer_documents d
    JOIN public.customers c ON c.id = d.customer_id
   WHERE d.id = p_document_id
     AND d.customer_id = p_customer_id
     AND d.deleted_at IS NULL
     FOR UPDATE OF d
     FOR SHARE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  -- guard_customer_document_update still fires and requires deleted_by to be
  -- auth.uid(), which v_actor is.
  UPDATE public.customer_documents
     SET deleted_at = now(),
         deleted_by = v_actor
   WHERE id = p_document_id
     AND deleted_at IS NULL
  RETURNING deleted_at INTO v_deleted_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'customer_id', v_customer_id,
    'deleted_at', v_deleted_at
  );

  -- The receipt, bound to the actor and the request. No row can exist for this
  -- key here: check_idempotency_intent returned NULL under the advisory lock.
  INSERT INTO public.idempotency_keys (
    idempotency_key, operation, result, request_actor_id, request_fingerprint
  ) VALUES (
    p_idempotency_key, 'soft_delete_customer_document', v_result, v_actor, v_fingerprint
  );

  RETURN v_result;
END;
$function$;

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
  v_file_created timestamptz;
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
  SELECT o.created_at INTO v_file_created
    FROM storage.objects o
   WHERE o.bucket_id = 'delivery-photos'
     AND o.name = NEW.storage_path
     AND o.owner_id = v_actor::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELIVERY_PHOTO_FILE_NOT_YOURS: the photo file must be one you uploaded'
      USING ERRCODE = '23514';
  END IF;
  -- The file's folder and reuse are not checked here: complete_delivery accepts only a photo in its own
  -- delivery's folder, and smoke-delivery-completion-evidence.sql files misplaced and shared rows on
  -- purpose to prove that. The upload time is the file's own, so a reused file never looks new.
  NEW.uploaded_at := coalesce(v_file_created, now());
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public._guard_delivery_photo_uploader() OWNER TO postgres;
-- A trigger function: nobody calls it directly.
REVOKE ALL ON FUNCTION public._guard_delivery_photo_uploader() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._guard_delivery_photo_uploader() IS
  'Trigger (20261222100000, KI-77/KI-26): a signed-in insert must name the caller as uploaded_by and a delivery-photos file the caller owns; uploaded_at is the file''s own upload time; delivery_id, storage_path, uploaded_by and uploaded_at never change.';

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
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.customer_document_restores'::regclass AND c.relrowsecurity)
     OR has_table_privilege('anon', 'public.customer_document_restores', 'SELECT')
     OR has_table_privilege('authenticated', 'public.customer_document_restores', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR NOT has_table_privilege('authenticated', 'public.customer_document_restores', 'SELECT') THEN
    RAISE EXCEPTION 'DOC_RESTORE_POSTFLIGHT: customer_document_restores access is not as intended';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public._record_customer_document_restore()'::regprocedure
                    AND p.prosecdef
                    AND p.proowner = 'postgres'::regrole
                    AND p.proconfig = ARRAY['search_path=public, pg_temp'])
     OR has_function_privilege('authenticated', 'public._record_customer_document_restore()', 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
                     WHERE tgrelid = 'public.customer_documents'::regclass
                       AND tgname = 'customer_documents_record_restore'
                       AND tgfoid = 'public._record_customer_document_restore()'::regprocedure
                       AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'DOC_RESTORE_POSTFLIGHT: the restore record trigger is not as intended';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.soft_delete_customer_document(uuid, uuid, text)'::regprocedure
                    AND p.prosecdef
                    AND p.prosrc LIKE '%CUSTOMER_DOCUMENT_RESTORED%')
     OR NOT has_function_privilege('authenticated', 'public.soft_delete_customer_document(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.soft_delete_customer_document(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'DOC_RESTORE_POSTFLIGHT: soft_delete_customer_document is not as intended';
  END IF;
END
$postflight$;
