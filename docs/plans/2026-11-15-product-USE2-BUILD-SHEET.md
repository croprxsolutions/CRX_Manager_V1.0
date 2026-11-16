# Product Master USE-2 build sheet: label adjuvants and the "View label" link

**Status (2026-11-15):** a plan only. No code and no migration have been written. Written against `staging` (`8b8962d95`) and the live database, read-only SQL only (counts, no names). For building, this sheet replaces the USE-2 outline in `docs/plans/2026-10-29-product-GRAND-PLAN.md` (Stage 6, "USE-2 ·", and overlaps 8 and 15). Where they differ, this sheet wins on *how* (section 2); the grand plan wins on order and on Mason's settled decisions. **Nothing here authorizes building. Mason reviews this sheet first** (Mason, 2026-11-15: "do not overbuild USE-2").

**Update (2026-11-15, after Mason's first read):** Mason answered question 2 (yes: product page first, quote warning after Taha) and question 3 (**admins or sales reps** fill the adjuvants). He also asked how the plan handles high-surfactant oils (HSOC, HS-MSO), labels that list several adjuvants with a preferred one depending on the weed and the tank mix, and listing what is in each adjuvant product. Section 3.0 answers these. Two changes follow: the label entry gets a slightly richer shape, and sales reps need their own narrow save. Both need **one small database PR**, so the plan is now one database PR, one product-page PR, and the later quote PR.

**What USE-2 does, in one line.** An admin or sales rep records which adjuvant(s) a product's label requires, recommends or forbids, including "any one of these, this one preferred" (once per EPA number), everyone sees it on the product page, a quote warns about it when the product is added, and "Search EPA labels" becomes "View label" wherever a label PDF link is stored.

**Words used here.**
- **Registration:** one row of `epa_registrations` (REG-1): one per EPA number, shared by every size and brand carrying that number.
- **Label adjuvants:** that row's `label_adjuvants` list. Each entry is one statement on the label (3.0).
- **COC / HSOC:** crop oil concentrate / high-surfactant crop oil concentrate (petroleum oil with more emulsifier). **MSO / HS-MSO:** methylated seed oil / high-surfactant MSO. **NIS:** non-ionic surfactant. **AMS:** ammonium sulfate. **UAN:** liquid nitrogen (28% or 32%) used as a spray additive.
- **Adjuvant:** a product added to the spray tank (oil, surfactant, ammonium sulfate) that the label tells you to use with the chemical.

---

## 1. Facts this plan is built on (checked 2026-11-15)

**The database already has almost everything USE-2 needs.** REG-1 built it (section 2 says what changes):

| Thing | Where | Live? |
|---|---|---|
| `label_adjuvants` column (NULL = not reviewed, `[]` = reviewed and none, else up to 50 entries of `{kind: required\|recommended, adjuvant_type ≤100 chars, note ≤500 chars}`) | `epa_registrations`, `20261210100000_epa_registrations.sql:123`, checked by `_epa_label_adjuvants_valid` (`:89`) | Yes |
| `label_url` (https only, ≤2000 chars) and `label_accepted_on` | same table, `:112-113` | Yes |
| Writer: `set_epa_registration(number, expected_version, changes, reason, label_draft_id, idempotency_key)`: admin only, needs a reason and a retry key, refuses a stale version, logs before/after in `epa_registration_events` | `20261231200000_epa_registration_tools.sql:277` | Yes, working body |
| Reader: `get_epa_registrations(numbers[])`: any active user; returns the whole row, adjuvants and link included | `20261210100000:401` | Yes |
| Label link filler: the EPA lookup (DM-4) proposes `label_url` and `label_accepted_on` (proposal item built at `20270105110000_epa_chemistry_proposals.sql:629-661`); when an admin accepts it, `commit_epa_proposal` (`:859`) writes it through `_epa_registration_update` (`:1016`) | `20270105110000` | Yes |

**Live counts (read-only):**

| Fact | Value |
|---|---|
| Registrations (seed has run) | **347** |
| …with a label link | **0** |
| …with adjuvants reviewed (not NULL) | **0** |
| …cancelled | 0 |
| EPA lookups run (the only thing that stores a link today) | **0** |
| Active products with an EPA number | 294 |
| Active products in category "Adjuvant" | 46 |

**What REG-1 stores today, and what is missing.** REG-1 stores the numbers, RUP, signal word, REI, PHI, label max rate, status, and empty slots for the label link and adjuvants. What is missing is a little database work (the entry shape and a sales-rep save, section 4.0; the current validator would refuse "any one of", "preferred" and "do not use") and the **screens**: nothing in `src` ever writes `set_epa_registration` (REG-1's planned "Edit registration" panel was dropped when Mason simplified REG-1 on 2026-11-09), nothing shows `label_adjuvants`, and `EpaLabelLink.tsx` always says "Search EPA labels" because the screen only reads the cancelled flag (`src/lib/epaRegistrationStatus.ts:20-35`). Today every one of the 347 EPA numbers on active products and parent brands has a registration (0 missing), but nothing in the app creates one for a number added later.

**Screens today:**
- `src/components/products/EpaLabelLink.tsx`: the "Search EPA labels" link, shown on the product page (`ProductDetail.tsx:1556`) and on each brand row (`ProductBrandsSection.tsx:503`).
- `ProductDetail.tsx:445-451` already reads the registrations of the product's own number **and every brand's number** in one call (`useCancelledRegistrations`), and keeps only the cancelled ones. USE-2 reuses that one read.
- The quote page (`src/pages/QuoteBuilder.tsx`) reads nothing from registrations.

---

**Adjuvant products today (live counts, 2026-11-15):** 46 active products in category Adjuvant. 0 carry an EPA number (adjuvants are usually not EPA-registered, so REG-1 holds nothing for them). Going by product name alone: 4 look like MSO, 4 COC, 2 surfactant, 5 AMS, 4 drift or deposition aids, 0 say "HS"; 44 have a description. DM-1 chemistry (`active_ingredients`, product page) has no category limit and allows an ingredient without a CAS number, so an admin can already list what is in an adjuvant product today.

## 2. Where the grand plan's outline differs

1. **Storage exists, but needs one small change.** REG-1 already stores the list, with a retry key, stale check and history. USE-2 changes the shape of one entry (3.0) and adds a save that sales reps may use (3.2). Every registration's list is still empty (0 of 347), so nothing has to be converted.
2. **The quote warning waits for Taha.** The quote screens are hands-off until Taha's quote UI work lands (grand plan, note after MOA-1; the cancelled-registration quote warning is held for the same reason). So USE-2 ships in two parts; the quote part is a named dependency, not dropped.
3. **"Once the delivered brand is known, its registration":** quotes do not pick brands, so the quote warning reads the product's own EPA number, as the grand plan says for a quote before a brand is chosen. Brand rows show their own adjuvants on the product page; a warning at delivery is not part of the core job (section 6).
4. **"A label change reaches new quotes only" is dropped.** Keeping an old line's warning frozen would mean saving a copy on every quote line (a new quote-line column and a database PR). Instead the warning is a live reminder while the quote is open: it always shows the label as recorded now, is never saved and never printed. Mason can ask for the frozen copy later if he wants it.

---

## 3. Design

### 3.0 What one label entry holds (answers Mason's 2026-11-15 questions)

Labels say three kinds of things about adjuvants, and often offer a choice:
- "Add COC **or** MSO **or** NIS; MSO gives the best control of large weeds or under dry conditions" (a choice with a preferred one, and a reason);
- "**Also** add AMS at 8.5–17 lb per 100 gal" (a second, separate requirement);
- "**Do not** add AMS" or "do not use COC when tank mixed with X" (forbidden; using it can cause crop injury or drift).

REG-1's entry holds only *required/recommended* + **one** type + a note. Three required entries would read as "add all three", which is wrong for a choice. So each entry becomes **one statement on the label**:

| Part | Holds |
|---|---|
| Kind | **Required**, **Recommended**, or **Do not use** |
| When | Optional, up to 200 characters: the condition this statement applies under ("tank mixed with atrazine", "waterhemp over 4 in.", "corn after V8"). Blank means always. **Shown first**, so a conditional statement never reads as an unconditional one. |
| Types | One or more from the type list. For Required and Recommended, more than one means **"any one of these"**. For Do not use, more than one means **"none of these"**. |
| Preferred | Optional, Required/Recommended only: which of this statement's types the label prefers **under this statement's condition** |
| Note | Free text, up to 500 characters: the label rate and anything else worth reading |

**Type list** (one fixed list in the editor, so spellings match): NIS, COC, HSOC, MSO, HS-MSO, Vegetable oil, AMS, UAN, Water conditioner, Drift reduction, Deposition aid, Defoamer, plus **Other** (typed). HSOC and HS-MSO are their own types because labels name them as such; a label that says "MSO or HS-MSO" lists both.

Example of a full label as entered (a preference that changes by weed or tank mix is simply two statements with different "When"):
- Required · any of HS-MSO, MSO, COC · preferred HS-MSO · note "1% v/v"
- When "tank mixed with atrazine" · Required · COC
- Required · AMS · note "8.5–17 lb / 100 gal"
- When "corn after V8" · Do not use · any of UAN, COC (meaning neither)

**Weed and tank-mix conditions are typed text in "When"**, not structured rules: the app shows the condition, it does not check it against the quote. Making the app pick the right adjuvant for a given weed and tank mix would need a weed list, a tank-mix list and a rule engine checked against every label; that is well beyond the core job (section 6).

**What is in each adjuvant product** (its oil and surfactant percentages, AMS content): **not part of USE-2.** It is not needed to warn a quote about a label's requirement. DM-1's chemistry section lets an admin list ingredients on any product, but whether it fits "% oil / % surfactant" for an adjuvant has not been checked; composition is a separate later item if Mason wants it. A simple "adjuvant type" tag on each of the 46 adjuvant products, so a quote could say "label wants HS-MSO; you carry these", is a possible later step (section 6).

### 3.1 Showing it (everyone)
On the product page, beside the product's own EPA number and beside each brand row's number, one line:
- *Not reviewed* (NULL): "Label adjuvants: not reviewed".
- *Reviewed, none* (`[]`): "Label adjuvants: none on the label".
- Otherwise, one line per statement, condition first: "Requires one of: **HS-MSO** (preferred), MSO, COC", "**When tank mixed with atrazine:** requires COC", "Requires: AMS", "**When corn after V8: do not use** UAN or COC" (in red), each with its note in smaller text.

A number with no registration row shows nothing extra (there is nothing to edit; see 3.2). If the registration read fails or times out, the line says "Couldn't check the label; reload" and the link stays "Search EPA labels"; a failed read is never shown as "not reviewed" or as no row.

### 3.2 Recording it (admins and sales reps; Mason, 2026-11-15)
An **"Edit adjuvants"** button (admins and sales reps) opens a small modal for one EPA number:
- rows of *Required / Recommended / Do not use* + one or more types (tick boxes from the list, "Other" typed) + optional preferred type + note; add and remove rows;
- a **"None on the label"** tick (saves `[]`);
- a required **"Why"** box (the database requires a reason);
- it states: "This applies to every product and brand with EPA number X."

Save calls the new `set_registration_adjuvants` (4.0), which changes **only** the adjuvant list (a sales rep can never change RUP, REI, PHI or the link through it), the version it loaded, and one retry key per intent (the `getCreateKeyFor` pattern). Every input is disabled while saving. A timeout re-sends the same request with the same key (house pattern; MOA-1 sheet section 5). On `EPA_REGISTRATION_STALE` the editor **keeps what the rep typed**, shows the list someone else just saved beside it, and lets the rep save again on top of the new version (never a silent reload). After a successful save the page re-reads the registrations (the existing hook's `refresh` key), so the new list shows at once. For an EPA number with no registration yet, the same save creates one holding only the adjuvant list, with every other fact at its empty default (RUP "unknown", as REG-1's own seed default); the builder confirms in the prover that posting and the compliance screens treat such a row exactly as they treat a number with no registration.

### 3.3 "View label"
`EpaLabelLink` takes the stored `label_url`. When there is one, it shows **"View label"** and opens that PDF in a new tab; otherwise it stays "Search EPA labels", exactly as today. Links arrive through the EPA lookup when an admin accepts it (DM-4); nothing new fills them. Known limit, not fixed here: if a registration ever had a label date stored without a link, a later lookup with the same date proposes the link as "differs" and does not fill it (`20270105110000:640-651`). Today 0 registrations have a date, but it can happen after launch if EPA returns a date without a link and later the link. Then the admin sees the proposal marked "differs" with the link, and "View label" stays off for that number. Fixing it is a change to DM-4's lookup, not USE-2; logged as a follow-up.

### 3.4 The quote warning (after Taha's quote work lands)
For **every product line shown on a quote being built or edited** (a line just added, a line whose product is changed, and every line of a reopened quote), read the registration of that product's own EPA number and show a note on the line listing **every** statement, worded as on the product page ("Requires one of: HS-MSO (preferred), MSO, COC · Requires: AMS"), with each note; recommended entries show softer; "Do not use" entries show in red. It **never blocks** (Mason, 2026-10-29, answer 3), is **not saved** and is not printed (section 2, point 4). The note names the EPA number it read ("Label 100-1234:"), so nobody takes it for a brand's label. While the read is pending the line says "Checking label…"; not reviewed says "Label adjuvants not reviewed" (grey); a product with no EPA number says nothing; a failed read says "Couldn't check the label". Each read is tagged with the line and product it was for; a late reply for a product no longer on that line is ignored.

---

## 4. PRs

### 4.0 USE-2 DB (one small migration)
`supabase/migrations/<stamp>_registration_adjuvants.sql`:
- **Preflight:** refuse unless every `epa_registrations.label_adjuvants` is NULL or `[]` (0 filled today), and `set_registration_adjuvants` does not exist.
- **New entry shape:** re-issue `_epa_label_adjuvants_valid` so each entry is `{kind: required|recommended|do_not_use, adjuvant_types: 1–8 non-blank strings ≤100 chars with no repeats, preferred?: one of adjuvant_types, note?: ≤500 chars}`; still NULL = not reviewed, `[]` = none, at most 50 entries. The type list itself stays in the editor, not the database, so "Other" text is allowed.
- **New save:** `set_registration_adjuvants(p_epa_registration text, p_expected_version bigint, p_adjuvants jsonb, p_reason text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`, `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `EXECUTE` for `authenticated` only. Refuses anyone who is not an active admin or sales rep (`is_admin()` / `is_sales_rep()`), a missing key, a blank reason or one over 1,000 characters (the `set_epa_registration` cap), a bad number, a stale version, and a bad list. **Order:** take the same exclusive registration lock as `set_epa_registration` first, then the retry-key check (so two identical requests sent at once: the second waits, finds the first one's receipt and returns it, never "stale"; the same key with a different request is refused), then the row. An existing row: writes only `label_adjuvants` through `_epa_registration_update`. A missing row (`p_expected_version` NULL): inserts it through `_epa_registration_insert` with only `rup_status 'unknown'` and the list. Logs one `epa_registration_events` row with before and after, saves its retry receipt last, returns a small receipt (number, new version, event id).
- `set_epa_registration` stays admin-only and unchanged; it uses the same validator.
- **Postflight:** grants as above; the md5 of every other REG-1 and DM-4 function unchanged.
- **Files:** the migration; `scripts/smoke/prove-epa-registrations-real-schema.mjs` and `src/lib/rpcFixtureLiveDiff.test.ts` (they use the old entry shape); ledger record, migration note, `docs/reference/rpc-functions.md`, regenerated `src/types/supabase.ts`.
- **Rollback:** its own migration drops `set_registration_adjuvants` (reps stop saving) and **keeps the new validator**, so every list already entered stays valid and readable; nothing is deleted. Any further repair goes forward in a new reviewed migration.
- **Gates:** under `supabase/`, so Luna, Sol and the apply proof gate as usual. Non-destructive.
- **Prover cases:** two identical requests at once write once and both get the same answer; a sales rep creates a registration for a new number and posting treats it as before; a do-not-use statement with two types is stored and read back as "none of these"; a sales rep saves a list; a sales rep cannot change any other field; a driver or inactive user is refused; a preferred type outside the entry's types is refused; repeated types refused; stale version refused; same key twice writes once.

### 4.1 USE-2 Screens (product page) — after 4.0 is applied
*Lands after 4.0 is applied.*
- `src/lib/epaRegistrationStatus.ts`: the existing read keeps the whole row (adjuvants, link, version) beside the cancelled map; existing callers (delivery brand pick, banner) keep working unchanged. Its row type stays local to this file.
- `src/components/products/EpaLabelLink.tsx`: optional `labelUrl` → "View label". `ProductDetail.tsx` passes the link only when the EPA number in the form equals the **saved** number (the registrations are read for the saved number, `ProductDetail.tsx:447`, while the field shows the typed one, `:1556`); while an admin is typing a different number it stays "Search EPA labels" for the typed number. The adjuvant lines follow the same rule.
- `src/components/products/LabelAdjuvants.tsx` (new): the 3.1 lines and the edit button (admins and sales reps).
- `src/components/products/LabelAdjuvantsModal.tsx` (new): the 3.2 editor.
- `src/pages/ProductDetail.tsx` and `src/components/products/ProductBrandsSection.tsx`: pass the rows down; place the line beside each number.
- Tests: the display states (not reviewed, none, a choice with preferred, do not use); "View label" vs "Search EPA labels"; the editor's stale (draft kept), timeout and retry-key paths; an admin and a sales rep see the button, a driver does not; an unsaved typed EPA number never shows the saved number's label.

**Gates:** this PR touches no file under `supabase/`; `ProductDetail.tsx` is on `docs/reference/sol-required-paths.md`, so this PR needs one Sol review, then lands on green checks into `staging`. No file in open draft PRs #1877, #1885, #1887, #1890, #1891 is touched (checked 2026-11-15; `src/types/index.ts` and `src/lib/db.ts` are deliberately avoided because #1890 and #1891 touch them).

### 4.2 USE-2 Quote warning — waits for Taha
- One small PR touching the quote line code (`QuoteBuilder.tsx` or whatever Taha's work leaves), reading `get_epa_registrations` for the product's number when a line is added.
- **Dependency:** starts only after Taha's quote UI PRs land. Not on the Sol list unless the file it touches is.

---

## 5. Done when

Observed in the app against the private test copy (`scripts/local-app/`), not only tests:
1. As a sales rep, record "Required · any of HS-MSO, MSO, COC · preferred HS-MSO" plus "Required · AMS" plus "Do not use · UAN"; reload; the product page shows all three as worded in 3.1. A second size with the same number shows them too, without editing.
2. Tick "None on the label"; the page says "none on the label". A never-reviewed number says "not reviewed".
3. A driver or other user who is neither admin nor sales rep sees the lines but no "Edit adjuvants" button. A sales rep has no way to change RUP, REI, PHI or the link.
4. A number with a stored label link shows "View label" and opens the PDF; a number without one still shows "Search EPA labels".
5. Two admins edit the same number; the second save is refused as stale and reloads.
6. The change appears in the registration's history (`epa_registration_events`) with the reason.
7. *(Quote PR)* Adding a product whose label holds the four example statements in 3.0 shows all four, conditions first; reopening the saved quote shows them again; a not-reviewed product says so; the quote still saves; swapping the line to another product before the read returns never shows the first product's warning.
8. A failed registration read shows "Couldn't check" on the product page (and the quote line), never "not reviewed".

A flow the test copy cannot run is recorded as owed, not passed.

---

## 6. Not doing (deliberately)

- No new table or column (REG-1's list is reused; only its entry shape and one narrow save change).
- No typing a label link by hand: links come from the EPA lookup (DM-4).
- No bulk fill, spreadsheet column or scraping of adjuvants from label PDFs: admins fill them as labels are reviewed.
- No automatic adding of an adjuvant product to the quote.
- No blocking a quote, delivery or sale for a missing adjuvant.
- No saved copy of the warning on quote lines (section 2, point 4).
- No adjuvant warning at the delivery brand pick or on invoices, PDFs or the field app.
- No linking an adjuvant entry to a specific CRX adjuvant product, and no "adjuvant type" tag on the 46 adjuvant products (a possible later step; not needed for the warning).
- No structured weed or tank-mix rules: when and why goes in the note (3.0).
- No composition (oil / surfactant percentages) for adjuvant products.
- No checking a "When" condition against the quote's other lines.
- No fix to DM-4's "date stored, link missing" case here (3.3; a DM-4 follow-up).
- No admin settings or option tables for adjuvant types.
- No "Edit registration" panel for the other label facts (RUP, REI, PHI…).

---

## 7. Questions for Mason

**Answered 2026-11-15:** the earlier question 2, yes (product page now, quote warning after Taha's quote work); the earlier question 3, **admins or sales reps** fill them, by hand as labels are reviewed.

**NEEDS MASON - DECISION REQUIRED (1 of 1): is this the right type list?**
NIS, COC, HSOC, MSO, HS-MSO, Vegetable oil, AMS, UAN, Water conditioner, Drift reduction, Deposition aid, Defoamer, and Other (typed). **Recommended: yes**; add or remove any you never see on your labels. It does not hold up building: "Other" takes any label wording, and the list can change later in a small screen PR.

**Moved out of the questions (Sol, 2026-11-15):** tagging the 46 adjuvant products with a type is not needed for USE-2 and is listed in section 6 as a later step.

## 8. Review record

**Sol advisory** (`gpt-6-sol`, high, read-only, 2026-11-15, plan text plus the cited code): 9 findings (2 HIGH, 6 MED, 1 LOW), none scope-only.
- HIGH: the unsaved quote warning disappears or changes on reopen → **cut, not built**: saving it needs a new quote-line column; the warning is now a live reminder and the "new quotes only" line is dropped (section 2, point 4).
- HIGH: reading only the product's own number misses brand numbers → **refuted**: the grand plan says a quote before a brand is chosen uses the generic's own registration; quotes never pick a brand. Brand rows show their own adjuvants on the product page.
- MED: late reply on a swapped quote line → fixed (3.4).
- MED: failed quote read looks like "not reviewed" → fixed (3.4).
- MED: failed product-page read looks like no row → fixed (3.1).
- MED: page does not refresh after a save → fixed (3.2).
- MED: quote warning must list every entry → fixed (3.4).
- MED: DM-4 leaves no link when a date is stored without one → true; **named limit, not fixed** (fixing it needs a migration, and 0 registrations have a date today) (3.3).
- LOW: wrong citation for where the link is written → fixed (section 1).

**After Mason's answers (2026-11-15):** sales reps may fill adjuvants, and the entry gains "do not use", "any one of" and "preferred" (3.0). That adds the small database PR in 4.0. It gets its own Luna and Sol rounds when built; this plan change has not been re-reviewed.

**Sol advisory round 2** (`gpt-6-sol`, high, read-only, 2026-11-15; given Mason's issue and scope, the plan and the cited code): 16 findings (7 HIGH, 7 MED, 2 LOW), plus 2 scope-only and 2 cut suggestions. All checked against code and live counts:
- HIGH: one "preferred" cannot change by weed or tank mix → fixed: an optional **When** condition per statement, shown first; a changing preference is two statements (3.0).
- HIGH: "any one of" made no sense for Do not use → fixed: for Do not use, several types mean "none of these" (3.0).
- HIGH: no way to record adjuvants for a number with no registration → fixed: the new save creates it with only the list (3.2, 4.0). Live: 0 numbers missing today, but nothing creates one later.
- HIGH: the quote reads only the product's own number → kept (grand plan rule; quotes pick no brand), and the note now names the EPA number it read (3.4).
- HIGH: the warning was read only for new lines → fixed: every line shown, including a reopened quote and a changed product (3.4).
- HIGH: rollback could not run once reps had saved → fixed: rollback drops the save and keeps the validator and data (4.0).
- MED: a conditional statement read as unconditional → fixed by "When" shown first.
- MED: not reviewed looked like "none" on a quote → fixed (3.4).
- MED: no pending state on the quote → fixed: "Checking label…" (3.4).
- MED: DM-4 date-without-link case can arise after launch → wording corrected; logged as a DM-4 follow-up, not USE-2 (3.3).
- MED: two identical saves at once could answer "stale" → fixed: lock before the retry-key check (4.0).
- MED: a stale save could throw away a rep's typing → fixed: the draft is kept (3.2).
- MED: "View label" could show beside an unsaved typed number → fixed: only for the saved number (4.1). Confirmed at `ProductDetail.tsx:447` vs `:1556`.
- MED: the test said non-admins see no button, which excludes reps → fixed (4.1).
- LOW: "only screens are missing" was false → fixed (section 1).
- LOW: no cap on the reason → fixed: 1,000 characters (4.0).
- Scope-only, not added: adjuvant composition; tagging adjuvant products (section 6).
- Cut, taken: the type list no longer blocks building (section 7); the save returns a small receipt instead of the whole row.
