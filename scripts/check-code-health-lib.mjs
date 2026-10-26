// Pure comparison logic for the code-health ratchet (scripts/check-code-health.mjs).
// Kept free of ESLint and Knip so the ratchet rules can be tested directly.

// Limits for app code. Existing violations are grandfathered in the baseline; only
// new ones fail. Raise a limit only with a written reason, never to pass one change.
export const SIZE_RULES = {
  'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
  complexity: ['error', 20],
  'max-depth': ['error', 4],
  'max-params': ['error', 5],
  'max-nested-callbacks': ['error', 4],
};

// Tests may be long and repetitive, and the two type catalogs are one long list by design.
const SKIPPED_FILE = /\.test\.[jt]sx?$|^src\/tests\/|^src\/types\/(?:supabase|index)\.ts$/;

export function relativePath(root, file) {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  return file.replace(/\\/g, '/').replace(`${normalizedRoot}/`, '');
}

export function isCheckedSourceFile(relative) {
  return relative.startsWith('src/') && !SKIPPED_FILE.test(relative);
}

// Keyed by rule AND the function ESLint names ("complexity Function 'QuoteBuilder'"), so fixing
// one grandfathered function cannot make room for a different new one in the same file.
export function findingKey(message) {
  const subject = message.message?.match(/^(.+?) has /)?.[1];
  return subject ? `${message.ruleId} ${subject}` : message.ruleId;
}

// ESLint results -> { file: { findingKey: count } }
export function summarizeSizeResults(root, results) {
  const size = {};
  for (const result of results) {
    const file = relativePath(root, result.filePath);
    if (!isCheckedSourceFile(file)) continue;
    for (const message of result.messages) {
      if (message.fatal) throw new Error(`${file}: ESLint could not parse the file: ${message.message}`);
      if (!(message.ruleId in SIZE_RULES)) continue;
      const key = findingKey(message);
      size[file] ??= {};
      size[file][key] = (size[file][key] || 0) + 1;
    }
  }
  return sortKeys(size);
}

// Knip JSON report -> { file: ["export:name", "type:name", ...] }
export function summarizeUnusedResults(report) {
  if (!report || !Array.isArray(report.issues)) throw new Error('Knip returned no issues list');
  const unused = {};
  const add = (file, item) => {
    unused[file] ??= [];
    if (!unused[file].includes(item)) unused[file].push(item);
  };
  for (const file of report.files || []) add(file.replace(/\\/g, '/'), 'file');
  for (const issue of report.issues) {
    const file = issue.file.replace(/\\/g, '/');
    for (const kind of ['files', 'exports', 'types', 'duplicates']) {
      for (const item of Object.values(issue[kind] || {})) {
        if (kind === 'files') add(file, 'file');
        else add(file, `${kind.replace(/s$/, '')}:${itemName(item)}`);
      }
    }
  }
  for (const file of Object.keys(unused)) unused[file].sort();
  return sortKeys(unused);
}

function itemName(item) {
  if (Array.isArray(item)) return item.map(itemName).join('|');
  return item?.name ?? String(item);
}

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

// Anything in current that the baseline does not already allow is a regression.
export function findRegressions(baseline, current) {
  const regressions = [];
  for (const [file, findings] of Object.entries(current.size)) {
    for (const [key, count] of Object.entries(findings)) {
      const allowed = baseline.size?.[file]?.[key] || 0;
      if (count > allowed) regressions.push(`${file}: ${key} — ${count} found, baseline allows ${allowed}`);
    }
  }
  for (const [file, items] of Object.entries(current.unused)) {
    const allowed = new Set(baseline.unused?.[file] || []);
    for (const item of items) {
      if (!allowed.has(item)) regressions.push(`${file}: unused ${item}`);
    }
  }
  return regressions;
}

// Baseline entries the code no longer has: the baseline can shrink by that much.
export function findImprovements(baseline, current) {
  const improvements = [];
  for (const [file, findings] of Object.entries(baseline.size || {})) {
    for (const [key, allowed] of Object.entries(findings)) {
      const count = current.size[file]?.[key] || 0;
      if (count < allowed) improvements.push(`${file}: ${key} ${allowed} -> ${count}`);
    }
  }
  for (const [file, items] of Object.entries(baseline.unused || {})) {
    const present = new Set(current.unused[file] || []);
    for (const item of items) {
      if (!present.has(item)) improvements.push(`${file}: unused ${item} is gone`);
    }
  }
  return improvements;
}
