# To-Do 12.1: Chicago document-number year - parked candidate

Scope: quote, order and rebate-claim numbering only. Existing invoice numbering
and payment dates are unchanged. No existing identifiers are rewritten and no
sequence or counter is reset. This candidate has not been merged or applied live.

## Current-source and live read-only evidence

Started from `origin/main` at `5b0246530` in isolated checkout
`C:/CRX_chicago_document_numbers`, branch
`codex/chicago-document-numbers-20261028`.

Live `pg_proc` inspection on 2026-10-28 found one signature each:

- `generate_quote_number()` and `generate_order_number()` return text and use
  their existing PostgreSQL sequences. Active-role checks remain unchanged.
- `create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text)` returns JSON,
  retains five defaults, its existing role checks and scoped idempotency helpers,
  and increments the yearly counter through atomic `INSERT ... ON CONFLICT`.

All three still used `current_date` for year selection. The candidate replaces
only that expression with `(now() AT TIME ZONE 'America/Chicago')::date`, matching
`20260914100100_next_invoice_number_year_chicago.sql`. The migration pins the
inspected original bodies and its own replacements and checks overload count and
signature before re-emitting explicit function definitions. No grants change.

Live caller inspection confirmed quote template creation, duplication and season
rollover use `generate_quote_number`. Direct order creation, quick delivery,
conversion, booking draw-down and rush orders use `generate_order_number`.
The quote and blend-ticket screens consume these RPC results. Rebates already
use `create_rebate_claim`; no browser year generation remains in the quote screen.

The fresh live migration ledger contained 1,075 rows. Comparing each row's
leading authored-name timestamp, falling back to version, gave effective maximum
`20261027080300` (version `20261028121259`,
`20261027080300_notification_sender_recorded`). This candidate sorts later.
Refresh this observation before any future apply.

Graphify refreshed from the starting commit. `graphify explain
generate_order_number` returned the older 20260209200000 definition and only its
containing-file edge; current source and live caller inspection supplied the
authoritative paths above.

## Verification

- Typecheck, lint and production build passed.
- Focused quote-page suite: 110/110 passed, including server-number success and
  error, null/empty-string and rejected-request cases with no browser fallback.
- Security, compliance and focused type review: clean. Migration drift review:
  no remaining technical HIGH after the fresh ledger evidence; shared migration
  history bookkeeping is deferred to the future authorized apply.
- Full-schema local proof passed: `DOCUMENT_NUMBERS_CHICAGO_PROOF_PASS`, after
  baseline restore and 155 post-baseline migrations. Seven controlled instants
  each passed in UTC, Chicago and Tokyo sessions: UTC New Year before Chicago
  midnight, immediately before/at/after Chicago midnight, summer and winter.
  The old year expression reproduced the early rollover; the fix prevented it.
  Twelve concurrent transactions returned unique quote/order/claim numbers.
  A claim replayed across midnight retained its original ID/number. Admin and
  sales-rep calls succeeded; driver and applicator calls were refused. Invalid
  quantity and unexpected body drift were refused. Apply/reapply, body hashes,
  signatures, defaults, owners, ACLs and search paths were verified.
- Local browser proof passed: `DOCUMENT_NUMBERS_BROWSER_PROOF_PASS`. The real
  quote screen displayed the server number. Error, null, empty-string and
  rejected-request cases showed the failure and refused Save Draft after a
  customer was selected: zero fallback count queries, zero save RPCs, and zero
  page errors. All API traffic used an intercepted loopback fake backend.
  Screenshot: `graphify-out/number-browser.png` (private local artifact).
- `check:agent-guidance` passed. The broad suite was not green: unchanged
  `src/lib/costFields.test.ts` failed its invoices_postable/schema-registry
  column assertion, and `QuotesOrdersDeliveries.loadFailed.test.tsx` hit a
  worker-termination timeout. The earlier parallel run hit worker-start timeouts.
- `test:agent-workflows` failed in the unchanged
  `.codex/hooks/production-action-guard.test.mjs` at line 482 (mock base commit
  unavailable); retry failed at line 1615 (mocked push proof expected accepted).
  No guard was changed, weakened or bypassed. This remains a push blocker.
- Luna (`gpt-6-luna`, xhigh; review session
  `01a183f2-b533-7392-ac12-e1adf1d4162e`) reported one HIGH and one MED.
  The HIGH is refuted: every preflight contains original AND candidate body
  hashes, and actual local apply followed by reapply succeeded. The MED concerns
  pre-existing `lpad(...,4,'0')` truncation above 9,999. It is deferred as a
  separate numbering-capacity issue; this scoped fix preserves identifier
  formatting and sequence behavior. No clean exact-head Sol proof is claimed:
  required broad/guard checks failed, so no push or PR was attempted.

The reproducible database command is
`node scripts/smoke/prove-document-numbers-chicago.mjs`. It restores the supported
schema baseline in a network-disabled disposable PostgreSQL 17 container,
replays post-baseline migrations using the existing harness exclusions, verifies
the original live-body hashes, applies and replays the candidate, then exercises
year-boundary, summer/winter, session-timezone, concurrency, retry, invalid-input
and role-refusal cases. Controlled clock cases replace only the installed local
function's `now()`/`current_date` with literal instants; there is no production
clock override or clock parameter. It restores the exact candidate definitions
after testing. The first run completed schema replay and migration-contract
checks but stopped on a proof-script multiline-definition decoding error; that
  script issue was corrected before the rerun. The first role-fixture setup was
  refused by the real profile guard; a separate synthetic administrator now
  performs fixture role changes without altering the guard. Reuse runs use
  fresh test keys, preserving the actual claim retry behavior.

## Parking and later delivery

Do not merge, enable auto-merge, apply a migration, deploy, or write production
data in this task. There is no PR while required checks remain unresolved.
The assigned session owns implementation/proof; a future authorized delivery
session owns fresh base/overlap/ledger checks, green required checks, independent
Luna and exact-head Sol review, guarded push and any requested PR.

Rollback is a forward migration re-emitting these same three reviewed bodies
with the prior `current_date` year expression. Never reset sequences/counters or
renumber existing records. Refresh the live function contracts first.

Proposed shared to-do status: "12.1 implemented and parked locally; Chicago
business-year selection covers quotes/orders/rebate claims, with no existing
renumbering or sequence reset. Not merged or applied; see this proof record for
verified results and remaining gates."
