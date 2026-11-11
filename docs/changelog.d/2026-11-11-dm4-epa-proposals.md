## 2026-11-11 — DM-4: EPA auto-fill proposals (database, not applied)

- Migration `20270104100000_epa_chemistry_proposals.sql`; build sheet `docs/plans/2026-11-08-product-DM4-BUILD-SHEET.md`.
- An admin starts an EPA lookup for one EPA number on a product (the product's own number, a size's, or a brand's;
  each gets its own lookup). The EPA answer becomes a proposal; nothing is written until an admin commits it.
- A lookup that finds nothing, errors, or returns something unreadable is listed by number and writes nothing else.
- Typed chemistry that disagrees with EPA stays live; the EPA value is shown beside it as a difference (D-L).
- Restricted use (Mason, 2026-11-11, "Yes, tickable"): when EPA says restricted use and the registration says no,
  the proposal offers an unticked box; ticking it records yes and lists the posted sales that now need records.
- A commit is held, not applied, if the number moved, the registration changed or the chemistry changed since the
  lookup.
- Typing chemistry for a product with an EPA number stays refused, except while EPA's newest answer for that
  number is "not found".
- Screens and the Edge Function's record step come in a follow-up PR once the database part is live.
- Proof: `node scripts/smoke/prove-epa-chemistry-proposals-real-schema.mjs`.
