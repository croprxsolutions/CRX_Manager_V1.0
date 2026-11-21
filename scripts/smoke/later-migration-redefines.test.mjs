// node scripts/smoke/later-migration-redefines.test.mjs (#1910)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { laterMigrationRedefines } from './later-migration-redefines.mjs';

// The provers' own guard shapes, read from their source so the test tracks them.
function guardOf(file) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  const TOUCHED = src.match(/^const TOUCHED = (\/.*\/i);$/m)?.[1];
  const REDEFINED = src.match(/^const REDEFINED = (.*);$/m)?.[1];
  const RENAMED_ONTO = src.match(/^const RENAMED_ONTO = (.*);$/m)?.[1];
  assert.ok(TOUCHED && REDEFINED && RENAMED_ONTO, `${file}: guard constants not found`);
  return new Function(`const TOUCHED = ${TOUCHED}; return [${REDEFINED}, ${RENAMED_ONTO}];`)();
}
const count = guardOf('./prove-cycle-count-onhand-at-count-real-schema.mjs');
const po = guardOf('./prove-po-close-short-real-schema.mjs');
const tote = guardOf('./prove-tote-fill-real-schema.mjs');
const hits = (guard, sql) => laterMigrationRedefines(sql, ...guard);

// Real DDL still trips the guard.
assert.equal(hits(count, 'ALTER TABLE public.cycle_count_items ADD COLUMN x int;'), true);
assert.equal(hits(count, 'CREATE OR REPLACE FUNCTION public.adjust_inventory() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;'), true);
assert.equal(hits(po, 'CREATE TRIGGER t BEFORE UPDATE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION f();'), true);
assert.equal(hits(tote, 'DROP TABLE public.inventory;'), true);

// 1. Commented-out DDL no longer trips it (line, block, nested block, and a comment inside a DO body).
assert.equal(hits(count, '-- ALTER TABLE public.cycle_counts ADD COLUMN x int;\nSELECT 1;'), false);
assert.equal(hits(count, '/* DROP FUNCTION public.adjust_inventory(); */ SELECT 1;'), false);
assert.equal(hits(po, '/* outer /* DROP TABLE purchase_orders; */ still comment */ SELECT 1;'), false);
assert.equal(hits(tote, "DO $$ BEGIN\n  -- DROP TABLE public.inventory;\n  PERFORM 1;\nEND $$;"), false);
// A comment marker inside a string literal is data: the real DDL after it still counts.
assert.equal(hits(count, "SELECT '/*'; ALTER TABLE public.cycle_counts ADD COLUMN x int; SELECT '*/';"), true);
assert.equal(hits(count, "SELECT '--'; ALTER TABLE public.cycle_counts ADD COLUMN x int;"), true);
// DDL in a dynamic EXECUTE string inside a DO body still counts.
assert.equal(hits(tote, "DO $$ BEGIN EXECUTE 'ALTER TABLE public.inventory ADD COLUMN x int'; END $$;"), true);

// 2. A rename onto a guarded name trips it.
assert.equal(hits(count, 'ALTER TABLE public.stock_takes RENAME TO cycle_count;'), true);
assert.equal(hits(count, 'ALTER TABLE public.stock_takes RENAME TO "cycle_counts";'), true);
assert.equal(hits(po, 'ALTER FUNCTION public.f(uuid) RENAME TO receive_po_items;'), true);
assert.equal(hits(po, 'ALTER TABLE public.x RENAME COLUMN a TO purchase_order_id;'), true);
assert.equal(hits(tote, 'ALTER TABLE public.stock RENAME TO inventory;'), true);
assert.equal(hits(tote, 'ALTER FUNCTION public.f() RENAME TO is_admin;'), true);
// ...but not a rename onto an unrelated name, a commented rename, or a GRANT ... TO.
assert.equal(hits(tote, 'ALTER TABLE public.stock RENAME TO inventory_snapshots;'), false);
assert.equal(hits(count, 'ALTER TABLE public.x RENAME TO y; GRANT SELECT ON public.cycle_counts TO authenticated;'), false);
assert.equal(hits(count, '-- ALTER TABLE public.x RENAME TO cycle_count;\nSELECT 1;'), false);

console.log('later-migration-redefines: all assertions passed');
