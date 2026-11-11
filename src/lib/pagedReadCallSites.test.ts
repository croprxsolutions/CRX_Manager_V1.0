import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// fetchAllRows only checks a paged read against the server's row count when
// each page carries `count`, i.e. when the query selects with
// `{ count: 'exact' }`. Without it the check is skipped silently and a list
// that changed mid-read can come back short. Every paged read on a page must
// therefore request the count.

const PAGES_DIR = join(__dirname, '..', 'pages');

// Files not checked yet, each with its reason.
const EXEMPT: Record<string, string> = {};

// Paged reads that cannot select with `{ count: 'exact' }`, each with its reason.
// They keep fetchAllRows' other guard: a read of more than one page is returned
// only once a second whole read matches it row for row. The number of such reads
// per file must match exactly, so a new read without the count still fails.
const COUNT_EXEMPT: Record<string, { sites: number; reason: string }> = {
  'src/lib/ordersPage.ts': { sites: 1, reason: 'pages through the orders-page function, which returns its own total_count; that count is passed to fetchAllRows' },
  'src/components/receiving/ReceivingLogPanel.tsx': { sites: 1, reason: 'get_receiving_log pages with p_limit/p_offset and returns no count; adding one needs a database change' },
};

const CALL_PATTERN = /\bfetchAllRows(?:ForIds)?\s*(?:<[^()]*?>)?\s*\(/g;

type CallSite = { file: string; line: number; callback: string };

// Shared readers outside src/pages and src/components that page with
// fetchAllRows (paths under src). The integrity checks recompute ledgers from
// reconciliation's reads, so a short read is a false result.
const SHARED_FILES = [
  'lib/customerDuplicates.ts',
  'lib/customerStatement.ts',
  'lib/epaRegistrationSeed.ts',
  'lib/fieldsGeojsonCache.ts',
  'lib/marginFloors.ts',
  'lib/ordersPage.ts',
  'lib/paymentDuplicate.ts',
  'lib/productParentProposals.ts',
  'lib/reconciliation.ts',
  'lib/sellPriceHistory.ts',
  'lib/toteFill.ts',
  'lib/useVendorNames.ts',
];

// Components (under src/components) that page with fetchAllRows: Goal 4 part 2's
// money, check, compliance and lookup panels. A file listed here must still exist.
const COMPONENT_FILES = [
  'blendtickets/ManualTicketCreate.tsx',
  'customers/CustomerContacts.tsx',
  'deliveries/QuickDeliveryModal.tsx',
  'field-app/SelectLocationsModal.tsx',
  'field-invoices/FieldInvoicesListPanel.tsx',
  'field-invoices/FieldInvoicesPostedPanel.tsx',
  'field-invoices/FieldInvoicesUnpostedPanel.tsx',
  'field-invoices/UnbilledApplicationsPanel.tsx',
  'fields/BulkFieldImport.tsx',
  'integrity/IntegrityCleanupPanel.tsx',
  'inventory/TransactionLedgerModal.tsx',
  'invoices/FinanceChargePreviewModal.tsx',
  'orders/BulkOrderImport.tsx',
  'products/NameBrandCheckSection.tsx',
  'prepay/PrepaymentManagerPanel.tsx',
  'prepay/PrepayWorkspacePanel.tsx',
  'purchase-orders/BulkPOImport.tsx',
  'quotes/BulkQuoteImport.tsx',
  'receiving/QuickReceivePanel.tsx',
  'receiving/ReceivingHubPanel.tsx',
  'receiving/ReceivingLogPanel.tsx',
  'reports/LogbookReport.tsx',
];
const COMPONENTS_DIR = join(__dirname, '..', 'components');

function findCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  const pageFiles = readdirSync(PAGES_DIR).sort()
    .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx') && !(file in EXEMPT))
    .map((file) => ({ file: `src/pages/${file}`, path: join(PAGES_DIR, file) }));
  const libFiles = SHARED_FILES.map((file) => ({ file: `src/${file}`, path: join(__dirname, '..', file) }));
  const componentFiles = COMPONENT_FILES.map((file) => ({ file: `src/components/${file}`, path: join(COMPONENTS_DIR, file) }));
  for (const { file, path } of [...pageFiles, ...libFiles, ...componentFiles]) {
    // Comments are blanked (same length, newlines kept, so lines still match)
    // so a comment mentioning the count cannot satisfy the check. Blanking only
    // removes text, so a misread string can only make a site fail, never pass.
    const source = blankComments(readFileSync(path, 'utf8'));
    const starts = [...source.matchAll(CALL_PATTERN)].map((m) => m.index ?? 0);
    starts.forEach((start, i) => {
      const nextCall = i + 1 < starts.length ? starts[i + 1] : source.length;
      const rangeAt = source.indexOf('.range(', start);
      const line = source.slice(0, start).split('\n').length;
      // The callback's `.range(` must come before the next paged call; otherwise
      // a later query's count could mask this one, so record nothing and fail.
      const ownsRange = rangeAt !== -1 && rangeAt < nextCall;
      sites.push({ file, line, callback: ownsRange ? source.slice(start, rangeAt) : '' });
    });
  }
  return sites;
}

describe('paged list reads request the exact row count', () => {
  const sites = findCallSites();

  it('finds the paged reads (a pattern that matches nothing must fail)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(20);
    expect(sites.filter((site) => site.file === 'src/lib/reconciliation.ts').length).toBeGreaterThanOrEqual(14);
    // Every listed shared file and component is actually scanned and pages at least once.
    for (const file of SHARED_FILES) {
      expect(sites.some((site) => site.file === `src/${file}`), file).toBe(true);
    }
    for (const file of COMPONENT_FILES) {
      expect(sites.some((site) => site.file === `src/components/${file}`), file).toBe(true);
    }
  });

  it("every fetchAllRows / fetchAllRowsForIds call selects with { count: 'exact' }", () => {
    const withoutCount = sites.filter((site) => !site.callback.includes("count: 'exact'"));
    const perFile: Record<string, number> = {};
    for (const site of withoutCount) perFile[site.file] = (perFile[site.file] ?? 0) + 1;
    const listed = Object.fromEntries(Object.entries(COUNT_EXEMPT).map(([file, { sites: n }]) => [file, n]));
    // Exact match: an unlisted read fails, and so does an entry that outlives its read.
    const lines = withoutCount.map((site) => `${site.file}:${site.line}`).join('\n');
    expect(perFile, `paged reads without { count: 'exact' } (COUNT_EXEMPT lists the allowed ones):\n${lines}`).toEqual(listed);
  });

  it('every exempt file still exists (drop the entry once the file is covered)', () => {
    const files = new Set(readdirSync(PAGES_DIR));
    for (const file of Object.keys(EXEMPT)) expect(files.has(file), file).toBe(true);
  });

  it('every file under src that pages with fetchAllRows is scanned', () => {
    const scanned = new Set(sites.map((site) => site.file));
    const missing = sourceFiles(join(__dirname, '..'), 'src')
      .filter(({ file }) => !/\.test\.tsx?$/.test(file) && file !== 'src/lib/pagedRead.ts' && !(file.replace('src/pages/', '') in EXEMPT))
      .filter(({ path }) => new RegExp(CALL_PATTERN.source).test(blankComments(readFileSync(path, 'utf8'))))
      .map(({ file }) => file)
      .filter((file) => !scanned.has(file));
    expect(missing, 'add these to SHARED_FILES or COMPONENT_FILES').toEqual([]);
  });
});

// Comments blanked to spaces (newlines kept, so line numbers still match). One
// pass, so whichever comment opens first wins: a `/*` inside a `//` comment must
// not blank everything up to the next `*/` (it once hid
// UnbilledApplicationsPanel's reads; the "every file is scanned" test caught it).
function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

function sourceFiles(dir: string, rel: string): { file: string; path: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    const file = `${rel}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path, file);
    return /\.tsx?$/.test(entry.name) ? [{ file, path }] : [];
  });
}

// A paged read that sorts by or selects a column its table does not have is
// refused by the server (42703), and the screen shows nothing. Component tests
// mock the readers, so only a check against the live column list sees it
// (PR #1608: product_parent_members has no `id`; its key is product_id).
// `.claude/schema-registry.json` › columns holds each table's live columns.
const REGISTRY_COLUMNS: Record<string, string[]> = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '.claude', 'schema-registry.json'), 'utf8'),
).columns;

// Paged reads with no literal table name, so their columns cannot be checked:
// file → number of such call sites, with the reason. The count must match
// exactly, so a new unreadable read fails until it is listed here.
const RPC = 'reads an RPC: its rows are computed, so there is no table to check';
const COLUMN_CHECK_EXEMPT: Record<string, { sites: number; reason: string }> = {
  'src/components/customers/CustomerContacts.tsx': { sites: 2, reason: 'the table comes from the contactsTable() / interactionsTable() helpers' },
  'src/components/field-invoices/FieldInvoicesUnpostedPanel.tsx': { sites: 1, reason: 'reads the invoices_postable view through the INVOICES_POSTABLE constant; views are not in the registry' },
  'src/components/invoices/FinanceChargePreviewModal.tsx': { sites: 1, reason: RPC },
  'src/components/receiving/ReceivingLogPanel.tsx': { sites: 1, reason: RPC },
  'src/components/reports/LogbookReport.tsx': { sites: 4, reason: RPC },
  'src/lib/customerStatement.ts': { sites: 1, reason: RPC },
  'src/lib/fieldsGeojsonCache.ts': { sites: 1, reason: RPC },
  'src/lib/ordersPage.ts': { sites: 1, reason: 'reads through fetchOrdersPage(), an RPC' },
  'src/pages/ARaging.tsx': { sites: 1, reason: RPC },
  'src/pages/AccountsPayable.tsx': { sites: 1, reason: RPC },
  'src/pages/AccountsReceivable.tsx': { sites: 1, reason: RPC },
  'src/pages/Compliance.tsx': { sites: 1, reason: RPC },
  'src/pages/CustomerTransactionReview.tsx': { sites: 1, reason: RPC },
  'src/pages/DispatchBoard.tsx': { sites: 1, reason: RPC },
  'src/pages/FieldDashboard.tsx': { sites: 1, reason: RPC },
  'src/pages/FieldProfitability.tsx': { sites: 1, reason: RPC },
  'src/pages/FieldView.tsx': { sites: 1, reason: RPC },
  'src/pages/Fields.tsx': { sites: 1, reason: RPC },
  'src/pages/Invoices.tsx': { sites: 1, reason: 'reads the invoices_postable view through the INVOICES_POSTABLE constant; views are not in the registry' },
  'src/pages/Jobs.tsx': { sites: 2, reason: 'one RPC read; the job list is built by the baseQuery() helper' },
  'src/pages/OfficeCockpit.tsx': { sites: 2, reason: RPC },
  'src/pages/Reports.tsx': { sites: 5, reason: RPC },
  'src/pages/SalesReports.tsx': { sites: 2, reason: RPC },
  'src/pages/WatchdogExceptions.tsx': { sites: 1, reason: RPC },
};

// Views read by name that the registry does not hold (it lists tables only):
// their columns cannot be checked, so the check skips them. An entry must
// still be missing from the registry; drop it once the registry lists the view.
const VIEWS_NOT_IN_REGISTRY: Record<string, string> = {
  profile_public_view: 'the non-sensitive employee directory over profiles; a view, so not in the registry',
};

// What is checked, per call site (the callback text up to its `.range(`):
// - the table is the one `.from('<table>')`; any other form (`.rpc(...)`, a
//   variable or constant table name, or two different tables) is unreadable
//   and must be listed in COLUMN_CHECK_EXEMPT;
// - every `.order('<col>')`, except one with a `referencedTable` /
//   `foreignTable` option (it sorts an embedded table);
// - every plain column in the literal text of each `.select(...)`, with
//   `label:col`, `col::cast` and `col->json` reduced to `col`.
// Skipped in `.select`: `*`, embedded relations (anything with parentheses,
// e.g. `customer:customers(farm_name)`, `...rel(col)`: the related table is
// named by relation, not table), and interpolated or constant parts
// (`${PRODUCT_COLUMNS}`, `.select(COLS)`), which are shared column lists
// rather than call-site text. shortcut: those forms stay unchecked; resolve
// the constants and relations if one of them ever breaks a read.
function selectedColumns(callback: string): string[] {
  return [...callback.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)].flatMap((arg) => selectListColumns(arg[2]));
}

function selectListColumns(selectText: string): string[] {
  const text = selectText.replace(/\$\{[^}]*\}/g, '');
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter((part) => part && part !== '*' && !part.includes('('))
    // `label:col` renames col: check col (the text after the alias colon, not a `::` cast).
    .map((part) => part.replace(/^[^:]*[^:]:(?!:)/, '').split(/::|->/)[0].trim());
}

type ColumnSite = CallSite & { table: string | null; columns: string[] };

function columnSites(): ColumnSite[] {
  return findCallSites().map((site) => {
    const tables = [...new Set([...site.callback.matchAll(/\.from\(\s*'([a-z0-9_]+)'\s*\)/g)].map((m) => m[1]))];
    const readable = tables.length === 1 && !/\.from\(\s*[^'\s]/.test(site.callback) && !/\.rpc\(/.test(site.callback);
    const orderMatches = [...site.callback.matchAll(/\.order\(\s*'([a-z0-9_]+)'\s*(?:,\s*\{([^}]*)\})?\s*\)/g)];
    const orders = orderMatches.filter((m) => !/referencedTable|foreignTable/.test(m[2] ?? '')).map((m) => m[1]);
    // A sort the pattern cannot read (a variable column) fails as an unknown column, never passes.
    if (orderMatches.length !== (site.callback.match(/\.order\(/g) ?? []).length) orders.push('<unreadable .order()>');
    return { ...site, table: readable ? tables[0] : null, columns: [...selectedColumns(site.callback), ...orders] };
  });
}

describe('paged list reads only name columns their table has', () => {
  const sites = columnSites();

  it('reads the table of most paged reads (a parser that reads none must fail)', () => {
    expect(sites.filter((site) => site.table).length).toBeGreaterThanOrEqual(100);
    expect(sites.some((site) => site.file === 'src/lib/toteFill.ts' && site.table === 'product_parent_members')).toBe(true);
  });

  it('every selected and sorted column exists on its table in the schema registry', () => {
    const missing = sites.flatMap((site) => {
      if (!site.table || site.table in VIEWS_NOT_IN_REGISTRY) return [];
      const known = REGISTRY_COLUMNS[site.table];
      if (!known) return [`${site.file}:${site.line} table ${site.table} is not in the schema registry`];
      return site.columns
        .filter((column) => !known.includes(column))
        .map((column) => `${site.file}:${site.line} ${site.table}.${column}`);
    });
    expect(missing, `paged reads naming a column their table lacks:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every paged read whose table cannot be read is listed, with the exact count', () => {
    const unreadable: Record<string, number> = {};
    for (const site of sites.filter((s) => !s.table)) unreadable[site.file] = (unreadable[site.file] ?? 0) + 1;
    const listed = Object.fromEntries(Object.entries(COLUMN_CHECK_EXEMPT).map(([file, entry]) => [file, entry.sites]));
    expect(unreadable).toEqual(listed);
  });

  it('every view skipped as missing from the registry is still missing from it', () => {
    for (const view of Object.keys(VIEWS_NOT_IN_REGISTRY)) expect(REGISTRY_COLUMNS[view], view).toBeUndefined();
  });
});
