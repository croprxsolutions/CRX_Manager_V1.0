// PR Follow-ups section (Mason, 2026-11-09).
//
// Mason could never tell, after a merge, whether work had been put off. Reading the
// conversation afterwards misses deferrals made in another session or lost to a
// summary (Sol, 2026-11-09), so each PR records them when they are decided: a
// "## Follow-ups" section whose every line is "None" or names the durable home of
// the deferred work (a GitHub issue `#123` or a known issue `KI-12`). Both merge
// gates refuse a PR into a gated base without it; the /ship close-out reads it.
// Taha's own PRs are his (.claude/commands/ship.md › Taha's PRs).

// Same login as migration-landing-gate-lib's TAHA_LOGIN; not imported, so the Codex
// guard does not load that whole lib (and its imports) at startup.
const TAHA_LOGIN = "tahakhanabdalli";

// Matched on the raw line: up to 3 leading spaces, as Markdown renders a heading (4+ is code).
const HEADING = /^ {0,3}#{2,4}[ \t]+follow-?ups[ \t]*:?[ \t]*#*[ \t]*$/i;
const ANY_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
// Existence of the issue is checked by the /ship close-out, not here (no network in this rule).
const HOME = /(?:^|[^\w&])#\d+\b|\bKI-\d+\b|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+\b/i;

// The section's lines, or null when the body has no Follow-ups heading.
// Only what GitHub renders counts: hidden HTML comments and fenced code blocks are dropped (Luna, 2026-11-09).
function renderedLines(body) {
  const out = [];
  let fence = null;
  for (const line of String(body ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      // A closing fence is the marker alone, at least as long as the opener.
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) {
      fence = marker[1];
    } else {
      out.push(line);
    }
  }
  return out;
}

export function followUpLines(body) {
  const lines = renderedLines(body);
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start < 0) return null;
  const out = [];
  let blank = false;
  for (const raw of lines.slice(start + 1)) {
    if (ANY_HEADING.test(raw)) break;
    if (!raw.trim()) { blank = true; continue; }
    // A paragraph after a blank line (e.g. the "Generated with" footer) is not part of the list.
    if (blank && out.length && !/^\s*(?:[-*+]|\d+[.)])\s/.test(raw)) break;
    const text = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "").trim();
    if (text) out.push(text);
  }
  return out;
}

// null when the PR may merge; otherwise the reason it may not.
export function followUpsProblem(pullRequest) {
  if (String(pullRequest?.author?.login ?? "").trim().toLowerCase() === TAHA_LOGIN) return null;
  if (typeof pullRequest?.body !== "string") return "GitHub did not return the PR description, so its Follow-ups section cannot be checked (fail closed).";
  const lines = followUpLines(pullRequest.body);
  if (lines === null) return "the PR description has no `## Follow-ups` section.";
  if (lines.length === 0) return "the `## Follow-ups` section is empty; write `- None` if nothing was put off.";
  // Only a bare "None" is the sentinel; "None yet, fix later" is untracked work (Codex App P2, #1696).
  const isNone = (line) => /^none[.!]?$/i.test(line);
  if (lines.some(isNone) && lines.length > 1) {
    return "the `## Follow-ups` section says None but also lists items; keep one or the other.";
  }
  const homeless = lines.filter((line) => !isNone(line) && !HOME.test(line));
  if (homeless.length) {
    return `these Follow-ups lines name no issue (#123) or known issue (KI-12) to hold the work: ${homeless.map((l) => JSON.stringify(l.slice(0, 80))).join("; ")}.`;
  }
  return null;
}

export function followUpsDenial(prefix, selector, problem) {
  const n = selector || "<number>";
  return (
    `${prefix}: PR ${n} cannot merge yet: ${problem}\n\n` +
    "Every PR lists what it put off, so the close-out after merge can tell Mason whether work remains " +
    "(.claude/commands/ship.md Step 8 item 8). Add to the PR description:\n" +
    "  ## Follow-ups\n" +
    "  - None\n" +
    "or one line per deferred item naming where it lives, e.g. `- #1700 tighten the X check` or `- KI-104 ...`. " +
    "Open the issue first (`gh issue create`) if it has no home yet. Then: " +
    `\`gh pr edit ${n} --body-file <file>\` and retry the merge.`
  );
}
