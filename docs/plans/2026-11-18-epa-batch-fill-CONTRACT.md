# EPA batch fill: behavior contract (2026-11-18)

Read at `origin/staging` b7b0d9c66. Mason approved Sol's batch plan in-session on 2026-11-18 ("go with Sol's plan"). Sol's review:
the session notes `moa1-sol-approach-review-2026-11-18.md` (not in repo).

## 1. Outcome and authority

**Outcome.** An admin fills active ingredients for many product parents in one run. Each parent goes through the same DM-4
path a person uses on the product page: `start_epa_lookup` → `epa-lookup` Edge Function (record mode) → `commit_epa_proposal`.
The tool writes **ingredients only**. Anything that is not a plain new ingredient waits on `/epa-lookups` for a person.

**Smallest change.** A screen-only change. No new table, RPC, migration, Edge Function change, flag, or job.
- `src/lib/epaBatchFill.ts` (new): the candidate list, the per-parent eligibility rule, the decisions builder, and the run loop. It is built from the existing `startEpaLookup`, `runRecordedEpaLookup` and `commitEpaProposal`.
- `src/lib/epaBatchFill.test.ts` (new): the eligibility and decisions rules.
- `src/components/products/EpaBatchFill.tsx` (new): the card on `/epa-lookups`. It lists the candidates with checkboxes and has Start and Stop buttons, plus per-parent results.
- `src/pages/EpaLookups.tsx`: mount the card; reload the overview after a run.

**Who may act.** Admins only. The page is `roles: ['admin']` (`src/appPages.tsx:421`). Every server step re-checks this independently:
- `start_epa_lookup` and `commit_epa_proposal` call `_product_parent_require_admin()` (migration `20270105110000`, lines 690 and 864).
- `record_epa_lookup` refuses a lookup whose starter is no longer an active admin (line 781).
- The Edge Function is admin-only.
- The screen offers nothing beyond what those RPCs already allow a single admin on the product page.

**Locators vs derived.**
- The screen sends `parent_id` and an EPA number. `start_epa_lookup` refuses a number that is not on that parent (`EPA_NUMBER_NOT_ON_PARENT`, line 718) or a parent that is inactive.
- The EPA answer is fetched and recorded by the Edge Function, never by the browser (D-Z).
- The screen sends `proposal_id`, `expected_version`, and `{item_id, accept}` decisions. The server re-sorts the items under locks, and it refuses accepting any item that is a difference (`EPA_DECISION_NOT_WRITABLE`, line 933).

## 2. State and failure

**Candidates.** A parent appears only if all of these hold:
- It is active.
- It has **no** `product_parent_ingredients` row.
- It has **exactly one** distinct EPA number, counted the way `fetchParentEpaNumbers` counts: parent, sizes, active brands, legacy brands.
- That number has no failure already recorded and no open (proposed or held) proposal.

Parents with several numbers are listed as "skipped: several EPA numbers" (Sol HIGH: generic parents with several brands) and get no lookup. The admin ticks which candidates to run; nothing runs unticked.

**Eligible to commit.** Every condition below must hold. Otherwise the proposal is left `proposed` for a person on `/epa-lookups`, and the run reports why.
- The proposal status is `proposed`.
- At least 1 ingredient item.
- Every ingredient item has class `add`: it has a CAS number, its % is not null and is > 0.
- The ingredient % values sum to ≤ 100.
- No ingredient item has class `add_name_only`, `epa_conflict`, `differs*`, `missing_from_epa`, or `ingredient_retired`.

**Decisions sent.** One explicit decision for **every** writable item:
- `accept: true` for each ingredient `add`.
- `accept: false` for every label item (signal word, restricted use, label date, registration status).

This matters because the server uses `accept_default` for any item left out (line 948). Label facts such as a blank signal word default to `true`, so leaving an item out would write it. Before the call, the client asserts that the accepted set is ingredients only, and refuses to send otherwise.

**Rules that always hold** (server, one transaction per commit; lines 900–1038):
- Ingredients are written through `_apply_parent_chemistry` in `'epa'` mode.
- `epa_registrations` is untouched when no label item is accepted, so `registration_version` stays the same.
- A proposal goes `proposed` → `committed` exactly once, under row locks.
- A chemistry or registration change between lookup and commit gives `held` rather than a write.

No email, file, or receipt is produced. The tool shows nothing beyond the per-parent result list.

**Existing rows.** The 12 parents already filled (19 rows, all `source=epa_lookup`) are not candidates. Pre-run check (read-only): `select count(*) from product_parent_ingredients` and the count of parents with zero rows. Old proposals and failures are untouched.

**EPA "not found".** A lookup EPA has no record of is recorded as a failure (existing behavior), and that lifts the typed-chemistry gate for that parent. The tool lists it under "needs a person". Known wrong numbers (Atrazine 4L 352-314, Atrazine 90 DF 352-360) are already excluded, because they have a recorded failure or are left unticked. **DECISION 2.**

**Timing.**
- **Double click on Start.** The button is disabled while running, and a ref guard ignores a second start. Server: each step has its own idempotency key.
- **Retry after a lost reply.**
  - Keys are created once per parent per run: `batch:<runId>:<parentId>:start` and `…:commit`.
  - A retried start or commit with the same key and the same request replays the saved receipt (`_product_parent_replay`), so it never runs twice.
  - The loop retries a lost reply once with the same key; after that it reports "unknown, reload".
  - The record step is keyed by the lookup ID (existing).
- **Two admins at once.**
  - A second `start_epa_lookup` on the same number supersedes the first; `record_epa_lookup` then refuses the old one with `EPA_LOOKUP_SUPERSEDED`.
  - A commit on a proposal that moved on gets `EPA_PROPOSAL_STALE` or `NOT_OPEN`.
  - Each such parent is reported and skipped. Nothing is written twice, because `_apply_parent_chemistry` is version-checked.
- **A product-page edit mid-run.** It becomes `held` (chemistry_changed); the tool reports "on hold".
- **Rate limit.** Every EPA call goes through `waitForEpaRequestSlot` (the shared client throttle). The Edge Function also caps at 30 per minute.
- **Tab closed or Stop pressed mid-run.**
  - Stop takes effect after the current parent; nothing new starts.
  - On a closed tab, a pending lookup expires after 30 minutes (line 791).
  - A recorded proposal stays `proposed` and appears under "Waiting for a decision".
- Parents run one at a time, never in parallel.

**Undo and history.**
- Each commit is recorded on the proposal (`decided_by` = the admin, `commit_result`) and in the chemistry events `_apply_parent_chemistry` writes.
- Undo is per parent through the existing chemistry tools; there is no batch undo, and none is added.

## 3. Delivery

Screens only; no database change. One PR to `staging`. The touched `src/` files are checked against the Sol list by running the classifier. If any is listed, Sol reviews before the PR opens. Luna reviews regardless.

## 4. Proof cases

All are browser checks on the staging app, which has its own database, as an admin, unless marked SQL. None mutates production.

1. When a candidate has one number and EPA returns only new ingredients with CAS and %, then it is committed. `product_parent_ingredients` gains exactly those rows with `source='epa_lookup'`. The number's `registration_version`, signal word and label date are unchanged, even when the signal word was blank, which is the case where `accept_default` is true (SQL read after).
2. When a proposal contains an ingredient with no CAS, a conflict, or a difference, then nothing is committed. The proposal stays `proposed` and is listed under "needs a person".
3. When a parent has two EPA numbers, then no lookup is started (no `epa_lookups` row) and it is reported as skipped.
4. When EPA has no record, then a failure is recorded, nothing is committed, and the parent is reported.
5. When a non-admin opens `/epa-lookups`, then the page is refused. When a non-admin calls `start_epa_lookup`, then it raises (existing DM-4 SQL test, re-run).
6. When the commit reply is lost and the call is retried with the same key, then the same result is returned and no duplicate rows exist (unit test with a mocked reply plus SQL replay on staging).
7. When Stop is pressed mid-run, then the current parent finishes and no new `epa_lookups` row appears afterwards.
8. When a product page commits the same parent between lookup and batch commit, then the batch gets `held` or `STALE`, reports it, and writes nothing.

## Open business decisions

1. **Label facts in the batch.** Options:
   - (a) Ingredients only, as now.
   - (b) Also fill **blank** signal word and label date/link from EPA, never overwriting.

   Option (b) clears many "Incomplete Setup: Signal word" flags at once. Option (a) keeps the run to the scope you approved. **Recommendation: (b), for blanks only.** It's the same EPA source, the server never overwrites a value, and restricted use stays out.
2. **EPA "not found" numbers.** Options:
   - (a) Run them, record the failure, and list them for a person. The typed-ingredient gate opens for that product.
   - (b) Never start a lookup for a number the preview did not find.

   **Recommendation: (b).** The preview already found every number except the two wrong atrazine ones. Those get corrected numbers first.

## Astra challenge settlement (2026-11-18, gpt-6-astra high, FINDINGS 38)

Live read-only baseline (2026-11-18): 401 active parents with no ingredient row; 347 registrations, **all** with
`registration_status='unknown'` and blank label date, 142 with blank signal word; 0 open or rejected proposals; 1 failure.

Rule changes adopted (supersede §2 where they differ):
- **Label items are never silently dropped (F1, F2).** The batch commits only when every label item is one of:
  `fill` on a field whose current value is blank (signal word null; label date AND link both null), `confirm`/`matches`,
  or `registration_status` `differs` with EPA saying *active* (status is never writable, D-T; ours is `unknown` everywhere).
  Any `differs`, any `rup_upgrade`, a newer-date `fill` over an existing date, or EPA saying *cancelled* → the whole
  proposal stays `proposed` for a person. Which blank fills are accepted is DECISION 1.
- **Identity check (F4, F21; the Atrazine 90 DF / "Demosan T" case).** Needs a person when `epa_summary.needsManual`
  is true, `base_label_note` is true (distributor number), or the EPA product name/alt names share no first word with the
  app parent or brand name (same test as the preview, which flagged every known wrong number).
- **Candidates also exclude (F8, F13, F12):** a parent/number with a pending lookup younger than 30 minutes, or any
  rejected proposal; a failure excludes only that parent+number. Inactive ingredient rows still exclude (F16, conservative;
  the product page remains the manual path).
- **Exactly-one-number race (F7) and concurrent supersede (F9, F10):** re-read the number count and open proposals in the
  browser immediately before start and before commit; a remaining race needs two admins acting on the same product in
  the same seconds. Accepted residual risk (two admins total), not closed server-side; §2 wording corrected.
  **Closed server-side 2026-11-19 (issue #1976):** the batch now saves through `commit_epa_proposal_batch`
  (`20270130100000`), which re-checks one number, no other proposal and no ingredients under the save's own locks.
- **Held rules (F5, F6):** §2 overstated. Actual: chemistry is version-checked from *recording*, and registration changes
  hold only when a label item is accepted. Batch re-reads both before commit.
- **Result identity (F23):** the loop requires `proposal_id` on a proposal outcome and re-fetches that proposal, checking
  parent, number, lookup, status `proposed` and version, before deciding.
- **Recovery (F25, F27, F28, F29):** 60 s deadline per request; any error (429 and 5xx included) is reported as
  "uncertain" for that product, and two consecutive errors stop the run (no churn). Run results (runId, keys, proposal ids) are kept in `sessionStorage` so a reload shows what is
  uncertain; the loop is owned by the card, stops on unmount and on sign-out.
- **Percent sum (F22):** compared in integer hundred-thousandths (EPA gives ≤ 4 dp), no float tolerance.
- **Rate limit (F24):** one run per browser tab; the Edge cap is the real limit; a 429 counts as an error (above).
- **Proofs added (F35):** zero ingredients; `add` with null/0 %; sum > 100; retired ingredient; every label default sent
  as explicit false or blank-fill only; full `epa_registrations` row compared before/after, not three fields.
- **Evidence items (F14, F15, F17-F20, F26, F31, F33, F34, F36):** answered at build time by reading the named helpers
  and policies; any that contradicts this contract stops the build and returns here.
- **Not adopted:** a server precondition for exactly-one-number (F7/F38) would need a migration; outside the approved
  screen-only scope unless Mason asks.

## Mason's decisions (in-session, 2026-11-18)

1. **Label facts: ingredients only.** Every label item is sent `accept: false`, blank fills included. Mason accepted that
   blank signal word / label date are then not queued and need a later lookup per product. A label `differs` (signal word
   or label date/link), a `rup_upgrade`, or EPA saying *cancelled* still sends the whole proposal to a person. The one
   exception is registration status `differs` with EPA saying *active*: status is never written (D-T) and ours is
   `unknown` on all 347 registrations, so blocking it would block every product (an existing value disagreeing
   with EPA is a discrepancy, not a blank).
2. **Name check: required.** A whole word of EPA's product name must equal the first word of the parent, a size or a brand
   name (re-read just before commit), else the proposal waits for a person. EPA alternate brand names are not in the
   saved proposal, so they are not used: stricter, more products wait for a person. This replaces "never run a number the preview did not find": a not-found number records
   a failure (existing behavior) and is listed for a person; a found-but-wrong number fails the name check.
