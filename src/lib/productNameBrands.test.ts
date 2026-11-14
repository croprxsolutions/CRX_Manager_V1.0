import { describe, expect, it } from 'vitest';
import {
  brandListFor,
  buildNameBrandReport,
  compareNameBrands,
  parseNameBrands,
  type BrandListSources,
  type ListBrand,
} from './productNameBrands';

// Made-up names only: the repository is public.
const list = (...names: string[]): ListBrand[] => names.map((name) => ({ name, isCurrentlySourced: true }));

describe('parseNameBrands', () => {
  it('reads several brands and ignores text outside the brackets', () => {
    expect(parseNameBrands('Gen Alpha: NO RETURN (Brandon XL, Coverly 4L, Zest) - 2.5 Gal').brands)
      .toEqual(['Brandon XL', 'Coverly 4L', 'Zest']);
  });

  it('returns nothing for a name with no brackets', () => {
    expect(parseNameBrands('Alpha - 1 Gal')).toEqual({ brands: [], notes: [], unclosed: false, maybeCutOff: null });
  });

  it('reads every bracket group; a note group stays a note', () => {
    const parsed = parseNameBrands('Gen Beta: Higher Quality (NO RETURN, FULL TOTE)(Inter, Flame) - 265G');
    expect(parsed.brands).toEqual(['Inter', 'Flame']);
    expect(parsed.notes).toEqual(['NO RETURN', 'FULL TOTE']);
  });

  it('cuts the size an unclosed bracket swallowed, as its own item or as a dash tail', () => {
    const own = parseNameBrands('Gen Gamma: (Brand A, Brand B, 2.5G');
    expect(own).toMatchObject({ brands: ['Brand A', 'Brand B'], unclosed: true, maybeCutOff: null });
    const tail = parseNameBrands('Gen Gamma: (Brand A, Brand B - 2.5 Gal');
    expect(tail).toMatchObject({ brands: ['Brand A', 'Brand B'], unclosed: true, maybeCutOff: null });
  });

  it('marks the last brand of an unclosed bracket as maybe cut off', () => {
    expect(parseNameBrands('Gen Gamma: (Brand A, Brand B, Bra')).toMatchObject({
      brands: ['Brand A', 'Brand B', 'Bra'], unclosed: true, maybeCutOff: 'Bra',
    });
  });

  it('drops empty items and tidies spaces; keeps the first spelling of a repeat', () => {
    expect(parseNameBrands('Gen D: (Brand A,, Brand  B , brand a,  Brand C)').brands).toEqual(['Brand A', 'Brand B', 'Brand C']);
  });

  it('treats percents, ratios, analyses, sizes and fixed words as notes', () => {
    const parsed = parseNameBrands('E (25%) F (50/50) G (0-0-24) H (2.5 Gal) I (retired) J (Full Pallets)');
    expect(parsed.brands).toEqual([]);
    expect(parsed.notes).toEqual(['25%', '50/50', '0-0-24', '2.5 Gal', 'retired', 'Full Pallets']);
  });

  it('keeps a percent followed by letters as a brand (known: some are nutrient notes)', () => {
    expect(parseNameBrands('Feed (25% N)').brands).toEqual(['25% N']);
  });

  it('reads a lone 4L item as a size (known limit)', () => {
    expect(parseNameBrands('Gen K: (Brand A, 4L').notes).toEqual(['4L']);
  });

  it('keeps 2,4-D whole and splits on semicolons', () => {
    expect(parseNameBrands('Gen L: (2,4-D Amine; Brand B)').brands).toEqual(['2,4-D Amine', 'Brand B']);
  });

  it('never reads a bracket before the colon as a brand', () => {
    expect(parseNameBrands('Gen Alpha (Crop Mix): (Brand A)').brands).toEqual(['Brand A']);
    expect(parseNameBrands('Alpha (Brand A) - 1 Gal').brands).toEqual(['Brand A']);
    expect(parseNameBrands('Alpha (Brand: A)').brands).toEqual(['Brand: A']);
  });

  it('does not split on a slash', () => {
    expect(parseNameBrands('Gen M: (Brand A/B)').brands).toEqual(['Brand A/B']);
  });
});

describe('compareNameBrands', () => {
  it('matches ignoring case, symbols, hyphens, en dashes and spacing', () => {
    expect(compareNameBrands(['Brand-X  4L', 'Zest®'], list('brand x 4l', 'Zest'))).toEqual({
      inNameOnly: [], onListOnly: [], spelledDifferently: [],
    });
    expect(compareNameBrands(['Brand–X'], list('Brand X™')).inNameOnly).toEqual([]);
  });

  it('lists brands on one side only, keeping original spelling', () => {
    const result = compareNameBrands(['Alpha', 'Bravado'], list('alpha', 'Corvette'));
    expect(result.inNameOnly).toEqual(['Bravado']);
    expect(result.onListOnly.map((brand) => brand.name)).toEqual(['Corvette']);
    expect(result.spelledDifferently).toEqual([]);
  });

  it('hints a one- or two-letter slip and never counts it as a match', () => {
    expect(compareNameBrands(['Interline'], list('Interlne')).spelledDifferently).toHaveLength(1);
    const swapped = compareNameBrands(['Interline'], list('Itnerline'));
    expect(swapped.spelledDifferently.map((pair) => [pair.inName, pair.onList.name])).toEqual([['Interline', 'Itnerline']]);
    expect(swapped.inNameOnly).toEqual([]);
    expect(swapped.onListOnly).toEqual([]);
  });

  it('gives no hint for three changes, short names, or a different formulation code', () => {
    expect(compareNameBrands(['Interline'], list('Intxrlxnx')).spelledDifferently).toEqual([]);
    expect(compareNameBrands(['Abcd'], list('Abce')).spelledDifferently).toEqual([]);
    expect(compareNameBrands(['Brand B 4L'], list('Brand B 4F')).spelledDifferently).toEqual([]);
    expect(compareNameBrands(['Slammer 5.4'], list('Slammer 4.5')).spelledDifferently).toEqual([]);
  });

  it('pairs a name brand with only the closest list brand', () => {
    const result = compareNameBrands(['Paraquin'], list('Paraquix', 'Parakwin'));
    expect(result.spelledDifferently.map((pair) => pair.onList.name)).toEqual(['Paraquix']);
    expect(result.onListOnly.map((brand) => brand.name)).toEqual(['Parakwin']);
  });
});

const brand = (brand_name: string, is_currently_sourced = true) => ({ brand_name, is_currently_sourced });

function sources(overrides: Partial<BrandListSources> = {}): BrandListSources {
  return {
    parentOf: new Map([['size-1', 'parent-1']]),
    ownBrands: new Map([['size-1', [brand('Own Brand')]], ['size-2', [brand('Solo')]]]),
    activeParentBrands: new Map([['parent-1', [brand('Parent Brand')]]]),
    groupingOpen: true,
    ...overrides,
  };
}

describe('brandListFor (the get_product_brands rule)', () => {
  it('a grouped size with the switch on uses its parent active brands', () => {
    expect(brandListFor('size-1', sources())).toEqual({ parentId: 'parent-1', brands: list('Parent Brand') });
  });

  it('the same size with the switch off uses its own rows', () => {
    expect(brandListFor('size-1', sources({ groupingOpen: false }))).toEqual({ parentId: null, brands: list('Own Brand') });
  });

  it('an ungrouped size uses its own rows; no rows is an empty list', () => {
    expect(brandListFor('size-2', sources()).brands).toEqual(list('Solo'));
    expect(brandListFor('size-3', sources()).brands).toEqual([]);
  });
});

describe('buildNameBrandReport', () => {
  const products = [
    { id: 'size-2', product_name: 'Gen Solo: (Solo) - 1 Gal', is_active: true },
    { id: 'p-agree-none', product_name: 'Plain - 1 Gal', is_active: true },
    { id: 'p-z', product_name: 'Zed: (Zebra)', is_active: true },
    { id: 'p-inactive', product_name: 'Abe: (Aardvark)', is_active: false },
    { id: 'p-a', product_name: 'Ace: (Antelope)', is_active: true },
    { id: 'p-cut', product_name: 'Cut: (2.5G', is_active: true },
    { id: 'size-1', product_name: 'Gen Pair: (Other) - 2.5 Gal', is_active: true },
    { id: 'p-list', product_name: 'Listed - 1 Gal', is_active: true },
  ];
  const report = buildNameBrandReport(products, sources({
    ownBrands: new Map([['size-2', [brand('Solo')]], ['p-list', [brand('Only On List', false)]]]),
  }));

  it('groups, counts the rest, and sorts in use first then A to Z', () => {
    expect(report.rows.map((row) => [row.group, row.productId])).toEqual([
      ['disagrees', 'size-1'],
      ['no_list', 'p-a'],
      ['no_list', 'p-z'],
      ['no_list', 'p-inactive'],
      ['no_name_brands', 'p-list'],
      ['unclosed_only', 'p-cut'],
    ]);
    expect(report.agreeCount).toBe(1);
    expect(report.neitherCount).toBe(1);
  });

  it('shows where a grouped size list comes from and keeps not-sourced brands', () => {
    expect(report.rows[0]).toMatchObject({ parentId: 'parent-1', inNameOnly: ['Other'], onListOnly: list('Parent Brand') });
    expect(report.rows.find((row) => row.productId === 'p-list')?.listBrands).toEqual([{ name: 'Only On List', isCurrentlySourced: false }]);
  });
});
