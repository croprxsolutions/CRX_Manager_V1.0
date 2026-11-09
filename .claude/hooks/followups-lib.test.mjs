import assert from "node:assert/strict";
import { followUpLines, followUpsDenial, followUpsProblem } from "./followups-lib.mjs";

const pr = (body, login = "masonwells1") => ({ author: { login }, body });

// Accepted shapes.
assert.equal(followUpsProblem(pr("## Summary\nx\n\n## Follow-ups\n- None\n")), null);
assert.equal(followUpsProblem(pr("## Follow-ups\nNone.")), null);
assert.equal(followUpsProblem(pr("### Follow-ups:\r\n- #1700 tighten X\r\n- KI-104 legacy rows\r\n\r\n## Test plan\n- ran it")), null);
assert.equal(followUpsProblem(pr("## Followups\n* [ ] https://github.com/o/n/issues/12 later")), null);
assert.equal(followUpsProblem(pr("## Follow-ups\n- (#1700) tighten X")), null);

// Refused shapes.
assert.match(followUpsProblem(pr("## Summary\nfixed it")), /no `## Follow-ups` section/);
assert.match(followUpsProblem(pr("## Follow-ups\n\n## Test plan\n- None")), /empty/);
assert.match(followUpsProblem(pr("## Follow-ups\n<!-- fill in -->\n")), /empty/);
assert.match(followUpsProblem(pr("## Follow-ups\n- tighten the X check later")), /name no issue/);
assert.match(followUpsProblem(pr("## Follow-ups\n- None\n- #12 also this")), /says None but also/);
assert.match(followUpsProblem(pr("## Follow-ups\n- see &#39; entity")), /name no issue/);
assert.match(followUpsProblem({ author: { login: "x" } }), /fail closed/);
assert.match(followUpsProblem(null), /fail closed/);
// A heading inside prose or deeper text is not the section.
assert.match(followUpsProblem(pr("We have no Follow-ups section.\n- None")), /no `## Follow-ups` section/);

// Only rendered text counts (Luna, 2026-11-09): a fenced example is not the section,
// and an issue number inside a hidden comment is not a home.
assert.match(followUpsProblem(pr("Example:\n```md\n## Follow-ups\n- None\n```\n")), /no `## Follow-ups` section/);
assert.match(followUpsProblem(pr("~~~\n## Follow-ups\n- None\n~~~")), /no `## Follow-ups` section/);
assert.match(followUpsProblem(pr("## Follow-ups\n- tighten the check <!-- #123 -->")), /name no issue/);
assert.match(followUpsProblem(pr("## Follow-ups\n<!--\n- #12 hidden\n-->\n")), /empty/);
assert.equal(followUpsProblem(pr("```\nx\n```\n## Follow-ups\n- #12 real")), null);

// Luna round 2: only real Markdown headings, real closing fences, and GitHub issue links count.
assert.match(followUpsProblem(pr("##Follow-ups\n- None")), /no `## Follow-ups` section/);
assert.match(followUpsProblem(pr("    ## Follow-ups\n    - None")), /no `## Follow-ups` section/);
assert.match(followUpsProblem(pr("```md\nexample\n```junk\n## Follow-ups\n- None\n```")), /no `## Follow-ups` section/);
assert.match(followUpsProblem(pr("## Follow-ups\n- https://tracker.example/issues/42 later")), /name no issue/);
assert.equal(followUpsProblem(pr("## Follow-ups\n- https://github.com/o/n/issues/42 later")), null);
assert.equal(followUpsProblem(pr("  ## Follow-ups ##\n- None")), null);

// The attribution footer after the list is not a follow-up (found live on #1696).
assert.equal(followUpsProblem(pr("## Follow-ups\n- None\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n")), null);
assert.equal(followUpsProblem(pr("## Follow-ups\n- #1 a\n\n- #2 b\n\nfooter")), null);
assert.deepEqual(followUpLines("## Follow-ups\n- #1 a\n\n- #2 b\n\nfooter"), ["#1 a", "#2 b"]);
assert.match(followUpsProblem(pr("## Follow-ups\n- #1 a\n- fix later\n\nfooter")), /name no issue/);

// Only a bare None is the sentinel (Codex App P2 on #1696).
assert.match(followUpsProblem(pr("## Follow-ups\n- None yet — create an issue for the guard fix later.")), /name no issue/);
assert.equal(followUpsProblem(pr("## Follow-ups\n- none!")), null);

// Taha's PRs are his.
assert.equal(followUpsProblem(pr("no section", "TahaKhanAbdalli")), null);

// The section stops at the next heading.
assert.deepEqual(followUpLines("## Follow-ups\n- #1 a\n## Next\n- not this"), ["#1 a"]);
assert.equal(followUpLines("nothing"), null);

assert.match(followUpsDenial("PR MERGE GATE", "1700", "the PR description has no `## Follow-ups` section."), /gh pr edit 1700 --body-file/);

console.log("followups-lib: all assertions passed");
