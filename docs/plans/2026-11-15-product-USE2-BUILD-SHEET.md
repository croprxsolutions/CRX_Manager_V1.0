# Product Master USE-2 build sheet: label adjuvants and the "View label" link

**Status (2026-11-15):** a plan only. No code and no migration have been written. Written against `staging` (`8b8962d95`) and the live database, read-only SQL only (counts, no names). For building, this sheet replaces the USE-2 outline in `docs/plans/2026-10-29-product-GRAND-PLAN.md` (Stage 6, "USE-2 ·", and overlaps 8 and 15). Where they differ, this sheet wins on *how* (section 2); the grand plan wins on order and on Mason's settled decisions. **Nothing here authorizes building. Mason reviews this sheet first** (Mason, 2026-11-15: "do not overbuild USE-2").

**What USE-2 does, in one line.** An admin records which adjuvant(s) a product's label requires or recommends (once per EPA number), everyone sees it on the product page, a quote warns about it when the product is added, and "Search EPA labels" becomes "View label" wherever a label PDF link is stored.

**Words used here.**
- **Registration:** one row of `epa_registrations` (REG-1): one per EPA number, shared by every size and brand carrying that number.
- **Label adjuvants:** that row's `label_adjuvants` list. Each entry is *required* or *recommended*, a type (such as COC, MSO, NIS, AMS) and an optional note.
- **Adjuvant:** a product added to the spray tank (oil, surfactant, ammonium sulfate) that the label tells you to use with the chemical.

---

## 1. Facts this plan is built on (checked 2026-11-15)

**The database already has everything USE-2 needs.** REG-1 built it:

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

**What REG-1 stores today, and what is missing.** REG-1 stores the numbers, RUP, signal word, REI, PHI, label max rate, status, and empty slots for the label link and adjuvants. What is missing is only **screens**: nothing in `src` ever writes `set_epa_registration` (REG-1's planned "Edit registration" panel was dropped when Mason simplified REG-1 on 2026-11-09), nothing shows `label_adjuvants`, and `EpaLabelLink.tsx` always says "Search EPA labels" because the screen only reads the cancelled flag (`src/lib/epaRegistrationStatus.ts:20-35`).

**Screens today:**
- `src/components/products/EpaLabelLink.tsx`: the "Search EPA labels" link, shown on the product page (`ProductDetail.tsx:1556`) and on each brand row (`ProductBrandsSection.tsx:503`).
- `ProductDetail.tsx:445-451` already reads the registrations of the product's own number **and every brand's number** in one call (`useCancelledRegistrations`), and keeps only the cancelled ones. USE-2 reuses that one read.
- The quote page (`src/pages/QuoteBuilder.tsx`) reads nothing from registrations.

---

## 2. Where the grand plan's outline differs

1. **No database PR.** The outline assumed USE-2 adds storage. REG-1 already added it, with the admin check, retry key, stale check and history USE-2 needs.
2. **The quote warning waits for Taha.** The quote screens are hands-off until Taha's quote UI work lands (grand plan, note after MOA-1; the cancelled-registration quote warning is held for the same reason). So USE-2 ships in two parts; the quote part is a named dependency, not dropped.
3. **"Once the delivered brand is known, its registration":** quotes do not pick brands, so the quote warning reads the product's own EPA number, as the grand plan says for a quote before a brand is chosen. Brand rows show their own adjuvants on the product page; a warning at delivery is not part of the core job (section 6).
4. **"A label change reaches new quotes only" is dropped.** Keeping an old line's warning frozen would mean saving a copy on every quote line (a new quote-line column and a database PR). Instead the warning is a live reminder while the quote is open: it always shows the label as recorded now, is never saved and never printed. Mason can ask for the frozen copy later if he wants it.

---

## 3. Design

### 3.1 Showing it (everyone)
On the product page, beside the product's own EPA number and beside each brand row's number, one line:
- *Not reviewed* (NULL): "Label adjuvants: not reviewed".
- *Reviewed, none* (`[]`): "Label adjuvants: none on the label".
- Otherwise: "Label requires: COC" and/or "Label recommends: NIS", each note in smaller text.

A number with no registration row shows nothing extra (there is nothing to edit; see 3.2). If the registration read fails or times out, the line says "Couldn't check the label; reload" and the link stays "Search EPA labels"; a failed read is never shown as "not reviewed" or as no row.

### 3.2 Recording it (admins only)
An **"Edit adjuvants"** button (admins only; the database refuses anyone else anyway) opens a small modal for one EPA number:
- rows of *Required / Recommended* + type + optional note; add and remove rows;
- a **"None on the label"** tick (saves `[]`);
- a required **"Why"** box (the database requires a reason);
- it states: "This applies to every product and brand with EPA number X."

Save calls `set_epa_registration` with `p_changes = {"label_adjuvants": [...]}` only, the version it loaded, and one retry key per intent (the `getCreateKeyFor` pattern). Every input is disabled while saving. A timeout re-sends the same request with the same key (house pattern; MOA-1 sheet section 5). `EPA_REGISTRATION_STALE` reloads and says "someone else just changed this". After a successful save the page re-reads the registrations (the existing hook's `refresh` key), so the new list shows at once. It never creates a registration (a missing row needs a RUP answer, which is out of scope).

### 3.3 "View label"
`EpaLabelLink` takes the stored `label_url`. When there is one, it shows **"View label"** and opens that PDF in a new tab; otherwise it stays "Search EPA labels", exactly as today. Links arrive through the EPA lookup when an admin accepts it (DM-4); nothing new fills them. Known limit, not fixed here: if a registration ever had a label date stored without a link, a later lookup with the same date proposes the link as "differs" and does not fill it (`20270105110000:640-651`). Today 0 registrations have a date, so it cannot happen until someone stores one.

### 3.4 The quote warning (after Taha's quote work lands)
When a product is added to a **new quote line**, if its EPA number's registration lists a *required* adjuvant, show a yellow note on that line listing **every** required entry ("Label requires: COC, AMS"); recommended entries show as a softer note. It **never blocks** (Mason, 2026-10-29, answer 3), is **not saved** and is not printed (section 2, point 4). Not reviewed shows nothing. A failed read shows "Couldn't check the label" rather than nothing. Each read is tagged with the line and product it was for; a late reply for a product no longer on that line is ignored.

---

## 4. PRs

**No database PR.**

### 4.1 USE-2 Screens (product page) — can build now
- `src/lib/epaRegistrationStatus.ts`: the existing read keeps the whole row (adjuvants, link, version) beside the cancelled map; existing callers (delivery brand pick, banner) keep working unchanged. Its row type stays local to this file.
- `src/components/products/EpaLabelLink.tsx`: optional `labelUrl` → "View label".
- `src/components/products/LabelAdjuvants.tsx` (new): the 3.1 line and the admin button.
- `src/components/products/LabelAdjuvantsModal.tsx` (new): the 3.2 editor.
- `src/pages/ProductDetail.tsx` and `src/components/products/ProductBrandsSection.tsx`: pass the rows down; place the line beside each number.
- Tests: the three display states; "View label" vs "Search EPA labels"; the editor's stale, timeout and retry-key paths; a non-admin sees no button.

**Gates:** `ProductDetail.tsx` is on `docs/reference/sol-required-paths.md`, so this PR needs one Sol review, then lands on green checks into `staging`. No file in open draft PRs #1877, #1885, #1887, #1890, #1891 is touched (checked 2026-11-15; `src/types/index.ts` and `src/lib/db.ts` are deliberately avoided because #1890 and #1891 touch them).

### 4.2 USE-2 Quote warning — waits for Taha
- One small PR touching the quote line code (`QuoteBuilder.tsx` or whatever Taha's work leaves), reading `get_epa_registrations` for the product's number when a line is added.
- **Dependency:** starts only after Taha's quote UI PRs land. Not on the Sol list unless the file it touches is.

---

## 5. Done when

Observed in the app against the private test copy (`scripts/local-app/`), not only tests:
1. As an admin, record "Required: COC" on a product's EPA number; reload; the product page shows "Label requires: COC". A second size with the same number shows it too, without editing.
2. Tick "None on the label"; the page says "none on the label". A never-reviewed number says "not reviewed".
3. A non-admin sees the line but no "Edit adjuvants" button.
4. A number with a stored label link shows "View label" and opens the PDF; a number without one still shows "Search EPA labels".
5. Two admins edit the same number; the second save is refused as stale and reloads.
6. The change appears in the registration's history (`epa_registration_events`) with the reason.
7. *(Quote PR)* Adding a product whose label requires COC and AMS to a quote line shows both; the quote still saves; swapping the line to another product before the read returns never shows the first product's warning.
8. A failed registration read shows "Couldn't check" on the product page (and the quote line), never "not reviewed".

A flow the test copy cannot run is recorded as owed, not passed.

---

## 6. Not doing (deliberately)

- No new table, column, function or migration (REG-1 already has them).
- No typing a label link by hand: links come from the EPA lookup (DM-4).
- No bulk fill, spreadsheet column or scraping of adjuvants from label PDFs: admins fill them as labels are reviewed.
- No automatic adding of an adjuvant product to the quote.
- No blocking a quote, delivery or sale for a missing adjuvant.
- No saved copy of the warning on quote lines (section 2, point 4).
- No fix to the DM-4 "date stored, link missing" edge case (3.3; it cannot arise today).
- No adjuvant warning at the delivery brand pick or on invoices, PDFs or the field app.
- No linking an adjuvant entry to a specific CRX adjuvant product (type is plain text).
- No admin settings or option tables for adjuvant types.
- No "Edit registration" panel for the other label facts (RUP, REI, PHI…).

---

## 7. Questions for Mason

**NEEDS MASON - DECISION REQUIRED (1 of 3): how should the adjuvant type be entered?**
**Recommended: a short pick list in the editor (COC, MSO, NIS, AMS, UAN) plus "Other" to type,** so "COC" is always spelled the same. No settings screen; the list lives in the editor and is easy to extend later.

**NEEDS MASON - DECISION REQUIRED (2 of 3): is it OK to ship the product-page part now and the quote warning after Taha's quote work lands?**
**Recommended: yes.** Recording and showing adjuvants is useful on its own, and the quote screens are Taha's until his work merges.

**NEEDS MASON - DECISION REQUIRED (3 of 3): who fills them?**
0 of 347 registrations have adjuvants today. **Recommended: admins fill them by hand as each label is reviewed** (no bulk tool). Until a number is filled, the product says "not reviewed" and the quote shows no warning.

---

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
