## 2026-11-15 — USE-2 part 1: label adjuvants per EPA registration (not applied)

- Migration `20270119160000_registration_adjuvants.sql` (build sheet `docs/plans/2026-11-15-product-USE2-BUILD-SHEET.md`).
- Each EPA registration can hold the label's adjuvant statements: Required, Recommended or Do not use; an optional
  condition shown first ("when tank mixed with atrazine"); one or more types (for Required/Recommended "any one of",
  for Do not use "none of"); an optional preferred type; a note. Empty means "none on the label"; nothing saved
  means "not reviewed".
- Admins and sales reps save a list with `set_registration_adjuvants`; it changes only the list (a rep cannot change
  RUP, REI, PHI or the label link), needs a reason, refuses a list that changed since the screen opened it, and is
  logged on the registration's history. A number with no registration gets one holding only the list (RUP
  "unknown"), which posting and the compliance list read exactly as a missing one.
- REG-1's one-type entry (`adjuvant_type`) stays valid, so the admin tool keeps working; the screens read it as a one-type statement.
- No screen calls it yet (the product-page PR follows; the quote warning waits for Taha's quote work).
- Proof: `node scripts/smoke/prove-registration-adjuvants-real-schema.mjs`.
