## 2026-11-24 - Price sheet: the database can say why an uploaded sheet was refused

- Migration `20270303140000_price_sheet_refusal_reason.sql`: new admin-only, read-only `get_pricing_workbook_export_refusal_reason(uuid)`. Given a price-sheet export id it returns one code: `EXPORT_NOT_FOUND`, `DOWNLOADED_BY_OTHER_USER`, `ALREADY_APPLIED`, `OLD_TEMPLATE` or `EXPIRED` (checked in that order), or `NONE` when the export passes the export-level check (row-level refusals keep their own codes). Another user's sheet reveals nothing beyond "not yours"; no names, dates or prices are returned.
- The preview and apply functions and their existing refusal codes are unchanged; nothing calls the new function yet. The screen half (naming the reason after a refusal) follows after the pricing follow-up PR merges.
- Contract: `docs/plans/2026-11-24-price-sheet-refusal-reason-CONTRACT.md`.
- Proof: `node scripts/smoke/prove-price-sheet-refusal-reason-real-schema.mjs` (`PRICE_SHEET_REFUSAL_REASON_PROOF_PASS`, local Docker).
- Not verified: the staging database (applied by the staging DB job after merge).
