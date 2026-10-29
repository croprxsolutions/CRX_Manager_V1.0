## 2026-10-29 — Guard friction, part 1: Sol's merge review keeps git out of the SQL reader list (PR #1193)

Sol's exact-head review of PR #1193 blocked one point: `bash-safety-lib.mjs` counted `git`
as a plain reader when deciding whether a `-c`/`-f` flag beside `DROP TABLE`/`TRUNCATE`
means a database client call, and a `git -c alias.x=!…` alias can run one. `git` is off
that list again, so `git log -c` beside those words is refused as it was before part 1;
`grep -c TRUNCATE` and the other plain readers stay allowed. Luna's round-2 "accepted
hole" note for this case is withdrawn.
