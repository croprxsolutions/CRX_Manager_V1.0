import { describe, it, expect } from 'vitest';
import { formatSharePct, invoiceStatusBadge, statusLabel } from './statusLabel';

describe('statusLabel', () => {
  it('title-cases a database status', () => {
    expect(statusLabel('partially_fulfilled')).toBe('Partially Fulfilled');
  });
});

describe('invoiceStatusBadge', () => {
  it('uses one palette for every invoice status', () => {
    expect(invoiceStatusBadge('draft')).toEqual({ variant: 'draft', label: 'Draft' });
    expect(invoiceStatusBadge('unposted')).toEqual({ variant: 'draft', label: 'Unposted' });
    expect(invoiceStatusBadge('posted')).toEqual({ variant: 'success', label: 'Posted' });
    expect(invoiceStatusBadge('paid')).toEqual({ variant: 'paid', label: 'Paid' });
    expect(invoiceStatusBadge('overdue')).toEqual({ variant: 'warning', label: 'Overdue' });
    expect(invoiceStatusBadge('voided')).toEqual({ variant: 'error', label: 'Voided' });
    expect(invoiceStatusBadge('cancelled')).toEqual({ variant: 'draft', label: 'Cancelled' });
  });

  it('Paid is a darker green than Posted', () => {
    expect(invoiceStatusBadge('paid').variant).not.toBe(invoiceStatusBadge('posted').variant);
  });

  it('an unknown status stays grey with a title-case label', () => {
    expect(invoiceStatusBadge('partially_paid')).toEqual({ variant: 'default', label: 'Partially Paid' });
  });

  it('a status not read yet draws an empty grey pill instead of throwing', () => {
    expect(invoiceStatusBadge(undefined)).toEqual({ variant: 'default', label: '' });
  });
});

describe('formatSharePct', () => {
  it('keeps at most two decimals', () => {
    expect(formatSharePct(50)).toBe('50%');
    expect(formatSharePct(33.333333)).toBe('33.33%');
    expect(formatSharePct(12.5)).toBe('12.5%');
    expect(formatSharePct(66.666666)).toBe('66.67%');
  });
});
