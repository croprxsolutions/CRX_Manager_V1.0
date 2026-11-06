## 2026-11-05 — The staging site can reach the staging database

- `vercel.json`: the Content-Security-Policy now also allows the staging Supabase project
  (`fsnjredpmakbmhwowjjt`, test data only) in `connect-src` (https and wss) and `img-src`. Before,
  only the live project was allowed, so a `staging` deployment pointed at the staging database
  would have every request blocked by the browser. Nothing else in the policy changes, and live
  builds still point at the live project through their own environment variables.
- Rollback: remove the two `fsnjredpmakbmhwowjjt` entries.
