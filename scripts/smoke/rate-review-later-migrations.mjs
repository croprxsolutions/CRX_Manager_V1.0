// Decides whether a migration that sorts after RT-3 (and is not replayed by its prover) leaves alone what the
// proof covers. Fail closed: every code mention of a covered name must be a plain call to one of the two parent
// helpers (READ_ONLY_CALLS), and every string mention must be a bare name in a to_regprocedure()/to_regclass()
// IS [NOT] NULL check or a ('name', '<md5>') pin row. Anything else (CREATE/ALTER/DROP/GRANT/REVOKE/COMMENT, a
// trigger, INSERT/UPDATE/DELETE/SELECT on a covered table, a dynamic EXECUTE whose text says product/rate/review or
// uses ||, a U& escape, standard_conforming_strings) is refused.
// shortcut: a dynamic EXECUTE whose command comes from a variable or a computed expression (decode, convert_from)
// is not judged (Mason accepted this limit, 2026-11-17, after three Luna rounds); the threat is an accidental overlap in our own reviewed migrations, not a hidden one. Sol still reads every migration.
export const TOUCHED = /(product_rate|_product_parent_require_admin|_product_parent_replay|product_parent_rate_outcomes|rate_review)/i;

const READ_ONLY_CALLS = new Set(['_product_parent_require_admin', '_product_parent_replay']);
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
      // E'...' strings take backslash escapes; decoded so an escaped covered name is still seen.
      const esc = /^e$/i.test(out.at(-1)?.word ?? '') && /e/i.test(sql[i - 1]);
      if (esc) out.pop();
      let v = ''; i += 1;
      while (i < sql.length) {
        if (esc && sql[i] === '\\') { v += sql.slice(i, i + 2); i += 2; } else if (sql[i] === "'" && sql[i + 1] === "'") { v += "'"; i += 2; } else if (sql[i] === "'") { i += 1; break; } else { v += sql[i]; i += 1; }
      }
      out.push({ str: esc ? unescape(v) : v }); continue;
    }
    // Dollar-quote markers are dropped: function and DO bodies are checked as code.
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
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
function unescape(v) {
  return v.replace(/\\(x[0-9a-f]{1,2}|u[0-9a-f]{4}|U[0-9a-f]{8}|[0-7]{1,3}|.)/gi, (_, e) => {
    if (/^[0-7]+$/.test(e)) return String.fromCodePoint(parseInt(e, 8));
    if (/^[xuU][0-9a-f]+$/i.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 16));
    return { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e] ?? e;
  });
}
const text = (t) => (t ? (t.word ?? t.p ?? `'${t.str}'`).toLowerCase() : '');

/** Returns null when `sql` only calls or names the covered helpers read-only, else why it is refused. */
export function rateReviewTouch(sql) {
  const ts = tokens(sql);
  for (const [i, t] of ts.entries()) {
    if (/^u$/i.test(t.word ?? '') && text(ts[i + 1]) === '&') return 'a U& escape could hide a covered name';
    if (/standard_conforming_strings/i.test(t.word ?? t.str ?? '')) return 'standard_conforming_strings changes how strings decode';
    if (/^execute$/i.test(t.word ?? '') && !['function', 'procedure', 'on'].includes(text(ts[i + 1]))) {
      let joined = ''; // all its literals joined, so adjacent or split pieces are still seen
      for (let j = i + 1; j < ts.length && text(ts[j]) !== ';'; j += 1) {
        if (text(ts[j]) === '|' && text(ts[j + 1]) === '|') return 'dynamic EXECUTE builds its command with ||';
        joined += ts[j].str ?? '';
      }
      if (/product|rate|review/i.test(joined)) return 'dynamic EXECUTE text could name a covered object';
    }
    if (t.word !== undefined && TOUCHED.test(t.word)) {
      let p = i - 1;
      if (text(ts[p]) === '.' && text(ts[p - 1]) === 'public') p -= 2;
      if (READ_ONLY_CALLS.has(t.word.toLowerCase()) && text(ts[i + 1]) === '(' && CALL_AFTER.has(text(ts[p]))) continue;
      return `${text(ts[p])} ${t.word}${text(ts[i + 1])} is not a plain call to a parent helper`;
    }
    if (t.str !== undefined && TOUCHED.test(t.str)) {
      const lookup = text(ts[i - 1]) === '(' && LOOKUP_FN.has(text(ts[i - 2])) && text(ts[i + 1]) === ')' && text(ts[i + 2]) === 'is';
      const pin = text(ts[i - 1]) === '(' && text(ts[i + 1]) === ',' && /^[0-9a-f]{32}$/.test(ts[i + 2]?.str ?? '') && text(ts[i + 3]) === ')';
      if (BARE_NAME.test(t.str) && (lookup || pin)) continue;
      return `string '${t.str}' is not a lookup or md5 pin`;
    }
  }
  return null;
}
