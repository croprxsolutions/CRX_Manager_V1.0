// TAHA'S LANES (Mason to Taha in Slack, 2026-11-22): until Dec 15 our agents
// never merge into staging a PR that changes Taha's areas (quotes, bookings,
// purchasing holds, chemical invoices and billing), whatever OK line the PR has.
// Field billing (field invoices, spray jobs, blend tickets) stays Mason's.
// #1980 and #1989 merged after Taha asked; a written note did not stop them.
//
// Mason can still let ONE named PR through: the merge refusal issues a 6-digit
// code for that PR at its current head, and his chat message `taha override #<PR> <code>`
// (taha-lane-prompt.mjs) turns it into a 24-hour override for that PR at that head
// only: a later push needs a new code (Taha's review of #2303). When it is used the
// gate itself tells Taha on the PR, or refuses. An agent cannot mint a
// working code: only a request this guard wrote counts. Same accepted residual as
// coderabbit-skip-lib.mjs: an agent that runs the prompt hook by hand with a forged
// message gets through; this is an honest-mistake net, not a security boundary.
//
// The Codex production gate imports this at startup: Node built-ins and codex-push-lib only.

import { randomInt } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ghApiRepoPath } from "./codex-push-lib.mjs";

// End of Dec 15 in Central time (06:00 UTC on Dec 16). After it the block is off.
export const TAHA_LANE_UNTIL_MS = Date.UTC(2026, 11, 16, 6, 0, 0);
export const TAHA_LANE_CODE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TAHA_LANE_OVERRIDE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FILES = 250; // GitHub's compare can stop short silently; at this size, fail closed.
const MAX_BYTES = 4096;

// Words in a path that put a file in Taha's lane, and words that keep it in Mason's field billing.
const LANE_WORDS = new Set([
  "quote", "quotes", "booking", "bookings", "hold", "holds", "purchasing",
  "invoice", "invoices", "invoicing", "payment", "payments", "prepay", "prepayment", "prepayments",
  "credit", "credits", "statement", "statements", "billing", "commission", "commissions",
  "month", "receivable", "tax", "discount", "booked", "aging",
]);
// Field billing is Mason's. "field" counts only when it names that work (field app, field invoice…):
// "Fields" alone means data fields (invoiceRowPdfFields) and stays in the lane (Codex P2, #2303).
const FIELD_WORDS = new Set(["spray", "blend", "application", "applications", "applicator", "job", "jobs"]);
const AFTER_FIELD = new Set(["app", "application", "applications", "invoice", "invoices", "billing", "split", "splits", "stop", "job", "jobs"]);
const isFieldBilling = (words) => words.some((w, i) => FIELD_WORDS.has(w) || (w === "field" && AFTER_FIELD.has(words[i + 1])));
// Chemical-sale bill splits (billSplitLock, LineBillSplit) are billing too; vendor bills are not (Codex P1, #2303).
const isBill = (words) => words.includes("bill") && !words.includes("vendor");

const wordsOf = (name) => String(name)
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(Boolean);

// Screens that run chemical-sale billing without a billing word in their name (Codex P1, #2303).
// shortcut: names, not code, decide the lane; add a file here when review finds another billing entry point.
// Taha's review of #2303 named the chemical-side screens below; Mason chose this short list over refuse-by-default (2026-11-22).
const LANE_FILE_PREFIXES = [
  "src/pages/OrderDetail.", "src/pages/NewOrder.", "src/pages/Orders.", "src/pages/CustomerDetail.",
  "src/pages/CustomerTransactionReview.", "src/pages/ARaging.", "src/lib/arAging.", "src/lib/reconciliation.",
  "src/pages/Reports.", "src/pages/SalesReports.", "src/pages/FinancialDashboard.", "src/components/reports/",
  "src/components/orders/SaleMoneySummary.", "src/components/orders/WhoPaysCard.",
];
// Quote, hold, prepay and booking words win over a field word (prepay_application_rpcs, release_hold_reject_job).
const STRONG_LANE_WORDS = new Set(["quote", "quotes", "hold", "holds", "prepay", "prepayment", "prepayments", "booking", "bookings", "booked"]);

// The block's own wiring: a PR that edits or unhooks it needs Mason's code too (Taha's review of #2303).
const BLOCK_FILES_RE = /^(?:\.claude\/hooks\/(?:taha-lane-[\w.-]+|pr-merge-guard|merge-guard-launcher|prompt-router|sol-risk-lib)\.mjs|\.codex\/hooks\/production-action-guard\.mjs|\.claude\/settings\.json|\.codex\/hooks\.json)$/i;

/** True when this changed file is app or database code in Taha's lane (and not field billing), or the block itself. */
export function isTahaLanePath(name) {
  const file = String(name ?? "").replace(/\\/g, "/");
  if (BLOCK_FILES_RE.test(file)) return true;
  if (!/^(?:src|supabase)\//i.test(file)) return false;
  if (LANE_FILE_PREFIXES.some((p) => file.startsWith(p))) return true;
  const words = wordsOf(file);
  if (isFieldBilling(words) && !words.some((w) => STRONG_LANE_WORDS.has(w))) return false;
  return isBill(words) || words.some((w) => LANE_WORDS.has(w));
}

/**
 * Why this merge is refused, or null. `files`: GitHub compare entries
 * ({filename, previous_filename}) or null when they could not be read (refuses).
 */
export function tahaLaneProblem({ files, now = Date.now() }) {
  if (now >= TAHA_LANE_UNTIL_MS) return null;
  if (!Array.isArray(files)) return { files: [], reason: "its changed files could not be read, so it can't be shown to stay out of Taha's areas" };
  if (files.length >= MAX_FILES) return { files: [], reason: `${files.length} changed files may be a cut-short list` };
  const hits = [];
  for (const entry of files) {
    for (const name of [entry?.filename, entry?.previous_filename]) {
      if (typeof name === "string" && isTahaLanePath(name) && !hits.includes(name)) hits.push(name);
    }
  }
  return hits.length ? { files: hits, reason: `it changes Taha's areas (${hits.slice(0, 5).join(", ")}${hits.length > 5 ? `, and ${hits.length - 5} more` : ""})` } : null;
}

/**
 * The PR's changed files ({filename, previous_filename}), read the same way as
 * stagingDestructiveProblem (sol-risk-lib.mjs), or null when unreadable.
 */
export function prFilesOnGitHub({ repo, gh, number }) {
  const repoPath = ghApiRepoPath(repo);
  if (!repoPath || !Number.isInteger(number) || number < 1) return null;
  try {
    const rows = String(gh(["api", "--paginate", `${repoPath}/pulls/${number}/files?per_page=100`, "--jq", '.[] | [.status, .filename, (.previous_filename // "")] | @tsv']))
      .split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"));
    if (rows.some((r) => r.length < 2 || r.length > 3 || !r[1])) return null;
    return rows.map(([, filename, previous]) => ({ filename, previous_filename: previous || undefined }));
  } catch { return null; }
}

const usablePr = (n) => Number.isInteger(n) && n > 0;
const usableHead = (sha) => /^[0-9a-f]{40}$/i.test(String(sha ?? ""));
const requestName = (code) => `taha-lane-request-${code}.json`;
const overrideName = (pr) => `taha-lane-override-pr${pr}.json`;

function readSmall(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch { return null; }
}
const live = (data, maxAge, now) => {
  const issued = Date.parse(data?.issuedAt);
  const expires = Date.parse(data?.expiresAt);
  return Number.isFinite(issued) && Number.isFinite(expires) && issued <= now && expires - issued <= maxAge && now < expires;
};

/**
 * The code Mason types to let `pullRequest` at `headSha` through. Reuses a live
 * request for the same PR and head, else writes a new one to every folder in
 * `dirs`. null when none could be saved (the refusal then says so; the block holds).
 */
export function issueTahaLaneCode({ dirs, pullRequest, headSha, now = Date.now(), newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0") }) {
  if (!usablePr(pullRequest) || !usableHead(headSha)) return null;
  headSha = headSha.toLowerCase();
  for (const dir of dirs || []) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^taha-lane-request-\d{6}\.json$/.test(n)) continue;
      const data = readSmall(path.join(dir, n));
      if (data?.pullRequest === pullRequest && data?.headSha === headSha && live(data, TAHA_LANE_CODE_MAX_AGE_MS, now)) return data.code;
    }
  }
  const code = newCode();
  const payload = { pullRequest, headSha, code, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + TAHA_LANE_CODE_MAX_AGE_MS).toISOString() };
  let wrote = 0;
  for (const dir of dirs || []) {
    try {
      if (!existsSync(path.dirname(dir))) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, requestName(code)), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      wrote++;
    } catch { /* another folder may still take it */ }
  }
  return wrote ? code : null;
}

// The WHOLE message must be the command, naming the PR Mason means (a phone may capitalise it or add a period).
const COMMAND_RE = /^\s*taha\s+override\s+#(\d{1,7})\s+(\d{6})\s*[.!]?\s*$/i;
/** { pullRequest, code } when the whole message is `taha override #<PR> <code>`, else null. */
export const tahaOverrideCommand = (reply) => {
  const m = COMMAND_RE.exec(String(reply ?? ""));
  return m ? { pullRequest: Number(m[1]), code: m[2] } : null;
};
/** True when the message mentions the command but is not exactly it. */
export const tahaOverrideAttempt = (reply) => !tahaOverrideCommand(reply) && /\btaha\s+override\b/i.test(String(reply ?? ""));

/**
 * Turn Mason's code into a 24-hour override for the PR and head it was issued
 * for. The PR he named must be that PR. Returns { ok: true, payload } or { ok: false, reason }.
 */
export function recordTahaLaneOverride({ dirs, pullRequest, code, now = Date.now() }) {
  if (!/^\d{6}$/.test(String(code ?? ""))) return { ok: false, reason: "the code is not 6 digits" };
  if (!usablePr(pullRequest)) return { ok: false, reason: "the message names no PR" };
  let request = null;
  for (const dir of dirs || []) {
    const data = readSmall(path.join(dir, requestName(code)));
    if (data?.code === code && usablePr(data?.pullRequest) && usableHead(data?.headSha) && live(data, TAHA_LANE_CODE_MAX_AGE_MS, now)) { request = data; break; }
  }
  if (!request) return { ok: false, reason: `no live merge-block code ${code} was found (it may be mistyped, used, or more than 24 hours old)` };
  if (request.pullRequest !== pullRequest) return { ok: false, reason: `code ${code} was issued for #${request.pullRequest}, not #${pullRequest}` };
  const payload = { pullRequest: request.pullRequest, headSha: request.headSha, code, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + TAHA_LANE_OVERRIDE_MAX_AGE_MS).toISOString() };
  let wrote = 0;
  for (const dir of dirs || []) {
    try {
      if (!existsSync(dir)) continue;
      writeFileSync(path.join(dir, overrideName(request.pullRequest)), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      rmSync(path.join(dir, requestName(code)), { force: true });
      wrote++;
    } catch { /* another folder may still take it */ }
  }
  return wrote ? { ok: true, payload } : { ok: false, reason: "the override could not be saved" };
}

/** Mason's live override for this PR at exactly this head, or null. */
export function findTahaLaneOverride({ dirs, pullRequest, headSha, now = Date.now() }) {
  if (!usablePr(pullRequest) || !usableHead(headSha)) return null;
  for (const dir of dirs || []) {
    const data = readSmall(path.join(dir, overrideName(pullRequest)));
    if (data?.pullRequest === pullRequest && data?.headSha === headSha.toLowerCase() && live(data, TAHA_LANE_OVERRIDE_MAX_AGE_MS, now)) return data;
  }
  return null;
}

function markTahaTold({ dirs, override }) {
  for (const dir of dirs || []) {
    const file = path.join(dir, overrideName(override.pullRequest));
    try { if (existsSync(file)) writeFileSync(file, `${JSON.stringify({ ...override, tahaToldAt: new Date().toISOString() }, null, 2)}\n`, "utf8"); } catch { /* the next try posts again */ }
  }
}

/** Posts the PR comment that tells Taha. true only when GitHub took it. */
export function tellTahaOnGitHub({ repo, gh, pullRequest, body }) {
  const repoPath = ghApiRepoPath(repo);
  if (!repoPath || !usablePr(pullRequest)) return false;
  try {
    return /^\d+$/.test(String(gh(["api", "-X", "POST", `${repoPath}/issues/${pullRequest}/comments`, "-f", `body=${body}`, "--jq", ".id"])).trim());
  } catch { return false; }
}

/**
 * The merge gates' single call: null when the merge may go on, otherwise the
 * refusal text. With Mason's override for this PR and head, `tellTaha(body)`
 * must post the PR comment first (once per override); if it can't, the merge is refused.
 */
export function tahaLaneGate({ prefix, pullRequest, headSha, files, dirs, now = Date.now(), tellTaha = () => false, notice = () => {} }) {
  const problem = tahaLaneProblem({ files, now });
  if (!problem) return null;
  const override = findTahaLaneOverride({ dirs, pullRequest, headSha, now });
  if (override) {
    if (!override.tahaToldAt) {
      const body = `@TahaKhanAbdalli Mason's override of the Taha lane block was used for a merge attempt on this PR at \`${override.headSha}\` ` +
        `(his code ${override.code}, valid until ${override.expiresAt}). The other merge checks still apply, so this attempt may still be refused; ` +
        `the PR's own merged state is the record of whether it landed. It ${problem.reason}.`;
      if (!tellTaha(body)) {
        return `${prefix}: TAHA LANE BLOCK — Mason's override for #${pullRequest} is valid, but the PR comment telling Taha could not be posted, so the merge is refused. Retry the merge.`;
      }
      markTahaTold({ dirs, override });
    }
    notice(`${prefix}: TAHA LANE OVERRIDDEN BY MASON for #${pullRequest} at ${override.headSha}; Taha was told on the PR.\n`);
    return null;
  }
  const code = issueTahaLaneCode({ dirs, pullRequest, headSha, now });
  return `${prefix}: TAHA LANE BLOCK — #${pullRequest || "?"} is refused because ${problem.reason}. ` +
    "Until Dec 15 agents never merge in Taha's areas (quotes, bookings, purchasing holds, chemical invoices and billing) " +
    "or change this block, whatever OK line the PR has (Mason to Taha, 2026-11-22). Leave it for Taha: post a PR comment or a KI. " +
    (code
      ? `Only if Mason wants it merged anyway: tell him why in one line and ask him to send, as a message of its own: taha override #${pullRequest} ${code} ` +
        "(it covers this PR at its current commit only; a new push needs a new code)"
      : "The override code could not be saved, so only Taha can land it.");
}
