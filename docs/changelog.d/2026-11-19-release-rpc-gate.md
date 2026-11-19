## 2026-11-19 - Release and hotfix PRs can call the RPCs their own migrations create

The v0.1.0 release PR (#1990) was deadlocked. `rpcFixtureLiveDiff.test.ts` passed a PR into main only when every production RPC call was already in the checked-in live snapshot. But the release's migrations go live from the release PR itself, and only once every check on it is green (ship.md, Mason's Decision A, enforced by the migration landing gate). So three new RPCs (`set_invoice_standing_discount`, `set_order_sales_tax`, `set_registration_adjuvants`) could never pass. The queued-exception bridge can't be committed, and the snapshot can't list a function before it is applied.

Taha's call (2026-11-19): a PR into main from `release/next` or `hotfix/<name>`, and a push to main, get the staging rule. They may call an RPC that a checked-in migration creates. Every migration already on main is live, so this admits only the PR's own migrations, and the apply gate puts those live just before the merge. Any other PR into main, and a local run, keep the live rule. Regenerate the snapshot after each release's live apply.

Also: `quotePdf.test.ts` finds the footer by the website as a whole word, not a substring (CodeQL js/incomplete-url-substring-sanitization, a false positive in a test, flagged on #1990).
