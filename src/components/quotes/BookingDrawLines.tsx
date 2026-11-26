import { Fragment } from 'react';
import { PackageCheck } from 'lucide-react';
import Button from '../ui/Button';
import { formatUSD } from '../../lib/money';

export interface DrawRow {
  product_id: string;
  product_name: string;
  booked: number;
  drawn: number;
  remaining: number;
  qty: string;
  unit: string | null;
  // Item 10: a quantity over `remaining` is allowed; the extra is its own order at the price the
  // rep picks (20261029110000). The booked price is the last booked line's, as the server uses.
  bookedPrice: number | null;
  todayPrice: number | null;
  extraPrice: 'today' | 'booked';
}

interface BookingDrawLinesProps {
  rows: DrawRow[];
  onChange: (rows: DrawRow[]) => void;
  /** Locked while the order is created: a later change would not be in it. */
  drawing: boolean;
  /** Phones get one stacked card per product with a large box instead of the table. */
  stacked: boolean;
}

const withUnit = (n: number, unit: string | null) => `${n}${unit ? ` ${unit}` : ''}`;

/** What is typed over the booking's remaining balance, in whole hundredths. */
const overBy = (row: DrawRow) => Math.round(((parseFloat(row.qty) || 0) - row.remaining) * 100) / 100;

/**
 * The lines of the "Draw from booking" window: how much of each booked product to send now.
 * "Send all remaining" only fills the boxes; the rep still confirms with the window's own button.
 */
export default function BookingDrawLines({ rows, onChange, drawing, stacked }: BookingDrawLinesProps) {
  const setRow = (idx: number, patch: Partial<DrawRow>) => {
    const next = [...rows];
    next[idx] = { ...rows[idx], ...patch };
    onChange(next);
  };
  // Remaining is already settled to hundredths, so its text passes the 2-decimal draw rule.
  const fillAllRemaining = () => onChange(rows.map((r) => (r.remaining > 0 ? { ...r, qty: String(r.remaining) } : r)));
  const anyRemaining = rows.some((r) => r.remaining > 0);

  const extraChoice = (row: DrawRow, idx: number) => {
    const over = overBy(row);
    if (!(over > 0 && row.remaining > 0)) return null;
    return (
      <div className="text-xs text-secondary">
        <p>
          {withUnit(over, row.unit)} over the booking. Booked {row.bookedPrice != null ? formatUSD(row.bookedPrice) : 'not set'},
          {' '}today {row.todayPrice != null ? formatUSD(row.todayPrice) : 'not set'}. The extra goes on its own order at:
        </p>
        <div className="mt-1 flex flex-wrap gap-4">
          {(['today', 'booked'] as const).map((choice) => (
            <label key={choice} className={`inline-flex items-center gap-1 text-nav-dark ${stacked ? 'min-h-11' : ''}`}>
              <input
                type="radio"
                name={`extra-price-${row.product_id}`}
                checked={row.extraPrice === choice}
                disabled={drawing}
                onChange={() => setRow(idx, { extraPrice: choice })}
              />
              {choice === 'today' ? "Today's price" : 'Booked price'}
            </label>
          ))}
        </div>
      </div>
    );
  };

  const qtyInput = (row: DrawRow, idx: number) => (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      step="0.01"
      value={row.qty}
      disabled={drawing || row.remaining <= 0}
      onChange={(e) => setRow(idx, { qty: e.target.value })}
      aria-label={`Quantity to draw for ${row.product_name}`}
      className={stacked
        ? 'min-h-12 w-full min-w-0 flex-1 rounded-lg border border-gray-300 px-3 text-right text-base disabled:bg-gray-50'
        : 'w-24 px-2 py-1 text-sm text-right border border-gray-200 rounded-lg disabled:bg-gray-50'}
    />
  );

  const fillButton = anyRemaining && (
    <div className="flex justify-end">
      <Button
        variant="secondary"
        size="sm"
        icon={<PackageCheck className="w-4 h-4" />}
        onClick={fillAllRemaining}
        disabled={drawing}
        className={stacked ? 'min-h-11 w-full' : 'min-h-10'}
      >
        Send all remaining
      </Button>
    </div>
  );

  if (stacked) {
    return (
      <div className="space-y-3">
        {fillButton}
        <ul className="space-y-3">
          {rows.map((row, idx) => (
            <li key={row.product_id} className="space-y-2 rounded-lg border border-gray-200 p-3">
              <p className="font-medium text-nav-dark">{row.product_name}</p>
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <div><dt className="text-xs text-secondary">Booked</dt><dd>{withUnit(row.booked, row.unit)}</dd></div>
                <div><dt className="text-xs text-secondary">Drawn</dt><dd>{withUnit(row.drawn, row.unit)}</dd></div>
                <div><dt className="text-xs text-secondary">Remaining</dt><dd className="font-medium">{withUnit(row.remaining, row.unit)}</dd></div>
              </dl>
              <label className="block text-sm text-secondary">
                Send now
                <div className="mt-1 flex items-center gap-2">
                  {qtyInput(row, idx)}
                  {row.unit && <span className="text-sm text-secondary">{row.unit}</span>}
                </div>
              </label>
              {extraChoice(row, idx)}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {fillButton}
      <div className="max-h-80 overflow-y-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-secondary border-b">
              <th className="py-2 pr-2">Product</th>
              <th className="py-2 pr-2 text-right">Booked</th>
              <th className="py-2 pr-2 text-right">Drawn</th>
              <th className="py-2 pr-2 text-right">Remaining</th>
              <th className="py-2 text-right">Send now</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const choice = extraChoice(row, idx);
              return (
                <Fragment key={row.product_id}>
                  <tr className={choice ? '' : 'border-b last:border-0'}>
                    <td className="py-2 pr-2">{row.product_name}</td>
                    <td className="py-2 pr-2 text-right">{withUnit(row.booked, row.unit)}</td>
                    <td className="py-2 pr-2 text-right">{withUnit(row.drawn, row.unit)}</td>
                    <td className="py-2 pr-2 text-right font-medium">{withUnit(row.remaining, row.unit)}</td>
                    <td className="py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        {qtyInput(row, idx)}
                        {row.unit && <span className="text-xs text-secondary">{row.unit}</span>}
                      </div>
                    </td>
                  </tr>
                  {choice && (
                    <tr className="border-b last:border-0">
                      <td colSpan={5} className="pb-2">{choice}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
