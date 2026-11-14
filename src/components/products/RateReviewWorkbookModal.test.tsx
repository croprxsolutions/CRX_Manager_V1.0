import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { PricingWorkbookFormatError } from '../../lib/productPricingWorkbook';
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
  recorded: {},
};

async function uploadFile() {
  H.parse.mockResolvedValue(upload);
  const view = render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
  const file = new File(['x'], 'review.xlsx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
  fireEvent.change(screen.getByLabelText('Rate review workbook file'), { target: { files: [file] } });
  return view;
}

describe('RateReviewWorkbookModal', () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });

  it('keeps every file problem visible without previewing or saving, then clears on a corrected upload', async () => {
    H.parse.mockRejectedValueOnce(new PricingWorkbookFormatError('Draft Rates row 2: bad decision.\nDraft Rates row 2: bad default.'));
    H.preview.mockResolvedValue({ rates: [], outcomes: [] });
    await uploadFile();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Draft Rates row 2: bad decision.');
    expect(alert).toHaveTextContent('Draft Rates row 2: bad default.');
    expect(H.preview).not.toHaveBeenCalled();
    expect(H.commit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Confirm rate review/ })).not.toBeInTheDocument();
    const repaired = new File(['repaired'], 'review.xlsx');
    Object.defineProperty(repaired, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    fireEvent.change(screen.getByLabelText('Rate review workbook file'), { target: { files: [repaired] } });
    await waitFor(() => expect(H.preview).toHaveBeenCalledWith(upload));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

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
    // The value being approved is on screen, so a mistyped 130 for 13 is visible before Confirm.
    expect(screen.getByText('per_acre house_standard: - / 13 / - fl_oz, quoting default')).toBeInTheDocument();
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

  it('keeps the preview after a lost reply so Confirm retries with the same key', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    H.commit.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ rates_changed: 1, outcomes_changed: 0, rates: [], outcomes: [] });
    await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledTimes(2));
    expect(H.commit.mock.calls[1][1]).toBe(H.commit.mock.calls[0][1]);
    expect(await screen.findByText(/Saved 1 rate and 0 outcomes\./)).toBeInTheDocument();
  });

  it('after a lost reply, remounting restores the original preview and key without an automatic save', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    H.commit.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ rates_changed: 1, outcomes_changed: 0, rates: [], outcomes: [] });
    const view = await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledTimes(1));
    view.unmount();
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    expect(await screen.findByText(/earlier Confirm got no reply/)).toBeInTheDocument();
    expect(H.preview).toHaveBeenCalledTimes(1);
    expect(H.commit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledTimes(2));
    expect(H.commit.mock.calls[1][1]).toBe(H.commit.mock.calls[0][1]);
    expect(await screen.findByText(/Saved 1 rate and 0 outcomes\./)).toBeInTheDocument();
  });

  it('offers a hand check when an old in-flight Confirm settles after remount', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    let finishCommit!: (receipt: unknown) => void;
    H.commit.mockImplementation(() => new Promise((resolve) => { finishCommit = resolve; }));
    const first = await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    const stored = JSON.parse(sessionStorage.getItem('crx:pending-retry:rate-review:u1')!);
    first.unmount();
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    expect(await screen.findByText(/earlier Confirm got no reply/)).toBeInTheDocument();
    await act(async () => finishCommit({ rates_changed: 1, outcomes_changed: 0, rates: [], outcomes: [] }));
    expect(sessionStorage.getItem('crx:pending-retry:rate-review:u1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Confirm rate review/ }));
    expect(H.commit).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: 'I checked the fresh workbook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm rate review/ })).toBeDisabled();
    const recovered = JSON.parse(sessionStorage.getItem('crx:pending-retry:rate-review:u1')!);
    expect(recovered.key).toBe(stored.key);
    expect(recovered.request).toEqual(stored.request);
    expect(recovered.needsCheck).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'I checked the fresh workbook' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I checked; clear reminder' }));
    expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeEnabled();
  });

  it('keeps the original key for a hand check when the old save clears storage and the remounted replay loses its reply', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    let finishOld!: (receipt: unknown) => void;
    let loseReplay!: (error: Error) => void;
    H.commit.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { loseReplay = reject; }));
    const first = await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    const name = 'crx:pending-retry:rate-review:u1';
    const original = JSON.parse(sessionStorage.getItem(name)!);
    first.unmount();
    const restored = render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledTimes(2));
    expect(H.commit.mock.calls[1][1]).toBe(original.key);
    await act(async () => finishOld({ rates_changed: 1, outcomes_changed: 0, rates: [], outcomes: [] }));
    expect(sessionStorage.getItem(name)).toBeNull();
    await act(async () => loseReplay(new TypeError('Failed to fetch')));
    expect(await screen.findByRole('button', { name: 'I checked the fresh workbook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm rate review/ })).toBeDisabled();
    expect(JSON.parse(sessionStorage.getItem(name)!)).toMatchObject({ key: original.key, request: original.request, needsCheck: true });
    expect(H.toast).not.toHaveBeenCalledWith('success', expect.any(String));
    restored.unmount();
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'I checked the fresh workbook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm rate review/ })).toBeDisabled();
    expect(H.commit).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'definitive refusal'] as const)('keeps a newer unanswered request when the old Confirm ends in %s', async (ending) => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    const receipt = { rates_changed: 1, outcomes_changed: 0, rates: [], outcomes: [] };
    let finishOld!: () => void;
    H.commit.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finishOld = () => ending === 'success' ? resolve(receipt) : reject(new Error('RATE_REVIEW_REFUSED: nothing was saved'));
    })).mockRejectedValueOnce(new Error('RATE_REVIEW_REFUSED: check the earlier result'))
      .mockImplementationOnce(() => new Promise(() => {}));
    const first = await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    const oldKey = JSON.parse(sessionStorage.getItem('crx:pending-retry:rate-review:u1')!).key;
    first.unmount();
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    expect(await screen.findByRole('button', { name: 'I checked the fresh workbook' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I checked the fresh workbook' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I checked; clear reminder' }));
    const file = new File(['next'], 'next-review.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    fireEvent.change(screen.getByLabelText('Rate review workbook file'), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledTimes(3));
    const newer = sessionStorage.getItem('crx:pending-retry:rate-review:u1');
    expect(newer).not.toBeNull();
    expect(JSON.parse(newer!).key).not.toBe(oldKey);
    await act(async () => finishOld());
    expect(sessionStorage.getItem('crx:pending-retry:rate-review:u1')).toBe(newer);
    expect(H.commit).toHaveBeenCalledTimes(3);
  });

  it('keeps the uncertain intent for a hand check when a later replay is refused', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    H.commit.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new Error('RATE_REVIEW_REFUSED: nothing was saved. Atrazine 4L: changed'));
    const view = await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledTimes(1));
    view.unmount();
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    expect(await screen.findByRole('button', { name: 'I checked the fresh workbook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm rate review/ })).toBeDisabled();
  });

  it('blocks a later upload while an unanswered intent is saved', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    H.commit.mockRejectedValue(new TypeError('Failed to fetch'));
    await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeDisabled();
    const stored = sessionStorage.getItem('crx:pending-retry:rate-review:u1');
    expect(stored).toContain('"key"');
    fireEvent.change(screen.getByLabelText('Rate review workbook file'), { target: { files: [new File(['other'], 'other.xlsx')] } });
    expect(sessionStorage.getItem('crx:pending-retry:rate-review:u1')).toBe(stored);
    expect(H.parse).toHaveBeenCalledTimes(1);
  });

  it('refuses an expired retry after remount and keeps it visible for a hand check', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    H.commit.mockRejectedValue(new TypeError('Failed to fetch'));
    const view = await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    const name = 'crx:pending-retry:rate-review:u1';
    const stored = JSON.parse(sessionStorage.getItem(name)!);
    sessionStorage.setItem(name, JSON.stringify({ ...stored, sentAt: Date.now() - 25 * 60 * 60 * 1000 }));
    view.unmount();
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'I checked the fresh workbook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm rate review/ })).toBeDisabled();
    expect(H.commit).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(name)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'I checked the fresh workbook' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I checked; clear reminder' }));
    expect(sessionStorage.getItem(name)).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeEnabled();
  });

  it('refuses a send when storage is unavailable', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    await uploadFile();
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied'); });
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('nothing was sent')));
    expect(H.commit).not.toHaveBeenCalled();
    storage.mockRestore();
  });

  it('refuses the first send when its written retry record cannot be read back', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    await uploadFile();
    const write = sessionStorage.setItem.bind(sessionStorage);
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      write(key, key === 'crx:pending-retry:rate-review:u1' ? '{"damaged":true}' : value);
    });
    try {
      fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
      await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('nothing was sent')));
      expect(H.commit).not.toHaveBeenCalled();
    } finally {
      storage.mockRestore();
    }
  });

  it('stores the exact upload and preview before the first RPC dispatch', async () => {
    const result = { rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] };
    H.preview.mockResolvedValue(result);
    H.commit.mockImplementation(async () => {
      const kept = JSON.parse(sessionStorage.getItem('crx:pending-retry:rate-review:u1')!);
      expect(kept.request.actorId).toBe('u1');
      expect(kept.request.upload).toEqual(upload);
      expect(kept.request.preview).toEqual(result);
      return { rates_changed: 1, outcomes_changed: 0, rates: [], outcomes: [] };
    });
    await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    expect(sessionStorage.getItem('crx:pending-retry:rate-review:u1')).toBeNull();
  });

  it('keeps an idempotency mismatch for a hand check instead of retiring the key', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    H.commit.mockRejectedValue(new Error('IDEMPOTENCY_PAYLOAD_MISMATCH'));
    await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    expect(await screen.findByRole('button', { name: 'I checked the fresh workbook' })).toBeInTheDocument();
    expect(sessionStorage.getItem('crx:pending-retry:rate-review:u1')).toContain('"needsCheck":true');
    expect(screen.getByRole('button', { name: /Confirm rate review/ })).toBeDisabled();
  });

  it('refuses to restore a damaged rate row instead of rendering or retrying it', () => {
    const name = 'crx:pending-retry:rate-review:u1';
    sessionStorage.setItem(name, JSON.stringify({ key: 'old-key', sentAt: Date.now(), request: {
      actorId: 'u1', upload: { ...upload, rates: [null] },
      preview: { rates: [{ index: 0, status: 'change' }], outcomes: [] },
    } }));
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    expect(screen.queryByLabelText('Rate review preview')).not.toBeInTheDocument();
    expect(H.commit).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(name)).toBeNull();
  });

  it('restores a valid pending review whose downloaded versions are zero', async () => {
    const initial = { ...upload, rates: [{ ...upload.rates[0], expected_row_version: 0 }],
      outcomes: [{ ...upload.outcomes[0], expected_outcome_version: 0 }] };
    sessionStorage.setItem('crx:pending-retry:rate-review:u1', JSON.stringify({ key: 'old-key', sentAt: Date.now(), request: {
      actorId: 'u1', upload: initial,
      preview: { rates: [{ index: 0, status: 'change' }], outcomes: [{ index: 0, status: 'change', parent_id: P1, name: 'Atrazine 4L' }] },
    } }));
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    expect(await screen.findByText(/earlier Confirm got no reply/)).toBeInTheDocument();
    expect(H.commit).not.toHaveBeenCalled();
  });

  it('shows no other admin a previous admin’s unanswered preview', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    H.commit.mockRejectedValue(new TypeError('Failed to fetch'));
    const view = await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    view.rerender(<RateReviewWorkbookModal open profileId="u2" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeEnabled());
    expect(screen.queryByText(/earlier Confirm got no reply/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem('crx:pending-retry:rate-review:u1')).not.toBeNull();
  });

  it('ignores a preview that finishes after the signed-in profile changes', async () => {
    let finishPreview!: (result: unknown) => void;
    H.preview.mockImplementation(() => new Promise((resolve) => { finishPreview = resolve; }));
    const view = await uploadFile();
    await waitFor(() => expect(H.preview).toHaveBeenCalledOnce());
    view.rerender(<RateReviewWorkbookModal open profileId="u2" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeEnabled());
    await act(async () => finishPreview({ rates: [{ index: 0, parent_id: P1, status: 'change' }], outcomes: [] }));
    expect(screen.queryByText(/Preview: 2 edited rates/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm rate review/ })).not.toBeInTheDocument();
    expect(H.toast).not.toHaveBeenCalled();
  });

  it('settles the original actor’s receipt without showing it to a later signed-in profile', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    let finishCommit!: (receipt: unknown) => void;
    H.commit.mockImplementation(() => new Promise((resolve) => { finishCommit = resolve; }));
    const view = await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    view.rerender(<RateReviewWorkbookModal open profileId="u2" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeEnabled());
    await act(async () => finishCommit({ rates_changed: 1, outcomes_changed: 0, rates: [], outcomes: [] }));
    await waitFor(() => expect(sessionStorage.getItem('crx:pending-retry:rate-review:u1')).toBeNull());
    expect(screen.queryByText(/Saved 1 rate and 0 outcomes/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm rate review/ })).not.toBeInTheDocument();
    expect(H.toast).not.toHaveBeenCalledWith('success', expect.anything());
  });

  it('does not permit an upload before the signed-in profile is known', () => {
    render(<RateReviewWorkbookModal open profileId="" onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeDisabled();
  });

  it('warns when a rate change clears a recorded outcome the file does not set again', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['reopen'] }], outcomes: [] });
    H.parse.mockResolvedValue({ ...upload, outcomes: [], recorded: { [P1]: 'approved_default' } });
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    const file = new File(['x'], 'review.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    fireEvent.change(screen.getByLabelText('Rate review workbook file'), { target: { files: [file] } });
    expect(await screen.findByText(/clear the recorded outcome of Atrazine 4L \(approved default\)/)).toBeInTheDocument();
  });
});
