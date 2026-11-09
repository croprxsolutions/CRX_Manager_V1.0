## 2026-11-08 — REG-1 Step 2: EPA registrations become the one source of label facts (database, not applied)

- Three migrations (`20261218100000`, `20261218120000`, `20261218130000`): the registration edit tool,
  restricted-use posting under the number each line was sold under (a record when that number's registration or
  the product's own tick says Yes), Sales to check, and the one-time seed with its preview. Everything stays off
  until Mason runs the seed.
- Q7: app users can no longer write invoice lines directly (the app never does).
- Simplified 2026-11-09 (Mason: "Yes, simplify", then "Drop them"): no per-line copy of the label facts, and no
  guards: sizes and brands keep their own label facts and stay directly editable; the registration list sits beside
  them. Label drafts, product setup and brand tools are unchanged.
- Proof: `node scripts/smoke/prove-epa-registration-step2-real-schema.mjs`.
