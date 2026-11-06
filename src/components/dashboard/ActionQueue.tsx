import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Receipt,
  FileText,
  Truck,
  Package,
  Clock,
  User,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  ExternalLink,
  ListTodo,
} from 'lucide-react';
import { supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { LoadFailedState } from '../ui/EmptyState';
import { useAuth } from '../../contexts/AuthContext';
import QuickTaskModal from '../team/QuickTaskModal';
import type { ActionQueueItem, LinkedEntityType } from '../../types';

interface CategoryConfig {
  key: string;
  label: string;
  icon: React.ReactNode;
  bg: string;
  border: string;
  iconColor: string;
  textColor: string;
  entityPath: string;
  entityType: LinkedEntityType;
  highPriority?: boolean;
  formatSubtitle: (item: ActionQueueItem) => string;
}

const CATEGORIES: CategoryConfig[] = [
  {
    key: 'overdue_invoices',
    label: 'Overdue Invoices',
    icon: <Receipt className="w-4 h-4" />,
    bg: 'bg-red-50', border: 'border-red-200',
    iconColor: 'text-red-600', textColor: 'text-red-800',
    entityPath: '/invoices/',
    entityType: 'invoice',
    highPriority: true,
    formatSubtitle: (item) => {
      const amt = item.amount_cents
        ? '$' + (item.amount_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })
        : '';
      const days = item.days_overdue ? item.days_overdue + 'd overdue' : '';
      return [item.secondary_text, days, amt].filter(Boolean).join(' \u2014 ');
    },
  },
  {
    key: 'cancelled_posted',
    label: 'Cancelled + Posted Invoices',
    icon: <FileText className="w-4 h-4" />,
    bg: 'bg-red-50', border: 'border-red-200',
    iconColor: 'text-red-600', textColor: 'text-red-800',
    entityPath: '/orders/',
    entityType: 'order',
    highPriority: true,
    formatSubtitle: (item) => [item.secondary_text, item.invoice_number].filter(Boolean).join(' \u2014 '),
  },
  {
    key: 'overdue_deliveries',
    label: 'Overdue Deliveries',
    icon: <Truck className="w-4 h-4" />,
    bg: 'bg-orange-50', border: 'border-orange-200',
    iconColor: 'text-orange-600', textColor: 'text-orange-800',
    entityPath: '/deliveries/',
    entityType: 'delivery',
    highPriority: true,
    formatSubtitle: (item) => {
      const days = item.days_overdue ? item.days_overdue + 'd overdue' : '';
      return [item.secondary_text, days].filter(Boolean).join(' \u2014 ');
    },
  },
  {
    key: 'due_today_not_started',
    label: 'Due today \u2014 not started',
    icon: <Clock className="w-4 h-4" />,
    bg: 'bg-amber-50', border: 'border-amber-200',
    iconColor: 'text-amber-600', textColor: 'text-amber-800',
    entityPath: '/deliveries/',
    entityType: 'delivery',
    highPriority: true,
    formatSubtitle: (item) => {
      const date = item.scheduled_date
        ? new Date(item.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      return [item.secondary_text, date].filter(Boolean).join(' \u2014 ');
    },
  },
  {
    key: 'unbilled_deliveries',
    label: 'Delivered, not invoiced',
    icon: <FileText className="w-4 h-4" />,
    bg: 'bg-violet-50', border: 'border-violet-200',
    iconColor: 'text-violet-600', textColor: 'text-violet-800',
    entityPath: '/deliveries/',
    entityType: 'delivery',
    formatSubtitle: (item) => {
      const date = item.scheduled_date
        ? new Date(item.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      return [item.secondary_text, date].filter(Boolean).join(' \u2014 ');
    },
  },
  {
    key: 'low_stock',
    label: 'Low Stock Items',
    icon: <Package className="w-4 h-4" />,
    bg: 'bg-amber-50', border: 'border-amber-200',
    iconColor: 'text-amber-600', textColor: 'text-amber-800',
    entityPath: '/products/',
    entityType: 'product',
    formatSubtitle: (item) => {
      const qty = item.current_qty !== undefined ? item.current_qty + ' avail' : '';
      const rp = item.reorder_point ? 'reorder at ' + item.reorder_point : '';
      return [item.secondary_text, qty, rp].filter(Boolean).join(' \u2014 ');
    },
  },
  {
    key: 'expiring_quotes',
    label: 'Expiring Quotes',
    icon: <Clock className="w-4 h-4" />,
    bg: 'bg-yellow-50', border: 'border-yellow-200',
    iconColor: 'text-yellow-600', textColor: 'text-yellow-800',
    entityPath: '/quotes/',
    entityType: 'quote',
    formatSubtitle: (item) => {
      const days = item.days_until_expiry !== undefined ? 'expires in ' + item.days_until_expiry + 'd' : '';
      return [item.secondary_text, days].filter(Boolean).join(' \u2014 ');
    },
  },
  {
    key: 'unassigned_deliveries',
    label: 'Unassigned Deliveries',
    icon: <User className="w-4 h-4" />,
    bg: 'bg-sky-50', border: 'border-sky-200',
    iconColor: 'text-sky-600', textColor: 'text-sky-800',
    entityPath: '/deliveries/',
    entityType: 'delivery',
    formatSubtitle: (item) => {
      const date = item.scheduled_date
        ? new Date(item.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      return [item.secondary_text, date].filter(Boolean).join(' \u2014 ');
    },
  },
  {
    // U13 (#15-21/#111): the job-side sibling of unassigned_deliveries \u2014 a
    // scheduled job with no ACTIVE per-location dispatch (mission #17). Points
    // at the Jobs list, which now surfaces the same jobs via the "Needs
    // Dispatch" badge/quick-filter (see Jobs.tsx patch) so clicking through
    // lands on a page that explains WHY it's here.
    key: 'unassigned_jobs',
    label: 'Unassigned Jobs',
    icon: <Truck className="w-4 h-4" />,
    bg: 'bg-sky-50', border: 'border-sky-200',
    iconColor: 'text-sky-600', textColor: 'text-sky-800',
    entityPath: '/jobs/',
    entityType: 'job',
    formatSubtitle: (item) => {
      const date = item.scheduled_date
        ? new Date(item.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      return [item.secondary_text, date].filter(Boolean).join(' \u2014 ');
    },
  },
];

const DEFAULT_VISIBLE = 5;
// Example rows the dashboard asks for per group; the true size comes from the server's `counts`.
const ITEM_LIMIT = 10;

type ActionGroups = Record<string, ActionQueueItem[]>;

/**
 * How many items a group holds, less the ones dismissed this session. The server sends a true count
 * per group (H36). Without one (an older server) a full group of examples is a lower bound, shown as
 * "10+", never as a complete-looking 10.
 */
function groupCount(serverCount: number | undefined, loaded: number, dismissed: number): { count: number; atLeast: boolean } {
  if (typeof serverCount === 'number') return { count: Math.max(serverCount - dismissed, 0), atLeast: false };
  return { count: loaded - dismissed, atLeast: loaded >= ITEM_LIMIT };
}

export default function ActionQueue() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [data, setData] = useState<ActionGroups>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [taskModal, setTaskModal] = useState<{ open: boolean; entityType: LinkedEntityType; entityId: string; title: string; priority: 'high' | 'medium' }>({
    open: false, entityType: 'delivery', entityId: '', title: '', priority: 'medium',
  });
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      const stored = sessionStorage.getItem('crx-aq-dismissed');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const { data: result, error } = await supabase.rpc('get_dashboard_action_items', { p_limit: ITEM_LIMIT });
      if (error) throw error;
      const { counts: serverCounts, ...groups } = assertRpcResult<ActionGroups & { counts?: Record<string, number> }>(
        result, 'get_dashboard_action_items');
      setData(groups as ActionGroups);
      setCounts(serverCounts ?? {});
    } catch (err) {
      // A failed read must not look like "All Clear" (To-Do 10.5, Goal 4).
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'load_action_queue' } });
      setData({});
      setCounts({});
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toggleCategory = useCallback((key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const dismissItem = useCallback((itemId: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(itemId);
      try { sessionStorage.setItem('crx-aq-dismissed', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const openTaskForItem = useCallback((cat: CategoryConfig, item: ActionQueueItem) => {
    const subtitle = cat.formatSubtitle(item);
    setTaskModal({
      open: true,
      entityType: cat.entityType,
      entityId: item.id,
      title: `Action: ${item.primary_text}${subtitle ? ' \u2014 ' + subtitle : ''}`,
      priority: cat.highPriority ? 'high' : 'medium',
    });
  }, []);

  if (loading) {
    return (
      <div>
        <h2 className="text-sm font-semibold text-secondary uppercase tracking-wide mb-3">Action Queue</h2>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-14 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div>
        <h2 className="text-sm font-semibold text-secondary uppercase tracking-wide mb-3">Action Queue</h2>
        <LoadFailedState title="The action queue could not be loaded" onRetry={fetchData} />
      </div>
    );
  }

  const visibleCategories = CATEGORIES
    .map((cat) => {
      const loaded = data[cat.key] || [];
      const items = loaded.filter((item) => !dismissed.has(item.id));
      const { count, atLeast } = groupCount(counts[cat.key], loaded.length, loaded.length - items.length);
      return { ...cat, items, count, plus: atLeast ? '+' : '' };
    })
    .filter((cat) => cat.items.length > 0);

  const totalItems = visibleCategories.reduce((sum, cat) => sum + cat.count, 0);
  const totalPlus = visibleCategories.some((cat) => cat.plus) ? '+' : '';

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-secondary uppercase tracking-wide">
          Action Queue {totalItems > 0 && <span className="text-xs font-normal ml-1">({totalItems}{totalPlus})</span>}
        </h2>
      </div>

      {visibleCategories.length === 0 ? (
        <div className="flex items-center gap-3 p-4 bg-crx-green-tint rounded-xl border border-crx-green/20">
          <CheckCircle2 className="w-5 h-5 text-crx-green" />
          <p className="text-sm text-crx-green font-medium">All Clear &mdash; No action items</p>
        </div>
      ) : (
        <div className="space-y-2">
          {visibleCategories.map((cat) => {
            const isExpanded = expanded[cat.key] !== false;
            const visibleItems = isExpanded ? cat.items.slice(0, DEFAULT_VISIBLE) : [];
            const moreCount = cat.count - visibleItems.length;

            return (
              <div key={cat.key} className={`${cat.bg} border ${cat.border} rounded-xl overflow-hidden`}>
                <button
                  onClick={() => toggleCategory(cat.key)}
                  className="w-full flex items-center gap-3 p-3 text-left"
                >
                  <span className={cat.iconColor}>{cat.icon}</span>
                  <span className={`text-sm font-semibold ${cat.textColor} flex-1`}>
                    {cat.label} ({cat.count}{cat.plus})
                  </span>
                  {isExpanded
                    ? <ChevronDown className={`w-4 h-4 ${cat.iconColor}`} />
                    : <ChevronRight className={`w-4 h-4 ${cat.iconColor}`} />
                  }
                </button>

                {isExpanded && (
                  <div className="border-t border-white/50">
                    {visibleItems.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-white/50 transition-colors group"
                      >
                        <button
                          onClick={() => navigate(cat.entityPath + item.id)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <span className={`text-sm font-medium ${cat.textColor} truncate block`}>
                            {item.primary_text}
                          </span>
                          <span className={`text-xs ${cat.iconColor} truncate block opacity-80`}>
                            {cat.formatSubtitle(item)}
                          </span>
                        </button>
                        <button
                          onClick={() => navigate(cat.entityPath + item.id)}
                          className={`shrink-0 p-1 rounded ${cat.iconColor} opacity-0 group-hover:opacity-100 transition-opacity`}
                          aria-label={'Open ' + item.primary_text}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); openTaskForItem(cat, item); }}
                          className="shrink-0 p-1 rounded text-gray-400 hover:text-crx-green hover:bg-white/80 opacity-0 group-hover:opacity-100 transition-opacity"
                          aria-label={'Create task for ' + item.primary_text}
                          title="Create task"
                        >
                          <ListTodo className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); dismissItem(item.id); }}
                          className="shrink-0 text-xs px-1.5 py-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-white/80 opacity-0 group-hover:opacity-100 transition-opacity"
                          aria-label="Dismiss for today"
                        >
                          Dismiss
                        </button>
                      </div>
                    ))}
                    {moreCount > 0 && (
                      <div className={`text-center text-xs font-medium ${cat.iconColor} py-2`}>
                        {cat.plus ? `${moreCount}+` : `+${moreCount}`} more items
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <QuickTaskModal
        open={taskModal.open}
        onClose={() => setTaskModal((prev) => ({ ...prev, open: false }))}
        entityType={taskModal.entityType}
        entityId={taskModal.entityId}
        prefillTitle={taskModal.title}
        prefillAssignee={profile?.id}
      />
    </div>
  );
}
