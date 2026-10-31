import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Mason 2026-10-26/27: a booking runs to season end (Sept 30) unless the rep picks a date, and a
// part-drawn booking past its date alerts its rep. Behaviour is proven on a local replay (booking
// scenarios S21, S21b, S21c, with S05a-c unchanged); this pins the migration text so the rule is
// not quietly widened (a writable column) or narrowed (expiring part-drawn bookings).
const sql = readFileSync('supabase/migrations/20261029100000_booking_season_end_expiry.sql', 'utf8')
  .replace(/\r\n/g, '\n');
const code = sql.replace(/--.*$/gm, '');

describe('20261029100000 booking season-end expiry', () => {
  it('adds a nullable pick column that signed-in users can read but not write', () => {
    expect(code).toContain('ALTER TABLE public.quotes ADD COLUMN chosen_expiry_date date;');
    expect(code).toContain('GRANT SELECT (chosen_expiry_date) ON public.quotes TO authenticated;');
    expect(code).toContain('GRANT REFERENCES (chosen_expiry_date) ON public.quotes TO authenticated;');
    expect(code).toContain('GRANT SELECT (chosen_expiry_date) ON public.quotes TO anon;');
    expect(code).not.toMatch(/GRANT (INSERT|UPDATE)/);
  });

  it('sets the expiry at send from the pick, else season end, and refuses a past pick', () => {
    expect(code).toContain(
      'v_quote.expires_at := COALESCE(v_quote.chosen_expiry_date, season_end_date(compute_season(v_today)));',
    );
    expect(code).toMatch(/IF v_quote\.chosen_expiry_date < v_today THEN\s+RAISE EXCEPTION 'QUOTE_EXPIRY_IN_PAST:/);
    expect(code).not.toContain('COALESCE(v_quote.valid_days, 15)');
  });

  it('save_quote stores the pick, and a missing key keeps it', () => {
    expect(code).toContain("(p_quote_payload->>'chosen_expiry_date')::date,");
    expect(code).toMatch(
      /chosen_expiry_date = CASE WHEN p_quote_payload \? 'chosen_expiry_date'\s+THEN \(p_quote_payload->>'chosen_expiry_date'\)::date ELSE chosen_expiry_date END,/,
    );
  });

  it('alerts once per date on part-drawn bookings and still never expires them', () => {
    expect(code).toContain("'booking_past_expiry'");
    expect(code).toContain('AND n.created_at >= q.expires_at');
    // The expiry loop keeps its "no draws" and "not planned" guards.
    expect(code).toMatch(/WHERE q\.expires_at < CURRENT_DATE\s+AND q\.status IN \('sent', 'revised'\)\s+AND q\.deleted_at IS NULL\s+AND NOT EXISTS \(/);
    expect(code.match(/AND q\.is_planned = false/g)).toHaveLength(2);
  });

  it('re-emits only the three pinned functions, inside one transaction', () => {
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(3);
    expect(code).not.toMatch(/DROP (TABLE|COLUMN|FUNCTION|TRIGGER|POLICY)/);
    expect(code).toContain('DO $preflight$');
    expect(code).toContain('DO $postflight$');
    expect(code).toContain("'40ca472ad197a2ca42ad991f8ecc7f75'");
    expect(code).toContain("'ef0245b6fa3e2d53123f02675337f5d6'");
    expect(code).toContain("'1c00c13430544ebacf66569f62da3956'");
  });
});
