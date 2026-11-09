/**
 * CLN-3 (docs/plans/2026-11-08-product-CLN3-BUILD-SHEET.md): reads the brand names written in brackets in a
 * product's name and compares them with the product's brand list. Read-only; nothing here writes.
 */

const SIZE_UNITS = 'gal|g|#|lb|lbs|oz|qt|pt|l|ml|kg|ton|tote|bulk|case';
// A whole item that is only a size, e.g. "2.5 gal", "265g", "12#".
const SIZE_ITEM = new RegExp(`^([0-9]+(\\.[0-9]*)?|\\.[0-9]+) ?(${SIZE_UNITS})$`);
// The size an unclosed bracket swallowed at its end, e.g. "(Brand A, Brand B - 2.5 Gal".
const SIZE_TAIL = new RegExp(`\\s+[-–—]\\s+([0-9]+(\\.[0-9]*)?|\\.[0-9]+) ?(${SIZE_UNITS})\\s*$`, 'i');
// Notes written in brackets that are words, not brands. Add a word here with a test.
const NOTE_WORDS = new Set(['retired', 'no return', 'full tote', 'full pallets', 'full pallet']);

export interface NameBrands {
  /** Brand names in the name, original spelling, each once. */
  brands: string[];
  notes: string[];
  /** An opening bracket that is never closed: the name was cut off. */
  unclosed: boolean;
  /** The last brand of an unclosed bracket, which may be only part of a word (e.g. "Bra"). */
  maybeCutOff: string | null;
}

/** The form two brand names are compared in: no ®™©, spaces, hyphens and underscores as one space, lower case. */
export function normalizeBrand(name: string): string {
  return name.replace(/[®™©]/g, '').replace(/[\s_\-–—]+/g, ' ').trim().toLowerCase();
}

function isNote(normal: string): boolean {
  return !/[a-z]/.test(normal) || SIZE_ITEM.test(normal) || NOTE_WORDS.has(normal);
}

export function parseNameBrands(productName: string): NameBrands {
  const result: NameBrands = { brands: [], notes: [], unclosed: false, maybeCutOff: null };
  const seen = new Set<string>();
  for (const match of productName.matchAll(/\(([^)]*)(\)|$)/g)) {
    const unclosed = match[2] === '';
    const text = unclosed ? match[1].replace(SIZE_TAIL, '') : match[1];
    let lastBrand: string | null = null;
    // Split on commas and semicolons, but keep a comma between two digits ("2,4-D").
    for (const raw of text.split(/;|(?<!\d),|,(?!\d)/)) {
      const name = raw.trim().replace(/\s+/g, ' ');
      const normal = normalizeBrand(name);
      lastBrand = null;
      if (!normal) continue;
      if (isNote(normal)) {
        result.notes.push(name);
        continue;
      }
      lastBrand = name;
      if (seen.has(normal)) continue;
      seen.add(normal);
      result.brands.push(name);
    }
    if (unclosed) {
      result.unclosed = true;
      // A size at the end means the name was cut after it, so the last brand is whole.
      result.maybeCutOff = SIZE_TAIL.test(match[1]) ? null : lastBrand;
    }
  }
  return result;
}

export interface ListBrand {
  name: string;
  isCurrentlySourced: boolean;
}

export interface NameBrandComparison {
  inNameOnly: string[];
  onListOnly: ListBrand[];
  /** Pairs that are probably one brand spelled two ways: shown as a hint, never counted as a match. */
  spelledDifferently: { inName: string; onList: ListBrand }[];
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

// "Brand B 4L" and "Brand B 4F" are different products, not a typo: no hint when two names differ only in
// digits, or only in a last word that carries a digit (a formulation code).
function differOnlyInCode(a: string, b: string): boolean {
  if (a.replace(/[0-9]/g, '') === b.replace(/[0-9]/g, '')) return true;
  const aWords = a.split(' ');
  const bWords = b.split(' ');
  const aLast = aWords.pop() ?? '';
  const bLast = bWords.pop() ?? '';
  return /[0-9]/.test(aLast) && /[0-9]/.test(bLast) && aWords.join(' ') === bWords.join(' ');
}

function typoDistance(a: string, b: string): number | null {
  if (Math.min(a.length, b.length) < 5 || differOnlyInCode(a, b)) return null;
  const distance = editDistance(a, b);
  return distance <= 2 ? distance : null;
}

export function compareNameBrands(nameBrands: string[], list: ListBrand[]): NameBrandComparison {
  const listNormals = new Set(list.map((brand) => normalizeBrand(brand.name)));
  const nameNormals = new Set(nameBrands.map(normalizeBrand));
  const inNameOnly = nameBrands.filter((name) => !listNormals.has(normalizeBrand(name)));
  const onListOnly = list.filter((brand) => !nameNormals.has(normalizeBrand(brand.name)));

  const candidates = inNameOnly.flatMap((inName, n) => onListOnly.flatMap((onList, l) => {
    const distance = typoDistance(normalizeBrand(inName), normalizeBrand(onList.name));
    return distance === null ? [] : [{ n, l, distance }];
  })).sort((left, right) => left.distance - right.distance);
  // Closest pairs first; each entry is used in at most one pair.
  const pairedNames = new Set<number>();
  const pairedList = new Set<number>();
  const spelledDifferently: NameBrandComparison['spelledDifferently'] = [];
  for (const { n, l } of candidates) {
    if (pairedNames.has(n) || pairedList.has(l)) continue;
    pairedNames.add(n);
    pairedList.add(l);
    spelledDifferently.push({ inName: inNameOnly[n], onList: onListOnly[l] });
  }
  return {
    inNameOnly: inNameOnly.filter((_, n) => !pairedNames.has(n)),
    onListOnly: onListOnly.filter((_, l) => !pairedList.has(l)),
    spelledDifferently,
  };
}

export interface BrandRow {
  brand_name: string;
  is_currently_sourced: boolean;
}

export interface BrandListSources {
  /** size id → its parent id (product_parent_members). */
  parentOf: ReadonlyMap<string, string>;
  /** size id → its own product_brands rows. */
  ownBrands: ReadonlyMap<string, BrandRow[]>;
  /** parent id → its product_parent_brands rows with status 'active' only. */
  activeParentBrands: ReadonlyMap<string, BrandRow[]>;
  groupingOpen: boolean;
}

/**
 * The brand list a size may be filled with. Copies the rule in get_product_brands
 * (supabase/migrations/20261123120000_product_parent_proposals.sql): a grouped size uses its parent's active
 * brands once the grouping switch is on; otherwise the size's own rows. A migration that changes that
 * function must change this too.
 */
export function brandListFor(productId: string, sources: BrandListSources): { parentId: string | null; brands: ListBrand[] } {
  const parentId = sources.parentOf.get(productId) ?? null;
  const fromParent = parentId !== null && sources.groupingOpen;
  const rows = (fromParent ? sources.activeParentBrands.get(parentId) : sources.ownBrands.get(productId)) ?? [];
  return {
    parentId: fromParent ? parentId : null,
    brands: rows.map((row) => ({ name: row.brand_name, isCurrentlySourced: row.is_currently_sourced })),
  };
}

export type NameBrandGroup = 'disagrees' | 'no_list' | 'no_name_brands' | 'unclosed_only';

export const NAME_BRAND_GROUP_LABELS: Record<NameBrandGroup, string> = {
  disagrees: 'Name and brand list disagree',
  no_list: 'Brands in the name, no brand list yet',
  no_name_brands: 'Brand list, no brands in the name',
  unclosed_only: 'Bracket not closed in the name',
};

const GROUP_ORDER: NameBrandGroup[] = ['disagrees', 'no_list', 'no_name_brands', 'unclosed_only'];

export interface NameBrandProduct {
  id: string;
  product_name: string;
  is_active: boolean;
}

export interface NameBrandRow extends NameBrandComparison {
  productId: string;
  productName: string;
  isActive: boolean;
  group: NameBrandGroup;
  nameBrands: NameBrands;
  listBrands: ListBrand[];
  /** Set when the list is the parent's (grouped size, switch on). */
  parentId: string | null;
}

export interface NameBrandReport {
  rows: NameBrandRow[];
  agreeCount: number;
  neitherCount: number;
}

function groupFor(name: NameBrands, list: ListBrand[], comparison: NameBrandComparison): NameBrandGroup | null {
  const nameHas = name.brands.length > 0;
  const listHas = list.length > 0;
  if (nameHas && listHas) {
    const differs = comparison.inNameOnly.length + comparison.onListOnly.length + comparison.spelledDifferently.length > 0;
    if (differs) return 'disagrees';
  } else if (nameHas) {
    return 'no_list';
  } else if (listHas) {
    return 'no_name_brands';
  }
  // A cut-off name is always listed, so no unclosed bracket is hidden.
  return name.unclosed ? 'unclosed_only' : null;
}

export function buildNameBrandReport(products: NameBrandProduct[], sources: BrandListSources): NameBrandReport {
  const rows: NameBrandRow[] = [];
  let agreeCount = 0;
  let neitherCount = 0;
  for (const product of products) {
    const nameBrands = parseNameBrands(product.product_name);
    const { parentId, brands: listBrands } = brandListFor(product.id, sources);
    const comparison = compareNameBrands(nameBrands.brands, listBrands);
    const group = groupFor(nameBrands, listBrands, comparison);
    if (group === null) {
      if (nameBrands.brands.length > 0) agreeCount += 1;
      else neitherCount += 1;
      continue;
    }
    rows.push({
      productId: product.id,
      productName: product.product_name,
      isActive: product.is_active,
      group,
      nameBrands,
      listBrands,
      parentId,
      ...comparison,
    });
  }
  // Group order, then products in use before inactive ones, then A to Z.
  rows.sort((left, right) => GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group)
    || Number(right.isActive) - Number(left.isActive)
    || left.productName.localeCompare(right.productName));
  return { rows, agreeCount, neitherCount };
}
