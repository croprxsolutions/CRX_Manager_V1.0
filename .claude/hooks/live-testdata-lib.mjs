// Pure classifier for live-testdata-guard.mjs. Decides whether an execute_sql
// query is a real-business-data write that should be blocked (unless it's clearly
// fake [E2E] data or Mason has authorized real data this session).
//
// Also closes the execute_sql side door around the migration gauntlet: raw DDL,
// GRANT/REVOKE, TRUNCATE, financial-amount UPDATEs, and any hand-written touch of
// financial_audit_log are blocked here so live schema/money changes can only travel
// the reviewed apply_migration path. Rolled-back smoke batches (BEGIN;...;ROLLBACK;
// with no COMMIT) stay allowed — that is the documented safe test pattern.

import { createHash } from "node:crypto";

const BUSINESS_TABLES = [
  "customers", "products", "orders", "order_items", "invoices", "invoice_items",
  "quotes", "quote_items", "deliveries", "delivery_items", "blend_tickets",
  "jobs", "job_fields", "returns", "return_items", "payments", "commissions",
  "commission_payments",
  // Codex P1 2026-07-13: the AP/prepay/credit/inventory side was missing, so a
  // raw UPDATE against these live tables slipped past the catch-all entirely.
  // Every name verified against .claude/schema-registry.json columns.
  "vendor_bills", "vendor_payments", "purchase_orders", "prepay_credits",
  "prepay_applications", "credit_memo_applications", "inventory_transactions",
  "inventory", "inventory_holds",
  "fields", "job_applied_records", "allocation_sets", "write_offs",
];
const FINANCIAL_TABLES = [
  "invoices", "orders", "payments", "commissions", "commission_payments", "financial_audit_log",
  "vendor_bills", "vendor_payments", "prepay_credits", "prepay_applications",
  "credit_memo_applications", "allocation_sets", "write_offs",
  "inventory", "inventory_holds", "inventory_transactions",
];

function tableAlt(tables) {
  return tables.map((t) => t.replace(/[^a-z_]/g, "")).join("|");
}
// Qualification prefix: bare, `public.`, `"public".`, or quoted table — all
// valid SQL forms. Codex P1 2026-07-13 round 3: `UPDATE "public"."customers"`
// evaded the earlier `(?:public\.)?` prefix entirely.
const QUAL = `(?:"?public"?\\s*\\.\\s*)?"?`;
// `UPDATE ONLY t` and `DELETE FROM ONLY t` are the same writes, and MERGE can
// insert, update and delete (2026-10-25).
const DML_VERB = `insert\\s+into|update(?:\\s+only)?|delete\\s+from(?:\\s+only)?|merge\\s+into(?:\\s+only)?`;

// Every INSERT/UPDATE/DELETE on a live business table, wherever it sits: a
// statement, a data-modifying CTE, a DO body, or a string literal (dynamic SQL).
// FIX 5 (2026-07-13) made ANY update count, not only money columns and
// cancel/void; the same standard covers deletes from non-financial tables
// (CodeRabbit, PR #352), and the AP/prepay/inventory tables joined the list in
// Codex P1 2026-07-13.
// `(?:"|\b)`, not `"?\b`: after a quoted name the closing quote must be part of
// the match, or the INSERT head check below sees a stray `"` (Luna round 3).
const WRITE_RE = new RegExp(`\\b(${DML_VERB})\\s+${QUAL}(${tableAlt(BUSINESS_TABLES)})(?:"|\\b)`, "gi");
const CANCEL_VOID_SET_RE = /\bset\b[\s\S]*?status\s*=\s*'(?:cancelled|voided)'/i;

// Any hand-written touch of the append-only audit log — [E2E] does NOT exempt this.
const AUDIT_LOG_WRITE_RE = new RegExp(`\\b(?:${DML_VERB})\\s+${QUAL}financial_audit_log\\b`, "i");

// Statement-anchored DDL (start of batch or after a `;`). `create temp`/`temporary`
// tables are legitimate scratch space for analysis and stay allowed.
const DDL_STMT_RE = /(?:^|;)\s*(?:create(?!\s+(?:temp|temporary)\b)(?:\s+or\s+replace)?|alter|drop)\s+\S+/im;
const GRANT_REVOKE_RE = /(?:^|;)\s*(?:grant|revoke)\b/im;
const TRUNCATE_RE = /(?:^|;)\s*truncate\b/im;

// Money-ish column assignment (column name on the LEFT of `=`) on a financial table.
const MONEY_COL_RE = /\b[a-z_]*(?:cents|amount|total|balance|price|rate|paid)[a-z_]*\s*=/i;

// A DO body is hand-written SQL that EXECUTES immediately (a DO block can even
// COMMIT mid-transaction), so unlike a stored function body it must stay visible
// to the classifier. Matches "DO $tag$" and "DO LANGUAGE plpgsql $tag$".
const DO_PREFIX_RE = /\bdo(?:\s+language\s+[a-z_][a-z0-9_]*)?\s*$/i;

// Comments are legal between DO and its dollar quote (`DO /* x */ $$...$$`,
// `DO -- note\n$$...$$`) and used to hide the executable body from the DO
// check (Codex P1 2026-07-13 round 3). Strip trailing comments/whitespace from
// the already-emitted text before testing the DO prefix. Used ONLY for that
// test — never for output — so an over-strip can only make MORE text visible
// to the classifiers (the safe direction).
function stripTrailingComments(s) {
  let t = s;
  let prev;
  do {
    prev = t;
    t = t.replace(/\s+$/, "");
    t = t.replace(/\/\*(?:[^*]|\*(?!\/))*\*\/$/, "");
    t = t.replace(/--[^\r\n]*$/, "");
  } while (t !== prev);
  return t;
}

// The dollar-quote opening at src[i], or null. Matches PostgreSQL's scanner
// (2026-10-25, Luna): a tag may hold any non-ASCII character and has no length
// cap, and a `$` that continues an identifier (`a$x$` is one name) opens
// nothing. The old ASCII-only, 66-character form missed `$xé$`, so a `--`
// inside such a string was stripped as a comment along with the real SQL after it.
const DOLLAR_TAG_RE = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;
function dollarTagAt(src, i) {
  if (/[A-Za-z0-9_$\u0080-￿]/.test(src[i - 1] || "")) return null;
  DOLLAR_TAG_RE.lastIndex = i;
  return DOLLAR_TAG_RE.exec(src);
}

// Strip dollar-quoted string bodies ($function$...$function$, $$...$$, any
// $tag$...$tag$ pair) so classification sees only top-level hand-written SQL —
// an INSERT INTO financial_audit_log inside a CREATE OR REPLACE FUNCTION body
// being re-emitted by a BEGIN;...;ROLLBACK; smoke is machine content, not a
// hand-written audit-log write. Single-quoted literals and comments are walked
// (not stripped) so a stray $$ inside them can't open a fake quote span that
// swallows real statements. DO bodies are kept (they execute). An unterminated
// dollar-quote leaves the rest untouched (fail closed).
function stripDollarQuotedCore(sql, keepBody) {
  const src = String(sql || "");
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const escapeString = (ch === "e" || ch === "E") && src[i + 1] === "'" &&
      !/[A-Za-z0-9_$]/.test(src[i - 1] || "");
    if (ch === "'" || escapeString) {
      let j = i + (escapeString ? 2 : 1);
      while (j < n) {
        if (escapeString && src[j] === "\\") { j += Math.min(2, n - j); continue; }
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j++; break; }
        j++;
      }
      out += src.slice(i, j); i = j; continue;
    }
    if (ch === "-" && src[i + 1] === "-") {
      let j = i + 2;
      while (j < n && src[j] !== "\n" && src[j] !== "\r") j++;
      out += src.slice(i, j); i = j; continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      let depth = 1, j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") { depth++; j += 2; continue; }
        if (src[j] === "*" && src[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      out += src.slice(i, j); i = j; continue;
    }
    if (ch === "$") {
      const tag = dollarTagAt(src, i);
      if (tag) {
        const open = tag[0];
        const close = src.indexOf(open, i + open.length);
        if (close === -1) { out += src.slice(i); break; }
        const end = close + open.length;
        out += keepBody(out) ? src.slice(i, end) : " ";
        i = end; continue;
      }
    }
    out += ch; i++;
  }
  return out;
}

export function stripDollarQuoted(sql) {
  return stripDollarQuotedCore(sql, (out) => DO_PREFIX_RE.test(stripTrailingComments(out)));
}

// Function-definition bodies ONLY: a dollar-quote is stripped iff the last
// non-comment token before it is `AS` (the CREATE FUNCTION body marker in
// this repo's migration style). EVERYTHING ELSE — DO blocks with comments
// anywhere in their prefix, unknown or obfuscated forms — stays VISIBLE.
// Default-keep is the fail-safe direction (Codex P1 2026-07-13 round 4: the
// DO-prefix allowlist kept being bypassable by legal comment placement; an
// over-kept body can only cause a false PARK, never hidden data loss).
const FN_BODY_PREFIX_RE = /\bas\s*$/i;
export function stripFunctionBodiesOnly(sql) {
  return stripDollarQuotedCore(sql, (out) => !FN_BODY_PREFIX_RE.test(stripTrailingComments(out)));
}

// Quote-aware comment removal. String literals, quoted identifiers, and
// dollar-quoted spans are copied VERBATIM — a `/*` or `--` inside them is data,
// not a comment (Codex P1 2026-07-13 round 5: `SELECT '/*'; DELETE FROM
// customers; SELECT '*/';` let a raw-regex comment strip swallow the real
// DELETE). Real comments become a single space. Side effect: a comment INSIDE
// a kept dollar-quoted body (e.g. a DO block) is no longer stripped, so prose
// like `-- never TRUNCATE` in a DO body can false-positive — that parks the
// migration for Mason, which is the safe direction.
export function stripCommentsQuoteAware(sql, { intoDollarBodies = false } = {}) {
  const src = String(sql || "");
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const escapeString = (ch === "e" || ch === "E") && src[i + 1] === "'" &&
      !/[A-Za-z0-9_$]/.test(src[i - 1] || "");
    if (ch === "'" || escapeString) {
      let j = i + (escapeString ? 2 : 1);
      while (j < n) {
        if (escapeString && src[j] === "\\") { j += Math.min(2, n - j); continue; }
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j++; break; }
        j++;
      }
      out += src.slice(i, j); i = j; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j++;
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === "$") {
      const tag = dollarTagAt(src, i);
      if (tag) {
        const open = tag[0];
        const close = src.indexOf(open, i + open.length);
        const end = close === -1 ? n : close + open.length;
        // intoDollarBodies: also remove the comments INSIDE a kept body (a DO
        // block), tokenized quote-aware from the body's own start — used by the
        // access classifier, whose prose false positives would otherwise park
        // every migration with a self-checking DO block. Default: verbatim.
        out += intoDollarBodies && close !== -1
          ? open + stripCommentsQuoteAware(src.slice(i + open.length, close), { intoDollarBodies }) + open
          : src.slice(i, end);
        i = end; continue;
      }
    }
    if (ch === "-" && src[i + 1] === "-") {
      let j = i + 2;
      while (j < n && src[j] !== "\n" && src[j] !== "\r") j++;
      out += " "; i = j; continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      let depth = 1, j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") { depth++; j += 2; continue; }
        if (src[j] === "*" && src[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      out += " "; i = j; continue;
    }
    out += ch; i++;
  }
  return out;
}

// ── SELECT-invoked function classification (Codex P1 round 4, PR #352) ───────
// A mutating-verb blocklist can never converge (save_customer, close_accounting_
// period, restore_quote_version all slipped it), so this is DEFAULT-DENY: any
// custom function invoked in the statement is blocked unless its name carries a
// read-only prefix or is a recognized SQL builtin. A false positive denies —
// the safe direction — and REAL-DATA-OK (checked by the guard) overrides.
// `check_` is deliberately NOT trusted: check_unpriced_orders() inserts
// notifications and updates orders (Codex P1 round 5, PR #352) — the prefix is
// not proof of immutability. Audited read-only functions with untrusted names
// go in READONLY_FN_NAMES below, one per line, with the audit date.
const READONLY_FN_PREFIX_RE = /^(?:get|list|find|search|count|calc|calculate|compute|report|fetch|lookup|has|is|can|preview|estimate|summarize|derive)_/;
export const READONLY_FN_NAMES = new Set([
  // (none audited yet — add "fn_name", // audited YYYY-MM-DD entries here)
]);
const SQL_BUILTIN_FNS = new Set([
  // aggregates / window
  "count", "sum", "avg", "min", "max", "string_agg", "array_agg", "jsonb_agg",
  "json_agg", "jsonb_object_agg", "json_object_agg", "bool_and", "bool_or",
  "row_number", "rank", "dense_rank", "percent_rank", "ntile", "lag", "lead",
  "first_value", "last_value", "nth_value", "percentile_cont", "percentile_disc",
  // conditionals / generic
  "coalesce", "nullif", "greatest", "least", "num_nonnulls", "num_nulls",
  // json
  "jsonb_build_object", "json_build_object", "jsonb_build_array", "json_build_array",
  "jsonb_array_elements", "json_array_elements", "jsonb_array_elements_text",
  "jsonb_each", "json_each", "jsonb_each_text", "jsonb_object_keys", "json_object_keys",
  "jsonb_typeof", "json_typeof", "jsonb_array_length", "json_array_length",
  "jsonb_extract_path", "jsonb_extract_path_text", "jsonb_path_query",
  "jsonb_path_query_array", "jsonb_path_exists", "jsonb_pretty", "jsonb_strip_nulls",
  "to_json", "to_jsonb", "row_to_json", "array_to_json", "json_populate_record",
  "jsonb_populate_record", "jsonb_set", "jsonb_insert", "jsonb_concat",
  // arrays / sets
  "unnest", "generate_series", "generate_subscripts", "array_length", "cardinality",
  "array_position", "array_positions", "array_to_string", "string_to_array",
  "array_append", "array_prepend", "array_remove", "array_replace", "array_cat",
  "array_fill", "array_agg_distinct", "array_upper", "array_lower", "array_ndims",
  // date / time
  "now", "clock_timestamp", "statement_timestamp", "transaction_timestamp",
  "date_trunc", "date_part", "extract", "to_char", "to_date", "to_timestamp",
  "to_number", "age", "justify_interval", "justify_days", "justify_hours",
  "make_date", "make_time", "make_timestamp", "make_timestamptz", "make_interval",
  "date_bin", "timezone", "isfinite",
  // math
  "round", "floor", "ceil", "ceiling", "abs", "sign", "mod", "power", "sqrt",
  "cbrt", "exp", "ln", "log", "log10", "trunc", "random", "setseed", "width_bucket",
  "div", "gcd", "lcm", "factorial", "pi", "degrees", "radians",
  // strings
  "length", "char_length", "character_length", "octet_length", "bit_length",
  "lower", "upper", "initcap", "trim", "ltrim", "rtrim", "btrim", "lpad", "rpad",
  "substring", "substr", "replace", "translate", "overlay", "split_part",
  "position", "strpos", "starts_with", "concat", "concat_ws", "left", "right",
  "reverse", "repeat", "format", "quote_ident", "quote_literal", "quote_nullable",
  "regexp_replace", "regexp_matches", "regexp_match", "regexp_split_to_table",
  "regexp_split_to_array", "regexp_count", "regexp_like", "regexp_instr",
  "regexp_substr", "md5", "encode", "decode", "convert_from", "convert_to",
  "to_hex", "ascii", "chr", "parse_ident",
  // casts / type info / misc reads
  "cast", "pg_typeof", "pg_column_size", "pg_size_pretty", "version",
  "current_setting", "current_database", "current_schema", "current_user",
  "session_user", "pg_backend_pid", "txid_current", "pg_is_in_recovery",
  "obj_description", "col_description", "shobj_description",
  "pg_get_serial_sequence", "pg_get_functiondef", "pg_get_constraintdef",
  "pg_get_indexdef", "pg_get_viewdef", "pg_get_expr", "pg_relation_size",
  "pg_total_relation_size", "pg_table_size", "pg_indexes_size", "pg_database_size",
  "format_type", "to_regclass", "to_regproc", "to_regtype",
  // catalog reads that were refused as RPCs in real sessions (2026-10-04 count)
  "pg_get_userbyid", "pg_get_triggerdef", "pg_get_function_identity_arguments",
  "pg_get_function_arguments", "pg_get_function_result", "pg_get_ruledef",
  "to_regprocedure", "to_regnamespace", "to_regrole", "aclexplode", "oidvectortypes",
  "pg_function_is_visible", "pg_table_is_visible",
  "has_table_privilege", "has_column_privilege", "has_function_privilege",
  "has_schema_privilege", "has_database_privilege", "pg_has_role",
  "gen_random_uuid", "uuid_generate_v4", "exists", "currval", "lastval",
  // full-text search (read-only)
  "to_tsvector", "to_tsquery", "plainto_tsquery", "phraseto_tsquery",
  "websearch_to_tsquery", "ts_rank", "ts_rank_cd", "ts_headline",
]);
// SQL keywords that look like `word (` in text but are not function calls.
const SQL_KEYWORD_FNS = new Set([
  "select", "from", "where", "and", "or", "not", "in", "on", "as", "join",
  "values", "using", "over", "filter", "within", "group", "order", "by",
  "having", "limit", "offset", "union", "all", "any", "some", "distinct",
  "case", "when", "then", "else", "end", "between", "like", "ilike", "similar",
  "is", "null", "true", "false", "interval", "array", "row", "with", "lateral",
  "cross", "inner", "outer", "full", "grouping", "window", "partition", "if",
]);

// An unquoted identifier folds to lower case and a quoted one keeps its case, so
// `AUTH.uid()` is auth.uid() but `"AUTH".uid()` is another schema (Luna, PR #882).
// An identifier character is what PostgreSQL's own scanner accepts: ASCII letters,
// digits, `_`, `$` and every non-ASCII character. So `x$auth` and `éauth` are other
// schemas too (Luna, PR #882).
const IDENT_CHAR = "\\w$\\u0080-\\uffff";
const caseless = (word) => word.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const schemaBefore = (word) => new RegExp(`(?:^|[^${IDENT_CHAR}."])(?:${caseless(word)}|"${word}")\\s*\\.\\s*$`);
const AUTH_SCHEMA_BEFORE_RE = schemaBefore("auth");
const PG_CATALOG_BEFORE_RE = schemaBefore("pg_catalog");

export function findNonReadFunctionCall(sqlText) {
  // Comments go first (quote-aware, each becomes one space): `evil./*x*/fn(1)`
  // hid its schema and `fn/**/(1)` hid the call itself (Codex connector, PR #882),
  // and comment prose such as `-- cancel_order(42)` is not a call.
  const text = stripCommentsQuoteAware(String(sqlText || ""));
  if (!/\bselect\b/i.test(text)) return null;
  // A name starts after any identifier character, `$` and non-ASCII included:
  // `my$count(…)` and `écount(…)` are application functions, not the built-in count
  // (Luna, PR #882).
  const re = /(?<![\w$\u0080-￿])(?:"?public"?\s*\.\s*)?"?([a-z_\u0080-￿][a-z0-9_$\u0080-￿]*)"?\s*\(/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    const before = text.slice(0, m.index);
    // The schema decides which function runs: `public.pg_get_triggerdef(…)` is the
    // application's own function, so only an unqualified or pg_catalog name is a
    // built-in (CodeRabbit, PR #882).
    // A quoted name with capitals (`"COUNT"(…)`) is not the built-in either.
    const quotedCaps = /"\s*\($/.test(m[0]) && m[1] !== name;
    const otherSchema = quotedCaps || /^"?public"?\s*\./i.test(m[0]) ||
      (/\.\s*$/.test(before) && !PG_CATALOG_BEFORE_RE.test(before));
    if (!otherSchema && (SQL_KEYWORD_FNS.has(name) || SQL_BUILTIN_FNS.has(name))) continue;
    // auth.uid() is the caller's id, a read; a `uid` in any other schema is not vouched for.
    // The schema must be exactly `auth` or `"auth"`, not `"evil.auth"` or `x.auth` (Luna, PR #882).
    if (name === "uid" && !quotedCaps && AUTH_SCHEMA_BEFORE_RE.test(before)) continue;
    // `AS t(a, b)` names an alias's columns and `::numeric(10,2)` is a type;
    // neither is a call.
    if (/(?:\bas|::)\s*$/i.test(text.slice(0, m.index))) continue;
    // The application's read-named functions live in `public`, so a get_/list_ name
    // in any other schema (`evil.get_invoice(…)`) is not vouched for (Luna, PR #882).
    const appSchema = !quotedCaps && (/^(?:"public"|[Pp][Uu][Bb][Ll][Ii][Cc])\s*\./.test(m[0]) ||
      (!/^"?public"?\s*\./i.test(m[0]) && !/\.\s*$/.test(before)));
    if (appSchema && READONLY_FN_NAMES.has(name)) continue;
    if (appSchema && READONLY_FN_PREFIX_RE.test(name)) continue;
    // pg_catalog/information_schema internals are reads
    if (!otherSchema && (name.startsWith("pg_stat") || name.startsWith("pg_ls") || name.startsWith("information_schema"))) continue;
    return name;
  }
  return null;
}

// Returns { block: false } | { block: true, kind, reason }
// ── Known sweep predicates, recognised by content — NOT parsed ──────────────
//
// All 29 db-invariant-sweep predicates are refused by the checks below. 27 are
// refused by findNonReadFunctionCall, which reads comment prose or an unlisted
// catalog function as a call — `-- predicate (f): overloads` as `predicate()`
// in 8 of them, and `suite()`, `expected()`, `key()`, `pg_get_triggerdef()` and
// others in the rest. The other 2 trip the audit-log write check. (This comment
// used to say all 29 were refused as `predicate()`; Codex, PR #648 round 7,
// counted.)
//
// PR #639 tried to fix that by teaching this file to lex SQL. Six pinned
// gpt-5.6-sol rounds each found real defects — several introduced by the
// previous round's fix — and it was closed unmerged on Mason's decision
// (2026-09-09). A PreToolUse hook cannot see standard_conforming_strings,
// cannot resolve a search_path, and cannot know which schema a name binds to.
// It was guessing, and the guesses were the bugs.
//
// These predicates are not unknown input. They are fixed, reviewed text in this
// repository, so they are RECOGNISED rather than understood: a sha256 of their
// text after the normalisation below, against the list embedded in this file
// (not the checked-in manifest an earlier version used). This can only ever ADD permission
// for text already written and reviewed, so it changes nothing about how any
// other input is classified — the checks below are untouched.
//
// Editing a predicate changes its fingerprint, so the guard stops recognising
// it until the list below is updated, and that update appears in the diff
// where the changed SQL is re-reviewed. That is the control, and it is
// deliberately the only one: see the long note in
// scripts/db-invariant-sweeps/write-predicate-fingerprints.mjs about the
// keyword shape-check that was tried here and removed for demanding a lexer.
//
// THE LIST LIVES IN THIS FILE, AND THAT IS THE POINT.
//
// It was first a JSON manifest under scripts/. That was a bypass: the manifest
// was an ordinary writable file while `.claude/hooks/**` is an approval-gated
// enforcement surface, so an agent could hash a destructive statement, append
// it to the manifest with an ordinary edit, and call execute_sql — each hook
// invocation reloads the file, and the allowance short-circuits every check
// below it. The suite would notice afterwards, which is no use once the rows
// are gone (Codex, PR #648 round 4).
//
// So the authorised hashes are part of the guard, protected by whatever
// protects the guard, and adding one is an edit to a hook file. This library
// now reads no file at runtime, which also retires the cache-lifetime,
// path-resolution and malformed-manifest questions that version carried. (Said
// precisely: the HOOK that calls this still reads its PreToolUse payload from
// stdin, as every hook does. An earlier commit message claimed "the guard
// performs no readFileSync", which was broader than the truth.)
//
// To change the list: node scripts/db-invariant-sweeps/write-predicate-fingerprints.mjs
// PRINTS the block that belongs between the markers below; it never changes
// this file. Apply the printed block with an ordinary edit here. It used to
// rewrite this region itself, which let an auto-allowed `node scripts/...`
// command change an approval-gated hook file — the manifest bypass above, by a
// side door (Codex GitHub review, PR #648). This removes that sanctioned,
// pre-allowed writer; it does not make hook files tamper-proof against an
// agent that writes its own script, which no hook-file layout can.

// Line endings, a UTF-8 BOM, and trailing whitespace at end of file can all
// differ between checkouts without a single SQL character changing, so they are
// normalised. NOTHING inside the SQL is touched: no comment stripping, no case
// folding, no whitespace collapsing. Every one of those would be a parser
// again, and would let two different statements share a fingerprint.
//
// Two consequences are accepted, not overlooked (Codex, PR #648 round 7).
// Line endings are folded everywhere, including inside a string literal, where
// a CR is part of the value; none of the 29 has a raw line break inside a
// literal, and a literal's contents change what a read returns, never whether
// it writes. And a leading BOM is stripped although PostgreSQL rejects one, so
// the BOM-prefixed variant shares a fingerprint while being a syntax error,
// which executes nothing.
//
// This is the ONE definition — write-predicate-fingerprints.mjs imports it, so
// the generator and the guard cannot drift into hashing different bytes.
//
// The trailing trim is ASCII-only, and deliberately narrower than `trimEnd()`.
// `trimEnd()` also strips NBSP, U+2028, ideographic space and friends, none of
// which a checkout introduces — and PostgreSQL does not treat them as
// whitespace either, so trimming them meant `SELECT 1;` plus a trailing NBSP
// shared a fingerprint with `SELECT 1;` while being a syntax error to the
// server (Codex, PR #648 round 6). Harmless in practice, but it made the stated
// rule — "only what a checkout can change" — untrue. This is the rule as
// written.
//
// It is also a hand-rolled loop rather than `/[ \t\n\r\f\v]+$/`, because that
// regex backtracks: every input passes through here on its way to the
// classifier, and a long run of leading whitespace made classification
// quadratic — 80,000 spaces cost 1.06 s, enough to exceed the hook timeout
// (Codex, PR #648 round 1). Scanning backwards is linear.
const ASCII_TRAILING_WS = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);
export function normalizePredicateSql(text) {
  const s = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let end = s.length;
  while (end > 0 && ASCII_TRAILING_WS.has(s[end - 1])) end--;
  return end === s.length ? s : s.slice(0, end);
}

// Each fingerprint maps to the predicate FILE it came from, so a wrapped sweep
// query (below) can be held to the name the runner gives that file.
// >>> BEGIN GENERATED PREDICATE FINGERPRINTS — do not hand-edit
export const KNOWN_SWEEP_PREDICATES = new Map([
  ["2ad3ccf677742b436ce793ea7c1fc56b4531500ad6841d38a87b4475224660df", "actor-forgery-fin-audit.sql"],
  ["ec304e4e2f10d420220a5df36982fe90a19f3f8230a8a3d0cbbe488eb36abc72", "actor-forgery.sql"],
  ["2e8bdab505e2e9b858462f0cdaae6c5a701c3c2ea362c1133a782a4234b30376", "anon-exec-secdef.sql"],
  ["3c1f93e2a1fe90b8e8aad9145f981904906116fae175696eecd9dce1b2061ed8", "audit-log-completeness.sql"],
  ["5c49a1f5d8afca87439cf87fc1a74ffebaa38de68cb5eb1790109fc0a8dce1e6", "auth-bound-role-ungated.sql"],
  ["c9a03c9a022912fdbf263251f3ec48155cf49259cf097f23a3daf28d445d4a54", "commission-admin-active.sql"],
  ["c769b15bf97485e4d8b1d7457a8ed9a726627a57ec1c16c06c198308d8984f0d", "dispatch-sync-nonqualifying-profile.sql"],
  ["b15716e33a3061f3ebced1eb6b4ca20b90ec53c5967f4a34531ec8e56088ff08", "fin-allocations-bounded.sql"],
  ["61e703c79b85374001fd80719e0faa00bda1b5f899cb66d5cd4b04ba5a1693b6", "fin-ar-statement-balance.sql"],
  ["11cd6482c1e98dd6c32a7ef7f17c9dc3d49511e554cd1841d6028a166bcbea3d", "fin-commission-split-sum.sql"],
  ["d333bf15256b8b9bc1e6b488d73ebfc90926837691aa54d8a7a027edaabd5e6e", "fin-invoice-balance-identity.sql"],
  ["90d85c6c218f5e96d08c7dd51994e0a7b950fa5522f77f76388bb775fc16b5d8", "fin-money-whole-cents.sql"],
  ["ad224d20046ea896cab17d5a4ec7fb5bbaf0e5836943902dc6c991e194f20217", "fin-po-receipt-identity.sql"],
  ["0f34426fbf1478e559f747a7a8c3c927834bea339903571ef941ac42feef0389", "fin-prepay-balance.sql"],
  ["204a287787bb5b46340e9b113afb80e75f8c6ac18163a3bf220db6bcd55d9144", "fin-quote-override-survival.sql"],
  ["d9d1fe470cd37287d77e50ffa7ef8b160743068b72cea79fa0f335b579096f85", "fin-vendor-bill-balance-identity.sql"],
  ["7316cc7f33a2c0717029689cb40b9831250b0884bd7ad8dc904a00e4102614a2", "office-only-pricing-secdef-gates.sql"],
  ["d339b02e5022edaf87748ec20540d3a451e5a67e4dfcd69961267f7a00f9fd6c", "overloads.sql"],
  ["1a9179b05963dc315c90e54b2fd18445e21d58cae9bdb743111607b9de7e8e86", "plpgsql-check.sql"],
  ["071d89aae1ef714720386c43c9ac6a4c11cc03edb0f00bdcd152ba52079db216", "product-name-vs-return-policy.sql"],
  ["5ea47dde9df5671b8b4acce4e274f242467e3eb71eeb0b3487c8940316a3019d", "profile-role-lock-insert-arm.sql"],
  ["995aa5e0e757aea9be90be9d7d49db6c1220ba3d593ee3998137615193738c02", "quote-versions-rpc-owned.sql"],
  ["7c6edab973d810b5c6e7abc34b4121376609fd82cb82f3905075e01975e29e17", "return-credit-intent-binding.sql"],
  ["e86e0b0d2f61073fce6110913bf9260a9332f92d29c295a61d1a7810345dda49", "returns-lifecycle-rpc-owned.sql"],
  ["c1d531420c58198a15ab94eb3e805b1778c3c3a4100633f591240a58e1492f94", "save-field-actor-binding.sql"],
  ["09b24ce34cc1c13ad3939a4270a5dbef647ef0aef80cbba8861fd625edd6d0ce", "secdef-searchpath.sql"],
  ["a214ec21734991ea10daa54e7832dc9f814d41b18bb5523dcb5ea42f2f60e93b", "section9-po-ap-controls.sql"],
  ["f0bd806a01f9114345eb47a0e1523e54a9e5ef7d2e8b40dfbd47f278bfe4503b", "status-literals.sql"],
  ["dbaa1cfe6d3d81ca66c8f44ac9085d8b9c47e507733cd708c4de2ead823b53c1", "ungated-secdef-mutators.sql"],
]);
// <<< END GENERATED PREDICATE FINGERPRINTS
// The Map above is the ONLY list: both allowances read it, and the generator's
// "overridden" check compares it to the files. A second derived collection would
// be a list the generator does not watch (Luna review of this change).

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function isKnownSweepPredicate(query) {
  const text = normalizePredicateSql(query || "");
  if (!text) return false;
  if (!KNOWN_SWEEP_PREDICATES.size) return false;
  return KNOWN_SWEEP_PREDICATES.has(sha256Hex(text));
}

// ── The sweep runner's WRAPPED queries, recognised by reconstruction ─────────
//
// The runner does not send a bare predicate. It wraps each one in a fixed
// envelope that also reads the reviewed function contracts in the same
// snapshot (scripts/db-invariant-sweeps/allowlist-match.mjs buildSweepQuery),
// and --adjudicate rejects any packet without them. A bare-predicate allowance
// therefore never produced an adjudicable sweep: every wrapped query fell to
// the classifier below and was refused (2 as audit-log writes, 27 as calls to
// `predicate()`, `suite()`, `oidvectortypes()` and friends).
//
// The envelope is DEFINED HERE, in the approval-gated hook file, and the runner
// imports it. If the guard trusted a template kept under scripts/, an ordinary
// edit to that script could change what the guard accepts — the manifest
// bypass described above, through the template instead of the hash list.
//
// Recognition is not parsing. The query is cut at the envelope's fixed
// markers into three parts: a predicate name, the inner predicate text and the
// list of function keys whose contracts it reads. Then ALL of the following
// must hold, or the query falls through to the ordinary classifier untouched:
//   - the inner text is one of the fingerprinted predicates above, and the name
//     is that predicate's own file name (the runner's `basename(file, '.sql')`);
//   - every function key is a `public.`/`auth.` identity signature of printable
//     ASCII with no single quote and no backslash, so a key cannot leave its
//     string literal however standard_conforming_strings is set (schema-
//     qualified argument types and quoted identifiers stay allowed: a `.` or a
//     `"` inside a single-quoted literal is inert);
//   - rebuilding the envelope from those three parts reproduces the query
//     byte for byte (after the same line-ending/BOM/trailing-whitespace
//     normalisation the bare predicates get).
// The last check makes the cut points irrelevant to safety: a wrong cut
// produces a different rebuild, and a different rebuild is a refusal. What can
// pass is exactly {known predicate} x {fixed read-only envelope} x {inert key
// literals} — every one a catalog read.
const SWEEP_HEAD = "SELECT json_build_object(\n  'predicate', '";
const SWEEP_ROWS_OPEN = "',\n  'rows', (SELECT COALESCE(json_agg(v), '[]'::json) FROM (\n";
const SWEEP_ROWS_CLOSE = "\n) AS v),\n  'function_contracts', ";
const SWEEP_TAIL = "\n) AS sweep_result;";
const SWEEP_NO_CONTRACTS = "'[]'::json";
const SWEEP_CONTRACTS_OPEN = "(SELECT COALESCE(json_agg(c), '[]'::json) FROM (";
const SWEEP_CONTRACTS_CLOSE = ") AS c)";
const CONTRACT_KEYS_OPEN = "= ANY(ARRAY[";
const CONTRACT_KEYS_CLOSE = "]::text[])\nORDER BY function_key";
// Printable ASCII (0x20-0x7E) minus `'` (0x27) and `\` (0x5C).
const CONTRACT_KEY_RE = /^(?:public|auth)\.[\x20-\x26\x28-\x5b\x5d-\x7e]*\)$/;

/** Full definition includes body/defaults/volatility/security/search_path; pin owner and ACL too. */
export function functionContractSql(functionKeys) {
  const literals = [...new Set(functionKeys)].sort()
    .map((key) => `'${key.replaceAll("'", "''")}'`).join(', ');
  return `SELECT
  n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS function_key,
  pg_catalog.md5(pg_catalog.jsonb_build_object(
    'definition', pg_catalog.pg_get_functiondef(p.oid),
    'owner', pg_catalog.pg_get_userbyid(p.proowner),
    'data_api_execute', pg_catalog.jsonb_build_object(
      'anon', CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')
        THEN pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') ELSE NULL END,
      'authenticated', CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated')
        THEN pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') ELSE NULL END,
      'service_role', CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
        THEN pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') ELSE NULL END
    ),
    'execute_acl', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
        'grantor', pg_catalog.pg_get_userbyid(a.grantor),
        'grantable', a.is_grantable
      ) ORDER BY (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END),
        pg_catalog.pg_get_userbyid(a.grantor), a.is_grantable)
      FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
      WHERE a.privilege_type = 'EXECUTE'
    ), '[]'::jsonb)
  )::text) AS contract_md5
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE p.prokind IN ('f', 'p') AND n.nspname IN ('public', 'auth')
  AND (n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')')
    ${CONTRACT_KEYS_OPEN}${literals}${CONTRACT_KEYS_CLOSE}`;
}

/**
 * The sweep envelope: predicate rows and the requested function contracts in ONE statement.
 * `sql` is the predicate with its trailing semicolon already removed; buildSweepQuery validates it.
 */
export function renderSweepQuery(name, sql, functionKeys) {
  const contracts = functionKeys.length === 0 ? SWEEP_NO_CONTRACTS :
    `${SWEEP_CONTRACTS_OPEN}${functionContractSql(functionKeys)}${SWEEP_CONTRACTS_CLOSE}`;
  return `${SWEEP_HEAD}${name.replaceAll("'", "''")}${SWEEP_ROWS_OPEN}${sql}${SWEEP_ROWS_CLOSE}${contracts}${SWEEP_TAIL}`;
}

// The keys a contracts clause requests, or null when the clause is not one
// functionContractSql could have produced from plain identity signatures.
function sweepContractKeys(clause) {
  if (clause === SWEEP_NO_CONTRACTS) return [];
  const close = `${CONTRACT_KEYS_CLOSE}${SWEEP_CONTRACTS_CLOSE}`;
  if (!clause.startsWith(SWEEP_CONTRACTS_OPEN) || !clause.endsWith(close)) return null;
  const open = clause.lastIndexOf(CONTRACT_KEYS_OPEN);
  if (open === -1) return null;
  const list = clause.slice(open + CONTRACT_KEYS_OPEN.length, clause.length - close.length);
  if (list.length < 2 || !list.startsWith("'") || !list.endsWith("'")) return null;
  const keys = list.slice(1, -1).split("', '");
  return keys.every((key) => CONTRACT_KEY_RE.test(key)) ? keys : null;
}

export function isKnownSweepQuery(query) {
  const text = normalizePredicateSql(query || "");
  if (!text.startsWith(SWEEP_HEAD) || !text.endsWith(SWEEP_TAIL)) return false;
  const nameEnd = text.indexOf(SWEEP_ROWS_OPEN, SWEEP_HEAD.length);
  const rowsEnd = text.lastIndexOf(SWEEP_ROWS_CLOSE);
  if (nameEnd === -1 || rowsEnd < nameEnd + SWEEP_ROWS_OPEN.length) return false;
  const name = text.slice(SWEEP_HEAD.length, nameEnd);
  const sql = text.slice(nameEnd + SWEEP_ROWS_OPEN.length, rowsEnd);
  const keys = sweepContractKeys(text.slice(rowsEnd + SWEEP_ROWS_CLOSE.length, text.length - SWEEP_TAIL.length));
  if (!keys) return false;
  // The runner strips the predicate's final `;` (a predicate file may also have
  // none), so the inner text never ends in one.
  if (/;\s*$/.test(sql)) return false;
  const file = KNOWN_SWEEP_PREDICATES.get(sha256Hex(normalizePredicateSql(`${sql};`))) ??
    KNOWN_SWEEP_PREDICATES.get(sha256Hex(normalizePredicateSql(sql)));
  if (file !== `${name}.sql`) return false;
  return renderSweepQuery(name, sql, keys) === text;
}

// realDataOk: Mason authorized a real write (a fresh REAL-DATA-OK marker,
// checked by the guard). It relaxes ONLY ordinary writes — real inserts and
// updates and money-column updates — and classification keeps going, so a
// later DELETE or TRUNCATE in the same batch is still caught. Audit-log writes,
// TRUNCATE, DDL/GRANT, sequence changes, RPC calls, deletes and cancels/voids
// stay blocked regardless (2026-10-23: a stale marker left from a smoke run had
// switched every rule off in 15 checkouts).
const REAL_WRITE_OVERRIDE_HINT = "If Mason explicitly asked for a REAL write in this conversation, record it in .claude/session-state/REAL-DATA-OK with the current UTC time as the first line (e.g. `2026-10-23T21:00:00Z Mason OK: <what he approved>`); it lapses after 2 hours. Delete it when done.";

export function classifySql(query, { realDataOk = false } = {}) {
  // Convert ONCE and judge that one string. Converting separately for the
  // recognition check and the classifier let a value whose toString changes
  // between calls read differently to each, where base converted once (Codex,
  // PR #648 round 7). Unreachable from a JSON hook payload, but it keeps
  // "untouched for every other input" literally true.
  const q = String(query || "");
  if (isKnownSweepPredicate(q)) return { block: false, kind: "known-sweep-predicate" };
  if (isKnownSweepQuery(q)) return { block: false, kind: "known-sweep-query" };
  return classifySqlInner(q, realDataOk);
}

function classifySqlInner(query, realDataOk) {
  const q = String(query || "");
  if (!q) return { block: false };

  // Pattern checks run against the stripped text (machine content removed).
  // The rolled-back-smoke structure below still reads the ORIGINAL text: the
  // RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' marker lives inside a DO body, and a
  // COMMIT anywhere (even inside a DO body) must keep disqualifying the batch.
  // A dollar-quote tag glued to a letter or digit (`a$x$`, `1$x$`) is read one
  // way after a name and another after a number; either wrong guess can hide SQL
  // as a string or a comment, so the ambiguous spelling is refused outright
  // (automated security review, 2026-10-25).
  if (/[A-Za-z0-9_$\u0080-￿]\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.test(q)) {
    return {
      block: true,
      kind: "ambiguous-dollar-quote",
      reason: "This SQL has a dollar quote ($tag$ or $$) written right after a letter or digit, which can be read as part of a name or as a string. Put a space before the dollar quote.",
    };
  }

  const t = stripDollarQuoted(q);

  // 1. financial_audit_log is append-only, written only by triggers/RPCs — a Hard
  //    Red Line. No [E2E] exemption and no REAL-DATA-OK override.
  if (AUDIT_LOG_WRITE_RE.test(t)) {
    return {
      block: true,
      kind: "audit-log-write",
      reason: "This writes to financial_audit_log by hand. The audit log is append-only and written ONLY by the database's own triggers/RPCs (Hard Red Line). If a correction is genuinely needed, it is Mason's call — surface the row IDs instead.",
    };
  }

  // 2. TRUNCATE has no legitimate execute_sql use against the live DB.
  if (TRUNCATE_RE.test(t)) {
    return {
      block: true,
      kind: "truncate",
      reason: "TRUNCATE wipes a live table and is never done via raw SQL here. If data really must be cleared, that is Mason's explicit call via the migration path.",
    };
  }

  // 3. Schema changes (DDL, GRANT/REVOKE) must travel the migration gauntlet —
  //    a rolled-back smoke batch is the one exception. "Rolled back" must be
  //    STRUCTURAL, not textual (Codex 2026-07-05: `SELECT 'SMOKE_PASS_ROLLBACK'`
  //    used to qualify): either a real transaction wrapper (BEGIN is the first
  //    statement AND ROLLBACK is the last), or a DO-block smoke that force-aborts
  //    via an actual RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'. Any statement-anchored
  //    COMMIT disqualifies the batch.
  const hasCommitStmt = /(?:^|;)\s*commit\b/i.test(q);
  const txWrapped = /^\s*begin\s*;[\s\S]*;\s*rollback\s*;?\s*$/i.test(q);
  const smokeAbort = /raise\s+exception\s+'?SMOKE_PASS_ROLLBACK/i.test(q);
  const rolledBack = !hasCommitStmt && (txWrapped || smokeAbort);
  if (!rolledBack && (DDL_STMT_RE.test(t) || GRANT_REVOKE_RE.test(t))) {
    return {
      block: true,
      kind: "raw-ddl",
      reason: "This changes the live database schema (or grants) via raw execute_sql, which routes around the entire migration review gauntlet. Put the change in a supabase/migrations/ file and go through apply_migration (with its reviews), or wrap the batch in BEGIN; ... ROLLBACK; if this is a smoke test.",
    };
  }

  // 3b. Side-effecting expressions hidden inside SELECT (Codex P1 round 3,
  //     PR #352): setval/nextval mutate live sequence state (e.g. invoice
  //     numbering), and the app's mutating RPCs can be invoked via a plain
  //     SELECT fn(...). Neither is a read. No [E2E] exemption — these change
  //     shared state regardless of marker, and REAL-DATA-OK does not relax them:
  //     the delete/cancel rules cannot see inside a function body, and a list
  //     of "destructive" names never converges (Luna 2026-10-23: a quoted
  //     "void_invoice" and destroy_customer slipped one). A real RPC call goes
  //     through the app. A sequence change is never undone by a ROLLBACK.
  //     currval/lastval remain allowed (true reads).
  if (/\b(?:setval|nextval)\s*\(/i.test(t)) {
    return {
      block: true,
      kind: "sequence-mutation",
      reason: "setval()/nextval() changes live sequence state (e.g. invoice numbering) even inside a SELECT. Read with currval()/last_value instead; a real sequence change belongs in a reviewed migration.",
    };
  }
  const rpc = findNonReadFunctionCall(t);
  if (rpc) {
    return {
      block: true,
      kind: "rpc-via-select",
      reason: `This statement invokes "${rpc}()", which is not a known read-only function — calling an application RPC changes live data even when the statement starts with SELECT. Use the app; REAL-DATA-OK does not cover RPC calls. (Read-prefixed functions like get_/check_/list_ and SQL builtins stay allowed.)`,
    };
  }

  // Comments removed, DO bodies included, so `-- [E2E]` or `/* [E2E] */` cannot
  // exempt anything below.
  const code = stripCommentsQuoteAware(t, { intoDollarBodies: true });
  const scan = findWrites(code);
  if (scan.block) return scan;
  const real = scan.writes.filter((w) => !w.fake);
  const isFin = (w) => FINANCIAL_TABLES.includes(w.table);

  // 4. Deletes, cancels/voids and MERGEs that do not target [E2E] rows, and any
  //    insert or update spelled inside a string literal (its SET list cannot be
  //    read). Never relaxed.
  for (const w of real) {
    if (w.verb === "merge") {
      return {
        block: true,
        kind: "real-merge",
        reason: `This MERGEs into the live business table "${w.table}". MERGE can update, insert and delete in one statement, so it is refused even for [E2E] rows and with REAL-DATA-OK; write the separate INSERT/UPDATE/DELETE statements instead.`,
      };
    }
    if (w.dynamic && w.verb !== "delete") {
      return {
        block: true,
        kind: "dynamic-sql-write",
        reason: `This SQL spells an ${w.verb.toUpperCase()} of the live business table "${w.table}" inside a string literal (dynamic SQL such as EXECUTE '…'). The guard cannot read what it changes, so it is refused even with REAL-DATA-OK: write the statement out plainly. For a catalog search, break up the words (e.g. ILIKE '%${w.verb}%${w.table}%').`,
      };
    }
    if (w.verb === "delete" && isFin(w)) {
      return {
        block: true,
        kind: "financial-delete",
        reason: `This DELETEs from the live financial table "${w.table}". Deleting real financial records is Mason's call — surface the record IDs in your findings instead of acting. REAL-DATA-OK does not cover deletes; a real deletion goes through a reviewed migration. ${E2E_TARGET_HINT}`,
      };
    }
    if (w.verb === "update" && isFin(w) && CANCEL_VOID_SET_RE.test(w.text)) {
      return {
        block: true,
        kind: "financial-cancel",
        reason: `This cancels/voids a real record in "${w.table}". Cancelling/voiding live invoices/orders/payments is Mason's job — surface the IDs, don't act. REAL-DATA-OK does not cover cancels or voids. ${E2E_TARGET_HINT}`,
      };
    }
    if (w.verb === "delete") {
      return {
        block: true,
        kind: "real-delete",
        reason: `This DELETEs from the live business table "${w.table}" without targeting [E2E] fake rows. Deleting real records is Mason's call — surface the record IDs instead of acting. REAL-DATA-OK does not cover deletes; a real deletion goes through a reviewed migration. ${E2E_TARGET_HINT}`,
      };
    }
  }
  if (realDataOk) return { block: false };

  // 5. Ordinary writes that do not target [E2E] rows (a fresh REAL-DATA-OK relaxes these).
  let w = real.find((x) => x.verb === "insert");
  if (w) {
    return {
      block: true,
      kind: "real-insert",
      reason: `This INSERTs into the live business table "${w.table}" without the [E2E] fake-data marker. On the LIVE app, use only clearly-fake [E2E]-prefixed entities for analysis (and delete them when done). ${E2E_TARGET_HINT} ${REAL_WRITE_OVERRIDE_HINT}`,
    };
  }
  // Money-amount edits on financial tables (SET clause only, not the WHERE part).
  w = real.find((x) => x.verb === "update" && isFin(x) &&
    MONEY_COL_RE.test((x.text.match(/\bset\b([\s\S]*)/i)?.[1] ?? "").split(/\bwhere\b/i)[0]));
  if (w) {
    return {
      block: true,
      kind: "financial-amount-update",
      reason: `This UPDATEs a money column on the live financial table "${w.table}" via raw SQL. Real financial amounts change only through the app's RPCs (or Mason's explicit REAL-DATA-OK authorization) — surface the row IDs and the proposed correction instead. ${E2E_TARGET_HINT}`,
    };
  }
  w = real.find((x) => x.verb === "update");
  if (w) {
    return {
      block: true,
      kind: "real-update",
      reason: `This UPDATEs the live business table "${w.table}" without targeting [E2E] fake rows. On the LIVE app, use only clearly-fake [E2E]-prefixed entities for analysis (and delete them when done). ${E2E_TARGET_HINT} ${REAL_WRITE_OVERRIDE_HINT}`,
    };
  }

  return { block: false };
}

// ── The [E2E] fake-data exemption, judged per write (2026-10-25) ─────────────
// A write is exempt only when the write ITSELF shows it touches [E2E] rows:
//   - an INSERT … VALUES has, in EVERY row, a value that is exactly a string
//     literal containing [E2E] (and is not ON CONFLICT … DO UPDATE, which can
//     overwrite a real row); INSERT … SELECT does not show its rows, so it is
//     never exempt;
//   - an UPDATE or DELETE has, at the top level of its own WHERE clause, a
//     conjunct `<column> = | LIKE '<text containing [E2E]>'`, joined to
//     the rest only by AND, with no OR, no USING/FROM join and nothing nested.
//     ANDing that conjunct narrows the write to rows that carry the marker, so
//     `DELETE FROM invoices WHERE id = 7 AND notes = '[E2E]'` touches invoice 7
//     only if invoice 7 is itself marked. Nothing else counts: a marker in a
//     comment, in another statement, in the SET list, in a subquery
//     (`id IN (SELECT 7 FROM customers WHERE name LIKE '[E2E]%')`), after an OR,
//     or as a tautology (`'[E2E]' = '[E2E]'`).
// Before 2026-10-23 one [E2E] anywhere in the batch exempted everything; until
// 2026-10-25 it still exempted every insert/update (comment included), and a
// delete with the marker anywhere in it (Luna, PR #1084).
// A regex classifier cannot see what a subquery or a foreign key reaches, so
// whatever it cannot prove is refused: clearing [E2E] child rows needs a marker
// on the child row itself, or a delete of the marked parent.
const E2E_TARGET_HINT = "To work on fake data, an INSERT … VALUES must have an '[E2E]…' string value in every row, and an UPDATE or DELETE needs `AND <column> LIKE '[E2E]%'` (or `= '[E2E] …'`) at the top level of its own WHERE clause, outside any DO block (where a name may be a variable); a marker in a comment, another statement, the SET list or a subquery does not count.";

const MARKER_IDENT = `(?:"[^"]+"|[a-z_][a-z0-9_$]*)`;
// `=` and LIKE only: ILIKE would also match a real row named "[e2e] …" (Luna round 3).
const MARKER_PREDICATE_RE = new RegExp(`^(${MARKER_IDENT})(?:\\s*\\.\\s*(${MARKER_IDENT}))?\\s*(?:=|like)\\s*'((?:[^']|'')*)'$`, "i");
// Bare words that parse as values, not columns, so they can never name a marked row.
const VALUE_KEYWORDS = new Set(["true", "false", "null", "user", "current_user", "session_user", "current_role",
  "system_user", "current_catalog", "current_schema", "current_date", "current_time", "current_timestamp",
  "localtime", "localtimestamp"]);

// A same-length copy of `code` with the contents of single-quoted literals and
// quoted identifiers blanked, plus a flag for each character inside a
// single-quoted literal and for each inside a dollar-quoted span. Dollar quotes
// are code here: classifySqlInner already blanked every body except a DO
// block's, whose statements execute. An unterminated quote runs to the end, so
// nothing after it can be exempt.
function maskQuotes(code) {
  const n = code.length;
  const masked = code.split("");
  const inLiteral = new Uint8Array(n);
  const inDollar = new Uint8Array(n);
  let dollarEnd = 0;
  let i = 0;
  while (i < n) {
    const ch = code[i];
    if (ch === "$" && i >= dollarEnd) {
      const tag = dollarTagAt(code, i);
      if (tag) {
        const close = code.indexOf(tag[0], i + tag[0].length);
        dollarEnd = close === -1 ? n : close + tag[0].length;
        inDollar.fill(1, i, dollarEnd);
        i += tag[0].length; continue;
      }
    }
    const escapeString = (ch === "e" || ch === "E") && code[i + 1] === "'" &&
      !/[A-Za-z0-9_$]/.test(code[i - 1] || "");
    if (ch === "'" || escapeString) {
      const start = i + (escapeString ? 2 : 1);
      let j = start, end = n;
      while (j < n) {
        if (escapeString && code[j] === "\\") { j += Math.min(2, n - j); continue; }
        if (code[j] === "'" && code[j + 1] === "'") { j += 2; continue; }
        if (code[j] === "'") { end = j; j++; break; }
        j++;
      }
      for (let k = start; k < end; k++) { masked[k] = " "; inLiteral[k] = 1; }
      i = j; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && code[j] !== '"') j++;
      for (let k = i + 1; k < j; k++) masked[k] = " ";
      i = j + 1; continue;
    }
    i++;
  }
  return { masked: masked.join(""), inLiteral, inDollar };
}

// Only what sits at parenthesis depth 0; anything nested (and the parens) becomes spaces.
function topLevel(s) {
  let depth = 0, out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    out += depth === 0 && ch !== ")" && ch !== "(" ? ch : " ";
    if (ch === ")") depth--;
  }
  return out;
}

// Where the write starting at `start` ends: its `;`, or the `)` closing the CTE it sits in.
function writeEnd(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === ";") return i;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return i;
  }
  return masked.length;
}

function isMarkerPredicate(conjunct) {
  const m = MARKER_PREDICATE_RE.exec(conjunct.trim());
  return !!m && m[3].includes("[E2E]") && (!!m[2] || !VALUE_KEYWORDS.has(m[1].toLowerCase()));
}

// One VALUES row, text[s..e) inside its parentheses: true when one of its
// values is exactly a string literal containing [E2E].
function rowCarriesMarker(text, masked, s, e) {
  let depth = 0, from = s;
  for (let i = s; i <= e; i++) {
    const ch = i < e ? masked[i] : ",";
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      const value = text.slice(from, i).trim();
      if (/^'(?:[^']|'')*'$/.test(value) && value.includes("[E2E]")) return true;
      from = i + 1;
    }
  }
  return false;
}

// `headLen` is the length of the `INSERT INTO t` / `UPDATE t` / `DELETE FROM t` head.
function targetsFakeRows(verb, text, masked, inLiteral, headLen) {
  // A comment or dollar quote left at code level means the text could not be
  // cleaned, so code and data cannot be told apart.
  if (/--|\/\*|\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.test(masked)) return false;
  // With standard_conforming_strings off (settable per session, even in an earlier
  // call) a backslash escapes a quote in an ordinary string, so where a literal
  // ends cannot be known from the text (Luna round 3).
  if (text.includes("\\")) return false;
  const flat = topLevel(masked);
  if (verb === "insert") {
    // Every row of a plain VALUES list must carry the marker: one marked row
    // does not make its neighbours fake, and a literal in RETURNING marks
    // nothing. INSERT … SELECT and DEFAULT VALUES do not show their rows.
    if (/\bon\s+conflict\b[\s\S]*\bdo\s+update\b/i.test(flat)) return false;
    const values = flat.search(/\bvalues\b/i);
    if (values === -1) return false;
    if (!/^\s*(?:as\s+\S+\s*)?(?:overriding\s+(?:system|user)\s+value\s*)?$/i.test(flat.slice(headLen, values))) return false;
    let depth = 0, rowStart = 0, rows = 0;
    for (let i = values + "values".length; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "(") { if (depth++ === 0) rowStart = i + 1; continue; }
      if (ch === ")") {
        if (--depth === 0) {
          if (!rowCarriesMarker(text, masked, rowStart, i)) return false;
          rows++;
        }
        continue;
      }
      if (depth > 0 || /[\s,]/.test(ch)) continue;
      // After the rows only ON CONFLICT … DO NOTHING or RETURNING may follow
      // (not UNION, ORDER BY or another row source).
      return rows > 0 && /^(?:on\s+conflict\b|returning\b)/i.test(flat.slice(i));
    }
    return rows > 0 && depth === 0;
  }
  const afterVerb = flat.slice(headLen);
  if (/\b(?:from|using)\b/i.test(afterVerb)) return false;
  const where = flat.search(/\bwhere\b/i);
  if (where === -1) return false;
  const bodyStart = where + "where".length;
  // OR or BETWEEN anywhere after WHERE (RETURNING included, so a column that
  // merely looks like RETURNING cannot hide one) makes the AND-split unsound.
  if (/\b(?:or|between)\b/i.test(flat.slice(bodyStart))) return false;
  const returning = flat.slice(bodyStart).search(/\breturning\b/i);
  const bodyEnd = returning === -1 ? flat.length : bodyStart + returning;
  const body = flat.slice(bodyStart, bodyEnd);
  let from = bodyStart;
  for (const and of body.matchAll(/\band\b/gi)) {
    if (isMarkerPredicate(text.slice(from, bodyStart + and.index))) return true;
    from = bodyStart + and.index + 3;
  }
  return isMarkerPredicate(text.slice(from, bodyEnd));
}

// Every write on a live business table in `code`, each with its own text and
// whether it provably targets [E2E] rows: `{ block: false, writes }`, or a
// refusal when the text hides what it writes. A write found inside a string
// literal is marked `dynamic` (EXECUTE '…', or text that only looks like SQL):
// it is never exempt and its extent is not measured, which keeps a literal
// packed with write keywords linear instead of quadratic.
function findWrites(code) {
  const { masked, inLiteral, inDollar } = maskQuotes(code);
  // U&"custome\0072s" is the customers table, spelled so no name list can match it.
  if (/\bu&"/i.test(masked)) {
    return {
      block: true,
      kind: "unicode-identifier",
      reason: "This SQL spells a name with a Unicode escape (U&\"…\"), which hides which table it touches. Write the name plainly.",
    };
  }
  // EXECUTE in a DO body runs SQL assembled at run time ('UPDATE ' || 'customers …'),
  // which no text check can read.
  for (const m of masked.matchAll(/\bexecute\b/gi)) {
    if (inDollar[m.index]) {
      return {
        block: true,
        kind: "dynamic-sql",
        reason: "This DO block runs dynamic SQL with EXECUTE, so the guard cannot see what it writes; it is refused even with REAL-DATA-OK. Write each statement out plainly.",
      };
    }
  }
  // COPY … FROM loads rows (from a server file, or a shell command with
  // FROM PROGRAM) without any INSERT; COPY (query) TO only reads.
  // Real statements end at their own `;` or `)`, so their extents barely overlap;
  // only malformed text (writes with no terminator) makes them pile up.
  let budget = 8 * code.length + 100000;
  const tooTangled = {
    block: true,
    kind: "unclassifiable-writes",
    reason: "This SQL holds so many overlapping, unterminated writes to live business tables that the guard cannot check them in time, so it is refused. End each statement with `;`.",
  };
  for (const m of masked.matchAll(/\bcopy\b/gi)) {
    const end = writeEnd(masked, m.index);
    if ((budget -= end - m.index) < 0) return tooTangled;
    if (/\bfrom\b/i.test(topLevel(masked.slice(m.index, end)))) {
      return {
        block: true,
        kind: "copy-from",
        reason: "COPY … FROM loads rows into a live table (or runs a program with FROM PROGRAM) and is never done through execute_sql, even with REAL-DATA-OK. Write [E2E] rows with INSERT … VALUES.",
      };
    }
  }
  const writes = [];
  for (const m of code.matchAll(WRITE_RE)) {
    const start = m.index;
    const verb = m[1].toLowerCase().match(/^(insert|update|delete|merge)/)[1];
    const table = m[2].toLowerCase();
    if (inLiteral[start] || verb === "merge") {
      writes.push({ verb, table, text: m[0], fake: false, dynamic: !!inLiteral[start] });
      continue;
    }
    const end = writeEnd(masked, start);
    if ((budget -= end - start) < 0) return tooTangled;
    const text = code.slice(start, end);
    // Inside a DO body any name in a WHERE may be a PL/pgSQL variable, not a
    // column: `AND v_note = '[E2E]'` is always true, and a block label or a
    // session-wide `plpgsql.variable_conflict = use_variable` can even capture a
    // qualified `c.name`. So a DO-body UPDATE/DELETE is never provably fake (its
    // VALUES literals still are, so marked inserts in smoke blocks pass).
    const fake = !(inDollar[start] && verb !== "insert") &&
      targetsFakeRows(verb, text, masked.slice(start, end), inLiteral.subarray(start, end), m[0].length);
    writes.push({ verb, table, text, fake, dynamic: false });
  }
  return { block: false, writes };
}

// ── Destructive-migration classifier (Mason's settled 2026-07-13 policy) ─────
// Detects APPLY-TIME data destruction in a migration's SQL: DROP TABLE,
// ALTER TABLE ... DROP COLUMN, TRUNCATE, or ANY top-level DELETE FROM. Runs
// against stripDollarQuoted() output, so a DELETE inside a CREATE FUNCTION
// body (which does NOT execute at apply time) doesn't count — but a DO block's
// body does (it executes immediately).
// The DELETE rule is deliberately GENERIC — no table allowlist (Codex P1
// 2026-07-13 round 2: a hard-coded list missed live tables like invoice_shares
// and finance_charges; in a migration, a top-level DELETE is rare enough that
// every one deserves Mason's eyes). DROP POLICY/INDEX/TRIGGER/FUNCTION/
// CONSTRAINT are routine schema hygiene and deliberately do NOT match.
// Comments are removed before matching so prose like "-- never TRUNCATE here"
// can't false-positive. Conservative by design: used by migration-apply-guard
// to refuse a destructive apply in a hands-free run — a false positive parks
// the migration for the morning, a false negative would delete data with
// nobody watching.
export function destructiveMigrationCheck(sql) {
  // Strip ONLY clear function-definition bodies (AS $$...$$) — everything
  // else, including DO blocks however commented, stays visible (default-keep).
  const stripped = stripFunctionBodiesOnly(String(sql || ""));
  if (!stripped) return { destructive: false };
  // Quote-aware, NOT raw regex: a `/*` inside a string literal must not open a
  // fake comment span that swallows a real DELETE (Codex P1 round 5).
  const t = stripCommentsQuoteAware(stripped);
  if (/\bdrop\s+table\b/i.test(t)) return { destructive: true, reason: "DROP TABLE" };
  // DOMAIN/TYPE/EXTENSION drops can CASCADE into data-bearing columns/tables;
  // any of them in a migration is rare enough to deserve Mason's eyes
  // (Codex P1 2026-07-13 round 4).
  if (/\bdrop\s+(?:schema|database|owned|domain|type|extension)\b/i.test(t)) return { destructive: true, reason: "DROP SCHEMA/DATABASE/OWNED/DOMAIN/TYPE/EXTENSION" };
  // `COLUMN` is OPTIONAL in ALTER TABLE ... DROP <col> (Codex P1 round 4).
  // Match any ALTER TABLE ... DROP <thing> EXCEPT the non-data forms:
  // DROP CONSTRAINT, and the ALTER COLUMN sub-forms DROP NOT NULL / DROP
  // DEFAULT / DROP IDENTITY / DROP EXPRESSION.
  if (/\balter\s+table\b[^;]*\bdrop\s+(?!constraint\b|not\s+null\b|default\b|identity\b|expression\b)/i.test(t)) {
    return { destructive: true, reason: "ALTER TABLE ... DROP [COLUMN]" };
  }
  if (/\btruncate\b/i.test(t)) return { destructive: true, reason: "TRUNCATE" };
  if (/\bdelete\s+from\b/i.test(t)) return { destructive: true, reason: "top-level DELETE FROM (any table)" };
  // MERGE can delete matched rows (WHEN MATCHED THEN DELETE) — and is rare
  // enough in a migration that ANY top-level MERGE deserves Mason's eyes
  // (Codex P1 2026-07-13 round 3).
  if (/\bmerge\s+into\b/i.test(t)) return { destructive: true, reason: "MERGE INTO (can delete matched rows)" };
  return { destructive: false };
}

export { BUSINESS_TABLES, FINANCIAL_TABLES };
