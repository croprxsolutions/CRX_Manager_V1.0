## 2026-10-29 - Home .claude exemption refuses paths that climb out with ..

- **Agent guards (security review, PR #1195).** The review-proof guard's exemption for the personal home `.claude` folder no longer applies to a path containing a `..` segment, so such a path is judged like any other and the repository's guard files stay protected.
