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

      const qtyMatch = (totalProduct || ratePerAcre || "").match(
        /([\d,]+\.?\d*)/,
      );
      const quantity = qtyMatch ? parseFloat(qtyMatch[1].replace(/,/g, "")) : 0;
      const unitMatch = (totalProduct || ratePerAcre || "").match(
        /(gal|gallon|gallons|lb|lbs|oz|qt|pt|pint|quart|l|ml|g)/i,
      );

      return {
        productName,
        quantity,
        unit: unitMatch ? unitMatch[1] : null,
        ratePerAcre,
        totalProduct,
        lotNumber: null,
        confidenceScore: calcProductConfidence(
          productName,
          quantity,
          unitMatch?.[1] || null,
        ),
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

  const numToken = tokens[numIdx];
  const qtyUnitMatch = numToken.match(
    /^([\d,]+\.?\d*)(pt|gal|lb|oz|qt|ml|l|g)?$/i,
  );
  const unitFromQty = qtyUnitMatch?.[2] || null;

  const ratePerAcre = tokens[numIdx] || null;
  const totalProduct = tokens.length > numIdx + 1
    ? tokens.slice(numIdx + 1).join(" ")
    : null;

  // The first number is the per-acre rate; a later number is the total used, which is the quantity,
  // as in the pipe and multi-line readers ("6 g 750 g" is 750 g, Sol #2267 round 11).
  const totalMatch = (totalProduct || "").match(
    /(\d[\d,]*\.?\d*)\s*(gal|gallon|gallons|lb|lbs|oz|qt|pt|pint|quart|l|ml|g)?/i,
  );
  const qtyText = totalMatch?.[1] ?? qtyUnitMatch?.[1];
  const quantity = qtyText ? parseFloat(qtyText.replace(/,/g, "")) : 0;

  const unitMatch = (totalProduct || "").match(
    /(gal|gallon|gallons|lb|lbs|oz|qt|pt|pint|quart|l|ml|g)/i,
  );
  const unit = totalMatch?.[2] || unitFromQty ||
    (unitMatch ? unitMatch[1] : null);

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
