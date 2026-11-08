import { describe, expect, it } from 'vitest';
import { duplicateReasons, namesLookAlike } from './customerDuplicates';

describe('customer duplicate matching', () => {
  it('treats filler words, punctuation and case as the same name', () => {
    expect(namesLookAlike('Smith Farms, LLC', 'smith farm')).toBe(true);
    expect(namesLookAlike('Wells & Sons', 'Wells and Sons Inc')).toBe(true);
  });

  it('flags a name inside another and small typos, but not unrelated names', () => {
    expect(namesLookAlike('Smith', 'Smith Brothers')).toBe(true);
    expect(namesLookAlike('Hendricks Grain', 'Hendriks Grain')).toBe(true);
    expect(namesLookAlike('Smithson Grain', 'Smith Grain Co')).toBe(false);
    expect(namesLookAlike('Johnson Farms', 'Jensen Ranch')).toBe(false);
    expect(namesLookAlike('Farms LLC', 'Farm')).toBe(false);
  });

  it('matches phone by its last 10 digits and email ignoring case', () => {
    expect(duplicateReasons(
      { farm_name: 'Alpha', phone: '+1 (555) 123-4567', email: 'A@X.com' },
      { farm_name: 'Zulu', phone: '555.123.4567', email: ' a@x.com' },
    )).toEqual(['same phone', 'same email']);
    expect(duplicateReasons({ farm_name: 'Alpha', phone: '123' }, { farm_name: 'Zulu', phone: '123' })).toEqual([]);
  });
});
