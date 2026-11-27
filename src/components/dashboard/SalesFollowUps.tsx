import { useState, type ReactNode } from 'react';
import { ClipboardList } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLoad, type LoadState } from '../../hooks/useLoad';
import { DEFAULT_STALE_QUOTE_DAYS, getCallListStaleQuotes, type StaleQuoteRow } from '../../lib/callLists';
import { localToday, parseLocalDate } from '../../lib/dateUtils';
import { supabase } from '../../lib/db';
import { hasPageAccess } from '../../lib/pagePermissions';
import { fetchAllRows, pageWithList } from '../../lib/pagedRead';
import { Sentry } from '../../lib/sentry';
import { toSentryError } from '../../lib/sentryError';
import type { Profile } from '../../types';
import QuickTaskModal from '../team/QuickTaskModal';
import Button from '../ui/Button';
import { LoadFailedState } from '../ui/EmptyState';
import SectionCard from '../ui/SectionCard';

const PREVIEW_SIZE = 6;
const linkClass = 'inline-flex min-h-11 max-w-full items-center rounded font-medium text-crx-green hover:underline focus-visible:ring-2 focus-visible:ring-crx-green';
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const contactDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });

async function readNames(ids: (string | null)[]) {
  const present = [...new Set(ids.filter((id): id is string => id !== null))];
  if (!present.length) return { names: new Map<string, string>(), error: null };
  const { data, error } = await supabase.from('profile_public_view').select('id, full_name')
    .in('id', present).eq('is_active', true).neq('role', 'entity_recipient');
  const names = new Map((data ?? []).flatMap((row) => row.id && row.full_name ? [[row.id, row.full_name] as const] : []));
  return { names, error };
}

function reportContextError(error: unknown) {
  if (error) Sentry.captureException(toSentryError(error), { tags: { action: 'load_sales_followup_details' } });
  return Boolean(error);
}

async function readStaleQuotes() {
  const page = await getCallListStaleQuotes(DEFAULT_STALE_QUOTE_DAYS, null);
  const rows = page.rows.slice(0, PREVIEW_SIZE);
  const [directory, callbacks] = await Promise.all([
    readNames(rows.map((row) => row.assigned_sales_rep)),
    readQuoteCallbacks(rows.map((row) => row.quote_id)),
  ]);
  return {
    rows, total: page.total, names: directory.names, byQuote: callbacks.byQuote,
    detailsUnavailable: reportContextError(directory.error ?? callbacks.error),
  };
}

async function readQuoteCallbacks(quoteIds: string[]) {
  const byQuote = new Map<string, string>();
  if (!quoteIds.length) return { byQuote, error: null };
  // A quote can already have a callback owned by another rep or awaiting assignment.
  const result = await fetchAllRows((from, to) => pageWithList(supabase.from('team_notes')
    .select('id, linked_entity_id', { count: 'exact' })
    .eq('note_type', 'todo').eq('is_completed', false).is('deleted_at', null)
    .eq('linked_entity_type', 'quote').in('linked_entity_id', quoteIds)
    .order('due_date', { nullsFirst: false }).order('id').range(from, to)));
  if (result.error || !result.data) return { byQuote, error: result.error ?? new Error('Missing quote callback list') };
  for (const row of result.data) {
    if (row.linked_entity_id && !byQuote.has(row.linked_entity_id)) byQuote.set(row.linked_entity_id, row.id);
  }
  return { byQuote, error: null };
}

async function readCallbacks(userId: string, isAdmin: boolean, entityTypes: string[]) {
  const result = await fetchAllRows((from, to) => {
    let query = supabase.from('team_notes')
      .select('id, title, due_date, assigned_to, linked_entity_type, linked_entity_id', { count: 'exact' })
      .eq('note_type', 'todo').eq('is_completed', false).is('deleted_at', null)
      .in('linked_entity_type', entityTypes).not('linked_entity_id', 'is', null);
    if (!isAdmin) query = query.eq('assigned_to', userId);
    return pageWithList(query.order('due_date', { nullsFirst: false }).order('id').range(from, to));
  });
  if (result.error || !result.data) throw result.error ?? new Error('Missing callback list');
  const all = result.data;
  const rows = all.slice(0, PREVIEW_SIZE);
  const farmIds = rows.flatMap((row) => row.linked_entity_type === 'customer' && row.linked_entity_id ? [row.linked_entity_id] : []);
  const quoteIds = rows.flatMap((row) => row.linked_entity_type === 'quote' && row.linked_entity_id ? [row.linked_entity_id] : []);
  const [directory, farms, quotes] = await Promise.all([
    readNames(rows.map((row) => row.assigned_to)),
    farmIds.length ? supabase.from('customers').select('id, farm_name').in('id', farmIds) : null,
    quoteIds.length ? supabase.from('quotes').select('id, quote_number, customer:customers(farm_name)').in('id', quoteIds).is('deleted_at', null) : null,
  ]);
  const detailsUnavailable = reportContextError(directory.error ?? farms?.error ?? quotes?.error);
  const farmNames = new Map(farms?.data?.map((row) => [row.id, row.farm_name]));
  const quoteDetails = new Map(quotes?.data?.map((row) => [row.id, row]));
  return { rows, total: all.length, names: directory.names, farmNames, quoteDetails, detailsUnavailable };
}

function assigneeLabel(id: string | null, names: Map<string, string>) {
  return id ? names.get(id) ?? 'Assignee unavailable' : 'Unassigned';
}

function dueLabel(dueDate: string | null, today: string) {
  if (!dueDate) return 'No due date';
  const day = dueDate.slice(0, 10);
  if (day === today) return 'Due today';
  const label = day < today ? 'Overdue' : 'Upcoming';
  return `${label} · ${shortDate.format(parseLocalDate(day))}`;
}

type CallbackListData = Awaited<ReturnType<typeof readCallbacks>>;

function CallbackRows({ list, today }: { list: CallbackListData; today: string }) {
  if (!list.total) return <p className="py-2 text-sm text-secondary">No open callbacks.</p>;
  return (
    <>
      <ul className="divide-y divide-gray-100">
        {list.rows.map((row) => {
          const id = row.linked_entity_id ?? '';
          const quote = row.linked_entity_type === 'quote' ? list.quoteDetails.get(id) : undefined;
          const farm = row.linked_entity_type === 'customer' ? list.farmNames.get(id) : quote?.customer?.farm_name;
          return (
            <li key={row.id} className="min-w-0 py-1">
              <Link className={`${linkClass} break-words`} to={`/team-board?note=${row.id}`}>{row.title}</Link>
              <p className="break-words pb-2 text-sm text-secondary">
                {farm ?? (row.linked_entity_type === 'quote' ? 'Quote' : 'Farm unavailable')}{quote && ` · #${quote.quote_number}`}
                {` · ${assigneeLabel(row.assigned_to, list.names)} · `}
                <span className={row.due_date && row.due_date.slice(0, 10) < today ? 'font-medium text-red-700' : undefined}>
                  {dueLabel(row.due_date, today)}
                </span>
              </p>
            </li>
          );
        })}
      </ul>
      {list.total > list.rows.length && <p className="pt-2 text-sm text-secondary">Showing {list.rows.length} of {list.total} open callbacks.</p>}
    </>
  );
}

function StaleQuoteRows({ list, refreshing, onSchedule }: {
  list: Awaited<ReturnType<typeof readStaleQuotes>>;
  refreshing: boolean;
  onSchedule: (row: StaleQuoteRow) => void;
}) {
  if (!list.total) return <p className="py-2 text-sm text-secondary">No stale quotes.</p>;
  return (
    <>
      <ul className="divide-y divide-gray-100">
        {list.rows.map((row) => {
          const task = list.byQuote.get(row.quote_id);
          return (
            <li key={row.quote_id} className="py-1">
              <Link className={`${linkClass} break-words`} to={`/quotes/${row.quote_id}`}>
                {row.farm_name || 'Unnamed farm'} · #{row.quote_number}
              </Link>
              <p className="break-words text-sm text-secondary">
                {assigneeLabel(row.assigned_sales_rep, list.names)} · {row.quote_age_days} days untouched
                {' · Last farm contact '}{row.last_interaction_at ? contactDate.format(new Date(row.last_interaction_at)) : 'never'}
              </p>
              {task ? (
                <Link className={`${linkClass} text-sm`} to={`/team-board?note=${task}`} aria-label={`Open callback for quote ${row.quote_number}`}>Open callback</Link>
              ) : (
                <Button variant="ghost" size="sm" className="min-h-11 px-0" disabled={refreshing || list.detailsUnavailable} onClick={() => onSchedule(row)}
                  aria-label={`Schedule callback for quote ${row.quote_number}`}>Schedule callback</Button>
              )}
            </li>
          );
        })}
      </ul>
      {list.total > list.rows.length && <p className="pt-2 text-sm text-secondary">Showing {list.rows.length} of {list.total} stale quotes.</p>}
    </>
  );
}

function FollowUpPanel({ title, link, state, subject, detailsUnavailable, children }: {
  title: string;
  link: { to: string; label: string };
  state: LoadState<unknown> & { reload: () => Promise<unknown> };
  subject: 'callbacks' | 'stale quotes';
  detailsUnavailable?: boolean;
  children: ReactNode;
}) {
  if (state.status === 'idle') return null;
  const failed = state.status === 'failed' || (state.status === 'loaded' && state.stale);
  return (
    <section className="min-w-0 px-4 pb-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <h3 className="font-semibold text-nav-dark">{title}</h3>
        <Link className={linkClass} to={link.to}>{link.label}</Link>
      </div>
      {state.status === 'loading' && <p role="status" className="py-2 text-sm text-secondary">Loading {subject}…</p>}
      {failed && <LoadFailedState title={`${subject === 'callbacks' ? 'Callbacks' : 'Stale quotes'} could not be loaded`}
        onRetry={() => void state.reload()} />}
      {detailsUnavailable && (
        <div className="flex flex-wrap items-center gap-x-2 text-sm text-secondary">
          <p role="status">Some details could not be loaded.</p>
          <Button variant="ghost" size="sm" className="min-h-11" onClick={() => void state.reload()}>Retry details</Button>
        </div>
      )}
      {children}
    </section>
  );
}

function freshData<T>(state: LoadState<T>): T | null {
  return state.status === 'loaded' && !state.stale ? state.data : null;
}

export default function SalesFollowUps({ profile, deniedPages }: { profile: Pick<Profile, 'id' | 'role'>; deniedPages: string[] }) {
  const { id: userId, role } = profile;
  const canOpenQuotes = hasPageAccess(role, deniedPages, 'quotes');
  const canOpenCustomers = hasPageAccess(role, deniedPages, 'customers');
  const canReadStaleQuotes = canOpenQuotes && hasPageAccess(role, deniedPages, 'call-lists');
  const isAdmin = role === 'admin';
  const entityTypes = [...(canOpenCustomers ? ['customer'] : []), ...(canOpenQuotes ? ['quote'] : [])];
  const staleQuotes = useLoad(canReadStaleQuotes ? `${userId}:${role}` : null, readStaleQuotes);
  const callbacks = useLoad(entityTypes.length ? `${userId}:${role}:${entityTypes.join(',')}` : null,
    () => readCallbacks(userId, isAdmin, entityTypes));
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);
  const today = localToday();
  const callbackData = freshData(callbacks);
  const quoteData = freshData(staleQuotes);
  const selectedQuote = quoteData?.rows.find((row) => row.quote_id === selectedQuoteId);
  const refreshLists = () => { void callbacks.reload(); void staleQuotes.reload(); };

  return (
    <SectionCard id="cockpit-sales-followups" title="Sales Follow-ups" icon={<ClipboardList className="h-5 w-5" />}>
      <div className="grid grid-cols-1 divide-y divide-gray-200 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <FollowUpPanel title={isAdmin ? 'Team callbacks' : 'My callbacks'} subject="callbacks" state={callbacks}
          detailsUnavailable={callbackData?.detailsUnavailable} link={{ to: '/team-board', label: 'Team Board' }}>
          {callbackData && <CallbackRows list={callbackData} today={today} />}
        </FollowUpPanel>
        <FollowUpPanel title="Stale quotes" subject="stale quotes" state={staleQuotes}
          detailsUnavailable={quoteData?.detailsUnavailable} link={{ to: '/call-lists?list=stale-quotes', label: 'View Call Lists' }}>
          {staleQuotes.status === 'loaded' && quoteData && (
            <StaleQuoteRows list={quoteData} refreshing={staleQuotes.refreshing} onSchedule={(row) => setSelectedQuoteId(row.quote_id)} />
          )}
        </FollowUpPanel>
      </div>
      {selectedQuote && quoteData && (
        <QuickTaskModal
          open callbackOnly
          entityType="quote" entityId={selectedQuote.quote_id}
          prefillTitle={`Follow up on quote #${selectedQuote.quote_number}`}
          prefillAssignee={selectedQuote.assigned_sales_rep && quoteData.names.has(selectedQuote.assigned_sales_rep) ? selectedQuote.assigned_sales_rep : ''}
          onCreated={refreshLists}
          onClose={(saved) => {
            setSelectedQuoteId(null);
            if (!saved) refreshLists();
          }}
        />
      )}
    </SectionCard>
  );
}
