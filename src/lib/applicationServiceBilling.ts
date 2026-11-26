import { assertRpcResult, supabase, supabaseUntyped } from './db';
import { fetchAllRows, pageWithList } from './pagedRead';

// The office UI stays read-only for these fields until the database lane confirms
// the columns and RPC argument names against its merged migration.
export const APPLICATION_SERVICE_BILLING_DB_READY = false;

const TODO_CONFIRM_BILLS_CUSTOMER_COLUMN = 'bills_customer';
const TODO_CONFIRM_OUTSIDE_VENDOR_ID_COLUMN = 'outside_vendor_id';
const TODO_CONFIRM_BILLS_CUSTOMER_RPC_ARGUMENT = 'p_bills_customer';
const TODO_CONFIRM_OUTSIDE_VENDOR_ID_RPC_ARGUMENT = 'p_outside_vendor_id';
const TODO_CONFIRM_CLEAR_OUTSIDE_VENDOR_RPC_ARGUMENT = 'p_clear_outside_vendor';

const APPLICATION_SERVICE_BILLING_COLUMNS = [
  'id',
  TODO_CONFIRM_BILLS_CUSTOMER_COLUMN,
  TODO_CONFIRM_OUTSIDE_VENDOR_ID_COLUMN,
  'outside_vendor:vendors(name)',
].join(', ');

export interface ApplicationServiceBillingWrite {
  billsCustomer: boolean;
  outsideVendorId: string | null;
  clearOutsideVendor: boolean;
}

export interface ApplicationServiceBillingRow {
  serviceId: string;
  billsCustomer: boolean;
  outsideVendorId: string | null;
  outsideVendorName: string | null;
}

export interface ApplicationServiceBillingRead {
  available: boolean;
  byServiceId: Map<string, ApplicationServiceBillingRow>;
}

export interface ApplicationServiceVendorChoice {
  id: string;
  name: string;
}

export interface ApplicationServiceSaveArgs {
  p_name: string;
  p_default_rate_per_acre_cents: number;
  p_is_active: boolean;
  p_sort_order: number;
  p_vehicle_id: string | null;
  p_cost_per_acre_cents: number | null;
  p_service_id: string | null;
}

function rowsFrom(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object');
}

function parseBillingRow(value: Record<string, unknown>): ApplicationServiceBillingRow | null {
  const outsideVendorId = value[TODO_CONFIRM_OUTSIDE_VENDOR_ID_COLUMN];
  const outsideVendor = value.outside_vendor;
  const vendor = outsideVendor !== null && typeof outsideVendor === 'object'
    ? outsideVendor as Record<string, unknown>
    : null;
  if (
    typeof value.id !== 'string'
    || typeof value[TODO_CONFIRM_BILLS_CUSTOMER_COLUMN] !== 'boolean'
    || (outsideVendorId !== null && typeof outsideVendorId !== 'string')
  ) return null;

  return {
    serviceId: value.id,
    billsCustomer: value[TODO_CONFIRM_BILLS_CUSTOMER_COLUMN] as boolean,
    outsideVendorId: typeof outsideVendorId === 'string' ? outsideVendorId : null,
    outsideVendorName: typeof vendor?.name === 'string' ? vendor.name : null,
  };
}

export async function readApplicationServiceBilling(
  serviceIds: string[],
): Promise<ApplicationServiceBillingRead> {
  if (serviceIds.length === 0) return { available: true, byServiceId: new Map() };

  let data: unknown;
  let error: unknown;
  try {
    const result = await supabaseUntyped
      .from('application_services')
      .select(APPLICATION_SERVICE_BILLING_COLUMNS)
      .in('id', serviceIds);
    data = result.data;
    error = result.error;
  } catch {
    return { available: false, byServiceId: new Map() };
  }
  if (error) return { available: false, byServiceId: new Map() };

  const rows = rowsFrom(data);
  if (!rows) return { available: false, byServiceId: new Map() };

  const byServiceId = new Map<string, ApplicationServiceBillingRow>();
  for (const row of rows) {
    const parsed = parseBillingRow(row);
    if (!parsed) return { available: false, byServiceId: new Map() };
    byServiceId.set(parsed.serviceId, parsed);
  }
  return { available: true, byServiceId };
}

export async function readApplicationServiceBillingIfReady(
  serviceIds: string[],
  databaseReady: boolean,
): Promise<ApplicationServiceBillingRead | null> {
  if (!databaseReady) return null;
  return readApplicationServiceBilling(serviceIds);
}

export async function loadActiveApplicationServiceVendors(): Promise<ApplicationServiceVendorChoice[] | null> {
  try {
    const { data, error } = await fetchAllRows((from, to) => pageWithList(supabase
      .from('vendors')
      .select('id, name', { count: 'exact' })
      .is('deleted_at', null)
      .order('name')
      .order('id')
      .range(from, to)));
    if (error || !data) return null;
    return data.map(({ id, name }) => ({ id, name }));
  } catch {
    return null;
  }
}

export interface ApplicationServiceBillingForm {
  available: boolean;
  billsCustomer: boolean;
  outsideVendorId: string;
  existingVendor: ApplicationServiceVendorChoice | null;
  activeVendors: ApplicationServiceVendorChoice[] | null;
}

// Billing values for one existing service's form. `available` is true only when the
// values were really read, so a failed read can never be saved back as defaults.
export async function loadApplicationServiceBillingForm(serviceId: string): Promise<ApplicationServiceBillingForm> {
  const read = await readApplicationServiceBillingIfReady([serviceId], APPLICATION_SERVICE_BILLING_DB_READY);
  const billing = read?.byServiceId.get(serviceId);
  const available = read?.available === true && billing !== undefined;
  return {
    available,
    billsCustomer: billing?.billsCustomer ?? true,
    outsideVendorId: billing?.outsideVendorId ?? '',
    existingVendor: billing?.outsideVendorId && billing.outsideVendorName
      ? { id: billing.outsideVendorId, name: billing.outsideVendorName }
      : null,
    activeVendors: available ? await loadActiveApplicationServiceVendors() : null,
  };
}

export async function saveApplicationService(
  args: ApplicationServiceSaveArgs,
  billing: ApplicationServiceBillingWrite | null,
  idempotencyKey: string,
): Promise<{ success: boolean; service_id: string; created: boolean }> {
  const rpcArgs: Record<string, unknown> = {
    ...args,
    p_idempotency_key: idempotencyKey,
  };
  if (billing && billing.outsideVendorId !== null && billing.clearOutsideVendor) {
    throw new Error('Cannot set an outside vendor and clear it in the same save.');
  }
  // A non-null billing value means the caller has confirmed it was read for an
  // existing service, or is a known default for a new service, and the DB lane is ready.
  if (billing !== null) {
    Object.assign(rpcArgs, {
      [TODO_CONFIRM_BILLS_CUSTOMER_RPC_ARGUMENT]: billing.billsCustomer,
      [TODO_CONFIRM_OUTSIDE_VENDOR_ID_RPC_ARGUMENT]: billing.outsideVendorId,
      [TODO_CONFIRM_CLEAR_OUTSIDE_VENDOR_RPC_ARGUMENT]: billing.clearOutsideVendor,
    });
  }

  const { data, error } = await supabaseUntyped.rpc('admin_save_application_service', rpcArgs);
  if (error) throw error;
  return assertRpcResult<{ success: boolean; service_id: string; created: boolean }>(
    data,
    'admin_save_application_service',
  );
}
