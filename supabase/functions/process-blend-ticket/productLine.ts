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
        !END.test((rate?.rest ?? "").replace(PER_ACRE, "")) ||
          parts.slice(3).some((p) => p !== ""),
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

const UNIT_WORD = /^(gals?|gallons?|lbs?|oz|qts?|pts?|pints?|quarts?|l|ml|g)$/i;
const PER_ACRE = /^\/\s*a(?:c(?:re)?)?\.?(?=\s|$)\s*/i; // "/ac", "/A", "/acre."

// Strict rule: a unit is filled only for an exact line, name + rate with a known unit + (optionally)
// total with a known unit, and nothing else. The total, when present, is the quantity ("6 g 750 g" is
// 750 g, Sol #2267 r11). Any other line keeps a best-guess number with a blank unit, which the filing
// stock-unit check refuses, so a rep must correct it before it can be filed or deducted.
function pickQuantity(
  rate: AmountCell | null,
  totalText: string | null,
  extraColumns = false,
): { quantity: number; unit: string | null } {
  const total = totalText ? readAmountCell(totalText) : null;
  if (!rate) return { quantity: total?.amount ?? 0, unit: null };
  const quantity = total?.amount ?? rate.amount;
  const exact = rate.unit !== null && !extraColumns &&
    (totalText === null || (total?.unit != null && END.test(total.rest)));
  return { quantity, unit: exact ? (total ?? rate).unit : null };
}

const END = /^[.;]*$/;

type AmountCell = {
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
