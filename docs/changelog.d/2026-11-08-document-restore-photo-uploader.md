## 2026-11-08 — Admins can reopen and restore removed customer documents; delivery photos are tied to who uploaded them

- KI-07: on a customer's Documents tab an admin can switch to "Show removed documents", download a removed
  document and restore it. The `customer-document-files` Edge Function serves a removed document to an admin
  only (needs a deploy); reps still get "no longer available". New migration
  `20261222100000_document_restore_and_photo_uploader.sql` lets the database accept the restore from an
  active admin only, keeps each restore in a new admin-readable table `customer_document_restores` (who
  removed it, who restored it), and makes a retried removal after a restore fail instead of reporting "removed".
- KI-77 / KI-26: the same migration refuses a delivery photo record that names someone other than the
  signed-in uploader, or whose file someone else uploaded, and freezes a photo's uploader, time, file and
  delivery afterwards. The recorded upload time is the file's own upload time. Old photo rows are not changed.
