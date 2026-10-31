import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Mason 2026-10-26: reps are warned when cost goes up, without seeing cost numbers (cost and margin
// are admin-only, 2026-10-15). Behaviour is proven on a local replay (booking scenario S23); this
// pins the migration so the function can never start returning a cost, price or margin.
const sql = readFileSync('supabase/migrations/20261030090000_quote_cost_alerts.sql', 'utf8').replace(/\r\n/g, '\n');
const code = sql.replace(/--.*$/gm, '');

describe('20261030090000 quote cost alerts', () => {
  it('returns only a line id and two yes/no flags', () => {
    expect(code).toContain('RETURNS TABLE (quote_item_id uuid, cost_rose boolean, below_cost boolean)');
    expect(code.match(/RETURN QUERY\s+SELECT qi\.id,/g)).toHaveLength(1);
  });

  it('is read-only, for active admins and sales reps, and callable only by signed-in users', () => {
    expect(code).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    expect(code).toContain('IF NOT (public.is_admin() OR public.is_sales_rep()) THEN');
    expect(code).toContain('REVOKE ALL ON FUNCTION public.get_quote_cost_alerts(uuid) FROM PUBLIC, anon;');
    expect(code).toContain('GRANT EXECUTE ON FUNCTION public.get_quote_cost_alerts(uuid) TO authenticated;');
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|ALTER TABLE|DROP /);
  });
});
