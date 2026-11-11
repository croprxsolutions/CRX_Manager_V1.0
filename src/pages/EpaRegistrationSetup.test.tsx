/**
 * EPA registration setup (REG-1 switch-on): preview, pick, run once. The RPC shim is mocked; the page's
 * contract is pinned here: a pick is required, a stale preview is refused and re-read, a lost reply is
 * retried with the same key, and after a run (or on a later visit) only "already switched on" shows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EpaRegistrationSetup from './EpaRegistrationSetup';

const m = vi.hoisted(() => ({
  preview: vi.fn(), seed: vi.fn(), lines: vi.fn(), sales: vi.fn(), toast: vi.fn(),
}));

vi.mock('../lib/epaRegistrationSeed', async (orig) => ({
  ...(await orig<typeof import('../lib/epaRegistrationSeed')>()),
  previewEpaRegistrationSeed: m.preview,
  seedEpaRegistrations: m.seed,
  listSeedLines: m.lines,
  getEpaSalesToCheck: m.sales,
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: m.toast }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1' } }) }));

const PREVIEW = {
  rup_default: 'no', fingerprint: 'fp-1', registration_count: 2, disagreement_count: 1, invalid_numbers: [],
  registrations: [
    { epa_registration: '100-1', number_valid: true, carried: true, facts: {}, disagreements: { signal_word: ['CAUTION', 'WARNING'] } },
    { epa_registration: '100-2', number_valid: true, carried: true, facts: { signal_word: 'CAUTION' }, disagreements: {} },
  ],
};
const LINES = [
  { id: 'l1', epa_registration: null, invoices: { invoice_number: 'INV-1', status: 'draft' }, products: { product_name: 'Prod A', epa_registration: '100-1', is_rup: false } },
  { id: 'l2', epa_registration: null, invoices: { invoice_number: 'INV-2', status: 'paid' }, products: { product_name: 'Prod B', epa_registration: null, is_rup: false } },
];
const pgError = (message: string) => ({ code: 'P0001', message });

beforeEach(() => {
  vi.clearAllMocks();
  m.preview.mockResolvedValue(PREVIEW);
  m.lines.mockResolvedValue(LINES);
  m.sales.mockResolvedValue([]);
});

const pickAndRun = async () => {
  fireEvent.click(await screen.findByLabelText('WARNING'));
  fireEvent.click(screen.getByRole('button', { name: /run setup/i }));
  const buttons = await screen.findAllByRole('button', { name: /run setup/i });
  fireEvent.click(buttons[buttons.length - 1]); // the ConfirmModal's button
};

describe('EpaRegistrationSetup', () => {
  it('shows each line with the number it is captured under and requires the pick', async () => {
    render(<EpaRegistrationSetup />);
    expect(await screen.findByText('100-1 (assumed from the product)')).toBeInTheDocument();
    expect(screen.getByText('No EPA number on the product')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run setup/i })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('WARNING'));
    expect(screen.getByRole('button', { name: /run setup/i })).toBeEnabled();
  });

  it('runs with the pick, the default No and the fingerprint, then shows only "already switched on"', async () => {
    m.seed.mockResolvedValue({ registrations: 2, lines_captured: 2, rup_default: 'no', fingerprint: 'fp-1' });
    render(<EpaRegistrationSetup />);
    await pickAndRun();
    await waitFor(() => expect(m.seed).toHaveBeenCalledWith({ '100-1': { signal_word: 'WARNING' } }, 'fp-1', expect.any(String)));
    expect(await screen.findByText(/already switched on/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run setup/i })).toBeNull();
    expect(m.sales).toHaveBeenCalled();
  });

  it('a stale preview is refused with a clear message and the preview is read again', async () => {
    m.seed.mockRejectedValue(pgError('EPA_REGISTRATION_SEED_STALE: products changed; preview again'));
    render(<EpaRegistrationSetup />);
    await pickAndRun();
    await waitFor(() => expect(m.toast).toHaveBeenCalledWith('error', expect.stringMatching(/changed since this preview/)));
    expect(m.preview).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/already switched on/i)).toBeNull();
  });

  it('a failed re-read after a stale refusal removes the old preview and its Run button', async () => {
    m.seed.mockRejectedValue(pgError('EPA_REGISTRATION_SEED_STALE: products changed; preview again'));
    render(<EpaRegistrationSetup />);
    await screen.findByLabelText('WARNING');
    m.preview.mockRejectedValueOnce(new Error('network down'));
    await pickAndRun();
    expect(await screen.findByText(/could not load the preview/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run setup/i })).toBeNull();
  });

  it('a lost reply offers Retry with the same key', async () => {
    m.seed.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ registrations: 2, lines_captured: 2, rup_default: 'no', fingerprint: 'fp-1' });
    render(<EpaRegistrationSetup />);
    await pickAndRun();
    fireEvent.click(await screen.findByRole('button', { name: /not sure this saved: retry/i }));
    await screen.findByText(/already switched on/i);
    expect(m.seed.mock.calls[1][2]).toBe(m.seed.mock.calls[0][2]);
  });

  it('Sales to check never shows a saved number as the captured one', async () => {
    m.preview.mockRejectedValue(pgError('EPA_REGISTRATION_SEED_DONE: EPA registrations are already set up'));
    m.sales.mockResolvedValue([{ line_id: 's1', invoice_id: 'i1', invoice_number: 'INV-9', invoice_date: '2026-11-11',
      product_name: 'Prod C', epa_registration: null, saved_number: '200-2', quantity: 1, captured_rup_status: 'yes', reason: 'no_epa_number' }]);
    render(<EpaRegistrationSetup />);
    expect(await screen.findByText('None captured (line saved 200-2)')).toBeInTheDocument();
  });

  it('a later visit after the run never offers Run again', async () => {
    m.preview.mockRejectedValue(pgError('EPA_REGISTRATION_SEED_DONE: EPA registrations are already set up'));
    render(<EpaRegistrationSetup />);
    expect(await screen.findByText(/already switched on/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run setup/i })).toBeNull();
  });
});
