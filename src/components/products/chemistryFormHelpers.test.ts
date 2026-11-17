import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ rpc: vi.fn(), captureException: vi.fn() }));
vi.mock('../../lib/db', () => ({
  supabaseUntyped: { rpc: H.rpc },
  assertRpcResult: <T,>(data: unknown, name: string) => { if (data == null) throw new Error(`${name} returned no data`); return data as T; },
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: H.captureException } }));

import { reportSaveError } from './chemistryFormHelpers';
import { ChemistrySaveUncertain } from '../../lib/productChemistry';

describe('reportSaveError authentication guidance', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('guides recovery after a first auth refusal without claiming an unfinished save', () => {
    const toast = vi.fn();
    expect(reportSaveError({ code: 'P0001', message: 'ADMIN_REQUIRED' }, toast)).toBe('refused');
    expect(toast).toHaveBeenCalledWith('error', expect.stringMatching(/Sign in again or check administrator access/));
    expect(H.captureException).not.toHaveBeenCalled();
  });

  it('guides re-authentication and Finish after an auth refusal on a saved intent', () => {
    const toast = vi.fn();
    const error = new ChemistrySaveUncertain({ code: 'PGRST303', message: 'JWT claims validation failed' }, true);
    expect(reportSaveError(error, toast)).toBe('uncertain');
    expect(toast).toHaveBeenCalledWith('warning', expect.stringMatching(/Sign in again.*Finish save to retry the same request/));
    expect(H.captureException).not.toHaveBeenCalled();
  });
});
