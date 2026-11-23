# Workflow review: chemical sales and field application (2026-11-22)

**Scope:** an end-to-end map of how stock and money move through the app, plus the gaps found. Two sides are covered: chemical sales (quote → purchasing → order → delivery → invoice → payment) and field application (job → mixed → sprayed → billed).
**Code read:** `origin/staging` at `3f1ca8933`. Many of those changes are not live yet; the documents tag which ones.
**Method:** code and migrations were read only. Nothing was run against a database and nothing was changed.
**Purpose:** the base for upcoming planning in this area.

| File | What it is |
|---|---|
| `chemical-sales-workflow-2026-11-22.html` | Diagram sheet for chemical sales: each stage's stock and money effects, how planned and firm bookings count toward purchasing, the side paths, and 15 ranked gaps with your rule for each |
| `field-application-workflow-2026-11-22.md` | Field application write-up: each stage, statuses, stock and money effects, gaps with file:line evidence, and recommendations |
| `field-application-workflow-2026-11-22.html` | Diagram sheet for field application |
| `workflow-review-decisions-2026-11-22.md` | Mason's business rules decided during the review (1-12) (commission timing, field invoice scope, billing by tank quantity, booked cost on order edits, and more; the Likely % idea was dropped) |

**Earlier work this builds on:** `docs/research/2026-11-17-bookings-flow-audit/` (bookings, prepay and inventory timing audit) and its booking timing/confidence design.

**Still open:** prepay (tie it to a booking and lock the price), which waits on Mason's brainstorm.
