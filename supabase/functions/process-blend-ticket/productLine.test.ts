import { assertEquals } from "jsr:@std/assert@1.0.14";
import { parseProductLine } from "./productLine.ts";

function read(line: string) {
  const p = parseProductLine(line);
  return p && { name: p.productName, quantity: p.quantity, unit: p.unit };
}

function check(
  line: string,
  name: string,
  quantity: number,
  unit: string | null,
) {
  assertEquals(read(line), { name, quantity, unit }, line);
}

Deno.test("the total column, not the per-acre rate, is the quantity (Sol #2267 r11)", () => {
  check("Piksi Dust Inffurow 6 g 750 g", "Piksi Dust Inffurow", 750, "g");
  check("Piksi Dust 6g 750g", "Piksi Dust", 750, "g");
  check("Roundup 32 oz 10 gal", "Roundup", 10, "gal");
  check("Atrazine 2 qt 1,500 qt", "Atrazine", 1500, "qt");
  check("Atrazine 2 lbs 80 lbs", "Atrazine", 80, "lb");
  check("Atrazine 2 qt 32 QTS", "Atrazine", 32, "QT"); // case kept, as before
  check("Atrazine 2 qt/ac 32 qt", "Atrazine", 32, "qt");
  check("Atrazine 2 qt 32qt.", "Atrazine", 32, "qt");
  check("Piksi 6 g .75 g", "Piksi", 0.75, "g");
  check("Piksi 6 g 750 g lot 24", "Piksi", 750, "g");
  check("Piksi | 6 g | 750 g", "Piksi", 750, "g");
  check("Atrazine | 2 qt | 32qt.", "Atrazine", 32, "qt");
});

Deno.test("a line with only a rate keeps it", () => {
  check("Roundup 32 oz", "Roundup", 32, "oz");
  check("Roundup 32oz", "Roundup", 32, "oz");
  check("Atrazine 2. qt", "Atrazine", 2, "qt");
  check("Roundup | 32 oz", "Roundup", 32, "oz");
  check("Roundup | 32 oz |", "Roundup", 32, "oz");
});

Deno.test("anything uncertain leaves the unit blank so the stock check stops it (Astra, Luna, Sol r1)", () => {
  // Text after the rate that is not a clean total.
  check("Piksi 6 g lot 24", "Piksi", 6, null);
  check("Roundup 32 oz Lot 12345", "Roundup", 32, null);
  check("Roundup 32 oz 524-579", "Roundup", 32, null);
  check("Roundup | 32 oz | N/A", "Roundup", 32, null);
  check("Piksi | 6 g | 1,5 g", "Piksi", 6, null);
  check("Piksi 6 g 1,5 g", "Piksi", 6, null);
  // A total with no unit, or a unit we do not know: never borrows the rate's unit, never finds g inside mg.
  check("Roundup 32 oz 10", "Roundup", 10, null);
  check("Roundup | 32 oz | 10", "Roundup", 10, null);
  check("Roundup 32 oz 10 Lot 5", "Roundup", 10, null);
  check("Piksi 6 g 750 mg", "Piksi", 750, null);
  check("Piksi | 6 g | 750 mg", "Piksi", 750, null);
  check("Piksi | 6 g | 750 kg", "Piksi", 750, null);
  check("Piksi 6 g 2 bags", "Piksi", 2, null);
  check("Seed | 1 bag | 50 bag", "Seed", 50, null);
  check("Atrazine 2 qt 1 500 qt", "Atrazine", 1, null);
  // A rate with a unit we do not know.
  check("Piksi 6 mg", "Piksi", 6, null);
  check("Piksi 6 kg", "Piksi", 6, null);
  check("Seed 6 bags", "Seed", 6, null);
  // A number in the product name shifts the columns.
  check("Liberty 280 SL 32 oz 10 gal", "Liberty", 32, null);
  check("Atrazine 4L 2 qt 100 qt", "Atrazine", 2, null);
});
