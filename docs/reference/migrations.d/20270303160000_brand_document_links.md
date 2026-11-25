**LOCAL CANDIDATE — NOT APPLIED.** `20270303160000_brand_document_links.sql` (SQL sha256: `6e98697e4ca82faa2ecacf05d84f538b38f815537fcc7fff988797c5bb135c7b`) adds manufacturer specimen, SDS and supplemental links and their history. Agreeing links carry across when a standalone product joins a group. Conflicting links block grouping or an existing-group size move until an admin reconciles them.

This is a database-first change. The current product screens and workbook remain compatible. If the feature must be withdrawn, land a forward migration that withdraws writes and removes the document identity guards, grouping checks and report transfers. Restore the existing move preflight from `20261201110000_product_parent_review_fixes.sql` if no later migration owns that helper. Keep the stored links and history for recovery.

If the grouping rollback from `20261123120000_product_parent_proposals.sql` is needed, withdraw the document identity guards before it renames legacy brands. Plan how to copy newer documents and unresolved reports back to the restored size brands.

Move comparison pairs active brands by name only after the existing move preflight confirms the brand lists match. The `product_parent_brands_active_name` unique index guarantees one active brand per name per group.

Local proof uses `node scripts/smoke/prove-brand-document-links-real-schema.mjs`. It exercises workbook preview, refusal of identity edits and conflicting documents, and preserving reports through grouping and size moves. On staging, confirm that a deferred grouping conflict rolls back and names the conflicting brand and document in the product setup screen.
