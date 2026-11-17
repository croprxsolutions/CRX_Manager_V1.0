## 2026-11-14 - Prepare explicit cleanup of inactive rate history (#1814)

Candidate database unit only. An optional history download includes inactive groups that still have rates or a recorded review decision, with activity labels and separate historical counts. Existing no-argument downloads and active readiness totals keep their current behavior. A compatible workbook screen is a separate dependency.

Mason chose to retain existing approvals until deliberate cleanup. Inactive history can be reopened, a draft deleted or a decision cleared; it cannot receive a fresh approval or new decision. Old workbook files keep their identity and server checks. Current roles, grants, readers, values and automatic history are retained; no backfill or live-rate cutover.

Migration `20270110110000_inactive_rate_review_cleanup.sql` pins four verified predecessor bodies and their access metadata. Its generated response declaration is a source-verified pending overlay until the normal post-apply regeneration. No merge, database apply or deployment has been performed.

Read-only ledger recheck on 2026-11-15 (America/Chicago): 1,207 rows, latest version `20261113011216` named `20270109100000_delivery_receipt_brands`. Each row's timestamped name (version only when no name timestamp exists) gives effective maximum `20270109100000`, below this candidate. The Current State and Known Issues freshness lines reflect this ledger-only recheck; Edge Function and all other dated evidence retain their prior dates.

Backup preflight, 2026-11-15: this unapplied candidate leaves the transaction to the staging/live runner. The local proof reuses the staging runner's file validation and SQL/ledger/hash transaction instead of installing the migration alone; the fresh corrected-file run completed `INACTIVE_RATE_REVIEW_PROOF_PASS`, exit 0. Review helper bodies and grants are unchanged. Normal publication checks and #1868 still apply.
