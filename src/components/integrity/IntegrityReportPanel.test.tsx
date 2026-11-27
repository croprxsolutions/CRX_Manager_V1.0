import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runReconciliationChecks } from '../../lib/reconciliation';
import IntegrityReportPanel from './IntegrityReportPanel';

vi.mock('../../lib/reconciliation', () => ({ runReconciliationChecks: vi.fn() }));
const toast = vi.fn();
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast }) }));

const orderCheck = {
  name: 'Order Totals',
  description: 'Order total matches the sum of its line-item totals',
  passed: true,
  discrepancies: [],
  entitiesChecked: 2,
};
const cleanReport = {
  timestamp: '2026-11-26T16:00:00Z',
  checks: [orderCheck],
  totalDiscrepancies: 0,
};

beforeEach(() => vi.mocked(runReconciliationChecks).mockReset());

describe('Integrity report errors', () => {
  it('flags an incomplete check even when no discrepancies were returned', async () => {
    vi.mocked(runReconciliationChecks)
      .mockResolvedValueOnce({
        ...cleanReport,
        checks: [{ ...orderCheck, passed: false, entitiesChecked: 0 }],
      })
      .mockResolvedValueOnce(cleanReport);

    render(<IntegrityReportPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Incomplete report');
    expect(screen.getByText('Not completed')).toBeInTheDocument();
    expect(screen.queryByText('0 issues')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    expect(await screen.findByText('PASS')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('removes stale results after a failed re-run and offers a retry', async () => {
    vi.mocked(runReconciliationChecks)
      .mockResolvedValueOnce(cleanReport)
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(cleanReport);

    render(<IntegrityReportPanel />);
    expect(await screen.findByText('PASS')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The integrity report could not be loaded');
    expect(screen.queryByText('PASS')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('PASS')).toBeInTheDocument();
  });
});
