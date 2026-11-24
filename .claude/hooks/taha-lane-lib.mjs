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
  // Taha's review of #2382 (HIGH 2): AR and month-end words; "write off" is matched as a pair in isLaneName.
  "ar", "monthly", "receivables", "writeoff", "writeoffs",
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
  return isLaneName(file);
}

function isFieldBillingName(name) {
  const words = wordsOf(name);
  return isFieldBilling(words) && !words.some((w) => STRONG_LANE_WORDS.has(w));
}

function isLaneName(name) {
  if (isFieldBillingName(name)) return false;
  const words = wordsOf(name);
  return isBill(words) || words.some((w, i) => LANE_WORDS.has(w) || (w === "write" && /^offs?$/.test(words[i + 1] ?? "")));
}

// Taha's functions whose names carry no lane word (Taha's review of #2382, HIGH 2: #2324 rebuilt
// _complete_delivery_authorized_impl, the step in front of the chemical-sale invoice). Prefixes, except the
// last two pieces, which may sit anywhere in the name. They win over a field word
// (_guard_credit_memo_application_immutable).
const TAHA_LANE_FUNCTIONS_RE = new RegExp("^(?:_?complete_delivery|_?start_and_complete_delivery|void_delivery|cancel_delivery|void_order|cancel_order" +
  "|update_order_items|price_order|apply_write_off|reverse_write_off|_lock_accounting_months|get_customer_balance|get_monthly_summary" +
  "|prevent_order_shares)(?=_|$)|^get_ar_|accounting_period|credit_memo", "i");
const isLaneFunction = (name) => TAHA_LANE_FUNCTIONS_RE.test(name) || isLaneName(name);

// A migration is Taha's when its SQL writes to, locks or changes one of these tables, or creates,
// replaces, alters or drops a function whose name is in his lane (Taha in Slack, 2026-11-23: #2331
// and #2338 had neutral file names; #2338 rebuilt the delivery step that writes invoices).
// Reading a table does not count; a row lock (FOR UPDATE / FOR SHARE) does.
export const TAHA_LANE_TABLES = [
  // No "bookings" table exists today (a booking is a quote, then an order); listed so a future one counts.
  "bookings", "quotes", "quote_items", "quote_sections", "quote_versions", "quote_price_changes", "quote_product_draws",
  "quote_templates", "quote_pdf_templates",
  "orders", "order_items", "order_shares", "order_item_shares", "order_line_allocations", "order_item_field_allocations",
  "inventory_holds",
  "invoices", "invoice_items", "invoice_shares", "invoice_line_shares", "invoice_line_share_snapshots",
  "invoice_line_allocations", "invoice_sales_tax_rates", "invoice_standing_discount_rates", "invoice_line_rup_captures",
  "invoice_line_brand_rup_captures", "invoice_delivery_recovery_capabilities", "split_invoice_creation_claims",
  "split_invoice_mutation_claims", "split_invoice_provenance", "credit_memo_applications",
  "payments", "prepay_credits", "prepay_applications",
  "commissions", "commission_payments", "commission_payment_items", "commission_settlement_events",
  "commission_earned_state_ledger", "commission_history_cutover",
  // AR and month-end (Taha's review of #2382, MED 3).
  "accounting_periods", "write_offs", "ar_reminder_tracking", "credit_memo_sales_tax", "billing_m4_switch",
  "return_credit_customer_claims",
];
// A migration named for field billing may write these (Mason, 2026-11-23: field billing stays his even when it
// writes the shared invoice tables). Every other lane table still counts there (Taha's review of #2382, HIGH 1);
// "commissions" is here because Taha asked that #2260, which deletes a field invoice's commissions, keep passing.
const FIELD_BILLING_TABLES = new Set(["invoices", "invoice_items", "invoice_shares", "invoice_line_shares", "commissions"]);
const tableRe = (tables) => String.raw`(?:"?public"?\s*\.\s*)?"?(?:${tables.join("|")})"?(?![\w$]|\s*\.)`;
// "INTO" covers INSERT, MERGE and SELECT INTO; "ON" covers triggers, policies, indexes, grants and comments;
// TABLE / ONLY / IF [NOT] EXISTS are optional fillers, and a list (TRUNCATE a, invoices) is read to its end (LOW 5).
const writeRe = (table) => new RegExp(String.raw`\b(?:into|update|delete\s+from|truncate|alter|drop|lock|copy|create(?:\s+unlogged)?\s+table|on)(?:\s+(?:table|only|if\s+(?:not\s+)?exists))*\s+(?:(?:only\s+)?[\w".]+\s*,\s*)*(?:only\s+)?` + table, "i");
const readRe = (table) => new RegExp(String.raw`\b(?:from|join)(?:\s+only)?\s+` + table, "i");
const LANE_RES = { write: writeRe(tableRe(TAHA_LANE_TABLES)), read: readRe(tableRe(TAHA_LANE_TABLES)) };
const FIELD_TABLES = TAHA_LANE_TABLES.filter((t) => !FIELD_BILLING_TABLES.has(t));
const FIELD_RES = { write: writeRe(tableRe(FIELD_TABLES)), read: readRe(tableRe(FIELD_TABLES)) };
const ROW_LOCK_RE = /\bfor\s+(?:no\s+key\s+)?update\b|\bfor\s+(?:key\s+)?share\b/i;
// Booking stock (Taha on #2382): a write that sets inventory.quantity_prebooked, or a function body that does.
const PREBOOKED_RE = /\bset\b(?:(?!\bwhere\b)[^;])*?\bquantity_prebooked"?\s*=|\bquantity_prebooked"?\s*:=|\binto\s+[\w".]*\binventory"?\s*\([^)]*\bquantity_prebooked\b|\bset\s*\([^)]*\bquantity_prebooked\b|\b(?:column|add|drop|alter|rename)\s+(?:column\s+)?(?:if\s+(?:not\s+)?exists\s+)?"?quantity_prebooked\b/i;
const QNAME = String.raw`(?:"?public"?\s*\.\s*)?"?([\w$]+)`;
const FUNCTION_RE = new RegExp(String.raw`\b(?:create(?:\s+or\s+replace)?|alter)\s+(?:function|procedure|routine)\s+` + QNAME, "gi");
// ALTER FUNCTION … RENAME TO <new name> (MED 4).
const RENAME_RE = /\balter\s+(?:function|procedure|routine)\b[^;]*?\brename\s+to\s+"?([\w$]+)/gi;
// DROP FUNCTION a(), b() and GRANT / REVOKE / COMMENT … ON FUNCTION a(), b(): every name in the list (MED 4, LOW 5).
const FUNCTION_LIST_RE = /\b(?:drop|on)\s+(?:function|procedure|routine)\s+(?:if\s+exists\s+)?([^;]*)/gi;
const LIST_NAME_RE = new RegExp(String.raw`^\s*` + QNAME);
function functionNames(text) {
  const names = [...text.matchAll(FUNCTION_RE), ...text.matchAll(RENAME_RE)].map((m) => m[1]);
  for (const m of text.matchAll(FUNCTION_LIST_RE)) {
    let list = m[1];
    while (/\([^()]*\)/.test(list)) list = list.replace(/\([^()]*\)/g, ""); // argument lists, numeric(10,2) included
    for (const piece of list.split(/\b(?:to|from|is|cascade|restrict)\b/i)[0].split(",")) {
      const name = LIST_NAME_RE.exec(piece);
      if (name) names.push(name[1]);
    }
  }
  return names;
}

/**
 * The SQL with its comments blanked. Quoted strings are kept (dynamic SQL in EXECUTE '…' still counts)
 * and a "--" or "/*" inside one is not a comment. Dollar-quoted text ($$ bodies, $c$ comments) is scanned
 * as SQL on its own, so a stray quote inside it (Mason's) cannot run past its closing tag (Taha's review
 * of #2382, LOW 6). A stray quote can only make it keep more text, so a mistake here errs towards refusing.
 */
function withoutComments(sql) {
  let out = "";
  for (let i = 0; i < sql.length;) {
    const tag = sql[i] === "$" && !/[\w$]/.test(sql[i - 1] ?? "") && /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
    if (tag) {
      const start = i + tag[0].length;
      const end = sql.indexOf(tag[0], start);
      const stop = end < 0 ? sql.length : end;
      out += tag[0] + withoutComments(sql.slice(start, stop)) + (end < 0 ? "" : tag[0]);
      i = end < 0 ? sql.length : end + tag[0].length;
    } else if (sql[i] === "'" || sql[i] === '"') {
      const q = sql[i]; // '…' strings and "…" identifiers: a doubled quote stays inside.
      const escapes = q === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? "");
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (escapes && sql[j] === "\\") { j++; continue; }
        if (sql[j] === q) { if (sql[j + 1] === q) { j++; continue; } break; }
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (sql.startsWith("/*", i)) {
      let depth = 0; // Postgres block comments nest.
      while (i < sql.length) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; } else if (sql.startsWith("*/", i)) { depth--; i += 2; if (!depth) break; } else i++;
      }
      out += " ";
    } else out += sql[i++];
  }
  return out;
}

/**
 * True when this migration SQL touches Taha's lane; unreadable SQL (null) counts, so the block fails closed.
 * `fieldBilling`: the file is named for field billing, so writes to FIELD_BILLING_TABLES are Mason's.
 */
export function isTahaLaneSql(sql, { fieldBilling = false } = {}) {
  if (typeof sql !== "string") return true;
  const { write, read } = fieldBilling ? FIELD_RES : LANE_RES;
  const text = withoutComments(sql);
  // Second pass joins string pieces ('UPDATE ' || 'invoices …'), so dynamic SQL built in parts still counts.
  const joined = text.replace(/'\s*\|\|\s*'/g, "");
  if ([text, joined].some((t) => write.test(t) || PREBOOKED_RE.test(t))) return true;
  // A row lock in the same statement as a read of his tables counts (Taha's review of #2382, LOW 9).
  if (text.split(";").some((statement) => ROW_LOCK_RE.test(statement) && read.test(statement))) return true;
  return functionNames(text).some(isLaneFunction);
}

/**
 * Why this merge is refused, or null. `files`: GitHub compare entries
 * ({filename, previous_filename, sql?}) or null when they could not be read (refuses).
 * An entry carrying `sql` (a migration's text, or null when unreadable) is also judged by its SQL.
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
    const name = entry?.filename;
    // A migration named for field billing stays Mason's when it writes the shared invoice tables (Mason, 2026-11-23),
    // but the rest of its SQL is still read (Taha's review of #2382, HIGH 1).
    if (entry && "sql" in entry && typeof name === "string" && !hits.includes(name) && isTahaLaneSql(entry.sql, { fieldBilling: isFieldBillingName(name) })) {
      hits.push(entry.sql === null ? `${name} (its SQL could not be read)` : name);
    }
  }
  return hits.length ? { files: hits, reason: `it changes Taha's areas (${hits.slice(0, 5).join(", ")}${hits.length > 5 ? `, and ${hits.length - 5} more` : ""})` } : null;
}

/**
 * The PR's changed files ({filename, previous_filename}), read the same way as
 * stagingDestructiveProblem (sol-risk-lib.mjs), or null when unreadable.
 */
export function prFilesOnGitHub({ repo, gh, number, headSha }) {
  const repoPath = ghApiRepoPath(repo);
  if (!repoPath || !Number.isInteger(number) || number < 1) return null;
  try {
    const rows = String(gh(["api", "--paginate", `${repoPath}/pulls/${number}/files?per_page=100`, "--jq",
      '.[] | [.status, .filename, (.previous_filename // ""), ((.contents_url // "") | ([capture("[?&]ref=(?<r>[0-9a-f]{40})").r][0] // ""))] | @tsv']))
      .split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"));
    if (rows.some((r) => r.length < 2 || r.length > 4 || !r[1])) return null;
    // The whole list must be GitHub's answer for the pinned head, not a later push (advisory Sol on #2382).
    if (usableHead(headSha) && rows.some(([status, , , ref]) => status !== "removed" && ref && ref.toLowerCase() !== headSha.toLowerCase())) return null;
    return rows.map(([status, filename, previous, ref = ""]) => {
      const entry = { filename, previous_filename: previous || undefined };
      // Migrations, baselines and hand-run undo scripts are judged by their SQL at the head the merge is pinned to;
      // a removed or unreadable one, or one GitHub lists at another commit, counts as Taha's (Taha's review of #2382, LOW 7, LOW 8).
      // A SQL file moved out of the read folders counts as removed there (advisory Sol on #2382).
      if (SQL_FILE_RE.test(filename) || SQL_FILE_RE.test(previous)) {
        entry.sql = status === "removed" || !SQL_FILE_RE.test(filename) || !usableHead(headSha) || ref.toLowerCase() !== headSha.toLowerCase() ? null : migrationSql({ repoPath, gh, filename, ref });
      }
      return entry;
    });
  } catch { return null; }
}

const SQL_FILE_RE = /^(?:supabase\/(?:migrations|baselines)\/.+|scripts\/smoke\/.+-reverse|scripts\/\.staging-migrations\/.+)\.sql$/i;

function migrationSql({ repoPath, gh, filename, ref }) {
  if (!/^[0-9a-f]{40}$/i.test(String(ref ?? ""))) return null;
  try {
    const filePath = filename.split("/").map(encodeURIComponent).join("/");
    const sql = String(gh(["api", "-H", "Accept: application/vnd.github.raw", `${repoPath}/contents/${filePath}?ref=${ref}`]));
    return sql.trim() ? sql : null;
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
