import type { Invoice } from '../types';
import { isBillSplitInvoice, takesChargeLines } from '../../supabase/functions/_shared/pdf/invoicePdf.ts';

export type InvoiceRowPdfSource = Invoice & { customer_name: string; salesman_name: string | null };

// The invoice-row half of a printed invoice (the list row already holds these).
export function invoiceRowPdfFields(inv: InvoiceRowPdfSource) {
  return { ...rowText(inv), ...rowMoney(inv) };
}

function rowText(inv: InvoiceRowPdfSource) {
  return {
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date,
    due_date: inv.due_date || undefined,
    invoice_type: inv.invoice_type || 'chemical_sale',
    status: inv.status || 'draft',
    bill_split_on_load: isBillSplitInvoice(inv),
    customer_name: inv.customer_name,
    salesman_name: inv.salesman_name || undefined,
    purchase_order_ref: inv.purchase_order_ref || undefined,
    header_notes: inv.header_notes || undefined,
    footer_notes: inv.footer_notes || undefined,
    crop_type: inv.crop_type || undefined,
    field_names: inv.field_names || undefined,
    total_acres: inv.total_acres || undefined,
    applicator_name: inv.applicator_name || undefined,
    vehicle_name: inv.vehicle_name || undefined,
    application_date: inv.application_date || undefined,
  };
}

function rowMoney(inv: InvoiceRowPdfSource) {
  return {
    total_amount_cents: inv.total_amount_cents || 0,
    total_cost_cents: inv.total_cost_cents || 0,
    paid_amount_cents: inv.paid_amount_cents || 0,
    prepay_applied_cents: inv.prepay_applied_cents || 0,
    // Attack run on #1873: the rows add up to the balance only with the write-off and the credit applied, and an
    // older untyped line is a charge exactly where the invoice page and the emailed PDF say so.
    write_off_cents: inv.write_off_cents ?? 0,
    credit_applied_cents: inv.credit_applied_cents ?? 0,
    takes_charge_lines: takesChargeLines(inv.invoice_type, inv),
    balance_cents: inv.balance_cents || 0,
  };
}
