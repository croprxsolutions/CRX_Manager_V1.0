# PAR-1 EPA-correction enable (build sheet 7.7): behavior contract

Read at `origin/staging` `3dd8f9bbf` and live (read-only) on 2026-11-23.

## Facts (with sources)

- The correction is already live and switched off: `correct_product_parent_identity` / `_product_parent_identity_after`
  (`20261207113000`, applied 2026-11-07) write the parent and every size in one logged event, refuse a stale version,
  reuse a retry key, need a reason and evidence, are admin-only, and refuse while any invoice line for a size whose
  number would change has no EPA copy of its own (`PRODUCT_PARENT_EPA_RECORD_UNSAVED`). Proven by
  `scripts/smoke/prove-parent-epa-correction-real-schema.mjs` with the switch forced on. The only thing off is
  `_product_parent_epa_correction_enabled()` (`SELECT false`; live checked 2026-11-23).
- Sprayed and finished jobs keep each product's number in `job_product_epa` (`20261204120000`, live).
- Old-record readers (full trace 2026-11-23, every printout of an EPA number):
  - Keep their own copy: invoice lines (PDF falls back to the product only for a line with no copy, which the
    correction refuses), statements, logbook `product_data`, RUP register, delivery receipt brand picks.
  - Read the job's kept number (`src/lib/jobEpa.ts`, KI-195 #2330 on staging): applicator sheet, chemical application
    report, WPS notice. Sent spray proof: `get_job_proof_data` reads it after `20270225193000` (staging, NOT applied).
  - **Still read the product's current number:** `get_customer_year_end_summary` (body in `20270201100000`, staging,
    NOT applied; live has the `20261013220000` body, same reader) selects and groups by `p.epa_registration`; the batch
    version only calls it. This package fixes it.
  - Read current by design: jobs not sprayed or finished yet, quotes/orders (screen only), purchase orders (accepted,
    record map), Master Mix (planning sheet, KI-195 Sol r1), catalog lists.
- Live Atrazine 4L (2026-11-23): parent `Atrazine 4L` at 352-314 with three sizes (2.5 Gal, Bulk, 265 Gal tote), all
  352-314, `is_rup` false; brand `Atrazine 4L (Winfield)` 1381-158 (untouched: the correction writes no brand). No
  invoice line without a copy on a live invoice (the one blank line is on a deleted draft); 0 job lines, 0 kept rows,
  0 RUP records. Registration 352-314 exists (`rup_status` no, status unknown); 100-497-37686 has none.

## Superseded parts of section 7.7 (established decisions)

- "Move sizes between registrations" and `p_expected_target_registration_version`: superseded by REG-1's 2026-11-09
  simplification (Mason: "Drop them"; REG-1 sheet line 11): registrations are a reference list beside sizes, nothing
  copies facts from them, and sizes may differ from their registration. The correction changes the number only.
- Job EPA snapshot side table and `refresh_job_epa_snapshot` open-job offer: superseded by `job_product_epa`
  (Mason, 2026-11-06, "lock per product"; REG-1 sheet section 7). A job not sprayed yet shows the corrected number
  automatically; a sprayed or finished one keeps its number. No offer is built.
- Record-map follow-up 5 (old blank invoice lines block a correction): the refusal stays; it names the invoice. For
  Atrazine 4L there are none, so no decision is needed now.

## Outcome and authority

An admin opens a parent, **Correct identity**, types the new EPA number, a reason and evidence, previews and saves.
Every size takes the new number; old invoices, statements, sprayed jobs' printouts, the spray proof, RUP records,
delivery receipts and the year-end summary keep showing the number they were made with.

Smallest change:
- Migration `20270227100000_parent_epa_correction_on.sql` (one transaction, NOT APPLIED):
  1. `_product_parent_epa_correction_enabled()` returns true (same signature, owner, no grants).
  2. `get_customer_year_end_summary(uuid, integer)` re-emitted from the `20270201100000` body with one change: the
     product-usage rows select and group by `COALESCE(_epa_norm(ii.epa_registration), _epa_norm(p.epa_registration))`
     (the line's copy; the product's only for a line with none). Same signature, gate, grants, security.
  - Preflight: one transaction; `20270201100000` and `20270225193000` applied (pinned body md5s); switch still false;
    every sprayed or finished job has a kept number for each of its products (the `20261204120000` invariant).
  - Report rows also sort by EPA number, so two numbers for one product keep a stable order.
  - Postflight: switch true; year-end grants and attributes as before.
- `ParentIdentityModal.tsx`: drop the "switched off" note; say old records keep their number; the preview shows each
  size's current number → the new one (Astra #31).
- No change to who may act: admin only, enforced by `_product_parent_require_admin()` inside the RPC.

## State and failure

- No automatic record change beyond what the live RPC already does (parent + sizes, one event).
- Existing rows: none written at apply. After apply the year-end summary of an old season shows each line's stored
  number; lines stored with spacing differences now group by the trimmed copy (`_epa_norm`).
- Rollout order (database): `20270201100000` and `20270225193000` must be live first (preflight refuses otherwise).
  App: KI-195's screens must be deployed to production before the apply, or a sprayed job printed from the old app
  would show the product's (new) number. Already-deployed app works with either database state.
- Timing: double click / retry use the existing key; stale version refused (existing, proven).
- Undo: correct back to the old number with a reason (a new event, not a restore: sizes added since take it too).
  The migration's rollback re-emits ONLY the switch as false and keeps the line-copy year-end reader; restoring the old
  reader after a correction would print the new number on old invoices (Astra #45).
- Exceptions already accepted (record map): a job sprayed or finished before `20261204120000` prints **Not recorded**
  rather than any number; a blank invoice line for a size that had no number shows the new number (Mason accepted,
  record map follow-up 4); invoices and RUP records made after the correction take the new number. A deleted draft
  invoice restored after a correction behaves as any draft: saving it fills its lines from the trigger.
- Clearing: an admin may clear the number (the server allows null); the preview shows "→ (none)" for the parent and
  every size, and old records still keep their copies.

## Proof cases (real migrated database in the local prover container; never production)

1. Before this file: an EPA change is refused `PRODUCT_PARENT_EPA_CORRECTION_OFF`.
2. The file refuses outside one transaction and a second apply.
3. After it: an admin corrects a parent with two sizes; both sizes show the new number; a rep is refused.
4. A completed (sprayed) job's spray proof (`get_job_proof_data`) still prints the old number; an unsprayed job shows
   the new one.
5. A posted invoice's line, the detailed statement and the RUP register keep the old number.
6. The customer year-end summary for that posted invoice still prints the old number (it printed the new one before
   this file), and a line with no copy for a numberless size shows the size's number.
7. A delivery's brand pick keeps its brand's own number.
8. A retried correction returns the same receipt; a stale version is refused.

## Open business decisions

None for this file. Mason's "Yes, change it" for Atrazine 4L covers the data change, which is made in the app after this file is live,
not by this file.

## Cold challenge settlement (Astra `gpt-6.2-astra` high, 2026-11-23, 57 findings)

Changed because of it:
- #45 BLOCKER (rollback restores the old reader): rollback is the switch only; header and this contract say so.
- #1, #2 BLOCKER (a missing kept row prints the corrected number): live checked 2026-11-23, every line of a sprayed or
  finished job has a kept row (4 job lines; the one sprayed job has its row); the apply now refuses if any is missing.
- #22 (row order): tie-break on the EPA number. #31 (preview hides each size's number): shown. #16, #17, #30, #3, #46:
  written into State and failure above.

Disproved with evidence:
- #21 (`coalesce` JSON key): the select has `AS epa_registration`; the prover reads the `epa_registration` key.
- #14, #15 (regenerated year-end differs from one issued earlier): live 2026-11-23, 0 live invoice lines whose copy
  differs from the product's number, so applying the reader changes no report today; regenerating from what each
  invoice recorded is the established rule ("old records keep the number they were made with").
- #25 (access): the body is copied byte for byte (preflight md5 of the source; postflight checks the one changed
  select); gate, grants and security are unchanged and checked in postflight.
- #48 (note wrong while off): while off, Save is refused with the server's own message; the note is true once on.
- #49, #53 (no migration, proposals not results): the migration and its prover are in this PR; results in the
  migrations.d record.
- #20: live has 0 padded copies and 1 whitespace-only copy (an unposted invoice for a size with a number); a
  correction of that parent is refused until it is saved, so the PDF/report difference cannot show for it.

Not this package (already reviewed and live or on staging; listed as follow-ups in the PR): #4-#13 (KI-195 readers and
proof send rules, #2330 / `20270225193000`), #18, #19, #26, #27, #43 (invoice writer and trigger behavior,
`20261207113000`), #34-#38, #42, #44 (the live correction RPC, proven by `prove-parent-epa-correction-real-schema.mjs`),
#47 (old open browser tabs: Atrazine 4L has no jobs, so its first correction prints nothing through an old tab), #50,
#51 (the prerequisites' own reviews), #54 (record map updated here), #55-#57 (the smaller design is this one: reader
fix plus switch, rollback switch-only).

Atrazine 4L only (Mason's call in the parent session, not this file): #39 (the label shows 100-497-37686 for each size),
#40 (atrazine is usually restricted-use; live says `is_rup` false), #41 (the yes covers the three sizes, not the
1381-158 brand).
