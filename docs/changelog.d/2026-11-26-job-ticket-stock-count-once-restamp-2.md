## 2026-11-26 — Count-once migration restamped to 20270312120000

Another open branch took `20270311200000`, so the count-once migration moves to `20270312120000` (from `npm run next-migration-stamp`). The SQL is byte-identical; the function bodies carry no stamp, so their fingerprints are unchanged. The branch now merges `origin/staging` instead of rebasing.
