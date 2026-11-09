import { describe, it, expect } from 'vitest';
import { quoteStatusLabel, quoteBadgeVariant } from './quoteStatusLabel';

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

describe('quoteBadgeVariant', () => {
  it.each([
    ['draft', 'slate'],
    ['sent', 'sky'],
    ['revised', 'violet'],
    ['accepted', 'accepted'],
    ['declined', 'rose'],
    ['expired', 'warning'],
    ['cancelled', 'default'],
    ['closed_by_application', 'teal'],
    ['closed_short', 'orange'],
  ])('%s -> %s (the quote boards palette)', (status, variant) => {
    expect(quoteBadgeVariant(status)).toBe(variant);
  });

  it('falls back to default for an unknown status', () => {
    expect(quoteBadgeVariant('something_new')).toBe('default');
  });
});
