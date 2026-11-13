#!/usr/bin/env node
// Tests for bash-safety-lib.mjs (dangerous-command patterns + npm-script
// indirection, FIX 2) and a couple of LIVE invocations of bash-safety.mjs
// itself (benign command allowed, dangerous command denied).
// Run: node .claude/hooks/bash-safety.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tempDir } from "../../scripts/lib/test-temp-dir.mjs";
import {
  checkDangerousCommand,
  checkCommandDeep,
  checkMigrationModify,
  extractNpmRunNames,
  computedJavaScriptScriptArgument,
  splitShellSegments,
  splitShellWords,
  resolveNpmScriptChain,
  readPackageScripts,
  checkPrBase,
} from "./bash-safety-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

// ── staging-first: PRs open into staging; only hotfix/ and release/next into main ──
{
  const on = (branch) => () => branch;
  const blocked = (cmd, branch = "claude/feature") => checkPrBase(cmd, ".", on(branch));
  ok(!blocked("gh pr create --base staging --title x --body y"), "PR into staging allowed");
  ok(!blocked("gh pr create --base=staging --fill"), "--base=staging allowed");
  ok(!blocked("gh pr create -B staging --fill"), "-B staging allowed");
  ok(blocked("gh pr create --fill"), "no --base blocked (GitHub default is main)");
  ok(blocked("gh pr create --base main --fill"), "feature branch into main blocked");
  ok(blocked("gh.exe -R croprxsolutions/CRX_Manager_V1.0 pr create -B main --fill"), "gh.exe -R spelling into main blocked");
  ok(blocked("gh pr create --base 'main' --fill"), "quoted main blocked");
  ok(blocked("git push -u origin x && gh pr create --base main --fill"), "second segment checked");
  ok(!blocked("gh pr create --base main --fill", "hotfix/restamp"), "hotfix branch into main allowed");
  ok(!blocked("gh pr create --base main --head hotfix/restamp --fill"), "explicit hotfix head allowed");
  ok(blocked("gh pr create --base main --head claude/feature --fill", "hotfix/x"), "explicit feature head into main blocked");
  ok(blocked("cd ../other && gh pr create --base main --fill", "hotfix/x"), "after cd the checkout's branch is not trusted");
  ok(blocked("gh pr edit 12 --base main"), "retarget onto main blocked");
  ok(!blocked("gh pr edit 12 --base staging"), "retarget onto staging allowed");
  ok(!blocked("gh pr edit 12 --title x"), "edit without base allowed");
  ok(!blocked("gh pr view 12 --json baseRefName"), "other pr subcommands untouched");
  ok(!blocked("rg -n 'gh pr create --base main' docs"), "searching for the text is not a PR");
  ok(checkCommandDeep("gh pr create --base main --head claude/x --fill", "."), "wired into checkCommandDeep");
}

// ── direct dangerous-command patterns (unchanged behavior) ────────────────
ok(checkDangerousCommand("git push --force origin main"), "force push blocked");
ok(checkDangerousCommand("git push -f origin main"), "force push -f blocked");
ok(checkDangerousCommand("git reset --hard HEAD~1"), "hard reset blocked");
ok(checkDangerousCommand("git checkout ."), "discard-all checkout blocked");
ok(checkDangerousCommand("git clean -fd"), "git clean -f blocked");
ok(checkDangerousCommand("npm test -- --no-verify"), "--no-verify blocked");
ok(checkDangerousCommand("rm -rf src"), "rm -rf src blocked");
ok(checkDangerousCommand("rm -rf supabase"), "rm -rf supabase blocked");
ok(checkDangerousCommand("git add file.txt .env"), "staging .env blocked");
ok(checkDangerousCommand("npx supabase db push"), "supabase db push blocked");
// An Area/City zone with `date` prints UTC silently in Git Bash; POSIX zones and searches stay allowed.
ok(checkDangerousCommand("TZ=America/Chicago date '+%H:%M %Z'"), "TZ=Area/City date blocked");
ok(checkDangerousCommand("git push && TZ='America/Chicago' date"), "quoted zone after && blocked");
ok(checkDangerousCommand("echo $(TZ=America/Chicago date +%H)"), "zone date in substitution blocked");
ok(checkDangerousCommand("env TZ=America/Chicago date"), "env TZ= date blocked");
ok(checkDangerousCommand("export TZ=America/Chicago; date"), "export then date blocked");
ok(checkDangerousCommand("FOO=1 TZ=America/Chicago date"), "TZ after another assignment blocked");
eq(checkDangerousCommand("export TZ=America/Chicago; git log -1"), null, "export without date allowed");
eq(checkDangerousCommand("TZ=CST6CDT date '+%H:%M %Z'"), null, "POSIX zone date allowed");
eq(checkDangerousCommand("date -u"), null, "plain date allowed");
eq(checkDangerousCommand("TZ=America/Chicago git log -1"), null, "zone on a non-date command allowed");
eq(checkDangerousCommand("grep -n 'TZ=America/Chicago date' notes.md"), null, "quoted search text allowed");
ok(checkDangerousCommand("supabase db push"), "bare (non-npx) supabase db push blocked — 2026-07-16 review B1");
ok(checkDangerousCommand("cd repo && supabase db push --linked"), "supabase db push blocked mid-compound-command");
ok(checkDangerousCommand("supabase migration up"), "bare supabase migration up blocked — sibling live-apply spelling");
ok(checkDangerousCommand("npx supabase migration up --linked"), "npx supabase migration up blocked");
ok(checkDangerousCommand("supabase db reset"), "supabase db reset blocked");
ok(checkDangerousCommand("dropdb mydb"), "dropdb blocked");
ok(checkDangerousCommand("git branch -D main"), "force-delete main blocked");
ok(checkDangerousCommand("git push --mirror origin"), "push --mirror blocked");
ok(checkDangerousCommand("git filter-branch --force"), "filter-branch blocked");
ok(checkDangerousCommand("rm -rf /etc"), "rm -rf /etc blocked (outside scratch allowlist)");
ok(checkDangerousCommand("npm run nuke"), "npm run nuke blocked (literal script name)");
ok(checkDangerousCommand('psql -c "DROP TABLE customers;"'), "psql DROP TABLE blocked");
ok(checkDangerousCommand('psql "$DB_URL" -c "truncate customers"'), "psql TRUNCATE blocked, any case");
ok(checkDangerousCommand('pgcli -e "DROP SCHEMA public"'), "pgcli DROP SCHEMA blocked");
ok(checkDangerousCommand(`p''sql -c "TRUNCATE customers"`), "quote-split client name still blocked (Luna, PR #1193)");
ok(checkDangerousCommand('P=psql; $P -c "TRUNCATE customers"'), "client named by a variable still blocked");
ok(checkDangerousCommand('docker exec db sh -c "TRUNCATE customers"'), "unknown program with -c beside TRUNCATE still blocked");
// A search for the word is not a wipe (Mason, 2026-10-29).
ok(!checkDangerousCommand('grep -c "TRUNCATE" supabase/migrations/x.sql'), "grep -c for TRUNCATE allowed");
ok(!checkDangerousCommand('git log --grep "drop table" -- supabase'), "git log naming DROP TABLE without a -c/-f flag allowed");
ok(checkDangerousCommand(`git -c "alias.wipe=!$P --command 'TRUNCATE customers'" wipe`), "a git alias beside TRUNCATE stays refused (Sol, PR #1193)");
// A client name inside a search pattern is not a client call (retro on PR #1333).
ok(!checkDangerousCommand('grep -l -i "DROP SCHEMA\\|docker exec psql" *.md'), "grep pattern naming psql and DROP SCHEMA allowed");
ok(!checkDangerousCommand('grep -E "DROP SCHEMA|psql" notes.md'), "a pipe inside the quoted pattern does not split the command");
ok(!checkDangerousCommand("rg -n 'psql.*DROP SCHEMA' docs"), "rg pattern naming psql and DROP SCHEMA allowed");
ok(!checkDangerousCommand('grep -n "DROP SCHEMA" notes.md # psql docs'), "a comment naming psql after a reader is not a client call");
ok(checkDangerousCommand('psql -c "DROP SCHEMA x"'), "psql DROP SCHEMA still blocked");
ok(checkDangerousCommand('docker exec c psql -c "TRUNCATE t"'), "docker exec psql TRUNCATE still blocked");
ok(checkDangerousCommand("cat <<'SQL' | psql\nDROP TABLE customers;\nSQL"), "cat piped into psql with DROP TABLE still blocked");
ok(checkDangerousCommand('grep -l "DROP TABLE" f | xargs cat | psql'), "readers feeding psql still blocked");
ok(checkDangerousCommand(`grep "$(psql -c 'DROP SCHEMA x')" f`), "a client run from a reader's command substitution still blocked");
ok(checkDangerousCommand('git grep "psql" -- "DROP SCHEMA"'), "git stays a non-reader");
// 2026-11-03: a git grep/log exemption (P4) was tried and dropped — a pager set
// in git's config can run a program the command text never names. These pin
// that every real SQL route stays refused.
ok(checkDangerousCommand('git commit -q -m "stop refusing psql -c TRUNCATE in a search"'), "a commit message stays as main treats it (no text skipping)");
ok(checkDangerousCommand('git -c alias.x="!psql" x "DROP SCHEMA"'), "git with a global option before the subcommand stays a non-reader");
ok(checkDangerousCommand('git -C . grep "psql" "DROP SCHEMA"'), "git with -C before grep stays a non-reader");
ok(checkDangerousCommand('git log --ext-diff -p "psql" "DROP SCHEMA"'), "git log running an external diff program stays refused");
ok(checkDangerousCommand('git grep -O"psql -c" "DROP SCHEMA"'), "git grep opening a pager program stays refused");
ok(checkDangerousCommand('git commit -m "$(psql -c \'DROP TABLE x\')"'), "a client in a commit message's command substitution stays refused");
ok(checkDangerousCommand("cat <<'EOF' | psql\nDROP TABLE customers;\nEOF"), "a here-document piped to psql stays refused");
ok(checkDangerousCommand("psql <<'EOF'\nDROP TABLE customers;\nEOF"), "a here-document fed to psql stays refused");
ok(checkDangerousCommand("python - <<'EOF'\nimport os; os.system('psql -c \"DROP TABLE x\"')\nEOF"), "an interpreter here-document naming psql stays refused");
ok(checkDangerousCommand('echo "DROP TABLE x;" | psql'), "echo piped into psql stays refused");
ok(checkDangerousCommand('supabase sql "DROP SCHEMA public"'), "supabase sql DROP SCHEMA stays refused");
// Real SQL routes stay refused (Sol on the P4 proposal, 2026-11-03).
for (const [command, label] of [
  ['git grep x; npx psql "$DB" -c "DROP TABLE x"', "npx psql after a git grep"],
  ["git log -1 && bash -c 'psql -c \"DROP TABLE x\"'", "bash -c psql after a git log"],
  ["git grep x\nsh <<'EOF'\npsql -c 'TRUNCATE x'\nEOF", "heredoc fed to sh"],
  ["cat wipe.sql | psql \"$DB\" # DROP TABLE", "file piped into psql"],
  ["cat > wipe.sql <<'EOF'\nDROP TABLE customers;\nEOF\npsql -f wipe.sql", "a written SQL file run by psql"],
  ["cat(){ bash; }; cat <<'EOF'\npsql -c 'DROP TABLE customers'\nEOF", "a function named cat running bash"],
  ['git grep "$(psql -c \'DROP TABLE x\')"', "a client in a git grep's command substitution"],
]) ok(checkDangerousCommand(command), `SQL route stays refused: ${label}`);
ok(checkDangerousCommand('rg --pre psql "DROP SCHEMA" db.sql'), "rg --pre running a client stays refused (Codex App, PR #1337)");
ok(checkDangerousCommand(`rg --p''re=psql "DROP SCHEMA" db.sql`), "a quote-split --pre= spelling stays refused");
// A reader spanning a line break is never exempt (Codex App, PR #1337).
ok(checkDangerousCommand(`grep "DROP TABLE" f # it's\npsql < wipe.sql`), "a quote in a comment cannot hide the next line's client");
ok(checkDangerousCommand(`grep "DROP TABLE" \\\n# it's\npsql < wipe.sql`), "a line continuation before the comment cannot hide it either");
ok(checkDangerousCommand(`grep "DROP TABLE" f # it's\rpsql < wipe.sql`), "a carriage return counts as a line break for the exemption");
ok(checkDangerousCommand('grep foo\\ #; psql --command="DROP TABLE customers"'), "an escaped space cannot fake a comment that hides psql (Luna, PR #1337)");
ok(checkDangerousCommand('grep foo\u00a0#; psql --command="DROP TABLE customers"'), "a no-break space cannot fake a comment that hides psql");
ok(checkDangerousCommand(`grep $'it\\'s' f; psql < wipe.sql # DROP TABLE x`), "ANSI-C quoting cannot hide a client in a reader segment (Codex App, PR #1337)");
ok(checkDangerousCommand('Select-String "DROP TABLE" "C:\\logs\\"; psql < wipe.sql; echo "x"'), "a PowerShell path ending in a backslash cannot hide a client (Codex App, PR #1337)");
ok(checkDangerousCommand('grep "DROP TABLE" "C:\\logs\\"; psql < wipe.sql; echo "x"'), "the same quoting after grep stays refused");
ok(checkDangerousCommand('grep "DROP TABLE" C:\\logs\\; psql < wipe.sql'), "an unquoted backslash before a separator cannot hide a client (Codex App, PR #1337)");
ok(checkDangerousCommand('rg "DROP TABLE" x\\| psql < wipe.sql'), "an unquoted backslash before a pipe cannot hide a client either");
ok(checkDangerousCommand(`grep "DROP TABLE" f <# ' #>; psql < wipe.sql; echo '`), "a PowerShell block comment cannot hide a client (Codex App, PR #1337)");
ok(checkDangerousCommand('grep "DROP TABLE" f --% "; psql < wipe.sql'), "PowerShell's stop-parsing token cannot hide a client");
ok(checkDangerousCommand(`rg 'DROP TABLE' psql.log @opts`), "PowerShell splatting can hide --pre, so it is not a plain reader (Luna, PR #1337)");
ok(checkDangerousCommand('./grep "DROP TABLE" psql -c "DROP TABLE customers"'), "a path-qualified reader name may be any program (Luna, PR #1337)");
ok(checkDangerousCommand(`grep() { psql -c 'DROP TABLE customers'; }; grep x f`), "a function shadowing a reader in the same command stays refused");
ok(checkDangerousCommand(`rg 'DROP TABLE' psql.log *`), "an unquoted glob can expand into rg --pre, so rg loses the exemption (Codex App, PR #1337)");
ok(!checkDangerousCommand(`rg "DROP TABLE|psql" '*.sql'`), "a quoted glob is passed to rg as text and stays allowed");
ok(checkDangerousCommand(`rg 'DROP TABLE' f ' & psql < wipe.sql & echo '`), "cmd.exe does not quote with ', so a single-quoted & cannot hide a client (Codex App, PR #1337)");
ok(checkDangerousCommand(`grep "DROP TABLE %X%" psql.log`), "cmd.exe expands %VAR% inside double quotes, so it is not plain");
ok(checkDangerousCommand(`grep "DROP TABLE ”; psql < wipe.sql; echo “" f`), "a PowerShell smart quote cannot hide a client (Codex App, PR #1337)");
ok(checkDangerousCommand(`rg --hostname-bin psql 'DROP TABLE' notes.md`), "rg --hostname-bin runs a program, so it stays refused (Codex App, PR #1337)");
ok(checkDangerousCommand(`rg --search-zip 'DROP TABLE|psql' notes.md`), "rg --search-zip runs a decompressor, so it is not exempt");
ok(checkDangerousCommand(`rg -nz 'DROP TABLE|psql' notes.md`), "rg's short -z bundle is --search-zip");
ok(!checkDangerousCommand(`rg -n "DROP TABLE|psql" notes.md`), "an ordinary rg flag stays allowed");
ok(!checkDangerousCommand(`grep -n 'psql $(x) DROP TABLE' notes.md`), "a single-quoted $( in a reader pattern runs nothing and stays allowed");
ok(!checkDangerousCommand("npm run build"), "npm run build allowed");
ok(!checkDangerousCommand("git status"), "git status allowed");
ok(!checkDangerousCommand("git push origin feature/x"), "ordinary feature push allowed");
ok(!checkDangerousCommand(""), "empty command allowed");
ok(!checkDangerousCommand(null), "null command allowed (no throw)");

// ── maintenance producer: denied BY NAME, and by a computed JavaScript script
//    argument (2026-09-05). The opaque-invocation classifier that used to sit here
//    fired 849 times in the 2026-08-21..09-04 fortnight, 59 of them on the
//    producer; the 2026-08-31 decision (DECISION_LOG) recorded it as ineffective
//    and named its removal the next harness task. The corpus below is the SAME
//    corpus the classifier was tested against, re-sorted by what the by-name rule
//    does with each entry, so every flip from deny to allow is explicit and
//    pinned. Since the producer's retirement on 2026-09-05 (PR #622) its four
//    former exact invocations are denied too: the script that enforced the blob
//    and proof checks is gone. ──
const decodedPowerShellProcessLaunch = "Set-Item Env:NODE_OPTIONS ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('LS1yZXF1aXJlPS4vcHJlbG9hZC5janM='))); Set-Variable E ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('bm9kZQ=='))); Set-Variable A @(([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('c2NyaXB0cy9hcHBseS1saXZlLXRlc3RkYXRhLW1haW50ZW5hbmNlLTIwMjYwODEyLm1qcw=='))),([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('LS1hcHByb3ZlZC1ieS1tYXNvbj0yMDI2LTA4LTEy')))); Start-Process (Get-Variable E -ValueOnly) -ArgumentList (Get-Variable A -ValueOnly) -Wait -NoNewWindow";
// 2026-10-18 (Mason): the by-name producer rule is REMOVED. The producer file is
// gone and never touched the live database; the rule only refused reads that
// named it. Naming it is ordinary text now.
for (const command of [
  "grep -rn apply-live-testdata-maintenance-20260812 docs",
  "git log --oneline -- scripts/apply-live-testdata-maintenance-20260812.mjs",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
]) {
  ok(!checkDangerousCommand(command), `naming the retired producer is no longer refused: ${command}`);
}
const REMOVED_PRODUCER_CORPUS = [
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify; Write-Output chained",
  "[IO.File]::WriteAllText('scripts/apply-live-testdata-maintenance-20260812.mjs','owned'); node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify --unknown",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --protect-producer --approved-by-mason=2026-08-12",
  "node \"scripts/apply-live-testdata-maintenance-20260812.mjs\" --verify",
  "node scripts\\apply-live-testdata-maintenance-20260812.mjs --verify",
  "cmd /c node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "env FLAG=1 node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.?js --approved-by-mason=2026-08-12",
  "node scripts/apply-live-testdata-ma[i]ntenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/appl?-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/apply-l[i]ve-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/appl?-live-testdata-maintenance-2026081?.mjs --approved-by-mason=2026-08-12",
  "node scripts/appl?-live-testdata-maintenance-2026081?.mjs --approved-by-mason=2026-08-$(printf 12)",
  "node scripts/$(printf apply-live-testdata-maintenance-20260812.mjs) --approved-by-mason=2026-08-12",
  "node --no-warnings scripts/$(printf apply-live-testdata-maintenance-20260812.mjs) --approved-by-$(printf mason)=2026-08-12",
  "node --require fs scripts/$(printf apply-live-testdata-maintenance-20260812.mjs) --approved-by-$(printf mason)=2026-08-12",
  'cmd /v:on /c "set a=--requ&set b=ire&set c=scripts/apply-live-testdata-maintenance-20260812.mjs&node !a!!b! ./preload.cjs !c! --approved-by-mason=2026-08-12"',
];
// The old (a) corpus is kept only as a parse-safety check: none may throw.
for (const command of REMOVED_PRODUCER_CORPUS) {
  checkDangerousCommand(command);
  pass++;
}
// (b) A JavaScript runtime (node/nodejs/bun/deno) whose SCRIPT argument is
//     computed — a variable, a substitution, a glob, a brace expansion, a cmd
//     `!var!`, a PowerShell sub-expression — stays denied whatever launcher,
//     shell, quote, or word-splitting escape sits around the runtime's name, as
//     long as the segment's head word is something that executes it.
for (const command of [
  "node scripts/appl?-live-testdata-maintenance-2026081?.mjs --approved-by-$(printf mason)=2026-08-12",
  "node </dev/null --no-warnings scripts/$(printf YXBwbHktbGl2ZS10ZXN0ZGF0YS1tYWludGVuYW5jZS0yMDI2MDgxMi5tanM= | base64 -d) --approved-by-$(printf bWFzb24= | base64 -d)=2026-08-12",
  "node --no-warnings \\\nscripts/$(printf YXBwbHktbGl2ZS10ZXN0ZGF0YS1tYWludGVuYW5jZS0yMDI2MDgxMi5tanM= | base64 -d) --approved-by-$(printf bWFzb24= | base64 -d)=2026-08-12",
  "node --require ./preload.cjs scripts/apply-l{i..i}ve-testdata-maintenance-20260{8..8}12.mjs --approved-by-ma{s..s}on=2026-08-12",
  'F=$(decode); nodejs --require ./preload.cjs "$F" "$P" "$S" "$T"',
  'F=$(decode); bun --preload ./preload.mjs "$F" "$P" "$S" "$T"',
  'F=$(decode); deno run "$F" "$P" "$S" "$T"',
  "node (\"--req\"+\"uire\") ./preload.cjs (\"scripts/apply-\"+\"live-testdata-maintenance-20260812.mjs\") (\"--approved-by-\"+\"mason=2026-08-12\")",
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); command node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); command -p node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec -c node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); env -i node --no-warnings "$F" "$P" "$S" "$T"',
  'set F=encoded& set P=encoded& set S=encoded& set T=encoded& cmd /v:on /c "node --no-warnings !F! !P! !S! !T!"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec -ca reviewed-name node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); env --default-signal node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); command -p -- node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec -a "reviewed name" node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); env -C "C:\\temp dir" node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); nohup node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); nice node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); timeout 5 node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); setsid node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); stdbuf -o0 node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); (node --no-warnings "$F" "$P" "$S" "$T")',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); "node" --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); nohup "node" --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); Select-String -Pattern\n"node" --no-warnings "$F" "$P" "$S" "$T"',
  'set F=encoded& set P=encoded& set S=encoded& set T=encoded& cmd /v:on /c"node --no-warnings !F! !P! !S! !T!"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); Select-String -Pattern ^\n"node" --no-warnings "$F" "$P" "$S" "$T"',
  'set F=encoded& set P=encoded& set S=encoded& set T=encoded& cmd /v:on /d/s/c"node --no-warnings !F! !P! !S! !T!"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); $\'node\' --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); n^ode --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); "n`ode" --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); bash -c \'"node" --no-warnings "$F" "$P" "$S" "$T"\'',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); pwsh -Command \'"node" --no-warnings "$F" "$P" "$S" "$T"\'',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); bash -c \'bash -c "node --no-warnings $F $P $S $T"\'',
  'F=$(decode); bash -c \'echo safe\'; bash -c \'bash -c "node $F"\'',
  'F=$(decode); pwsh -Com \'"node" $F\'',
  'F=$(decode); pwsh -CommandWithArgs \'"node" $F\'',
  'F=$(decode); pwsh -cwa \'"node" $F\'',
  'F=$(decode); pwsh /Com \'"node" $F\'',
  'F=$(decode); pwsh /CommandWithArgs \'"node" $F\'',
  'F=$(decode); pwsh /cwa \'"node" $F\'',
  'F=$(decode); pwsh /Com:\'"node" $F\'',
  'F=$(decode); "pwsh" /Com \'"node" $F\'',
  'F=$(decode); cmd /d /c \'@node "$F"\'',
  'F=$(decode); pwsh --Command \'"node" $F\'',
  'F=$(decode); pwsh --CommandWithArgs \'"node" $F\'',
]) {
  ok(computedJavaScriptScriptArgument(command), `computed script argument: ${command}`);}
// (c) NODE_OPTIONS mutation through PowerShell is its own ordered check now (it
//     used to ride inside the classifier); the 2026-08-12 decoded launch still
//     denies, for that reason and no other.
ok(/NODE_OPTIONS/.test(checkDangerousCommand(decodedPowerShellProcessLaunch) || ""), "decoded PowerShell launch is denied by the NODE_OPTIONS rule");
ok(!computedJavaScriptScriptArgument(decodedPowerShellProcessLaunch), "…and by nothing else: its producer name and arguments are base64, invisible to a by-name rule");
// (d) NOW ALLOWED — every corpus entry the classifier refused only because its
//     executable or its code could not be read from the text. None names the
//     producer and none launches a JavaScript runtime on a computed script. Two of
//     them ARE producer invocations with the name split or held in variables
//     (`& ('no','de' -join '') …`, `& $EXE $OPTION $MODULE $SCRIPT $APPROVAL`):
//     allowed on purpose. When this corpus was sorted the producer still existed
//     and refused any argv but its exact reviewed one, a body that differs from
//     its committed HEAD blob, and any write without a fresh exact-head Sol
//     proof; since its retirement (PR #622) there is no file at that path to run,
//     and the same run was always reachable through `node runner.mjs`, which
//     the classifier never saw. The generated Codex
//     production guard keeps the full classifier for the session that holds
//     production credentials.
for (const command of [
  'python -c "import base64; exec(base64.b64decode(PAYLOAD))"',
  "printf %s ENCODED | base64 -d | sh",
  "printf %s ENCODED | base64 -d | xargs",
  "sh -- < encoded-command.txt",
  "bash launch.sh",
  ". ./launch.ps1",
  'Invoke-Expression "$COMMAND"',
  "Invoke-Command -ScriptBlock ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('ZW5jb2RlZA=='))))",
  "icm -ScriptBlock ([ScriptBlock]::Create('encoded'))",
  "Start-Job -ScriptBlock ([ScriptBlock]::Create('encoded'))",
  "Start-ThreadJob -ScriptBlock ([ScriptBlock]::Create('encoded'))",
  "Start-RSJob -ScriptBlock ([ScriptBlock]::Create('encoded'))",
  "[ScriptBlock]::Create('encoded').Invoke()",
  'F=$(decode); ./reviewed-runtime --require ./preload.cjs "$F" "$P" "$S" "$T"',
  'PACKED=$(decode); env -S "$PACKED"',
  'PACKED=$(decode); env -S"$PACKED"',
  'PACKED=$(decode); env -a reviewed-name -S"$PACKED"',
  'PACKED=$(decode); env -vS"$PACKED"',
  'pwsh -EncodedCommand ZW5jb2RlZA==',
  'ENC=$(decode); pwsh -ec "$ENC"',
  'pwsh /EncodedCommand ZW5jb2RlZA==',
  'pwsh /EncodedCommand:ZW5jb2RlZA==',
  'ENC=$(decode); pwsh /ec "$ENC"',
  '"pwsh" /EncodedCommand ZW5jb2RlZA==',
  'pwsh "$env:OPT" "$env:PAYLOAD"',
  'pwsh @args',
  "Start-Process pwsh -ArgumentList '-" + "Encoded" + "Command','ZW5jb2RlZA==' -Wait",
  "Write-Output payload | xargs pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  'Write-Output payload | pwsh -Command -',
  "& ('no','de' -join '') ('--requ','ire' -join '') ./preload.cjs ('scripts/apply-live-testdata-maintenance-20260812','.mjs' -join '') ('--approved-by-','mason=2026-08-12' -join '')",
  '& $EXE $OPTION $MODULE $SCRIPT $APPROVAL',
  "pwsh -Command \"Start-Process pwsh -ArgumentList @('-" + "Encoded" + "Command','ZW5jb2RlZA==') -Wait\"",
  "pwsh -Command \"Start-Process pwsh -ArgumentList '-" + "Encoded" + "Command ZW5jb2RlZA==' -Wait\"",
  "bash -c 'if true; then pwsh --" + "Encoded" + "Command ZW5jb2RlZA==; fi'",
  "pwsh -Command 'if ($true) { pwsh --" + "Encoded" + "Command ZW5jb2RlZA== }'",
  "cmd /d /c '@pwsh --" + "Encoded" + "Command ZW5jb2RlZA=='",
  "cmd /d /c 'call pwsh --" + "Encoded" + "Command ZW5jb2RlZA=='",
  "cmd /d /c 'if 1==1 pwsh --" + "Encoded" + "Command ZW5jb2RlZA=='",
  "command command command command command command command command command pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "env -vu FOO pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "timeout -vk 1s 5s pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "exec -ca review pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "exec -la review pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "pwsh -Cus reviewpipe --" + "Encoded" + "Command ZW5jb2RlZA==",
  'cmd /d /c pwsh /EncodedCommand ZW5jb2RlZA==',
  'bash -c \'pwsh /EncodedCommand ZW5jb2RlZA==\'',
  'env -S \'pwsh /EncodedCommand ZW5jb2RlZA==\'',
  'pwsh -En\\codedCommand ZW5jb2RlZA==',
  'cmd /c pwsh -En^codedCommand ZW5jb2RlZA==',
  'pwsh --EncodedCommand ZW5jb2RlZA==',
  'bash -c \'pwsh --EncodedCommand ZW5jb2RlZA==\'',
  'pwsh \\/EncodedCommand ZW5jb2RlZA==',
  'MID=w env -S \'p${MID}sh /EncodedCommand ZW5jb2RlZA==\'',
  'pwsh -CustomPipeName reviewpipe --EncodedCommand ZW5jb2RlZA==',
  'pwsh -ep Bypass --EncodedCommand ZW5jb2RlZA==',
  'pwsh -ConfigurationName Microsoft.PowerShell --EncodedCommand ZW5jb2RlZA==',
  'pwsh -ConfigurationFile config.pssc --EncodedCommand ZW5jb2RlZA==',
  'pwsh -SettingsFile settings.json --EncodedCommand ZW5jb2RlZA==',
  'pwsh -inp text --EncodedCommand ZW5jb2RlZA==',
  'pwsh -out text --EncodedCommand ZW5jb2RlZA==',
  'pwsh -w hidden --EncodedCommand ZW5jb2RlZA==',
  'pwsh -wd . --EncodedCommand ZW5jb2RlZA==',
  'cmd /d /k pwsh --EncodedCommand ZW5jb2RlZA==',
  'cmd /d/k"pwsh --EncodedCommand ZW5jb2RlZA=="',
]) {
  eq(checkDangerousCommand(command), null, `nameless command with no computed JavaScript script is no longer the producer guard's business: ${command}`);
}
// (e) The ordinary shapes that made up most of the 849 refusals, pinned as allowed…
for (const command of [
  'node -e "console.log(process.versions.node)"',
  "node -v",
  'node -e "console.log(`x ${process.env.HOME}`)"',
  "node -pe 'process.arch'",
  "node - < script.mjs",
  "node --enable-source-maps scripts/x.mjs",
  "node scripts/claude-usage-report.mjs --days $(printf 14)",
  'node scripts/x.mjs "$SINCE"',
  "node scripts/x.mjs; node -e 'x'",
  "bash -c 'ls -la'",
  "printf '%s\\n' a b | xargs -n1 echo",
  "[ -f package.json ] && echo present",
  "python3 -c 'print(1)'",
  "cat <<'EOF'\nhello\nEOF",
  "$HOME/.local/bin/tool --version",
  "Get-ChildItem @('a','b')",
  "& git status",
  "pwsh -File script.ps1 /EncodedCommand",
]) {
  eq(checkDangerousCommand(command), null, `ordinary command stays allowed: ${command}`);
}
// (f) …and the computed-script shapes one token away from them, pinned as denied.
for (const command of [
  'node "$F"',
  "node scripts/$(printf x).mjs",
  "node scripts/appl?.mjs",
  "node --no-warnings \\\n\"$F\"",
  'F=x; n^ode "$F"',
  'F=x; cmd /d /c \'@node "$F"\'',
  'deno run --allow-read "$F"',
  "bun run $SCRIPT",
  'node -r "$P" scripts/x.mjs',
  "node scripts/%SCRIPT%.mjs",
  "node (Get-Item scripts/x.mjs).FullName",
]) {
  ok(computedJavaScriptScriptArgument(command), `computed script argument recognised: ${command}`);}
// (g) Codex App review of PR #619 (three P2 findings on 0d5823915), each pinned
//     in both directions.
//     1. A redirection glued to the runtime's name is still a launch: `<`/`>`
//        end the name like whitespace, a leading redirection does not hide the
//        head word, and a bare operator's target is not the script.
for (const command of [
  'F=x; node</dev/null "$F"',
  'node</dev/null "$F"',
  'node>out "$F"',
  'node > out "$F"',
  '</dev/null node "$F"',
  '2>&1 node "$F"',
  '> out node "$F"',
  'F=x </dev/null node "$F"',
]) {
  ok(computedJavaScriptScriptArgument(command), `redirection does not hide a computed script: ${command}`);}
//     2. A separator inside quotes is data, not a new segment: a search or a
//        commit message that quotes `; node "$F"` is not a launch, while a shell
//        head whose quoted argument contains one still is.
for (const command of [
  "rg -n 'foo | node \"$F\"' docs",
  "rg -n 'foo; node \"$F\"' docs",
  'git commit -m "later: run node $SCRIPT; then node $F"',
  "echo 'a & node $F'",
  'Write-Output "it\'s; node $F"',
]) {  ok(!checkDangerousCommand(command), `quoted separator stays allowed: ${command}`);
}
for (const command of [
  "bash -c 'echo a; node \"$F\"'",
  "bash -c 'echo a | node \"$F\"'",
  "pwsh -Command 'Write-Output a; node $F'",
  "echo 'a'; node \"$F\"",
  "echo \"it's\"; node \"$F\"",
]) {
  ok(computedJavaScriptScriptArgument(command), `real separator or shell head still reaches the launch: ${command}`);}
eq(splitShellSegments("rg -n 'a; b | c' docs; node x").length, 2, "quoted separators do not split; a real one does");
eq(splitShellSegments('echo "a; \\" b"; node x').length, 2, "an escaped quote inside double quotes does not end the quote");
eq(splitShellSegments("echo a\\; node x").length, 1, "a backslash-escaped separator does not split");
eq(splitShellSegments("echo 'unterminated; node x").length, 1, "an unterminated quote swallows the rest of the line");
//     4. Round 2 (Codex App P2 on 939c2d3cf): a quoted redirection target with
//        whitespace is ONE word, both in the token walk after the runtime and
//        in the head-word scan, so skipping the target cannot expose half of it
//        as a literal script.
for (const command of [
  'node > "out file" "$F"',
  'node >"out file" "$F"',
  "node 2> 'err log' \"$F\"",
  'node > "out file" -- "$F"',
  '> "out file" node "$F"',
  '2>"err log" node "$F"',
  'F=x > "out file" node "$F"',
]) {
  ok(computedJavaScriptScriptArgument(command), `quoted redirection target does not hide a computed script: ${command}`);}
for (const command of [
  'node > "out file" scripts/safe.mjs',
  '> "out file" node scripts/safe.mjs',
  'node "out file.js"',
  'echo "a b" > "out file"',
]) {
  ok(!computedJavaScriptScriptArgument(command), `quoted redirection target or quoted literal script is not computed: ${command}`);
  eq(checkDangerousCommand(command), null, `literal script behind a quoted redirection target stays allowed: ${command}`);
}
eq(splitShellWords('node > "out file" "$F"').length, 4, "a quoted word with whitespace is one word");
eq(splitShellWords("echo a\\ b c").length, 3, "a backslash-escaped space keeps its word together");
eq(splitShellWords("echo 'unterminated word").length, 2, "an unterminated quote swallows the rest of the line");
//     5. Round 3 (CodeRabbit on db355b11d): a PATH-QUALIFIED runtime name is the
//        same launch as a bare one, and a transparent launcher head runs its
//        trailing argv. `segmentHead` already strips the directory, so the head
//        check passed while the runtime regex found nothing and skipped the
//        segment. The Windows spelling needs the RAW command too, because
//        `wordEscapeView` strips the backslashes out of `C:\tools\node.exe`.
//        `/usr/bin/node "$F"` was first raised by Sol in round 1 and had not
//        actually been closed.
for (const command of [
  '/usr/bin/node "$F"',
  './node "$F"',
  '$HOME/bin/node "$F"',
  'C:\\tools\\node.exe "$F"',
  '/usr/local/bin/bun "$F"',
  'start /b node "$F"',
  'wsl --exec node "$F"',
  'winpty node "$F"',
  'runuser -u user -- node "$F"',
  "su -c 'node \"$F\"' user",
  'flock lockfile node "$F"',
]) {
  ok(computedJavaScriptScriptArgument(command), `path-qualified or launcher-fronted computed script is seen: ${command}`);}
for (const command of [
  "/usr/bin/node scripts/safe.mjs",
  "start /b node scripts/safe.mjs",
  "sudo apt install nodejs",
  'echo /usr/bin/node "$F"',
]) {
  ok(!computedJavaScriptScriptArgument(command), `a literal script or non-executing head stays uncomputed: ${command}`);
  eq(checkDangerousCommand(command), null, `path-qualified literal script and data mentions stay allowed: ${command}`);
}
// The braced PowerShell spelling of the same environment assignment.
ok(checkDangerousCommand("${env:NODE_" + 'OPTIONS} = "--require ./x.js"'), "braced $env:NODE_OPTIONS assignment denied");
ok(checkDangerousCommand("$env:NODE_" + 'OPTIONS = "--require ./x.js"'), "unbraced $env:NODE_OPTIONS assignment stays denied");
//     6. EVERY occurrence of a runtime name is examined, not just the first. An
//        earlier occurrence can be an option's VALUE: `env -u node node "$F"`
//        unsets a variable named `node`, and stopping at that first hit read the
//        real launch as a literal script. Raised by gpt-5.6-sol in ROUND 1 of
//        this PR, recorded in the PR body as addressed, and still open two
//        rounds later — these cases exist so "the round was addressed" is a
//        measurement rather than a claim.
for (const command of [
  'env -u node node "$F"',
  'env -i node "$F"',
  'env -u PATH /usr/bin/node "$F"',
  'env FOO=bar node "$F"',
  'command -p node "$F"',
  'nice -n 10 node "$F"',
  "xargs -I{} node \"$F\"",
]) {
  ok(computedJavaScriptScriptArgument(command), `a runtime name used as an option value does not shadow the launch: ${command}`);}
for (const command of [
  "env -u node node scripts/safe.mjs",
  "env -u node printenv node",
]) {
  ok(!computedJavaScriptScriptArgument(command), `scanning every occurrence does not invent a computed script: ${command}`);
  eq(checkDangerousCommand(command), null, `a literal script after an unset of the same name stays allowed: ${command}`);
}
//     3. A literal, non-loader option whose computed value is QUOTED keeps the
//        parser moving toward the (literal) script; an unquoted expansion can
//        word-split into a script argument, and a computed option NAME or a
//        loader option keeps its denial.
for (const command of [
  'TITLE=worker node --title="$TITLE" scripts/safe.mjs',
  "node --title='$TITLE' scripts/safe.mjs",
  'node "--title=$TITLE" scripts/safe.mjs',
  'node --max-old-space-size="$(nproc)" scripts/safe.mjs',
]) {
  ok(!computedJavaScriptScriptArgument(command), `quoted computed value of an ordinary option is not a computed script: ${command}`);
  eq(checkDangerousCommand(command), null, `ordinary option with a quoted computed value stays allowed: ${command}`);
}
for (const command of [
  "node --title=$TITLE scripts/safe.mjs",
  "node --title=%TITLE% scripts/safe.mjs",
  "node --$OPT scripts/safe.mjs",
  "node -$OPT scripts/safe.mjs",
  'node --require="$P" scripts/safe.mjs',
  'node --import="$P" scripts/safe.mjs',
  "node --loader=$P scripts/safe.mjs",
]) {
  ok(computedJavaScriptScriptArgument(command), `computed option name, unquoted value, or loader value is still a computed script: ${command}`);}
// Quoted data that merely MENTIONS a runtime, a shell, or an encoded-command
// spelling was never an invocation; it stays outside the producer gate.
for (const dataCommand of [
  "Select-String -Pattern 'node' | ForEach-Object { $_ }",
  "echo $PATH",
  "Get-ChildItem *.mjs",
  'Write-Output \'command node "$F"\'',
  "env MODE=-S powershell -Command 'Write-Output $env:MODE'",
  "env -- powershell -Command 'Write-Output -S $env:MODE'",
  "rg -n 'pwsh /EncodedCommand' docs",
  'rg -n \'node "$F"\' docs',
  'git commit -m "run node $SCRIPT later"',
  'echo node "$F"',
  "Write-Output pwsh /EncodedCommand",
  "command -v pwsh /EncodedCommand",
  "command -V pwsh /EncodedCommand",
  "Write-Output bash -c 'pwsh /EncodedCommand text'",
  "rg -n 'python -c' docs",
  "rg -n 'base64 -d | sh' docs",
  "env --help pwsh /EncodedCommand",
  "timeout --help pwsh /EncodedCommand",
  "timeout -s TERM --help pwsh /" + "Encoded" + "Command",
]) {  ok(!checkDangerousCommand(dataCommand), `quoted data stays allowed: ${dataCommand}`);
}
// FORMER OVER-BLOCK: computed `node …` text inside a shell's quoted argument was
// refused until the computed-script rule was dropped on 2026-10-02 (Mason).
ok(!checkDangerousCommand("pwsh -ExecutionPolicy Bypass 'Write-Output node $value'"), "computed node text inside a shell's quoted argument is no longer refused");
ok(checkDangerousCommand("node --require ./preload.cjs scripts/ordinary-check.mjs"), "Node require preload is denied");
ok(checkDangerousCommand("NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("FOO=1 NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "prefixed NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("Set-Item Env:NODE_OPTIONS $PRELOAD"), "PowerShell Set-Item NODE_OPTIONS mutation is denied");
ok(checkDangerousCommand("$env:NODE_OPTIONS = $PRELOAD"), "PowerShell env assignment to NODE_OPTIONS is denied");
ok(checkDangerousCommand("[Environment]::SetEnvironmentVariable('NODE_OPTIONS', $PRELOAD)"), ".NET NODE_OPTIONS mutation is denied");
ok(!checkDangerousCommand("rg -n 'NODE_OPTIONS=' docs"), "NODE_OPTIONS spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("rg -n 'Set-Item Env:NODE_OPTIONS' docs"), "PowerShell NODE_OPTIONS mutation spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("Write-Output '$env:NODE_OPTIONS = x'"), "NODE_OPTIONS assignment spelling inside quoted output stays allowed");

// ── net-new: shell-redirect .env write (2026-07-13, shared with mcp-tool-guard) ──
ok(checkDangerousCommand("echo SECRET=x > .env"), "shell-redirect write to .env blocked");
ok(checkDangerousCommand("echo SECRET=x >> .env.local"), "shell-redirect append to .env.local blocked");
ok(checkDangerousCommand("echo SECRET=x | tee .env"), "tee to .env blocked");
ok(!checkDangerousCommand("cat .env.example"), "reading .env.example is not a write, allowed");

// ── migration-modify check (unchanged) ─────────────────────────────────────
{
  const tmp = tempDir("bash-safety-migtest-");
  try {
    const migDir = path.join(tmp, "supabase", "migrations");
    mkdirSync(migDir, { recursive: true });
    const existing = path.join(migDir, "20260101000000_existing.sql");
    writeFileSync(existing, "select 1;");
    ok(
      checkMigrationModify(`echo "x" >> supabase/migrations/20260101000000_existing.sql`, tmp),
      "redirect-modify of an EXISTING migration file blocked"
    );
    ok(
      !checkMigrationModify(`echo "x" >> supabase/migrations/20260102000000_new.sql`, tmp),
      "redirect to a NEW (not-yet-existing) migration file allowed"
    );
    ok(!checkMigrationModify("echo hi", tmp), "unrelated command allowed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── FIX 2: npm-script indirection ──────────────────────────────────────────
{
  const tmp = tempDir("bash-safety-npmtest-");
  try {
    const pkg = {
      scripts: {
        safe: "vite build",
        dangerous: "git push --force origin main",
        producer: "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
        "producer:computed": 'node "$PRODUCER" --verify',
        "chain:a": "npm run chain:b",
        "chain:b": "npm run chain:c",
        "chain:c": "rm -rf src",
        // 5-deep chain: the dangerous command sits at hop 5 (depth 4), one past
        // the maxDepth=3 cap — proves the cap is a real boundary, not just
        // documentation. cap-a..cap-d (depths 0-3) ARE resolved; cap-e (depth 4)
        // is not, so its dangerous body is never inspected.
        "chain:cap-a": "npm run chain:cap-b",
        "chain:cap-b": "npm run chain:cap-c",
        "chain:cap-c": "npm run chain:cap-d",
        "chain:cap-d": "npm run chain:cap-e",
        "chain:cap-e": "git reset --hard HEAD~1",
      },
    };
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2));

    eq(extractNpmRunNames("npm run dangerous").length, 1, "extracts one npm run target");
    eq(extractNpmRunNames("npm run safe && npm run dangerous").length, 2, "extracts multiple npm run targets");

    const scripts = readPackageScripts(tmp);
    ok(scripts && typeof scripts === "object", "readPackageScripts reads the temp package.json");
    eq(resolveNpmScriptChain(scripts, "chain:a").length, 3, "resolves a 3-deep chain (a, b, c bodies)");

    ok(!checkCommandDeep("npm run safe", tmp), "npm run safe stays allowed");
    ok(checkCommandDeep("npm run dangerous", tmp), "npm run dangerous is caught via its resolved script body");
    ok(!checkCommandDeep("npm run producer", tmp), "2026-10-18: the retired producer's name in an npm script is no longer refused");
    ok(!checkCommandDeep("npm run producer:computed", tmp), "2026-10-02: a computed-script launch in an npm script is no longer refused");
    ok(
      checkCommandDeep("npm run chain:a", tmp),
      "a dangerous command hidden 2 levels deep behind chained npm scripts is caught (FIX 2)"
    );
    // Depth cap is a real boundary: cap-a..cap-d (depths 0-3) are resolved, but
    // the dangerous command lives one hop further (cap-e, depth 4) and is
    // never fetched — documents the intentional bound, not an oversight.
    eq(resolveNpmScriptChain(scripts, "chain:cap-a").length, 4, "depth cap resolves exactly 4 bodies (depths 0-3)");
    ok(
      !checkCommandDeep("npm run chain:cap-a", tmp),
      "a dangerous command one hop past the depth-3 cap is NOT caught (documented bound)"
    );

    // Unreadable/missing package.json → warn-and-allow, never throw or block.
    const missingDir = path.join(tmp, "does-not-exist");
    let threw = false;
    let result;
    try { result = checkCommandDeep("npm run dangerous", missingDir); } catch { threw = true; }
    ok(!threw, "missing package.json does not throw");
    eq(result, null, "missing package.json warn-and-allows (no block) for the script-body check");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── LIVE: bash-safety.mjs itself — benign allowed, dangerous denied ────────
function runHook(payload) {
  return spawnSync(process.execPath, [path.join(__dirname, "bash-safety.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}
let r = runHook({ tool_name: "Bash", tool_input: { command: "npm run build" } });
eq(r.status, 0, "bash-safety.mjs exits 0 on benign command");
ok(!r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs allows npm run build");

r = runHook({ tool_name: "Bash", tool_input: { command: "git push --force origin main" } });
eq(r.status, 0, "bash-safety.mjs exits 0 on dangerous command");
ok(r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs denies a force push");

// The shapes that used to be refused with a misleading "maintenance producer"
// message pass the LIVE hook too, not only the library predicate.
for (const command of [
  'node -e "console.log(1)"',
  "bash -c 'ls'",
  "[ -f package.json ] && echo present",
  "printf a | xargs echo",
  "rg -n 'foo | node \"$F\"' docs",
  'TITLE=worker node --title="$TITLE" scripts/safe.mjs',
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety exits 0 on: ${command}`);
  ok(!r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs allows the ordinary shape: ${command}`);
}
// A plain search whose quoted pattern names a dangerous command is text, not
// that command (Codex was refused on these 2026-10-27). The same command
// outside quotes, or chained after the search, is still refused.
for (const command of [
  'rg -n "supabase db push" docs/workflows/DATABASE_CHANGE_CHECKLIST.md',
  "rg -n 'rm -rf' docs",
  "git grep -n 'git reset --hard' -- docs",
  "Get-ChildItem -Recurse docs | Select-String 'git push --force'",
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety exits 0 on: ${command}`);
  ok(!r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs allows the plain search: ${command}`);
}
for (const command of [
  "rg -n x docs; git reset --hard",
  "rg -n 'x' docs && git push --force origin main",
  "rg --pre 'git reset --hard' x docs",
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs still denies a search chained to a dangerous command: ${command}`);
}
// Here-document text that only becomes a file or a note is not a command
// (2026-11-07, Mason: two harmless notes were refused). Every route that RUNS
// the text keeps the full-text check.
const denied = (command, tool_name = "Bash") =>
  runHook({ tool_name, tool_input: { command } }).stdout.includes('"permissionDecision":"deny"');
for (const command of [
  "cat >> /c/Users/mason/.claude/projects/x/memory/note.md <<'EOF'\nNever run git reset --hard on a shared worktree.\nEOF",
  "cat >> /c/Users/mason/notes/handover.md <<'EOF'\nLesson: git reset --hard destroyed work; never use --no-verify.\nEOF",
  "tee -a /c/Users/mason/notes/a.md <<'EOF'\ngit push --force is never used here.\nEOF\n",
  "cat > docs/notes/x.md <<'NOTE'\ngit reset --hard\nNOTE",
]) ok(!denied(command), `bash-safety allows here-document text: ${command.split("\n")[0]}`);
for (const [command, label] of [
  ["git reset --hard", "plain hard reset"],
  ["git -C x reset --hard HEAD~1", "hard reset with -C"],
  ['bash -c "git reset --hard"', "bash -c"],
  ["bash <<'EOF'\ngit reset --hard\nEOF", "here-document fed to bash"],
  ["sh <<'EOF'\ngit reset --hard\nEOF", "here-document fed to sh"],
  ["cat <<'EOF' | bash\ngit reset --hard\nEOF", "cat piped into bash"],
  ["cat <<'EOF' \\\n| bash\ngit reset --hard\nEOF", "line continuation into bash"],
  ["cat > x.sh <<'EOF'\ngit reset --hard\nEOF\nbash x.sh", "written script run later"],
  ["cat > x.sh <<'EOF'\ngit reset --hard\nEOF\n./x.sh", "written script run by path"],
  ["cat(){ bash; }; cat <<'EOF'\ngit reset --hard\nEOF", "a function named cat"],
  ["cat <<EOF\n$(git reset --hard)\nEOF", "substitution in an unquoted body"],
  // Bash joins `\`+newline in an unquoted body before expanding (Codex App, PR #1632).
  ["cat <<EOF\n$\\\n(git push --force origin main)\nEOF", "a substitution split across a line join"],
  ["cat <<EOF\ngit reset --hard\nEOF", "an unquoted body (only quoted delimiters are narrowed)"],
  // An escape in a quoted delimiter can make the lexer and Bash end the body on different lines (Codex App round 2).
  // Bash ends `<<"A\\B"` at `A\B`; the lexer waited for `A\\B`.
  ["cat <<\"A\\\\B\"\nnote\nA\\B\ngit push --force origin main\nA\\\\B", "a delimiter with a backslash escape"],
  ["cat <<\"A\\$B\"\nnote\nA$B\ngit reset --hard\nA\\$B", "a delimiter with an escaped dollar"],
  // Codex App round 3: a non-breaking space after the delimiter is part of Bash's word.
  ["cat >> n.md <<'EOF' \nnote\nEOF \ngit push --force origin main\nEOF", "a non-breaking space after the delimiter"],
  // The strict shape: Bash ends at the FIRST line equal to the word.
  ["cat >> n.md <<'EOF'\nnote\nEOF\ngit reset --hard\nEOF", "a command between two closing lines"],
  ["cat >> \"$HOME/n.md\" <<'EOF'\ngit reset --hard\nEOF", "a quoted or expanded file name"],  ["echo hi # <<EOF\ngit reset --hard\nEOF", "a heredoc opener inside a comment"],
  ["cat <<'EOF'\ngit reset --hard\n", "a here-document that never ends"],
  ["cat <<'EOF' | xargs git\nreset --hard\nEOF\ngit reset --hard", "xargs, then a real reset"],
  ["python - <<'EOF'\nimport os; os.system('git reset --hard')\nEOF", "python launching a process"],
  ["node - <<'EOF'\nconst c = require(['child','process'].join('_')); c[['ex','ecSync'].join('')]('git reset --hard');\nEOF", "node building the launch call from pieces (Luna round 2)"],
  // A runtime's here-document stays judged in full, even when it only writes a
  // note: no word list can tell writing from launching (Luna rounds 1-2).
  ["python - <<'EOF'\nfrom pathlib import Path\nPath('note.md').write_text('Never run git reset --hard.')\nEOF", "python writing a note (runtimes are not narrowed)"],
  ["cat > x.py <<'EOF'\nimport subprocess; subprocess.run('git reset --hard', shell=True)\nEOF\npython x.py", "written python run later"],
  ["cat > notes.md <<'EOF'\ntext\nEOF\ngit reset --hard", "a real reset after the here-document"],
  ["cat > .env <<'EOF'\nSECRET=x\nEOF", "a here-document written to .env"],
]) ok(denied(command), `bash-safety still denies: ${label}`);
// PowerShell has no here-documents; its text is judged as before.
ok(denied("cat >> notes.md <<'EOF'\ngit reset --hard\nEOF", "PowerShell"), "PowerShell keeps the full-text check");

// A computed script path is no longer refused by the LIVE hook either
// (2026-10-02, Mason): the retired producer was the only reason for the rule.
for (const command of ['F=x; node</dev/null "$F"', 'node > "out file" "$F"', 'for f in scripts/*.mjs; do node "$f" --check; done']) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety exits 0 on: ${command}`);
  ok(!r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs allows a computed script path: ${command}`);
}

for (const command of [
  "git push origin feature/test --force",
  "git push --all origin --force",
  "git push origin --all --force",
  "git -C . push origin feature/test -uf",
  "git push origin +feature/test",
  "git push --all origin",
  "git push origin --branches",
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety exits 0 after denying: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety denies force/bulk push: ${command}`);
}

// ── Codex P1 round 3: valid npm option forms must still resolve script names ──
eq(extractNpmRunNames("npm run --silent dangerous")[0], "dangerous", "npm run --silent <name> resolves the name, not the flag");
eq(extractNpmRunNames("npm -s run dangerous")[0], "dangerous", "npm -s run <name> resolves");
eq(extractNpmRunNames("npm run-script dangerous")[0], "dangerous", "npm run-script alias resolves");
eq(extractNpmRunNames("npm --loglevel=silent run dangerous")[0], "dangerous", "npm --opt=value run <name> resolves");

// ── Codex P1 round 4: npm pre/post lifecycle scripts ride along ──────────────
{
  const scripts = { build: "vite build", prebuild: "git push --force origin main" };
  const chain = resolveNpmScriptChain(scripts, "build");
  ok(chain.includes("git push --force origin main"), "prebuild lifecycle script is resolved with npm run build");
}
{
  const tmp = tempDir("bashsafety-lifecycle-");
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      scripts: { build: "echo building", postbuild: "git reset --hard HEAD~1" },
    }));
    ok(checkCommandDeep("npm run build", tmp), "dangerous POSTbuild lifecycle script is blocked");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Codex P2 round 4: tracked .env templates are exempt from the redirect ban ─
eq(checkDangerousCommand("node gen-template.js > .env.example"), null, "redirect to .env.example (template) allowed");
eq(checkDangerousCommand("cat base > .env.staging.example"), null, "redirect to .env.staging.example allowed");
ok(checkDangerousCommand("echo SECRET > .env.staging"), ".env.staging (real env) still blocked");

// ── Codex P2 2026-07-13: .env redirect with NO space after > must be caught ──
ok(checkDangerousCommand("echo SECRET>.env"), "no-space redirect to .env blocked");
ok(checkDangerousCommand("echo SECRET >.env"), "space-before-only redirect to .env blocked");
ok(checkDangerousCommand("echo SECRET>>.env.production"), "no-space append to .env.production blocked");
eq(checkDangerousCommand("echo hello > notes.txt"), null, "redirect to a non-.env file still allowed");
eq(checkDangerousCommand("dotenv -e .env.test -- npm run test"), null, "mentioning .env without a redirect still allowed");

// ── Codex P1 2026-07-13: npm-resolved script bodies must also hit the
//    migration-immutability check, not just the dangerous-command table ──────
{
  const tmp = tempDir("bashsafety-npm-mig-");
  try {
    mkdirSync(path.join(tmp, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(tmp, "supabase", "migrations", "20260101000000_existing.sql"), "select 1;\n");
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      scripts: { sneaky: "echo '-- tweak' >> supabase/migrations/20260101000000_existing.sql" },
    }));
    ok(checkCommandDeep("npm run sneaky", tmp), "npm script that appends to an EXISTING migration is blocked");
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      scripts: { fine: "echo ok > supabase/migrations/20990101000000_brand_new.sql" },
    }));
    eq(checkCommandDeep("npm run fine", tmp), null, "npm script writing a NEW (non-existent) migration file is allowed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`bash-safety: ${pass} assertions passed`);
