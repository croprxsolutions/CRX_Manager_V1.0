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
    - Only the bookkeeping records Claude Code writes after every turn are skipped. That list was
      measured on a real session transcript: `system`/`stop_hook_summary`, `last-prompt`,
      `custom-title`, `agent-name`, `atis-latch`, `pr-link`, `bridge-session`, `attachment`,
      `file-history-*`, and a `queue-operation` that carries no message or carries Mason's current
      message itself. A queued or withdrawn message that is anything else ends the scan, and so does
      a `summary` record, which current Claude Code does not write (Luna round 4).
    - The tail is read from one byte before the window, so a window starting exactly at a line keeps
      that line (Luna round 4).
    - Any other entry after the agent's message makes the result empty (Luna round 3). That covers a
      message of Mason's (image-only included), injected text such as a Stop hook's feedback, a
      notification, a compaction, an error or synthetic message, and an unknown record type.
    - Only messages the model wrote count; `isMeta`, API-error and `<synthetic>` assistant entries
      never do (Luna round 3).
    - Tool output, subagent text and Claude Code's own `isMeta` entries do not count.
    - His current message is skipped whether or not it has been written yet. When it is written, it
      must be those words alone: "I approve" sent with a picture or file refuses (Codex P1 on the PR).
  - His reply must be his words alone in every case (Codex P1, raised twice on the PR). Claude Code
    normally writes his message just AFTER the hook runs (measured on a real transcript), and the
    hook's input holds only his words, so:
    - `replyMark` (at the reply, for both `I approve` and `approve <code>`) records the transcript's
      size, or that his message is already the last one written, which is then checked at once.
      `recordReplyApproval` stores it in the approval; without it nothing is recorded.
    - `assertReplyAlone` (at the apply, the last check in `verifyOwnerApproval`) reads from that
      point: the first message there must be his reply, his words alone. If the agent's answer comes
      first, his reply must have been written and checked already. A picture or file, another
      message, a damaged or unfinished line, a missing or shorter transcript, or a malformed mark
      refuses the apply.
    - A whole `<system-reminder>` block Claude Code puts in front of his words is not his words. In
      all 57 multi-block messages on this machine such a block came first and whole.
    - It throws, so nothing is approved, when the transcript is unreadable, when any damaged or
      half-written line lies in what is scanned, when an assistant entry has no message id, or when
      the message's start is not in the part read (Luna rounds 1-2).
  - `resolvePlainReply` finds the live requests this session built (pending, unexpired, code not
    retired). With none, it is ordinary chat and the hook stays silent. An unreadable folder or
    request file is reported, never taken as "nothing waiting" (Luna round 2). Otherwise exactly one
    of them must be SHOWN in the agent's last message (`requestShownIn`, Luna round 4). Shown means
    all three of:
    - its `Reference <code>` line (markdown allowed between);
    - the `reply: I approve` line;
    - its migration's name (or the self-test line).

    A message that only cites an old reference while asking something else does not count. The same
    digits starting or inside another number or identifier never count, in any script: `482913-4`,
    `482913_4`, `482913.1`, `482913٧` (Luna rounds 1, 2 and 4). A request shown earlier, two shown at
    once, or an unreadable transcript approves nothing.
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
- New and small: the attachment check relies on Claude Code saving a picture or file in the same
  transcript entry as his words (or saving the picture without the words, which also refuses). That
  is how every message with a picture on this machine was saved.

**Proof.**
- `owner-approval-lib.test.mjs`: 313 assertions (151 before); `migration-apply-lib.test.mjs`: 299
  (297 before). They cover:
  - every plain-reply form, and 21 messages that must not count;
  - the transcript reader on Claude Code's entry shapes: tool calls, tool results, subagents, `isMeta`,
    an image-only message, "I approve" sent with a picture or file, damaged and half-written lines, a turn longer than the part read, a missing file;
  - reading his reply back at the apply: written after the hook or before it, as a text block, after
    a reminder block, with a picture or file, image only, another message first, never written,
    damaged or cut by the read, sent twice, and malformed marks; through the apply gate itself, an
    approval whose reply came with a picture is refused;
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
- Luna round 3 found 1 BLOCKER and 1 HIGH (skipped notification or unknown entries; metadata or
  synthetic assistant entries). Both fixed with the bookkeeping allow-list and the model-written
  check, each with tests.
- When a plain reply is refused, the hook tells the agent to fall back to `approve <reference>` if
  re-showing does not help, so Mason is never stuck.
- Luna round 4 found 2 BLOCKERs, 1 HIGH, 1 MED and 1 LOW:
  - a stale reference mention;
  - a queued message;
  - a `summary` record;
  - Unicode digits;
  - a boundary-aligned read window.

  That round reached `ship.md`'s three-round cap, so the work stopped and Mason chose: "fix and
  ship" (2026-10-13). All five are fixed with tests. Breaking the new "request shown" rule makes the
  suite fail. No further Luna round was run, by his choice; CodeRabbit and Sol review the final head.
- One unexplained crash of the test suite in 34 runs (33 passed). Its output was lost to a piped
  command, so the cause is not known.
- The transcript reader was also run against this session's real transcript, cut at Mason's own
  "Approve 301239". It returned exactly the agent's preceding message, both before and after his
  message was written.
- The read-back was replayed on a real session transcript (2026-10-13) with one of Mason's own
  replies, cut at every point the hook could have run between the agent's message and his: each
  was marked and read back fine. The same reply with a picture added was refused.
- After the first attachment fix, the Codex connector raised the same P1 again: that fix only
  covered a message already written. The read-back above is the full fix. Breaking the apply-time
  check, the attachment check, the "agent answered first" rule or the reminder-block rule makes the
  suites fail.
