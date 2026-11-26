import {
  APPLICATION_SERVICE_BILLING_DB_READY,
  type ApplicationServiceBilling,
} from '../../lib/jobServiceBillingSummary';
import {
  FIELD_SOURCED_FROM_DB_READY,
  jobSupportsVendorSourcing,
  type JobSourceVendor,
  type JobStockPathRead,
} from '../../lib/jobSourcedFrom';
import { VEHICLE_CARRIER_DEFAULT_DB_READY } from '../../lib/vehicleCarrierDefaults';

interface SourcedFromControlProps {
  isOffice: boolean;
  stockPath: JobStockPathRead;
  available: boolean;
  canEdit: boolean;
  sourceVendorId: string | null;
  vendors: JobSourceVendor[];
  batchVendorRequired?: boolean;
  onChange: (vendorId: string | null) => void;
}

export function SourcedFromControl({
  isOffice,
  stockPath,
  available,
  canEdit,
  sourceVendorId,
  vendors,
  batchVendorRequired = false,
  onChange,
}: SourcedFromControlProps) {
  if (!jobSupportsVendorSourcing(FIELD_SOURCED_FROM_DB_READY, isOffice, stockPath)) return null;
  const canChooseSource = FIELD_SOURCED_FROM_DB_READY && available;
  return (
    <div className="pt-1">
      <label className="block text-xs font-medium text-secondary mb-1">
        Sourced from
        <select
          aria-label="Sourced from"
          value={sourceVendorId ?? ''}
          onChange={(event) => onChange(event.target.value || null)}
          disabled={!canEdit || !canChooseSource}
          className="mt-1 block w-full max-w-xs px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50"
        >
          {canChooseSource ? <option value="">CRX stock</option> : <option value="">Not available yet</option>}
          {sourceVendorId && !vendors.some((vendor) => vendor.id === sourceVendorId) && (
            <option value={sourceVendorId} disabled>Previously selected vendor (inactive)</option>
          )}
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.id} disabled={vendor.inactive}>
              {vendor.name}{vendor.inactive ? ' (inactive)' : ''}
            </option>
          ))}
        </select>
      </label>
      {FIELD_SOURCED_FROM_DB_READY && sourceVendorId && (
        <p className="mt-1 text-xs text-secondary">Vendor-sourced: no CRX stock, $0</p>
      )}
      {FIELD_SOURCED_FROM_DB_READY && batchVendorRequired && (
        <p className="mt-1 text-xs text-red-700">Choose a vendor for this customer-supplied line on a batch job.</p>
      )}
    </div>
  );
}

export function RigCarrierSourceHint({ label, isOffice }: { label: string | null; isOffice: boolean }) {
  if (!isOffice || !VEHICLE_CARRIER_DEFAULT_DB_READY || !label) return null;
  return <span className="ml-1 text-xs text-secondary">{label}</span>;
}

export function ApplicationServiceBillingSummary({
  isOffice,
  billing,
}: {
  isOffice: boolean;
  billing: ApplicationServiceBilling | null;
}) {
  if (!isOffice || !APPLICATION_SERVICE_BILLING_DB_READY || !billing) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-secondary" aria-label="Application service billing">
      <span>Billed by CRX: {billing.billsCustomer ? 'Yes' : 'No'}</span>
      <span>Outside company: {billing.outsideCompanyName ?? 'None'}</span>
    </div>
  );
}
