import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Mason 2026-10-26/27: a customer may take more than is left on a booking; the rep chooses the
// price for the extra (default today). Behaviour is proven on a local replay (booking scenarios
// S03-S03f, every other scenario unchanged); this pins the migration text so the extra never
// lands on the booking (which every booking reader assumes never exceeds what was booked).
const sql = readFileSync('supabase/migrations/20261029110000_booking_over_draw.sql', 'utf8')
  .replace(/\r\n/g, '\n');
const code = sql.replace(/--.*$/gm, '');

describe('20261029110000 booking over-draw', () => {
  it('splits only when the rep chose a price and something is left', () => {
    expect(code).toContain('IF v_qty > v_remaining AND v_remaining > 0 AND v_extra_choice IS NOT NULL THEN');
    expect(code).toContain("IF v_extra_choice IS NOT NULL AND v_extra_choice NOT IN ('today', 'booked') THEN");
    // The original refusal is still there for everything else.
    expect(code).toMatch(/IF v_qty > v_remaining THEN\s+RAISE EXCEPTION 'BOOKING_OVERDRAWN:/);
  });

  it('writes the extra to an ordinary order, outside the booking ledger', () => {
    expect(code).toMatch(/VALUES \(v_extra_order_number, NULL, v_quote\.customer_id, 'confirmed',/);
    expect(code).not.toMatch(/UPDATE orders SET booking_draw = true WHERE id = v_extra_order_id/);
    // The booking ledger row is written once, for the booking part only.
    expect(code.match(/INSERT INTO quote_product_draws/g)).toHaveLength(1);
    expect(code).toContain('VALUES (p_quote_id, v_product_id, v_qty)');
  });

  it('prices the extra at today\'s tier price or the last booked line, with today\'s cost', () => {
    expect(code).toContain('ORDER BY qs.sort_order DESC, qi.sort_order DESC, qi.id DESC');
    expect(code).toMatch(/WHEN 2 THEN COALESCE\(p\.tier2_price, p\.tier1_price, 0\)/);
    expect(code).toContain('SELECT current_cost INTO v_extra_cost FROM products WHERE id = v_product_id;');
  });

  it('fingerprints the choice only when it is sent', () => {
    expect(code).toMatch(/\|\| CASE WHEN d\.value \? 'extra_price'\s+THEN jsonb_build_object\('extra_price', d\.value ->> 'extra_price'\)\s+ELSE '\{\}'::jsonb END/);
  });

  it('re-emits only the two pinned functions, inside one transaction', () => {
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2);
    expect(code).not.toMatch(/DROP (TABLE|COLUMN|FUNCTION|TRIGGER|POLICY)|ALTER TABLE|GRANT /);
    expect(code).toContain("'cd3a7b1b398d69d1f44288f160d69e3d'");
    expect(code).toContain("'e92324844af88051c4a20f773b7ac2bb'");
    expect(code).toContain('DO $preflight$');
    expect(code).toContain('DO $postflight$');
  });
});
