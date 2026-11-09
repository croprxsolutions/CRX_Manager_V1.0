## 2026-11-08 — REG-1 Step 2: EPA registrations become the one source of label facts (database, not applied)

- Four migrations (`20261218100000` to `20261218130000`): the registration tools, label-draft and product
  setup through registrations, invoice-line sale capture with restricted-use posting from it, the size and
  brand guards, and the one-time seed with its preview. Everything stays off until Mason runs the seed.
- Q7: app users can no longer insert products or write invoice lines directly (neither is used by the app).
- Proof: `node scripts/smoke/prove-epa-registration-step2-real-schema.mjs`.
