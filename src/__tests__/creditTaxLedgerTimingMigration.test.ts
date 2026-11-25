/**
 * Contract for 20270308040000_credit_tax_ledger_timing (#2091). The behaviour is proven on the real schema by
 * scripts/smoke/prove-credit-tax-ledger-timing-real-schema.mjs; this pins the shape the proof relies on.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync('supabase/migrations/20270308040000_credit_tax_ledger_timing.sql', 'utf8');
const BODY = MIGRATION.slice(MIGRATION.indexOf('AS $function$'), MIGRATION.indexOf('$function$;'));

describe('20270308040000 credit tax ledger timing', () => {
  it('runs as one transaction and pins the one body it re-emits', () => {
    expect(MIGRATION).toContain('CREDIT_TAX_LEDGER_TIMING_NOT_IN_TRANSACTION');
    expect(MIGRATION).toContain("'6b175becb29ac202c5b1983ddc6686a5'");
    expect(MIGRATION.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(MIGRATION).toContain('CREATE OR REPLACE FUNCTION public._freeze_credit_sales_tax_20270109(p_invoice_id uuid)');
  });

  it('pools every posted lot, with no cut at the credit posting time and nothing else changed', () => {
    expect(BODY.length).toBeGreaterThan(1000);
    expect(BODY).not.toContain('<= v_inv.booked_at');
    expect(BODY).toContain("AND i.status IN ('posted', 'overdue', 'paid')");
    expect(BODY).not.toContain('pooled');
    expect(MIGRATION.replace(BODY, '')).not.toMatch(/ALTER TABLE|UPDATE public\.|INSERT INTO public\.|GRANT |REVOKE /);
  });
});
