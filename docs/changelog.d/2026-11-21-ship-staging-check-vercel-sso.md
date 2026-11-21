## 2026-11-21 — ship.md: staging deploy check works behind Vercel sign-in

- `.claude/commands/ship.md` step 6 (merge into `staging`): the staging site now sits behind Vercel sign-in, so `curl` of `staging.croprxsolutions.app` returned only a sign-in redirect and could never show the new bundle. The step now waits for the merge commit's `Vercel – crx-manager-v1-0` statuses to read `success`, then compares the `assets/index-*.js` name in a signed-in browser.
- Seen 2026-11-21 landing #2062. Docs-only; no guard or gate changed.
