## 2026-11-25 — Hold liquid weight review out of production

**Severity:** MED. **Area:** Product weights and saved paperwork. **Status:** OPEN.
**Owner:** Product Setup admin for the review and merge captain for the release hold.

The staging activation verifies the new Weight card and paperwork on test records. Its migration only opens the switch in the staging database job. A normal production release replay leaves the switch closed and the existing weight entry paths available. A separate production activation requires owner approval after a Product Setup admin reviews every previously approved multi-brand liquid group against the brand SDS evidence. Split confirmed mismatches and have a different admin approve the resulting weights before clearing this hold. Record the completed review with the release evidence. Reconcile the staging and production switch states before refreshing the schema baseline or restoring staging from production.

The [Better Product Labels contract](../../plans/2026-11-24-better-product-labels-CONTRACT.md) records the rollout decision.
