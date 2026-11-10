## 2026-11-07 - Migration hard-rules check never silently skips

Found 2026-11-07 in the DM-1 session: `scripts/check-migration-hard-rules.mjs`
accepted only raw 40-character SHAs. `--head HEAD` was refused ("check could not
run"), and any `--base` that was not a raw SHA (`origin/main`, a branch name, a
typo, or a SHA missing from the clone) printed "no comparison base available;
nothing to compare" and exited 0. A local run could report success while having
checked nothing.

Now:

- `--base` and `--head` accept any ref name (`HEAD`, `origin/main`, a branch) and
  resolve it with `git rev-parse --verify <ref>^{commit}` before use.
- A `--base` or `--head` that does not resolve exits 2 ("could not run") at once,
  before any diff work.
- The only remaining skip is the all-zero base SHA GitHub sends on a brand-new
  branch push, which is still printed as a notice.

Callers: the `SQL Migration Validation` CI step passes GitHub event SHAs from a
full-history checkout, so they always resolve and its result is unchanged. The
`check:migration-hard-rules` npm script uses `--audit-all`, which is untouched.

Proof: `node scripts/check-migration-hard-rules.test.mjs` adds two scenarios
(ref names resolve and catch an edited applied migration; an unresolvable base
exits 2 with no skip notice). The first failed on the old code with exit 2 for
`--head HEAD`; the old code also exited 0 for `--base origin/main`.
