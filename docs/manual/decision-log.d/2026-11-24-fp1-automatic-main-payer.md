## 2026-11-24 — Field splits: the main payer is picked automatically (FP-1)

**Decision (Mason, 2026-11-24, answering Sol's HIGH on FP-1 "Set Primary is ignored"):** "Yes, automatic". On a split field the main (primary) payer is the field owner when the owner pays, otherwise the largest share (lowest customer id on a tie); staff do not choose it.
**Why:** one fixed rule with nothing to keep in sync; split amounts are unaffected, only which invoice a job links to as its main one.
**What this forbids/implies:** FP-1 (`20270305190000_field_split_versions.sql`) refuses a Field Setup save that marks anyone but the automatic payer primary (`FIELD_PRIMARY_IS_AUTOMATIC`, naming the automatic one), so the old Set Primary button can never report success for a dropped choice, whichever release order FP-1 and the Field Setup screen PR take (Mason, 2026-11-24: "fix them" on Sol's repeat HIGH). Do not add a stored primary choice without a new decision.
