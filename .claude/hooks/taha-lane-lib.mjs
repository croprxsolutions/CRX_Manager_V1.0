// TAHA'S LANES (Mason to Taha in Slack, 2026-11-22): our agents never merge into
// staging a PR that changes Taha's areas (quotes, bookings, purchasing holds,
// chemical invoices and billing), whatever OK line the PR has, unless Taha's own
// GitHub Approve is on the exact head being merged (Mason, 2026-11-24). No end
// date: Mason kept the block past Dec 15 (2026-11-24). Edits to the block's own
// wiring (BLOCK_FILES_RE) still need Mason's code, whatever Taha's review says.
// Field billing (field invoices, spray jobs, blend tickets) stays Mason's.
// #1980 and #1989 merged after Taha asked; a written note did not stop them.
// Comments do not count (Taha, 2026-11-24).
//
// Mason can still let ONE named PR through: the merge refusal issues a 6-digit
// code for that PR at its current head, and his chat message `taha override #<PR> <code>`
// (taha-lane-prompt.mjs) turns it into a 24-hour override for that PR, later pushes
// included (Mason, 2026-11-25; it was one head only after Taha's review of #2303). When it is used the
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
/** The block's own wiring: needs Mason's code, but is not Taha's work to review (Mason, 2026-11-26). */
export const isTahaGateWiring = (name) => BLOCK_FILES_RE.test(String(name ?? "").replace(/\\/g, "/"));

// Mason, 2026-11-26 (#2451): a change to one of Taha's screens that only edits words people read (strings, JSX text,
// comments) is not his work. True only when the changed lines, with those stripped, are the same code before and after.
// Words are: a string given to a label-like name (label, title, placeholder…), JSX text between tags, and comments.
// Every other string is code (a tab key or route can change behaviour: Luna, PR 2), and line breaks are kept.
// A missing patch (GitHub leaves it out of big diffs) is not text-only.
// shortcut: pattern matching, not a parser; an honest-mistake net like the SQL check, not a security boundary.
const TEXT_TOKEN_RE = /(\b(?:label|title|subtitle|placeholder|description|aria-label|alt|tooltip|helperText|emptyText|emptyMessage|heading)\s*[:=]\s*\{?\s*)(?:'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\$])*`)|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?<=[\w"'}/])>([^\S\n]*[A-Za-z][\w .,!?'’:\-–—…]*)<(?=\/|[A-Za-z])/g;
const codeOnly = (lines) => lines.join("\n")
  .replace(TEXT_TOKEN_RE, (m, key, jsx) => key !== undefined ? `${key.replace(/\s+/g, "")}S` : jsx !== undefined ? "><" : m.startsWith("/") ? "" : m)
  .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
export function isTextOnlyPatch(patch) {
  if (typeof patch !== "string" || !patch.trim()) return false;
  const lines = patch.split(/\r?\n/);
  const removed = lines.filter((l) => l.startsWith("-")).map((l) => l.slice(1));
  const added = lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
  return codeOnly(removed) === codeOnly(added);
}

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

// Supplier quotes are Mason's purchasing lane, not customer quotes (Taha, 2026-11-25, after #2524).
// Only inside one path segment, so src/pages/supplier/Quotes.tsx stays Taha's (desk review of #2548, LOW 1).
const dropSupplierQuotes = (name) => String(name).split("/").flatMap((segment) => {
  const words = wordsOf(segment);
  return words.filter((w, i) => !(/^quotes?$/.test(w) && words[i - 1] === "supplier"));
});

function isLaneName(name) {
  if (isFieldBillingName(name)) return false;
  const words = dropSupplierQuotes(name);
  return isBill(words) || words.some((w, i) => LANE_WORDS.has(w) || (w === "write" && /^offs?$/.test(words[i + 1] ?? "")));
}

// Taha's functions whose names carry no lane word (Taha's review of #2382, HIGH 2: #2324 rebuilt
// _complete_delivery_authorized_impl, the step in front of the chemical-sale invoice). Prefixes, except the
// last two pieces, which may sit anywhere in the name. They win over a field word
// (_guard_credit_memo_application_immutable).
// Every name may carry a leading "_": the impls and wrappers behind the public names (Taha, #2382 MED 1).
const TAHA_LANE_FUNCTIONS_RE = new RegExp("^_?(?:complete_delivery|start_and_complete_delivery|void_delivery|cancel_delivery|void_order|cancel_order" +
  "|update_order_items|price_order|apply_write_off|reverse_write_off|lock_accounting_months|get_customer_balance|get_monthly_summary" +
  "|prevent_order_shares" +
  // A sweep of staging (2026-11-24, Taha's ask via Mason): functions whose bodies write his tables but whose names
  // carry no lane word. Field-billing ones (field app, blend ticket, job, application) stay Mason's and are left out.
  "|create_direct_order|create_rush_order|bulk_import_order|restore_cancelled_order|close_undelivered_order_remainder" +
  "|bump_order_item_edit_version|check_unpriced_orders|trg_recalc_order_totals|guard_order_item_shares|validate_order_shares_total" +
  "|assert_order_line_fits|create_return|receive_return|generate_finance_charges|create_delivery_with_items|create_quick_delivery" +
  "|edit_delivery|fix_delivery|correct_delivery_brands|batch_cancel_deliveries|delivery_line_matches_order_line" +
  "|enforce_delivery_items_parent_lock|prebook_quick_delivery_inventory" +
  // Taha's review of #2408: read-only billing reports, the month lock, and NEW-setting triggers the write sweep missed.
  // The customer year-end summaries came off (Mason, 2026-11-26: #2381, a product change, was caught by one).
  "|check_period_open|preview_finance_charges" +
  "|get_sales_summary_report|get_sales_detail_report|get_gross_sales_report|get_profitability_report|financial_dashboard_summary" +
  "|bump_order_edit_version|prevent_oifa_edit_after_post|guard_order_reopen_inactive_product" +
  ")(?=_|$)|^_?get_ar_|accounting_period|credit_memo", "i");
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
// A migration named for a product's units may UPDATE order and quote lines and take table locks (Mason, 2026-11-26:
// #2267 converted one product from mg to grams, its lines included, and locked what it re-checks so nothing moved under
// it; a unit fix is not Taha's). Any other write to those tables (a policy, a column, a delete) and every other lane
// table still count (Luna, PR 2).
const UNIT_FIX_STRIP_RE = /\block\s+(?:table\s+)?[^;]*|\bupdate\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?(?:order_items|quote_items)"?(?![\w$])[^;]*/gi;
// "unit(s)" alone is too common a word to count (a delivery_units fix could be his).
const UNIT_WORDS = new Set(["uom", "gram", "grams", "mg", "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds",
  "gallon", "gallons", "quart", "quarts", "pint", "pints", "liter", "liters", "litre", "litres"]);
const isProductUnitName = (name) => wordsOf(name).some((w) => UNIT_WORDS.has(w)) && !isLaneName(name);
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
// Taha's #2382 LOW 2: a PL/pgSQL `NEW.quantity_prebooked = 0;` at a statement start, and RENAME COLUMN x TO quantity_prebooked.
const PREBOOKED_MORE_RE = /(?:^|;|\bbegin\b|\bthen\b|\belse\b|\bloop\b)\s*(?:"?[\w$]+"?\s*\.\s*)?"?quantity_prebooked"?\s*=(?!=)|\brename\s+(?:column\s+)?[^;]*?\bto\s+"?quantity_prebooked\b/i;
// The SET branch stops at the first WHERE, so a subquery's WHERE is blanked out first (LOW 2).
const withoutParens = (t) => { let prev; do { prev = t; t = t.replace(/\([^()]*\)/g, "()"); } while (t !== prev); return t; };
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
 * `productUnits`: the file is named for a product's units, so its table locks and UPDATEs of order and quote lines
 * are not Taha's (Mason, 2026-11-26; UNIT_FIX_STRIP_RE).
 */
export function isTahaLaneSql(sql, { fieldBilling = false, productUnits = false } = {}) {
  if (typeof sql !== "string") return true;
  const { write, read } = fieldBilling ? FIELD_RES : LANE_RES;
  const text = productUnits ? withoutComments(sql).replace(UNIT_FIX_STRIP_RE, "") : withoutComments(sql);
  // Second pass joins string pieces ('UPDATE ' || 'invoices …'), so dynamic SQL built in parts still counts.
  const joined = text.replace(/'\s*\|\|\s*'/g, "");
  if ([text, joined].some((t) => write.test(t) || PREBOOKED_RE.test(t) || PREBOOKED_MORE_RE.test(t) || PREBOOKED_RE.test(withoutParens(t)))) return true;
  // A row lock in the same statement as a read of his tables counts (Taha's review of #2382, LOW 9).
  if (text.split(";").some((statement) => ROW_LOCK_RE.test(statement) && read.test(statement))) return true;
  return functionNames(text).some(isLaneFunction);
}

/**
 * Why this merge is refused, or null. `files`: GitHub compare entries
 * ({filename, previous_filename, sql?}) or null when they could not be read (refuses).
 * An entry carrying `sql` (a migration's text, or null when unreadable) is also judged by its SQL.
 */
export function tahaLaneProblem({ files }) {
  if (!Array.isArray(files)) return { files: [], reason: "its changed files could not be read, so it can't be shown to stay out of Taha's areas" };
  if (files.length >= MAX_FILES) return { files: [], reason: `${files.length} changed files may be a cut-short list` };
  const hits = [];
  for (const entry of files) {
    const name = entry?.filename;
    // A label-only edit of an app file in his lane, not renamed (Mason, 2026-11-26, #2451).
    const wordsOnly = !entry?.previous_filename && typeof name === "string" && /^src\/.+\.[jt]sx?$/i.test(name) && !isTahaGateWiring(name) && isTextOnlyPatch(entry?.patch);
    for (const n of wordsOnly ? [] : [entry?.filename, entry?.previous_filename]) {
      if (typeof n === "string" && isTahaLanePath(n) && !hits.includes(n)) hits.push(n);
    }
    // A migration named for field billing stays Mason's when it writes the shared invoice tables (Mason, 2026-11-23),
    // but the rest of its SQL is still read (Taha's review of #2382, HIGH 1).
    if (entry && "sql" in entry && typeof name === "string" && !hits.includes(name) && isTahaLaneSql(entry.sql, { fieldBilling: isFieldBillingName(name), productUnits: isProductUnitName(name) })) {
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
      '.[] | [.status, .filename, (.previous_filename // ""), ((.contents_url // "") | ([capture("[?&]ref=(?<r>[0-9a-f]{40})").r][0] // "")), (.patch // "")] | @tsv']))
      .split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"));
    if (rows.some((r) => r.length < 2 || r.length > 5 || !r[1])) return null;
    // The whole list must be GitHub's answer for the pinned head, not a later push (advisory Sol on #2382).
    if (usableHead(headSha) && rows.some(([status, , , ref]) => status !== "removed" && ref && ref.toLowerCase() !== headSha.toLowerCase())) return null;
    return rows.map(([status, filename, previous, ref = "", patch = ""]) => {
      const entry = { filename, previous_filename: previous || undefined };
      // The diff of an app file, for the label-only rule (@tsv escaped its line breaks).
      if (patch && /^src\//i.test(filename)) entry.patch = patch.replace(/\\(.)/g, (_, c) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c);
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

export const TAHA_LOGIN = "tahakhanabdalli";
// His GitHub account number: a login can be renamed and re-registered by someone else; this cannot.
export const TAHA_ID = "50602678";

/**
 * Taha's latest deciding review (approve / changes-requested / dismissed, on any commit) must be an
 * Approve of exactly `headSha`; comments and pending reviews do not count. A dismissal is deciding, so
 * dismissing his Request changes never revives an older Approve (#2406). `rows`: [{ id, state, commit, at }]
 * oldest first. True only when that Approve also came after the PR's last base-branch change
 * (`baseChangedAt`, ISO time or ""): a retarget keeps the head but changes the code that merges.
 */
export function tahaApprovedHead(rows, headSha, baseChangedAt = "") {
  return usableHead(headSha) && tahaApprovedCommit(rows, baseChangedAt) === headSha.toLowerCase();
}

/** The commit Taha's standing Approve is on (lower case), under the same rules as tahaApprovedHead, or null. */
export function tahaApprovedCommit(rows, baseChangedAt = "") {
  const verdict = (rows || []).filter((r) => String(r?.id || "") === TAHA_ID
    && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r?.state)).at(-1);
  if (verdict?.state !== "APPROVED" || !usableHead(verdict.commit)) return null;
  if (baseChangedAt) {
    const approvedAt = Date.parse(verdict.at);
    if (!(Number.isFinite(approvedAt) && approvedAt > Date.parse(baseChangedAt))) return null;
  }
  return verdict.commit.toLowerCase();
}

// Mason, 2026-11-25: Taha's Approve of an older commit still counts when the PR's own change is the same
// now. Pushes that only catch up with staging, change only files under docs/, or restamp a migration (only its
// own migration stamp changed, old -> new, in names and text; Luna r1) leave it so; any other change needs him again.
// shortcut: a staging catch-up that changes how the PR's unchanged code behaves is not seen (Mason accepted, 2026-11-25).
// shortcut: a file whose git mode alone changes (e.g. to a symlink) is not seen; same honest-mistake net (Luna r1, deferred).
// Date-shaped (YYYYMMDDhhmmss, 2000-2099), never part of a decimal. Not \b: a stamp is followed by "_" in names.
const STAMP_RE = /(?<!\d|\d\.)20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[01]\d|2[0-3])[0-5]\d[0-5]\d(?!\d|\.\d)/g;
const unstamped = (text) => String(text ?? "").replace(STAMP_RE, "<stamp>");
const COMPARE_MAX_FILES = 300; // GitHub's compare lists at most 300 files: at that size, refuse.
const MAX_CONTENT_READS = 20;
const isNote = (name) => /^docs\//i.test(String(name ?? ""));
const isMigration = (name) => /^supabase\/migrations\/[^/]+\.sql$/i.test(String(name ?? ""));
// Only a migration's path loses its stamp (Sol: two differently dated code paths are different files).
const pathKey = (name) => (isMigration(name) ? unstamped(name) : String(name));

/** The PR's own changes (GitHub compare `files`) keyed by stamp-free path, docs/ left out; null when unusable. */
export function ownChanges(files) {
  if (!Array.isArray(files) || files.length >= COMPARE_MAX_FILES) return null;
  const out = new Map();
  for (const f of files) {
    const name = String(f?.filename ?? "");
    if (!name) return null;
    if (isNote(name) && (!f.previous_filename || isNote(f.previous_filename))) continue;
    const key = pathKey(name);
    if (out.has(key)) return null;
    const from = f.previous_filename ? `renamed from ${pathKey(f.previous_filename)}` : "";
    out.set(key, { status: f.status === "removed" ? "removed" : `present ${from}`, sha: String(f.sha ?? "").toLowerCase(), name });
  }
  return out;
}

/** Old stamp -> new stamp, read off the PR's own files whose names differ only by stamp (the restamp); null when inconsistent. */
export function restampMap(before, after) {
  if (!before || !after) return null;
  const map = new Map();
  for (const [key, a] of before) {
    const b = after.get(key);
    // Only a migration file names a restamp (Luna r3: any other renamed file with a date in its name does not).
    if (!b || !isMigration(a.name) || !isMigration(b.name)) continue;
    const [x, y] = [String(a.name ?? "").match(STAMP_RE) || [], String(b.name ?? "").match(STAMP_RE) || []];
    if (x.length !== y.length) return null;
    for (let i = 0; i < x.length; i++) {
      if (x[i] === y[i]) continue;
      if (map.has(x[i]) && map.get(x[i]) !== y[i]) return null;
      map.set(x[i], y[i]);
    }
  }
  return map;
}

/** [beforeBlob, afterBlob] pairs whose text must match once stamps are blanked; null when the change differs. */
export function ownChangePairs(before, after) {
  if (!before || !after) return null;
  const pairs = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key);
    const b = after.get(key);
    if (!a || !b || a.status !== b.status) return null;
    if (a.sha === b.sha) continue;
    if (a.status === "removed" || !usableHead(a.sha) || !usableHead(b.sha)) return null;
    pairs.push([a.sha, b.sha]);
  }
  return pairs.length > MAX_CONTENT_READS ? null : pairs;
}

// Sol HIGH: a catch-up whose conflict resolution keeps the PR's copy of a file silently drops staging's change to
// it, yet the PR's file is unchanged. So when the branch point moved, staging must not have touched any PR file.
function stagingLeftOwnFilesAlone({ repoPath, gh, from, to, files }) {
  if (!usableHead(from) || !usableHead(to)) return false;
  if (from.toLowerCase() === to.toLowerCase()) return true;
  const moved = JSON.parse(String(gh(["api", `${repoPath}/compare/${from}...${to}`, "--jq",
    "{status, files: (if .files == null then null else [.files[] | .filename, (.previous_filename // empty)] end), count: (.files // [] | length)}"])));
  if (moved?.status !== "ahead" || !Array.isArray(moved.files) || moved.count >= COMPARE_MAX_FILES) return false;
  const own = new Set(files.filter((f) => !isNote(f.filename) || (f.previous_filename && !isNote(f.previous_filename)))
    .flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
  return !moved.files.some((name) => own.has(name));
}

function sameOwnChange({ repoPath, gh, pullRequest, from, to }) {
  const base = String(gh(["api", `${repoPath}/pulls/${pullRequest}`, "--jq", ".base.ref"])).trim();
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(base)) return false;
  // base...commit is the PR's own diff at that commit (against where it branched off the base).
  // A reply without `files` is unusable (null), never an empty change (Sol).
  const compare = (commit) => JSON.parse(String(gh(["api", `${repoPath}/compare/${base}...${commit}`, "--jq",
    "{mb: .merge_base_commit.sha, files: (if .files == null then null else [.files[] | {filename, status, sha, previous_filename}] end)}"])));
  const [old, now] = [compare(from), compare(to)];
  const [before, after] = [ownChanges(old?.files), ownChanges(now?.files)];
  const pairs = ownChangePairs(before, after);
  const restamps = restampMap(before, after);
  if (!pairs || !restamps) return false;
  if (!stagingLeftOwnFilesAlone({ repoPath, gh, from: old.mb, to: now.mb, files: [...old.files, ...now.files] })) return false;
  const bytes = (sha) => Buffer.from(String(gh(["api", `${repoPath}/git/blobs/${sha}`, "--jq", ".content"])).replace(/\s+/g, ""), "base64");
  // Only the PR's own restamp may differ in text (Luna r1: any other date-shaped number is a real change),
  // and only in real UTF-8 text; anything else must match byte for byte.
  const text = (buf) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return null; } };
  // shortcut: a code value equal to the PR's own migration stamp, moved in step with the restamp, carries over;
  // real restamps rewrite bare stamp mentions in src/ and scripts/ comments (#2557), so all files are normalized
  // (Luna r2, refuted; tighten only if a real code value ever matches a migration stamp).
  const restamped = (t) => t.replace(STAMP_RE, (s) => restamps.get(s) ?? s);
  return pairs.every(([a, b]) => {
    const [x, y] = [bytes(a), bytes(b)];
    const [tx, ty] = [text(x), text(y)];
    return tx !== null && ty !== null ? restamped(tx) === restamped(ty) : x.equals(y);
  });
}

/**
 * Taha's reviews and the PR's base changes read from GitHub: his standing Approve of this head, or of an older
 * commit whose own change is the same (sameOwnChange). Any read error → false (refuse).
 */
// The repo's rulesets dismiss stale reviews on every push, so GitHub lists an Approve of an older commit as
// DISMISSED. Those, and only those, still count as his Approve here: the timeline records them as an
// approval dismissed by a push (a commit) with no message; a person dismissing one must give a message.
export function pushDismissedApprovals(events) {
  return new Set((events || []).filter((e) => e?.event === "review_dismissed" && e.state === "approved" && !e.message
    && usableHead(e.commit) && /^\d+$/.test(String(e.review ?? ""))).map((e) => String(e.review)));
}

export function tahaApprovedOnGitHub({ repo, gh, pullRequest, headSha }) {
  const repoPath = ghApiRepoPath(repo);
  if (!repoPath || !usablePr(pullRequest) || !usableHead(headSha)) return false;
  try {
    const events = String(gh(["api", "--paginate", `${repoPath}/issues/${pullRequest}/timeline?per_page=100`, "--jq",
      '.[] | select(.event == "base_ref_changed" or .event == "automatic_base_change_succeeded" or .event == "review_dismissed") | ' +
      '[.event, (.created_at // ""), (.dismissed_review.review_id // "" | tostring), (.dismissed_review.state // ""), ' +
      '(.dismissed_review.dismissal_message // ""), (.dismissed_review.dismissal_commit_id // "")] | @tsv'])).split(/\r?\n/).filter(Boolean)
      .map((line) => { const [event, at, review, state, message, commit] = line.split("\t"); return { event, at, review, state, message, commit }; });
    const baseChangedAt = events.filter((e) => e.event !== "review_dismissed").map((e) => e.at).filter(Boolean).sort().at(-1) || "";
    const pushDismissed = pushDismissedApprovals(events);
    const rows = String(gh(["api", "--paginate", `${repoPath}/pulls/${pullRequest}/reviews?per_page=100`, "--jq",
      '.[] | [(.user.id // "" | tostring), .state, (.commit_id // ""), (.submitted_at // ""), (.id // "" | tostring)] | @tsv'])).split(/\r?\n/).filter(Boolean)
      .map((line) => { const [id, state, commit, at, review] = line.split("\t");
        return { id, state: state === "DISMISSED" && pushDismissed.has(review) ? "APPROVED" : state, commit, at }; });
    const approved = tahaApprovedCommit(rows, baseChangedAt);
    if (!approved) return false;
    return approved === headSha.toLowerCase() || sameOwnChange({ repoPath, gh, pullRequest, from: approved, to: headSha });
  } catch { return false; }
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

/**
 * Mason's live override for this PR, or null. It covers every later push to the PR for its 24 hours
 * (Mason, 2026-11-25: one message per PR, not per commit). `headSha` is unused, kept for callers.
 */
export function findTahaLaneOverride({ dirs, pullRequest, now = Date.now() }) {
  if (!usablePr(pullRequest)) return null;
  for (const dir of dirs || []) {
    const data = readSmall(path.join(dir, overrideName(pullRequest)));
    if (data?.pullRequest === pullRequest && usableHead(data?.headSha) && live(data, TAHA_LANE_OVERRIDE_MAX_AGE_MS, now)) return data;
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
 * refusal text. `tahaApproved()` true (Taha's Approve stands for this head) lets it through.
 * With Mason's override for this PR (any head, 24 hours), `tellTaha(body)`
 * must post the PR comment first (once per override); if it can't, the merge is refused.
 */
export function tahaLaneGate({ prefix, pullRequest, headSha, files, dirs, now = Date.now(), tellTaha = () => false, tahaApproved = () => false, notice = () => {} }) {
  const problem = tahaLaneProblem({ files });
  if (!problem) return null;
  // Taha's standing Approve (tahaApprovedOnGitHub) lets lane code through. Not an unreadable file list, a migration
  // whose SQL could not be read, or the block's own files.
  // Unreadable SQL is checked on the raw entries: a lane-named migration is listed by name, never with the suffix (Astra, 2026-11-24).
  const unreadableSql = !Array.isArray(files) || files.some((e) => e && "sql" in e && e.sql === null);
  if (problem.files.length && !unreadableSql && !problem.files.some((f) => BLOCK_FILES_RE.test(f)) && tahaApproved()) {
    notice(`${prefix}: TAHA LANE: Taha approved #${pullRequest} at ${String(headSha).slice(0, 12)}; it may go on to the next gate.\n`);
    return null;
  }
  const override = findTahaLaneOverride({ dirs, pullRequest, headSha, now });
  if (override) {
    if (!override.tahaToldAt) {
      const body = `@TahaKhanAbdalli Mason's override of the Taha lane block was used for a merge attempt on this PR at \`${String(headSha).toLowerCase()}\` ` +
        `(his code ${override.code}, valid until ${override.expiresAt}). The other merge checks still apply, so this attempt may still be refused; ` +
        `the PR's own merged state is the record of whether it landed. It ${problem.reason}.`;
      if (!tellTaha(body)) {
        return `${prefix}: TAHA LANE BLOCK — Mason's override for #${pullRequest} is valid, but the PR comment telling Taha could not be posted, so the merge is refused. Retry the merge.`;
      }
      markTahaTold({ dirs, override });
    }
    notice(`${prefix}: TAHA LANE OVERRIDDEN BY MASON for #${pullRequest} at ${String(headSha).slice(0, 12)}; Taha was told on the PR.\n`);
    return null;
  }
  const code = issueTahaLaneCode({ dirs, pullRequest, headSha, now });
  return `${prefix}: TAHA LANE BLOCK — #${pullRequest || "?"} is refused because ${problem.reason}. ` +
    "Agents never merge in Taha's areas (quotes, bookings, purchasing holds, chemical invoices and billing) without Taha's " +
    "GitHub Approve (it carries over pushes that only catch up with staging, change only docs/ or restamp a migration), and never change this block without Mason's code (Mason, 2026-11-22 and 2026-11-24). " +
    `Request his review (gh pr edit ${pullRequest || "<n>"} --add-reviewer TahaKhanAbdalli) and wait for his Approve. ` +
    (code
      ? `Only if Mason wants it merged anyway: tell him why in one line and ask him to send, as a message of its own: taha override #${pullRequest} ${code} ` +
        "(it covers this PR, later pushes included, for 24 hours)"
      : "The override code could not be saved, so only Taha can land it.");
}
