## 2026-10-29 — Guard friction, part 1: Luna round-1 fixes (PR #1193)

Luna (gpt-6-luna, xhigh) reviewed the first guard-friction change and found six problems;
all are fixed in the same PR.

- **`review-proof-guard.mjs` (two BLOCKERs):** the new plain-read reading trusted
  `echo "x|truncate" @(Set-Content .husky/pre-push …)`, which PowerShell evaluates, and
  `node <script> "x|truncate" .husky/pre-push`, where the script can write. It now refuses
  any unquoted `( ) [ ] { } @ $ % < > ^` and never vouches for `node` or `gh`; those
  commands fall back to the old reading and are denied as before.
- **`bash-safety-lib.mjs` (HIGH):** requiring a literal client name let `p''sql -c "TRUNCATE …"`
  and `$P -c …` through. The client name is now matched with quoting removed, and a `-c`/`-f`
  flag beside the words still counts unless every command in the line is a known search or
  read program (`grep`, `rg`, `git`, `cat`, `head`, `tail`, `wc`, `ls`).
- **`posttooluse-migration.mjs` (two MED, one LOW):** the once-per-file record keys on the
  file's location under `supabase/migrations/` rather than its bare name, is written only
  after the reminder is emitted, and an unusable working directory falls back to the full
  checklist.

Mason deleted the unwired `.claude/hooks/ship-intent-reminder.mjs` himself the same day
(the review proof guard reserves deleting hook files for him); this commit records that.
