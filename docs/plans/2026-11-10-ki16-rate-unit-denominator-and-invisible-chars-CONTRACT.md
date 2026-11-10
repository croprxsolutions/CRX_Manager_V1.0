# KI-16 bullets 1–2: per-X rate units and invisible characters — behavior contract

Read at `8617d3725` (origin/main, 2026-11-10). Live bodies read read-only from `rhyzpcqhnizqbxphqdkr` the same day.

## Facts (with source)

- `save_job` (`_save_job_cost_step2_impl`, rule from `20260820120000`) refuses a job chemical line whose rate unit is
  measured per something other than acres (`CHEM_RATE_DENOMINATOR_NOT_ACRES`): fold everything except letters, digits
  and `/` to a space, strip ONE trailing per-acre suffix (`/ac|acre|acres|a` or ` per …`), refuse if a `/` or a
  whole-word `per` survives. Ungated (any non-blank rate unit). It also refuses a priced line (price ≠ 0) whose units
  carry a character outside `[a-z0-9 ./-]` after mapping U+00A0/U+202F to space and deleting U+200B–U+200D/U+FEFF
  (`CHEM_UNIT_UNSUPPORTED_CHARACTER`).
- Other writers of `job_chemicals` skip that rule (live `pg_proc`, 2026-11-10):
  - `_create_job_from_quote_section_replay_impl_20261015` copies `quote_items.rate_unit` (schedule a job from a
    booking). KI-16 names `_close_quote_as_applied`; its live body writes no job lines, so the quote path is this one.
  - `load_recipe_into_job` copies `products.rate_unit`. Live ACL is `postgres` and `service_role` only (app access
    revoked, `20261023100000`); the app loads recipes client-side (`src/lib/recipeHelpers.ts`) and saves them through
    `save_job`, which already refuses. The trigger still covers the RPC for service-role callers.
- Blend ticket lines (`blend_ticket_products.rate_per_acre_unit`) are written by `create_blend_ticket` /
  `save_blend_ticket` from the manual-ticket and ticket-detail screens (the OCR function does not write this column).
  A per-X unit is refused only when billing (`create_invoice_from_blend_ticket` → `BLEND_TICKET_UNIT_UNCONVERTIBLE`).
- `normalize_rate_unit` (`20260630170000`, live body identical) only `btrim`s ASCII spaces, so `oz<ZWSP>` stays
  `oz<ZWSP>`, matches no size table, and a blend ticket carrying it cannot be invoiced.
- Nothing indexes, constrains or generates a column from `normalize_rate_unit` (live `pg_index`, `pg_constraint`,
  `information_schema.columns`, 2026-11-10), so changing its output rewrites no stored value.
- Live data: `job_chemicals` has 4 rows with rate units `oz` (2), `pt/ac`, `32`; `blend_ticket_products` has 0 rows.
  None would be refused. No `quote_items`, `products` or recipe-product rate unit would be refused either (read-only,
  2026-11-10, after the drift review). Live triggers on both tables match the migration files.
- TypeScript: `baseUnitOfRate` (`src/lib/chemCalculator.ts`) splits on the first `/`, so `oz/cwt` reads as `oz`.
  `normalizeRateUnit` (`src/lib/labelGuardrails.ts`) and `rateBaseUnit` (`src/lib/blendMathValidator.ts`) mirror the
  SQL normalizer; the latter says to relax its zero-width handling in the same change that teaches the SQL to.
- RT-2 (PR #1706, branch `claude/rt2a-unit-remap`) changes product unit spellings and adds a `Dry oz` case to
  `toGallonOrLbEquivalent`. It does not touch `normalize_rate_unit`, `baseUnitOfRate` or the job/blend writers. No overlap.

## Outcome

1. No path can store a job chemical line or a blend ticket line whose rate unit (for a blend line: the unit billing
   will use, the line's own or else the product's) is per-something-other-than-acres in plain letters (`/`, `per`).
   Each is refused when the line is written, with save_job's message and rule. A lookalike slash (U+2215) is refused
   wherever save_job's character rule applies (priced job lines, product blend lines); on an unpriced job line it is
   left to save_job's existing gate. The guarantee is about the denominator only: an unreadable numerator (`32`,
   `.`) still saves and is still refused at billing, as today. No conversion is added.
2. An invisible character pasted into a unit no longer breaks billing: the database normalizer and its TypeScript
   mirrors delete zero-width characters and read non-breaking spaces as spaces.

Smallest change: one SQL helper holding save_job's denominator and character rules, called by one `BEFORE INSERT OR
UPDATE` trigger (OLD/NEW compare) on each of `job_chemicals` and `blend_ticket_products`; `normalize_rate_unit` re-emitted
with the invisible-character fold. TypeScript: shared fold in `labelGuardrails.ts`, used by `normalizeRateUnit` and
`blendMathValidator.rateBaseUnit`; `baseUnitOfRate` keeps a non-acre unit whole instead of truncating it.

Files: `supabase/migrations/<new>.sql`, ledger note, `src/lib/labelGuardrails.ts`, `src/lib/chemCalculator.ts`,
`src/lib/blendMathValidator.ts`, their tests, a prover script, `docs/manual/KNOWN_ISSUES.md`.

Authority: unchanged. Triggers fire for every writer, including SECURITY DEFINER RPCs; they only refuse.

## Rules

- **Denominator rule** (save_job's, run on the invisible-folded unit so `oz p<ZWSP>er cwt` cannot hide its `per`):
  non-blank rate unit; fold `[^a-z0-9/]+` → space; strip one per-acre suffix; refuse on surviving `/` or whole-word
  `per`. Applies to every job line and every blend line, priced or not. save_job's own copy does not fold first, so
  it still refuses `pt/a<ZWSP>c` (stricter, fails closed; left alone).
- **Character rule** (save_job's, with the invisible set widened): after the invisible fold, a character outside
  `[a-z0-9 ./-]` in the rate unit refuses the line — on job lines only when `price_per_unit_cents <> 0` (save_job's
  gate); on blend lines that carry a product (billing converts those), not on free-text lines.
- **Invisible fold** (normalizer and character rule): U+00A0, U+2007, U+202F → space; U+00AD, U+200B, U+200C, U+200D,
  U+2060, U+FEFF deleted. save_job's own character check still refuses U+00AD/U+2007/U+2060 on priced lines (stricter,
  fails closed; left alone).
- Triggers fire on INSERT and every UPDATE and compare OLD with NEW (job: rate unit, price; blend: rate unit,
  product), so a value another BEFORE trigger fills (`trg_guard_seed_each_job_chemical_units`, which sorts first) is
  judged, and an existing row whose judged values did not change is never re-judged by this guard. save_job's own
  validation of the lines it is sent is unchanged.
- Blend lines: a blank or spaces-only line unit is judged through the product's rate unit, as billing reads it; an
  invisible-only line unit is refused (billing would not fall back from it) (Sol rounds 1-2).
- Products: a rate unit edit that a blend line would refuse is refused while an unbilled blend ticket line with no unit
  of its own relies on it (`trigger_zzzz_products_rate_unit_blend_guard`, Sol round 2).
- Job lines on screen: `unitHasCharacterSaveJobRefuses` mirrors save_job's narrower character probe on priced lines.

## Existing rows

Checked live: none would be refused (query above). No backfill.

## Timing

Pure row-level checks in the writer's transaction; a refusal rolls back the whole RPC (job scheduling, recipe load,
ticket save). Retries hit the same refusal. Nothing outside the transaction.

## Delivery

Database-only behavior plus client mirrors that only become more lenient where the database becomes more lenient
(invisible characters) or stop mis-reading a unit the database now refuses (`oz/cwt`). The deployed app keeps working
before and after; one PR, migration applied before merge.

## Proof cases (container/prover, test data)

1. Schedule a job from a booking whose quote line rate unit is `oz/cwt` → refused, `CHEM_RATE_DENOMINATOR_NOT_ACRES`, no job.
2. Load a recipe whose product rate unit is `oz per cwt` → refused, job lines untouched.
3. Save a blend ticket line with `oz/cwt/ac` → refused at save. `pt/ac`, `gal per acre`, `oz` → saved.
4. Priced job line with rate unit `oz∕cwt` (U+2215) → refused `CHEM_UNIT_UNSUPPORTED_CHARACTER`; unpriced → saved.
5. `normalize_rate_unit('oz' || U+200B)` = `oz`; `normalize_rate_unit('fl' || U+00A0 || 'oz')` = `oz`;
   `normalize_rate_unit('oz/cwt')` still `oz/cwt`.
6. A blend ticket line with rate unit `oz<ZWSP>` bills (invoice created) where before it raised `BLEND_TICKET_UNIT_UNCONVERTIBLE`.
7. Existing live-shaped rows (`32`, `pt/ac`, `oz`) update other columns without refusal.
8. TS: `baseUnitOfRate('oz/cwt')` is not `oz`; `normalizeRateUnit('oz​')` = `oz`; blend validator's
   rate-base mirror agrees with the SQL on the same inputs.

## Astra challenge (gpt-6-astra, high, 2026-11-10): 43 points, settled

- Fixed: #2/#3 fold before the denominator probe; #8/#9 blend effective unit and invisible-only → NULL; #14/#16
  triggers on every UPDATE with OLD/NEW compare; #22 `blendMathValidator.normalizeUnit` and `parseApplicationRate`
  use the shared fold; #1/#11/#12/#23 outcome narrowed and stated above.
- Already covered: #6 repricing (price is in the job OLD/NEW compare); #18 `baseUnitOfRate` uses the fold; #29/#41
  postflight re-checks every existing row and both triggers inside the apply transaction, `lock_timeout` 5s;
  #33 prover P1/P2 show no job and untouched lines after a refusal; #30 guards are invoker and only refuse; a
  hidden product name falls back to "This product".
- Out of scope, unchanged by this work (fail closed today): #4/#5/#13/#15 save_job's own stricter checks; #7 the
  stock unit column; #10 a product's rate unit edited after a ticket saved (billing still refuses it);
  #17/#20/#21/#24 pre-existing client/normalizer spacing and multi-denominator differences; #37 RT-2 changes
  spellings only.
- Accepted with reason: #19/#31/#32/#34 callers already show RPC errors as toasts and the refusal names the line
  and unit; the fix is to re-type the unit on the booking or ticket. #25 a unit that now folds compares as its plain
  spelling, which can only add a warning where one was missed. #36 P6 proves the folded unit is `oz`, so billing
  arithmetic is the plain-`oz` path. #38/#39 the client mirrors are advisory; rollback is forward-only (re-create the
  old normalizer only if nothing relies on the fold). #40 restore paths re-insert units that passed this guard.
  #42/#43 suggestions; not taken.

## Reviewers (2026-11-10): rls-security, migration-drift, compliance — 0 BLOCKER, 0 HIGH

- Fixed: trigger functions also revoked from service_role, postflight checks anon on all five functions; live
  source units (`quote_items`, `products`, recipe products) checked: none refused; live triggers match the files;
  comments cite save_job's live body (20260904185900) and the seed guard as a normalizer caller; an invisible-only
  blend unit is blanked only when that unit is written; a blend refusal from the product's default unit says so.
- Fixed (client mirrors, so the screens are never quieter than the database): `chemUnitUnspecifiedSides`,
  `isExplicitlyFluidUnit` and `rateDenominatorIsUnrecognized` fold invisible characters, and the latter folds
  separators exactly as SQL does; the blend validator folds before its blank test and warns when a product's sold
  unit is nothing but invisible characters (billing reads it unfolded); `chemLineBillingHazard` leaves a non-acre
  rate to the row-defect message.
- Left as is: JS `.trim()` vs SQL `btrim` on tabs (comments now name the gap, #20 above); a bare `per acre` stays
  with the client's blank-unit message (existing design); free-text blend lines with a per-X unit are refused at
  save (intended, outcome 1); trigger name order versus the linked-ticket lock changes only which refusal shows.

## Open business decisions

None. Refusing per-X units follows the existing save_job rule (PR #446); no conversion is invented.
