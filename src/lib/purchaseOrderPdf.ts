/**
 * purchaseOrderPdf.ts — the purchase order PDF in the app (To-Do 0.15).
 *
 * The layout lives in the Edge Functions' shared folder, so send-email draws an
 * emailed PO copy with the same code (KNOWN_ISSUES KI-98). jsPDF and autoTable are
 * dynamically imported here to keep them out of the main bundle (~500KB each).
 */
import {
  drawPurchaseOrderPdf,
  purchaseOrderPdfFilename,
  type PdfPurchaseOrderData,
} from '../../supabase/functions/_shared/pdf/purchaseOrderPdf.ts';
import type { JsPDFWithAutoTable } from './pdfTheme';

export {
  buildPurchaseOrderPdfData,
  buildPurchaseOrderPdfRows,
  purchaseOrderPdfFilename,
  purchaseOrderStatusBanner,
  type PdfPurchaseOrderData,
  type PdfPurchaseOrderLine,
  type PdfPurchaseOrderVendor,
  type PurchaseOrderPdfRow,
} from '../../supabase/functions/_shared/pdf/purchaseOrderPdf.ts';

export async function generatePurchaseOrderPdf(data: PdfPurchaseOrderData): Promise<JsPDFWithAutoTable> {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  return drawPurchaseOrderPdf({ jsPDF, autoTable }, data);
}

export async function downloadPurchaseOrderPdf(data: PdfPurchaseOrderData): Promise<void> {
  const doc = await generatePurchaseOrderPdf(data);
  doc.save(purchaseOrderPdfFilename(data.po_number));
}
