## 2026-11-24 — Price sheet: problem rows first, plain-English errors

From a full staging round trip of the product price sheet (.xlsx): export, edit, re-upload, apply, restore.
Prices and costs saved exactly; this change is wording and layout only. Nothing that is saved changes.

- Price-sheet preview lists Invalid and Conflict rows first. Unchanged rows fold behind "Show N unchanged rows".
  A "Nothing was saved" notice says how to fix the file. About 15 row codes now read as plain English.
- Plain toasts for a used, expired, old-template or another user's sheet, and for a product listed twice
  (`errorSanitizer.ts`). Plain parser messages for added or deleted rows and for an unreadable file.
- Products: the "Pricing .xlsx" tooltip and toast say the search box does not narrow the file. The file name
  uses the Central business day.
- Margin floor help text now says the price sheet warns about a below-floor price.
- Supplier Pricing: each staged cost shows "per <unit>"; row errors are plain English.
- Partly addresses the KI-204 pricing workbook and supplier quote items. Still open: telling a used sheet apart
  from an expired one, and showing the converted per-unit cost before approval (both need database changes).
