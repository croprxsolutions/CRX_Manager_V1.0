## 2026-11-01 - No more false "Unsaved Changes" prompt after saving or opening a record

Saving a new record showed "Unsaved Changes" over work that was already saved, and opening some records and leaving untouched showed it too.

- **After a save:** Product, Customer, Application Service, Job, New Delivery, New Purchase Order and Vehicle now use the `skipUnsavedPromptRef` pattern already on QuoteBuilder, InvoiceDetail and FieldApplicationInvoice. Job's Transfer to Invoice is unchanged: it only shows on a completed job, whose form is fully locked, so it cannot have unsaved edits.
- **After a load:** Customer, Field, Application Service and Vehicle armed their change-tracking on a timer that can fire before the page sees a read, so the read counted as an edit. Each now remembers what it loaded and does not count that as a change. Customer also treats what it just saved as the new baseline.
- **Proof:** in the private test app, before the fix all seven pages prompted on every save (6 of 6 on Product). After it, 0 of 17 saves prompted, plain opens were quiet, and real edits still prompted on every page tested. `ProductDetail.saveNavigation.test.tsx` fails with the fix removed.
