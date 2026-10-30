interface InvalidOrderCsvRow {
  row: number;
  error: string;
  data: Record<string, string>;
}

/** Repeated order headers must agree; never choose one customer's header for another's items. */
export function checkOrderCsvGroups(
  headers: string[], rows: string[][], rowNumbers: number[], fields: Record<string, number>,
): { blocked: Set<string>; invalid: InvalidOrderCsvRow[]; headersByOrder: Map<string, string[]> } {
  const firstRows = new Map<string, string[]>();
  const blocked = new Set<string>();
  const invalid: InvalidOrderCsvRow[] = [];
  rows.forEach((row, index) => {
    const orderNumber = row[fields.order_number];
    if (!orderNumber) return;
    const first = firstRows.get(orderNumber);
    if (!first) {
      firstRows.set(orderNumber, [...row]);
      return;
    }
    const conflicts = ['customer_name', 'order_date', 'notes'].filter((field) => {
      const column = fields[field];
      if (column === undefined || !row[column]) return false;
      if (!first[column]) first[column] = row[column];
      return row[column] !== first[column];
    });
    if (!conflicts.length) return;
    blocked.add(orderNumber);
    invalid.push({
      row: rowNumbers[index],
      error: `Conflicting ${conflicts.join(', ')} for order ${orderNumber}. Make the header values match on every row; the entire order is excluded.`,
      data: Object.fromEntries(headers.map((header, column) => [header, row[column]])),
    });
  });
  return { blocked, invalid, headersByOrder: firstRows };
}
