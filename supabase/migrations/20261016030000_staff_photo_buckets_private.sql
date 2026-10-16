-- Staff photos: make the three photo buckets private (Goal 1, docs/plans/2026-10-13-direction-and-goals.md;
-- Mason 2026-10-13: delivery, receiving and team-note photos need a sign-in to view).
--
-- Step 2 of 2. Step 1 (20261015230000_staff_photo_storage_access, applied live 2026-10-15 21:06 UTC,
-- PR #929) added the per-request storage read, upload and delete policies, and the app released with
-- it downloads every photo with the signed-in user's session. The buckets stayed public so app copies
-- installed before that release kept working. This file sets delivery-photos, receiving-photos and
-- team-note-attachments to public = false, so Storage's public object endpoint stops serving them and
-- a copied public link no longer opens a photo. Viewing then goes only through the step 1 read
-- policies (an active staff sign-in with the right role).
--
-- Live state measured read-only immediately before this file was written (2026-10-15 UTC):
--   * the three buckets are public, 10 MB cap, image-only MIME list (20260615182721); no other
--     setting changes here.
--   * storage.buckets: owned by supabase_storage_admin, row-level security on, NO policy, so no app
--     role can change a bucket; postgres (BYPASSRLS) holds UPDATE. Its triggers guard only the
--     bucket name, lifecycle columns and deletes; none fires on an UPDATE of public.
--   * The app (main after PR #929) never loads a photo through its public URL: DeliveryDetail,
--     FieldStop and the team board download through usePrivatePhoto / PrivatePhoto, and receipt
--     emails carry no photos (Mason, 2026-10-14). The stored image_url / file_url values stay as they
--     are: the app reads only the object path out of them (src/lib/privatePhotos.ts), and
--     getPublicUrl, which builds that string, makes no network call. No Edge Function reads these
--     buckets.
--   * public.team_note_attachments: 0 rows; no unique index on file_url.
--
-- Also in this file (Codex Sol MED on PR #929, deferred here): two team_note_attachments rows could
-- name the same file in the uploader's own folder, and deleting either row removes the file the other
-- still names. A unique index on file_url makes one row per file. Step 1's insert policy already
-- pins file_url to exactly one canonical public URL per object, so one URL means one file.
--
-- Behavior change to note: an app copy installed before PR #929 (2026-10-15) still shows photos by
-- their public URL; after this file those photos show as broken images until that copy reloads the
-- current release. Uploads from such a copy keep working (the policies, not the bucket flag, decide).
--
-- Not destructive: no row, object or policy is changed or removed; one bucket flag per bucket and one
-- new index. Access-changing (bucket visibility), so it needs Mason's own approval of this file.
-- Rollback: UPDATE storage.buckets SET public = true WHERE id IN ('delivery-photos',
-- 'receiving-photos', 'team-note-attachments'); DROP INDEX public.team_note_attachments_file_url_key;
-- sql-safety: exempt — storage.buckets is a Supabase-managed table (not in the public schema
-- registry); public is its real column.

-- Lock first so nothing changes between the preflight and the changes. The timeout keeps a long
-- storage transaction from parking every storage read behind this file: it fails fast and can be re-run.
SET LOCAL lock_timeout = '5s';
LOCK TABLE storage.buckets, storage.objects, public.team_note_attachments IN SHARE ROW EXCLUSIVE MODE;

-- Preflight: step 1 must be in place exactly as applied (a private bucket with no read policy would
-- hide every photo from everyone), the buckets must still be public, and no two rows may share a file.
DO $preflight$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  -- Step 1's eleven policies, pinned to the text 20261015230000's verify block checked at apply.
  FOR v_pin IN SELECT * FROM (VALUES
    ('storage', 'objects', 'staff_photos_delivery_select', '90f32dc6545185303ce7388cef4c2df1'),
    ('storage', 'objects', 'staff_photos_receiving_select', '8f1d00d9e18358df1e9a6238ff96538f'),
    ('storage', 'objects', 'staff_photos_team_note_select', '27cfe714de7b43154732c07162393db4'),
    ('storage', 'objects', 'delivery_photos_insert', '77226f37b06516baf3fa3d72b43b2b80'),
    ('storage', 'objects', 'delivery_photos_delete', '18eaabc7bfae3c43d6b922f8b24c6ac4'),
    ('storage', 'objects', 'recv_photos_storage_upload', '49d68cd4f3a03332c5658e15ab30d8c6'),
    ('storage', 'objects', 'recv_photos_storage_delete', '11e5f2acbee2538208d484c955df1aae'),
    ('storage', 'objects', 'Authenticated users can upload team note attachments', '2591f94e1b2b6a55126914a4868fecf1'),
    ('storage', 'objects', 'Users can delete own team note attachments', '23557263186d9cbcd1d27ae89d184e04'),
    ('public', 'delivery_photos', 'del_photos_select', '106bd925a2a96c428f96a21261d44410'),
    ('public', 'team_note_attachments', 'Authenticated users can insert own attachments', '5c30ffc8fc80002944e161c929b63b7e')
  ) AS t(schema_name, table_name, policy_name, pin) LOOP
    SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))
      INTO v_md5
      FROM pg_policies
     WHERE schemaname = v_pin.schema_name AND tablename = v_pin.table_name AND policyname = v_pin.policy_name
       AND permissive = 'PERMISSIVE';
    IF v_md5 IS DISTINCT FROM v_pin.pin THEN
      RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_PREFLIGHT: %.% policy "%" is missing or not as step 1 applied it (md5 %)',
        v_pin.schema_name, v_pin.table_name, v_pin.policy_name, v_md5;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM storage.buckets
       WHERE id IN ('delivery-photos', 'receiving-photos', 'team-note-attachments') AND public) <> 3 THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_PREFLIGHT: the three photo buckets must exist and still be public; this file has already been applied or a bucket changed';
  END IF;

  IF to_regclass('public.team_note_attachments_file_url_key') IS NOT NULL THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_PREFLIGHT: team_note_attachments_file_url_key already exists';
  END IF;

  IF EXISTS (SELECT file_url FROM public.team_note_attachments GROUP BY file_url HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_PREFLIGHT: two or more team_note_attachments rows name the same file; resolve them first';
  END IF;
END
$preflight$;

UPDATE storage.buckets
   SET public = false
 WHERE id IN ('delivery-photos', 'receiving-photos', 'team-note-attachments');

CREATE UNIQUE INDEX team_note_attachments_file_url_key ON public.team_note_attachments (file_url);

-- Verify inside the same transaction; any mismatch rolls the whole file back.
DO $verify$
BEGIN
  IF (SELECT count(*) FROM storage.buckets
       WHERE id IN ('delivery-photos', 'receiving-photos', 'team-note-attachments') AND public IS FALSE) <> 3 THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_VERIFY: the three photo buckets are not all private';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = 'public.team_note_attachments_file_url_key'::regclass
      AND i.indrelid = 'public.team_note_attachments'::regclass
      AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnkeyatts = 1
      AND i.indkey[0] = (SELECT attnum FROM pg_attribute
                          WHERE attrelid = 'public.team_note_attachments'::regclass AND attname = 'file_url')
  ) THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_VERIFY: team_note_attachments_file_url_key is not a valid unique index on file_url alone';
  END IF;
END
$verify$;
