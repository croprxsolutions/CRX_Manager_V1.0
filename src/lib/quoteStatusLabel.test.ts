import { describe, it, expect } from 'vitest';
import { quoteStatusLabel } from './quoteStatusLabel';

describe('quoteStatusLabel', () => {
  it.each([
    ['draft', 'Draft'],
    ['sent', 'Sent'],
    ['revised', 'Revised'],
    ['accepted', 'Accepted'],
    ['declined', 'Declined'],
    ['expired', 'Expired'],
    ['cancelled', 'Cancelled'],
    ['closed_by_application', 'Fulfilled'],
    ['closed_short', 'Closed short'],
  ])('%s -> %s', (status, label) => {
    expect(quoteStatusLabel(status)).toBe(label);
  });

  it('turns every underscore into a space and capitalizes the first letter', () => {
    expect(quoteStatusLabel('pending_review_now')).toBe('Pending review now');
  });
});
