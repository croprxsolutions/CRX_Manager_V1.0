/**
 * BulkOrderImport.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
}));

// Fully chainable Supabase query-builder mock
function chainable(resolveWith: unknown = { data: [], error: null }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  const methods = [
    'select','insert','update','upsert','delete',
    'eq','neq','gt','gte','lt','lte','like','ilike','regexIMatch','is','in','or','not','match',
    'order','limit','range','single','maybeSingle',
    'csv','explain',
  ];
  for (const m of methods) builder[m] = vi.fn(self);
  builder.then = vi.fn((resolve: (v: unknown) => void) => {
    Promise.resolve(resolveWith).then(resolve);
    return builder;
  });
  return builder;
}

vi.mock('../../lib/db', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  assertRpcResult: (value: unknown) => value,
}));

vi.mock('../../lib/documentOCR', () => ({
  processDocumentWithOCR: vi.fn(),
  isCSVFile: vi.fn(() => true),
  isOCRSupported: vi.fn(() => false),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', full_name: 'Test User' } }),
}));

vi.mock('../../lib/activityLogger', () => ({
  logActivity: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

import BulkOrderImport from './BulkOrderImport';

async function parseCsvFile(container: HTMLElement, csv: string) {
  const file = new File([csv], 'review-cases.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
  fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
}

describe('BulkOrderImport', () => {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'products') {
        return chainable({
          data: [
            { id: 'product-a', product_name: 'Same Name', sku: 'SKU-A', is_active: true, current_cost: 6 },
            { id: 'product-b', product_name: 'Same Name', sku: 'SKU-B', is_active: true, current_cost: 7 },
            { id: 'product-name-x', product_name: 'Cross Identity', sku: 'NAME-X', is_active: true, current_cost: 8 },
            { id: 'product-sku-x', product_name: 'Other Product', sku: 'Cross Identity', is_active: true, current_cost: 9 },
          ],
          error: null,
        });
      }
      if (table === 'customers') {
        return chainable({ data: { id: 'customer-1' }, error: null });
      }
      return chainable();
    });
    mocks.rpc.mockResolvedValue({ data: { order_id: 'order-1' }, error: null });
  });

  it('renders when open', () => {
    render(<BulkOrderImport {...defaultProps} />);
    expect(screen.getByText(/import orders/i)).toBeInTheDocument();
  });

  it.each([false, true])('inherits optional order headers without dropping continuation items, reverse=%s', async (reverse) => {
    const rows = ['O-INHERIT,North Farm,2026-10-28,Header notes,SKU-B,2,20', 'O-INHERIT,North Farm,,,SKU-B,1,20'];
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    await parseCsvFile(container, ['order_number,customer_name,order_date,notes,product_name,quantity,price_per_unit', ...(reverse ? rows.reverse() : rows)].join('\n'));
    await screen.findByText(/O-INHERIT/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.objectContaining({
      p_order_date: '2026-10-28', p_notes: 'Header notes', p_total_price: 60,
      p_items: [expect.anything(), expect.anything()],
    })));
  });

  it('reports one accurate error for a blank required customer on a continuation row', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    await parseCsvFile(container, 'order_number,customer_name,product_name,quantity,price_per_unit\nO-REQUIRED,North Farm,SKU-B,2,20\nO-REQUIRED,,SKU-B,1,20');
    expect(await screen.findByText(/Missing required order number, customer name, or product name/)).toBeInTheDocument();
    expect(screen.queryByText(/Conflicting customer_name/)).not.toBeInTheDocument();
    expect(screen.queryByText(/invalid quantity, price/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /import 1 order/i })).not.toBeInTheDocument();
  });
  it('reports only the missing first customer, without false conflicts on subsequent matching rows', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    await parseCsvFile(container, 'order_number,customer_name,product_name,quantity,price_per_unit\nO-REQUIRED,,SKU-B,2,20\nO-REQUIRED,North Farm,SKU-B,1,20\nO-REQUIRED,North Farm,SKU-B,1,20');
    expect(await screen.findByText(/Missing required order number, customer name, or product name/)).toBeInTheDocument();
    expect(screen.queryByText(/Conflicting customer_name/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /import 1 order/i })).not.toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('matches asterisk, percent, underscore, backslash and regex characters in customer names literally', async () => {
    const customerQuery = chainable({ data: { id: 'customer-literal' }, error: null });
    const original = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => table === 'customers' ? customerQuery : original(table));
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    await parseCsvFile(container, 'order_number,customer_name,product_name,quantity,price_per_unit\nO-LITERAL,Farm*_1%\\East.(North)+?,SKU-B,1,20');
    await screen.findByText(/O-LITERAL/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.objectContaining({ p_customer_id: 'customer-literal' })));
    expect(customerQuery.regexIMatch).toHaveBeenCalledWith('farm_name', '^Farm\\*_1%\\\\East\\.\\(North\\)\\+\\?$');
  });

  it('excludes only the order with an invalid status and preserves an unrelated order', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    await parseCsvFile(container, 'order_number,customer_name,status,product_name,quantity,price_per_unit\nO-BAD,North Farm,fulfilled,SKU-B,1,20\nO-BAD,North Farm,confirmed,SKU-B,1,20\nO-GOOD,North Farm,confirmed,SKU-B,1,20');
    await screen.findByText(/Only confirmed orders/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.objectContaining({ p_order_number: 'O-GOOD' })));
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'bulk_import_order')).toHaveLength(1);
  });

  it.each([
    ['customer_name', 'Other Farm'], ['order_date', '2026-10-29'], ['notes', 'Different notes'],
  ])('rejects the whole order when repeated %s disagrees', async (field, conflict) => {
    const header = ['order_number', 'customer_name', 'order_date', 'notes', 'product_name', 'quantity', 'price_per_unit'];
    const first = ['O-CONFLICT', 'North Farm', '2026-10-28', 'Header notes', 'SKU-B', '2', '20'];
    const second = [...first];
    second[header.indexOf(field)] = conflict;
    const csv = [header.join(','), first.join(','), second.join(','), 'O-GOOD,North Farm,2026-10-28,Header notes,SKU-B,1,20'].join('\n');
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const file = new File([csv], 'conflict.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    expect(await screen.findByText(new RegExp(`Conflicting.*${field}`))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.objectContaining({ p_order_number: 'O-GOOD' })));
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'bulk_import_order')).toHaveLength(1);
  });

  it.each(['0x10', '0b10', '0o10', '1e-999', '9007199254740993', '1.0000000000000001', 'NaN', 'Infinity', '1,200', '2 units'])('blocks the whole order for invalid quantity %s', async (quantity) => {
    const csv = `order_number,customer_name,product_name,quantity,price_per_unit\nO-PARTIAL,North Farm,SKU-B,2,20\nO-PARTIAL,North Farm,SKU-B,"${quantity}",20`;
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const file = new File([csv], 'numeric-edge.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    expect(await screen.findByText(/invalid quantity, price, or unit cost/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /import 1 order/i })).not.toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('preserves distinct Description items in one order without treating them as conflicting header notes', async () => {
    const csv = 'Order No,Buyer,Description,Qty,Unit Price\nO-DESC,North Farm,SKU-A,+2,1.25e1\nO-DESC,North Farm,SKU-B,.5,12.50';
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const file = new File([csv], 'descriptions.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-DESC/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.objectContaining({
      p_order_number: 'O-DESC', p_total_price: 31.25, p_notes: undefined,
      p_items: [expect.objectContaining({ product_id: 'product-a', total_units_needed: 2 }), expect.objectContaining({ product_id: 'product-b', total_units_needed: 0.5 })],
    })));
  });

  it('blocks unsafe order money before bulk_import_order', async () => {
    const csv = 'order_number,customer_name,product_name,quantity,price_per_unit\nO-RANGE,North Farm,SKU-B,1,1e14';
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const file = new File([csv], 'range.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-RANGE/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));
    expect(await screen.findByRole('list', { name: /order import failure details/i })).toHaveTextContent('Order O-RANGE');
    expect(screen.getByRole('list', { name: /order import failure details/i })).toHaveTextContent('Imported money exceeds the supported whole-cent range');
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('imports quoted names without shifting mapped quantity or price', async () => {
    const customerQuery = chainable({ data: { id: 'customer-quoted' }, error: null });
    mocks.from.mockImplementation((table: string) => table === 'customers' ? customerQuery : chainable({
      data: [{ id: 'product-quoted', product_name: 'Mix, "A"', sku: 'MIX-A', is_active: true }], error: null,
    }));
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = '\uFEFF"Order No",Buyer,Item,Qty,Unit Price,Item Notes\r\nO-QUOTED,"Wells, ""Family"" Farms","Mix, ""A""",2,12.50,"Line one\r\nLine two"\r\n';
    const file = new File([csv], 'quoted.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-QUOTED/);
    expect(screen.getByText(/Wells, "Family" Farms/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.objectContaining({
      p_customer_id: 'customer-quoted',
      p_total_price: 25,
      p_items: [expect.objectContaining({ product_id: 'product-quoted', product_name: 'Mix, "A"', total_units_needed: 2, price_per_unit: 12.5, notes: 'Line one\r\nLine two' })],
    })));
    expect(customerQuery.regexIMatch).toHaveBeenCalledWith('farm_name', '^Wells, "Family" Farms$');
  });

  it.each(['O-BAD,"Unclosed,Roundup,2,20', 'O-BAD,Wells,Farm,Roundup,2,20'])('blocks malformed CSV before import: %s', async (row) => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = `order_number,customer_name,product_name,quantity,price_per_unit\n${row}`;
    const file = new File([csv], 'bad.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringMatching(/CSV line 2:.*Correct the file/)));
    expect(screen.queryByRole('button', { name: /import \d+ order/i })).not.toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('does not render when closed', () => {
    render(<BulkOrderImport {...defaultProps} open={false} />);
    expect(screen.queryByText(/import orders/i)).not.toBeInTheDocument();
  });

  it('shows file upload area', () => {
    render(<BulkOrderImport {...defaultProps} />);
    expect(screen.getAllByText(/csv/i).length).toBeGreaterThan(0);
  });

  it('rejects an ambiguous same-name Product before bulk_import_order', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-AMB,North Farm,Same Name,2,20',
    ].join('\n');
    const file = new File([csv], 'ambiguous.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/ambiguous\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-AMB/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await screen.findByText(/successfully imported:/i);
    expect(screen.getByText(/failed:/i)).toHaveTextContent('Failed: 1');
    const failures = screen.getByRole('list', { name: /order import failure details/i });
    expect(failures).toHaveTextContent('Order O-AMB');
    expect(failures).toHaveTextContent('"Same Name" has an ambiguous Product match');
    expect(failures).toHaveTextContent('use a unique SKU and retry');
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('shows the missing Product text and retry guidance without calling bulk_import_order', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-MISSING,North Farm,Unknown Product,2,20',
    ].join('\n');
    const file = new File([csv], 'missing.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/missing\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-MISSING/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await screen.findByText(/successfully imported:/i);
    const failures = screen.getByRole('list', { name: /order import failure details/i });
    expect(failures).toHaveTextContent('Order O-MISSING');
    expect(failures).toHaveTextContent('"Unknown Product" has no matching Product');
    expect(failures).toHaveTextContent('use a unique SKU and retry');
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('rejects a cross-field name/SKU collision before bulk_import_order', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-CROSS,North Farm,Cross Identity,2,20',
    ].join('\n');
    const file = new File([csv], 'cross-field.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/cross-field\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-CROSS/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await screen.findByText(/successfully imported:/i);
    const failures = screen.getByRole('list', { name: /order import failure details/i });
    expect(failures).toHaveTextContent('"Cross Identity" has an ambiguous Product match');
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('uses a unique SKU to send the exact sibling UUID', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-SKU,North Farm,SKU-B,2,20',
    ].join('\n');
    const file = new File([csv], 'sku.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/sku\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-SKU/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.anything()));
    const args = mocks.rpc.mock.calls.find(([name]) => name === 'bulk_import_order')?.[1] as {
      p_items: Array<{ product_id: string; unit_cost?: number }>;
      p_status: string;
      p_total_cost: number;
    };
    expect(args.p_items[0].product_id).toBe('product-b');
    expect(args.p_items[0]).not.toHaveProperty('unit_cost');
    expect(args.p_total_cost).toBe(14);
    expect(args.p_status).toBe('confirmed');
  });

  it('submits cent-normalized totals and surfaces returned inventory warnings', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        order_id: 'order-warning',
        warnings: ['Same Name: need 3, net position is 0'],
      },
      error: null,
    });
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-CENTS,North Farm,SKU-B,3,0.105',
    ].join('\n');
    const file = new File([csv], 'cents.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/cents\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-CENTS/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.anything()));
    const args = mocks.rpc.mock.calls.find(([name]) => name === 'bulk_import_order')?.[1] as {
      p_total_price: number;
      p_total_cost: number;
      p_total_profit: number;
    };
    expect(args.p_total_price).toBe(0.33);
    expect(args.p_total_cost).toBe(21);
    expect(args.p_total_profit).toBe(-20.67);
    expect(mocks.toast).toHaveBeenCalledWith(
      'warning',
      'Inventory for imported order O-CENTS: Same Name: need 3, net position is 0',
    );
  });

  it('rejects a malformed explicit unit cost before bulk_import_order', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit,unit_cost',
      'O-BAD-COST,North Farm,SKU-B,2,20,not-a-number',
    ].join('\n');
    const file = new File([csv], 'bad-cost.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/bad-cost\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    expect(await screen.findByText(/invalid quantity, price, or unit cost/i)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('rejects a blank required price instead of coercing it to zero', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-BLANK-PRICE,North Farm,SKU-B,2,',
    ].join('\n');
    const file = new File([csv], 'blank-price.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/blank-price\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    expect(await screen.findByText(/invalid quantity, price, or unit cost/i)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('does not let an explicit zero override the authoritative Product cost', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit,unit_cost',
      'O-ZERO-COST,North Farm,SKU-B,2,20,0',
    ].join('\n');
    const file = new File([csv], 'zero-cost.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/zero-cost\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-ZERO-COST/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.anything()));
    const args = mocks.rpc.mock.calls.find(([name]) => name === 'bulk_import_order')?.[1] as {
      p_items: Array<{ unit_cost?: number }>;
      p_total_cost: number;
    };
    expect(args.p_items[0]).not.toHaveProperty('unit_cost');
    expect(args.p_total_cost).toBe(14);
  });

  it('rejects a terminal imported status before bulk_import_order', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = [
      'order_number,customer_name,status,product_name,quantity,price_per_unit',
      'O-FULFILLED,North Farm,fulfilled,SKU-B,2,20',
    ].join('\n');
    const file = new File([csv], 'fulfilled.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/fulfilled\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    expect(await screen.findByText(/only confirmed orders can be imported/i)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('keeps mixed-result failure details open while refreshing successful orders', async () => {
    const onSuccess = vi.fn();
    const onPartialSuccess = vi.fn();
    const { container } = render(
      <BulkOrderImport
        {...defaultProps}
        onSuccess={onSuccess}
        onPartialSuccess={onPartialSuccess}
      />,
    );
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-GOOD,North Farm,SKU-B,2,20',
      'O-BAD,North Farm,Same Name,2,20',
    ].join('\n');
    const file = new File([csv], 'mixed.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/mixed\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-GOOD/);
    fireEvent.click(screen.getByRole('button', { name: /import 2 orders/i }));

    const failures = await screen.findByRole('list', { name: /order import failure details/i });
    expect(failures).toHaveTextContent('Order O-BAD');
    expect(onPartialSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
