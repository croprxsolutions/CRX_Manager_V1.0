## 2026-11-24 — Field splits: the main payer is picked automatically (FP-1)

**Decision (Mason, 2026-11-24, answering Sol's HIGH on FP-1 "Set Primary is ignored"):** "Yes, automatic". On a split field the main (primary) payer is the field owner when the owner pays, otherwise the largest share (lowest customer id on a tie); staff do not choose it.
**Why:** one fixed rule with nothing to keep in sync; split amounts are unaffected, only which invoice a job links to as its main one.
**What this forbids/implies:** FP-1 (`20270303120000_field_split_versions.sql`) ignores `is_primary` from Field Setup. The Field Setup screen PR that removes the Set Primary button must reach live in the SAME release as FP-1, so the old button is never live with a database that ignores it. Do not add a stored primary choice without a new decision.
