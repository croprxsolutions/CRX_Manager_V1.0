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
const NAME = /^(\d{14})_[a-z0-9_]+$/;

// Same rule as scripts/list-post-baseline-migrations.mjs, against the target's own ledger: files after
// the baseline high-water whose name the ledger lacks. One-shot data migrations are recorded, never
// run (supabase/baselines/one-shot-migrations.json). A missing ordinary file older than the newest
// applied one would run out of order, so it is reported instead of applied.
export function planMigrations({ files, highWater, ledgerNames, oneShots }) {
  const newest = [...ledgerNames].map((n) => NAME.exec(n)?.[1]).filter(Boolean).sort().at(-1) ?? '';
  const steps = [];
  const outOfOrder = [];
  for (const file of [...files].sort()) {
    const stem = file.replace(/\.sql$/, '');
    if (stem.slice(0, 14) <= highWater || ledgerNames.has(stem)) continue;
    if (oneShots.has(stem)) steps.push({ stem, run: false });
    else if (stem.slice(0, 14) < newest) outOfOrder.push(stem);
    else steps.push({ stem, run: true });
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
    ...(run ? [text] : []),
    `DO $crx_check$ BEGIN IF current_setting('crx.apply_tx', true) IS DISTINCT FROM txid_current()::text THEN RAISE EXCEPTION 'MIGRATION_LEFT_ITS_TRANSACTION: ${stem}'; END IF; END $crx_check$;`,
    `INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS'), '${stem}', ARRAY[${tag}${text}${tag}]);`,
    `DO $crx_check$ BEGIN IF (SELECT encode(sha256(convert_to(statements[1], 'UTF8')), 'hex') FROM supabase_migrations.schema_migrations WHERE name = '${stem}') IS DISTINCT FROM '${sha}' THEN RAISE EXCEPTION 'LEDGER_HASH_MISMATCH: ${stem}'; END IF; END $crx_check$;`,
    'COMMIT;',
    '',
  ].join('\n');
}

// Mason's point 6: a file that can't run inside a transaction (CREATE INDEX CONCURRENTLY) says so in
// its header; it runs on its own, then its ledger row goes in, with the same hash check.
export function isNoTransaction(text) {
  return text.split('\n').slice(0, 5).some((l) => /^--\s*crx:\s*no-transaction\b/i.test(l));
}

// What the job refuses to run: a file that isn't plain UTF-8 (the ledger stores text, so the hash
// would not match the bytes), a byte-order mark, its own transaction control (it would commit before
// the ledger row), or a psql backslash command (the live apply path doesn't run those).
export function fileProblems(stem, buf) {
  const problems = [];
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) problems.push(`${stem}: starts with a byte-order mark`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return [...problems, `${stem}: is not valid UTF-8`]; }
  for (const [i, line] of text.split('\n').entries()) {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|ABORT|START\s+TRANSACTION)\s*;/i.test(line)) problems.push(`${stem}:${i + 1}: has its own transaction control (${line.trim()}); the job wraps each file in one transaction`);
    if (/^\s*\\/.test(line)) problems.push(`${stem}:${i + 1}: has a psql backslash command`);
  }
  return problems;
}

// PR check: every new migration has a well-formed name, a stamp no other file shares, and a stamp
// newer than everything already on the base branch (the target applies all of those).
export function stampProblems({ added, base, head, changed = [] }) {
  const stamp = (f) => f.slice(0, 14);
  const baseMax = base.filter((f) => NAME.test(f.replace(/\.sql$/, ''))).map(stamp).sort().at(-1) ?? '';
  const problems = changed.map((f) => `${f}: an existing migration was edited, renamed or deleted; applied migrations never change (add a new one instead)`);
  for (const f of added) {
    if (!NAME.test(f.replace(/\.sql$/, ''))) { problems.push(`${f}: name must be <14-digit stamp>_<lower_snake>.sql`); continue; }
    if (head.filter((h) => stamp(h) === stamp(f)).length > 1) problems.push(`${f}: shares its stamp with another migration`);
    if (stamp(f) <= baseMax) problems.push(`${f}: stamp is not newer than ${baseMax}, the newest migration already on the base branch (npm run next-migration-stamp)`);
  }
  return problems;
}

// The project a Supabase connection string points at: the pooler user is postgres.<ref>, the
// direct host is db.<ref>.supabase.co. A local host counts as "local" (tests only).
export function urlRef(dbUrl) {
  let u;
  try { u = new URL(dbUrl); } catch { return null; }
  const user = /^postgres\.([a-z]{20})$/.exec(decodeURIComponent(u.username))?.[1];
  const host = /^db\.([a-z]{20})\.supabase\.co$/.exec(u.hostname)?.[1];
  if (user && host && user !== host) return null;
  if (user || host) return user ?? host;
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

// The connection string never reaches a log: a failure carries only psql's own output.
function psql(dbUrl, args, input) {
  try {
    return execFileSync('psql', [dbUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
      encoding: 'utf8', input, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = new Error(`psql failed: ${String(e.stderr ?? '').replaceAll(dbUrl, '<db>').trim() || `exit ${e.status}`}`);
    err.stderr = String(e.stderr ?? '').replaceAll(dbUrl, '<db>');
    throw err;
  }
}
const query = (dbUrl, sql) => psql(dbUrl, ['-At', '-c', sql]).split('\n').filter(Boolean);

// Runs one wrapper; retries while the database reports a busy draw-down cutover (as catchup-staging.sh).
function runFile(dbUrl, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      psql(dbUrl, ['-f', file]);
      return;
    } catch (e) {
      const msg = `${e.stderr ?? ''}${e.stdout ?? ''}`;
      if (attempt < 5 && msg.includes('NOT_QUIET')) { execFileSync('sleep', ['2']); continue; }
      throw new Error(msg.split('\n').filter((l) => /ERROR|CONTEXT|DETAIL|HINT/.test(l)).join('\n') || e.message);
    }
  }
}

function apply({ dbUrl, expectedRef, repo, backfill }) {
  const refused = refuseTarget(dbUrl, expectedRef);
  if (refused) throw new Error(`REFUSED: ${refused}`);
  const migDir = path.join(repo, 'supabase', 'migrations');
  const manifest = JSON.parse(readFileSync(path.join(repo, 'supabase/baselines/manifest.json'), 'utf8'));
  const oneShots = new Set(Object.keys(JSON.parse(readFileSync(path.join(repo, 'supabase/baselines/one-shot-migrations.json'), 'utf8')).one_shot ?? {}));
  const files = readdirSync(migDir).filter((n) => /^\d{14}_.+\.sql$/.test(n));
  const fileBytes = (stem) => readFileSync(path.join(migDir, `${stem}.sql`));
  const work = mkdtempSync(path.join(tmpdir(), 'db-apply-'));

  // Staging rows written by catchup-staging.sh carry no statements; give them the file text once so
  // the hash and drift checks can compare every row. Never on live.
  if (backfill) {
    // Only rows after the baseline: baseline rows came from the restored dump, not from these files.
    const bare = query(dbUrl, "SELECT name FROM supabase_migrations.schema_migrations WHERE statements IS NULL OR cardinality(statements) = 0 ORDER BY name")
      .filter((n) => NAME.test(n) && n.slice(0, 14) > manifest.migrations_high_water && files.includes(`${n}.sql`));
    for (const stem of bare) {
      const buf = fileBytes(stem);
      const bad = fileProblems(stem, buf);
      if (bad.length) throw new Error(`STOPPED: ${bad.join('; ')}`);
      const text = buf.toString('utf8');
      const tag = dollarTag(text);
      const f = path.join(work, `backfill-${stem}.sql`);
      writeFileSync(f, `UPDATE supabase_migrations.schema_migrations SET statements = ARRAY[${tag}${text}${tag}] WHERE name = '${stem}' AND (statements IS NULL OR cardinality(statements) = 0);\n`);
      runFile(dbUrl, f);
    }
    if (bare.length) console.log(`backfilled statements on ${bare.length} older ledger rows`);
  }

  // Applied files must still be what was applied: the stored text's hash per post-baseline row.
  const stored = new Map(query(dbUrl, "SELECT name || '|' || coalesce(encode(sha256(convert_to(statements[1], 'UTF8')), 'hex'), '') FROM supabase_migrations.schema_migrations")
    .map((l) => [l.slice(0, l.lastIndexOf('|')), l.slice(l.lastIndexOf('|') + 1)]));
  const ledgerNames = new Set(stored.keys());
  const edited = [...stored].filter(([n, h]) => h && NAME.test(n) && n.slice(0, 14) > manifest.migrations_high_water && files.includes(`${n}.sql`) && sha256(fileBytes(n)) !== h).map(([n]) => n);
  if (edited.length) throw new Error(`STOPPED: these applied migrations no longer match the ledger (edited after they ran): ${edited.join(', ')}`);
  const { steps, outOfOrder } = planMigrations({ files, highWater: manifest.migrations_high_water, ledgerNames, oneShots });
  if (outOfOrder.length) {
    throw new Error(`STOPPED: these files are older than the newest migration already applied, so they would run out of order: ${outOfOrder.join(', ')}. Restamp them (npm run next-migration-stamp).`);
  }
  const problems = steps.flatMap(({ stem }) => fileProblems(stem, fileBytes(stem)));
  if (problems.length) throw new Error(`STOPPED before applying anything: ${problems.join('; ')}`);
  for (const { stem, run } of steps) {
    const buf = fileBytes(stem);
    const text = buf.toString('utf8');
    const sha = sha256(buf);
    const wrapper = path.join(work, `${stem}.sql`);
    // ponytail: a no-transaction file that succeeds but whose ledger row then fails will re-run next
    // time; none exists yet, so the rare repair is by hand.
    if (run && isNoTransaction(text)) {
      runFile(dbUrl, path.join(migDir, `${stem}.sql`));
      writeFileSync(wrapper, wrapperSql({ stem, text, run: false, sha }));
    } else {
      writeFileSync(wrapper, wrapperSql({ stem, text, run, sha }));
    }
    runFile(dbUrl, wrapper);
    const after = query(dbUrl, `SELECT encode(sha256(convert_to(statements[1], 'UTF8')), 'hex') FROM supabase_migrations.schema_migrations WHERE name = '${stem}'`);
    if (after.length !== 1 || after[0] !== sha) throw new Error(`HASH MISMATCH for ${stem}: ledger ${after.join(',') || 'missing'}, file ${sha}`);
    console.log(`${run ? 'applied' : 'recorded (one-shot, not run)'} ${stem}  sha256 ${sha.slice(0, 12)} ok`);
    execFileSync('sleep', ['1']); // versions are the apply second; keep them unique
  }
  if (steps.length) psql(dbUrl, ['-c', "NOTIFY pgrst, 'reload schema';"]);
  console.log(`DB_APPLY_DONE ${expectedRef}: ${steps.length} migration(s)`);
}

const commands = {
  // env: DB_URL, TARGET_REF; optional BACKFILL=1 (staging only)
  apply() {
    const expectedRef = process.env.TARGET_REF ?? '';
    apply({ dbUrl: process.env.DB_URL, expectedRef, repo: process.cwd(), backfill: process.env.BACKFILL === '1' });
    return 0;
  },
  // usage: db-apply.mjs stamp-check <base ref>
  'stamp-check'([baseRef]) {
    const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
    const names = (lines) => lines.map((l) => path.basename(l)).filter((n) => n.endsWith('.sql'));
    const diff = (filter) => names(git('diff', '--no-renames', '--name-only', `--diff-filter=${filter}`, `${baseRef}...HEAD`, '--', 'supabase/migrations'));
    const added = diff('A');
    const problems = stampProblems({
      added,
      changed: diff('MD'),
      base: names(git('ls-tree', '--name-only', `${baseRef}:supabase/migrations`)),
      head: names(git('ls-tree', '--name-only', 'HEAD:supabase/migrations')),
    });
    problems.push(...added.flatMap((f) => fileProblems(f.replace(/\.sql$/, ''), readFileSync(path.join('supabase/migrations', f)))));
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
