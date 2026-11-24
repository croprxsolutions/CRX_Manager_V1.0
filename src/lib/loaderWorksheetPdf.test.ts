import { describe, expect, it } from 'vitest';
import { buildLoaderWorksheetPdfPlan, loaderPdfWaterRows, type LoaderWorksheetPdfData } from './loaderWorksheetPdf';

const baseData: LoaderWorksheetPdfData = {
  job_number: 'JOB-100',
  customers: [{ customer_name: 'Smith Farm', account_number: null }],
  scheduled_date: '2026-07-11',
  scheduled_time: null,
  applicator_name: 'Avery Applicator',
  vehicle_name: 'Rogator',
  total_acres: 344.67,
  carrier_rate_gpa: 15,
  tank_capacity: 2000,
  capacity_unit: 'gal',
  products: [{ product_name: 'AMS', total_quantity: 689.34, unit: 'lb' }],
  loader_comment: null,
};

describe('buildLoaderWorksheetPdfPlan', () => {
  it('uses selected-row mode and per-load acres instead of legacy defaults', () => {
    const plan = buildLoaderWorksheetPdfPlan({
      ...baseData,
      load_balance_mode: 'full_loads_remainder',
      per_load_acres: [133.33, 133.33, 78.01],
      loads_done: [0],
    });

    expect(plan.worksheet.valid).toBe(true);
    expect(plan.worksheet.loads.map((load) => Math.round((load.volume / 15) * 100) / 100)).toEqual([133.33, 133.33, 78.01]);
    expect(plan.columns[0]).toMatchObject({ label: 'Load 1', done: true });
    expect(plan.columns[1]).toMatchObject({ label: 'Load 2', done: false });
  });

  it('condenses identical completed full loads while retaining their done mark', () => {
    const plan = buildLoaderWorksheetPdfPlan({
      ...baseData,
      load_balance_mode: 'full_loads_remainder',
      loads_done: [0, 1],
      display_mode: 'condensed',
    });

    expect(plan.columns[0]).toMatchObject({ label: '2 × Loads 1–2', done: true });
    expect(plan.columns[0].loads).toHaveLength(2);
    expect(plan.columns[1]).toMatchObject({ label: 'Load 3', done: false });
  });

  it('keeps condensed product amounts per tank instead of summing the group', () => {
    const plan = buildLoaderWorksheetPdfPlan({
      ...baseData,
      load_balance_mode: 'full_loads_remainder',
      display_mode: 'condensed',
    });

    const groupedColumn = plan.columns[0];
    const perTankAmount = plan.worksheet.loads[0].products[0].amount;
    expect(groupedColumn.loads).toHaveLength(2);
    expect(groupedColumn.load.products[0].amount).toBe(perTankAmount);
    expect(groupedColumn.load.products[0].amount).not.toBe(
      groupedColumn.loads.reduce((sum, load) => sum + load.products[0].amount, 0),
    );
  });

  it('ignores saved done marks beyond the current three-load plan', () => {
    const plan = buildLoaderWorksheetPdfPlan({ ...baseData, loads_done: [0, 5] });

    expect(plan.worksheet.loads_count).toBe(3);
    expect(plan.columns.map((column) => column.done)).toEqual([true, false, false]);
  });
});

describe('loaderPdfWaterRows', () => {
  const liquid = { ...baseData, total_acres: 100, carrier_rate_gpa: 10, tank_capacity: 300,
    products: [{ product_name: 'TEST Liquid', total_quantity: 40.5, unit: 'gal', product_form: 'liquid' },
      { product_name: 'TEST Dry', total_quantity: 100, unit: 'lb', product_form: 'dry' }] };

  it('prints finished gallons and water to add per tank and for the whole batch', () => {
    const { rows, warnings } = loaderPdfWaterRows(liquid, buildLoaderWorksheetPdfPlan(liquid));
    expect(rows[0]).toEqual(['Finished gallons', '300 GL', '300 GL', '300 GL', '100 GL', '1000 GL']);
    expect(rows[1][0]).toBe('Water to add');
    expect(rows[1][1]).toBe('287 GL 108.8 FL OZ'); // 300 − 12.15 gal
    expect(rows[1].at(-1)).toBe('959 GL 64 FL OZ'); // 1000 − 40.5
    expect(warnings).toEqual([]);
  });

  it('prints 0 and a warning when the recipe is more than the finished gallons', () => {
    const over = { ...liquid, products: [{ product_name: 'TEST Liquid', total_quantity: 1200, unit: 'gal', product_form: 'liquid' }] };
    const { rows, warnings } = loaderPdfWaterRows(over, buildLoaderWorksheetPdfPlan(over));
    expect(rows[1].slice(1)).toEqual(['0 GL (!)', '0 GL (!)', '0 GL (!)', '0 GL (!)', '0 GL (!)']);
    expect(warnings[0]).toMatch(/more than the finished gallons on Load 1, Load 2, Load 3, Load 4/);
  });

  it('flags a line with no amount instead of counting it as no volume', () => {
    const blank = { ...liquid, products: [{ product_name: 'TEST Blank', total_quantity: null, unit: 'gal', product_form: 'liquid' }] };
    const { rows, warnings } = loaderPdfWaterRows(blank, buildLoaderWorksheetPdfPlan(blank));
    expect(rows[1].at(-1)).toBe('1000 GL *');
    expect(warnings[0]).toMatch(/does not count TEST Blank: the amount is missing/);
  });
});
