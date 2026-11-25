**LOCAL CANDIDATE — NOT APPLIED.** `20270307070000_preserve_brand_document_reports.sql` (SQL sha256: `69a8095c2289e937135e581719bf2bf65baf6f0d18c4c5c5ff7220854cae1f8e`) keeps an open report when an admin changes a supplemental label's state or expiration without changing its normalized URL.

The existing document save validates the same versions and request keys. Its private helper keeps the prior owner and grants. Replacing the URL, withdrawing the link, or closing the report still resolves it. A forward rollback can restore the helper body from `20270306170000_brand_document_links.sql` and retains all saved history.

Run `node scripts/smoke/prove-brand-document-links-real-schema.mjs` in a disposable database. Check the report and original reporter after a date-only edit, and verify that replacing a URL still resolves its report.
