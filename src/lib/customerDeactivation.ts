import type { Customer } from '../types';

/** The open-work refusal cuts a farm name over 60 characters to 59 and "…". When several selected farms share
 * that start, name them all so the office can tell which one still has open work (#2114). */
export function namesCutFarm(message: string, selected: Pick<Customer, 'farm_name'>[]): string {
  const prefix = message.match(/deactivated\. (.{59})… still has/su)?.[1];
  if (!prefix) return message;
  const farms = selected.map((c) => (c.farm_name ?? '').trim()).filter((n) => n.startsWith(prefix));
  return farms.length > 1 ? `${message} Selected farms starting with that name: ${farms.join('; ')}.` : message;
}
