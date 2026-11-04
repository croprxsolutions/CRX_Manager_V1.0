import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui/Toast';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./db', () => ({ supabase: {} }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./companyInfo', async (orig) => ({ ...(await orig<typeof import('./companyInfo')>()), loadCompanyInfo: mocks.load }));

import { COMPANY_INFO_FALLBACK_MESSAGE, loadCompanyInfoForPdf } from './companyInfoForPdf';
import { DEFAULT_COMPANY_INFO } from './companyInfo';

describe('loadCompanyInfoForPdf', () => {
  it('prints the defaults and shows a warning toast when the Settings read fails', async () => {
    render(<ToastProvider><div /></ToastProvider>);
    mocks.load.mockRejectedValueOnce(new Error('network down'));
    let company;
    await act(async () => { company = await loadCompanyInfoForPdf(); });
    expect(company).toEqual(DEFAULT_COMPANY_INFO);
    expect(screen.getByText(COMPANY_INFO_FALLBACK_MESSAGE)).toBeInTheDocument();
  });

  it('shows no warning when the Settings read works', async () => {
    render(<ToastProvider><div /></ToastProvider>);
    const settings = { name: 'Prairie Ag Co', phone: '555-0100', email: '', address: '12 Main St' };
    mocks.load.mockResolvedValueOnce(settings);
    await act(async () => { expect(await loadCompanyInfoForPdf()).toEqual(settings); });
    expect(screen.queryByText(COMPANY_INFO_FALLBACK_MESSAGE)).not.toBeInTheDocument();
  });
});
