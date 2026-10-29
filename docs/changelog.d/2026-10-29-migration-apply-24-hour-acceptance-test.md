## 2026-10-29 — Migration apply: the 24-hour window is pinned by an acceptance test (PR #1196)

Luna's review of PR #1196 noted that the only new reviewer-proof test refused a 25-hour-old
proof, which the old 30-minute limit would also refuse. `migration-apply-lib.test.mjs` now
also proves that two-hour-old reviewer and Sol apply proofs are accepted. (Luna's other
concern, that the reviewer check still used a 30-minute `MAX_AGE_MS`, does not hold:
that local is assigned from `PROOF_MAX_AGE_MS`, outside the diff it was shown.)
