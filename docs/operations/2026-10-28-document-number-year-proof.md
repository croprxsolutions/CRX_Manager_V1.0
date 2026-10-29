# To-Do 12.1: Chicago document-number year - unapplied candidate

Scope: quote, order and rebate-claim numbering only. Invoice numbering, payment
dates, existing identifiers, formats, sequences and counters are unchanged.
The sections below are the 2026-10-28 evidence (before the 2026-10-29 re-stamp and
the main merge); the "Landing status" section at the end is current. Not applied
or merged; landing follows the `ship.md` gates.

## Current-source and live read-only evidence

Initial base: `origin/main` at `5b0246530`, still current when the final suite completed.
Before the final review, the unpublished commits were rebased onto `32469af54`,
which adds the notes-only Vercel build skip. Its `ignoreCommand` is preserved
(the branch's preview-deployment hold was later removed). No application or
numbering function changed during that refresh.
Checkout: `C:/CRX_chicago_document_numbers`.
Branch: `codex/chicago-document-numbers-20261028`.

Live `pg_proc` inspection on 2026-10-28 found one signature each:
`generate_quote_number()`, `generate_order_number()`, and
`create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text)`.
The generators retain their sequences and active-role checks. Claim creation
retains five defaults, role checks, scoped idempotency helpers and its atomic
yearly counter increment.

The candidate replaces only `current_date` in these bodies with
`(now() AT TIME ZONE 'America/Chicago')::date`, following the invoice pattern in
`20260914100100_next_invoice_number_year_chicago.sql`. Preflight and postflight
verify signatures, overload counts, original/replacement body hashes, security
mode, search path, owner, default arguments and existing grants. Postflight also
asserts the Chicago year boundary. No grants change.

Live caller inspection confirmed quote templates, duplication and rollover use
the quote generator; direct orders, quick delivery, conversion, booking draw-down
and rush orders use the order generator. The quote and blend-ticket screens
consume those results. Rebates use the claim RPC. Quote Builder no longer invents
a browser number after failure; new-quote Save Draft waits for allocation and
distinguishes pending from failed allocation.

The live ledger had 1,075 rows. Its effective maximum (leading authored-name
timestamp, else version) was `20261027080300`: version `20261028121259`,
name `20261027080300_notification_sender_recorded`. This candidate sorts later.
Refresh the ledger before any future apply.

Graphify refreshed from the base. `graphify explain generate_order_number`
returned an older definition and only its containing-file edge; current source
and live caller inspection supplied the authoritative paths above.

## Observed verification

- Final application suite: 480 files passed, 6,638 tests passed, 123 skipped.
  Command: `npm run test -- --maxWorkers=1`.
- Focused quote suite: 111/111 passed, including pending allocation, server
  success, errors, null/empty-string and rejected requests.
- Typecheck and lint passed after review fixes. The initial build passed; the
  protected pre-push hook rechecks typecheck and build on the final head.
- Complete `test:agent-workflows` and `check:agent-guidance` passed. Earlier
  mocked guard failures passed on retry without changing any guard.
- The cost-field check passed its isolated 30-test retry. A later two-worker run
  had an inventory retry timeout; its isolated 20-test run passed. The final
  one-worker full suite above passed all 480 files. No checks were weakened.
- `DOCUMENT_NUMBERS_CHICAGO_PROOF_PASS`: supported baseline plus 155 post-baseline
  migrations in a network-disabled PostgreSQL 17 container. Seven clock cases
  passed in UTC, Chicago and Tokyo: UTC New Year before Chicago midnight,
  immediately before/at/after Chicago midnight, summer and winter. The old
  expression reproduced early rollover.
- Twelve concurrent transactions produced unique quote/order/claim numbers.
  A cross-midnight claim retry retained its ID/number. Admin and sales-rep calls
  succeeded; driver/applicator calls were refused. Invalid quantity and body
  drift were refused. Apply/reapply preserved all function contracts.
- Metadata mutation checks passed: changed security mode, owner, search path or
  grants caused preflight refusal and rollback. An incorrect emitted security
  mode caused postflight refusal and rollback of the whole migration.
- `DOCUMENT_NUMBERS_BROWSER_PROOF_PASS`: the real page waited for a delayed
  allocation, then enabled Save Draft. Four failure cases refused saving after
  customer selection: zero fallback count queries, zero save RPCs, zero page
  errors. Every API request used an intercepted loopback fake backend.
  Screenshot: `graphify-out/number-browser.png` (private local artifact).

Reproduce with `node scripts/smoke/prove-document-numbers-chicago.mjs`. The
submitted script always creates a fresh network-disabled container, accepts no
database URL, refuses reuse, and cleans up only its successfully created
container ID. Literal clock substitution affects installed local definitions
only; there is no production clock override.

## Review reconciliation

Security, compliance, focused types and migration-drift reviews found no
unresolved technical HIGH. Shared migration-history bookkeeping is deferred
until a future authorized apply; no applied row is claimed here.

Luna's original HIGH about absent candidate hashes was refuted by source and
successful actual apply/reapply. Its later MED about container reuse was fixed
by removing reuse and binding cleanup to the created container ID. Pre-existing
`lpad(...,4,'0')` truncation above 9,999 remains a separate deferred capacity issue.

The first direct Claude review used `sonnet` at high effort; its capture resolved
to `claude-sonnet-5`, not the requested 5.5. Its requests for stronger migration
checks, pending/failed numbering UX, a corrected comment and green checks are
addressed above. Draft-only delivery requires an explicit `claude-sonnet-5-5`
high-effort review through `scripts/run-claude-review.mjs`, whose private capture
records the resolved model and reviewed head. No final Sol/merge proof is claimed.

The explicit Sonnet 5.5 high-effort run at `60394fd0c` completed with no BLOCKER,
HIGH or MED. Its two LOW documentation findings are addressed in KI-18 and the
RPC reference: the unapplied candidate is linked and the capacity deferral has
Codex ownership. Optional NITs remain named here: malformed saved quotes with an
empty number can show the pending message, Sentry can receive the original RPC
error object, and late allocation cancellation needs a separate quote-route
lifecycle follow-up (owner: Codex). Those pre-existing/diagnostic cases do not
change the tested year-selection behavior and are deferred from this scope.
The dated manual review record is retained because the follow-up migration
commit required a newly added ledger record; it points to this detailed record.
The safe optional live lock timeout can be assessed by the future apply session.

## Delivery boundary and rollback

Not applied and not merged. Delivery follows the `ship.md` gates (CI, reviews,
final Sol, guarded apply before merge). No Vercel project settings were changed.

Rollback is a forward migration re-emitting the three reviewed bodies with the
prior year expression. Never reset counters/sequences or renumber records.
Quote/order prior definitions are in `20261027080100_number_generators_active_signed_in_only.sql`.
For exact prior bodies, write the candidate's three explicit definitions with only
the Chicago date expression restored to `current_date`, and verify the original
body hashes pinned by its preflight. Do not dynamically rewrite live function source.

Proposed shared to-do status: "12.1 built; local Chicago boundary, concurrency,
retry and failure proof passed. Not merged or applied until the landing gates
finish. See this record and the PR for current delivery evidence."

## Landing status - 2026-10-29

- The candidate is `20261029160300_document_numbers_chicago_year.sql` (history row
  1005; authored as `20261028185021`, re-stamped after the
  live order-edit migration `20261028185500`). The earlier evidence above ran on the
  authored stamp; the function bodies are unchanged by the re-stamp and
  `20261028185500` does not touch these three functions.
- The live ledger at the last read was 1,077 rows with ordering high-water
  `20261028185500` (the figures above are the older 2026-10-28 read).
- Review round 1 (Luna, compliance, security) fixed in this head: quote screen now
  clears the previous number when a new allocation starts and no longer reports
  "still loading" for an existing quote; stale stamp/draft-only wording corrected.
  The 9,999 `lpad` capacity limit stays a separate deferred follow-up (owner: Codex).
