#!/usr/bin/env node
// Owner-accepted Sol finding (sol-accept-lib.mjs; Mason, 2026-11-10). Proves the two
// things the gate promises: an `accept <code>` reply covers only its named finding of
// its exact Sol run and head, and a stale, reused or misdirected code is refused.
//
// Run: node .claude/hooks/sol-accept-lib.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "../../scripts/lib/test-temp-dir.mjs";
import { buildCarryForwardProof } from "../../scripts/write-codex-push-proof.mjs";
import { carriedSolProof, proofValid } from "./codex-push-lib.mjs";
import {
  assertReplyAlone,
  assertSkipShown,
  buildApprovalPayload,
  recordReplyApproval,
  resolvePlainReply,
  writeApprovalRequest,
} from "./owner-approval-lib.mjs";
import {
  acceptAttemptIn,
  acceptFromReply,
  blockersRecordProblem,
  buildBlockersRecord,
  buildSolAcceptPayload,
  collectAcceptances,
  decisionLogEntry,
  findingLocation,
  gateFilesIn,
  packageVersionOnlyChange,
  insertDecisionEntry,
  parseSolFindings,
  reasonProblem,
  textHash,
  solAcceptFileName,
  verifySolAcceptance,
  OWNER_SOL_SKIP_PURPOSE,
  SKIP_REASON,
  buildSolSkipPayload,
  readSkipReceipts,
  skipDeadlineMs,
  skipFromReply,
  skipSelection,
  verifySolSkip,
  ownerAcceptedForPr,
} from "./sol-accept-lib.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const BASE = "c".repeat(40);
const SESSION = "session-1234abcd";
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ── parsing Sol's numbered findings ─────────────────────────────────────────
const solOut = [
  "Findings:",
  "1. HIGH src/pages/Sales.tsx:40 — a sale before switch-on skips the registration check.",
  "2. BLOCKER supabase/migrations/x.sql:12 — missing grant.",
  "3. MED something minor.",
  "",
  "SOL_FINDING 1 HIGH: src/pages/Sales.tsx:40 - a sale before switch-on skips the registration check",
  "- **SOL_FINDING 2 BLOCKER: supabase/migrations/x.sql:12 - missing grant**",
  "SOL_FINDING_COUNT: 2",
  "",
  "CODEX_PROOF_VERDICT: BLOCKERS",
].join("\n");
const parsed = parseSolFindings(solOut);
assert.deepEqual(parsed.findings.map((f) => [f.n, f.severity]), [[1, "HIGH"], [2, "BLOCKER"]], "parse: BLOCKER/HIGH lines in order");
assert.match(parseSolFindings("SOL_FINDING 2 HIGH: x\nSOL_FINDING 1 HIGH: y").problem, /do not run 1\.\.2/, "parse: numbers out of order refused");
assert.match(parseSolFindings("SOL_FINDING 1 HIGH: x\nSOL_FINDING 1 HIGH: y").problem, /do not run/, "parse: a repeated number refused");
assert.match(parseSolFindings("SOL_FINDING 1 MED: x").problem, /not in the required form/, "parse: a MED line is malformed, never silently dropped");
assert.match(parseSolFindings("SOL_FINDING 1 HIGH: a\nSOL_FINDING_COUNT 2").problem, /does not match its 1/, "parse: Sol said 2 but listed 1, refused");
assert.match(parseSolFindings("SOL_FINDING 1 HIGH: a").problem, /missing/, "parse: no count line, refused");
assert.match(parseSolFindings("SOL_FINDING 1 HIGH: a b\nSOL_FINDING_COUNT 1").problem, /line break|not in the required form/, "parse: a Unicode line break refused at parse time");
assert.equal(parsed.findings[1].text, "supabase/migrations/x.sql:12 - missing grant", "parse: a bulleted, bold line is read");
assert.match(parseSolFindings("no findings here").problem, /no SOL_FINDING lines/, "parse: none listed refused");
assert.match(parseSolFindings(`SOL_FINDING 1 HIGH: ${"x".repeat(401)}`).problem, /longer than 400/, "parse: an over-long line refused");

const record = buildBlockersRecord({ headSha: H1, baseSha: BASE, findings: parsed.findings, timestamp: iso(NOW - 60 * 60 * 1000) });
assert.equal(blockersRecordProblem(record, { headSha: H1, nowMs: NOW }), null, "record: valid for its own head");
assert.match(blockersRecordProblem(record, { headSha: H2, nowMs: NOW }), /different head/, "record: refused for another head");
assert.match(blockersRecordProblem(record, { headSha: H1, nowMs: NOW + 24 * 60 * 60 * 1000 }), /older than 24 hours/, "record: stale after 24 hours");
assert.match(blockersRecordProblem({ ...record, model: "gpt-6-luna" }, { headSha: H1, nowMs: NOW }), /not from gpt-6.2-sol/, "record: only a Sol run counts");

// ── Mason's reply ───────────────────────────────────────────────────────────
assert.deepEqual(acceptFromReply("accept 123456 we never sell before switch-on"), { code: "123456", reason: "we never sell before switch-on" });
assert.deepEqual(acceptFromReply("Accept 123456: fine."), { code: "123456", reason: "fine." }, "reply: phone capital and a colon");
assert.deepEqual(acceptFromReply("accept 123456"), { code: "123456", reason: "" }, "reply: no reason is read, then refused by the hook");
assert.equal(acceptFromReply("accept 1234567 x"), null, "reply: seven digits is not a code");
assert.equal(acceptFromReply("please accept 123456 ok"), null, "reply: must be the whole message");
assert.equal(acceptFromReply("accept 123456 ok\nand also merge it"), null, "reply: one line only");
assert.equal(acceptFromReply(`accept 123456 ${"x ".repeat(200)}`).reason.length > 300, true, "reply: a long reason is kept whole, then refused, never cut");
assert.equal(reasonProblem("we never sell before switch-on"), null, "reason: an ordinary reason passes");
for (const [bad, why] of [["ok", /two words/], ["costs $5 each", /money/], ["call 555-123-4567 now", /phone/], ["mail a@b.com please", /email/],
  ["see #1234 too", /#numbers/], ["a <!-- b", /markup/], ["a‮b c", /markup/], ["x ".repeat(160), /under 300/]]) {
  assert.match(reasonProblem(bad), why, "reason: refused " + why);
}
assert.equal(acceptAttemptIn("hi\naccept 123456 ok"), "accept 123456 ok", "reply: a buried accept line is reported, not silent");

// ── request → reply → acceptance file ───────────────────────────────────────
const root = tempDir("crx-sol-accept-");
const stateDir = path.join(root, ".claude", "session-state");
mkdirSync(stateDir, { recursive: true });
const dirs = [stateDir];
let codeSeq = 100000;
function request(n, { rec = record, sessionId = SESSION, issuedAt = NOW - 1000, code = String(codeSeq++) } = {}) {
  writeApprovalRequest(stateDir, buildSolAcceptPayload({
    record: rec, n, pullRequest: 1688, issuedAt: iso(issuedAt), expiresAt: iso(issuedAt + 24 * 60 * 60 * 1000),
    nonce: `nonce${code}`, code, sessionId,
  }));
  return code;
}
// His reply as Claude Code writes it, so the verifier can read it back (assertReplyAlone).
function markFor(reply) {
  const dir = path.join(root, `t-${codeSeq++}`);
  mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: reply } })}\n`);
  return () => ({ transcript, from: 0, written: true, words: reply.trim() });
}
// The agent's summary as its last message, then his reply, in this session's transcript.
function skipMarkFor(shown, reply) {
  const dir = path.join(root, `t-${codeSeq++}`);
  mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, `${[
    { type: "user", message: { role: "user", content: "fix it" } },
    { type: "assistant", message: { id: `m${codeSeq++}`, role: "assistant", content: [{ type: "text", text: shown }] } },
    { type: "user", message: { role: "user", content: reply } },
  ].map((o) => JSON.stringify(o)).join("\n")}\n`);
  const from = readFileSync(transcript).length;
  // The agent's answer after his reply, as in a real conversation by the time of the proof.
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { id: `m${codeSeq++}`, role: "assistant", content: [{ type: "text", text: "Noted." }] } })}\n`, { flag: "a" });
  return () => ({ transcript, from, written: true, words: reply.trim() });
}
function reply(text, { sessionId = SESSION, now = NOW } = {}) {
  const a = acceptFromReply(text);
  return recordReplyApproval({
    code: a ? a.code : text.match(/\d{6}/)[0], dirs, reply: text, sessionId, now, readMark: markFor(text),
    ...(a ? { form: "accept", reason: a.reason } : {}),
  });
}
const readAcceptance = (head, n) => { try { return JSON.parse(readFileSync(path.join(stateDir, solAcceptFileName(head, n)), "utf8")); } catch { return null; } };

const c1 = request(1);
assert.equal(resolvePlainReply({ dirs, sessionId: SESSION, readShown: () => "" }).silent, true, "a plain 'I approve' never answers a Sol-finding request");
assert.match(reply(`approve ${c1}`).reason, /is a Sol finding; accept it with/, "an `approve <code>` reply never accepts a finding");
assert.match(reply(`accept ${c1}`).reason, /at least two words/, "accept without a reason is refused");
assert.match(reply(`accept ${c1} it costs $40 only`).reason, /money/, "a reason with a money amount is refused (the log is public)");
assert.match(reply(`accept ${c1} fine by me`, { sessionId: "other-session-99" }).reason, /different conversation/, "a reply in another conversation is refused");
assert.match(reply(`accept ${c1} fine by me`, { now: NOW + 25 * 60 * 60 * 1000 }).reason, /expired/, "a stale request is refused");
// None of those refusals used the code up.
const ok1 = reply(`accept ${c1} we never sell before switch-on`);
assert.equal(ok1.ok, true, `accept with a reason records it (${ok1.reason})`);
assert.equal(ok1.kind, "sol-accept");
assert.equal(readAcceptance(H1, 1).reason, "we never sell before switch-on", "the acceptance keeps his reason");
assert.equal(existsSync(path.join(stateDir, solAcceptFileName(H1, 2))), false, "accepting finding 1 writes nothing for finding 2");

// Reused code: refused at the reply, and no new request may draw it again.
assert.match(reply(`accept ${c1} again`).reason, /no pending approval request has the code/, "a used code is refused");
assert.throws(() => request(2, { code: c1 }), (e) => e.code === "EEXIST", "a used code can never be issued again");

// A migration request is never answered by `accept`.
const migCode = String(codeSeq++);
writeApprovalRequest(stateDir, buildApprovalPayload({
  project: "p", migration: "20261110000000_x", queryHash: "f".repeat(64), pullRequest: 1688, prHead: H1,
  categories: [{ category: "deletes-data", reason: "DELETE" }], issuedAt: iso(NOW - 1000), expiresAt: iso(NOW + 60_000),
  nonce: "migNonce", code: migCode, sessionId: SESSION,
}));
assert.match(reply(`accept ${migCode} looks fine`).reason, /not a Sol finding/, "accept never approves a migration");

// ── the acceptance covers only its finding, head and Sol run ────────────────
const a1 = readAcceptance(H1, 1);
assert.equal(verifySolAcceptance({ approval: a1, record, n: 1, checkReply: assertReplyAlone }).ok, true, "verify: covers its own finding");
assert.match(verifySolAcceptance({ approval: a1, record, n: 2 }).reason, /different finding/, "verify: never covers another finding");
const otherHead = buildBlockersRecord({ headSha: H2, baseSha: BASE, findings: parsed.findings, timestamp: record.timestamp });
assert.match(verifySolAcceptance({ approval: a1, record: otherHead, n: 1 }).reason, /different version/, "verify: never covers another head");
const rerun = { ...record, timestamp: iso(NOW - 1000) };
assert.match(verifySolAcceptance({ approval: a1, record: rerun, n: 1 }).reason, /earlier Sol run/, "verify: stale after Sol re-runs on the same head");
const reworded = buildBlockersRecord({ headSha: H1, baseSha: BASE, timestamp: record.timestamp,
  findings: [{ ...parsed.findings[0], text: "something else" }, parsed.findings[1]] });
assert.match(verifySolAcceptance({ approval: a1, record: reworded, n: 1 }).reason, /different finding/, "verify: a reworded finding is not the one he accepted");
assert.match(verifySolAcceptance({ approval: { ...a1, reason: "" }, record, n: 1 }).reason, /no usable reason/, "verify: the reason is required");
assert.match(verifySolAcceptance({ approval: { ...a1, reason: "a different reason" }, record, n: 1 }).reason, /recorded reply does not match/, "verify: the reason must be the one his reply gave");
assert.match(verifySolAcceptance({ approval: { ...a1, reply: "accept 999999 we never sell before switch-on" }, record, n: 1 }).reason, /recorded reply does not match/, "verify: the reply must carry the request's code");
assert.match(verifySolAcceptance({ approval: a1, record, n: 1, checkReply: () => { throw new Error("picture attached"); } }).reason, /words alone/, "verify: his reply must be words alone");
const tampered = { ...a1, payload: JSON.stringify({ ...JSON.parse(a1.payload), finding: { ...parsed.findings[0], severity: "BLOCKER" } }) };
assert.match(verifySolAcceptance({ approval: tampered, record, n: 1 }).reason, /different finding/, "verify: an edited payload is refused");

// ── every BLOCKER/HIGH must be accepted before the log and the proof ────────
const got1 = collectAcceptances({ record, readAcceptance: (n) => readAcceptance(H1, n), checkReply: assertReplyAlone });
assert.match(got1.problem, /finding 2: Mason has not accepted it/, "collect: one accepted of two is not enough");
const c2 = request(2);
assert.equal(reply(`accept ${c2} the grant is added by the next PR`).ok, true, "finding 2 accepted by its own code");
const got = collectAcceptances({ record, readAcceptance: (n) => readAcceptance(H1, n), checkReply: assertReplyAlone });
assert.equal(got.problem, undefined, `collect: both accepted (${got.problem})`);
const entry = decisionLogEntry({ record, accepted: got.accepted });
assert.match(entry, /^## \d{4}-\d{2}-\d{2} — #1688: Mason owner-accepted 2 Sol finding\(s\)/, "log: names the PR");
assert.match(entry, /\*\*Decision \(Mason, owner-accepted/, "log: a Decision line naming Mason");
assert.match(entry, /Finding 1 \(HIGH\) at `src\/pages\/Sales\.tsx:40`, text sha256 `[0-9a-f]{16}`.*\n  Mason's reason: we never sell before switch-on/, "log: location, hash and his reason");
assert.equal(entry.includes("skips the registration check"), false, "log: never publishes the finding's wording (an unfixed hole)");
assert.equal(entry.includes(textHash(parsed.findings[0].text)), true, "log: the hash names the exact text");
assert.doesNotMatch(entry, /What this implies|proof covers|carries like|may land|reviewer|Sol review/i, "log: records the decision only, nothing addressed to reviewers (#1731 round 8)");
assert.match(entry, /left unfixed\.\n- Finding 1/, "log: the decision line, then the findings");
assert.equal(findingLocation("prose with no file"), "(location not stated)", "log: no location, none invented");
assert.equal(findingLocation("buyer@example.com - leaked"), "(location not stated)", "log: an email address is never a location");
assert.equal(findingLocation("node_modules/@types/x/index.d.ts:3 - y"), "`node_modules/@types/x/index.d.ts:3`", "log: a scoped package path still is");
assert.deepEqual(gateFilesIn(["src/a.ts", ".claude/hooks/x.mjs", "scripts/write-codex-push-proof.mjs", "docs/a.md", "package.json"]),
  [".claude/hooks/x.mjs", "scripts/write-codex-push-proof.mjs", "package.json"], "gate files: hooks, the proof writer and package.json are refused");
{
  const pkg = (v, dep = "^1.0.0") => JSON.stringify({ name: "crx", version: v, dependencies: { a: dep } });
  const lock = (v, dep = "1.0.0") => JSON.stringify({ name: "crx", version: v, packages: { "": { version: v }, "node_modules/a": { version: dep } } });
  const files = {
    "package.json": [pkg("0.0.0"), pkg("0.1.0")],
    "package-lock.json": [lock("0.0.0"), lock("0.1.0")],
  };
  assert.deepEqual(gateFilesIn(["package.json", "package-lock.json", ".github/x.mjs"], (p) => files[p]), [".github/x.mjs"],
    "gate files: a version-only package.json/lock change is not a gate change");
  files["package.json"] = [pkg("0.0.0"), pkg("0.1.0", "^2.0.0")];
  files["package-lock.json"] = [lock("0.0.0"), lock("0.1.0", "2.0.0")];
  assert.deepEqual(gateFilesIn(["package.json", "package-lock.json"], (p) => files[p]), ["package.json", "package-lock.json"],
    "gate files: a dependency change still counts");
  files["package.json"] = [null, pkg("0.1.0")];
  files["package-lock.json"] = [lock("0.0.0"), "not json"];
  assert.deepEqual(gateFilesIn(["package.json", "package-lock.json"], (p) => files[p]), ["package.json", "package-lock.json"],
    "gate files: an unreadable or new package file still counts");
  assert.equal(packageVersionOnlyChange(pkg("0.0.0"), pkg("0.0.0")), true, "gate files: identical is version-only");
  assert.deepEqual(gateFilesIn(["scripts/lib/x.mjs"], () => [pkg("0.0.0"), pkg("0.1.0")]), ["scripts/lib/x.mjs"],
    "gate files: the exemption is only for the two package files");
}
assert.equal(decisionLogEntry({ record, accepted: got.accepted }), entry, "log: deterministic");
const log = "# Decision Log\n\nIntro.\n\n## 2026-11-09 — older\n\nbody\n";
assert.equal(insertDecisionEntry(log, entry), `# Decision Log\n\nIntro.\n\n${entry}## 2026-11-09 — older\n\nbody\n`, "log: newest first");
assert.equal(insertDecisionEntry(log.replace(/\n/g, "\r\n"), entry), insertDecisionEntry(log, entry), "log: line endings do not matter");

// ── the gates accept the carried proof only for its own head and base ───────
const proof = buildCarryForwardProof({
  headSha: H2, baseSha: BASE, source: { head_sha: H1, base_sha: BASE, timestamp: record.timestamp }, mode: "owner_accepted", timestamp: iso(NOW),
});
proof.owner_accepted = got.accepted.map((a) => ({ n: a.payload.finding.n, reason: a.reason }));
assert.equal(carriedSolProof(proof), true, "gate: owner_accepted is a carried Sol proof");
assert.equal(proofValid(proof, H2, NOW, BASE), true, "gate: valid for its exact head and base");
assert.equal(proofValid(proof, H1, NOW, BASE), false, "gate: not for the reviewed head");
assert.equal(proofValid(proof, H2, NOW, "d".repeat(40)), false, "gate: not for another base");
assert.equal(proofValid({ ...proof, owner_accepted: [] }, H2, NOW, BASE), false, "gate: no acceptances, no proof");
assert.equal(proofValid({ ...proof, carry: { ...proof.carry, from_base: "d".repeat(40) } }, H2, NOW, BASE), false, "gate: the base cannot move");
assert.equal(proofValid(proof, H2, NOW + 24 * 60 * 60 * 1000, BASE), false, "gate: expires with the Sol run it came from");

// A later carry (a main merge, a restamp, post-apply records) keeps the acceptance on record.
const chained = buildCarryForwardProof({ headSha: "e".repeat(40), baseSha: BASE, source: proof, mode: "post_apply", timestamp: iso(NOW) });
assert.equal(chained.carry.root_review.owner_accepted, true, "chain: the root review stays marked owner-accepted");
assert.deepEqual(chained.owner_accepted, proof.owner_accepted, "chain: the acceptances travel with the proof");
assert.equal("owner_accepted" in buildCarryForwardProof({ headSha: H2, baseSha: BASE, source: { head_sha: H1, base_sha: BASE, timestamp: iso(NOW) }, mode: "restamp" }), false,
  "chain: an ordinary carry gains no acceptance");

// ── Skipping in plain words: one request, one reply, no code (Mason, 2026-11-21) ──
for (const yes of ["skip", "Skip.", "SKIP!", "skip all", "skip them", "skip these", "accept", "Accept all", "don't fix", "Don’t fix them",
  "do not fix", "I don’t want those", "i do not want them fixed", "leave them", "  skip  ", "I disagree", "I disagree.", "i disagree with them"]) {
  assert.deepEqual(skipFromReply(yes), { all: true }, `skip: "${yes}" skips everything shown`);
}
for (const one of ["I don't want that", "leave it alone", "skip it", "don't fix that", "i do not want it fixed", "I disagree with that"]) {
  assert.deepEqual(skipFromReply(one), { all: true, single: true }, `skip: "${one}" names one finding`);
}
assert.deepEqual(skipSelection(skipFromReply("I don't want that"), [{ n: 1 }]), { numbers: [1] }, "skip: 'that' skips a lone finding");
for (const no of ["I disagree, fix it later", "do you disagree?", "disagree"]) assert.equal(skipFromReply(no), null, `skip: "${no}" skips nothing`);
// A skip counts only for the PR it was given for (Sol gate rounds 3-4).
assert.equal(ownerAcceptedForPr({ verdict: "clean" }, 7), true, "PR binding: a plain clean proof is unaffected");
assert.equal(ownerAcceptedForPr({ owner_accepted: [{ pull_request: 7 }, { pull_request: 7 }] }, 7), true, "PR binding: own PR");
assert.equal(ownerAcceptedForPr({ owner_accepted: [{ pull_request: 7 }, { pull_request: 8 }] }, 7), false, "PR binding: a skip from another PR is refused");
assert.equal(ownerAcceptedForPr({ owner_accepted: [] }, 7), false, "PR binding: an empty list is refused");
assert.equal(ownerAcceptedForPr({ owner_accepted: null }, 7), false, "PR binding: a damaged list is refused");
assert.match(skipSelection(skipFromReply("I don't want that"), [{ n: 1 }, { n: 2 }]).problem, /"that" or "it"/, "skip: 'that' never skips a list of two");
assert.deepEqual(skipFromReply("skip 1 3"), { numbers: [1, 3] }, "skip: numbers");
assert.deepEqual(skipFromReply("skip 1, 3 and 4"), { numbers: [1, 3, 4] }, "skip: a list with commas and and");
assert.deepEqual(skipFromReply("don't fix finding 2"), { numbers: [2] }, "skip: 'finding 2'");
for (const no of ["ok", "yes", "Yes I approve", "I approve", "move on", "merge it", "no", "no, fix it", "skip?", "skip the explanation and fix it",
  "I don't want that approach", "accept only if the totals reconcile", "accept all 1 3", "accept 123456", "accept 123456 fine by me",
  "skip\nand merge", "please skip", "skip 123", ""]) {
  assert.equal(skipFromReply(no), null, `skip: "${no}" is not a skip`);
}
const shownF = [{ n: 1 }, { n: 3 }];
assert.deepEqual(skipSelection({ all: true }, shownF), { numbers: [1, 3] }, "selection: all = every finding shown");
assert.deepEqual(skipSelection({ numbers: [3, 1] }, shownF), { numbers: [1, 3] }, "selection: sorted");
assert.match(skipSelection({ numbers: [2] }, shownF).problem, /not in the list/, "selection: a number he was not shown skips nothing");
assert.match(skipSelection({ numbers: [0] }, shownF).problem, /not in the list/, "selection: 0 skips nothing");
assert.match(skipSelection({ numbers: [1, 1] }, shownF).problem, /twice/, "selection: a repeat skips nothing");

{
  const H3 = "d".repeat(40);
  const rec3 = buildBlockersRecord({ headSha: H3, baseSha: BASE, findings: [
    { n: 1, severity: "HIGH", text: "src/a.ts:1 - one" },
    { n: 2, severity: "BLOCKER", text: "src/b.ts:2 - two" },
    { n: 3, severity: "HIGH", text: "src/c.ts:3 - three" },
  ], timestamp: iso(NOW - 60 * 60 * 1000) });
  const shownFor = {};
  const skipReq = (numbers, code = String(codeSeq++), extra = {}) => {
    const text = buildSolSkipPayload({ record: rec3, numbers, pullRequest: 2200, issuedAt: iso(NOW - 1000),
      expiresAt: iso(skipDeadlineMs(rec3, NOW - 1000, 24 * 60 * 60 * 1000)), nonce: `skipnonce${code}`, code, sessionId: SESSION, ...extra });
    writeApprovalRequest(stateDir, text);
    shownFor[code] = JSON.parse(text).summary.join("\n");
    return { code, payload: JSON.parse(text) };
  };
  const skipReply = (code, text, opts = {}) => recordReplyApproval({
    code, dirs, reply: text, sessionId: opts.sessionId ?? SESSION, now: opts.now ?? NOW, readMark: skipMarkFor(shownFor[code] ?? "", text), form: "skip", skip: skipFromReply(text),
  });
  const r1 = skipReq([1, 3]);
  assert.equal(Date.parse(r1.payload.expiresAt), Date.parse(rec3.timestamp) + 24 * 60 * 60 * 1000, "request: deadline never past the Sol run's own 24 hours");
  assert.match(r1.payload.summary.join("\n"), /Finding 1 of 3 \(HIGH\).*\nFinding 3 of 3 \(HIGH\)/, "request: lists only the findings asked about");
  assert.match(r1.payload.summary.join("\n"), /To skip them all, reply: skip/, "request: tells him the one word");
  assert.doesNotMatch(r1.payload.summary.join("\n"), /accept \d{6}/, "request: no code to type");
  const shownText = r1.payload.summary.join("\n");
  const resolveSkip = (shown, sessionId = SESSION) => resolvePlainReply({ dirs, sessionId, readShown: () => shown, purposes: [OWNER_SOL_SKIP_PURPOSE] });
  assert.equal(resolveSkip(shownText).code, r1.code, "resolve: the summary shown alone picks its request");
  assert.match(resolveSkip(`${shownText}\nAlso, want me to merge?`).reason, /did not show/, "resolve: summary plus other words picks nothing");
  assert.equal(resolveSkip(shownText, "other-session-99").silent, true, "resolve: another conversation sees nothing waiting");
  assert.notEqual(resolvePlainReply({ dirs, sessionId: SESSION, readShown: () => shownText }).code, r1.code, "resolve: 'I approve' never answers a skip request");
  assert.match(recordReplyApproval({ code: r1.code, dirs, reply: `approve ${r1.code}`, sessionId: SESSION, readMark: markFor("x") }).reason, /answer it with: skip/, "approve never skips");
  assert.match(recordReplyApproval({ code: r1.code, dirs, reply: `accept ${r1.code} fine by me`, sessionId: SESSION, readMark: markFor("x"), form: "accept", reason: "fine by me" }).reason,
    /answer it with: skip/, "the old accept form never answers a skip request");
  assert.match(skipReply(r1.code, "skip 2").reason, /not in the list/, "reply: a number not shown skips nothing");
  assert.match(skipReply(r1.code, "skip", { sessionId: "other-session-99" }).reason, /different conversation/, "reply: another conversation skips nothing");
  assert.match(skipReply(r1.code, "skip", { now: NOW + 25 * 60 * 60 * 1000 }).reason, /expired/, "reply: a stale request skips nothing");
  const ok3 = skipReply(r1.code, "skip 3");
  assert.equal(ok3.ok, true, `reply: skip 3 records (${ok3.reason})`);
  assert.deepEqual(ok3.selected, [3], "reply: only finding 3");
  const receipts = readSkipReceipts(stateDir, H3);
  assert.equal(receipts.length, 1, "one receipt for the reply");
  assert.deepEqual(receipts[0].selected, [3]);
  { const v = verifySolSkip({ approval: receipts[0], record: rec3, checkReply: assertReplyAlone, checkShown: assertSkipShown }); assert.equal(v.ok, true, `verify: the receipt holds (${v.reason})`); }
  assert.match(verifySolSkip({ approval: receipts[0], record: rec3, checkReply: assertReplyAlone }).reason, /was not checked/, "verify: what he was shown must be checked");
  assert.match(verifySolSkip({ approval: { ...receipts[0], replyMark: skipMarkFor("Another request's summary", "skip 3")() }, record: rec3, checkShown: assertSkipShown }).reason,
    /not this request's summary/, "verify: a skip sent for another request never counts");
  assert.match(verifySolSkip({ approval: { ...receipts[0], selected: [1, 3] }, record: rec3 }).reason, /does not match/, "verify: an edited selection is refused");
  assert.match(verifySolSkip({ approval: { ...receipts[0], reply: "skip" }, record: rec3 }).reason, /does not match/, "verify: the reply must give the same selection");
  assert.match(verifySolSkip({ approval: receipts[0], record: { ...rec3, timestamp: iso(NOW - 1000) } }).reason, /earlier Sol run/, "verify: a re-run of Sol voids it");
  assert.match(verifySolSkip({ approval: receipts[0], record: { ...rec3, head_sha: H2 } }).reason, /different version/, "verify: another head voids it");
  assert.match(verifySolSkip({ approval: receipts[0], record: rec3, checkReply: () => { throw new Error("picture attached"); } }).reason, /words alone/, "verify: words alone");
  assert.match(verifySolSkip({ approval: { ...receipts[0], replyMark: { ...receipts[0].replyMark, words: "skip" } }, record: rec3 }).reason, /does not hold the recorded reply/,
    "verify: the transcript mark must hold the recorded reply");
  assert.match(verifySolSkip({ approval: { ...receipts[0], replyMark: { ...receipts[0].replyMark, transcript: path.join(root, "other-session.jsonl") } }, record: rec3 }).reason,
    /different conversation/, "verify: the mark must be in the conversation that asked");

  const readNone = () => null;
  assert.match(collectAcceptances({ record: rec3, readAcceptance: readNone, readSkips: () => readSkipReceipts(stateDir, H3) }).problem, /finding 1/,
    "collect: findings 1 and 2 still open");
  const r2 = skipReq(undefined);
  assert.equal(r2.payload.findings.length, 3, "request: --all lists every finding");
  assert.equal(skipReply(r2.code, "I don't want that").ok, false, "reply: 'that' on a list of three skips nothing");
  assert.equal(skipReply(r2.code, "I don't want those").ok, true, "reply: plain words skip them all");
  const got3 = collectAcceptances({ record: rec3, readAcceptance: readNone, readSkips: () => readSkipReceipts(stateDir, H3), checkReply: assertReplyAlone, checkShown: assertSkipShown });
  assert.equal(got3.problem, undefined, `collect: all three skipped (${got3.problem})`);
  assert.deepEqual(got3.accepted.map((a) => [a.payload.finding.n, a.reason]), [[1, SKIP_REASON], [2, SKIP_REASON], [3, SKIP_REASON]]);
  const e3 = decisionLogEntry({ record: rec3, accepted: got3.accepted });
  assert.match(e3, /\*\*Decision \(Mason, by chat reply, .*Mason chose to leave each one unfixed\./, "log: plain-reply wording");
  assert.match(e3, /Finding 2 \(BLOCKER\) at `src\/b\.ts:2`.*\n  Mason chose to leave it unfixed \(plain reply, ref /, "log: fixed wording per finding");
  assert.equal(e3.includes(" - two"), false, "log: never the finding's wording");
  assert.doesNotMatch(e3, /may land|reviewer|Sol review/i, "log: nothing addressed to reviewers");
  assert.equal(entry.includes("accept <code>"), true, "log: an old accept-only entry keeps its old wording");

  // The real reply hook, end to end: the summary as the agent's last message, then his one word.
  const r4 = skipReq([1, 2]);
  const transcript = path.join(root, "skip-transcript.jsonl");
  const line = (o) => JSON.stringify(o);
  const tx = (agentText) => writeFileSync(transcript, `${[
    line({ type: "user", message: { role: "user", content: "fix it" } }),
    line({ type: "assistant", message: { id: `m${codeSeq++}`, role: "assistant", content: [{ type: "text", text: agentText }] } }),
  ].join("\n")}\n`);
  const hook = (prompt, sessionId = SESSION) => {
    const res = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "owner-approval-prompt.mjs")], {
      cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8", timeout: 30_000,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: root, prompt, transcript_path: transcript }),
    });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput?.additionalContext || "" : "";
  };
  const shown4 = r4.payload.summary.join("\n");
  tx(shown4);
  assert.equal(hook("ok"), "", "hook: 'ok' is ordinary chat and skips nothing");
  assert.doesNotMatch(hook("yes"), /SKIPPED —/, "hook: 'yes' skips nothing (it stays a migration-approval word only)");
  tx(`Here is something else.\n${shown4}`);
  assert.match(hook("skip"), /NOT SKIPPED.*did not show/, "hook: the summary must be the whole last message");
  tx(shown4);
  assert.equal(hook("skip", "other-session-99"), "", "hook: another conversation has nothing waiting, so it skips nothing");
  const out = hook("skip");
  assert.match(out, /SOL FINDINGS SKIPPED — Mason skipped finding\(s\) 1, 2 of 3 on PR #2200/, `hook: one word skips both (${out})`);
  assert.equal(hook("skip"), "", "hook: the same reply again skips nothing more (nothing is waiting, so it is ordinary chat)");
}

console.log("sol-accept-lib.test.mjs: all assertions passed");
