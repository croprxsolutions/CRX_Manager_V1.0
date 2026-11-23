import { beforeEach, describe, expect, it, vi } from 'vitest';

// The two reads applyKeptEpa makes: the job (still visible?) and its kept rows for the printed products.
const db = vi.hoisted(() => ({
  job: { data: { id: 'job-1' } as unknown, error: null as unknown },
  kept: { data: [] as unknown[] | null, error: null as unknown },
  keptFilter: [] as unknown[],
}));
vi.mock('./db', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'jobs') return { select: () => ({ eq: () => ({ maybeSingle: async () => db.job }) }) };
      return {
        select: () => ({
          eq: () => ({
            in: async (_column: string, ids: unknown[]) => {
              db.keptFilter = ids;
              return db.kept;
            },
          }),
        }),
      };
    },
  },
}));

import { applyKeptEpa, jobEpaText } from './jobEpa';
import { buildProofDraft, renderProofHtml, renderProofText, type JobProofData, type ProofProduct } from './proofNotification';

const labels = () =>
  new Map([
    ['p-corrected', { epa_registration: '100-9' as string | null }],
    ['p-none', { epa_registration: '200-2' as string | null }],
    ['p-old', { epa_registration: '300-9' as string | null }],
    ['p-open', { epa_registration: '400-4' as string | null }],
  ]);

describe('jobEpaText', () => {
  it('kept number, kept with no number, not recorded, else the catalog', () => {
    expect(jobEpaText({ epa_registration: '100-1', not_recorded: false }, '100-9')).toBe('100-1');
    expect(jobEpaText({ epa_registration: null, not_recorded: false }, '200-2')).toBe('Unknown');
    expect(jobEpaText({ epa_registration: null, not_recorded: true }, '300-9')).toBe('Not recorded');
    expect(jobEpaText({ epa_registration: '9-9', not_recorded: true }, '300-9')).toBe('Not recorded');
    expect(jobEpaText(undefined, '400-4')).toBe('400-4');
    expect(jobEpaText(undefined, null)).toBeNull();
  });
});

describe('applyKeptEpa', () => {
  beforeEach(() => {
    db.job = { data: { id: 'job-1' }, error: null };
    db.kept = {
      data: [
        { product_id: 'p-corrected', epa_registration: '100-1', not_recorded: false },
        { product_id: 'p-none', epa_registration: null, not_recorded: false },
        { product_id: 'p-old', epa_registration: null, not_recorded: true },
      ],
      error: null,
    };
  });

  it('replaces the catalog number with the kept one and asks only for the printed products', async () => {
    const m = labels();
    await applyKeptEpa('job-1', m);
    expect([...m.values()].map((l) => l.epa_registration)).toEqual(['100-1', 'Unknown', 'Not recorded', '400-4']);
    expect(db.keptFilter).toEqual(['p-corrected', 'p-none', 'p-old', 'p-open']);
  });

  it('aborts (never prints the catalog) when the job is no longer visible or the kept rows cannot be read', async () => {
    db.job = { data: null, error: null };
    await expect(applyKeptEpa('job-1', labels())).rejects.toThrow(/no longer be opened/);
    db.job = { data: { id: 'job-1' }, error: null };
    db.kept = { data: null, error: { message: 'boom' } };
    await expect(applyKeptEpa('job-1', labels())).rejects.toEqual({ message: 'boom' });
  });
});

describe('proof email EPA line (KI-195)', () => {
  const product = (name: string, extra: Partial<ProofProduct>): ProofProduct => ({
    product_name: name,
    rate_per_acre: 1,
    rate_unit: 'pt',
    rei_hours: null,
    phi_days: null,
    signal_word: null,
    epa_registration: null,
    sort_order: 0,
    ...extra,
  });
  const data = (products: ProofProduct[]): JobProofData => ({
    job_id: 'job-1',
    job_number: 'J-1',
    status: 'completed',
    application_date: '2026-11-20',
    applicator_name: null,
    fields: [],
    products,
    weather: null,
  });

  it('prints the kept number, Unknown, Not recorded and an unlocked catalog number in the HTML and text', () => {
    const draft = buildProofDraft(
      data([
        product('Kept', { epa_registration: '100-1', epa_kept: true, epa_not_recorded: false }),
        product('NoNumber', { epa_registration: null, epa_kept: true, epa_not_recorded: false }),
        product('Old & <Co>', { epa_registration: null, epa_kept: true, epa_not_recorded: true }),
        product('Open', { epa_registration: '400-4', epa_kept: false, epa_not_recorded: false }),
        product('OpenBlank', { epa_registration: '  ', epa_kept: false, epa_not_recorded: false }),
      ]),
    );
    expect(draft.products.map((p) => p.epa)).toEqual(['100-1', 'Unknown', 'Not recorded', '400-4', null]);
    const html = renderProofHtml({ customerName: 'Farm', draft });
    for (const t of ['EPA Reg. No. 100-1', 'EPA Reg. No. Unknown', 'EPA Reg. No. Not recorded', 'EPA Reg. No. 400-4']) {
      expect(html).toContain(t);
    }
    expect(html.match(/EPA Reg\. No\./g)).toHaveLength(4);
    const text = renderProofText({ customerName: 'Farm', draft });
    expect(text).toContain('    EPA Reg. No. 100-1');
    expect(text).toContain('    EPA Reg. No. Not recorded');
  });

  it('prints no EPA line from a database that does not yet send epa_kept', () => {
    const draft = buildProofDraft(data([product('Kept', { epa_registration: '100-9' })]));
    expect(draft.products[0].epa).toBeNull();
    expect(renderProofHtml({ customerName: 'Farm', draft })).not.toContain('EPA Reg. No.');
  });
});
