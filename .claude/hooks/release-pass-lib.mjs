// Mason's release pass (Mason, 2026-11-20: "I want to prior authorize a session to take PRs live while I
// sleep ... I give prior authorization and the agent does what is best"). He starts a message with
//   `ship the release`           → this session may take the open weekly release (release/next) live,
//   `go live #2105`              → ...or that hotfix PR (several numbers allowed),
//   `stop the release`           → every pass this session holds is withdrawn.
// A pass lasts 24 hours, covers only the session he said it in, and replaces Taha's merge and his
// `Ready to merge: <sha>` comment for those PRs. It is bound to the PR, not its head: fixes the agent
// makes afterwards don't void it (Mason, 2026-11-20: "if agent changes things that is for good
// shouldn't hold us up"). It never covers deletions: each destructive migration still needs his own
// `yes` (owner-approval-lib.mjs). Taha's 4-hour hold and every check, Sol and proof gate still apply.
// Like every chat-reply record here, an agent could forge the file by hand; Mason accepted that
// residual (owner-approval-lib.mjs header).

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mayExist, usableSkipSessionId } from "./coderabbit-skip-lib.mjs";

export const RELEASE_PASS_PURPOSE = "crx-release-pass-v1";
export const RELEASE_PASS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 4096;
const MAX_PRS = 5;

const SHIP_RE = /^\s*(?:ship|release)\s+(?:the\s+)?(?:release|it\s+live)\b|^\s*ship\s+release\b/i;
const GO_LIVE_RE = /^\s*go\s+live\b([^\n]*)/i;
const STOP_RE = /^\s*(?:stop|hold|cancel)\s+(?:the\s+)?(?:release|going\s+live)\b/i;

/** What his message asks, or null. Only the START of the message counts, like `skip coderabbit`. */
export function releasePassCommand(reply) {
  const text = String(reply ?? "");
  if (STOP_RE.test(text)) return { kind: "cancel" };
  if (SHIP_RE.test(text)) return { kind: "pass", release: true, pullRequests: [], said: text.trim().split(/\r?\n/)[0] };
  const m = GO_LIVE_RE.exec(text);
  if (!m) return null;
  const pullRequests = [...new Set([...m[1].matchAll(/#(\d{1,7})(?!\d)/g)].map((x) => Number(x[1])))].filter((n) => n > 0);
  if (!pullRequests.length) return { kind: "unnamed" };
  return { kind: "pass", release: false, pullRequests: pullRequests.slice(0, MAX_PRS), said: text.trim().split(/\r?\n/)[0] };
}

export const releasePassFileName = (sessionId) => `release-pass-${sessionId}.json`;

/** Read this session's live pass from any of `dirs`, or null (missing, malformed, expired, future-dated). */
export function findReleasePass({ dirs, sessionId, now = Date.now(), stat = lstatSync }) {
  if (!usableSkipSessionId(sessionId)) return null;
  for (const dir of dirs || []) {
    const file = path.join(dir, releasePassFileName(sessionId));
    let data;
    try {
      const info = stat(file);
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch { continue; }
    if (data?.purpose !== RELEASE_PASS_PURPOSE || data?.sessionId !== sessionId) continue;
    if (typeof data.release !== "boolean" || !Array.isArray(data.pullRequests) || !data.pullRequests.every((n) => Number.isInteger(n) && n > 0)) continue;
    const recorded = Date.parse(data.recordedAt);
    const expires = Date.parse(data.expiresAt);
    if (!Number.isFinite(recorded) || !Number.isFinite(expires) || recorded > now || expires - recorded > RELEASE_PASS_MAX_AGE_MS || now >= expires) continue;
    return data;
  }
  return null;
}

/** Record (or widen) this session's pass. Returns the saved pass, or null when nothing could be written. */
export function recordReleasePass({ dirs, sessionId, release, pullRequests, said, now = Date.now() }) {
  if (!usableSkipSessionId(sessionId)) return null;
  const old = findReleasePass({ dirs, sessionId, now });
  const payload = {
    purpose: RELEASE_PASS_PURPOSE,
    sessionId,
    release: Boolean(release || old?.release),
    pullRequests: [...new Set([...(old?.pullRequests ?? []), ...(pullRequests ?? [])])].slice(0, MAX_PRS * 2),
    said: String(said ?? "").slice(0, 200),
    recordedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RELEASE_PASS_MAX_AGE_MS).toISOString(),
  };
  let wrote = 0;
  for (const dir of dirs || []) {
    try {
      if (!existsSync(path.dirname(dir))) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, releasePassFileName(sessionId)), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      wrote++;
    } catch { /* another folder may still take it */ }
  }
  return wrote ? payload : null;
}

/** `stop the release`: remove this session's pass everywhere; stillLive when any copy may remain. */
export function withdrawReleasePass({
  dirs, sessionId, remove = (f) => rmSync(f, { force: true }), exists = (f) => mayExist(f),
  read = (f) => readFileSync(f, "utf8"), write = (f, s) => writeFileSync(f, s),
}) {
  if (!usableSkipSessionId(sessionId) || !Array.isArray(dirs) || !dirs.length) return { stillLive: true };
  let stillLive = false;
  for (const dir of dirs) {
    const file = path.join(dir, releasePassFileName(sessionId));
    try { remove(file); } catch { /* re-checked below */ }
    if (!exists(file)) continue;
    // Couldn't delete it: overwrite it with something findReleasePass refuses, so the gates see no pass.
    try { write(file, "withdrawn"); } catch { /* re-checked below */ }
    let content = null;
    try { content = read(file); } catch { /* unreadable: can't confirm */ }
    if (content !== "withdrawn") stillLive = true;
  }
  return { stillLive };
}

/**
 * Does this session's pass cover merging this PR? `base`/`headRef` are GitHub's; `number` the PR number.
 * Covered: the release PR (release/next into main) under `ship the release`, a PR named by `go live #n`,
 * and the back-merge (main into staging) that follows either, so staging isn't left behind.
 */
export function releasePassCovers(pass, { base, headRef, number }) {
  if (!pass) return false;
  const named = Number.isInteger(Number(number)) && pass.pullRequests.includes(Number(number));
  if (base === "main" && headRef === "release/next") return pass.release || named;
  if (base === "main" && /^hotfix\/[^/]+$/.test(String(headRef || ""))) return named;
  if (base === "staging" && headRef === "main") return pass.release || pass.pullRequests.length > 0;
  return false;
}
