// send-email draws invoice and purchase order PDFs from the saved records (KI-98).
// These run the real drawing code under Deno against a fake database.
import { jsPDF } from "npm:jspdf@4.2.1";
import { autoTable } from "npm:jspdf-autotable@5.0.9";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { invoiceEmailSnapshot } from "../invoiceEmailGate.ts";
import { drawInvoicePdf, InvoiceDetailsUnavailableError, loadInvoicePdfData } from "./invoicePdf.ts";
import { buildPurchaseOrderPdfData, drawPurchaseOrderPdf, loadPurchaseOrderVendor } from "./purchaseOrderPdf.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, received ${a}`);
}

type Reply = { data: unknown; error: { message: string } | null };

// A query builder that records filters and answers from `tables` (rows matching every .eq).
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>, fail: Set<string> = new Set()) {
  return {
    from(table: string) {
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      const rows = (): Reply => {
        if (fail.has(table)) return { data: null, error: { message: `${table} read failed` } };
        const all = tables[table] ?? [];
        return {
          data: all.filter((r) => eqs.every(([k, v]) => r[k] === v) && ins.every(([k, vs]) => vs.includes(r[k]))),
          error: null,
        };
      };
      const builder = {
        select: () => builder,
        order: () => builder,
        is: () => builder,
        eq: (column: string, value: unknown) => {
          eqs.push([column, value]);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          ins.push([column, values]);
          return builder;
        },
        maybeSingle: () => {
          const r = rows();
          return Promise.resolve(r.error ? r : { data: (r.data as unknown[])[0] ?? null, error: null });
        },
        then: (resolve: (r: Reply) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(rows()).then(resolve, reject),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const pdfText = (doc: { output: (type: "arraybuffer") => ArrayBuffer }) =>
  new TextDecoder("latin1").decode(doc.output("arraybuffer"));

const invoiceTables = () => ({
  invoices: [{
    id: "inv-1", invoice_number: "INV-KI98-1", invoice_date: "2026-11-02", invoice_type: "chemical_sale",
    status: "posted", customer_id: "cust-1", salesman_id: "rep-1", invoice_group_id: null,
    crop_type: null, field_names: null, total_acres: null, applicator_name: null, vehicle_name: null,
    application_date: null, total_amount_cents: 12_345, paid_amount_cents: 2_345, prepay_applied_cents: 0,
    write_off_cents: 0, balance_cents: 10_000, customer: { farm_name: "Green Acres" },
    discount_earned_cents: null, discount_date: null, payment_terms: "Net 30", purchase_order_ref: null,
    header_notes: null, footer_notes: null, due_date: "2026-12-02", diluent_rate_gpa: null,
  }],
  profiles: [{ id: "rep-1", full_name: "Sam Rep" }],
  customers: [{ id: "cust-1", billing_address: "1 Farm Rd", city: "Town", state: "IL", zip: "62000", account_number: "A-1", payment_terms: "Net 30" }],
  invoice_items: [
    { invoice_id: "inv-1", description: "Atrazine 4L", quantity: 2, unit_size: "gal", unit_price_cents: 5_000, extended_cents: 10_000, product: { product_name: "Atrazine 4L", epa_registration: "100-497", product_form: "liquid" } },
    { invoice_id: "inv-1", description: "Surfactant", quantity: 1, unit_size: "gal", unit_price_cents: 2_345, extended_cents: 2_345, product: { product_name: "Surfactant", epa_registration: null, product_form: "liquid" } },
  ],
  invoice_shares: [],
  app_settings: [
    { setting_key: "company_name", setting_value: "Test Ag Co" },
    { setting_key: "company_phone", setting_value: "555-0199" },
    { setting_key: "company_email", setting_value: "office@testag.test" },
    { setting_key: "company_address", setting_value: "" },
  ],
});

Deno.test("an invoice PDF is drawn from the saved invoice, and prints its saved money", async () => {
  const data = await loadInvoicePdfData(fakeDb(invoiceTables()), "inv-1");
  assertEquals(invoiceEmailSnapshot(data), {
    invoice_number: "INV-KI98-1",
    total_amount_cents: 12_345,
    paid_amount_cents: 2_345,
    prepay_applied_cents: 0,
    balance_cents: 10_000,
    lines_total_cents: 12_345,
  });
  assertEquals(data.customer_name, "Green Acres");
  const text = pdfText(drawInvoicePdf({ jsPDF, autoTable }, data));
  assert(text.startsWith("%PDF-"), "not a PDF");
  for (const printed of ["INV-KI98-1", "GREEN ACRES", "Atrazine 4L", "$123.45", "$100.00"]) {
    assert(text.includes(printed), `PDF does not print ${printed}`);
  }
  // The letterhead takes the Settings company details; a blank address keeps the default town.
  for (const printed of ["Test Ag Co", "555-0199", "office@testag.test", "West York, IL"]) {
    assert(text.includes(printed), `PDF does not print the Settings value ${printed}`);
  }
  // The built-in name never heads the letterhead; the pay note names the legal payee ("Crop RX Solutions, Inc."), as the old footer did.
  assert(!text.includes("CROP RX SOLUTIONS") && !text.includes("(Crop RX Solutions)"), "PDF still prints the built-in company name");
  assert(text.includes("Make checks payable to Crop RX Solutions, Inc."), "PDF does not name the legal payee");
});

Deno.test("any failed invoice read refuses instead of drawing a PDF with parts missing", async () => {
  for (const table of ["invoices", "profiles", "customers", "invoice_items", "invoice_shares", "app_settings"]) {
    let refused = false;
    try {
      await loadInvoicePdfData(fakeDb(invoiceTables(), new Set([table])), "inv-1");
    } catch (err) {
      refused = err instanceof InvoiceDetailsUnavailableError || (err as Error).name.includes("Unavailable");
    }
    assert(refused, `a failed ${table} read did not refuse`);
  }
});

Deno.test("a purchase order PDF is drawn from the saved order and its vendor record", async () => {
  const db = fakeDb({
    vendors: [{ name: "Spinner  Ag", contact_name: "Pat", phone: "555-0100", email: "orders@spinner.test", address: "9 Mill St" }],
  });
  const vendor = await loadPurchaseOrderVendor(db, "spinner ag");
  assertEquals(vendor?.contact_name, "Pat");
  const data = buildPurchaseOrderPdfData(
    { po_number: "PO-KI98-1", status: "submitted", vendor: "Spinner Ag", submitted_date: "2026-11-02", expected_delivery_date: null, notes: null },
    vendor,
    [{ product_name: "Atrazine 4L", product: { product_name: "Atrazine 4L", epa_registration: "100-497" }, unit_size: "gal", quantity_ordered: "3", unit_cost: "19.99", cost_needs_review: false, notes: null }],
  );
  assertEquals(data.lines[0].quantity_ordered, 3);
  assertEquals(data.lines[0].unit_cost, 19.99);
  const company = { name: "Prairie Ag Co", phone: "555-0199", email: "", address: "12 Main St Annapolis, IL 62413" };
  const text = pdfText(drawPurchaseOrderPdf({ jsPDF, autoTable }, data, company));
  assert(text.startsWith("%PDF-"), "not a PDF");
  for (const printed of ["PO-KI98-1", "Atrazine 4L", "$59.97", "PRAIRIE AG CO", "12 Main St Annapolis, IL 62413", "555-0199"]) {
    assert(text.includes(printed), `PDF does not print ${printed}`);
  }
});

Deno.test("two vendors with the PO's vendor name refuse instead of guessing", async () => {
  const db = fakeDb({ vendors: [{ name: "Spinner Ag" }, { name: "spinner ag" }] });
  let refused = false;
  try {
    await loadPurchaseOrderVendor(db, "Spinner Ag");
  } catch {
    refused = true;
  }
  assert(refused, "duplicate vendor names did not refuse");
});
