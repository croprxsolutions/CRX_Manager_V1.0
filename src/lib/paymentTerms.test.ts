import { describe, expect, it } from 'vitest';
import { dueDateFromTerms, paymentTermsDays } from './paymentTerms';

// The same table the real-schema proof runs against public.parse_payment_terms_days.
const CASES: Array<[string | null, number]> = [
  ['Net 15', 15], ['Net 30', 30], ['net_30', 30], ['NET-45', 45], ['2/10 Net 30', 30], ['2% 10 net 30', 30], ['1/15 Net 60', 60],
  ['Due on receipt', 0], ['  due upon receipt ', 0], ['receipt', 0], ['\tDue on receipt', 30], ['Immediately', 0], [null, 30], ['', 30], ['COD', 30],
  ['15 days', 15], ['Net 0', 30], ['Net 400', 30], ['Net 99999999999999999999', 30], ['Net 365', 365],
];

describe('paymentTermsDays mirrors parse_payment_terms_days', () => {
  it.each(CASES)('%s -> %i', (terms, days) => {
    expect(paymentTermsDays(terms)).toBe(days);
  });

  it('adds the days across a month end', () => {
    expect(dueDateFromTerms('2026-11-20', '2/10 Net 30')).toBe('2026-12-20');
    expect(dueDateFromTerms('2026-11-20', 'Due on receipt')).toBe('2026-11-20');
  });

  it('gives no date (never throws) while the invoice date is half-typed', () => {
    expect(dueDateFromTerms('20261-11-06', 'Net 30')).toBe('');
    expect(dueDateFromTerms('', 'Net 30')).toBe('');
    expect(dueDateFromTerms('2026-02-30', 'Net 15')).toBe('');
  });
});
