// edit-splice-lib.mjs — shared, line-ending-safe Edit/MultiEdit simulation for
// PreToolUse guards that judge the FULL post-edit file rather than the fragment.
//
// THE CRLF BUG (2026-08-26, PR #401 branch): guards simulated an Edit with an
// exact `disk.split(old_string).join(new_string)`. On a Windows worktree with
// core.autocrlf the on-disk file is CRLF while the harness hands the hook
// LF-normalized old_string/new_string, so the splice silently no-oped and the
// guard evaluated the UNEDITED file. Deadlock: the guard demands a marker line
// (`-- caller-analysis:` / `-- idempotency-body-check: exempt`) but denies the
// very Edit that adds it, because it never sees the edit land.
//
// Fix: normalize BOTH sides to LF before splicing. Guards only ANALYZE the
// result (regex/lexer scans) and never write it back to disk, so wholesale
// LF-normalization is safe — and it keeps every index self-consistent for the
// length-preserving maskers that slice content by index.

import { existsSync, readFileSync } from "node:fs";

/** Normalize CRLF (and lone CR) to LF. */
export function toLF(s) {
  return String(s).replace(/\r\n?/g, "\n");
}

/**
 * Apply an Edit's old_string/new_string — or a MultiEdit's edits array, in
 * order — to on-disk content, line-ending-safely. Returns the LF-normalized
 * post-edit text for guard analysis. Matches every occurrence (a conservative
 * superset of the harness's replace semantics: a guard judging more replaced
 * text than the harness will apply can only see MORE of the change, not less).
 */
export function applyEditsForAnalysis(diskText, toolInput) {
  let text = toLF(diskText);
  const applyOne = (oldStr, newStr) => {
    if (typeof oldStr !== "string" || oldStr.length === 0 || typeof newStr !== "string") return;
    text = text.split(toLF(oldStr)).join(toLF(newStr));
  };
  if (Array.isArray(toolInput?.edits)) {
    for (const e of toolInput.edits) applyOne(e?.old_string, e?.new_string);
  } else {
    applyOne(toolInput?.old_string, toolInput?.new_string);
  }
  return text;
}

/**
 * The text a content guard should judge for a Write / Edit call: the Write
 * `content`, or for an Edit the full post-edit file spliced from disk followed by
 * the fragment (`new_string`, or every MultiEdit `edits[i].new_string`), so the new
 * text is judged even when the splice cannot place it (the harness may match an
 * old_string this exact splice misses). An unreadable file judges the fragment
 * alone. LF-normalized.
 * Used by env-guard only; the other content guards keep `content || new_string`
 * (KI-78, accepted 2026-11-02).
 */
export function judgedContent(filePath, toolInput) {
  const input = toolInput || {};
  if (typeof input.content === "string") return toLF(input.content);
  const isFragmentEdit = typeof input.old_string === "string" || Array.isArray(input.edits);
  if (!isFragmentEdit) return "";
  const fragments = Array.isArray(input.edits)
    ? input.edits.map((e) => (typeof e?.new_string === "string" ? e.new_string : "")).join("\n")
    : (typeof input.new_string === "string" ? input.new_string : "");
  try {
    if (filePath && existsSync(filePath)) {
      return applyEditsForAnalysis(readFileSync(filePath, "utf8"), input) + "\n" + toLF(fragments);
    }
  } catch {
    /* fall through to the fragments */
  }
  return toLF(fragments);
}
