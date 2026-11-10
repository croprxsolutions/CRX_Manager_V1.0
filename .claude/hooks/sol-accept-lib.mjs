// OWNER-ACCEPTED SOL FINDING (Mason, 2026-11-10: PR #1688 ran 13 Sol rounds, most on
// sales before a feature's switch-on, which he says will never happen).
//
// Mason may accept ONE named BLOCKER/HIGH finding from a Sol review as a business
// non-issue, instead of another fix-and-review round. The flow:
//   1. scripts/write-codex-push-proof.mjs, on a BLOCKERS verdict, saves the run's
//      numbered BLOCKER/HIGH findings (SOL_FINDING lines) bound to the reviewed head
//      and base: codex-review-blockers-<head>.json.
//   2. scripts/owner-accept-sol-finding.mjs <n> builds a request for finding n; Mason
//      replies `accept <code> <reason>` in the session that built it
//      (owner-approval-prompt.mjs records it through owner-approval-lib.mjs).
//   3. When every BLOCKER/HIGH of that run is accepted, `--log` writes the
//      DECISION_LOG.md entry; it is committed alone on top of the reviewed head.
//   4. write-codex-push-proof.mjs --carry-owner-accepted checks that commit adds
//      exactly that entry and writes a carried Sol proof (carry.mode
//      "owner_accepted") bound to the new head, which the merge and apply gates accept.
// The same trust boundary as Mason's migration approval (owner-approval-lib.mjs
// header): it stops a mistaken or relayed acceptance, not an agent forging files.

import path from "node:path";

export const SOL_FINDING_TOKEN = "SOL_FINDING";
export const SOL_BLOCKERS_PURPOSE = "crx-sol-blockers-v1";
export const OWNER_SOL_ACCEPT_PURPOSE = "crx-owner-sol-accept-v1";
export const OWNER_SOL_ACCEPT_VIA = "chat-reply-accept";
export const SOL_MODEL = "gpt-6-sol";
export const SOL_EFFORT = "high";
// The blockers record lives as long as a Sol proof would (codex-push-lib SOL_PROOF_MAX_AGE_MS).
export const SOL_BLOCKERS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DECISION_LOG_PATH = "docs/manual/DECISION_LOG.md";
const SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_TEXT = 400;
// Any line break, including the Unicode separators, so a reason or finding is one line.
const BREAK_RE = /[\r\n\x85\p{Zl}\p{Zp}]/u;

export const blockersRecordName = (head) => `codex-review-blockers-${head}.json`;
export const solAcceptFileName = (head, n) => `owner-approval-sol-accept-${head}-${n}.json`;

const FINDING_RE = new RegExp(`^${SOL_FINDING_TOKEN}\\s+(\\d{1,2})\\s+(BLOCKER|HIGH):\\s*(\\S.*)$`);

/**
 * The numbered BLOCKER/HIGH findings Sol listed (`SOL_FINDING <n> <BLOCKER|HIGH>: <one line>`).
 * Numbers must run 1..k with no gap or repeat, and every line naming the token must match,
 * so the count cannot be read wrong. { findings } or { problem }.
 */
export function parseSolFindings(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes(SOL_FINDING_TOKEN));
  const findings = [];
  for (const line of lines) {
    const m = FINDING_RE.exec(line);
    if (!m) return { problem: `a ${SOL_FINDING_TOKEN} line is not in the required form: ${line.slice(0, 80)}` };
    const text = m[3].trim();
    if (text.length > MAX_TEXT) return { problem: `finding ${m[1]} is longer than ${MAX_TEXT} characters` };
    findings.push({ n: Number(m[1]), severity: m[2], text });
  }
  if (!findings.length) return { problem: `Sol listed no ${SOL_FINDING_TOKEN} lines` };
  if (findings.some((f, i) => f.n !== i + 1)) return { problem: `the ${SOL_FINDING_TOKEN} numbers do not run 1..${findings.length}` };
  return { findings };
}

/** What the push-proof wrapper saves after a BLOCKERS run with parseable findings. */
export function buildBlockersRecord({ headSha, baseSha, findings, timestamp = new Date().toISOString() }) {
  return {
    purpose: SOL_BLOCKERS_PURPOSE,
    codex_ran: true,
    verdict: "blockers",
    model: SOL_MODEL,
    reasoning_effort: SOL_EFFORT,
    head_sha: headSha,
    base_sha: baseSha,
    timestamp,
    findings: findings.map(({ n, severity, text }) => ({ n, severity, text })),
  };
}

/** null when `rec` is a usable blockers record for `headSha` at `nowMs`, otherwise why not. */
export function blockersRecordProblem(rec, { headSha, nowMs = Date.now() }) {
  if (!rec || typeof rec !== "object") return "no Sol findings were saved for this head (run the full Sol review)";
  if (rec.purpose !== SOL_BLOCKERS_PURPOSE || rec.codex_ran !== true || rec.verdict !== "blockers") return "the saved Sol findings are malformed";
  if (rec.model !== SOL_MODEL || rec.reasoning_effort !== SOL_EFFORT) return `the saved findings are not from ${SOL_MODEL}/${SOL_EFFORT}`;
  if (!SHA_RE.test(String(rec.head_sha || "")) || String(rec.head_sha).toLowerCase() !== String(headSha).toLowerCase()) {
    return "the saved Sol findings are for a different head";
  }
  if (!SHA_RE.test(String(rec.base_sha || ""))) return "the saved Sol findings record no usable base";
  const t = Date.parse(rec.timestamp || "");
  if (!Number.isFinite(t) || nowMs < t || nowMs - t > SOL_BLOCKERS_MAX_AGE_MS) return "the Sol review that found them is older than 24 hours (or dated in the future)";
  const f = rec.findings;
  if (!Array.isArray(f) || !f.length || f.some((x, i) => x?.n !== i + 1 || !["BLOCKER", "HIGH"].includes(x?.severity)
    || typeof x?.text !== "string" || !x.text || x.text.length > MAX_TEXT || BREAK_RE.test(x.text))) {
    return "the saved Sol findings list is malformed";
  }
  return null;
}

// `accept <6 digits> <reason>` as the WHOLE message, on one line. The reason is required:
// it is what DECISION_LOG.md records as his.
const ACCEPT_RE = /^\s*accept\s+(\d{6})(?![\p{L}\p{N}_])([^\r\n\x85\p{Zl}\p{Zp}]*)$/iu;

/** { code, reason } for `accept <code> <reason>`; { code, reason: "" } when he gave none; else null. */
export function acceptFromReply(prompt) {
  const m = ACCEPT_RE.exec(String(prompt ?? "").replace(/\s+$/, ""));
  if (!m) return null;
  const reason = m[2].replace(/^[\s:,\-–—]+/, "").trim();
  return { code: m[1], reason: reason.length > 300 ? reason.slice(0, 300) : reason };
}

/** True when one LINE of a longer message is an accept reply (said out loud, never silent). */
export const acceptAttemptIn = (prompt) =>
  String(prompt ?? "").split(/\r\n|[\r\n\x85\p{Zl}\p{Zp}]/u).map((l) => l.trim()).find((l) => acceptFromReply(l)) || null;

/** The lines Mason reads before he replies. Derived only from payload fields. */
export function solAcceptSummary(p) {
  return [
    "Accept this ONE Sol finding as a business non-issue:",
    "",
    `Pull request: #${p.pullRequest} (version ${String(p.prHead).slice(0, 12)})`,
    `Finding ${p.finding?.n} of ${p.findingCount} (${p.finding?.severity}): ${p.finding?.text}`,
    "",
    "If you accept it, the pull request may land without fixing it.",
    `Your reason is written word for word in ${DECISION_LOG_PATH}, which is public.`,
    "Every other finding and every other safety check still applies.",
    "",
    `To accept, reply: accept ${p.code} followed by your reason`,
    `(for example: accept ${p.code} we never sell before switch-on)`,
    `Reply before ${new Date(p.expiresAt).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" })} Central.`,
  ];
}

/** The request for finding `n` of `record`. Field order is fixed. */
export function buildSolAcceptPayload({ record, n, pullRequest, issuedAt, expiresAt, nonce, code, sessionId }) {
  const f = record.findings[n - 1];
  const p = {
    purpose: OWNER_SOL_ACCEPT_PURPOSE,
    pullRequest,
    prHead: record.head_sha,
    baseSha: record.base_sha,
    reviewedAt: record.timestamp,
    finding: { n: f.n, severity: f.severity, text: f.text },
    findingCount: record.findings.length,
    issuedAt,
    expiresAt,
    nonce,
    code,
    sessionId,
  };
  return JSON.stringify({ ...p, summary: solAcceptSummary(p) }, null, 2);
}

/**
 * Check one recorded acceptance against the blockers record it must cover, finding `n`.
 * Bound to that exact Sol run (head, base and review time), so an acceptance from an
 * earlier run, another head or another finding never counts.
 * @returns {{ok: true, payload: object, reason: string, approvedAt: string}|{ok: false, reason: string}}
 */
export function verifySolAcceptance({ approval, record, n, checkReply }) {
  const no = (reason) => ({ ok: false, reason: `finding ${n}: ${reason}` });
  if (!approval || approval.via !== OWNER_SOL_ACCEPT_VIA || typeof approval.payload !== "string") return no("Mason has not accepted it");
  let p;
  try { p = JSON.parse(approval.payload); } catch { return no("the acceptance is unreadable"); }
  if (p.purpose !== OWNER_SOL_ACCEPT_PURPOSE) return no("the acceptance is not a Sol-finding acceptance");
  if (String(p.prHead).toLowerCase() !== String(record.head_sha).toLowerCase() || p.baseSha !== record.base_sha) {
    return no("it was accepted for a different version of the pull request");
  }
  if (p.reviewedAt !== record.timestamp) return no("it was accepted from an earlier Sol run on this head, not this one");
  const f = record.findings[n - 1];
  if (!f || p.finding?.n !== f.n || p.finding?.severity !== f.severity || p.finding?.text !== f.text) return no("it accepts a different finding");
  if (p.findingCount !== record.findings.length) return no("it was shown a different number of findings");
  if (!Number.isInteger(p.pullRequest) || p.pullRequest <= 0) return no("it names no pull request");
  if (JSON.stringify(p.summary) !== JSON.stringify(solAcceptSummary(p))) return no("what Mason was shown does not match what the acceptance covers");
  const reason = String(approval.reason ?? "").trim();
  if (reason.length < 3 || BREAK_RE.test(reason)) return no("it carries no usable reason");
  const issued = Date.parse(p.issuedAt);
  const deadline = Date.parse(p.expiresAt);
  const approved = Date.parse(approval.approvedAt);
  if (![issued, deadline, approved].every(Number.isFinite) || approved < issued || approved > deadline) return no("it has no usable time window");
  try { checkReply?.(approval.replyMark); }
  catch (e) { return no(`his reply could not be confirmed as his words alone (${e?.message || e})`); }
  return { ok: true, payload: p, reason, approvedAt: approval.approvedAt };
}

/** Central date (YYYY-MM-DD) of an ISO time; Mason works in Central time. */
export const centralDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso));

/**
 * The DECISION_LOG.md entry for a fully accepted run. Deterministic from the record and
 * the acceptances, so the proof writer can rebuild it and compare byte for byte.
 */
export function decisionLogEntry({ record, accepted }) {
  const pr = accepted[0].payload.pullRequest;
  const day = centralDay(accepted.map((a) => a.approvedAt).sort().at(-1));
  const head = String(record.head_sha).slice(0, 12);
  return [
    `## ${day} — #${pr}: Mason owner-accepted ${accepted.length} Sol finding(s) at \`${head}\``,
    "",
    `**Decision (Mason, owner-accepted by \`accept <code>\` reply, ${day}).** Sol's review of PR #${pr} at \`${head}\` ` +
      `(base \`${String(record.base_sha).slice(0, 12)}\`) found ${record.findings.length} BLOCKER/HIGH finding(s). ` +
      "Mason accepted each one as a business non-issue, so the PR may land without fixing them.",
    ...accepted.flatMap((a) => [
      `- Finding ${a.payload.finding.n} (${a.payload.finding.severity}): ${a.payload.finding.text}`,
      `  Mason's reason: ${a.reason} (ref ${String(a.payload.nonce).slice(0, 12)})`,
    ]),
    "**What this implies:** the owner-accepted Sol proof covers only that review plus the one commit that adds this entry. " +
      "Any later change on the Sol list needs a normal Sol review.",
    "",
    "",
  ].join("\n");
}

/** `log` with `entry` inserted before its first `## ` entry (newest first), LF line endings. */
export function insertDecisionEntry(log, entry) {
  const text = String(log).replace(/\r\n/g, "\n");
  const at = text.search(/^## /m);
  return at < 0 ? `${text.replace(/\n*$/, "\n\n")}${entry}` : `${text.slice(0, at)}${entry}${text.slice(at)}`;
}

/**
 * Every BLOCKER/HIGH of `record` must carry a valid acceptance, all for one pull request.
 * `readAcceptance(n)` returns the parsed acceptance file or null.
 * @returns {{accepted: object[]}|{problem: string}}
 */
export function collectAcceptances({ record, readAcceptance, checkReply }) {
  const accepted = [];
  for (const f of record.findings) {
    const r = verifySolAcceptance({ approval: readAcceptance(f.n), record, n: f.n, checkReply });
    if (!r.ok) return { problem: r.reason };
    accepted.push(r);
  }
  if (new Set(accepted.map((a) => a.payload.pullRequest)).size !== 1) return { problem: "the acceptances name different pull requests" };
  return { accepted };
}

/** The session-state folder of a checkout. */
export const stateDirOf = (root) => path.join(root, ".claude", "session-state");
