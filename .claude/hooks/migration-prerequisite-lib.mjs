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
    sqlMarker: /\bmoa1_list\b/i,
  },
};

// Matched on the name after its stamp (a restamped copy is still caught) or on the
// load's own SQL (the same SQL sent under another name is caught too).
export function prerequisiteFor(name, sql = "") {
  const stem = normalizeMigrationName(name).replace(/^\d{14}_/, "");
  return PREREQUISITES[stem] || Object.values(PREREQUISITES).find((p) => p.sqlMarker.test(String(sql))) || null;
}

// The load's own 123 list rows, read from the migration being applied, matched by
// the load's own rule: CAS decides; the name counts only when one side has no CAS
// and exactly one active ingredient has that name.
export function moaMatchCountQuery(sql) {
  const text = String(sql || "");
  const start = text.search(/INSERT INTO moa1_list\s*\([^)]*\)\s*VALUES/i);
  if (start < 0) throw new Error("could not find the load's list (INSERT INTO moa1_list ... VALUES)");
  const valuesAt = text.indexOf("VALUES", start) + "VALUES".length;
  const end = text.indexOf("');", valuesAt);
  if (end < 0) throw new Error("could not find the end of the load's list");
  const values = text.slice(valuesAt, end + 2);
  return (
    `WITH l(name, cas, scheme, group_code, source_note) AS (VALUES ${values}),\n` +
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
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = await res.json();
  } catch (err) {
    return fail(`could not read the live ingredient count (${err?.message || err})`);
  }
  const listed = Number(rows?.[0]?.listed);
  const matched = Number(rows?.[0]?.matched);
  if (!Number.isInteger(listed) || !Number.isInteger(matched)) return fail("the live count came back unreadable");
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
