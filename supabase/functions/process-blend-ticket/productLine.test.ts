import { assertEquals } from "jsr:@std/assert@1.0.14";
import { parseProductLine } from "./productLine.ts";

function read(line: string) {
  const p = parseProductLine(line);
  return p && { name: p.productName, quantity: p.quantity, unit: p.unit };
}

Deno.test("the total column, not the per-acre rate, is the quantity (Sol #2267 r11)", () => {
  assertEquals(read("Piksi Dust Inffurow 6 g 750 g"), {
    name: "Piksi Dust Inffurow",
    quantity: 750,
    unit: "g",
  });
  assertEquals(read("Piksi Dust 6g 750g"), {
    name: "Piksi Dust",
    quantity: 750,
    unit: "g",
  });
  assertEquals(read("Roundup 32 oz 10 gal"), {
    name: "Roundup",
    quantity: 10,
    unit: "gal",
  });
  assertEquals(read("Atrazine 2 qt 1,500 qt"), {
    name: "Atrazine",
    quantity: 1500,
    unit: "qt",
  });
});

Deno.test("a line with only a rate keeps that number (unchanged)", () => {
  assertEquals(read("Roundup 32 oz"), {
    name: "Roundup",
    quantity: 32,
    unit: "oz",
  });
  assertEquals(read("Roundup 32oz"), {
    name: "Roundup",
    quantity: 32,
    unit: "oz",
  });
});

Deno.test("the pipe form already read the total (unchanged)", () => {
  assertEquals(read("Piksi | 6 g | 750 g"), {
    name: "Piksi",
    quantity: 750,
    unit: "g",
  });
});
