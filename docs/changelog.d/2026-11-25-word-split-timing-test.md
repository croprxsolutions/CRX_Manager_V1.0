## 2026-11-25 — Guard test no longer fails on a slow PC

Mason: the "shell word splitting stays linear" check in the Codex production guard's tests failed about 2 runs
in 3 on his PC (300–920ms against a 250ms limit), costing 20+ minutes of reruns on PR #2605.

- `.codex/hooks/production-action-guard.test.mjs`: the check now times each adversarial quoting shape at 3,000
  and 24,000 characters (fastest of 5 runs each) and fails only if 8x the input costs 24x the time or more.
  A linear splitter measures about 7–10x; a quadratic one about 52–64x. No wall-clock limit remains, so machine
  speed no longer matters. The timed calls drop the test repo, whose git subprocesses added 100–300ms of noise.
- Proven backwards: with a temporary quadratic rescan added to `splitShellWordsRaw`, the check failed; restored,
  the file passed on repeated runs.
