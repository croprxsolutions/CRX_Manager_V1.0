## 2026-11-01 - Luna advisory review is one committed script

`/codex-review` Step 3A was about 100 lines that each session copied by hand. It is now
`node scripts/luna-review.mjs` (Mason approved this in the Product Master Wave 1 retro).

- It routes to the newest Luna this account can use, `gpt-6-luna` at `xhigh`, in one constant.
  `gpt-6.1-luna` was probed and refused. A refused or substituted model stops the run; there is no
  fallback model.
- It keeps every Step 3A protection, adds an explicit ban on credential reads to the prompt, and
  passes Codex a scrubbed environment.
- Exit codes: 0 clean, 1 findings, 2 did not run.
- An output-limit failure (`max_output_tokens`, twice on PR #1248) is reported as not a review, with
  a `--commit` command for each commit to run instead.
- Advisory only: it writes no proof. Sol, its gates and the hooks are unchanged.

Proof: `scripts/luna-review.test.mjs` (in `test:agent-workflows`), shown failing with void detection,
the Luna pin and the answering-model check each removed. Real Luna runs were watched: CLEAN on a
126-line commit, and on this change, where it found two real defects, both fixed.

Not verified: a live `max_output_tokens` failure. Forcing one with a low limit did not work, so the
void path replays the real error text from the PR #1248 run through a stub. `scripts/overnight-codex-gate.mjs`,
`codex-build.mjs` and `codex-hunt.mjs` still pin `gpt-6-luna` themselves.
