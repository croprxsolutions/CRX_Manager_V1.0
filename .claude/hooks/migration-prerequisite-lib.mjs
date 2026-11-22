// Live prerequisites a migration needs before it may be applied (#2193).
//
// The modes-of-action load (20270205150000_ingredient_modes_of_action_load) is a
// one-time seed: it gives resistance groups only to the active ingredients that
// exist when it runs, and ingredients added later never get theirs from it. The
// ingredients come from the separate live EPA batch fill, so that fill must run
// first. Mason (2026-11-22) chose a hard block over a written release step alone:
// the live-apply tooling counts how many of the load's 123 list rows match an
// active ingredient in the app (the load's own matching rule) and refuses below
// the threshold, showing the count. No database change.
//
// Doors: scripts/apply-migration-file.mjs runs checkLivePrerequisite right before
// it transmits (fails closed). The MCP apply_migration door cannot read the live
// count from inside its hook, so evaluateMigrationApply refuses these migrations
// there outright and points at the script.

import { normalizeMigrationName } from "./migration-ordering-lib.mjs";

const MOA_LIST_ROWS = 123;
const PREREQUISITE_READ_TIMEOUT_MS = 10_000;
// Threshold: at least 90 of the 123 list rows (73%) must match an active
// ingredient. Measured on live 2026-11-22, after the 2026-11-21 EPA batch fill:
// 99 of 123 match. Before the fill the app had few ingredients, so the count sits
// far below 90. Some list rows are salts/esters or chemicals CRX does not stock, so
// 123 of 123 is not expected; 90 leaves room for a few ingredients being retired.
// Change it only with Mason (DECISION_LOG, 2026-11-22).
export const MOA_MIN_MATCHED = 90;

const PREREQUISITES = {
  ingredient_modes_of_action_load: {
    what: "the live EPA batch fill",
    minMatched: MOA_MIN_MATCHED,
    query: moaMatchCountQuery,
    // The load's own list table: catches its SQL sent under any other name (Luna MED).
    sqlMarker: /CREATE\s+TEMP(?:ORARY)?\s+TABLE\s+"?moa1_list\b/i,
  },
};

// Matched on the name after its stamp (a restamped copy is still caught) or on the
// load's own SQL (the same SQL sent under another name is caught too).
export function prerequisiteFor(name, sql = "") {
  const stem = normalizeMigrationName(name).replace(/^\d{14}_/, "");
  return (Object.hasOwn(PREREQUISITES, stem) && PREREQUISITES[stem]) || Object.values(PREREQUISITES).find((p) => p.sqlMarker.test(String(sql))) || null;
}

// Reads the load's list as DATA: exactly one `INSERT INTO moa1_list (...) VALUES`,
// whose rows are 5 plain string literals (or NULL) each. Anything else (an
// expression, a function call, a second list) fails closed, so no SQL from the
// migration is ever sent to live (Sol BLOCKER, round 2).
const MOA_LIST_COLUMNS = "name,cas,scheme,group_code,source_note";
export function parseMoaList(sql) {
  const text = String(sql || "");
  const heads = [...text.matchAll(/INSERT\s+INTO\s+moa1_list\s*\(([^)]*)\)\s*VALUES/gi)];
  if (heads.length !== 1) throw new Error(`expected exactly one INSERT INTO moa1_list ... VALUES, found ${heads.length}`);
  if (heads[0][1].replace(/\s+/g, "").toLowerCase() !== MOA_LIST_COLUMNS) throw new Error("the load's list has unexpected columns");
  let i = heads[0].index + heads[0][0].length;
  const ws = () => { while (/\s/.test(text[i] || "")) i += 1; };
  const expect = (ch) => { ws(); if (text[i] !== ch) throw new Error(`the load's list is not plain literals (expected "${ch}" at ${i})`); i += 1; };
  const literal = () => {
    ws();
    if (/^NULL\b/i.test(text.slice(i, i + 5))) { i += 4; return null; }
    if (text[i] !== "'") throw new Error(`the load's list is not plain literals (at ${i})`);
    let v = "";
    for (i += 1; ; i += 1) {
      if (i >= text.length) throw new Error("the load's list has an unterminated string");
      if (text[i] === "'") { if (text[i + 1] === "'") { v += "'"; i += 1; continue; } i += 1; return v; }
      v += text[i];
    }
  };
  const rows = [];
  for (;;) {
    expect("(");
    const row = [literal()];
    for (let c = 1; c < 5; c += 1) { expect(","); row.push(literal()); }
    expect(")");
    rows.push({ name: row[0], cas: row[1] });
    ws();
    if (text[i] === ",") { i += 1; continue; }
    if (text[i] === ";") return rows;
    throw new Error(`the load's list is not plain literals (at ${i})`);
  }
}

// The load's own list rows, matched by the load's own rule: CAS decides; the name
// counts only when one side has no CAS and exactly one active ingredient has that
// name. Only the parsed names and CAS numbers are sent, as one escaped JSON literal.
export function moaMatchCountQuery(sql) {
  const json = JSON.stringify(parseMoaList(sql)).replace(/'/g, "''");
  return (
    `WITH l AS (SELECT * FROM jsonb_to_recordset('${json}'::jsonb) AS x(name text, cas text)),\n` +
    `ing AS (SELECT a.name_key, NULLIF(btrim(a.cas), '') AS cas,\n` +
    `              count(*) OVER (PARTITION BY a.name_key) = 1 AS name_unique\n` +
    `          FROM public.active_ingredients a WHERE a.status = 'active')\n` +
    `SELECT count(*)::int AS listed,\n` +
    `       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ing i\n` +
    `         WHERE (l.cas IS NOT NULL AND i.cas = l.cas)\n` +
    `            OR (i.name_key = lower(regexp_replace(btrim(l.name), '\\s+', ' ', 'g'))\n` +
    `                AND (l.cas IS NULL OR i.cas IS NULL) AND i.name_unique)))::int AS matched\n` +
    `  FROM l;`
  );
}

/** Refusal text for the MCP door, or null when the migration has no live prerequisite. */
export function mcpPrerequisiteRefusal(name, sql = "") {
  const p = prerequisiteFor(name, sql);
  if (!p) return null;
  return (
    `MIGRATION PREREQUISITE (#2193): ${normalizeMigrationName(name)} may only be applied after ${p.what} ` +
    `(at least ${p.minMatched} of its ${MOA_LIST_ROWS} list rows must match an active ingredient). ` +
    `This door cannot read that count. Apply it with scripts/apply-migration-file.mjs, which checks the live count first.`
  );
}

/**
 * Read the live count and judge it. Returns { ok: true, skipped: true } for a
 * migration with no prerequisite; otherwise { ok, matched, listed, reason }.
 * Fails closed on any read or shape problem.
 */
export async function checkLivePrerequisite({ fetchImpl, projectId, token, name, sql }) {
  const p = prerequisiteFor(name, sql);
  if (!p) return { ok: true, skipped: true };
  const fail = (why) => ({ ok: false, reason: `MIGRATION PREREQUISITE CHECK FAILED (#2193): ${why}. Refusing to transmit.` });
  let query;
  try { query = p.query(sql); } catch (err) { return fail(err?.message || String(err)); }
  let rows;
  try {
    const res = await fetchImpl(`https://api.supabase.com/v1/projects/${projectId}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      // Bounded, so a slow read cannot stretch the apply past its other checks (Sol MED).
      signal: AbortSignal.timeout(PREREQUISITE_READ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = await res.json();
  } catch (err) {
    return fail(`could not read the live ingredient count (${err?.message || err})`);
  }
  if (!Array.isArray(rows) || rows.length !== 1) return fail("the live count came back unreadable");
  const listed = rows?.[0]?.listed;
  const matched = rows?.[0]?.matched;
  if (!Number.isInteger(listed) || !Number.isInteger(matched) || matched < 0 || matched > listed) {
    return fail("the live count came back unreadable");
  }
  if (listed !== MOA_LIST_ROWS) return fail(`expected ${MOA_LIST_ROWS} list rows in the migration, found ${listed}`);
  if (matched < p.minMatched) {
    return {
      ok: false, matched, listed,
      reason:
        `MIGRATION PREREQUISITE NOT MET (#2193): only ${matched} of the load's ${listed} list rows match an active ingredient ` +
        `on live; at least ${p.minMatched} are needed. Run ${p.what} first, then apply again. Refusing to transmit.`,
    };
  }
  return { ok: true, matched, listed };
}
