export interface BatchPostInvoice {
  id: string;
  invoice_number: string;
  invoice_group_id?: string | null;
  /** The `invoice_post_version` the list loaded with this row (see invoicePostVersion.ts). */
  invoice_post_version?: string | null;
  deleted_at?: string | null;
}

/**
 * The {invoice_id: version} map post_invoice_group needs: every member of the group among the rows
 * this screen loaded, with the version it loaded. Only loaded rows count, so a member added since
 * the screen loaded makes the server refuse instead of posting an invoice nobody saw.
 */
export function groupVersionsFromRows(
  invoiceGroupId: string,
  rows: readonly Pick<BatchPostInvoice, 'id' | 'invoice_group_id' | 'deleted_at' | 'invoice_post_version'>[],
): Record<string, string | null | undefined> {
  const versions: Record<string, string | null | undefined> = {};
  for (const row of rows) {
    if (row.invoice_group_id === invoiceGroupId && !row.deleted_at) versions[row.id] = row.invoice_post_version;
  }
  return versions;
}

export interface InvoicePostTarget {
  key: string;
  operation: 'post_invoice' | 'post_invoice_group';
  scopeId: string;
  label: string;
  selectedIds: string[];
  /** Version each selected row was loaded with; posting refuses a row changed since. */
  loadedVersions: Record<string, string | null | undefined>;
  invoiceId?: string;
  invoiceGroupId?: string;
}

/**
 * The post confirm for a selection. `count` is how many invoices actually post: each plain invoice, plus every
 * loaded member of each selected split group (the group posts together, even members not ticked).
 */
export function describeInvoicePostScope(
  invoices: BatchPostInvoice[],
  loadedRows: readonly BatchPostInvoice[] = invoices,
): { message: string; confirmLabel: string; count: number } {
  const count = buildInvoicePostTargets(invoices, loadedRows)
    .reduce((n, t) => n + (t.invoiceGroupId ? Object.keys(t.loadedVersions).length : 1), 0);
  const confirmLabel = `Post ${count} invoice${count === 1 ? '' : 's'}`;
  if (invoices.some((invoice) => Boolean(invoice.invoice_group_id))) {
    return {
      message:
        'These include a split sale, so every invoice in that split posts together, even ones your filters hide. If one changed since you opened this list, none of its split posts and you will be told. The other invoices still post.',
      confirmLabel,
      count,
    };
  }
  // The confirm's title already asks "Post n invoices?", so the body does not repeat it.
  return { message: 'Posting locks them into AR.', confirmLabel, count };
}

/**
 * Build one posting action per standalone invoice and one action per split group.
 * A group RPC posts every sibling atomically, even when the user selected only
 * one visible member, so grouped rows must never fall through to post_invoice.
 * `loadedRows` is every row the screen loaded (not just the selection): a group's
 * versions come from all of its loaded members, so the server can tell whether the
 * group's membership changed since.
 */
export function buildInvoicePostTargets(
  invoices: BatchPostInvoice[],
  loadedRows: readonly BatchPostInvoice[] = invoices,
): InvoicePostTarget[] {
  const targets: InvoicePostTarget[] = [];
  const groupTargets = new Map<string, InvoicePostTarget>();

  for (const invoice of invoices) {
    if (!invoice.invoice_group_id) {
      targets.push({
        key: `invoice:${invoice.id}`,
        operation: 'post_invoice',
        scopeId: invoice.id,
        label: invoice.invoice_number,
        selectedIds: [invoice.id],
        loadedVersions: { [invoice.id]: invoice.invoice_post_version },
        invoiceId: invoice.id,
      });
      continue;
    }

    const existing = groupTargets.get(invoice.invoice_group_id);
    if (existing) {
      existing.selectedIds.push(invoice.id);
      existing.label += `, ${invoice.invoice_number}`;
      continue;
    }

    const target: InvoicePostTarget = {
      key: `group:${invoice.invoice_group_id}`,
      operation: 'post_invoice_group',
      scopeId: invoice.invoice_group_id,
      label: `Split group (${invoice.invoice_number}`,
      selectedIds: [invoice.id],
      loadedVersions: groupVersionsFromRows(invoice.invoice_group_id, [...loadedRows, ...invoices]),
      invoiceGroupId: invoice.invoice_group_id,
    };
    groupTargets.set(invoice.invoice_group_id, target);
    targets.push(target);
  }

  for (const target of groupTargets.values()) {
    target.label += ')';
  }
  return targets;
}
