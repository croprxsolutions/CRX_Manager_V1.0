// Decides whether a migration that sorts after RT-3 (and is not replayed by its prover) leaves alone what the
// proof covers. Fail closed: every code mention of a covered name must be a plain call, and every string mention
// must be a bare name inside to_regprocedure()/to_regclass() or a ('name', '<md5>') pin row. Anything else
// (CREATE/ALTER/DROP/GRANT/REVOKE/COMMENT, a trigger, INSERT/UPDATE/DELETE/SELECT on a covered table, dynamic SQL
// naming one) is refused.
export const TOUCHED = /(product_rate|_product_parent_require_admin|_product_parent_replay|product_parent_rate_outcomes|rate_review)/i;

const CALL_AFTER = new Set([':=', '=', '(', 'perform', 'select']);
const LOOKUP_FN = new Set(['to_regprocedure', 'to_regproc', 'to_regclass']);
const BARE_NAME = /^(public\.)?[a-z0-9_]+(\([a-z0-9_ ,[\]]*\))?$/i;

function tokens(sql) {
  const out = [];
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (sql.startsWith('--', i)) { const e = sql.indexOf('\n', i); i = e < 0 ? sql.length : e; continue; }
    if (sql.startsWith('/*', i)) { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; continue; }
    if (c === "'") {
      let v = ''; i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { v += "'"; i += 2; } else if (sql[i] === "'") { i += 1; break; } else { v += sql[i]; i += 1; }
      }
      out.push({ str: v }); continue;
    }
    // Dollar-quote markers are dropped: function and DO bodies are checked as code.
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
    if (dollar) { i += dollar[0].length; continue; }
    if (c === '"') { const e = sql.indexOf('"', i + 1); out.push({ word: sql.slice(i + 1, e < 0 ? sql.length : e) }); i = e < 0 ? sql.length : e + 1; continue; }
    const word = /^[A-Za-z0-9_]+/.exec(sql.slice(i, i + 256));
    if (word) { out.push({ word: word[0] }); i += word[0].length; continue; }
    if (sql.startsWith(':=', i)) { out.push({ p: ':=' }); i += 2; continue; }
    if (!/\s/.test(c)) out.push({ p: c });
    i += 1;
  }
  return out;
}
const text = (t) => (t ? (t.word ?? t.p ?? `'${t.str}'`).toLowerCase() : '');

/** Returns null when `sql` only calls or names the covered helpers read-only, else why it is refused. */
export function rateReviewTouch(sql) {
  const ts = tokens(sql);
  for (const [i, t] of ts.entries()) {
    if (t.word !== undefined && TOUCHED.test(t.word)) {
      let p = i - 1;
      if (text(ts[p]) === '.' && text(ts[p - 1]) === 'public') p -= 2;
      if (text(ts[i + 1]) === '(' && CALL_AFTER.has(text(ts[p]))) continue;
      return `${text(ts[p])} ${t.word}${text(ts[i + 1])} is not a plain call`;
    }
    if (t.str !== undefined && TOUCHED.test(t.str)) {
      const lookup = text(ts[i - 1]) === '(' && LOOKUP_FN.has(text(ts[i - 2]));
      const pin = text(ts[i - 1]) === '(' && text(ts[i + 1]) === ',' && /^[0-9a-f]{32}$/.test(ts[i + 2]?.str ?? '') && text(ts[i + 3]) === ')';
      if (BARE_NAME.test(t.str) && (lookup || pin)) continue;
      return `string '${t.str}' is not a lookup or md5 pin`;
    }
  }
  return null;
}
