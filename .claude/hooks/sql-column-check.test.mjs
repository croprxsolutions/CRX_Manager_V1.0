#!/usr/bin/env node
// Tests for sql-column-check.mjs. The refusals are the real guessed columns from
// the 2026-11-16 retro session; the allows are the false-alarm cases that must
// never be refused. Run: node .claude/hooks/sql-column-check.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { findBadColumns, hasSkipMarker } from "./sql-column-check.mjs";
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
allows(`select "P"."Price_Per_Acre" from products p`, "mixed-case quoted identifiers are a different name: skipped");
allows(`select "from".x from products "from"`, "a quoted SQL word stays opaque");
allows("select public.fn_x(oi.id) from order_items oi", "schema-qualified function call");
allows("select 1.5 * oi.acres from order_items oi", "numbers");
allows("select oi.* from order_items oi", "star");
allows("select x.ctid, x.xmin from order_items x", "system columns");
allows("/* outer /* inner */ select p.price_per_acre from products p */ select 1", "nested block comment");
refuses("/* note */ select p.price_per_acre from products p", ["p.price_per_acre"], "plain block comment still checked");
// Real 2026 sweep query: a `--` inside a string once hid `JOIN pg_proc p` and bound p to products only.
allows(`select regexp_replace(p.prosrc, '--[^\\n]*', ' ', 'g'), p.proconfig
  from quote_items qi join products p on p.id = qi.product_id
  left join pg_proc p on p.oid = 1`, "comment marker inside a string");
allows("select e'it\\'s -- x', p.price_per_acre from products p join pg_proc p on true", "E-string with escaped quote");
assert.deepEqual(findBadColumns("select oi.quantity from order_items oi", null), [], "no registry"); pass++;

// --- #1906: cases the first version let through ---
// Tables after a comma in FROM.
refuses("select o.id, oi.quantity from orders o, order_items oi where oi.order_id = o.id", ["oi.quantity"], "comma-listed table");
refuses("select oi.quantity from orders o, public.order_items as oi, products p", ["oi.quantity"], "comma list with AS and schema");
refuses("select products.price_per_acre from orders, products", ["products.price_per_acre"], "comma-listed bare table");
allows("select oi.quantity_delivered, p.rate_unit from orders o, order_items oi, products p", "correct comma list");
allows("select e.value from orders o, jsonb_array_elements('[]'::jsonb) e", "function after a comma");
allows("select x.quantity from orders o, (select 1 as quantity) x", "subquery after a comma");
allows("select x.quantity from orders o, lateral (select 1 as quantity) x", "lateral subquery after a comma");
allows("select oi.quantity from orders o, order_items oi(quantity)", "comma-listed alias with column list");
allows("select o.id from orders o order by o.id, o.status", "ORDER BY commas are not tables");
allows("select oi.quantity from orders o group by o.id, oi", "GROUP BY commas are not tables");
refuses("select p.nope from orders o, jsonb_array_elements('[]'::jsonb) f, products p", ["p.nope"], "table after a function in the comma list");
refuses("select p.nope from orders o, (select 1) x, lateral public.fn(o.id) as y(a, b), products p", ["p.nope"], "table after subquery and lateral function");
refuses("select p.nope from orders o(a, b), products p", ["p.nope"], "table after an alias column list");
allows("select p.id from orders o, jsonb_array_elements('[]'::jsonb) f, products p", "correct table after a function");
allows("select z.nope from orders o where exists (select 1 from order_items oi, f(oi.id) y) z, products z", "a subquery's comma list does not leak out");
allows("select 1 from products p where exists (select 1 from public.return_rows() p where p.value = 1)", "inner function alias shadows outer alias (Luna #1906 r1)");
// Three-part public.table.column.
refuses("select public.products.price_per_acre from public.products", ["public.products.price_per_acre"], "three-part name");
refuses("select public.order_items.quantity from orders, order_items", ["public.order_items.quantity"], "three-part name, comma list");
allows("select public.products.rate_unit from products", "correct three-part name");
allows("select public.products.price_per_acre from products p", "three-part name with an aliased table is not resolvable here");
allows("select other.products.price_per_acre from other.products", "non-public three-part name");
// Quoted identifiers that mean the same unquoted.
refuses(`select "p"."price_per_acre" from products p`, ["p.price_per_acre"], "quoted lowercase identifiers");
refuses(`select oi.quantity from "order_items" oi`, ["oi.quantity"], "quoted lowercase table name");
allows(`select "p"."rate_unit" from "products" "p"`, "correct quoted identifiers");
// An AS output name equal to a table alias does not hide the alias.
refuses("select count(*) as oi, oi.quantity from order_items oi group by oi.id", ["oi.quantity"], "output name equals alias");
refuses("select (select 1) oi, oi.quantity from order_items oi", ["oi.quantity"], "scalar subquery output name");
refuses("select sum(oi.acres) over (partition by oi.order_id) as oi, oi.quantity from order_items oi", ["oi.quantity"], "window output name");
allows("select oi.quantity from order_items oi join (select 1 as quantity) oi on true", "subquery in JOIN still binds its alias");
allows("select oi.quantity from orders o join lateral public.fn(o.id) oi on true", "schema-qualified function in FROM still binds");
allows("select p.quantity from orders o cross join lateral (select 1 as quantity) as p", "lateral subquery still binds");
// "/*" inside a string no longer skips the query.
refuses("select '/*', '/*', p.price_per_acre from products p", ["p.price_per_acre"], "comment opener inside strings");
refuses("select $x$ /* /* $x$, p.price_per_acre from products p", ["p.price_per_acre"], "comment opener inside dollar quotes");
// oid is not a column every table has.
refuses("select oi.oid from order_items oi", ["oi.oid"], "oid on a user table");
allows("select c.oid from pg_catalog.pg_class c", "oid on a catalog table");
// The skip marker counts only in a comment.
assert.equal(hasSkipMarker("select 'column-check: skip', 1"), false, "marker inside a string"); pass++;
assert.equal(hasSkipMarker("select $$ column-check: skip $$"), false, "marker inside dollar quotes"); pass++;
assert.equal(hasSkipMarker("select 1 -- column-check: skip"), true, "marker in a line comment"); pass++;
assert.equal(hasSkipMarker("/* column-check: skip */ select 1"), true, "marker in a block comment"); pass++;

// --- #2035: an output name after a select-list comma, and a quoted "public" schema ---
refuses("select 1, count(*) as oi, oi.quantity from order_items oi", ["oi.quantity"], "output name after a select-list comma");
refuses("select o.id, (select 1) oi, oi.quantity from orders o, order_items oi", ["oi.quantity"], "scalar subquery after a select-list comma");
refuses("select distinct on (o.id) o.id, sum(oi.acres) over (partition by o.id) oi, oi.quantity from orders o join order_items oi on true",
  ["oi.quantity"], "window output name after DISTINCT ON and a comma");
allows("select 1, x.quantity from orders o, (select 1 as quantity) x", "FROM-list subquery after a select-list comma still binds");
allows("select (select y.quantity from orders o, (select 1 as quantity) y) from orders", "FROM-list comma inside a select-list subquery");
allows("select x.quantity from orders o join order_items oi on oi.order_id = o.id, lateral (select 1 as quantity) x", "comma after a JOIN condition");
allows("select a is distinct from b, f() oi, oi.quantity from order_items oi", "a FROM inside an expression keeps the safe side");
refuses(`select p.price_per_acre from "public"."products" p`, ["p.price_per_acre"], "quoted public schema");
refuses(`select oi.quantity from orders o, "public".order_items oi`, ["oi.quantity"], "quoted public schema in a comma list");
refuses(`select "public"."products"."price_per_acre" from "public"."products"`, ["public.products.price_per_acre"], "quoted three-part name");
allows(`select p.rate_unit from "public"."products" p`, "correct quoted public schema");
allows(`select p.price_per_acre from "Public"."products" p`, "mixed-case quoted schema is a different schema");

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
writeFileSync(path.join(migDir, "20261113100000_commented.sql"),
  "-- alter table order_items add column commented_col int;\n/* alter table order_items add column commented_col int; */\n" +
  "/* outer /* nested */ alter table order_items add column nested_col int; */\n" +
  "alter table \"order_items\" add column \"later_col\" int; select 1;");
// Adds the column to a DIFFERENT table: must not excuse products.unit_cost.
writeFileSync(path.join(migDir, "20261114000000_other.sql"),
  "alter table products add column sku_extra text;\nalter table orders add column unit_cost bigint;");

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
assert.equal(run("select p.unit_cost from products p")?.hookSpecificOutput?.permissionDecision, "deny",
  "a column added to another table does not excuse it"); pass++;
assert.equal(run("-- column-check: skip\nselect p.default_rate_unit from products p"), null, "skip marker"); pass++;
assert.equal(run("select 'column-check: skip', p.default_rate_unit from products p")?.hookSpecificOutput?.permissionDecision, "deny",
  "skip marker inside a string does not skip"); pass++;
assert.equal(run("select oi.commented_col from order_items oi")?.hookSpecificOutput?.permissionDecision, "deny",
  "a column added only in a comment of a newer migration does not excuse it"); pass++;
assert.equal(run("select oi.nested_col from order_items oi")?.hookSpecificOutput?.permissionDecision, "deny",
  "a column added only inside a nested block comment does not excuse it"); pass++;
assert.equal(run("select oi.later_col from order_items oi"), null, "column added by a newer migration's quoted ADD COLUMN"); pass++;
assert.equal(run("select p.default_rate_unit from products p", "mcp__supabase__list_tables"), null, "other tools ignored"); pass++;
// An unreadable newer migration (here a folder named .sql) allows the query rather than refuse a maybe-valid one.
mkdirSync(path.join(migDir, "20261115000000_unreadable.sql"));
assert.equal(run("select p.default_rate_unit from products p"), null, "unreadable newer migration allows"); pass++;
writeFileSync(registryPath, "{ not json");
assert.equal(run("select p.default_rate_unit from products p"), null, "unreadable registry allows"); pass++;

console.log(`sql-column-check: ${pass} passed`);
