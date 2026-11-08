import { beforeEach, describe, expect, it, vi } from 'vitest';
import { duplicateReasons, findLikelyDuplicateCustomers, namesLookAlike } from './customerDuplicates';

const mocks = vi.hoisted(() => ({ from: vi.fn(), or: vi.fn(), not: vi.fn(), limit: vi.fn() }));
vi.mock('./db', () => ({ supabase: { from: mocks.from } }));

beforeEach(() => {
  vi.clearAllMocks();
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'order']) builder[m] = vi.fn(() => builder);
  builder.or = mocks.or.mockImplementation(() => builder);
  builder.not = mocks.not.mockImplementation(() => builder);
  builder.limit = mocks.limit;
  mocks.from.mockReturnValue(builder);
});

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
    expect(duplicateReasons({ farm_name: 'Alpha', phone: '123-4567' }, { farm_name: 'Zulu', phone: '(555) 123-4567' })).toEqual(['same phone']);
  });
});

describe('findLikelyDuplicateCustomers', () => {
  const row = (id: string, farm_name: string, extra: Record<string, unknown> = {}) => (
    { id, farm_name, phone: null, email: null, city: null, state: null, is_active: true, ...extra }
  );

  it('searches name-word prefixes and phone/email separately, leaves out the customer itself, and keeps only real matches', async () => {
    mocks.limit
      .mockResolvedValueOnce({ data: [row('1', 'Hendricks'), row('2', 'Henderson Seed')], error: null })
      .mockResolvedValueOnce({ data: [row('3', 'Zulu', { email: 'A"B@x.com' }), row('1', 'Hendricks')], error: null });

    const matches = await findLikelyDuplicateCustomers({ farm_name: 'Hendriks Farms', email: 'a"b@x.com' }, 'self-id');

    expect(mocks.or).toHaveBeenNthCalledWith(1, 'farm_name.ilike."%hend%"');
    expect(mocks.or).toHaveBeenNthCalledWith(2, 'email.ilike."%a\\"b@x.com%"');
    expect(mocks.not).toHaveBeenCalledWith('id', 'in', '(self-id)');
    expect(matches.map((m) => [m.id, m.reasons])).toEqual([['3', ['same email']], ['1', ['similar name']]]);
  });

  it('reads nothing when there is nothing to search by, and passes a database error to the caller', async () => {
    expect(await findLikelyDuplicateCustomers({ farm_name: 'Farms LLC' })).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
    mocks.limit.mockResolvedValue({ data: null, error: new Error('down') });
    await expect(findLikelyDuplicateCustomers({ farm_name: 'Smith' })).rejects.toThrow('down');
  });
});
