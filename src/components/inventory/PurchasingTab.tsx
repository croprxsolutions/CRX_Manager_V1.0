import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import { LoadFailedState } from '../ui/EmptyState';
import { useToast } from '../ui/Toast';
import { supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';

// Read-only view of get_purchasing_plan (20270127110000). Quantities are in each product's stock unit.
type Qty = number | string;
interface Suggestion { need_date: string; order_by: string; order_now: boolean; quantity: Qty }
interface DemandRow { kind: 'booking' | 'order' | 'job' | 'hold'; class: 'committed' | 'could_add' | 'shown';
  bucket: string; need_date: string | null; overdue: boolean; raw_date: string | null; quantity: Qty; confidence: string | null;
  estimated: boolean | null; quote_number: string | null; order_number: string | null; job_number: string | null;
  customer_name: string | null; section_name: string | null }
interface PlanPo { po_id: string; po_number: string; status: string; expected_date: string | null; flag: string; quantity: Qty }
interface PlanProduct { product_id: string; product_name: string; stock_unit: string | null; on_hand: Qty;
  incoming: Qty; drafted: Qty; committed: Qty; suggested: Qty; could_add: Qty; over_drawn: Qty;
  not_complete: boolean; reasons: string[] | null; suggestions: Suggestion[]; rows: DemandRow[];
  purchase_orders: PlanPo[] }
interface BookingRef { quote_number: string; customer_name: string | null; product_name: string; quantity: Qty; section_name?: string | null }
interface ReviewRow { quote_id: string; section_id: string; quote_number: string; customer_name: string;
  section_name: string; timing: string | null; confidence: string | null; needed_by_date: string | null; window_end: string }
export interface PurchasingPlan { today: string; lead_days: number; months_ahead: number; horizon_end: string;
  firm_needs_date: BookingRef[]; drawn_section_unknown: BookingRef[]; review: ReviewRow[]; products: PlanProduct[] }

const REASONS: Record<string, string> = {
  needs_date: 'firm need without a date',
  check_units: 'a line in a unit that does not match stock',
  later: 'committed need beyond the plan window',
  over_drawn: 'drawn more than booked',
  late_po: 'a PO is past its expected date',
  undated_po: 'a PO has no expected date',
};
const TIMING: Record<string, string> = { pre_plant: 'Pre-plant', in_season: 'In season', late_summer: 'Late summer' };
const CLASS: Record<string, string> = { committed: 'Committed', could_add: 'Could add', shown: 'Maybe (shown only)' };

const num = (q: Qty) => Number(q);
// A positive amount under the shown precision reads "<0.001", never "0".
const qty = (q: Qty) => (num(q) > 0 && num(q) < 0.0005 ? '<0.001' : num(q).toLocaleString('en-US', { maximumFractionDigits: 3 }));
const day = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

// eslint-disable-next-line react-refresh/only-export-components -- exported for its unit test
export function suggestionText(s: Suggestion, unit: string | null): string {
  const n = `${qty(s.quantity)}${unit ? ` ${unit}` : ''}`;
  const order = s.order_now ? `Order ${n} now` : `Order ${n} by ${day(s.order_by)}`;
  return `${order} (needed ${day(s.need_date)})`;
}

function sourceOf(r: DemandRow): string {
  if (r.kind === 'order') return `Order ${r.order_number ?? ''}`;
  if (r.kind === 'job') return `Job ${r.job_number ?? ''}`;
  if (r.kind === 'hold') return 'Stock hold';
  return `Booking ${r.quote_number ?? ''}${r.section_name ? ` · ${r.section_name}` : ''}`;
}

// The expanded row of one product: suggestions, notes, demand rows and its POs.
function ProductDetails({ p }: { p: PlanProduct }) {
  return (
    <>
      {p.suggestions.length > 0 && (
        <ul className="space-y-1">{p.suggestions.map((s, i) => <li key={i} className="font-medium text-red-700">{suggestionText(s, p.stock_unit)}</li>)}</ul>
      )}
      {num(p.drafted) > 0 && <p className="text-secondary">Drafted on unsent POs: {qty(p.drafted)} (not counted).</p>}
      {num(p.over_drawn) > 0 && <p className="text-amber-700">Over-drawn: {qty(p.over_drawn)} drawn beyond what was booked.</p>}
      {(p.reasons ?? []).length > 0 && <p className="text-amber-700">Not complete: {(p.reasons ?? []).map((r) => REASONS[r] ?? r).join('; ')}.</p>}
      {p.rows.length > 0 && (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-secondary">
            <th className="py-1 pr-3 font-medium">Need date</th><th className="py-1 pr-3 font-medium">Source</th>
            <th className="py-1 pr-3 font-medium">Grower</th><th className="py-1 pr-3 font-medium">Class</th>
            <th className="py-1 pr-3 text-right font-medium">Quantity</th>
          </tr></thead>
          <tbody>
            {p.rows.map((r, i) => (
              <tr key={i} className="border-t border-gray-200">
                <td className="py-1 pr-3">
                  {r.bucket === 'needs_date' ? 'Needs date' : r.bucket === 'check_units' ? 'Check units' : r.bucket === 'later' ? `Later (${day(r.need_date)})` : r.overdue ? `${day(r.raw_date)} · overdue` : day(r.need_date)}
                </td>
                <td className="py-1 pr-3">{sourceOf(r)}{r.estimated && ' (estimated)'}</td>
                <td className="py-1 pr-3">{r.customer_name ?? '—'}</td>
                <td className="py-1 pr-3">{CLASS[r.class] ?? r.class}</td>
                <td className="py-1 pr-3 text-right font-mono">{qty(r.quantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.purchase_orders.length > 0 && (
        <ul className="text-xs text-secondary space-y-0.5">
          {p.purchase_orders.map((po, i) => (
            <li key={i}>
              PO {po.po_number}: {qty(po.quantity)} {po.flag === 'draft' ? '(draft, not counted)' : po.flag === 'undated' ? '(no expected date, not counted)'
                : po.flag === 'late' ? `(was due ${day(po.expected_date)}, counted today)` : po.flag === 'later' ? `(due ${day(po.expected_date)}, after the plan window)` : `due ${day(po.expected_date)}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function PurchasingTab() {
  const { toast } = useToast();
  const [plan, setPlan] = useState<PurchasingPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_purchasing_plan', { p_months_ahead: 6 });
      if (id !== requestId.current) return;
      if (error) throw error;
      const result = assertRpcResult<PurchasingPlan>(data, 'get_purchasing_plan');
      if (!result || ![result.products, result.firm_needs_date, result.drawn_section_unknown, result.review].every(Array.isArray)) {
        throw new Error('get_purchasing_plan returned no plan');
      }
      setPlan(result);
      setFailed(false);
    } catch (loadErr) {
      if (id !== requestId.current) return;
      Sentry.captureException(loadErr, { tags: { source: 'fetch', page: 'inventory-purchasing' } });
      toast('error', 'Failed to load the purchasing plan');
      setPlan(null);
      setFailed(true);
    }
    setLoading(false);
  }, [toast]);

  // Leaving the tab retires the request in flight, so a late reply neither renders nor toasts.
  useEffect(() => { load(); return () => { requestId.current += 1; }; }, [load]);

  if (loading && !plan) {
    return (
      <Card>
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />)}</div>
      </Card>
    );
  }
  if (failed || !plan) {
    return <Card><LoadFailedState title="The purchasing plan could not be loaded" onRetry={load} /></Card>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-lg font-semibold text-nav-dark">Purchasing</h3>
            <p className="text-sm text-secondary">
              Read-only buy plan through {day(plan.horizon_end)}. Order-by dates are {plan.lead_days} days before the need. Quantities are in each product's stock unit.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={load} loading={loading}>Refresh</Button>
        </div>
      </Card>

      {plan.firm_needs_date.length > 0 && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800" role="alert">
          <p className="font-semibold">
            <AlertTriangle className="w-4 h-4 inline mr-2" />
            Firm, needs a date: {plan.firm_needs_date.length} booking {plan.firm_needs_date.length === 1 ? 'line' : 'lines'}. The buy plan is incomplete until these get a needed-by date.
          </p>
          <ul className="mt-2 space-y-1">
            {plan.firm_needs_date.map((r, i) => (
              <li key={i}>{[r.customer_name, `Booking ${r.quote_number}`, r.section_name, r.product_name].filter(Boolean).join(' · ')}: {qty(r.quantity)}</li>
            ))}
          </ul>
        </div>
      )}

      {plan.drawn_section_unknown.length > 0 && (
        <Card>
          <h4 className="font-semibold text-nav-dark">Drawn, section unknown</h4>
          <p className="text-sm text-secondary mb-2">
            Already drawn from these bookings by orders or jobs that do not record which section they came from. The plan takes it off each booking's least certain lines first (Maybe, then Likely or not set, then Firm), latest-needed first within each (estimated).
          </p>
          <ul className="text-sm space-y-1">
            {plan.drawn_section_unknown.map((r, i) => (
              <li key={i}>{r.customer_name} · Booking {r.quote_number} · {r.product_name}: {qty(r.quantity)}</li>
            ))}
          </ul>
        </Card>
      )}

      {plan.review.length > 0 && (
        <Card>
          <h4 className="font-semibold text-nav-dark">Review: booking sections near the end of their window</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-secondary">
                  <th className="px-3 py-2 font-medium">Grower</th><th className="px-3 py-2 font-medium">Booking</th>
                  <th className="px-3 py-2 font-medium">Section</th><th className="px-3 py-2 font-medium">Timing</th>
                  <th className="px-3 py-2 font-medium">Confidence</th><th className="px-3 py-2 font-medium">Needed by</th>
                  <th className="px-3 py-2 font-medium">Window ends</th>
                </tr>
              </thead>
              <tbody>
                {plan.review.map((r) => (
                  <tr key={r.section_id} className="border-b border-gray-50">
                    <td className="px-3 py-2">{r.customer_name}</td><td className="px-3 py-2">{r.quote_number}</td>
                    <td className="px-3 py-2">{r.section_name}</td><td className="px-3 py-2">{r.timing ? TIMING[r.timing] ?? r.timing : '—'}</td>
                    <td className="px-3 py-2 capitalize">{r.confidence ?? 'not set'}</td>
                    <td className="px-3 py-2">{day(r.needed_by_date)}</td><td className="px-3 py-2">{day(r.window_end)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card>
        {plan.products.length === 0 ? (
          <p className="text-sm text-secondary py-8 text-center">Nothing to buy: no bookings, orders, jobs, holds or open POs in the plan window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-secondary">
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-right font-medium">On hand (Main Warehouse)</th>
                  <th className="px-3 py-2 text-right font-medium">Incoming</th>
                  <th className="px-3 py-2 text-right font-medium">Committed</th>
                  <th className="px-3 py-2 text-right font-medium">To buy</th>
                  <th className="px-3 py-2 text-right font-medium">Could add</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {plan.products.map((p) => {
                  const isOpen = open === p.product_id;
                  return (
                    <Fragment key={p.product_id}>
                      <tr className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="px-3 py-2">
                          <span className="font-medium text-nav-dark">{p.product_name}</span>
                          {p.stock_unit && <span className="text-secondary"> ({p.stock_unit})</span>}
                          {p.not_complete && <Badge variant="warning" className="ml-2">not complete</Badge>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{qty(p.on_hand)}</td>
                        <td className="px-3 py-2 text-right font-mono">{qty(p.incoming)}</td>
                        <td className="px-3 py-2 text-right font-mono">{qty(p.committed)}</td>
                        <td className={`px-3 py-2 text-right font-mono ${num(p.suggested) > 0 ? 'text-red-600 font-bold' : ''}`}>{qty(p.suggested)}</td>
                        <td className="px-3 py-2 text-right font-mono">{qty(p.could_add)}</td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => setOpen(isOpen ? null : p.product_id)} aria-expanded={isOpen}
                            aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${p.product_name}`} className="text-secondary hover:text-nav-dark p-1">
                            {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-gray-50">
                          <td colSpan={7} className="px-4 py-3 space-y-3">
                            <ProductDetails p={p} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
