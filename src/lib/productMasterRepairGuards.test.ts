/**
 * Product Master repair regression guards (KI-156, KI-158 to KI-162; To-Do 0.17 step 6, KI-164).
 *
 * Each fix lives in a migration (or the stock sweep). A later migration that re-emits a function without the fix,
 * or drops its trigger or index, undoes it silently; these checks fail in `npm test` when that happens.
 * Behaviour is proven by the real-schema provers named per entry; this file only pins that the fix is still there.
 * KI-157 (invoice PDF names) is still open, so it has no entry.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInventoryLedger, PREBOOK_ONLY_ADJUSTMENT_TX_IDS, type InventoryTransactionRow } from './reconciliation';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
// Every migration, oldest first, as one text: a later position is a later change.
const ALL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => `\n-- @@file ${f}\n` + readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('');

function lastMatch(re: RegExp): number {
  let last = -1;
  for (const m of ALL.matchAll(new RegExp(re.source, 'gi'))) last = m.index ?? last;
  return last;
}

/** The newest body of a function; fails if no migration creates it or a newer one drops it. */
function latestBody(fn: string): string {
  // Schema optional: older migrations create some functions unqualified.
  const created = lastMatch(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?"?${fn}"?\\s*\\(`));
  expect(created, `${fn} is not created by any migration`).toBeGreaterThan(-1);
  const dropped = lastMatch(new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?"?${fn}"?(?![A-Za-z0-9_])`));
  expect(dropped, `${fn} is dropped later`).toBeLessThan(created);
  const body = ALL.slice(created).match(/AS\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/);
  return body ? body[2] : '';
}

/** The newest create of a trigger or index on a table comes after its newest drop. */
function stillCreated(kind: 'TRIGGER' | 'UNIQUE INDEX', name: string, table: string): void {
  const created = lastMatch(new RegExp(`CREATE\\s+${kind.replace(' ', '\\s+')}\\s+${name}\\b[\\s\\S]{0,200}?\\bON\\s+(?:public\\.)?${table}\\b`));
  // A trigger drop names its table (one name can sit on several tables); an index name is unique per schema.
  const dropped = lastMatch(new RegExp(kind === 'TRIGGER'
    ? `DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${name}\\s+ON\\s+(?:public\\.)?${table}\\b`
    : `DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?(?:public\\.)?${name}\\b`));
  expect(created, `${kind} ${name} on ${table} is never created`).toBeGreaterThan(-1);
  expect(dropped, `${kind} ${name} is dropped after it was created`).toBeLessThan(created);
}

describe('Product Master repair fixes stay in place', () => {
  // Prover: scripts/smoke/prove-grower-share-cost-unit-real-schema.mjs
  it('KI-156: a grower-share chemical is costed in its sold unit', () => {
    const body = latestBody('_save_field_app_invoice_impl_20260714');
    expect(body).toMatch(/v_qa_qty\s*:=\s*field_app_priced_quantity\(v_chem_qty_a,/);
    expect(body).toMatch(/v_invoice_cost\s*:=\s*v_invoice_cost\s*\+\s*safe_cents_qty\(v_qa_unit_cost,\s*v_qa_qty\)/);
  });

  // Prover: scripts/smoke/prove-units-batch-real-schema.mjs
  it('KI-158: order, delivery and PO lines must be in the stock unit', () => {
    expect(latestBody('_enforce_line_stock_unit')).toMatch(/LINE_UNIT_NOT_STOCK_UNIT/);
    for (const table of ['order_items', 'delivery_items', 'purchase_order_items']) {
      stillCreated('TRIGGER', 'a1_line_unit_is_stock_unit', table);
    }
  });

  // Prover: scripts/smoke/prove-one-open-count-real-schema.mjs (also runs the sweep's returned-row case)
  it('KI-159: the stock sweep reads a returned row with its sign, the same as the browser check', () => {
    const sql = readFileSync(join(ROOT, 'scripts/db-invariant-sweeps/predicates/stock-matches-history.sql'), 'utf8');
    const listAfter = (expr: string) => {
      const m = sql.match(new RegExp(`transaction_type IN \\(([^)]*)\\)\\s*THEN ${expr}`));
      return new Set([...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    };
    const add = listAfter('abs\\(t\\.quantity\\)');
    const subtract = listAfter('-abs\\(t\\.quantity\\)');
    const signed = listAfter('t\\.quantity\\b');
    expect(signed.has('returned')).toBe(true);
    const types: InventoryTransactionRow['transaction_type'][] = [
      'received', 'booked', 'delivered', 'returned', 'adjusted', 'transferred', 'job_applied',
      'cancelled_delivery_reversal', 'void_delivery_reversal', 'prebooked', 'released', 'prebook_reconciliation',
      'tote_fill_out', 'tote_fill_in',
    ];
    // Both signs: with only -5, "signed" and "subtract" look the same.
    for (const type of types) {
      for (const quantity of [5, -5]) {
        const sqlDelta = add.has(type) ? Math.abs(quantity)
          : subtract.has(type) ? -Math.abs(quantity)
          : signed.has(type) ? quantity : 0;
        const issues = checkInventoryLedger(
          [{ id: 'i', product_id: 'p', product_name: 'P', quantity_available: 1000 }],
          [{ product_id: 'p', transaction_type: type, quantity }],
        );
        expect(issues[0]?.expected ?? 1000, `${type} ${quantity}: sweep and browser check disagree`).toBe(sqlDelta);
      }
    }
    // Pins the SQL side alone too (the docker prover is not in npm test).
    expect(signed).toEqual(new Set(['adjusted', 'transferred', 'returned', 'tote_fill_out', 'tote_fill_in']));
    for (const id of PREBOOK_ONLY_ADJUSTMENT_TX_IDS) expect(sql).toContain(`'${id}'::uuid`);
  });

  // Prover: scripts/smoke/prove-one-open-count-real-schema.mjs
  it('KI-160: one open count per warehouse and per stock row, and counts only move forward', () => {
    stillCreated('UNIQUE INDEX', 'cycle_counts_one_open_per_warehouse', 'cycle_counts');
    expect(latestBody('_cycle_count_item_one_open_row')).toMatch(/CYCLE_COUNT_ROW_ALREADY_OPEN/);
    stillCreated('TRIGGER', 'trg_cycle_count_item_one_open_row', 'cycle_count_items');
    expect(latestBody('_cycle_count_no_reopen')).toMatch(/CYCLE_COUNT_REOPEN_FORBIDDEN/);
    stillCreated('TRIGGER', 'trg_cycle_count_no_reopen', 'cycle_counts');
  });

  // Prover: scripts/smoke/prove-inventory-cleanup-real-schema.mjs
  it('KI-161: an edited delivery line is re-checked against its order line', () => {
    const body = latestBody('_delivery_line_matches_order_line');
    for (const token of ['DELIVERY_LINE_NOT_ON_ORDER', 'DELIVERY_LINE_PRODUCT_MISMATCH', 'DELIVERY_LINE_UNIT_MISMATCH']) {
      expect(body).toContain(token);
    }
    stillCreated('TRIGGER', 'a2_delivery_line_matches_order_line', 'delivery_items');
  });

  // Prover: scripts/smoke/prove-stock-checks-real-schema.mjs
  it('KI-162: the Receiving Log filters by the Central date', () => {
    const body = latestBody('get_receiving_log');
    expect(body).toMatch(/received_at\s*>=\s*\(p_date_from::timestamp AT TIME ZONE 'America\/Chicago'\)/);
    expect(body).toMatch(/received_at\s*<\s*\(\(p_date_to \+ 1\)::timestamp AT TIME ZONE 'America\/Chicago'\)/);
  });
});
