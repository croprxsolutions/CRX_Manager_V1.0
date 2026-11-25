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

      // Same strict amount cells and rules as the plain reader below.
      const rate = readAmountCell(ratePerAcre || "");
      const total = readAmountCell(totalProduct || "");
      const quantity = total?.amount ?? rate?.amount ?? 0;
      const unit = total
        ? total.unit ??
          (total.word === null && total.rest === "" ? rate?.unit ?? null : null)
        : rate?.unit ?? null;

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

  // The first cell is the per-acre rate; a clean amount cell right after it is the total used, and the
  // total is the quantity, as in the pipe and multi-line readers ("6 g 750 g" is 750 g, Sol #2267 r11).
  const rate = readAmountCell(tokens.slice(numIdx).join(" "));
  const total = rate?.rest ? readAmountCell(rate.rest) : null;

  let quantity = rate?.amount ?? 0;
  let unit = rate?.unit ?? null;
  if (total) {
    quantity = total.amount;
    // A bare total at the end of the line shares the rate's unit; anything else unrecognised stays blank for the rep.
    unit = total.unit ??
      (total.word === null && total.rest === "" ? unit : null);
  }

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

const UNIT_WORD = /^(gals?|gallons?|lbs?|oz|qt|pt|pints?|quarts?|l|ml|g)$/i;

// One "amount [unit]" cell at the start of text, e.g. "750 g", "750g", ".75 g", "1,500 qt".
// word is the letters right after the amount; unit is set only when that word is a unit we know,
// so "750 mg" or "750 kg" never turns into grams.
export function readAmountCell(
  text: string,
):
  | { amount: number; word: string | null; unit: string | null; rest: string }
  | null {
  const m = text.trim().match(
    /^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)\s*([a-z]+)?(?=\s|$)\s*(.*)$/i,
  );
  if (!m) return null;
  const word = m[2] ?? null;
  const unit = word && UNIT_WORD.test(word)
    ? word.match(/(gal|gallon|gallons|lb|lbs|oz|qt|pt|pint|quart|l|ml|g)/i)![1]
    : null;
  return { amount: parseFloat(m[1].replace(/,/g, "")), word, unit, rest: m[3] };
}
