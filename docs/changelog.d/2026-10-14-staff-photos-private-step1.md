## 2026-10-14 — Goal 1: staff photos need a staff sign-in (step 1 of 2)

Second of the three Goal 1 security fixes (`docs/plans/2026-10-13-direction-and-goals.md`; Mason
2026-10-13: delivery, receiving and team-note photos need a sign-in to view).

**The hole.** The three photo buckets are public: anyone holding a photo's link can open it with no
sign-in, forever. Any signed-in account, even a deactivated one with an unexpired token, could upload
to all three. The customer receipt email embedded the photo links.

**Step 1 (this change).** The buckets stay public. The migration is applied before the app ships
(the new screens download through its read policies), so the old app and the new one both work.
- Migration `20261014230000_staff_photo_storage_access.sql`: storage read policies by role
  (delivery photos: admins, reps, the assigned active driver; receiving photos: admins and reps;
  team-note photos: active staff, not commission-recipient profiles); uploads and deletes narrowed to
  the same roles (a delivery photo's file is deleted by an admin only, like its record); the
  team-note delete now reads the right folder; the delivery-photo row policy
  requires an active driver. It locks with a 5-second timeout, pins every policy it changes before
  and after (exact text), and refuses any storage policy that does not test a bucket.
- The app shows photos through `src/hooks/usePrivatePhoto.ts` and `src/components/ui/PrivatePhoto.tsx`:
  it downloads each photo with the signed-in user's session and shows a tab-local `blob:` address,
  never a storage URL. For field signal: a dropped download ends in a tap-to-retry tile (not an
  endless spinner), retries by itself when the phone is back online, and is cancelled when the photo
  leaves the screen. Downloads bypass the browser cache (and new uploads are stored uncacheable), so
  the read policy decides every view, even on a shared device. A full-size in-app viewer (with zoom) replaces opening the URL in a new window
  and reuses the thumbnail's download; Escape closes only the viewer, not the note it was opened from.
  `DeliveryDetail.tsx`, `FieldStop.tsx` and `NoteAttachments.tsx` use it. A note owner sees Delete
  only on photos they uploaded (or as admin), matching the storage and table rules.
- The customer receipt email (shared helper and both inline copies in `DeliveryDetail.tsx`) no
  longer has a photo section, and the delivery screen's help text says so (Mason, 2026-10-14).
- `DECISION_LOG.md` records Mason's Goal 1 answers, including option A: a staff member allowed to
  view a photo can still deliberately mint a temporary share link through the storage API (accepted
  limitation). `KNOWN_ISSUES.md` updates the photo entry; `code-patterns.md` the photo pattern.

**Found while proving it.** Storage deletes as the signed-in user, and a DELETE only reaches rows that
user may also read. With no storage read policy, no delete in these buckets removed anything, even an
admin's, which is why "deleted" team-note photos left orphan files. Step 1 fixes it; after apply,
permitted deletes really remove the file.

**Step 2 (next change).** Once this release is live and old installed-app copies have updated, a
small migration sets the three buckets private so old public links stop working.

**Proof.** `scripts/smoke/prove-staff-photo-storage-access-real-schema.mjs` builds the production
schema in a disposable database (storage modeled as live, including `storage.protect_delete`) and
runs 44 role cases (download, upload, delete) before and after, plus a drifted-policy refusal, a
re-apply refusal and a mutation check; it also runs the new live chain
`scripts/smoke/smoke-staff_photo_storage_access.sql` (spec `staff_photo_storage_access`), which fails
before the migration and passes after. Live read-only checks 2026-10-14: every storage policy names a
bucket, the role helpers are hardened, and all 12 `delivery_photos.storage_path` values match a stored
object. Unit tests: `src/lib/privatePhotos.test.tsx` (path parsing, session download, blob release,
abort on unmount, refusal placeholder, dropped-connection retry, back-online retry, viewer reuse,
Escape inside a dialog) and `src/lib/deliveryCompletionEmail.test.ts` (no image or storage link).

The team board shows a note's photos and its Add Photos button only to active admins, sales reps,
drivers and applicators, the same set the team-note storage rules allow
(`canUseTeamNotePhotos` in `src/lib/privatePhotos.ts`). An entity-recipient service login no
longer sees an upload button that would always be refused.
