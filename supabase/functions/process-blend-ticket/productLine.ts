// One product line from the CropRx blend-ticket OCR text: name, rate per acre, total used.

export interface ParsedProduct {
  productName: string;
  quantity: number;
  unit: string | null;
  ratePerAcre: string | null;
  totalProduct: string | null;
  lotNumber: string | null;
  confidenceScore: number;
}

export function calcProductConfidence(
  name: string,
  qty: number,
  unit: string | null,
): number {
  let c = 50;
  if (name.length > 3) c += 15;
  if (qty > 0) c += 20;
  if (unit) c += 15;
  return Math.min(c, 100);
}

export function parseProductLine(
  line: string,
): ParsedProduct | null {
  const lower = line.toLowerCase();
  if (
    lower === "product" || lower.includes("rate/acre") || lower === "acre" ||
    lower === "total product" || lower === "total"
  ) {
    return null;
  }

  if (line.includes("|")) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length >= 2 && parts[0].length > 0) {
      const productName = parts[0];
      const ratePerAcre = parts[1] || null;
      const totalProduct = parts.length >= 3 ? parts[2] : null;

      const rate = readAmountCell(ratePerAcre || "");
      const { quantity, unit } = pickQuantity(
        rate,
        totalProduct || null,
        // Extra text in the rate cell or extra columns mean the line is not exact.
        rateHasExtra(rate) || parts.slice(3).some((p) => p !== ""),
      );

      return {
        productName,
        quantity,
        unit,
        ratePerAcre,
        totalProduct,
        lotNumber: null,
        confidenceScore: calcProductConfidence(productName, quantity, unit),
      };
    }
  }

  const tokens = line.split(/\s+/);
  if (tokens.length < 2) return null;

  let numIdx = -1;
  for (let t = 0; t < tokens.length; t++) {
    if (tokens[t].match(/^\d+\.?\d*$/)) {
      numIdx = t;
      break;
    }
    if (tokens[t].match(/^\d+\.?\d*(pt|gal|lb|oz|qt|ml|l|g)$/i)) {
      numIdx = t;
      break;
    }
  }

  if (numIdx <= 0) return null;

  const productName = tokens.slice(0, numIdx).join(" ");
  if (productName.length < 2) return null;

  const ratePerAcre = tokens[numIdx] || null;
  const totalProduct = tokens.length > numIdx + 1
    ? tokens.slice(numIdx + 1).join(" ")
    : null;

  const rate = readAmountCell(tokens.slice(numIdx).join(" "));
  const afterRate = (rate?.rest ?? "").replace(/^[.;]+(?=\s|$)\s*/, "").replace(
    PER_ACRE,
    "",
  );
  const { quantity, unit } = pickQuantity(rate, afterRate || null);

  return {
    productName,
    quantity,
    unit,
    ratePerAcre,
    totalProduct,
    lotNumber: null,
    confidenceScore: calcProductConfidence(productName, quantity, unit),
  };
}

const UNIT_WORD =
  /^(gals?|gallons?|lbs?|oz|qts?|pts?|pints?|quarts?|l|ml|g|grams?)$/i;
// "/ac", "/A", "/acre.", "per acre"
const PER_ACRE = /^(?:\/\s*|per\s+)a(?:c(?:re)?)?\.?(?=\s|$)\s*/i;
// A damaged total like "~10 gal": only symbols before the number, so "lot 24" or "1,5" never count.
const LOOSE_NUMBER =
  /^[^a-z0-9.,]*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?=[\s a-z]|$)/i;

// Strict rule (Mason, 2026-11-24): a unit is filled only for an exact line, a rate with a known unit
// and a total with a known unit, nothing else. The total is the quantity ("6 g 750 g" is 750 g, Sol
// #2267 r11). Every other line (one amount only, an empty or unreadable total, an unknown unit, extra
// text or columns) keeps a best-guess number with a blank unit, which the filing stock-unit check
// refuses, so a rep must correct it before it can be filed or deducted. Used by all three readers.
export function pickQuantity(
  rate: AmountCell | null,
  totalText: string | null,
  extraColumns = false,
): { quantity: number; unit: string | null } {
  const total = totalText ? readAmountCell(totalText) : null;
  const loose = totalText?.match(LOOSE_NUMBER)?.[1];
  const quantity = total?.amount ??
    (loose ? parseFloat(loose.replace(/,/g, "")) : rate?.amount ?? 0);
  const exact = rate?.unit != null && total?.unit != null &&
    END.test(total.rest) && !extraColumns;
  return { quantity, unit: exact ? total.unit : null };
}

const END = /^[.;]*$/;

// A rate cell read on its own (pipe or multi-line) is clean only as "amount unit" plus an optional /ac.
export function rateHasExtra(rate: AmountCell | null): boolean {
  return !END.test((rate?.rest ?? "").replace(PER_ACRE, ""));
}

export type AmountCell = {
  amount: number;
  word: string | null;
  unit: string | null;
  rest: string;
};

// One "amount [unit]" cell at the start of text, e.g. "750 g", "750g", ".75 g", "2.", "1,500 qt".
// word is the letters right after the amount; unit is set only when that word is a unit we know,
// so "750 mg" or "750 kg" never turns into grams.
export function readAmountCell(text: string): AmountCell | null {
  const m = text.trim().match(
    /^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)\s*([a-z]+)?(?=[\s/.;]|$)\s*(.*)$/i,
  );
  if (!m) return null;
  const word = m[2] ?? null;
  const unit = word && UNIT_WORD.test(word)
    ? word.match(/(gal|gallon|gallons|lb|lbs|oz|qt|pt|pint|quart|l|ml|g)/i)![1]
    : null;
  return { amount: parseFloat(m[1].replace(/,/g, "")), word, unit, rest: m[3] };
}

const normName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

// A catalog name that ends with what the reader took as the rate ("Atrazine 4L" read as "Atrazine"
// + rate 4L) means the columns shifted; the caller leaves the unit blank for the rep (Sol r2).
export function nameSwallowsRate(
  prod: Pick<ParsedProduct, "productName" | "ratePerAcre">,
  catalogNames: string[],
): boolean {
  if (!prod.ratePerAcre) return false;
  const joined = normName(prod.productName + prod.ratePerAcre);
  return catalogNames.some((n) => normName(n) === joined);
}
