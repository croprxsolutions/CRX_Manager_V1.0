/**
 * quotePdfLayout.ts — look of the quote PDF only (Quote PDF board, US Letter in points).
 * The shared PDF palette in pdfTheme.ts stays as it is for the other PDFs.
 */
type RGB = [number, number, number];

export const QUOTE_TEXT: RGB = [31, 31, 31]; // #1f1f1f
export const QUOTE_MUTED: RGB = [90, 90, 90]; // #5a5a5a, labels
export const QUOTE_FOOTER_TEXT: RGB = [74, 74, 74]; // #4a4a4a
export const QUOTE_NOTE_BG: RGB = [246, 246, 246]; // #f6f6f6, header and bottom notes
export const QUOTE_TABLE_HEAD_BG: RGB = [238, 238, 238]; // #eeeeee
export const QUOTE_ROW_RULE: RGB = [227, 227, 227]; // #e3e3e3
export const QUOTE_TOTALS_RULE: RGB = [200, 200, 200]; // #c8c8c8
export const QUOTE_FOOTER_RULE: RGB = [154, 154, 154]; // #9a9a9a, dashed

export const QUOTE_MARGIN_X = 42;
export const QUOTE_MARGIN_TOP = 36;
/** Where content starts on page 2 and later, below the small logo. */
export const QUOTE_CONTINUED_TOP = 60;
/** Content stops here; the footer sits below. */
export const QUOTE_CONTENT_BOTTOM = 66;
export const QUOTE_FOOTER_BASELINE = 30;

/** Logo size: 400 x 125 px source, drawn 142.5 pt wide on page 1 and smaller on later pages. */
export const QUOTE_LOGO_RATIO = 125 / 400;
export const QUOTE_LOGO_WIDTH = 142.5;
export const QUOTE_LOGO_SMALL_WIDTH = 64;

/** Columns that hold numbers; right-aligned like the money columns. */
export const QUOTE_NUMBER_COLUMNS = new Set(['sug_rate', 'actual_rate', 'acres', 'qty']);

export const QUOTE_TOTALS_WIDTH = 210;
