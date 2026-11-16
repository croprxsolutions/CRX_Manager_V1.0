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
// registry. A missing or unreadable registry allows the query. A column named
// in a migration newer than the registry is allowed (the registry may be stale).
// Escape hatch: `-- column-check: skip` anywhere in the query.
// shortcut: tables after a comma in FROM and three-part names (schema.table.col)
// are not checked; add them only if guessed columns keep slipping through there.
// Fail-open: no onFailure "block"; a crash allows the call.
// @proven-by sql-column-check.test.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Words that can follow a table name in FROM/JOIN but are not an alias.
const NOT_ALIAS = new Set(("where on using join inner left right full outer cross natural lateral group order " +
  "having limit offset union intersect except window for fetch returning set as with tablesample only").split(" "));

// Every table has these, though the registry does not list them.
const SYSTEM_COLUMNS = new Set(["ctid", "oid", "xmin", "xmax", "cmin", "cmax", "tableoid"]);

// One left-to-right pass so `--` inside a string, or a quote inside a comment,
// cannot desynchronize the others. Quoted identifiers become "q" (never matched).
function stripSql(sql) {
  return String(sql)
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|[eE]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g,
      (t) => (t[0] === '"' ? '"q"' : t[0] === "'" || /^e'/i.test(t) ? "''" : " "))
    .toLowerCase();
}

// Returns [{ ref, table, column }] for every reference that is certainly wrong.
export function findBadColumns(sql, columnsByTable) {
  if (!columnsByTable || typeof columnsByTable !== "object") return [];
  // Postgres block comments nest; the stripper does not, so skip such a query.
  if (/\/\*(?:(?!\*\/)[\s\S])*\/\*/.test(String(sql))) return [];
  const bad = [];
  for (const stmt of stripSql(sql).split(";")) {
    const ctes = new Set();
    for (const m of stmt.matchAll(/\b([a-z_]\w*)\s*(?:\([^()]*\))?\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/g)) ctes.add(m[1]);

    const bindings = new Map(); // qualifier -> Set of table names (null = unresolvable)
    const bind = (q, t) => { if (!bindings.has(q)) bindings.set(q, new Set()); bindings.get(q).add(t); };
    // Subquery / function aliases: ") alias" — never resolvable.
    for (const m of stmt.matchAll(/\)\s+(?:as\s+)?([a-z_]\w*)/g)) if (!NOT_ALIAS.has(m[1])) bind(m[1], null);

    const fromRe = /\b(?:from|join)\s+(?:only\s+)?([a-z_]\w*)(?:\.([a-z_]\w*))?(?!\s*\(|\w|\.)(?:\s+(?:as\s+)?([a-z_]\w*))?(\s*\()?/g;
    for (const m of stmt.matchAll(fromRe)) {
      const [, first, second, rawAlias, aliasCols] = m;
      const schema = second ? first : "public";
      const table = second || first;
      const alias = rawAlias && !NOT_ALIAS.has(rawAlias) ? rawAlias : null;
      const known = schema === "public" && !ctes.has(table) && Array.isArray(columnsByTable[table]);
      const qualifier = alias || table;
      bind(qualifier, known && !aliasCols ? table : null);
    }

    for (const m of stmt.matchAll(/(?<![\w.$"])([a-z_]\w*)\.([a-z_]\w*)(?![\w.$"(]|\s*\()/g)) {
      const [, q, column] = m;
      const tables = bindings.get(q);
      if (!tables || tables.size !== 1 || ctes.has(q)) continue;
      const [table] = tables;
      if (!table) continue;
      if (!SYSTEM_COLUMNS.has(column) && !columnsByTable[table].includes(column)) bad.push({ ref: `${q}.${column}`, table, column });
    }
  }
  const seen = new Set();
  return bad.filter((b) => !seen.has(b.ref) && seen.add(b.ref));
}

// Migrations stamped after the registry's high water: the registry may not
// have their columns yet (see addedSinceRegistry).
function newerMigrations(migrationsDir, highWater) {
  try {
    if (!highWater) return [];
    return readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql") && (f.match(/^(\d+)/)?.[1] || "") > String(highWater))
      .map((f) => readFileSync(path.join(migrationsDir, f), "utf8").toLowerCase());
  } catch { return []; }
}

// One newer migration file both names this table (ALTER TABLE or a view of
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
  if (!sql || /column-check:\s*skip/i.test(sql)) return;

  const here = path.dirname(fileURLToPath(import.meta.url));
  let registry;
  try { registry = JSON.parse(readFileSync(path.join(here, "..", "schema-registry.json"), "utf8")); } catch { return; }

  let bad = findBadColumns(sql, registry?.columns);
  if (bad.length === 0) return;
  const newer = newerMigrations(path.join(here, "..", "..", "supabase", "migrations"), registry?._meta?.migrations_high_water);
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
