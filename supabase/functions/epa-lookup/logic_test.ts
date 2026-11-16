import {
  classifyRegistrationNumber,
  confirmedDistributorListing,
  distributorBaseRegistration,
  needsDistributorBaseLookup,
  normalizeDistributorBasePayload,
  normalizeEpaPayload,
  normalizeSignalWord,
  isRecordRefusal,
  LOOKUP_ID_PATTERN,
  planRecordedLookup,
  recordIdempotencyKey,
} from "./logic.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      message ?? `Expected ${expectedJson}, received ${actualJson}`,
    );
  }
}

Deno.test("classifier accepts basic Section 3 registrations", () => {
  assertEquals(classifyRegistrationNumber(" 264-849 "), {
    kind: "section3",
    supported: true,
    normalized: "264-849",
  });
});

Deno.test("classifier accepts distributor sub-registrations", () => {
  assertEquals(classifyRegistrationNumber("264-849-12345"), {
    kind: "distributor",
    supported: true,
    normalized: "264-849-12345",
  });
});

Deno.test("classifier recognizes SLN and 24(c) registrations as unsupported", () => {
  for (
    const input of [
      "NC950034",
      "AL-98-0001",
      "EPA SLN No. NC950034",
      "24(c) NC950034",
    ]
  ) {
    assertEquals(classifyRegistrationNumber(input), {
      kind: "sln_24c",
      supported: false,
    });
  }
});

Deno.test("classifier recognizes Section 18 inputs as unsupported", () => {
  for (
    const input of [
      "Section 18",
      "FIFRA Section 18 emergency use",
      "Emergency Exemption",
    ]
  ) {
    assertEquals(classifyRegistrationNumber(input), {
      kind: "section18",
      supported: false,
    });
  }
});

Deno.test("classifier rejects malformed and URL-like inputs", () => {
  for (
    const input of [
      "",
      "264",
      "0264-849",
      "264-0849",
      "264-849-123-4",
      "264-849/path",
      "264-849?host=evil.example",
      "https://evil.example/264-849",
      null,
    ]
  ) {
    assertEquals(classifyRegistrationNumber(input), {
      kind: "malformed",
      supported: false,
    });
  }
});

Deno.test("signal-word normalizer case-normalizes accepted values", () => {
  assertEquals(normalizeSignalWord(" danger "), {
    canonical: "Danger",
    needsManual: false,
  });
  assertEquals(normalizeSignalWord("WARNING"), {
    canonical: "Warning",
    needsManual: false,
  });
  assertEquals(normalizeSignalWord("cAuTiOn"), {
    canonical: "Caution",
    needsManual: false,
  });
});

Deno.test("signal-word normalizer maps No Signal Word to null", () => {
  assertEquals(normalizeSignalWord(" No   Signal Word "), {
    canonical: null,
    needsManual: false,
  });
});

Deno.test("signal-word normalizer never passes through unknown values", () => {
  assertEquals(normalizeSignalWord("Highly Toxic"), {
    canonical: null,
    needsManual: true,
  });
  assertEquals(normalizeSignalWord(null), {
    canonical: null,
    needsManual: true,
  });
});

Deno.test("EPA payload normalizer returns the Stage 1 response shape", () => {
  const result = normalizeEpaPayload(
    {
      items: [{
        eparegno: "264-849",
        productname: "ABSOLUTE 500 SC FUNGICIDE",
        signal_word: "caution",
        product_status: "Active",
        cancel_flag: "No",
        rup_yn: "Yes",
        companyinfo: [{ name: "BAYER CROPSCIENCE, LLC" }],
        active_ingredients: [{
          active_ing: "Tebuconazole",
          active_ing_percent: 22.63,
          pc_code: "128997",
          cas_number: "107534-96-3",
        }],
        pdffiles: [
          {
            pdffile: "000264-00849-20240124.pdf",
            pdffile_accepted_date: "January 24, 2024",
          },
          {
            pdffile: "000264-00849-20251212.pdf",
            pdffile_accepted_date: "December 12, 2025",
          },
          {
            pdffile: "https://evil.example/label.pdf",
            pdffile_accepted_date: "January 1, 2026",
          },
        ],
      }],
    },
    "section3",
    "264-849",
  );

  assertEquals(result, {
    found: true,
    regType: "section3",
    eparegno: "264-849",
    productname: "ABSOLUTE 500 SC FUNGICIDE",
    signalWordCanonical: "Caution",
    needsManual: false,
    manufacturer: "BAYER CROPSCIENCE, LLC",
    rupYn: "Yes",
    productStatus: "Active",
    isCancelled: false,
    activeIngredients: [{
      name: "Tebuconazole",
      percent: 22.63,
      pcCode: "128997",
      casNumber: "107534-96-3",
    }],
    latestLabelPdfUrl:
      "https://www3.epa.gov/pesticides/chem_search/ppls/000264-00849-20251212.pdf",
    labelPdfs: [
      {
        fileName: "000264-00849-20251212.pdf",
        acceptedDate: "December 12, 2025",
        url:
          "https://www3.epa.gov/pesticides/chem_search/ppls/000264-00849-20251212.pdf",
      },
      {
        fileName: "000264-00849-20240124.pdf",
        acceptedDate: "January 24, 2024",
        url:
          "https://www3.epa.gov/pesticides/chem_search/ppls/000264-00849-20240124.pdf",
      },
    ],
    transferredTo: null,
  });
});

Deno.test("EPA payload normalizer returns found false for an empty EPA result", () => {
  const result = normalizeEpaPayload(
    { items: [] },
    "distributor",
    "264-849-12345",
  );
  assertEquals(result.found, false);
  assertEquals(result.regType, "distributor");
  assertEquals(result.activeIngredients, []);
  assertEquals(result.labelPdfs, []);
});

Deno.test("EPA payload normalizer flags unrecognized signal words for manual review", () => {
  const result = normalizeEpaPayload(
    {
      items: [{
        eparegno: "264-849",
        signal_word: "Unrecognized EPA value",
      }],
    },
    "section3",
    "264-849",
  );
  assertEquals(result.signalWordCanonical, null);
  assertEquals(result.needsManual, true);
});

// Shape copied from the live EPA PPLS answer for 524-475 on 2026-11-08.
const MOVED_PAYLOAD = {
  items: [{
    eparegno: "105211-77",
    productname: "ROUNDUP ULTRA HERBICIDE",
    product_status: "Active",
    cancel_flag: "No",
    signal_word: "Caution",
    transfer_history: [
      {
        previous_eparegno: "524-475",
        previous_company: "BAYER CROPSCIENCE, LLC",
        transferred_date: "January 14, 2026",
      },
      {
        previous_eparegno: "105211-18",
        previous_company: "RUVEON, LLC",
        transferred_date: "January 22, 2026",
      },
    ],
  }],
};

Deno.test("EPA payload normalizer reports a moved registration with its new number", () => {
  const result = normalizeEpaPayload(MOVED_PAYLOAD, "section3", "524-475");
  // found:false keeps screens without transferredTo from applying the new record.
  assertEquals(result.found, false);
  assertEquals(result.eparegno, "105211-77");
  assertEquals(result.transferredTo, "105211-77");
  assertEquals(result.productname, "ROUNDUP ULTRA HERBICIDE");
  assertEquals(result.signalWordCanonical, "Caution");
});

Deno.test("EPA payload normalizer does not mark the current number as moved", () => {
  const result = normalizeEpaPayload(MOVED_PAYLOAD, "section3", "105211-77");
  assertEquals(result.found, true);
  assertEquals(result.eparegno, "105211-77");
  assertEquals(result.transferredTo, null);
});

Deno.test("EPA payload normalizer still rejects an unrelated registration", () => {
  let message = "";
  try {
    normalizeEpaPayload(MOVED_PAYLOAD, "section3", "264-849");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message, "EPA response registration did not match the request");
});

Deno.test("EPA payload normalizer rejects a move to a malformed number", () => {
  let message = "";
  try {
    normalizeEpaPayload(
      {
        items: [{
          eparegno: "https://evil.example/1",
          transfer_history: [{ previous_eparegno: "524-475" }],
        }],
      },
      "section3",
      "524-475",
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message, "EPA response registration did not match the request");
});

Deno.test("distributor base is the first two parts", () => {
  assertEquals(distributorBaseRegistration("62719-671-55467"), "62719-671");
});

// Shape copied from EPA's regnum search for 62719-671-5546 on 2026-11-08 (partial match).
const VOLLEY_SEARCH = {
  items: [{
    eparegno: "62719-671-55467",
    productname: "VOLLEY ATZ NXT ",
    product_name_status: "Active",
    product_status: "Active",
  }],
};
const VOLLEY_LISTING = { productname: "VOLLEY ATZ NXT", productStatus: "Active" };

Deno.test("distributor search confirms only an exact listing", () => {
  assertEquals(
    confirmedDistributorListing(VOLLEY_SEARCH, "62719-671-55467"),
    VOLLEY_LISTING,
  );
  // A partial-match hit for another number never confirms a made-up number.
  assertEquals(confirmedDistributorListing(VOLLEY_SEARCH, "62719-671-5546"), null);
  assertEquals(confirmedDistributorListing({ items: [] }, "62719-671-999999"), null);
  let message = "";
  try {
    confirmedDistributorListing({ nope: true }, "62719-671-55467");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message, "EPA search response did not contain an items array");
});

Deno.test("confirmed distributor takes label facts from the base and name from its listing", () => {
  const result = normalizeDistributorBasePayload(
    {
      items: [{
        eparegno: "62719-671",
        productname: "KEYSTONE NXT",
        product_status: "Active",
        rup_yn: "Yes",
        signal_word: "Warning",
      }],
    },
    "62719-671-55467",
    VOLLEY_LISTING,
  );
  assertEquals(result.found, true);
  assertEquals(result.regType, "distributor");
  assertEquals(result.eparegno, "62719-671-55467");
  assertEquals(result.productname, "VOLLEY ATZ NXT");
  assertEquals(result.rupYn, "Yes");
  assertEquals(result.signalWordCanonical, "Warning");
  assertEquals(result.transferredTo, null);
});

Deno.test("a cancelled distributor listing is reported cancelled even on an active base", () => {
  const result = normalizeDistributorBasePayload(
    { items: [{ eparegno: "62719-671", product_status: "Active" }] },
    "62719-671-55467",
    { productname: "VOLLEY ATZ NXT", productStatus: "Cancelled" },
  );
  assertEquals(result.isCancelled, true);
  assertEquals(result.productStatus, "Cancelled");
});

Deno.test("confirmed distributor stays not found when the base is missing", () => {
  const result = normalizeDistributorBasePayload(
    { items: [] },
    "62719-671-55467",
    VOLLEY_LISTING,
  );
  assertEquals(result.found, false);
  assertEquals(result.regType, "distributor");
  assertEquals(result.eparegno, null);
});

Deno.test("a moved base lends the distributor neither its new number nor its label facts", () => {
  const result = normalizeDistributorBasePayload(
    MOVED_PAYLOAD,
    "524-475-12345",
    { productname: "SOME DISTRIBUTOR BRAND", productStatus: "Active" },
  );
  assertEquals(result.found, false);
  assertEquals(result.eparegno, null);
  assertEquals(result.transferredTo, null);
  assertEquals(result.signalWordCanonical, null);
  assertEquals(result.rupYn, null);
});

Deno.test("a distributor number missing from a non-empty lookup still goes on to the search", () => {
  const result = normalizeEpaPayload(
    { items: [{ eparegno: "62719-671", product_status: "Active" }] },
    "distributor",
    "62719-671-55467",
  );
  assertEquals(result.found, false);
  assertEquals(result.eparegno, null);
  assertEquals(needsDistributorBaseLookup(result), true);
});

Deno.test("only an unlisted, unmoved distributor number falls back to its base", () => {
  const empty = normalizeEpaPayload({ items: [] }, "distributor", "62719-671-55467");
  assertEquals(needsDistributorBaseLookup(empty), true);
  assertEquals(
    needsDistributorBaseLookup(
      normalizeEpaPayload({ items: [] }, "section3", "62719-671"),
    ),
    false,
  );
  const movedDistributor = normalizeEpaPayload(
    {
      items: [{
        eparegno: "62719-671-55468",
        transfer_history: [{ previous_eparegno: "62719-671-55467" }],
      }],
    },
    "distributor",
    "62719-671-55467",
  );
  assertEquals(movedDistributor.transferredTo, "62719-671-55468");
  assertEquals(needsDistributorBaseLookup(movedDistributor), false);
  assertEquals(
    needsDistributorBaseLookup(
      normalizeEpaPayload(MOVED_PAYLOAD, "section3", "105211-77"),
    ),
    false,
  );
});

Deno.test("a move wins when EPA lists the old record next to its replacement", () => {
  const result = normalizeEpaPayload(
    { items: [{ eparegno: "524-475", productname: "OLD" }, ...MOVED_PAYLOAD.items] },
    "section3",
    "524-475",
  );
  assertEquals(result.found, false);
  assertEquals(result.transferredTo, "105211-77");
});

const ADMIN = "11111111-1111-4111-8111-111111111111";
const OTHER_ADMIN = "22222222-2222-4222-8222-222222222222";

Deno.test("record mode asks EPA only about the stored number, and only for the admin who started it", () => {
  const lookup = { epa_registration: "100-1234", status: "pending", requested_by: ADMIN, requested_at: new Date().toISOString() };
  assertEquals(planRecordedLookup(lookup, ADMIN), { action: "fetch", regNumber: "100-1234" });
  assertEquals(planRecordedLookup(lookup, OTHER_ADMIN).action, "refuse");
  assertEquals((planRecordedLookup(lookup, OTHER_ADMIN) as { status: number }).status, 403);
  assertEquals((planRecordedLookup(null, ADMIN) as { status: number }).status, 404);
});

Deno.test("record mode refuses a pending lookup the database would call expired, without asking EPA", () => {
  const startedAt = Date.parse("2026-11-12T15:00:00Z");
  const lookup = { epa_registration: "100-1234", status: "pending", requested_by: ADMIN, requested_at: "2026-11-12T15:00:00Z" };
  assertEquals(planRecordedLookup(lookup, ADMIN, startedAt + 29 * 60_000).action, "fetch");
  const expired = planRecordedLookup(lookup, ADMIN, startedAt + 30 * 60_000) as { action: string; status: number; error: string };
  assertEquals([expired.action, expired.status], ["refuse", 409]);
  assertEquals(expired.error.startsWith("EPA_LOOKUP_EXPIRED:"), true);
});

Deno.test("record mode replays a recorded lookup and refuses an abandoned one", () => {
  assertEquals(
    planRecordedLookup({ epa_registration: "100-1234", status: "recorded", requested_by: ADMIN, requested_at: new Date().toISOString() }, ADMIN),
    { action: "replay" },
  );
  // Ownership is checked before the replay: another admin never reads someone else's saved answer.
  assertEquals(
    planRecordedLookup({ epa_registration: "100-1234", status: "recorded", requested_by: ADMIN, requested_at: new Date().toISOString() }, OTHER_ADMIN).action,
    "refuse",
  );
  const abandoned = planRecordedLookup(
    { epa_registration: "100-1234", status: "abandoned", requested_by: ADMIN, requested_at: new Date().toISOString() },
    ADMIN,
  );
  assertEquals((abandoned as { status: number }).status, 409);
});

Deno.test("record mode keys, IDs and refusals", () => {
  assertEquals(recordIdempotencyKey("ABCDEF00-1111-4111-8111-111111111111"), "epa-record:abcdef00-1111-4111-8111-111111111111");
  assertEquals(LOOKUP_ID_PATTERN.test(ADMIN), true);
  assertEquals(LOOKUP_ID_PATTERN.test("100-1234"), false);
  assertEquals(LOOKUP_ID_PATTERN.test(`${ADMIN}x`), false);
  assertEquals(isRecordRefusal("EPA_LOOKUP_EXPIRED: this lookup is more than 30 minutes old; start a new one"), true);
  assertEquals(isRecordRefusal("IDEMPOTENCY_PAYLOAD_MISMATCH"), true);
  assertEquals(isRecordRefusal("permission denied for function record_epa_lookup"), false);
  assertEquals(isRecordRefusal(undefined), false);
});
