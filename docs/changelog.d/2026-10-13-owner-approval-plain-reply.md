## 2026-10-13 — A parked migration is approved with a plain "I approve"

**Why.** The day after the chat-reply approval landed (PR #894), Mason asked for less: "can we make it
even simpler than that? … I just want to say I approve and that's good enough." The 6-digit code he had
to copy tied his reply to one request. That binding now comes from what the agent showed him, so he
no longer types anything but the approval.

**What changed.**
- `.claude/hooks/owner-approval-lib.mjs`:
  - `isPlainApprovalReply` accepts a WHOLE message of `I approve`, `approve`, `approved`, `yes I
    approve` or `I approve it`, case-insensitive, with a trailing `.`/`!`. A bare "yes", "go", "ok", a
    question, a negation, a longer sentence, a quote, inline code, or a peer/task envelope never matches.
  - `lastAgentMessageText` reads the session transcript the hook receives (`transcript_path`, last
    32 MB) and returns the text of the agent's FINAL main-thread message before Mason's reply. Claude
    Code stores one message as several entries sharing a message id, so these are grouped.
    - A request shown earlier in the same turn, before a later question, does not count (Luna round 2).
    - Any message after the agent's makes the result empty. That covers one of Mason's, image-only
      included, and a notification.
    - Tool output, subagent text and Claude Code's own `isMeta` entries do not count.
    - His current message is skipped whether or not it has been written yet.
    - It throws, so nothing is approved, when the transcript is unreadable, when any damaged or
      half-written line lies in what is scanned, when an assistant entry has no message id, or when
      the message's start is not in the part read (Luna rounds 1-2).
  - `resolvePlainReply` finds the live requests this session built (pending, unexpired, code not
    retired). With none, it is ordinary chat and the hook stays silent. An unreadable folder or
    request file is reported, never taken as "nothing waiting" (Luna round 2). Otherwise exactly one
    of them must have its reference number in the agent's last message, labelled `Reference`
    (markdown allowed between). The same digits starting or inside another number or identifier, such
    as `482913-4`, `482913_4` or `482913.1`, never count (Luna rounds 1-2). A request shown earlier,
    two shown at once, or an unreadable transcript approves nothing.
  - The summary now ends with "reply: I approve" and "(Reference <code>. You don't need to type it.)".
- `.claude/hooks/owner-approval-prompt.mjs`:
  - Handles both reply forms, then records through the unchanged `recordReplyApproval`. Session
    binding, code retirement, the atomic write and single use are all unchanged.
  - All output happens outside its `try`, because `process.exit` throws under `prompt-router.mjs`.
- `scripts/owner-approve-migration.mjs` and the `migration-apply-lib.mjs` refusal text tell the agent:
  - show the summary with its Reference line;
  - ask nothing else in that message;
  - show the request again if anything else is said first.
- `verifyOwnerApproval` and the apply gate are unchanged: a plain-reply approval is the same file,
  checked the same way.
- Docs: `OWNER_PLAYBOOK.md`, `DECISION_LOG.md` (2026-10-13 entry), `agent-guardrails.md`,
  `DATABASE_CHANGE_CHECKLIST.md`, `DEPLOYMENT.md`, `.claude/commands/ship.md` and the three migration
  skills, with their `.agents` mirrors.

**Residual risk.**
- Unchanged from 2026-10-09: an agent that deliberately fakes the approval is not stopped.
- New and small: if an agent shows a request and also asks something else in the same message,
  "I approve" approves the request. The scripts tell agents never to bundle.

**Proof.**
- `owner-approval-lib.test.mjs`: 245 assertions (151 before). They cover:
  - every plain-reply form, and 21 messages that must not count;
  - the transcript reader on Claude Code's entry shapes: tool calls, tool results, subagents, `isMeta`,
    an image-only message, damaged and half-written lines, a turn longer than the part read, a missing file;
  - the reference label: digits inside another number or identifier, or without the label, do not count;
  - which request is chosen;
  - the hook as a real process through `prompt-router.mjs`, including "I approve" answering another
    question, with no transcript, from another conversation, and twice.
- Breaking the reference-number check, or the previous-message boundary, makes the suite fail.
- Luna round 1 found 2 BLOCKERs and 2 HIGHs (an image-only message, damaged lines, unlabelled digits,
  a truncated turn). All four fixed, each with a test.
- Luna round 2 found 4 HIGHs, 1 MED and 1 LOW.
  - Fixed, each with a test:
    - a request shown earlier in the turn;
    - a half-written last line;
    - no boundary in the whole transcript;
    - compound identifiers;
    - an unreadable folder.
  - Refuted: an earlier identical "I approve" with nothing between it and the request. Both
    messages answer that same request, so approving matches his intent either way. A test records
    this behavior.
- The transcript reader was also run against this session's real transcript, cut at Mason's own
  "Approve 301239". It returned exactly the agent's preceding message, both before and after his
  message was written.
