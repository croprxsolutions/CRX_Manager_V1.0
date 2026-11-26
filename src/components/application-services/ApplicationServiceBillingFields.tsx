import type { ApplicationServiceVendorChoice } from '../../lib/applicationServiceBilling';

interface Props {
  billsCustomer: boolean;
  outsideVendorId: string;
  billingAvailable: boolean;
  outsideVendorAvailable: boolean;
  activeVendors: ApplicationServiceVendorChoice[] | null;
  existingOutsideVendor: ApplicationServiceVendorChoice | null;
  onBillsCustomerChange: (value: boolean) => void;
  onOutsideVendorChange: (value: string) => void;
}

export default function ApplicationServiceBillingFields({
  billsCustomer,
  outsideVendorId,
  billingAvailable,
  outsideVendorAvailable,
  activeVendors,
  existingOutsideVendor,
  onBillsCustomerChange,
  onOutsideVendorChange,
}: Props) {
  const hasInactiveSelection = Boolean(
    outsideVendorId
    && existingOutsideVendor
    && !activeVendors?.some((vendor) => vendor.id === outsideVendorId),
  );

  return (
    <>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium text-nav-dark">
          <input
            type="checkbox"
            checked={billsCustomer}
            disabled={!billingAvailable}
            onChange={(event) => onBillsCustomerChange(event.target.checked)}
          />
          CRX bills the customer for this service
        </label>
        {!billingAvailable && <p className="text-sm text-secondary">Not available yet</p>}
        <p className="text-sm text-secondary">Acres are always logged. When CRX does not bill this service, invoices carry products only, no service line.</p>
      </div>
      <div>
        <label className="block text-sm font-medium text-nav-dark mb-1" htmlFor="outside-company">Outside company (optional)</label>
        <select
          id="outside-company"
          aria-label="Outside company"
          value={outsideVendorId}
          disabled={!outsideVendorAvailable}
          onChange={(event) => onOutsideVendorChange(event.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
        >
          <option value="">No outside company</option>
          {hasInactiveSelection && existingOutsideVendor && (
            <option value={existingOutsideVendor.id}>{existingOutsideVendor.name}</option>
          )}
          {activeVendors?.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
        </select>
        {!outsideVendorAvailable && <p className="mt-1 text-sm text-secondary">Not available yet</p>}
      </div>
    </>
  );
}
