import { supabase, assertRpcResult } from './db';
import type { Customer } from '../types';

/**
 * What a driver may see of a farm (#2018, Mason 2026-11-21): name, phone, email and the delivery address
 * (shipping, else billing). get_driver_customers never returns credit, prepay, terms or notes; drivers lose the
 * whole-row customers read in a later release, so driver screens read farms only through here.
 */
export interface DriverFarm {
  id: string;
  farm_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  // A delivery with no site goes to the shipping address, else billing, as on the load sheet (#2018; Mason, 2026-11-21).
  billing_address?: string | null;
  shipping_address?: string | null;
}

/** Farms by id. Throws on a failed read so a caller never mistakes a failure for "no farm". */
export async function fetchDriverFarms(ids: (string | null | undefined)[]): Promise<Map<string, DriverFarm>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  const farms = new Map<string, DriverFarm>();
  // The database takes at most 500 ids per call.
  for (let i = 0; i < unique.length; i += 500) {
    const { data, error } = await supabase.rpc('get_driver_customers', { p_customer_ids: unique.slice(i, i + 500) });
    if (error) throw error;
    const rows = assertRpcResult<{ rows: unknown }>(data, 'get_driver_customers').rows;
    // A malformed reply such as {} is a failure, not "no farms" (#2167).
    if (!Array.isArray(rows)) throw new Error('get_driver_customers returned an unexpected result');
    // An email of only spaces is no email, so screens still warn that none is on file (#2167).
    for (const farm of rows as DriverFarm[]) farms.set(farm.id, { ...farm, email: farm.email?.trim() || null });
  }
  return farms;
}

/**
 * One delivery's farm for the delivery detail screen, in the customers-read result shape. A driver gets only the
 * lookup's fields, with the delivery address where the office sees the billing and shipping address; others read
 * the whole row as before.
 */
export async function fetchDeliveryFarm(
  customerId: string,
  isDriver: boolean,
): Promise<{ data: Customer | null; error: unknown }> {
  if (!isDriver) {
    const { data, error } = await supabase.from('customers').select('*').eq('id', customerId).maybeSingle();
    return { data: data as Customer | null, error };
  }
  try {
    const farm = (await fetchDriverFarms([customerId])).get(customerId);
    const data = farm
      ? ({ id: farm.id, farm_name: farm.farm_name, phone: farm.phone, email: farm.email,
          billing_address: farm.billing_address ?? null, shipping_address: farm.shipping_address ?? null } as unknown as Customer)
      : null;
    return { data, error: null };
  } catch (error) {
    return { data: null, error };
  }
}
