## 2026-11-25 — Four small field-split gaps left from FP-1's Sol review

**Severity:** MED (items 1–3), LOW (item 4). **Area:** field payer splits (FP-1,
`20270305190000_field_split_versions.sql`). **Status:** OPEN. **Owner:** unassigned (field-billing lane).
**Tracked:** deferred from Sol round 6 on #2487 (Mason, 2026-11-25: "Land now, follow-up"); listed in #2539.

1. **A tiny share rounds to 0.** A payer entered at a share so small it rounds to 0% (for example
   0.0000001%) is accepted on save, then left out of the billing copy, and another payer becomes main payer.
   Before FP-1 the database refused the rounded-zero share. No real field has such a share.
2. **Only a JSON `true` marks the main payer.** An older caller that sent another yes-value (such as `"yes"`)
   for "main payer" gets success but a different main payer. Today's screen sends true/false, and FP-1 picks
   the main payer automatically (Mason, "Yes, automatic"), so this only matters to an old or outside caller.
3. **A split's author can't be hard-deleted.** Once a rep saves a split, their record is linked to it, so
   permanently deleting their login fails. Deactivating the user still works, and is the normal path.
4. **Bulk Delete gives a fix staff can't do.** Bulk-deleting a field that has split history (but no jobs or
   invoices) says "remove those references first", but split history cannot be removed. A mixed selection
   also stops the other, deletable fields. The message should tell staff to mark the field Inactive instead.

Recheck items 1–2 once the Field Setup screen PR (#2498) is live; item 4 overlaps FP-3 (archiving).
When an item is fixed, remove it here in the fixing PR.
