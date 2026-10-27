## 2026-10-27 — Purchase order copy email: post-merge Sol review fixes (To-Do 0.15, PR #1114)

- send-email's purchase order gate now also refuses a PDF whose PO number or order date no longer matches the database. The app sends both in the snapshot, and the gate reads `po_number` and `submitted_date`. It takes effect live only when `send-email` is next deployed (that deploy is still gated on Mason's yes).
- The retry key for the PO copy email counts the status only through the PDF's banner. A submitted and a partly received PO print the same PDF, so a receipt between a lost send and its retry no longer mints a new key and a second email. The fingerprint now also includes the PO number, and it moved to `src/lib/purchaseOrderPdf.ts` (`purchaseOrderPdfFingerprint`) so it can be tested.
- The PO notes box now says "Notes (printed on the PO PDF)": the copy goes only to the company ordering inbox, never to a vendor.
- `docs/reference/migration-history.md` row 995 names the real file, `20261027070000_email_type_purchase_order.sql`.
