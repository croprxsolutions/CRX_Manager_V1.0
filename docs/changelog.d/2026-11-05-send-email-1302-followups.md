## 2026-11-05 — send-email: #1302 review follow-ups (not yet deployed)

- Sales reps can no longer send `statement` or `ar_reminder` emails; only admins can, matching the A/R Aging page (Mason's decision on Taha's #1302 review question).
- Two retries of the same failed email at the same moment send it once: a retry claims the log row only while it is still `failed`, and two first sends racing on one key get "already in progress" instead of an error.
- The call to Resend gives up after 30 seconds, and a timeout, network error or unreadable reply marks the email `failed` instead of leaving it `pending`. Resend receives the log row's id plus a fingerprint of the email as its idempotency key, so retrying the same email within Resend's 24 hours does not mail it twice, while corrected content is sent. Known limit: a retry of a timed-out send more than 24 hours later can arrive twice; the error tells staff to check the log first.
- `supabase/functions/send-email/send_email_test.ts` runs the real function against an in-memory database and Resend: wrong-customer record, reused key, legacy key dedupe, rep refused / admin allowed on a statement, both races, timeout and a non-JSON reply. CI's Deno test step now allows only the named settings the function reads (`--allow-env=...`).
- Takes effect only when `send-email` is deployed, on Mason's approval.
