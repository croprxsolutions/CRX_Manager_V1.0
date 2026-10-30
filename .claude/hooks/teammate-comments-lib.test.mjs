import assert from "node:assert/strict";
import {
  readTeammateComments,
  teammateCommentsDenial,
  unansweredTeammateComments,
} from "./teammate-comments-lib.mjs";

const PR_URL = "https://github.com/o/n/pull/7";
const list = (nodes, truncated = false) => ({ pageInfo: { hasPreviousPage: truncated }, nodes });
const comment = (login, url, body, type = "User") => ({ author: { __typename: type, login }, url, body });
const review = (login, url, body, state = "COMMENTED", type = "User") =>
  ({ ...comment(login, url, body, type), state });
const pr = ({ author = "masonwells1", comments = [], reviews = [], threads = [] } = {}) => ({
  author: { login: author },
  comments: list(comments),
  reviews: list(reviews),
  reviewThreads: list(threads.map((nodes) => ({ comments: list(nodes) }))),
});
const open = (input) => unansweredTeammateComments(pr(input)).comments.map((c) => c.url);

const TAHA = "TahaKhanAbdalli";
const LINK = `${PR_URL}#issuecomment-12`;
const taha = comment(TAHA, LINK, "Review (Taha): one blocking case");
const reply = (body, login = "masonwells1") => comment(login, `${PR_URL}#issuecomment-99`, body);

assert.deepEqual(open(), [], "a PR with no comments is clear");
assert.equal(unansweredTeammateComments({ ...pr(), comments: { nodes: [] } }), null, "a list with no paging info is not a usable read");
assert.deepEqual(open({ comments: [taha] }), [LINK], "a teammate comment with no answer blocks");
assert.deepEqual(open({ reviews: [review(TAHA, LINK, "needs work")] }), [LINK], "a review body counts");
assert.deepEqual(open({ threads: [[taha]] }), [LINK], "a line comment counts");
assert.deepEqual(open({ reviews: [review(TAHA, LINK, "")] }), [], "an empty review wrapper is not a comment");
assert.deepEqual(open({ reviews: [review(TAHA, LINK, "draft", "PENDING")] }), [], "a pending review is unseen");

// The #1174 shape: unrelated comments followed Taha's and must not count.
assert.deepEqual(open({ comments: [taha, reply("@coderabbitai full review"), reply("Re CodeRabbit review: verified")] }),
  [LINK], "a later comment that does not link it is no answer");
assert.deepEqual(open({ comments: [taha, reply(`@${TAHA} fixed`)] }), [LINK], "naming them without the link is no answer");
assert.deepEqual(open({ comments: [taha, reply(`${LINK} fixed in abc123`)] }), [], "an answer linking it clears");
assert.deepEqual(open({ reviews: [review(TAHA, `${PR_URL}#pullrequestreview-5`, "needs work")], comments: [reply(`Fixed ${PR_URL}#pullrequestreview-5.`)] }),
  [], "an answer can link a review");
assert.deepEqual(open({ threads: [[taha, reply(`${LINK} no change needed`)]] }), [], "an answer inside the thread clears");
assert.deepEqual(open({ comments: [taha, reply(`${LINK}3 hello`)] }), [LINK], "a link to a longer comment id is not this comment");

// Sol, 2026-10-30: answering one comment must not clear the rest.
const second = comment(TAHA, `${PR_URL}#issuecomment-13`, "An unrelated question");
assert.deepEqual(open({ comments: [taha, second, reply(`${second.url} no`)] }), [LINK], "each comment needs its own answer");
assert.deepEqual(open({ comments: [taha, second, reply(`${LINK} fixed, ${second.url} no`)] }), [], "one reply may answer both");

assert.ok(open({ comments: [taha, reply(`${LINK} self note`, TAHA)] }).includes(LINK), "they cannot answer themselves");
assert.deepEqual(open({ comments: [taha, comment("coderabbitai", `${PR_URL}#issuecomment-99`, `${LINK} thanks`, "Bot")] }),
  [LINK], "a bot cannot answer");
assert.deepEqual(open({ comments: [comment(TAHA, "", "no link came back"), reply("anything")] }), [""], "a comment with no link stays unanswered");

assert.deepEqual(open({ author: TAHA, comments: [taha] }), [], "a PR author's own comment needs no answer");
assert.deepEqual(open({ author: TAHA, comments: [reply("please change this")] }), [], "the shared owner account never blocks");
assert.deepEqual(open({ comments: [comment("coderabbitai", LINK, "finding", "Bot")] }), [], "bots are not teammates");

assert.equal(unansweredTeammateComments(null), null, "no pull request is unreadable");
assert.equal(unansweredTeammateComments({ ...pr(), comments: null }), null, "a missing list is unreadable");
assert.equal(unansweredTeammateComments({ ...pr(), author: null }), null, "a missing PR author is unreadable");
assert.equal(unansweredTeammateComments({ ...pr(), comments: list([], true) }).truncated, true, "a cut-off list is reported");

let calls = 0;
assert.throws(() => readTeammateComments(() => { calls += 1; return "{}"; }, {
  owner: "o", name: "n", number: 1, deadlineMs: 5, now: () => 6,
}), /time budget/, "a spent budget throws so the gates refuse");
assert.equal(calls, 0, "no call is started past the deadline");
assert.equal(readTeammateComments(() => "{}", { owner: "o", name: "n", number: 1 }), null, "an empty answer is unreadable");
assert.equal(
  readTeammateComments(() => JSON.stringify({ data: { repository: { pullRequest: pr() } }, errors: [{ message: "body unavailable" }] }), { owner: "o", name: "n", number: 1 }),
  null,
  "an answer carrying errors is unreadable even with data beside it",
);
assert.deepEqual(
  readTeammateComments(() => JSON.stringify({ data: { repository: { pullRequest: pr({ comments: [taha] }) } } }), { owner: "o", name: "n", number: 1 }).comments,
  [{ login: "tahakhanabdalli", url: LINK }],
  "the read returns the evaluated answer",
);

assert.match(teammateCommentsDenial("X", "7", [{ login: "tahakhanabdalli", url: LINK }]),
  /@tahakhanabdalli: https:[^\n]*issuecomment-12[\s\S]*gh pr comment 7 --body/, "the denial names who, which comment and how");

console.log("teammate-comments-lib tests passed");
