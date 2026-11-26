/**
 * "Mine" on the Quotes and Orders lists: a record is a sales rep's own when the rep is its salesman, created
 * it, or owns its customer (the customer's assigned sales rep). A view filter only, never a permission:
 * under "All" every rep still sees every record, as before.
 */
export function isMyRecord(
  record: { salesman_id?: string | null; created_by?: string | null },
  customerRepId: string | null | undefined,
  userId: string,
): boolean {
  return record.salesman_id === userId || record.created_by === userId || customerRepId === userId;
}
