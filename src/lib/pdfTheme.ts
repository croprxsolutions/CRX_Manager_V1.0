/**
 * pdfTheme.ts — shared typing and palette for all CRX PDF generators.
 *
 * jsPDF + jspdf-autotable are dynamically imported at runtime inside each
 * generator (to keep them out of the main bundle). The palette lives in the Edge
 * Functions' shared folder so send-email draws the same PDFs (KNOWN_ISSUES KI-98).
 */
export {
  type JsPDFWithAutoTable,
  type PdfLib,
  CRX_GREEN,
  CHARCOAL,
  GRAY,
  LIGHT_BG,
  RED,
  AMBER,
  TABLE_HEADER_BG,
  ALT_ROW_BG,
  BLUE,
} from '../../supabase/functions/_shared/pdf/theme.ts';
