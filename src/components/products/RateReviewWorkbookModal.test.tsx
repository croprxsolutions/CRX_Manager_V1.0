import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ toast: vi.fn(), parse: vi.fn(), preview: vi.fn(), commit: vi.fn() }));
vi.mock('../../lib/db', () => ({
  supabaseUntyped: { rpc: vi.fn() },
  assertRpcResult: (data: unknown) => data,
  sanitizeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('../../lib/rateReviewWorkbook', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/rateReviewWorkbook')>()),
  parseRateReviewWorkbook: H.parse,
  previewRateReview: H.preview,
  commitRateReview: H.commit,
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import RateReviewWorkbookModal from './RateReviewWorkbookModal';
import type { ParsedRateReview } from '../../lib/rateReviewWorkbook';

const P1 = '11111111-1111-4111-8111-111111111111';
const upload: ParsedRateReview = {
  rates: [
    { sheetRow: 2, parent_name: 'Atrazine 4L', rate_id: 'r1', parent_id: P1, expected_row_version: 3, basis: 'per_acre', source: 'house_standard',
      low: null, recommended: '13', high: null, unit: 'fl_oz', is_quoting_default: true, over_label_reason: null, decision: 'approve', reason: null },
    { sheetRow: 3, parent_name: 'Atrazine 4L', rate_id: 'r2', parent_id: P1, expected_row_version: 1, basis: 'per_acre', source: 'label',
      low: null, recommended: null, high: '2', unit: 'qt', is_quoting_default: false, over_label_reason: null, decision: 'delete', reason: 'dup' },
  ],
  outcomes: [{ sheetRow: 2, parent_name: 'Atrazine 4L', parent_id: P1, expected_outcome_version: 2, outcome: 'approved_default', note: null }],
};

async function uploadFile() {
  H.parse.mockResolvedValue(upload);
  render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
  const file = new File(['x'], 'review.xlsx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
  fireEvent.change(screen.getByLabelText('Rate review workbook file'), { target: { files: [file] } });
}

describe('RateReviewWorkbookModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows each problem by sheet row and blocks Confirm', async () => {
    H.preview.mockResolvedValue({
      rates: [
        { index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'], label_check: { status: 'within' } },
        { index: 1, rate_id: 'r2', parent_id: P1, name: 'Atrazine 4L', status: 'stale', problem: 'changed by someone else since you downloaded it' },
      ],
      outcomes: [{ index: 0, parent_id: P1, name: 'Atrazine 4L', status: 'invalid',
        problem: 'PRODUCT_RATE_OUTCOME_DRAFTS_LEFT: Atrazine 4L has 1 rate(s) not yet approved; approve or delete them first' }],
    });
    await uploadFile();
    expect(await screen.findByText(/Draft Rates row 3 \(Atrazine 4L\): changed by someone else/)).toBeInTheDocument();
    expect(screen.getByText(/Rate Outcomes row 2 \(Atrazine 4L\): Atrazine 4L has 1 rate\(s\) not yet approved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm rate review/ })).toBeDisabled();
    expect(H.preview).toHaveBeenCalledWith(upload);
  });

  it('previews the changes, then commits the same upload once with a key', async () => {
    H.preview.mockResolvedValue({
      rates: [
        { index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'],
          label_check: { status: 'not_checked', why: 'no_registration' } },
        { index: 1, rate_id: 'r2', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['delete'] },
      ],
      outcomes: [{ index: 0, parent_id: P1, name: 'Atrazine 4L', outcome: 'approved_default', note: null, status: 'change' }],
    });
    H.commit.mockResolvedValue({ rates_changed: 2, outcomes_changed: 1, rates: [], outcomes: [] });
    await uploadFile();
    expect(await screen.findByText('label maximum not checked (no registration)')).toBeInTheDocument();
    expect(screen.getByText('delete')).toBeInTheDocument();
    expect(screen.getByText('outcome: approved default')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rate review (3 changes)' }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    expect(H.commit).toHaveBeenCalledWith(upload, expect.any(String));
    expect(await screen.findByText(/Saved 2 rates and 1 outcome\./)).toBeInTheDocument();
  });

  it('drops the preview after a refused commit so the next try checks again', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    H.commit.mockRejectedValue(new Error('RATE_REVIEW_REFUSED: nothing was saved. Atrazine 4L: changed'));
    await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    expect(await screen.findByRole('button', { name: 'Preview again' })).toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('nothing was saved'));
  });
});
