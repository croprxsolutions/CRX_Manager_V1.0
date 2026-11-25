import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  matchAddsNumber,
  nameSwallowsRate,
  parseProductLine,
  pickQuantity,
  rateHasExtra,
  readAmountCell,
} from "./productLine.ts";

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
  check("Roundup 32 oz/ac 10 gal", "Roundup", 10, "gal");
  check("Atrazine 2 qt 1,500 qt", "Atrazine", 1500, "qt");
  check("Atrazine 2 lbs 80 lbs", "Atrazine", 80, "lb");
  check("Atrazine 2 qt 32 QTS", "Atrazine", 32, "QT"); // case kept, as before
  check("Atrazine 2 qt/ac 32 qt", "Atrazine", 32, "qt");
  check("Atrazine 2 qt/ac. 32 qt", "Atrazine", 32, "qt");
  check("Atrazine | 2 qt/ac | 32 qt", "Atrazine", 32, "qt");
  check("Atrazine 2 qt 32qt.", "Atrazine", 32, "qt");
  check("Piksi 6 g .75 g", "Piksi", 0.75, "g");
  check("Piksi | 6 g | 750 g", "Piksi", 750, "g");
  check("Atrazine | 2 qt | 32qt.", "Atrazine", 32, "qt");
});

Deno.test("ml stays ml", () => {
  check("Roundup 2 l 10 ml", "Roundup", 10, "ml");
  check("Roundup 2l 10ml", "Roundup", 10, "ml");
  check("Roundup | 2 l | 10 ml", "Roundup", 10, "ml");
});

Deno.test("a line with only one amount keeps it but leaves the unit blank (strict rule, Sol r2)", () => {
  check("Roundup 32 oz", "Roundup", 32, null);
  check("Roundup 32oz", "Roundup", 32, null);
  check("Atrazine 2. qt", "Atrazine", 2, null);
  check("Roundup | 32 oz", "Roundup", 32, null);
  check("Roundup | 32 oz |", "Roundup", 32, null);
  check("Piksi Dust Inffurow | 6 g/ac | |", "Piksi Dust Inffurow", 6, null);
  check("Piksi Dust Inffurow 750 grams", "Piksi Dust Inffurow", 750, null);
});

Deno.test("Sol r2: damaged totals keep their number; grams and per acre are read", () => {
  check("Roundup | | ~10 gal", "Roundup", 10, null);
  check("Roundup | 2 qt | ~20 qt", "Roundup", 20, null);
  check("Roundup | 2 qt per acre | 20 qt", "Roundup", 20, "qt");
  check("Piksi 6 grams 750 grams", "Piksi", 750, "g");
  // Sol r3: a damaged total never becomes zero; an attached /ac stays the rate.
  check("Roundup | | 10-gal", "Roundup", 10, null);
  check("Atrazine | | 80- qt", "Atrazine", 80, null);
});

Deno.test("the multi-line reader uses the same rule", () => {
  assertEquals(pickQuantity(readAmountCell("6 g"), "750 g"), {
    quantity: 750,
    unit: "g",
  });
  assertEquals(pickQuantity(readAmountCell("6 g"), null), {
    quantity: 6,
    unit: null,
  });
  assertEquals(pickQuantity(readAmountCell("6 g"), "750 mg"), {
    quantity: 750,
    unit: null,
  });
  assertEquals(pickQuantity(readAmountCell("6 g"), "750 g", true), {
    quantity: 750,
    unit: null,
  });
  // Luna r7: extra text in the multi-line rate cell is not exact.
  const dirty = readAmountCell("6 g lot 24");
  assertEquals(pickQuantity(dirty, "750 g", rateHasExtra(dirty)), {
    quantity: 750,
    unit: null,
  });
  assertEquals(rateHasExtra(readAmountCell("6 g/ac")), false);
  assertEquals(rateHasExtra(readAmountCell("6 g")), false);
});

Deno.test("a catalog name that swallows the rate token is caught (Sol r2)", () => {
  const p = parseProductLine("Atrazine 4L 2 qt")!;
  assertEquals(nameSwallowsRate(p, ["Roundup", "Atrazine 4L"]), true);
  assertEquals(nameSwallowsRate(p, ["Atrazine"]), false);
  assertEquals(
    nameSwallowsRate(parseProductLine("Piksi Dust 6 g 750 g")!, ["Piksi Dust"]),
    false,
  );
  // Luna r8: the name's amount and unit are separate tokens.
  const spaced = parseProductLine("Atrazine 4 L 2 qt")!;
  assertEquals(nameSwallowsRate(spaced, ["Atrazine", "Atrazine 4 L"]), true);
  assertEquals(
    nameSwallowsRate(parseProductLine("Liberty 280 SL 32 oz 10 gal")!, ["Liberty 280 SL"]),
    true,
  );
  assertEquals(
    nameSwallowsRate(parseProductLine("Atrazine | 4 L | 2 qt")!, ["Atrazine 4L"]),
    true,
  );
  // Sol r3: the catalog name has more words after the number.
  assertEquals(nameSwallowsRate(p, ["Atrazine 4L Herbicide"]), true);
  assertEquals(
    nameSwallowsRate(parseProductLine("Piksi Dust 6 g 750 g")!, ["Piksi Dust Inffurow"]),
    false,
  );
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
  check("Liberty 280 32 oz", "Liberty", 32, null);
  // Anything after the total, or extra pipe columns (Luna r3).
  check("Piksi 6 g 750 g lot 24", "Piksi", 750, null);
  check("Piksi 6 g 750 g Lot 24 10 gal", "Piksi", 750, null);
  check("Piksi | 6 g | 750 g | 10 gal", "Piksi", 750, null);
  check("Piksi | 6 g | | 10 gal", "Piksi", 6, null);
  // Luna r4: extra text in the pipe rate cell; an unreadable rate keeps a readable total's number.
  check("Piksi | 6 g 750 g | 10 gal", "Piksi", 10, null);
  check("Roundup | N/A | 10 gal", "Roundup", 10, null);
});

Deno.test("a matched product with a number the read name lacks is caught (Sol r4)", () => {
  assertEquals(matchAddsNumber("Atrazlne", "Atrazine 4L"), true);
  assertEquals(matchAddsNumber("2,4-D Amine", "2,4-D Amine"), false);
  assertEquals(matchAddsNumber("Roundup", "Roundup PowerMax"), false);
});
