import { supabase, assertRpcResult } from './db';

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
}

/** Farms by id. Throws on a failed read so a caller never mistakes a failure for "no farm". */
export async function fetchDriverFarms(ids: (string | null | undefined)[]): Promise<Map<string, DriverFarm>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase.rpc('get_driver_customers', { p_customer_ids: unique });
  if (error) throw error;
  const rows = assertRpcResult<{ rows: DriverFarm[] }>(data, 'get_driver_customers').rows ?? [];
  return new Map(rows.map((farm) => [farm.id, farm]));
}
