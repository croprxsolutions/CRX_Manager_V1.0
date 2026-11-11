// Applies new migrations to a target database the same way they reach live today: one transaction
// per file holding the file byte for byte plus its supabase_migrations.schema_migrations row
// (version = UTC apply time, name = file name without .sql, statements = [file text]), then a
// read-only check that sha256(statements[1]) equals the file. Replaces local-supabase/catchup-staging.sh.
// Tested in db-apply.test.mjs; called by .github/workflows/db-apply.yml.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIVE_REF = 'rhyzpcqhnizqbxphqdkr';
const METAHIVE_REF = 'dyxaxsjrqprvxzxkfooi';
// <14-digit stamp>_<lower_snake>. Existing files only need this shape: three applied ones carry
// impossible times (20261022086000 = 08:60). New files must also have a real date and time (below).
const NAME = /^(\d{14})_[a-z0-9_]+$/;
const REAL_STAMP = /^20[2-9]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/;
// A real calendar day too: 20260231 (31 February) has the right shape but no such date.
export const realStamp = (s) => REAL_STAMP.test(s) && new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8))).getUTCDate() === +s.slice(6, 8);

// Same rule as scripts/list-post-baseline-migrations.mjs, against the target's own ledger: files after
// the baseline high-water whose name the ledger lacks. One-shot data migrations are recorded, never
// run (supabase/baselines/one-shot-migrations.json). A missing ordinary file older than the newest
// applied one would run out of order: it stops the run, unless allowOutOfOrder (staging only, where
// staging-only migrations can sit ahead of main's) lets it apply after a loud warning.
export function planMigrations({ files, highWater, ledgerNames, oneShots, allowOutOfOrder = false }) {
  const newest = [...ledgerNames].map((n) => NAME.exec(n)?.[1]).filter(Boolean).sort().at(-1) ?? '';
  const steps = [];
  const outOfOrder = [];
  for (const file of [...files].sort()) {
    const stem = file.replace(/\.sql$/, '');
    if (stem.slice(0, 14) <= highWater || ledgerNames.has(stem)) continue;
    if (oneShots.has(stem)) steps.push({ stem, run: false });
    else if (stem.slice(0, 14) < newest) {
      outOfOrder.push(stem);
      if (allowOutOfOrder) steps.push({ stem, run: true });
    } else steps.push({ stem, run: true });
  }
  return { steps, outOfOrder };
}

// A dollar-quote tag that can't occur in the file, so the ledger stores the text unchanged.
export function dollarTag(text) {
  for (;;) {
    const tag = `$crx_${randomBytes(8).toString('hex')}$`;
    if (!text.includes(tag)) return tag;
  }
}

// Inside the one transaction: remember it, run the file, prove it is still the same transaction (a
// file that committed on its own fails loudly), insert the ledger row, and prove the stored text
// hashes to the file's bytes before COMMIT, so a mismatch rolls everything back.
export function wrapperSql({ stem, text, run, sha, tag = dollarTag(text) }) {
  if (!NAME.test(stem)) throw new Error(`bad migration name: ${stem}`);
  if (!/^[0-9a-f]{64}$/.test(sha ?? '')) throw new Error(`bad sha256 for ${stem}`);
  return [
    'BEGIN;',
    "SELECT set_config('crx.apply_tx', txid_current()::text, true);",
    // The file may end without a semicolon or inside a -- comment; close its last statement first.
    ...(run ? [text, ';'] : []),
    `DO $crx_check$ BEGIN IF current_setting('crx.apply_tx', true) IS DISTINCT FROM txid_current()::text THEN RAISE EXCEPTION 'MIGRATION_LEFT_ITS_TRANSACTION: ${stem}'; END IF; END $crx_check$;`,
    `INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS'), '${stem}', ARRAY[${tag}${text}${tag}]);`,
    `DO $crx_check$ BEGIN IF (SELECT encode(sha256(convert_to(statements[1], 'UTF8')), 'hex') FROM supabase_migrations.schema_migrations WHERE name = '${stem}') IS DISTINCT FROM '${sha}' THEN RAISE EXCEPTION 'LEDGER_HASH_MISMATCH: ${stem}'; END IF; END $crx_check$;`,
    'COMMIT;',
    '',
  ].join('\n');
}

// Mason's point 6: a file that can't run inside a transaction (CREATE INDEX CONCURRENTLY) says so on
// its first line; it runs on its own, then its ledger row goes in, with the same hash check.
// ponytail: if such a file fails part-way, what already ran stays; the job stops and says so, and the
// repair is by hand. Keep these files to one statement.
export function isNoTransaction(text) {
  return /^--\s*crx:\s*no-transaction\s*$/i.test(text.split('\n')[0].trimEnd());
}

// What the job refuses to run: a file that isn't plain UTF-8 (the ledger stores text, so the hash
// would not match the bytes), a byte-order mark, its own transaction control (it would commit before
// the ledger row), or a psql backslash command (the live apply path doesn't run those).
// The file with comments, string literals, quoted identifiers and dollar-quoted bodies blanked out,
// so only top-level SQL remains (a COMMIT inside a procedure body doesn't count).
export function sqlSkeleton(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if (rest.startsWith('--')) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      out += ' ';
    } else if (rest.startsWith('/*')) {
      let depth = 0;
      let j = i;
      do {
        if (text.startsWith('/*', j)) { depth++; j += 2; } else if (text.startsWith('*/', j)) { depth--; j += 2; } else j++;
      } while (depth > 0 && j < text.length);
      i = j;
      out += ' ';
    } else if ((m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest))) {
      const end = text.indexOf(m[0], i + m[0].length);
      i = end === -1 ? text.length : end + m[0].length;
      out += ' ';
    } else if (rest[0] === "'" || rest[0] === '"') {
      const q = rest[0];
      const escapes = q === "'" && /[eE]$/.test(text.slice(0, i));
      let j = i + 1;
      for (; j < text.length; j++) {
        if (escapes && text[j] === '\\') { j++; continue; }
        if (text[j] === q) { if (text[j + 1] === q) { j++; continue; } break; }
      }
      i = j + 1;
      out += ' ';
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

const TX_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|ABORT|END|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i;

// forRun = false: the file is only stored (backfill, one-shot record), so only the encoding matters.
export function fileProblems(stem, buf, { forRun = true } = {}) {
  const problems = [];
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) problems.push(`${stem}: starts with a byte-order mark`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return [...problems, `${stem}: is not valid UTF-8`]; }
  if (!forRun) return problems;
  const skeleton = sqlSkeleton(text);
  let atomic = 0; // SQL-standard function bodies: BEGIN ATOMIC ...; END
  for (const statement of skeleton.split(';')) {
    if (/\bBEGIN\s+ATOMIC\b/i.test(statement)) atomic++;
    if (atomic > 0 && /^\s*END\b/i.test(statement)) { atomic--; continue; }
    if (atomic === 0 && TX_CONTROL.test(statement)) problems.push(`${stem}: has its own transaction control (${statement.trim().split(/\s+/).slice(0, 3).join(' ')}); the job wraps each file in one transaction`);
  }
  // A no-transaction file runs outside a transaction: a second statement could fail after the first ran.
  // Session settings before it (SET lock_timeout = ...) change nothing in the database; nothing may follow it.
  if (isNoTransaction(text)) {
    const statements = skeleton.split(';').filter((s) => s.trim());
    const main = statements.findIndex((s) => !/^\s*SET\s/i.test(s));
    if (main < 0 || statements.length > main + 1) problems.push(`${stem}: a "-- crx: no-transaction" file must hold one statement (SET lines only before it)`);
  }
  // psql runs a backslash command anywhere outside quotes (\! runs a shell command), so none at all.
  if (skeleton.includes('\\')) problems.push(`${stem}: has a psql backslash command outside quotes`);
  return problems;
}

// PR check: every new migration has a well-formed name, a stamp no other file shares, and a stamp
// newer than everything already on the base branch (the target applies all of those). onMain: files that
// are already on main, byte for byte (a back-merge into staging); those may be older, since main's own
// check passed them and staging applies them out of order on purpose.
export function stampProblems({ added, base, head, changed = [], onMain = [] }) {
  const stamp = (f) => f.slice(0, 14);
  const baseMax = base.filter((f) => NAME.test(f.replace(/\.sql$/, ''))).map(stamp).sort().at(-1) ?? '';
  const problems = changed.map((f) => `${f}: an existing migration was edited, renamed or deleted; applied migrations never change (add a new one instead)`);
  for (const f of added) {
    if (!NAME.test(f.replace(/\.sql$/, '')) || !realStamp(stamp(f))) { problems.push(`${f}: name must be <14-digit stamp with a real date and time>_<lower_snake>.sql`); continue; }
    if (head.filter((h) => stamp(h) === stamp(f)).length > 1) problems.push(`${f}: shares its stamp with another migration`);
    if (stamp(f) <= baseMax && !onMain.includes(f)) problems.push(`${f}: stamp is not newer than ${baseMax}, the newest migration already on the base branch (npm run next-migration-stamp)`);
  }
  return problems;
}

// Drift between the ledger and the repo, for rows after the baseline: a row with no migration file
// (applied some other way, e.g. the SQL Editor or an unmerged branch), a row whose file changed
// after it ran (stored text's sha256 differs), and a file never applied. stored/files map name ->
// sha256 ('' when the row holds no text yet).
export function ledgerDrift({ stored, files, highWater, oneShots }) {
  const after = (n) => NAME.test(n) && n.slice(0, 14) > highWater;
  const noFile = [...stored.keys()].filter((n) => after(n) && !files.has(n)).sort();
  const changed = [...stored].filter(([n, h]) => h && after(n) && files.has(n) && files.get(n) !== h).map(([n]) => n).sort();
  const notApplied = [...files.keys()].filter((n) => after(n) && !stored.has(n) && !oneShots.has(n)).sort();
  return { noFile, changed, notApplied };
}

// The project a Supabase connection string points at: the pooler user postgres.<ref> on a Supabase
// pooler host, or user postgres on the direct host db.<ref>.supabase.co. Anything else is unknown,
// except a local host with a plain user, which counts as "local" (tests only).
export function urlRef(dbUrl) {
  let u;
  try { u = new URL(dbUrl); } catch { return null; }
  const username = decodeURIComponent(u.username);
  // <role>.<project ref>: postgres for the apply job, crx_drift_ro for the read-only drift and schema checks.
  const poolerUser = /^[a-z_][a-z0-9_]*\.([a-z]{20})$/.exec(username)?.[1];
  if (poolerUser) return /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(u.hostname) ? poolerUser : null;
  const directHost = /^db\.([a-z]{20})\.supabase\.co$/.exec(u.hostname)?.[1];
  if (directHost) return username === 'postgres' ? directHost : null;
  return ['127.0.0.1', 'localhost'].includes(u.hostname) ? 'local' : null;
}

// This job never applies to live (the live half is a separate, approval-gated job) or to MetaHive,
// and only to exactly the expected project.
export function refuseTarget(dbUrl, expectedRef) {
  if (!dbUrl) return 'the database URL is not set';
  if (!expectedRef) return 'TARGET_REF is not set';
  const ref = urlRef(dbUrl);
  if (ref === LIVE_REF || expectedRef === LIVE_REF) return 'that is the live database';
  if (ref === METAHIVE_REF) return 'that is the MetaHive project (another client)';
  if (ref !== expectedRef) return `the database URL is for ${ref ?? 'an unrecognised host'}, not ${expectedRef}`;
  return null;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// The connection goes to psql through libpq environment variables, never the command line, and a
// failure carries only psql's own output, so the password reaches neither the process list nor a log.
function pgEnv(dbUrl) {
  const u = new URL(dbUrl);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)) || 'postgres',
    PGSSLMODE: u.searchParams.get('sslmode') ?? (['127.0.0.1', 'localhost'].includes(u.hostname) ? 'disable' : 'require'),
    PGCLIENTENCODING: 'UTF8', // the files are UTF-8; never let an inherited setting re-encode them
  };
}
function psql(dbUrl, args, input) {
  try {
    return execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
      encoding: 'utf8', input, env: pgEnv(dbUrl), maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = new Error(`psql failed: ${String(e.stderr ?? '').replaceAll(dbUrl, '<db>').trim() || `exit ${e.status}`}`);
    err.stderr = String(e.stderr ?? '').replaceAll(dbUrl, '<db>');
    throw err;
  }
}
const query = (dbUrl, sql) => psql(dbUrl, ['-At', '-c', sql]).split('\n').filter(Boolean);

// Runs one wrapper; retries while the database reports a busy draw-down cutover (as catchup-staging.sh).
// A file run outside a transaction is never retried: part of it may already have taken effect.
function runFile(dbUrl, file, { retry = true } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      psql(dbUrl, ['-f', file]);
      return;
    } catch (e) {
      const msg = `${e.stderr ?? ''}${e.stdout ?? ''}`;
      if (retry && attempt < 5 && msg.includes('NOT_QUIET')) { execFileSync('sleep', ['2']); continue; }
      throw new Error(msg.split('\n').filter((l) => /ERROR|CONTEXT|DETAIL|HINT/.test(l)).join('\n') || e.message);
    }
  }
}

// Applies run only as postgres (objects get the owner and default grants every migration expects).
export function applyUserProblem(dbUrl) {
  let user;
  try { user = decodeURIComponent(new URL(dbUrl).username); } catch { return 'the database URL is not a URL'; }
  return /^postgres(\.[a-z]{20})?$/.test(user) ? null : `migrations apply only as postgres, not ${user.split('.')[0]}`;
}

function apply({ dbUrl, expectedRef, repo, backfill, allowOutOfOrder }) {
  const refused = refuseTarget(dbUrl, expectedRef) ?? applyUserProblem(dbUrl);
  if (refused) throw new Error(`REFUSED: ${refused}`);
  const migDir = path.join(repo, 'supabase', 'migrations');
  const manifest = JSON.parse(readFileSync(path.join(repo, 'supabase/baselines/manifest.json'), 'utf8'));
  const highWater = manifest.migrations_high_water;
  if (!/^\d{14}$/.test(highWater ?? '')) throw new Error('STOPPED: supabase/baselines/manifest.json has no valid migrations_high_water');
  const registry = JSON.parse(readFileSync(path.join(repo, 'supabase/baselines/one-shot-migrations.json'), 'utf8')).one_shot;
  if (!registry || typeof registry !== 'object') throw new Error('STOPPED: supabase/baselines/one-shot-migrations.json has no one_shot list');
  const oneShots = new Set(Object.keys(registry));
  const allSql = readdirSync(migDir).filter((n) => n.endsWith('.sql'));
  const badNames = allSql.filter((n) => n > highWater && !NAME.test(n.slice(0, -4)));
  if (badNames.length) throw new Error(`STOPPED before applying anything: badly named migration file(s): ${badNames.join(', ')} (<14-digit stamp>_<lower_snake>.sql)`);
  const files = allSql.filter((n) => NAME.test(n.slice(0, -4)));
  const fileBytes = (stem) => readFileSync(path.join(migDir, `${stem}.sql`));
  const postBaseline = (n) => NAME.test(n) && n.slice(0, 14) > highWater && files.includes(`${n}.sql`);
  const work = mkdtempSync(path.join(tmpdir(), 'db-apply-'));

  // Every check runs before anything is written.
  const stored = new Map(query(dbUrl, "SELECT name || '|' || coalesce(encode(sha256(convert_to(statements[1], 'UTF8')), 'hex'), '') FROM supabase_migrations.schema_migrations")
    .map((l) => [l.slice(0, l.lastIndexOf('|')), l.slice(l.lastIndexOf('|') + 1)]));
  const ledgerNames = new Set(stored.keys());
  // Applied files must still be what was applied.
  const edited = [...stored].filter(([n, h]) => h && postBaseline(n) && sha256(fileBytes(n)) !== h).map(([n]) => n);
  if (edited.length) throw new Error(`STOPPED: these applied migrations no longer match the ledger (edited after they ran): ${edited.join(', ')}`);
  const { steps, outOfOrder } = planMigrations({ files, highWater, ledgerNames, oneShots, allowOutOfOrder });
  if (outOfOrder.length && !allowOutOfOrder) {
    throw new Error(`STOPPED: these files are older than the newest migration already applied, so they would run out of order: ${outOfOrder.join(', ')}. Restamp them (npm run next-migration-stamp).`);
  }
  for (const stem of outOfOrder) console.log(`::warning::${stem} is older than the newest migration on this database; applying it now, after the newer ones (staging only).`);
  // Staging rows written by catchup-staging.sh carry no statements; give rows after the baseline the
  // file text once (baseline rows came from the restored dump, not these files). Never on live.
  const bare = backfill ? [...stored].filter(([n, h]) => !h && postBaseline(n)).map(([n]) => n) : [];
  const problems = [
    ...steps.flatMap(({ stem, run }) => fileProblems(stem, fileBytes(stem), { forRun: run })),
    ...bare.flatMap((stem) => fileProblems(stem, fileBytes(stem), { forRun: false })),
  ];
  if (problems.length) throw new Error(`STOPPED before applying anything: ${problems.join('; ')}`);

  for (const stem of bare) {
    const text = fileBytes(stem).toString('utf8');
    const tag = dollarTag(text);
    const f = path.join(work, `backfill-${stem}.sql`);
    writeFileSync(f, `UPDATE supabase_migrations.schema_migrations SET statements = ARRAY[${tag}${text}${tag}] WHERE name = '${stem}' AND statements[1] IS NULL;\n`);
    runFile(dbUrl, f);
    const back = query(dbUrl, `SELECT encode(sha256(convert_to(statements[1], 'UTF8')), 'hex') FROM supabase_migrations.schema_migrations WHERE name = '${stem}'`);
    if (back[0] !== sha256(fileBytes(stem))) throw new Error(`HASH MISMATCH after backfilling ${stem}`);
  }
  if (bare.length) console.log(`backfilled statements on ${bare.length} older ledger rows (hash-checked)`);

  for (const { stem, run } of steps) {
    const buf = fileBytes(stem);
    const text = buf.toString('utf8');
    const sha = sha256(buf);
    const wrapper = path.join(work, `${stem}.sql`);
    if (run && isNoTransaction(text)) {
      try {
        runFile(dbUrl, path.join(migDir, `${stem}.sql`), { retry: false });
      } catch (e) {
        throw new Error(`${stem} ran outside a transaction and failed: whatever ran before the error stays; repair by hand before the next run. ${e.message}`);
      }
      writeFileSync(wrapper, wrapperSql({ stem, text, run: false, sha }));
      try {
        runFile(dbUrl, wrapper);
      } catch (e) {
        throw new Error(`${stem} ran (outside a transaction) but its ledger row failed: record it by hand before the next run, or it runs again. ${e.message}`);
      }
    } else {
      writeFileSync(wrapper, wrapperSql({ stem, text, run, sha }));
      runFile(dbUrl, wrapper);
    }
    const after = query(dbUrl, `SELECT encode(sha256(convert_to(statements[1], 'UTF8')), 'hex') FROM supabase_migrations.schema_migrations WHERE name = '${stem}'`);
    if (after.length !== 1 || after[0] !== sha) throw new Error(`HASH MISMATCH for ${stem}: ledger ${after.join(',') || 'missing'}, file ${sha}`);
    console.log(`${run ? 'applied' : 'recorded (one-shot, not run)'} ${stem}  sha256 ${sha.slice(0, 12)} ok`);
    execFileSync('sleep', ['1']); // versions are the apply second; keep them unique
  }
  if (steps.length) psql(dbUrl, ['-c', "NOTIFY pgrst, 'reload schema';"]);
  console.log(`DB_APPLY_DONE ${expectedRef}: ${steps.length} migration(s)`);
}

// Read-only: compares the target's ledger with the repo's files and fails on any drift.
// report = true: list drift as warnings and pass (used until the first report has been reviewed).
function drift({ dbUrl, expectedRef, repo, report }) {
  const refused = refuseTarget(dbUrl, expectedRef);
  if (refused) throw new Error(`REFUSED: ${refused}`);
  const migDir = path.join(repo, 'supabase', 'migrations');
  const highWater = JSON.parse(readFileSync(path.join(repo, 'supabase/baselines/manifest.json'), 'utf8')).migrations_high_water;
  const oneShots = new Set(Object.keys(JSON.parse(readFileSync(path.join(repo, 'supabase/baselines/one-shot-migrations.json'), 'utf8')).one_shot ?? {}));
  const files = new Map(readdirSync(migDir).filter((n) => n.endsWith('.sql') && NAME.test(n.slice(0, -4)))
    .map((n) => [n.slice(0, -4), sha256(readFileSync(path.join(migDir, n)))]));
  const stored = new Map(query(dbUrl, "SELECT name || '|' || coalesce(encode(sha256(convert_to(statements[1], 'UTF8')), 'hex'), '') FROM supabase_migrations.schema_migrations")
    .map((l) => [l.slice(0, l.lastIndexOf('|')), l.slice(l.lastIndexOf('|') + 1)]));
  const { noFile, changed, notApplied } = ledgerDrift({ stored, files, highWater, oneShots });
  const level = report ? 'warning' : 'error';
  for (const n of noFile) console.log(`::${level}::${n} is in the ledger but has no migration file (applied outside the repo, e.g. the SQL Editor, or renamed after it ran)`);
  for (const n of changed) console.log(`::${level}::${n} was edited after it ran (ledger text and file differ)`);
  for (const n of notApplied) console.log(`::warning::${n} has a file but isn't applied on ${expectedRef} yet`);
  console.log(`DB_DRIFT ${expectedRef}: ${noFile.length} without a file, ${changed.length} changed, ${notApplied.length} not applied`);
  return !report && (noFile.length || changed.length) ? 1 : 0;
}

// Lines only on one side of two schema fingerprints (.github/scripts/schema-fingerprint.sql).
export function schemaDiff(target, rebuilt) {
  const [t, r] = [new Set(target), new Set(rebuilt)];
  return { onlyTarget: target.filter((l) => !r.has(l)), onlyRebuilt: rebuilt.filter((l) => !t.has(l)) };
}

// The target's public schema must equal one rebuilt from the repo (baseline + migrations): catches
// SQL Editor changes that left no ledger row. Read-only on the target; the rebuilt DB must be local.
function schema({ dbUrl, expectedRef, rebuiltUrl, report }) {
  const refused = refuseTarget(dbUrl, expectedRef);
  if (refused) throw new Error(`REFUSED: ${refused}`);
  if (urlRef(rebuiltUrl ?? '') !== 'local') throw new Error('REBUILT_DB_URL must be the local rebuilt database');
  const sql = readFileSync(new URL('./schema-fingerprint.sql', import.meta.url), 'utf8');
  const [target, rebuilt] = [query(dbUrl, sql), query(rebuiltUrl, sql)];
  if (!rebuilt.length || !target.length) throw new Error('a schema fingerprint came back empty');
  const { onlyTarget, onlyRebuilt } = schemaDiff(target, rebuilt);
  const level = report ? 'warning' : 'error';
  const show = (lines, where) => {
    for (const l of lines.slice(0, 100)) console.log(`::${level}::${where}: ${l.slice(0, 400)}`);
    if (lines.length > 100) console.log(`::${level}::...and ${lines.length - 100} more ${where}`);
  };
  show(onlyTarget, `on ${expectedRef}, not in the migration files`);
  show(onlyRebuilt, `in the migration files, not on ${expectedRef}`);
  console.log(`DB_SCHEMA ${expectedRef}: ${target.length} objects, ${onlyTarget.length} only on ${expectedRef}, ${onlyRebuilt.length} only in the files`);
  return !report && (onlyTarget.length || onlyRebuilt.length) ? 1 : 0;
}

const commands = {
  // env: DB_URL, TARGET_REF, REBUILT_DB_URL (from rebuild-schema.sh); SCHEMA_MODE=report warns only. Read-only.
  schema() {
    return schema({ dbUrl: process.env.DB_URL, expectedRef: process.env.TARGET_REF ?? '', rebuiltUrl: process.env.REBUILT_DB_URL, report: process.env.SCHEMA_MODE === 'report' });
  },
  // env: DB_URL, TARGET_REF. Read-only.
  drift() {
    return drift({ dbUrl: process.env.DB_URL, expectedRef: process.env.TARGET_REF ?? '', repo: process.cwd(), report: process.env.DRIFT_MODE === 'report' });
  },
  // env: DB_URL, TARGET_REF; optional BACKFILL=1 and ALLOW_OUT_OF_ORDER=1 (staging only)
  apply() {
    const expectedRef = process.env.TARGET_REF ?? '';
    apply({ dbUrl: process.env.DB_URL, expectedRef, repo: process.cwd(), backfill: process.env.BACKFILL === '1', allowOutOfOrder: process.env.ALLOW_OUT_OF_ORDER === '1' });
    return 0;
  },
  // usage: db-apply.mjs stamp-check <base ref>
  'stamp-check'([baseRef]) {
    const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
    const names = (lines) => lines.map((l) => path.basename(l)).filter((n) => n.endsWith('.sql'));
    const diff = (filter) => names(git('diff', '--no-renames', '--name-only', `--diff-filter=${filter}`, `${baseRef}...HEAD`, '--', 'supabase/migrations'));
    const added = diff('A');
    // A back-merge into staging brings main's files as-is: same content as on main = already checked there.
    const blob = (ref, f) => { try { return execFileSync('git', ['rev-parse', `${ref}:supabase/migrations/${f}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
    const mainRef = baseRef.endsWith('/staging') ? baseRef.replace(/\/staging$/, '/main') : null;
    const onMain = mainRef ? added.filter((f) => { const m = blob(mainRef, f); return m !== null && m === blob('HEAD', f); }) : [];
    const problems = stampProblems({
      added,
      onMain,
      changed: diff('MDT'),
      base: names(git('ls-tree', '--name-only', `${baseRef}:supabase/migrations`)),
      head: names(git('ls-tree', '--name-only', 'HEAD:supabase/migrations')),
    });
    // The baseline high-water and the one-shot list decide what runs: they move only on purpose.
    const show = (ref, file) => { try { return JSON.parse(execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' })); } catch { return null; } };
    const [mBase, mHead] = [show(baseRef, 'supabase/baselines/manifest.json'), show('HEAD', 'supabase/baselines/manifest.json')];
    if (!/^\d{14}$/.test(mHead?.migrations_high_water ?? '')) problems.push('supabase/baselines/manifest.json: missing or invalid migrations_high_water');
    if (mBase && mHead && mBase.migrations_high_water !== mHead.migrations_high_water) problems.push(`supabase/baselines/manifest.json: migrations_high_water changed (${mBase.migrations_high_water} -> ${mHead.migrations_high_water}); that skips every file below it, so it needs a new baseline, not a PR`);
    const [oBase, oHead] = [show(baseRef, 'supabase/baselines/one-shot-migrations.json'), show('HEAD', 'supabase/baselines/one-shot-migrations.json')];
    const oneShots = oHead?.one_shot && typeof oHead.one_shot === 'object' && !Array.isArray(oHead.one_shot) ? oHead.one_shot : null;
    if (!oneShots) problems.push('supabase/baselines/one-shot-migrations.json: missing or invalid one_shot list');
    // A one-shot is only recorded, never run, so only its encoding is checked (as apply does).
    problems.push(...added.flatMap((f) => {
      const stem = f.replace(/\.sql$/, '');
      return fileProblems(stem, readFileSync(path.join('supabase/migrations', f)), { forRun: !Object.hasOwn(oneShots ?? {}, stem) });
    }));
    for (const stem of Object.keys(oBase?.one_shot ?? {})) {
      if (!(stem in (oHead?.one_shot ?? {}))) problems.push(`one-shot-migrations.json: ${stem} was removed from the one-shot list; a record-only data migration would then run`);
    }
    for (const stem of Object.keys(oHead?.one_shot ?? {})) {
      if (!(stem in (oBase?.one_shot ?? {})) && !added.includes(`${stem}.sql`)) problems.push(`one-shot-migrations.json: ${stem} was added as a one-shot but isn't a new file in this PR (an existing migration can't become record-only)`);
    }
    for (const p of problems) console.log(`::error::${p}`);
    return problems.length ? 1 : 0;
  },
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [name, ...args] = process.argv.slice(2);
  try {
    process.exit(commands[name] ? await commands[name](args) : (console.error(`unknown command ${name}`), 2));
  } catch (e) {
    console.log(`::error::${e.message.split('\n')[0]}`);
    console.error(e.message);
    process.exit(1);
  }
}
