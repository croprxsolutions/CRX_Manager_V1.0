import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// KI-134 (20270101134000): pins the saved count's comparison with on hand at the moment it is saved.
const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20270101134000_cycle_count_variance_vs_onhand_at_count.sql'),
  'utf8',
).replace(/\r\n/g, '\n');
const body = migration.slice(migration.indexOf('AS $function$'), migration.indexOf('$function$;'));

describe('update_cycle_count_item compares with on hand at save (KI-134)', () => {
  it('reads the line inventory on hand, rounded like the stored columns', () => {
    expect(body).toMatch(/SELECT i\.quantity_available INTO v_on_hand\s+FROM public\.inventory i\s+WHERE i\.id = v_item\.inventory_id\s+FOR SHARE;/);
    expect(body).toContain('v_expected := round(COALESCE(v_on_hand, 0), 2);');
    expect(body).toContain('v_variance := round(p_counted_qty, 2) - v_expected;');
    expect(body).toContain('v_variance_pct := round((v_variance / abs(v_expected)) * 100, 2);');
  });

  it('stores and returns the on hand it compared with', () => {
    expect(body).toMatch(/SET expected_qty = v_expected,/);
    expect(body).toContain("'expected_qty', v_expected,");
  });

  it('keeps the guards and the unchanged receipt fingerprint', () => {
    expect(body).toContain("IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;");
    expect(body).toContain("RAISE EXCEPTION 'ACTOR_MISMATCH';");
    expect(body).toMatch(/'actor_id', v_actor,\s+'item_id', p_item_id,\s+'counted_qty', p_counted_qty,\s+'notes', p_notes\s+\)/);
  });

  it('refuses to apply over an open count holding old-rule lines', () => {
    expect(migration).toContain("WHERE cc.status = 'in_progress' AND cci.is_counted");
    expect(migration).toContain('LOCK TABLE public.cycle_count_items IN SHARE ROW EXCLUSIVE MODE;');
  });
});
