import { supabaseUntyped } from './db';

export const APPLICATION_SERVICE_BILLING_DB_READY = false;
const TODO_CONFIRM_APPLICATION_SERVICE_BILLS_CUSTOMER_COLUMN = 'bills_customer' as const;
const TODO_CONFIRM_APPLICATION_SERVICE_OUTSIDE_VENDOR_ID_COLUMN = 'outside_vendor_id' as const;
const TODO_CONFIRM_APPLICATION_SERVICE_VENDOR_NAME_RELATION = 'vendors(name)' as const;

export interface ApplicationServiceBilling {
  billsCustomer: boolean;
  outsideCompanyName: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function loadApplicationServiceBilling(
  serviceId: string,
): Promise<{ available: boolean; billing: ApplicationServiceBilling | null }> {
  try {
    const { data, error } = await supabaseUntyped
      .from('application_services')
      .select(`${TODO_CONFIRM_APPLICATION_SERVICE_BILLS_CUSTOMER_COLUMN}, ${TODO_CONFIRM_APPLICATION_SERVICE_OUTSIDE_VENDOR_ID_COLUMN}, outside_vendor:${TODO_CONFIRM_APPLICATION_SERVICE_VENDOR_NAME_RELATION}`)
      .eq('id', serviceId)
      .maybeSingle();
    const row = record(data);
    if (error || !row || typeof row[TODO_CONFIRM_APPLICATION_SERVICE_BILLS_CUSTOMER_COLUMN] !== 'boolean') {
      return { available: false, billing: null };
    }
    const outsideVendor = Array.isArray(row.outside_vendor) ? record(row.outside_vendor[0]) : record(row.outside_vendor);
    return {
      available: true,
      billing: {
        billsCustomer: row[TODO_CONFIRM_APPLICATION_SERVICE_BILLS_CUSTOMER_COLUMN] as boolean,
        outsideCompanyName: typeof outsideVendor?.name === 'string' ? outsideVendor.name : null,
      },
    };
  } catch {
    return { available: false, billing: null };
  }
}
