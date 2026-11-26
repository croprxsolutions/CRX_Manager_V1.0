import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/jobSourcedFrom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/jobSourcedFrom')>()),
  FIELD_SOURCED_FROM_DB_READY: true,
}));
vi.mock('../../lib/vehicleCarrierDefaults', () => ({ VEHICLE_CARRIER_DEFAULT_DB_READY: true }));
vi.mock('../../lib/jobServiceBillingSummary', () => ({ APPLICATION_SERVICE_BILLING_DB_READY: true }));

import {
  ApplicationServiceBillingSummary,
  RigCarrierSourceHint,
  SourcedFromControl,
} from './JobDetailOfficeAdditions';
import {
  batchCustomerSuppliedLineNeedsVendor,
  jobStockPathFromFieldBatchSetting,
  jobStockPathForSourcing,
} from '../../lib/jobSourcedFrom';

describe('Job Detail office additions', () => {
  it('enables vendor selection only when the sourced-from data is available', () => {
    const onChange = vi.fn();
    const vendors = [{ id: 'vendor-1', name: 'Spray Partner' }];
    const { rerender } = render(
      <SourcedFromControl
        isOffice
        stockPath={{ available: true, path: 'batch' }}
        available={false}
        canEdit
        sourceVendorId={null}
        vendors={[]}
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText('Sourced from')).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Not available yet' })).toBeInTheDocument();

    rerender(
      <SourcedFromControl
        isOffice
        stockPath={{ available: true, path: 'batch' }}
        available
        canEdit
        sourceVendorId={null}
        vendors={vendors}
        onChange={onChange}
      />,
    );
    const picker = screen.getByLabelText('Sourced from');
    expect(picker).toBeEnabled();
    expect(screen.getByRole('option', { name: 'CRX stock' })).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'vendor-1' } });
    expect(onChange).toHaveBeenCalledWith('vendor-1');
    rerender(
      <SourcedFromControl
        isOffice
        stockPath={{ available: true, path: 'batch' }}
        available
        canEdit
        sourceVendorId="vendor-1"
        vendors={vendors}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Vendor-sourced: no CRX stock, $0')).toBeInTheDocument();
  });

  it('hides sourced-from for old-path and unknown-path jobs', () => {
    const { rerender, container } = render(
      <SourcedFromControl
        isOffice
        stockPath={{ available: true, path: 'at_completion' }}
        available
        canEdit
        sourceVendorId={null}
        vendors={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Sourced from')).not.toBeInTheDocument();
    rerender(
      <SourcedFromControl
        isOffice
        stockPath={{ available: false, path: null }}
        available
        canEdit
        sourceVendorId={null}
        vendors={[]}
        onChange={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the first-save batch control and vendor-required message for a new job', () => {
    const unavailable = { available: false, path: null } as const;
    const stockPath = jobStockPathForSourcing(null, unavailable, {
      available: true,
      path: jobStockPathFromFieldBatchSetting('true'),
    });
    render(
      <SourcedFromControl
        isOffice
        stockPath={stockPath}
        available
        canEdit
        sourceVendorId={null}
        vendors={[{ id: 'vendor-1', name: 'Spray Partner' }]}
        batchVendorRequired={batchCustomerSuppliedLineNeedsVendor(stockPath, true, null)}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Sourced from')).toBeEnabled();
    expect(screen.getByText('Choose a vendor for this customer-supplied line on a batch job.')).toBeInTheDocument();
  });

  it.each(['false', null])('keeps new jobs on the at-completion path when the setting is %s', (settingValue) => {
    const unavailable = { available: false, path: null } as const;
    const stockPath = jobStockPathForSourcing(null, unavailable, {
      available: true,
      path: jobStockPathFromFieldBatchSetting(settingValue),
    });
    const { container } = render(
      <SourcedFromControl
        isOffice
        stockPath={stockPath}
        available
        canEdit
        sourceVendorId={null}
        vendors={[]}
        onChange={vi.fn()}
      />,
    );
    expect(stockPath).toEqual({ available: true, path: 'at_completion' });
    expect(container).toBeEmptyDOMElement();
  });

  it('labels a rig default or a job-specific carrier value', () => {
    const { rerender } = render(<RigCarrierSourceHint isOffice label="(rig default)" />);
    expect(screen.getByText('(rig default)')).toBeInTheDocument();
    rerender(<RigCarrierSourceHint isOffice label="(changed for this job)" />);
    expect(screen.getByText('(changed for this job)')).toBeInTheDocument();
  });

  it('shows the selected service billing status and outside company read-only', () => {
    render(<ApplicationServiceBillingSummary isOffice billing={{ billsCustomer: true, outsideCompanyName: 'Spray Partner' }} />);
    expect(screen.getByText('Billed by CRX: Yes')).toBeInTheDocument();
    expect(screen.getByText('Outside company: Spray Partner')).toBeInTheDocument();
  });

  it('keeps a saved inactive vendor selectable for display without offering it as a new choice', () => {
    render(
      <SourcedFromControl
        isOffice
        stockPath={{ available: true, path: 'batch' }}
        available
        canEdit
        sourceVendorId="vendor-old"
        vendors={[{ id: 'vendor-old', name: 'Old Supplier', inactive: true }]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('option', { name: 'Old Supplier (inactive)' })).toBeDisabled();
  });

  it('shows a reload note when the batch vendor list failed to load', () => {
    render(
      <SourcedFromControl
        isOffice
        stockPath={{ available: true, path: 'batch' }}
        available={false}
        canEdit
        sourceVendorId={null}
        vendors={[]}
        vendorListLoadFailed
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Vendor list could not be loaded — reload the job')).toBeInTheDocument();
    expect(screen.getByLabelText('Sourced from')).toBeDisabled();
  });

  it('hides the office-only details from crew when readiness flags are enabled', () => {
    const { container } = render(
      <>
        <SourcedFromControl
          isOffice={false}
          stockPath={{ available: true, path: 'batch' }}
          available
          canEdit
          sourceVendorId="vendor-1"
          vendors={[]}
          onChange={vi.fn()}
        />
        <RigCarrierSourceHint isOffice={false} label="(rig default)" />
        <ApplicationServiceBillingSummary
          isOffice={false}
          billing={{ billsCustomer: true, outsideCompanyName: 'Spray Partner' }}
        />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
