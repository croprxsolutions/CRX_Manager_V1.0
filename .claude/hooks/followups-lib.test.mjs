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

// Taha's PRs are his.
assert.equal(followUpsProblem(pr("no section", "TahaKhanAbdalli")), null);

// The section stops at the next heading.
assert.deepEqual(followUpLines("## Follow-ups\n- #1 a\n## Next\n- not this"), ["#1 a"]);
assert.equal(followUpLines("nothing"), null);

assert.match(followUpsDenial("PR MERGE GATE", "1700", "the PR description has no `## Follow-ups` section."), /gh pr edit 1700 --body-file/);

console.log("followups-lib: all assertions passed");
