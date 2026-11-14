## 2026-11-12 — DM-4: an over-long EPA ingredient name still matches by CAS (not applied)

- Migration `20270107100000_epa_long_name_keeps_cas_match.sql`, Taha's post-merge LOW on #1810.
- When EPA lists an ingredient under a name longer than 200 characters, the proposal used to report the product's own
  row for that chemical as "missing from EPA" even though EPA lists it by CAS. The over-long entry stays an unticked
  conflict and nothing is written, but it now shows the matching row, and that row is no longer listed as missing.
- Proof: `node scripts/smoke/prove-epa-chemistry-proposals-real-schema.mjs` (cases M2 and H28).
