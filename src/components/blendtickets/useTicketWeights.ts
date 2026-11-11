import { toSentryError } from '../../lib/sentryError';
import { useEffect, useMemo, useState } from 'react';
import { Sentry } from '../../lib/sentry';
import { fetchProductWeights, type ProductWeightsResult } from '../../lib/productWeights';
import {
  fetchBlendTicketWeights, headerEdited, matchesPageRead, resolveTicketLines, totalWeightText,
  type BlendTicketWeights, type ResolvedLine, type TicketLineInput,
} from '../../lib/blendTicketWeights';
import type { WeightTotalOptions } from '../../lib/blendWeightTotals';

type Read<T> = { status: 'loading' } | { status: 'failed'; why: string } | { status: 'ready'; data: T };
// One object, so a render while loading never hands the page a "new" result (which would re-run its checker).
const LOADING = { status: 'loading' } as const;

/** One async read tagged with the inputs it was made for, so a newer input never shows an older answer. */
function useTaggedRead<T>(tag: unknown, enabled: boolean, read: () => Promise<T>, context: string): Read<T> {
  const [state, setState] = useState<{ tag: unknown; read: Read<T> }>({ tag: undefined, read: LOADING });
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    read().then(
      (data) => { if (!cancelled) setState({ tag, read: { status: 'ready', data } }); },
      (error: unknown) => {
        Sentry.captureException(toSentryError(error), { level: 'warning', extra: { context } });
        if (!cancelled) setState({ tag, read: { status: 'failed', why: 'weights unavailable' } });
      },
    );
    return () => { cancelled = true; };
    // `read` closes over the same inputs `tag` names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, enabled, context]);
  return state.tag === tag ? state.read : LOADING;
}

interface TicketWeightArgs {
  /** The saved ticket's id; null on a new ticket. */
  ticketId: string | null;
  /** The ticket and lines exactly as the page last loaded them (a new object on every load and save). */
  pageRead: { header: Record<string, unknown>; lines: ReadonlyArray<Record<string, unknown>> } | null;
  /** The lines as they are on the page now (memoised by the caller). */
  lines: readonly TicketLineInput[];
  /** The header total and unit as the save would store them. */
  headerTotal: number | null;
  headerUnit: string | null;
}

export interface TicketWeights {
  status: 'loading' | 'ready' | 'unavailable';
  lines: ResolvedLine[];
  total: string;
  options: WeightTotalOptions;
}

/**
 * DM-2 sheet 4.4: each line's weight (saved with the ticket, or the current approved weight a save would use)
 * and what the checker needs for the ticket total. A failed or mismatched read shows "Weights unavailable".
 */
export function useTicketWeights({ ticketId, pageRead, lines, headerTotal, headerUnit }: TicketWeightArgs): TicketWeights {
  const productKey = useMemo(() => [...new Set(lines.map((line) => line.product_id).filter(Boolean))].sort().join(','), [lines]);
  // Re-read on every page load and save too, so a weight approved since the last save is the one shown.
  const currentTag = useMemo(() => ({ productKey, pageRead }), [productKey, pageRead]);
  const current = useTaggedRead<ProductWeightsResult>(currentTag, true,
    () => fetchProductWeights(productKey ? productKey.split(',') : []), 'blend_ticket_current_weights');
  // Tagged by ticket as well as page read, so another ticket's weights never show while this one loads.
  const savedTag = useMemo(() => ({ ticketId, pageRead }), [ticketId, pageRead]);
  const savedRead = useTaggedRead<BlendTicketWeights>(savedTag, Boolean(ticketId && pageRead),
    () => fetchBlendTicketWeights(ticketId as string), 'blend_ticket_saved_weights');

  return useMemo(() => {
    const saved: Read<BlendTicketWeights | null> = !ticketId ? { status: 'ready', data: null }
      : savedRead.status === 'ready' && pageRead && !matchesPageRead(savedRead.data, pageRead.header, pageRead.lines)
        ? { status: 'failed', why: 'the ticket changed while loading; reload to see them' }
        : savedRead;
    if (saved.status === 'loading' || current.status === 'loading') {
      return { status: 'loading', lines: [], total: '', options: { loading: true } };
    }
    if (saved.status === 'failed') {
      const resolved = resolveTicketLines(lines, { saved: null, current: null })
        .map((line) => ({ ...line, text: `Weights unavailable: ${saved.why}` }));
      return { status: 'unavailable', lines: resolved, total: `Total product weight not shown: ${saved.why}`,
        options: { unavailable: true, lines: resolved.map((line) => line.mapped) } };
    }
    const resolved = resolveTicketLines(lines, { saved: saved.data, current: current.status === 'ready' ? current.data : null });
    const mapped = resolved.map((line) => line.mapped);
    if (!saved.data && current.status !== 'ready') {
      return { status: 'unavailable', lines: resolved, total: totalWeightText(resolved), options: { unavailable: true, lines: mapped } };
    }
    const headerUnits = !saved.data ? (current.status === 'ready' ? current.data.units : null)
      : headerEdited(saved.data, headerTotal, headerUnit) ? saved.data.current_unit_factors : saved.data.basis_unit_factors;
    return { status: 'ready', lines: resolved, total: totalWeightText(resolved), options: { headerUnits, lines: mapped } };
  }, [ticketId, pageRead, savedRead, current, lines, headerTotal, headerUnit]);
}
