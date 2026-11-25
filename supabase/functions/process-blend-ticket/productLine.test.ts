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

Deno.test("a total is only a clean amount cell right after the rate (Astra challenge)", () => {
  // Text after the rate that is not an amount never becomes the total.
  assertEquals(read("Piksi 6 g lot 24")?.quantity, 6);
  assertEquals(read("Piksi 6 g 750 g lot 24")?.quantity, 750);
  // A leading decimal is kept; a European-style comma is not read as thousands.
  assertEquals(read("Piksi 6 g .75 g")?.quantity, 0.75);
  assertEquals(read("Piksi 6 g 1,5 g")?.quantity, 6);
  // mg and kg are not grams: the amount is kept, the unit is left blank for the rep.
  assertEquals(read("Piksi 6 g 750 mg"), {
    name: "Piksi",
    quantity: 750,
    unit: null,
  });
  assertEquals(read("Piksi | 6 g | 750 mg"), {
    name: "Piksi",
    quantity: 750,
    unit: null,
  });
  assertEquals(read("Piksi | 6 g | 750 kg"), {
    name: "Piksi",
    quantity: 750,
    unit: null,
  });
  // A bare total at the end of the line takes the rate's unit.
  assertEquals(read("Roundup 32 oz 10"), {
    name: "Roundup",
    quantity: 10,
    unit: "oz",
  });
  // Plural units keep their old short form.
  assertEquals(read("Atrazine 2 lbs 80 lbs"), {
    name: "Atrazine",
    quantity: 80,
    unit: "lb",
  });
});

Deno.test("lot numbers, EPA numbers and unknown units never become a confident total (compliance review)", () => {
  assertEquals(read("Roundup 32 oz Lot 12345"), {
    name: "Roundup",
    quantity: 32,
    unit: "oz",
  });
  assertEquals(read("Roundup 32 oz 524-579"), {
    name: "Roundup",
    quantity: 32,
    unit: "oz",
  });
  assertEquals(read("Piksi 6 g 2 kg"), {
    name: "Piksi",
    quantity: 2,
    unit: null,
  });
  assertEquals(read("Piksi 6 g 2 bags"), {
    name: "Piksi",
    quantity: 2,
    unit: null,
  });
  assertEquals(read("Roundup 32 oz 10 Lot 5"), {
    name: "Roundup",
    quantity: 10,
    unit: null,
  });
  assertEquals(read("Seed | 1 bag | 50 bag"), {
    name: "Seed",
    quantity: 50,
    unit: null,
  });
  assertEquals(read("Piksi | 0.006 kg | 6 kg"), {
    name: "Piksi",
    quantity: 6,
    unit: null,
  });
});
