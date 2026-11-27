import { supabaseUntyped } from './db';

export const VEHICLE_CARRIER_DEFAULT_DB_READY = false;
const TODO_CONFIRM_VEHICLE_DEFAULT_CARRIER_COLUMN = 'default_carrier_gpa' as const;

export type CarrierRateOrigin = 'rig_default' | 'manual' | 'loaded' | null;

export interface VehicleCarrierDefaultRead {
  available: boolean;
  defaultGpa: number | null;
}

export interface CarrierRateDefaultResult {
  value: string;
  autoFilled: boolean;
  origin: CarrierRateOrigin;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function loadVehicleCarrierDefault(vehicleId: string): Promise<VehicleCarrierDefaultRead> {
  try {
    const { data, error } = await supabaseUntyped
      .from('vehicles')
      .select(TODO_CONFIRM_VEHICLE_DEFAULT_CARRIER_COLUMN)
      .eq('id', vehicleId)
      .maybeSingle();
    const row = record(data);
    if (error || !row || !(TODO_CONFIRM_VEHICLE_DEFAULT_CARRIER_COLUMN in row)) {
      return { available: false, defaultGpa: null };
    }
    const value = row[TODO_CONFIRM_VEHICLE_DEFAULT_CARRIER_COLUMN];
    const defaultGpa = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    return { available: true, defaultGpa };
  } catch {
    return { available: false, defaultGpa: null };
  }
}

export function applyRigCarrierDefault(
  currentValue: string,
  wasAutoFilled: boolean,
  defaultGpa: number | null,
): CarrierRateDefaultResult {
  if (defaultGpa == null || !Number.isFinite(defaultGpa) || defaultGpa <= 0) {
    return wasAutoFilled
      ? { value: '', autoFilled: false, origin: null }
      : { value: currentValue, autoFilled: false, origin: currentValue.trim() ? 'manual' : null };
  }
  if (currentValue.trim() && !wasAutoFilled) {
    return { value: currentValue, autoFilled: false, origin: 'manual' };
  }
  return { value: String(defaultGpa), autoFilled: true, origin: 'rig_default' };
}

export function carrierRateSourceLabel(
  value: string,
  origin: CarrierRateOrigin,
  defaultGpa: number | null,
): '(rig default)' | '(changed for this job)' | null {
  if (!value.trim()) return null;
  if (origin === 'rig_default' || (
    origin === 'loaded' && defaultGpa != null && Number(value) === defaultGpa
  )) return '(rig default)';
  return '(changed for this job)';
}
