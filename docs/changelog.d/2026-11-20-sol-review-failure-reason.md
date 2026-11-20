## 2026-11-20 — Sol review: a fixed, secret-safe reason when no verdict comes back

When a Sol review (full review or the carry-forward collision check) ended without a
CLEAN or BLOCKERS verdict, the console only said "did NOT return clean", and the
capture's stderr was often redacted, so the cause was invisible and the natural
reaction was to pay for another full run.

What changed (`scripts/write-codex-push-proof.mjs`):
- `captureReviewOutput` now classifies the RAW result before the existing redaction and
  returns `{ capturePath, failureReason }`. The reason is one sentence from a fixed list
  (response limit, usage/rate limit, authentication, connection dropped, Windows sandbox
  at session start, timeout, output buffer exceeded, could not start, terminated, exit 0
  without a verdict, or "exit code N … cause is unknown"). It never echoes stderr or
  spawn error text.
- Only Codex `ERROR` lines are read (bare `ERROR:` or ISO-timestamped `ERROR:` /
  `ERROR <target>:`), and only explicit markers match. The sandbox reason needs both the
  session-start and sandbox-setup signatures, so a later command sandbox error is not
  reported as a startup failure.
- The reason goes to the capture (`Failure reason:`) and to stderr (`Review failure:`).
  The old "Failed to launch Codex: <raw error>" line is gone; timeout guidance is kept.

Unchanged: verdict parsing, proof writing, the single sandbox fallback retry, the
redactor, exit codes.

Proof: `node scripts/write-codex-push-proof.test.mjs` passes, including a credential in
stderr that stays out of the capture and the reason. Not verified: a live Sol run.
