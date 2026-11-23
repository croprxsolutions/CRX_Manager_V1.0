# KI-195 — printouts show the job's kept EPA number: behavior contract

Read at `origin/staging` `42039d705` (2026-11-23). GitHub #2183, To-Do 10.10.

## Facts (with sources)

- `job_product_epa(job_id, product_id, epa_registration, not_recorded)` is live (ledger `20261107131813`, migration
  `20261204120000`). One insert-only row per product of a sprayed or finished job; first number wins. Signed-in users may
  SELECT rows of jobs they can see (policy `job_product_epa_select`). Numbers are stored normalized (`_epa_norm`).
- Its header item 4 is the settled read rule (Mason, 2026-11-06, "lock per product"; DECISION_LOG ~L1722): a job shows
  the lock row's number when one exists, else `_epa_norm(products.epa_registration)`.
- Three kept states: a number; NULL with `not_recorded = false` (the product had no number when locked: "explicit
  unknown"); NULL with `not_recorded = true` (backfill or moved spray record: "Not recorded"). REG-1 build sheet section 7:
  "Not recorded" is never filled from the product's current number.
- Readers today, all on the catalog: `chemicalApplicationReportFetch.ts` L127-135 (Jobs-list report and applicator sheet,
  also the summary reports' per-job gatherer), `JobDetail.tsx` L958-1004 (WPS notice) and L1043-1159 (job-page report and
  applicator sheet), `get_job_proof_data` (`20260630160000`, live body identical to the file, checked read-only
  2026-11-23) returns `p.epa_registration`, and the proof email (`proofNotification.ts`) prints no EPA at all.
  `applicatorSheetPdf.ts` L239-260 has no EPA column.
- Live (read-only, 2026-11-23): 1 lock row, `not_recorded = true`; 0 explicit-unknown rows.

## Outcome and authority

Every printout of a job shows, per product, the kept number when the job has one, else the catalog number as today.
No write path changes; nobody gains or loses access. Smallest change:

- `src/lib/jobEpa.ts` (new, ~20 lines): read the job's lock rows (RLS as the caller) and turn a lock row into print text:
  the number; `Unknown` for an explicit unknown; `Not recorded` for not_recorded. A failed read throws (compliance prints
  abort, as the label lookups already do).
- `chemicalApplicationReportFetch.ts` and the two `JobDetail.tsx` builders apply it to their existing label map.
- `applicatorSheetPdf.ts` gains an `EPA Reg. No.` column (always on; it is regulatory data).
- Migration `20270225110000_job_proof_kept_epa.sql`: `CREATE OR REPLACE` of `get_job_proof_data(uuid, uuid)`, same
  signature, gate, grants and body except the products block: LEFT JOIN the lock row; `epa_registration` = the kept number
  when locked, else `_epa_norm(catalog)`; two new keys `epa_kept`, `epa_not_recorded`. Read-only, so no idempotency key.
- `proofNotification.ts` prints `EPA Reg. No. <text>` on each product line (HTML and text). Old database (keys absent)
  reads as unlocked, so the screen works before and after the apply. The email is built in the browser and sent through
  the existing `send-email` type: no Edge Function deploy.

Batch reports (Master Mix, Chemical Summary, Projected Use) keep the catalog number and do not read the kept rows
(Sol r1 HIGH: Master Mix tells same-named products apart by catalog number; they are loading and usage sheets, not
per-job records).

Unchanged: invoice PDFs (KI-157, Taha's lane), split invoice re-save (KI-117), product names (the snapshot has none), the
Master Mix/summary reports beyond inheriting the per-job text.

## State and failure

- Unsprayed job: no lock rows, prints exactly as today.
- Lock read fails or is cut: the report, applicator sheet and WPS notice abort with the existing error toast; never print
  the catalog number for a locked product.
- An applicator who can see the job reads its lock rows (policy follows `jobs`); one who cannot see the job cannot print it.
- Rollout: the screen tolerates the old RPC (no `epa_kept` key → no EPA line in the proof email, today's behavior). The migration alone changes
  only the proof JSON (new keys, normalized catalog) and the deployed app ignores the new keys.

## Proof cases (staging DB via local vite, or the real-schema prover; never production data)

1. When a sprayed job's product has its catalog number corrected afterwards, then the report, applicator sheet, WPS notice
   and proof email all show the kept (old) number.
2. When a product was locked with no number (explicit unknown) and later gains one, all four print `Unknown`.
3. When a job was backfilled `not_recorded`, all four print `Not recorded`, never the catalog number.
4. When a job is not yet sprayed, the three pre-completion outputs show the catalog number (the proof needs a completed
   job, so it has no unlocked case).
5. `get_job_proof_data` as admin returns the kept values and the two flags; as an applicator it still refuses
   `INSUFFICIENT_ROLE`; one overload, anon has no EXECUTE.

## Open business decisions

None. Wording `Unknown` / `Not recorded` follows KI-195 and REG-1 section 7.

## Cold challenge (gpt-6.2-astra high, 2026-11-23, 48 findings) and how each was settled

Changed in the contract and code:
- **Old database answer (5, 41):** a proof answer without `epa_kept` (database before `20270225110000`) prints no EPA
  line at all, as today, instead of a catalog number that may be wrong.
- **Lost access / cut answer (1, 2):** the kept-number read first confirms the caller can still see the job (else the
  print aborts), and asks only for the printed products' rows (at most one each), so no row limit can cut it.
- **Master Mix (18):** only a value starting with a digit names a same-named product; "Unknown"/"Not recorded" fall back
  to "product n" as a missing number did.
- **Office preview (12):** the proof preview shows the same `EPA Reg. No.` line as the email.
- **Line membership (16):** the promise is the kept number **for each currently saved line**; a removed product is not
  reprinted (unchanged).
- **Unlocked, no catalog number (7, 8):** each output keeps today's fallback (`—` report and sheet, `see label` WPS, no
  line in the email). "Prints as today" means the same source, plus the new sheet column.
- **Rollback (44):** revert the app first, then (if ever needed) re-run the `20260630160000` body; recording is untouched.

Disproved or out of scope, with evidence:
- 6, 25, 32, 37: the RPC tests row existence (`k.job_id IS NULL`), not the number; the app reads locks whenever the job is
  saved, never by status; a contradictory row (number + not_recorded) prints "Not recorded"; a new unsaved job cannot have
  locks (`isNew` skips the read).
- 11: the proof email is sent as HTML (`buildProofEmailPayload`); the text form is the preview/log, both updated.
- 13, 35, 38, 39, 14: existing send-flow behavior (preview vs per-recipient read, partial sends, retry logging, proof of an
  unsprayed job) is unchanged by this change; an unsprayed job's proof shows the catalog number, the settled rule.
- 26, 27, 28, 29, 30, 31: recording rules were settled and proven in `20261204120000` (its prover covers moves, re-adds,
  late adds); this change only reads them. Live coverage was checked by that migration's postflight.
- 36: every throw lands in an existing catch before that job's download, stamp or log (JobDetail WPS/sheet/report,
  Jobs.tsx single path); no partial file is produced. The bulk sheet path catches per job: the failed job gets no file
  or stamp and is named in the failure toast, while the other selected jobs still print and stamp (retry only the
  named jobs).
- 42: `get_job_proof_data` has one caller (`FieldApplicationInvoice.tsx`); the normalized catalog value is trimmed only.
- 43: the lock migration is APPLIED LIVE (ledger `20261107131813`); the candidate's preflight pins the live body md5.
- 47 (one RPC for all prints): declined; a new RPC is a bigger change than two small reads behind the same RLS.
- 48 (explicit state): the print text is formed in one function (`jobEpaText`); Master Mix fixed separately.
- Others (3, 4, 9, 10, 15, 17, 19-24, 33, 34, 40, 45, 46): either existing behavior this change does not touch (stale
  open screens, Jobs-list line filter, live label data beside the kept number, office role gate) or covered by the proof
  cases (RLS read as applicator and rep, rendered artifacts).

No DECISION finding needs Mason: 8 and 16 follow existing fallbacks and the settled per-product rule; 19 (one summary
row, several jobs) only affects Master Mix naming, fixed above; 30 (mistaken first lock) is a write-path question outside
this read-only change; 37 has no case (new jobs have no locks).

## Sol round 1 (2026-11-23) and how each finding was settled

- HIGH Master Mix label from a historical number: fixed. The three batch reports pass `keptEpa: false` and keep the
  catalog number (unchanged from staging); the Master Mix edit is reverted.
- MED summary reports depend on the kept read: fixed by the same change.
- MED catalog read vs a spray lock recorded during the print: refuted. A print made before the lock exists shows the
  job as it was when printed (no number was kept yet); a later reprint shows the kept number.
- MED proof-send retry spanning the migration apply: refuted as not introduced here. A retry re-renders from fresh
  data, as it already does for any change between attempts (weather, acres); the window is the seconds of one apply.
- MED cost-exposure allowlist key: a post-apply step in the migration record (the key is computed from the live chain).
- LOW prover export read as the applicator after the window: fixed (exports the rep's read).
- LOW rollout wording in this contract: fixed above.

## Luna round 3 and Sol round 2 (2026-11-23)

- Luna MED kept-row read could be cut by the API row cap: refuted. At most one row per printed product (primary key
  job_id + product_id), and the label read of the same product list has the same shape and aborts on any gap.
- Sol HIGH WPS pairs the kept number with catalog REI/PHI: fixed in round 2, then reverted in round 3 (below). It took REI/PHI from the job line
  first (filled from the label when the product is picked), then the product, the rule the report, applicator sheet
  and `get_job_proof_data` already use. A line left blank still falls back to the product, as everywhere today.
- Sol MED access removed and restored between the two visibility checks: refuted as needing two opposite access changes
  within one print's milliseconds; each single change is caught.
- Sol MED proof retry across the migration: refuted as in round 1.
- Sol MED the send endpoint does not re-check the rendered EPA text: pre-existing design (the office sender composes
  the body; the endpoint checks the notice and HTML shape); out of scope for KI-195.
- Sol LOW no automated test drives the WPS handler: it is a page handler; the shared `applyKeptEpa` is unit-tested and
  the browser check on staging is owed after merge (Mason signs in).
- Sol LOW three short reads per printed job: accepted; the bulk loop already makes several reads per job.
- Sol LOW KNOWN_ISSUES KI-195 description reads as current: fixed (status line says the description is pre-fix).

## Sol round 3 (2026-11-23)

- HIGH cost-exposure allowlist key deferred to after the apply: fixed. The post-apply key `d4ee3cbf4e79` is computed
  read-only on live with the new body swapped in (the method reproduced today's key `3a3abcd3a1cd`) and carried in
  `scripts/db-invariant-sweeps/allowlist.json`, as `ship.md` Step 5 asks.
- HIGH the WPS notice prints editable job-line REI/PHI (round 2's fix): fixed by reverting it. The WPS notice prints the
  label's REI/PHI again, exactly as on staging. The round-2 HIGH it answered is the next item.
- HIGH a reprint can pair the kept EPA number with today's label intervals (WPS; report, sheet and proof when the job
  line is blank): **NEEDS MASON - DECISION REQUIRED.** The job keeps its EPA number at spray time but not the REI/PHI,
  so no printout can show the intervals that went with that number; it only matters when the catalog's registration
  and intervals changed after the spray. This is the same safety-interval question as Sol round 2 (second round). Two
  answers: (a) ship KI-195 as is (numbers fixed; intervals behave exactly as today) and open a follow-up to keep REI/PHI
  with the EPA number at spray time; (b) hold KI-195 until the intervals are kept too. Recommended: (a), because this
  PR changes no interval and holding it keeps the wrong EPA number on every corrected product's printouts.
- MED access removed and restored between the two visibility checks; MED proof retry across the migration: refuted as
  in round 2.
- LOW pilot log overstated WPS test coverage: fixed (names what is unit-tested and that the WPS handler is not).

## Sol round 4 (2026-11-23): stopped for Mason

- HIGH a kept EPA number beside today's label REI/PHI: the same safety-interval mechanism as rounds 2 and 3, a third
  round in a row, so per AGENTS.md this stops for **NEEDS MASON - DECISION REQUIRED** (question above, round 3).
  No interval code is changed by this PR; the gap is that intervals are not kept at spray time.
- MED retry across rollout; MED access flip between checks: refuted as in rounds 1-3.
- LOW prover export not consumed by a rendering test: accepted; the WPS handler's browser check on staging is owed.
- LOW applicator-sheet test skipped the Custom format: fixed (loops Original, Enhanced and Custom).
- LOW item 36 overstated the bulk path: fixed (the bulk path skips only the failed job and names it).
