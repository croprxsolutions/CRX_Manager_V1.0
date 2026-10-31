import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Mason 2026-10-27: the database refuses a booking marked 'accepted' with no order (KI-12).
// Behaviour is proven on a local replay (booking scenario S15b plus real-commit Convert and
// full-draw runs); this pins the migration text so the check is not quietly made immediate
// (which would break Convert) or widened.
const sql = readFileSync('supabase/migrations/20261029090000_quote_accepted_requires_order.sql', 'utf8')
  .replace(/\r\n/g, '\n');
const code = sql.replace(/--.*$/gm, '');

describe('20261029090000 quote accepted requires an order', () => {
  it('adds one deferred constraint trigger on quotes that fires when a row becomes accepted', () => {
    expect(code).toMatch(
      /CREATE CONSTRAINT TRIGGER trg_quote_accepted_requires_order\s+AFTER INSERT OR UPDATE OF status ON public\.quotes\s+DEFERRABLE INITIALLY DEFERRED\s+FOR EACH ROW\s+WHEN \(NEW\.status = 'accepted'\)/,
    );
    expect(code.match(/CREATE (CONSTRAINT )?TRIGGER/g)).toHaveLength(1);
  });

  it('re-reads the row at commit and requires a live order', () => {
    expect(code).toContain("SELECT 1 FROM quotes q WHERE q.id = NEW.id AND q.status = 'accepted'");
    expect(code).toContain('SELECT 1 FROM orders o WHERE o.quote_id = NEW.id AND o.deleted_at IS NULL');
    expect(code).toContain("RAISE EXCEPTION 'QUOTE_ACCEPTED_WITHOUT_ORDER:");
  });

  it('creates new objects only, with a locked-down trigger function', () => {
    expect(code.match(/CREATE (OR REPLACE )?FUNCTION/g)).toHaveLength(1);
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION|DROP |ALTER TABLE|UPDATE public\.|DELETE FROM/);
    expect(code).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    expect(code).toContain('REVOKE ALL ON FUNCTION public._enforce_quote_accepted_has_order() FROM PUBLIC, anon, authenticated;');
    expect(code).toContain('DO $preflight$');
    expect(code).toContain('DO $postflight$');
  });
});
