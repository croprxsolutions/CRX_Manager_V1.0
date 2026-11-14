# Chemical sales quoting and invoicing gauntlet

**Verdict: COMPLETE WITH FINDINGS — scoped chemical sales run.** Baseline `a52195dbeb4a4cba6b0b6eacfe3945930f9a7ebc`, verified against current `origin/main` on November 14, 2026. This completes the previously blocked test setup and historical-proof work. It does not mark the whole-app numbered foundation queue complete. Field application, application jobs and application billing are excluded.

## Observed proof

| Check | Observed result |
|---|---|
| Selected quote, invoice, pricing, PDF and related unit/component suites | 1,899 tests passed across 113 files in the initial audit; unchanged application source |
| Selected live read-only diagnostics | Nine passed with zero violations; a selected subset, not the full global sweep gate |
| Existing invoice-brand proof | 28 scenarios passed in disposable PostgreSQL |
| Existing order-invoice delivered-cap proof | Passed, including racing saves and retry limits; historical candidate scope |
| Repaired delivery-invoice cap proof | Passed defect reproduction, expected ordering refusal, valid delivery/invoice chains, concurrent writers and mutation checks; historical candidate scope |
| Repaired quote pricing proof, `--chemical-sales` | Passed candidate-era chains and 13 applicable mutation checks; frozen fixture with recorded provenance; field/job cases excluded |
| Fresh isolated current-schema build | Passed at 10:06 a.m. CST: 287 selected migrations, 1,207 ledger rows; sealed Docker network; local storage enabled |
| Current-schema SQL checks | Nine rolled-back chains passed: conversion, quote versions/expiry/customer saves, booked prices/overdraw, unchanged invoice cents/cost and charge lines |
| Browser admin journey | Passed saved/reloaded quote, quote PDF, presentation/version, conversion plus retry, signed delivery/storage, exact stock reduction, auto draft, save/reload, stale-tab post refusal, post plus retry, invoice PDF, unpost/repost/void and separate draft cancellation |
| Browser rep journey | Passed separate rep logins, own quote saves and server refusal of an unrelated rep edit without changing the saved quote |
| PDF inspection | Downloaded quote and invoice text matched customer, product, quantity and $24.68 total; both rendered and visually inspected |
| Setup refusal tests | Both default and sales profiles passed; separate state/ports/ownership and unsupported input refusal |
| Toolchain | Typecheck, lint, build, agent guidance and focused historical-scope tests passed; delivery checks recorded in the PR |

Run the repeatable current-schema checks with `node scripts/local-app/sales.mjs rebuild`, then `node scripts/local-app/sales.mjs test`. The latter runs nine SQL chains followed by two real browser tests. The fixed profile owns only `crx-sales-gauntlet`; it preserves the existing default stack. CLI rebuild requires a matching Supabase launcher and companion, both version 2.109.1. Private generated credentials, PDFs and browser captures stay under ignored `.state/sales-gauntlet/` and are never committed.

Historical proofs deliberately stop at their named candidate. They do not certify later behavior. The separate fresh full replay supplies the current-schema evidence. One-shot production data migrations are ledgered, never executed against test business rows. A registration prerequisite is performed through the normal local admin RPC before its dependent migration, before browser products are seeded.

## Application findings retained

These findings are outside the requested test repair. Application sales rules and production records were not changed.

- **MED — KI-99, void/write-off reconciliation.** Source and live read-only function inspection confirmed the existing known issue. The live aggregate of affected voided chemical invoices was zero. Keep the documented workaround: reverse a write-off before voiding. Owner: application maintenance, tracked in `docs/manual/KNOWN_ISSUES.md`.
- **MED — KI-03, invoice ownership enforcement.** The existing known issue remains confirmed by source and live read-only inspection. No production action was performed to exercise it. Owner: application maintenance, existing KI-03. Security implementation details are intentionally omitted from this public report.
- **LOW — Quote admin cost preview rounding.** `src/pages/QuoteBuilder.tsx` sums raw extended costs before rounding; the authoritative database sums rounded lines. Two $0.005 extensions display $0.01 but store $0.02. Helper assertions reproduced it. This affects the admin cost preview; the customer PDF total and saved sale price were correct.
- **LOW — Quote edit affordance.** Another rep's draft offers Save; the actual browser request is correctly refused with `NOT_QUOTE_OWNER`, leaving version and notes unchanged. The screen should reflect the server's restriction.
- **LOW — Invoice PDF footer.** Visual rendering showed overlapping footer text. Customer, product, quantity, total and balance remained readable and correct. Quote layout was readable.

The three LOW observations are tracked in [#1881](https://github.com/croprxsolutions/CRX_Manager_V1.0/issues/1881). Existing KI-99 and KI-03 remain in their own work queue.

## Limits and unresolved lead

The order-void review loop handles draft/posted invoices but omits overdue/paid states. This remains an unconfirmed lead: intended accounting and warning behavior must be settled before proposing a change. It is not counted as a reproduced defect.

No real outbound email, Edge Functions, payment collection, commission payout or production sales transaction was exercised. Local mark-presented/version recording is not email delivery. Invented test accounts and records cannot establish every real-customer data combination. This scoped gauntlet completed its required sales checks with the findings above; it is not a clean bill of health for the whole app.

Rollback of the test repair is reverting its PR. Stop only its local services with `node scripts/local-app/sales.mjs stop`; no live migration or production rollback is needed.
