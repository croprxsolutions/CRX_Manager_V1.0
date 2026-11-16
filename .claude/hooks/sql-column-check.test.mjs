#!/usr/bin/env node
// Tests for sql-column-check.mjs. The refusals are the real guessed columns from
// the 2026-11-16 retro session; the allows are the false-alarm cases that must
// never be refused. Run: node .claude/hooks/sql-column-check.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { findBadColumns } from "./sql-column-check.mjs";
import { tempDir } from "../../scripts/lib/test-temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const COLUMNS = {
  order_items: ["id", "order_id", "product_id", "product_name", "price_per_unit", "rate_unit", "acres", "total_units_needed", "quantity_delivered", "quantity_remaining"],
  orders: ["id", "customer_id", "status", "created_at"],
  products: ["id", "product_name", "tier1_price_per_acre", "rate_per_acre", "rate_unit", "is_active"],
};
const refs = (sql) => findBadColumns(sql, COLUMNS).map((b) => b.ref);
function refuses(sql, expected, msg) { assert.deepEqual(refs(sql), expected, msg); pass++; }
function allows(sql, msg) { assert.deepEqual(refs(sql), [], msg); pass++; }

// --- Real cases from the retro: must be refused ---
refuses("SELECT oi.quantity FROM order_items oi WHERE oi.order_id = 1", ["oi.quantity"], "oi.quantity on order_items");
refuses("select p.product_name, p.price_per_acre, p.default_rate_unit from products p where p.is_active",
  ["p.price_per_acre", "p.default_rate_unit"], "products guesses");
refuses(`SELECT o.id, oi.quantity
  FROM orders o
  JOIN order_items AS oi ON oi.order_id = o.id
  LEFT JOIN public.products p ON p.id = oi.product_id
  WHERE p.price_per_acre > 0`, ["oi.quantity", "p.price_per_acre"], "joins, AS and public. schema");
refuses("select products.price_per_acre from products", ["products.price_per_acre"], "bare table name qualifier");
refuses("select 1; select oi.quantity from order_items oi;", ["oi.quantity"], "second statement checked");

// --- False-alarm cases: must be allowed ---
allows("SELECT oi.quantity_delivered, p.rate_per_acre FROM order_items oi JOIN products p ON p.id = oi.product_id", "correct query");
allows("WITH oi AS (SELECT order_id, sum(total_units_needed) AS quantity FROM order_items GROUP BY order_id) SELECT oi.quantity FROM oi", "CTE alias");
allows("with totals as (select 1 as quantity) select t.quantity from totals t", "CTE referenced through alias");
allows("with products as (select 1 as price_per_acre) select products.price_per_acre from products", "CTE shadows a real table");
allows("SELECT x.quantity FROM (SELECT order_id, count(*) AS quantity FROM order_items GROUP BY order_id) x", "subquery alias");
allows("SELECT c.column_name, c.data_type FROM information_schema.columns c WHERE c.table_name = 'order_items'", "information_schema");
allows("select c.relname, a.attname from pg_catalog.pg_class c join pg_catalog.pg_attribute a on a.attrelid = c.oid", "pg_catalog");
allows("select g.n from generate_series(1, 3) g", "function output alias");
allows("select g.n from generate_series(1, 3) as g(n)", "function alias with column list");
allows("select p.anything from products p(a, b)", "table alias with column list");
allows("select p.quantity from products p join lateral (select 1 as quantity) p2 on true where exists (select 1 from orders p)", "alias bound twice");
allows("select w.thing from widgets w", "table not in registry");
allows("select 'oi.quantity' as label, oi.id from order_items oi -- oi.quantity", "strings and comments ignored");
allows(`select "p"."price_per_acre" from products p`, "quoted identifiers skipped");
allows("select public.fn_x(oi.id) from order_items oi", "schema-qualified function call");
allows("select 1.5 * oi.acres from order_items oi", "numbers");
allows("select oi.* from order_items oi", "star");
allows("select x.ctid, x.xmin from order_items x", "system columns");
// Real 2026 sweep query: a `--` inside a string once hid `JOIN pg_proc p` and bound p to products only.
allows(`select regexp_replace(p.prosrc, '--[^\\n]*', ' ', 'g'), p.proconfig
  from quote_items qi join products p on p.id = qi.product_id
  left join pg_proc p on p.oid = 1`, "comment marker inside a string");
allows("select e'it\\'s -- x', p.price_per_acre from products p join pg_proc p on true", "E-string with escaped quote");
assert.deepEqual(findBadColumns("select oi.quantity from order_items oi", null), [], "no registry"); pass++;

// --- End to end: the hook process itself, isolated copy beside a crafted registry ---
const tmp = tempDir("crx-sql-column-");
const hooksDir = path.join(tmp, ".claude", "hooks");
const migDir = path.join(tmp, "supabase", "migrations");
mkdirSync(hooksDir, { recursive: true });
mkdirSync(migDir, { recursive: true });
copyFileSync(path.join(__dirname, "sql-column-check.mjs"), path.join(hooksDir, "sql-column-check.mjs"));
const registryPath = path.join(tmp, ".claude", "schema-registry.json");
writeFileSync(registryPath, JSON.stringify({ _meta: { generated_at: "2026-11-12", migrations_high_water: "20261112000000" }, columns: COLUMNS }));
writeFileSync(path.join(migDir, "20261101000000_old.sql"), "alter table products add column default_rate_unit text;");
writeFileSync(path.join(migDir, "20261113000000_new.sql"), "alter table order_items add column quantity numeric;\n-- mentions price_per_acre in passing\nupdate products set rate_unit = 'oz';");

function run(query, toolName = "mcp__supabase__execute_sql") {
  const r = spawnSync(process.execPath, [path.join(hooksDir, "sql-column-check.mjs")], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { query } }), encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const denied = run("select p.default_rate_unit from products p");
assert.equal(denied?.hookSpecificOutput?.permissionDecision, "deny", "hook denies a bad column"); pass++;
const reason = denied.hookSpecificOutput.permissionDecisionReason;
assert.match(reason, /p\.default_rate_unit/, "names the bad column"); pass++;
assert.match(reason, /tier1_price_per_acre, rate_per_acre, rate_unit/, "lists the real columns"); pass++;
assert.equal(run("select p.rate_unit from products p"), null, "correct query prints nothing"); pass++;
assert.equal(run("select oi.quantity from order_items oi"), null, "column in a migration newer than the registry is allowed"); pass++;
assert.equal(run("select p.price_per_acre from products p")?.hookSpecificOutput?.permissionDecision, "deny",
  "a newer migration that only mentions the word does not excuse it"); pass++;
assert.equal(run("-- column-check: skip\nselect p.default_rate_unit from products p"), null, "skip marker"); pass++;
assert.equal(run("select p.default_rate_unit from products p", "mcp__supabase__list_tables"), null, "other tools ignored"); pass++;
writeFileSync(registryPath, "{ not json");
assert.equal(run("select p.default_rate_unit from products p"), null, "unreadable registry allows"); pass++;

console.log(`sql-column-check: ${pass} passed`);
