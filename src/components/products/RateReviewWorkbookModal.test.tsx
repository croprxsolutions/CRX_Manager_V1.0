import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ toast: vi.fn(), parse: vi.fn(), preview: vi.fn(), commit: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/db', () => ({
  supabaseUntyped: { rpc: H.rpc },
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

  it('pages long error lists without dropping any problems', async () => {
    H.parse.mockRejectedValueOnce(new PricingWorkbookFormatError(Array.from({ length: 120 }, (_, i) => `Workbook problem ${i + 1}.`).join('\n')));
    await uploadFile();
    const alert = await screen.findByRole('region', { name: 'Workbook file problems' });
    expect(alert).toHaveTextContent('Problems 1–50 of 120');
    expect(alert).not.toHaveTextContent('Workbook problem 51.');
    fireEvent.click(screen.getByRole('button', { name: 'Next problems' }));
    expect(alert).toHaveTextContent('Problems 51–100 of 120');
    fireEvent.click(screen.getByRole('button', { name: 'Next problems' }));
    expect(alert).toHaveTextContent('Workbook problem 120.');
    expect(screen.getByRole('button', { name: 'Next problems' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous problems' }));
    expect(alert).toHaveTextContent('Problems 51–100 of 120');
    expect(H.preview).not.toHaveBeenCalled();
    expect(H.commit).not.toHaveBeenCalled();
  });

  it('keeps every file problem visible without previewing or saving, then clears on a corrected upload', async () => {
    H.parse.mockRejectedValueOnce(new PricingWorkbookFormatError('Draft Rates row 2: bad decision.\nDraft Rates row 2: bad default.'));
    H.preview.mockResolvedValue({ rates: [], outcomes: [] });
    await uploadFile();
    const alert = await screen.findByRole('region', { name: 'Workbook file problems' });
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

  it('warns on a row whose parent rate moved, still lets Confirm save it, and repeats the warning on the saved result', async () => {
    const moved = { was: '4 oz', now: '6 oz' };
    H.preview.mockResolvedValue({
      rates: [
        { index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'], parent_changed: moved },
        { index: 1, rate_id: 'r2', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['delete'] },
      ],
      outcomes: [],
    });
    H.commit.mockResolvedValue({ rates_changed: 2, outcomes_changed: 0, outcomes: [],
      rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', parent_changed: { was: '4 oz', now: null } }] });
    await uploadFile();
    const text = 'Parent rate changed since this draft was made: was "4 oz", now "6 oz". Approving still saves it.';
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getAllByText(/Parent rate changed/)).toHaveLength(1);
    const confirm = screen.getByRole('button', { name: 'Confirm rate review (2 changes)' });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Saved 2 rates and 0 outcomes./)).toBeInTheDocument();
    expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Parent rate changed/)).toHaveLength(1);
    expect(screen.getByText('Draft Rates 2 (Atrazine 4L): Parent rate changed since this draft was made: was "4 oz", now none. Approved anyway.'))
      .toBeInTheDocument();
  });

  it('restores a saved retry that carries a parent warning, and treats a malformed warning as damaged', async () => {
    const name = 'crx:pending-retry:rate-review:u1';
    const stored = (parent_changed: unknown) => JSON.stringify({ key: 'old-key', sentAt: Date.now(), request: {
      actorId: 'u1', upload, preview: { rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'], parent_changed }], outcomes: [] },
    } });
    sessionStorage.setItem(name, stored({ was: '4 oz/A', now: '8 oz/A' }));
    const view = render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    expect(await screen.findByText('Parent rate changed since this draft was made: was "4 oz/A", now "8 oz/A". Approving still saves it.')).toBeInTheDocument();
    view.unmount();
    for (const bad of [{ was: 4, now: '8 oz/A' }, { was: '', now: '8 oz/A' }, { was: '4 oz/A', now: '' }]) {
      sessionStorage.setItem(name, stored(bad));
      const damaged = render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
      expect(await screen.findByText(/unreadable.*rows are unavailable/i)).toBeInTheDocument();
      expect(screen.queryByLabelText('Rate review preview')).not.toBeInTheDocument();
      damaged.unmount();
    }
    expect(H.commit).not.toHaveBeenCalled();
  });

  it('warns that inactive rate cleanup clears its recorded outcome without suggesting Reconfirm', async () => {
    const inactiveUpload: ParsedRateReview = {
      ...upload, rates: [upload.rates[1]], outcomes: [], recorded: { [P1]: 'approved_default' }, inactive_parent_ids: [P1],
    };
    H.parse.mockResolvedValue(inactiveUpload);
    H.preview.mockResolvedValue({
      rates: [{ index: 0, rate_id: 'r2', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['reopen'] }],
      outcomes: [],
    });
    const view = render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    const file = new File(['x'], 'review.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    fireEvent.change(screen.getByLabelText('Rate review workbook file'), { target: { files: [file] } });
    expect(await screen.findByText(/Reopening or deleting these inactive rates also clears their recorded outcomes: Atrazine 4L \(approved default\)/)).toBeInTheDocument();
    expect(screen.queryByText(/To keep an outcome that still fits/)).not.toBeInTheDocument();
    view.unmount();
  });

  it('requests inactive history explicitly and keeps its totals separate from active readiness counts', async () => {
    H.rpc.mockResolvedValue({
      data: { parents: [], units: [], totals: {
        rates: 3, drafts: 1, approved: 2, per_100_gal: 0, per_100_gal_approved: 0, parents: 2, parents_undecided: 1,
        approved_default: 1, no_per_acre_default: 0, needs_label_data: 0, outcomes_no_longer_valid: 0,
        inactive_parents: 1, inactive_rates: 2, inactive_approved: 1, inactive_outcomes: 1,
      } }, error: null,
    });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rate-review');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const view = render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download rate review workbook' }));
    expect(await screen.findByText(/Historical only: 1 inactive group, 2 rates \(1 approved\), and 1 recorded outcome/)).toBeInTheDocument();
    expect(H.rpc).toHaveBeenCalledWith('get_rate_review_workbook', { p_include_inactive: true });
    expect(screen.getByText(/2 parents: 1 undecided, 1 approved default/)).toBeInTheDocument();
    view.unmount();
    create.mockRestore();
    click.mockRestore();
  });

  it('does not describe its own in-flight save as an earlier unanswered request', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    let finishCommit!: (receipt: unknown) => void;
    H.commit.mockImplementation(() => new Promise((resolve) => { finishCommit = resolve; }));
    await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    expect(screen.queryByRole('region', { name: 'Earlier rate review recovery' })).not.toBeInTheDocument();
    expect(screen.queryByText(/earlier Confirm got no reply/i)).not.toBeInTheDocument();
    await act(async () => finishCommit({ rates_changed: 1, outcomes_changed: 0, rates: [], outcomes: [] }));
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

  it('restores the inactive cleanup warning from a saved retry without changing its payload', async () => {
    const inactiveUpload: ParsedRateReview = {
      rates: [{ ...upload.rates[0], decision: 'reopen', reason: 'inactive group cleanup' }], outcomes: [],
      recorded: { [P1]: 'approved_default' }, inactive_parent_ids: [P1],
    };
    H.parse.mockResolvedValue(inactiveUpload);
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['reopen'] }], outcomes: [] });
    H.commit.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const first = render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    const file = new File(['x'], 'review.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    fireEvent.change(screen.getByLabelText('Rate review workbook file'), { target: { files: [file] } });
    const warning = /Reopening or deleting these inactive rates also clears their recorded outcomes: Atrazine 4L \(approved default\)/;
    expect(await screen.findByText(warning)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    const stored = JSON.parse(sessionStorage.getItem('crx:pending-retry:rate-review:u1')!);
    expect(stored.request.upload.inactive_parent_ids).toEqual([P1]);
    first.unmount();
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    expect(await screen.findByText(/earlier Confirm got no reply/)).toBeInTheDocument();
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(H.commit).toHaveBeenCalledOnce();
    expect(JSON.parse(sessionStorage.getItem('crx:pending-retry:rate-review:u1')!).request.upload).toEqual(inactiveUpload);
  });

  it('offers a hand check when an old in-flight Confirm settles after remount', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    let finishCommit!: (receipt: unknown) => void;
    H.commit.mockImplementation(() => new Promise((resolve) => { finishCommit = resolve; }));
    const first = await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    first.unmount();
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    expect(await screen.findByText(/earlier Confirm got no reply/)).toBeInTheDocument();
    await act(async () => finishCommit({ rates_changed: 1, outcomes_changed: 0, rates: [], outcomes: [] }));
    expect(sessionStorage.getItem('crx:pending-retry:rate-review:u1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Confirm rate review/ }));
    expect(H.commit).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: 'I checked the fresh workbook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm rate review/ })).toBeDisabled();
    // The matching old receipt is authoritative, so the current copy keeps only a cautious
    // in-memory reminder and never fabricates a new stored retry record.
    expect(sessionStorage.getItem('crx:pending-retry:rate-review:u1')).toBeNull();
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

  it('does not let an older same-key refusal clear a newer retry fence', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    let refuseOld!: () => void;
    H.commit.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      refuseOld = () => reject(new Error('RATE_REVIEW_REFUSED: old dispatch refusal'));
    })).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const first = await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    const name = 'crx:pending-retry:rate-review:u1';
    const dispatchA = JSON.parse(sessionStorage.getItem(name)!);
    first.unmount();
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledTimes(2));
    const dispatchB = JSON.parse(sessionStorage.getItem(name)!);
    expect(dispatchB.key).toBe(dispatchA.key);
    expect(dispatchB.sentAt).toBe(dispatchA.sentAt);
    expect(dispatchB.dispatchFence).not.toBe(dispatchA.dispatchFence);
    const unchangedB = sessionStorage.getItem(name);
    await act(async () => refuseOld());
    expect(sessionStorage.getItem(name)).toBe(unchangedB);
    expect(JSON.parse(sessionStorage.getItem(name)!).dispatchFence).toBe(dispatchB.dispatchFence);
  });

  it('does not recreate an unanswered reminder when a late reply follows a settled same-key success', async () => {
    let loseOld!: () => void;
    H.commit.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      loseOld = () => reject(new TypeError('Failed to fetch'));
    })).mockResolvedValueOnce({ rates_changed: 1, outcomes_changed: 0, rates: [], outcomes: [] });
    const first = await uploadFile();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    await waitFor(() => expect(H.commit).toHaveBeenCalledOnce());
    first.unmount();
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    expect(await screen.findByText(/Saved 1 rate and 0 outcomes/)).toBeInTheDocument();
    const name = 'crx:pending-retry:rate-review:u1';
    expect(sessionStorage.getItem(name)).toBeNull();
    await act(async () => loseOld());
    expect(sessionStorage.getItem(name)).toBeNull();
    expect(screen.queryByText(/Your earlier Confirm may still finish/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeEnabled();
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

  it('does not send or mutate a hidden record when Confirm cannot inspect browser storage', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    await uploadFile();
    const name = 'crx:pending-retry:rate-review:u1';
    const hiddenDamaged = '{hidden retry bytes';
    sessionStorage.setItem(name, hiddenDamaged);
    const get = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    const realRemove = Storage.prototype.removeItem;
    let writes = 0;
    let removals = 0;
    const readSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === name) throw new Error('storage denied');
      return get.call(this, key);
    });
    const writeSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === name) writes += 1;
      return realSet.call(this, key, value);
    });
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (key === name) removals += 1;
      return realRemove.call(this, key);
    });
    try {
      fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
      await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('could not be checked')));
      expect(H.commit).not.toHaveBeenCalled();
      expect(writes).toBe(0);
      expect(removals).toBe(0);
      readSpy.mockRestore();
      expect(sessionStorage.getItem(name)).toBe(hiddenDamaged);
    } finally {
      readSpy.mockRestore(); writeSpy.mockRestore(); removeSpy.mockRestore();
    }
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

  it('keeps a damaged rate row hidden and available for an explicit checked clear', async () => {
    const name = 'crx:pending-retry:rate-review:u1';
    sessionStorage.setItem(name, JSON.stringify({ key: 'old-key', sentAt: Date.now(), request: {
      actorId: 'u1', upload: { ...upload, rates: [null] },
      preview: { rates: [{ index: 0, status: 'change' }], outcomes: [] },
    } }));
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    expect(screen.queryByLabelText('Rate review preview')).not.toBeInTheDocument();
    expect(H.commit).not.toHaveBeenCalled();
    expect(await screen.findByText(/unreadable.*rows are unavailable/i)).toBeInTheDocument();
    expect(sessionStorage.getItem(name)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'I checked the fresh workbook' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I checked; clear reminder' }));
    expect(sessionStorage.getItem(name)).toBeNull();
  });

  it('refreshes a failed damaged-record clear from the now-valid stored retry', async () => {
    const name = 'crx:pending-retry:rate-review:u1';
    const damaged = '{damaged retry bytes';
    sessionStorage.setItem(name, damaged);
    render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
    expect(await screen.findByText(/unreadable.*rows are unavailable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I checked the fresh workbook' }));
    sessionStorage.setItem(name, JSON.stringify({ key: 'recovered-key', sentAt: Date.now(), request: {
      actorId: 'u1', upload, preview: { rates: [{ index: 0, status: 'change' }], outcomes: [] },
    } }));
    fireEvent.click(await screen.findByRole('button', { name: 'I checked; clear reminder' }));
    expect(await screen.findByText(/earlier Confirm got no reply/)).toBeInTheDocument();
    expect(screen.queryByText(/unreadable.*rows are unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Browser storage could not be checked/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeDisabled();
    expect(JSON.parse(sessionStorage.getItem(name)!).key).toBe('recovered-key');
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

  it('restores a hidden valid record when storage reads recover, without sending from the upload action', async () => {
    const name = 'crx:pending-retry:rate-review:u1';
    sessionStorage.setItem(name, JSON.stringify({ key: 'hidden-key', sentAt: Date.now(), request: {
      actorId: 'u1', upload, preview: { rates: [{ index: 0, status: 'change' }], outcomes: [] },
    } }));
    const get = Storage.prototype.getItem;
    let failFirstRead = true;
    const storage = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === name && failFirstRead) { failFirstRead = false; throw new Error('storage denied'); }
      return get.call(this, key);
    });
    try {
      render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
      expect(await screen.findByText(/Browser storage could not be checked/)).toBeInTheDocument();
      const file = new File(['fresh'], 'review.xlsx');
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
      fireEvent.change(screen.getByLabelText('Rate review workbook file'), { target: { files: [file] } });
      expect(await screen.findByText(/earlier Confirm got no reply/)).toBeInTheDocument();
      expect(screen.queryByText(/No request can be sent until it can be checked safely/)).not.toBeInTheDocument();
      // One explanation (in the preview), plus the recovery region's clear button; not the same warning twice.
      expect(screen.queryByText(/Your earlier Confirm may still finish/)).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Earlier rate review recovery' })).toContainElement(screen.getByRole('button', { name: 'I checked the fresh workbook' }));
      expect(H.parse).not.toHaveBeenCalled();
      expect(H.commit).not.toHaveBeenCalled();
      expect(JSON.parse(sessionStorage.getItem(name)!).key).toBe('hidden-key');
    } finally {
      storage.mockRestore();
    }
  });

  it('restores a different readable stored intent before showing rows or offering its clear action', async () => {
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    await uploadFile();
    const name = 'crx:pending-retry:rate-review:u1';
    const storedUpload = { ...upload, rates: [upload.rates[0]], outcomes: [] };
    const storedRequest = { actorId: 'u1', upload: storedUpload, preview: { rates: [{ index: 0, status: 'change' }], outcomes: [] } };
    sessionStorage.setItem(name, JSON.stringify({ key: 'different-key', sentAt: Date.now(), request: storedRequest }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm rate review/ }));
    expect(await screen.findByText(/Preview: 1 edited rate, 0 edited outcomes/)).toBeInTheDocument();
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('found and restored')));
    expect(screen.getByText(/earlier Confirm got no reply/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Earlier rate review recovery' })).not.toHaveTextContent(/Your earlier Confirm may still finish/);
    expect(H.commit).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(name)!).request).toEqual(storedRequest);
    fireEvent.click(screen.getByRole('button', { name: 'I checked the fresh workbook' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I checked; clear reminder' }));
    expect(sessionStorage.getItem(name)).toBeNull();
  });

  it('shows a hidden damaged record after storage reads recover and preserves its bytes', async () => {
    const name = 'crx:pending-retry:rate-review:u1';
    const damaged = '{hidden unreadable synthetic rate data';
    sessionStorage.setItem(name, damaged);
    const get = Storage.prototype.getItem;
    let failFirstRead = true;
    const storage = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === name && failFirstRead) { failFirstRead = false; throw new Error('storage denied'); }
      return get.call(this, key);
    });
    try {
      render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
      expect(await screen.findByText(/Browser storage could not be checked/)).toBeInTheDocument();
      const file = new File(['fresh'], 'review.xlsx');
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
      fireEvent.change(screen.getByLabelText('Rate review workbook file'), { target: { files: [file] } });
      expect(await screen.findByText(/unreadable.*rows are unavailable/i)).toBeInTheDocument();
      expect(screen.queryByText(/Browser storage could not be checked/)).not.toBeInTheDocument();
      expect(H.parse).not.toHaveBeenCalled();
      expect(H.commit).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(name)).toBe(damaged);
      fireEvent.click(screen.getByRole('button', { name: 'I checked the fresh workbook' }));
      fireEvent.click(await screen.findByRole('button', { name: 'I checked; clear reminder' }));
      expect(sessionStorage.getItem(name)).toBeNull();
    } finally {
      storage.mockRestore();
    }
  });

  it('clears a stale storage warning when a fresh inspection confirms no pending record', async () => {
    H.parse.mockResolvedValue(upload);
    H.preview.mockResolvedValue({ rates: [{ index: 0, rate_id: 'r1', parent_id: P1, name: 'Atrazine 4L', status: 'change', actions: ['approve'] }], outcomes: [] });
    const name = 'crx:pending-retry:rate-review:u1';
    const get = Storage.prototype.getItem;
    let failFirstRead = true;
    const storage = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === name && failFirstRead) { failFirstRead = false; throw new Error('storage denied'); }
      return get.call(this, key);
    });
    try {
      render(<RateReviewWorkbookModal open profileId="u1" onClose={vi.fn()} />);
      expect(await screen.findByText(/Browser storage could not be checked/)).toBeInTheDocument();
      const file = new File(['fresh'], 'review.xlsx');
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
      fireEvent.change(screen.getByLabelText('Rate review workbook file'), { target: { files: [file] } });
      expect(await screen.findByText(/Preview: 2 edited rates/)).toBeInTheDocument();
      expect(screen.queryByText(/Browser storage could not be checked/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Confirm rate review/ })).toBeEnabled();
    } finally {
      storage.mockRestore();
    }
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
