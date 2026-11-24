#!/usr/bin/env node
// UserPromptSubmit half of Mason's owner approval (owner-approval-lib.mjs;
// Mason 2026-10-09: replaces Windows Hello so he can approve from his phone;
// 2026-10-13: a plain "I approve" is enough).
//   - His WHOLE message is `yes` or `I approve` (or `approve`, `approved`, `yes I approve`)
//     right after this conversation showed a pending request's summary, or
//     `approve <6-digit code>`; whichever session built the request (Mason, 2026-11-23:
//     it must carry to the merge captain), but another session's request only right after
//     this conversation showed its summary word for word, whatever the reply's form
//     (scripts/owner-approve-migration.mjs) → the request becomes an approval
//     good for 24 hours (2026-11-20), and the agent is told so.
//   - A plain `I approve` when this conversation neither built nor showed a
//     waiting request is ordinary chat: the hook says nothing.
//   - Any other message → nothing is approved.
//     A whole <system-reminder> block the app puts in front of his words is not
//     part of the message; a message with a reply on one of its lines but other
//     text as well is refused out loud, never silently (2026-10-20), except a
//     plain "I approve" line with no request waiting, which is ordinary chat.
//   - Every message leaves a marker that this session's messages reach this hook;
//     without it the request script warns that his reply must come from another conversation.
// Claude Code runs this on each message sent into a session. Nothing stops an
// agent running it by hand with a made-up message; that is the deliberate
// forgery Mason accepted as the residual (owner-approval-lib.mjs header).

import { readFileSync } from "node:fs";
import {
  approvalAttemptIn, approvalCodeFromReply, isPlainApprovalReply, lastAgentMessageText, ownerRequestDirs, recordPromptHookSeen, recordReplyApproval, replyMark,
  replyWithoutReminders, repositoryCheckouts, resolvePlainReply,
} from "./owner-approval-lib.mjs";
import { OWNER_SOL_SKIP_PURPOSE, acceptAttemptIn, acceptFromReply, skipFromReply } from "./sol-accept-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  }
  process.exit(0);
}

let payload;
try { payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }
// Every message, approval or not: proof for the request script that messages in
// this session reach this hook (some sessions never run it, 2026-10-20).
const ownDirs = ownerRequestDirs([payload?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]);
try { recordPromptHookSeen({ dirs: ownDirs, sessionId: payload?.session_id }); }
catch { /* a missing marker only makes the request script refuse */ }

// Where a request he answers may be: every checkout of this repository, so his reply in the
// conversation he is talking to counts for a request a merge captain built elsewhere (Mason,
// 2026-11-23). Only listed when a message looks like an answer, and once per message.
let listed = null;
const replyDirs = () => (listed ??= ownerRequestDirs([payload?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd(),
  ...repositoryCheckouts(payload?.cwd || process.cwd())]));

// The app's reminder block in front of his words is not part of his reply (2026-10-20).
const reply = replyWithoutReminders(payload?.prompt);
const readShown = () => lastAgentMessageText(payload?.transcript_path, reply);

// `accept <code> <reason>`: Mason accepts ONE Sol finding (sol-accept-lib.mjs, 2026-11-10).
const accept = acceptFromReply(reply);
if (accept || acceptAttemptIn(reply)) {
  if (!accept) {
    emit("SOL FINDING NOT ACCEPTED — Mason's message had an accept line, but other text came with it. Nothing was accepted. " +
      "Ask him to send accept <code> followed by his reason as a message of its own, on one line.");
  }
  let res;
  try {
    res = recordReplyApproval({
      code: accept.code, dirs: replyDirs(), reply,
      sessionId: payload?.session_id, form: "accept", reason: accept.reason, readMark: () => replyMark(payload?.transcript_path, reply),
    });
  } catch (error) {
    res = { ok: false, reason: `the approval hook failed (${error?.message || error})` };
  }
  if (!res.ok) emit(`SOL FINDING NOT ACCEPTED — Mason replied "${reply.trim().slice(0, 60)}", but ${res.reason}. Nothing was accepted. Tell him in one line.`);
  const p = res.payload;
  emit(`SOL FINDING ACCEPTED — Mason accepted finding ${p.finding.n} of ${p.findingCount} on PR #${p.pullRequest} ` +
    `(head ${String(p.prHead).slice(0, 12)}) with the reason "${accept.reason}". ` +
    "Once every BLOCKER/HIGH of that Sol run is accepted: node scripts/owner-accept-sol-finding.mjs --log, commit only the one file it writes, " +
    "then node scripts/write-codex-push-proof.mjs --carry-owner-accepted.");
}

// `skip` / `skip 1 3` / `I don't want that`: Mason skips the Sol findings the agent's last
// message listed, in plain words with no code (Mason, 2026-11-21; sol-accept-lib.mjs).
// With no skip request waiting in this session it is ordinary chat and stays silent.
const skip = skipFromReply(reply);
if (skip) {
  let which;
  let res;
  try {
    const dirs = replyDirs();
    which = resolvePlainReply({
      dirs, ownDirs, sessionId: payload?.session_id, purposes: [OWNER_SOL_SKIP_PURPOSE], readShown,
    });
    if (which.ok) {
      res = recordReplyApproval({
        code: which.code, dirs, reply, sessionId: payload?.session_id, form: "skip", skip, readShown,
        readMark: () => replyMark(payload?.transcript_path, reply),
      });
    }
  } catch (error) {
    res = { ok: false, reason: `the approval hook failed (${error?.message || error})` };
  }
  // No skip request waiting, or one waiting that his last-shown message was not (so nothing
  // was recorded) while the reply is also a plain migration approval: not ours. Fall through,
  // so a plain `yes` still reaches the migration approval below (Codex P1/P2, #2199).
  if (res || (!which?.silent && !isPlainApprovalReply(reply))) {
  if (!res?.ok) {
    emit(`SOL FINDINGS NOT SKIPPED — Mason replied "${reply.trim().slice(0, 60)}", but ${res?.reason || which?.reason || "no skip request was found"}. ` +
      "Nothing was skipped. Tell him in one line; if he still wants to skip, run node scripts/owner-accept-sol-finding.mjs again " +
      "and make its summary, exactly as printed, the whole last message of your turn.");
  }
  const p = res.payload;
  emit(`SOL FINDINGS SKIPPED — Mason skipped finding(s) ${res.selected.join(", ")} of ${p.findingCount} on PR #${p.pullRequest} ` +
    `(head ${String(p.prHead).slice(0, 12)}). Acknowledge it in one line and carry on without asking again. ` +
    "Once every BLOCKER/HIGH of that Sol run is skipped or fixed: node scripts/owner-accept-sol-finding.mjs --log, commit only the one file it writes, " +
    "then node scripts/write-codex-push-proof.mjs --carry-owner-accepted, then keep landing.");
  }
}
let code = approvalCodeFromReply(reply);
const plain = !code && isPlainApprovalReply(reply);
// Not a whole reply, but one of its lines is: say it did not count rather than
// stay silent, so an approval is never lost without a word (2026-10-20). A plain
// "I approve" with nothing waiting in this session stays ordinary chat.
// The note's own lines are not his words, so they are never read as an attempt (CodeRabbit, PR #979).
const attempt = !code && !plain ? approvalAttemptIn(reply) : null;
if (!code && !plain && !attempt) emit();
const said = (attempt ? attempt.line : reply.trim()).slice(0, 40);

// Output happens only outside this try: under prompt-router.mjs process.exit
// throws, and a catch here would turn a clean exit into a failure.
let which = null;
let result;
let waiting = attempt?.kind === "code";
try {
  const dirs = replyDirs();
  if (attempt?.kind === "plain") waiting = !resolvePlainReply({ dirs, ownDirs, sessionId: payload?.session_id, readShown: () => "" }).silent;
  if (plain) {
    which = resolvePlainReply({ dirs, ownDirs, sessionId: payload?.session_id, readShown });
    if (which.ok) code = which.code;
  }
  // readMark: where his reply lands in the transcript. The apply reads it back there
  // and refuses if a picture or file came with it (Codex P1, PR #900).
  if (code) {
    result = recordReplyApproval({
      code, dirs, reply, sessionId: payload?.session_id, readShown, readMark: () => replyMark(payload?.transcript_path, reply),
    });
  }
} catch (error) {
  result = { ok: false, reason: `the approval hook failed (${error?.message || error})` };
}

if (attempt && !result) {
  if (!waiting) emit();
  emit([
    `OWNER APPROVAL NOT RECORDED — Mason's message contained "${said}", but other text came with it, so it was not those words alone. Nothing was approved.`,
    "If he meant to approve the waiting database change, ask him to send the reply again as a message of its own: " +
      "only approve followed by the reference number (or I approve right after the request). Do not take this message as his approval.",
  ].join("\n"));
}

if (!result && which?.silent) emit();
if (!result) {
  emit([
    `OWNER APPROVAL NOT RECORDED — Mason replied "${said}", but ${which?.reason || "no request was found"}. Nothing was approved.`,
    "If he meant to approve the waiting database change, show him its request again: a reply containing ONLY its summary, exactly " +
      "as printed (no bold, code or quote marks). Anything you write in the same reply joins that message, so say it before a tool " +
      "call (for example, re-run the script) instead. Make it the last message of your turn and ask him to reply I approve. If it is refused again, ask him " +
      "to reply approve followed by the reference number instead, which names the request outright. Do not take this " +
      "message as his approval of anything else without checking what he meant.",
  ].join("\n"));
}

if (!result.ok) {
  emit([
    `OWNER APPROVAL NOT RECORDED — Mason replied "${said}", but ${result.reason}. Nothing was approved.`,
    "Tell him in one line. If he still wants the change, run node scripts/owner-approve-migration.mjs again for a fresh request " +
      "and make its summary, exactly as printed, the whole last message of your turn; his reply then counts in this conversation.",
  ].join("\n"));
}

if (result.kind === "selftest") {
  emit(
    `OWNER APPROVAL TEST PASSED — the reply "${said}" in this session reached the approval hook and was recorded ` +
    `(${result.file}). Approving by chat reply works from where he sent it. Nothing was approved.`);
}

const p = result.payload;
emit([
  `OWNER APPROVAL RECORDED — the reply "${said}" in this session approved ${p.migration} (pull request ` +
    `#${p.pullRequest}). It works once, for the next 24 hours, for that exact file (the PR head may move; the SQL may not).`,
  p.sessionId === payload?.session_id
    ? `Apply it now: node scripts/apply-migration-file.mjs supabase/migrations/${p.migration}.sql (dry run), then again with --confirm.`
    : "Another session built this request: tell that session (or the merge captain) it is approved, with SendMessage if you can; any session may apply it.",
  ...(result.requestLeft ? ["(The used request file could not be removed; it is harmless and needs no action.)"] : []),
].join("\n"));
