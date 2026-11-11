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
  insertDecisionEntry,
  parseSolFindings,
  reasonProblem,
  textHash,
  solAcceptFileName,
  verifySolAcceptance,
} from "./sol-accept-lib.mjs";

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
assert.match(blockersRecordProblem({ ...record, model: "gpt-6-luna" }, { headSha: H1, nowMs: NOW }), /not from gpt-6-sol/, "record: only a Sol run counts");

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
  const transcript = path.join(root, `t-${codeSeq++}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: reply } })}\n`);
  return () => ({ transcript, from: 0, written: true, words: reply.trim() });
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
assert.match(entry, /\n\n\*\*What this implies/, "log: the closing paragraph is its own paragraph");
assert.equal(findingLocation("prose with no file"), "(location not stated)", "log: no location, none invented");
assert.deepEqual(gateFilesIn(["src/a.ts", ".claude/hooks/x.mjs", "scripts/write-codex-push-proof.mjs", "docs/a.md", "package.json"]),
  [".claude/hooks/x.mjs", "scripts/write-codex-push-proof.mjs", "package.json"], "gate files: hooks, the proof writer and package.json are refused");
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

console.log("sol-accept-lib.test.mjs: all assertions passed");
