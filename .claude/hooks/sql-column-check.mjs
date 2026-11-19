#!/usr/bin/env node
// PreToolUse column check for live execute_sql (Mason, 2026-11-16 retro).
// Bug pattern: one session lost 12 read-only live queries to guessed column
// names (oi.quantity, p.price_per_acre, p.default_rate_unit), retrying each.
// This refuses a query that names alias.column / table.column when the alias
// maps, through FROM or JOIN in the same statement, to a table in
// .claude/schema-registry.json that has no such column, and lists the real ones.
//
// Conservative by design (a false alarm is worse than a miss): anything it
// cannot resolve is allowed — CTE names, subquery or function aliases, aliases
// with column lists, aliases bound to two sources, non-public schemas
// (information_schema, pg_catalog), quoted identifiers, tables not in the
// registry. A missing or unreadable registry, or migrations folder, allows the
// query. A column added by a migration newer than the registry is allowed (the
// registry may be stale); comments in that migration do not count.
// Escape hatch: `-- column-check: skip` in a comment of the query.
// shortcut: a column added by a newer migration file is allowed even if that file
// is not applied live yet; the hook cannot see live, and guessing would refuse valid queries.
// Fail-open: no onFailure "block"; a crash allows the call.
// @proven-by sql-column-check.test.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Words that can follow a table name in FROM/JOIN but are not an alias.
const NOT_ALIAS = new Set(("where on using join inner left right full outer cross natural lateral group order " +
  "having limit offset union intersect except window for fetch returning set as with tablesample only").split(" "));

// Every table has these, though the registry does not list them.
// (`oid` is not one: user tables have had no oid column since PostgreSQL 12.)
const SYSTEM_COLUMNS = new Set(["ctid", "xmin", "xmax", "cmin", "cmax", "tableoid"]);

// Words the parser below reads as SQL; a quoted identifier spelling one stays opaque.
const PARSED_WORDS = new Set([...NOT_ALIAS, "from", "select", "not", "materialized", "public"]);

// Dollar-quoted text, strings, quoted identifiers and comments, left to right in one
// pass so `--` inside a string, or a quote inside a comment, cannot desynchronize the others.
const TOKEN_RE = /\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|[eE]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g;
const isComment = (t) => t.startsWith("--") || t.startsWith("/*");
const comments = (sql) => [...String(sql).matchAll(TOKEN_RE)].map((m) => m[0]).filter(isComment);

// The skip marker counts only inside a comment, not inside a string.
export function hasSkipMarker(sql) {
  return comments(sql).some((c) => /column-check:\s*skip/i.test(c));
}

// Comments become a space (block comments nest, as in Postgres); strings and quoted
// identifiers stay as written, since a migration's EXECUTE '...' can really add a column.
const TOKEN_AT = new RegExp(TOKEN_RE.source, "y");
export function stripComments(sql) {
  const s = String(sql);
  let out = "";
  for (let i = 0; i < s.length;) {
    if (s.startsWith("/*", i)) {
      let depth = 0;
      while (i < s.length) {
        if (s.startsWith("/*", i)) { depth++; i += 2; } else if (s.startsWith("*/", i)) { i += 2; if (--depth === 0) break; } else i++;
      }
      out += " ";
      continue;
    }
    TOKEN_AT.lastIndex = i;
    const t = TOKEN_AT.exec(s)?.[0];
    if (t) { out += t.startsWith("--") ? " " : t; i += t.length; } else out += s[i++];
  }
  return out;
}

// Strings become '', comments a space. A quoted identifier that is plain lowercase
// ("p", "order_items") means the same unquoted, so it is unquoted; any other becomes "q" (never matched).
function stripSql(sql) {
  return String(sql)
    .replace(TOKEN_RE, (t) => {
      if (t[0] === '"') {
        const name = t.slice(1, -1);
        return /^[a-z_][a-z0-9_]*$/.test(name) && !PARSED_WORDS.has(name) ? name : '"q"';
      }
      return t[0] === "'" || /^e'/i.test(t) ? "''" : " ";
    })
    .toLowerCase();
}

// Index of the "(" matching each ")" in a statement (strings already blanked).
function openParens(stmt) {
  const open = new Map(), stack = [];
  for (let i = 0; i < stmt.length; i++) {
    if (stmt[i] === "(") stack.push(i);
    else if (stmt[i] === ")" && stack.length) open.set(i, stack.pop());
  }
  return open;
}

// True when the parenthesis opening at `at` starts a FROM item: a subquery, or a
// function call, right after FROM, JOIN, LATERAL, ONLY or a comma. A comma may also
// start a select-list item; it still counts here (unresolvable, the safe side).
function startsFromItem(stmt, at) {
  if (at === undefined) return true;
  let before = stmt.slice(0, at).trimEnd();
  const fn = before.match(/(?:[a-z_]\w*\s*\.\s*)?([a-z_]\w*)$/);
  if (fn && !/^(?:from|join|lateral|only)$/.test(fn[1])) before = before.slice(0, fn.index).trimEnd();
  return /(?:\b(?:from|join|lateral|only)|,)$/.test(before);
}

// Returns [{ ref, table, column }] for every reference that is certainly wrong.
export function findBadColumns(sql, columnsByTable) {
  if (!columnsByTable || typeof columnsByTable !== "object") return [];
  // Postgres block comments nest; the stripper does not, so skip such a query.
  if (comments(sql).some((c) => c.startsWith("/*") && c.slice(2).includes("/*"))) return [];
  const bad = [];
  for (const stmt of stripSql(sql).split(";")) {
    const ctes = new Set();
    for (const m of stmt.matchAll(/\b([a-z_]\w*)\s*(?:\([^()]*\))?\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/g)) ctes.add(m[1]);

    const bindings = new Map(); // qualifier -> Set of table names (null = unresolvable)
    const bind = (q, t) => { if (!bindings.has(q)) bindings.set(q, new Set()); bindings.get(q).add(t); };
    // Subquery / function aliases in FROM: ") alias" — never resolvable. An output
    // name in the select list (count(*) as oi) is not a source and binds nothing.
    const open = openParens(stmt);
    for (const m of stmt.matchAll(/\)\s+(?:as\s+)?([a-z_]\w*)/g)) {
      if (!NOT_ALIAS.has(m[1]) && startsFromItem(stmt, open.get(m.index))) bind(m[1], null);
    }

    // Binds one FROM/JOIN item; returns whether a ", next_item" may follow it.
    const item = ([, first, second, rawAlias, aliasCols]) => {
      const schema = second ? first : "public";
      const table = second || first;
      const alias = rawAlias && !NOT_ALIAS.has(rawAlias) ? rawAlias : null;
      const known = schema === "public" && !ctes.has(table) && Array.isArray(columnsByTable[table]);
      bind(alias || table, known && !aliasCols ? table : null);
      return !rawAlias || alias !== null;
    };
    const tableRef = String.raw`(?:only\s+)?([a-z_]\w*)(?:\.([a-z_]\w*))?(?!\s*\(|\w|\.)(?:\s+(?:as\s+)?([a-z_]\w*))?(\s*\()?`;
    const fromRe = new RegExp(String.raw`\b(?:from|join)\s+${tableRef}`, "g");
    const commaRe = new RegExp(String.raw`\s*,\s*${tableRef}`, "y");
    // A function or subquery in a comma list: ", fn(" or ", (" (LATERAL allowed).
    const parenItemRe = /\s*,\s*(?:lateral\s+)?(?:[a-z_]\w*(?:\s*\.\s*[a-z_]\w*)?\s*)?\(/y;
    const aliasRe = /\s+(?:as\s+)?([a-z_]\w*)(\s*\()?/y;
    const close = new Map([...open].map(([c, o]) => [o, c]));
    // Index just past the ")" matching the "(" that ends at `at`, or -1.
    const past = (at) => (close.has(at - 1) ? close.get(at - 1) + 1 : -1);
    for (const m of stmt.matchAll(fromRe)) {
      // Tables listed after a comma: FROM orders o, order_items oi. A function, a
      // subquery or an alias column list in the list is stepped over, not a stop.
      let c = m;
      for (let at = 0; ;) {
        if (c) {
          if (!item(c)) break;
          at = c.index + c[0].length;
          if (c[4]) at = past(at);
        } else {
          parenItemRe.lastIndex = at;
          if (!parenItemRe.exec(stmt)) break;
          at = past(parenItemRe.lastIndex);
          aliasRe.lastIndex = at;
          const a = at >= 0 ? aliasRe.exec(stmt) : null;
          if (a && !NOT_ALIAS.has(a[1])) at = a[2] ? past(aliasRe.lastIndex) : aliasRe.lastIndex;
        }
        if (at < 0) break;
        commaRe.lastIndex = at;
        c = commaRe.exec(stmt);
        if (c && NOT_ALIAS.has(c[1])) c = null;
      }
    }

    for (const m of stmt.matchAll(/(?<![\w.$"])([a-z_]\w*)\.([a-z_]\w*)(?![\w.$"(]|\s*\()/g)) {
      const [, q, column] = m;
      const tables = bindings.get(q);
      if (!tables || tables.size !== 1 || ctes.has(q)) continue;
      const [table] = tables;
      if (!table) continue;
      if (!SYSTEM_COLUMNS.has(column) && !columnsByTable[table].includes(column)) bad.push({ ref: `${q}.${column}`, table, column });
    }
    // public.table.column: valid only when the table is in FROM without an alias.
    for (const m of stmt.matchAll(/(?<![\w.$"])public\.([a-z_]\w*)\.([a-z_]\w*)(?![\w.$"(]|\s*\()/g)) {
      const [, table, column] = m;
      const tables = bindings.get(table);
      if (!tables || tables.size !== 1 || !tables.has(table) || ctes.has(table)) continue;
      if (!SYSTEM_COLUMNS.has(column) && !columnsByTable[table].includes(column)) bad.push({ ref: `public.${table}.${column}`, table, column });
    }
  }
  const seen = new Set();
  return bad.filter((b) => !seen.has(b.ref) && seen.add(b.ref));
}

// Migrations stamped after the registry's high water, comments removed: the
// registry may not have their columns yet (see addedSinceRegistry). null when the
// folder or any such file cannot be read: the caller then allows the query, since
// the unread file may be the one that adds the column.
export function newerMigrations(migrationsDir, highWater) {
  try {
    if (!highWater) return [];
    return readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql") && (f.match(/^(\d+)/)?.[1] || "") > String(highWater))
      .map((f) => stripComments(readFileSync(path.join(migrationsDir, f), "utf8")).toLowerCase());
  } catch { return null; }
}

// One statement in a newer migration both names this table (ALTER TABLE or a view of
// that name) and adds/renames to this column, or names the column in that view.
export function addedSinceRegistry(newerFiles, table, column) {
  const col = `"?${column}"?\\b`;
  const tbl = `(?:"?public"?\\.)?"?${table}"?\\b`;
  const alters = new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${tbl}`);
  const adds = new RegExp(`\\badd\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?${col}|\\brename\\s+column\\s+\\S+\\s+to\\s+${col}`);
  const view = new RegExp(`\\bview\\s+(?:if\\s+not\\s+exists\\s+)?${tbl}`);
  return newerFiles.some((file) => file.split(";").some((stmt) => (alters.test(stmt) && adds.test(stmt)) ||
    (view.test(stmt) && new RegExp(`\\b${column}\\b`).test(stmt))));
}

function main() {
  let payload;
  try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { return; }
  if (!/execute_sql/i.test(String(payload?.tool_name || ""))) return;
  const sql = String(payload?.tool_input?.query || "");
  if (!sql || hasSkipMarker(sql)) return;

  const here = path.dirname(fileURLToPath(import.meta.url));
  let registry;
  try { registry = JSON.parse(readFileSync(path.join(here, "..", "schema-registry.json"), "utf8")); } catch { return; }

  let bad = findBadColumns(sql, registry?.columns);
  if (bad.length === 0) return;
  const newer = newerMigrations(path.join(here, "..", "..", "supabase", "migrations"), registry?._meta?.migrations_high_water);
  if (newer === null) return;
  bad = bad.filter((b) => !addedSinceRegistry(newer, b.table, b.column));
  if (bad.length === 0) return;

  const lines = bad.map((b) => `\`${b.ref}\`: table ${b.table} has no column "${b.column}". Its columns: ${registry.columns[b.table].join(", ")}.`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "COLUMN CHECK: " + lines.join(" | ") +
        ` (source: .claude/schema-registry.json, generated ${registry?._meta?.generated_at || "unknown"}). ` +
        "Fix the column name and retry. If the column is real and the registry is stale, run /regen-schema-registry " +
        "or add `-- column-check: skip` to the query.",
    },
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { /* fail-open */ }
  process.exit(0);
}
