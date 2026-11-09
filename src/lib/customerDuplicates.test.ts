import { beforeEach, describe, expect, it, vi } from 'vitest';
import { duplicateReasons, findLikelyDuplicateCustomers, namesLookAlike } from './customerDuplicates';

const mocks = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn(), range: vi.fn() }));
vi.mock('./db', () => ({ supabase: { from: mocks.from } }));

beforeEach(() => {
  vi.clearAllMocks();
  const builder: Record<string, unknown> = {};
  builder.select = mocks.select.mockImplementation(() => builder);
  builder.order = vi.fn(() => builder);
  builder.range = mocks.range;
  mocks.from.mockReturnValue(builder);
});

describe('customer duplicate matching', () => {
  it('treats filler words, punctuation, case and accents as the same name', () => {
    expect(namesLookAlike('Smith Farms, LLC', 'smith farm')).toBe(true);
    expect(namesLookAlike('Wells & Sons', 'Wells and Sons Inc')).toBe(true);
    expect(namesLookAlike('José Farms', 'Jose Farms')).toBe(true);
    expect(namesLookAlike('牧场有限公司', '牧场有限公司 LLC')).toBe(true);
    expect(namesLookAlike('牧场有限公司', '果园')).toBe(false);
  });

  it('flags a name inside another and small typos, but not unrelated names', () => {
    expect(namesLookAlike('Smith', 'Smith Brothers')).toBe(true);
    expect(namesLookAlike('Hendricks Grain', 'Hendriks Grain')).toBe(true);
    expect(namesLookAlike('Smtih Farms', 'Smith Farms')).toBe(true);
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
    expect(duplicateReasons({ farm_name: 'Alpha', phone: '555-123-4567' }, { farm_name: 'Zulu', phone: '+1 (555) 123-4567 ext. 89' })).toEqual(['same phone']);
    expect(duplicateReasons({ farm_name: 'Alpha', phone: '555-123-4567' }, { farm_name: 'Zulu', phone: '555-123-4567x89' })).toEqual(['same phone']);
  });
});

describe('findLikelyDuplicateCustomers', () => {
  const row = (id: string, farm_name: string, extra: Record<string, unknown> = {}) => (
    { id, farm_name, phone: null, email: null, city: null, state: null, is_active: true, ...extra }
  );
  const page = (rows: unknown[]) => ({ data: rows, error: null, count: rows.length });

  it('compares every customer, so a typo in the first letters, an accent or a long list cannot hide one', async () => {
    // 250 other "Smith" customers sort ahead of the real match, past the old 200-row cap.
    const crowd = Array.from({ length: 250 }, (_, i) => row(`c${i}`, `Smith A${String(i).padStart(3, '0')}`, { phone: '111-1111' }));
    mocks.range.mockResolvedValueOnce(page([
      ...crowd,
      row('self-id', 'Smith Farms'),
      row('1', 'Smith Farms'),
      row('2', 'José Farms'),
      row('3', 'Zulu', { email: 'A"B@x.com' }),
      row('4', 'Henderson Seed'),
    ]));

    const typo = await findLikelyDuplicateCustomers({ farm_name: 'Smtih Farms', email: 'a"b@x.com' }, 'self-id');
    expect(mocks.select).toHaveBeenCalledWith('id, farm_name, phone, email, city, state, is_active', { count: 'exact' });
    expect(typo.map((m) => [m.id, m.reasons])).toEqual([['1', ['similar name']], ['3', ['same email']]]);

    mocks.range.mockResolvedValueOnce(page([row('2', 'José Farms'), row('4', 'Henderson Seed')]));
    const accent = await findLikelyDuplicateCustomers({ farm_name: 'Jose Farms' });
    expect(accent.map((m) => m.id)).toEqual(['2']);
  });

  it('reads nothing when there is nothing to search by, and passes a database error to the caller', async () => {
    expect(await findLikelyDuplicateCustomers({ farm_name: 'Farms LLC' })).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
    mocks.range.mockResolvedValue({ data: null, error: { message: 'down' }, count: null });
    await expect(findLikelyDuplicateCustomers({ farm_name: 'Smith' })).rejects.toThrow('down');
  });
});
