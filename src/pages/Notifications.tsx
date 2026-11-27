import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import EmptyState, { LoadFailedState } from '../components/ui/EmptyState';
import Input from '../components/ui/Input';
import PageHeader from '../components/ui/PageHeader';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { sanitizeError, supabase, checkMutationResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { fetchAllRows } from '../lib/pagedRead';
import { withSenderNames } from '../lib/activityLogger';
import type { Notification as NotificationType } from '../types';
import { toSentryError } from '../lib/sentryError';

export default function Notifications() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<NotificationType[]>([]);
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  // The last load failed: an error shows instead of "You're all caught up!".
  const [loadFailed, setLoadFailed] = useState(false);
  // Only the newest load may set state.
  const loadSeq = useRef(0);
  // Whose notifications are on screen (null: nobody's).
  const shownProfileId = useRef<string | null>(null);

  const fetchNotifications = useCallback(async () => {
    // A new person (or none) supersedes any read still in flight, and the last
    // person's list leaves the screen at once rather than when the new read lands.
    const seq = ++loadSeq.current;
    if (shownProfileId.current !== (profile?.id ?? null)) {
      shownProfileId.current = profile?.id ?? null;
      setNotifications([]);
      setLoadFailed(false);
    }
    // Guard: Ensure profile is loaded
    if (!profile) {
      setLoading(false);
      return;
    }

    // Every notification, newest first, page by page: the page showed only the
    // newest 200 while some staff have over 1,000 unread (2026-10-20).
    const { data, error } = await fetchAllRows<NotificationType>((from, to) => supabase
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, to));
    const rows = error ? [] : await withSenderNames((data || []) as NotificationType[]);
    if (seq !== loadSeq.current) return;
    if (error) {
      Sentry.captureException(error, { extra: { context: 'load_notifications' } });
      setNotifications([]);
      setLoadFailed(true);
    } else {
      setNotifications(rows);
      setLoadFailed(false);
    }
    setLoading(false);
  }, [profile]);

  useEffect(() => {
    // Runs signed out too, so the last person's notifications are cleared.
    fetchNotifications();
  }, [profile, fetchNotifications]);

  const markAsRead = async (notification: NotificationType) => {
    if (!notification.is_read) {
      try {
        const readResult = await supabase
          .from('notifications')
          .update({ is_read: true })
          .eq('id', notification.id)
          .select();
        checkMutationResult(readResult, 'Mark notification as read');
        setNotifications((prev) =>
          prev.map((n) => (n.id === notification.id ? { ...n, is_read: true } : n))
        );
      } catch (err: unknown) {
        Sentry.captureException(toSentryError(err), { extra: { context: 'mark_notification_read' } });
        toast('error', sanitizeError(err));
      }
    }
    if (notification.related_entity_type && notification.related_entity_id) {
      // Team notes live on the board behind a query param, not a /:id route
      // (mirrors NotificationsPanel — covers 'mention' and 'task_assigned').
      if (notification.related_entity_type === 'team_note') {
        navigate(`/team-board?note=${notification.related_entity_id}`);
        return;
      }
      const routes: Record<string, string> = {
        quote: '/quotes',
        order: '/orders',
        delivery: '/deliveries',
        purchase_order: '/purchase-orders',
        invoice: '/invoices',
        payment: '/payments',
        return: '/returns',
        job: '/jobs',
        product: '/products',
        customer: '/customers',
        commission: '/commission-payments',
        blend_ticket: '/blend-tickets',
      };
      const base = routes[notification.related_entity_type];
      if (base) navigate(`${base}/${notification.related_entity_id}`);
    }
  };

  const markAllRead = async () => {
    // Guard: Ensure profile is loaded
    if (!profile) return;
    // No unread notifications — nothing to do. Skip the call so the
    // zero-rows-affected outcome below doesn't surface a false error toast.
    if (!notifications.some((n) => !n.is_read)) return;

    try {
      const markAllResult = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', profile.id)
        .eq('is_read', false)
        .select();
      // Zero rows is a valid outcome here (a concurrent read may have already
      // cleared them), so only a real error counts as failure — do NOT use
      // checkMutationResult, which treats an empty result array as denial.
      if (markAllResult.error) throw markAllResult.error;
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    } catch (err: unknown) {
      Sentry.captureException(toSentryError(err), { extra: { context: 'mark_all_notifications_read' } });
      toast('error', sanitizeError(err));
    }
  };

  const unreadCount = notifications.filter((n) => !n.is_read).length;
  const query = search.trim().toLowerCase();
  const filtered = unreadOnly || Boolean(query);
  const visibleNotifications = filtered ? notifications.filter((n) =>
    (!unreadOnly || !n.is_read)
    && (!query || [n.title, n.message, n.sender_name].some((value) => value?.toLowerCase().includes(query)))
  ) : notifications;

  const clearFilters = () => {
    setSearch('');
    setUnreadOnly(false);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your"
        accent="Notifications"
        subtitle={loadFailed ? undefined : `${unreadCount.toLocaleString()} unread · ${notifications.length.toLocaleString()} total`}
        actions={unreadCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-10"
            icon={<CheckCheck className="w-4 h-4" />}
            showChevron={false}
            onClick={markAllRead}
          >
            Mark All Read
          </Button>
        )}
      />

      {notifications.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-72">
            <Input
              type="search"
              aria-label="Search notifications"
              placeholder="Search notifications…"
              className="min-h-11 max-md:text-base"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Button
            variant="secondary"
            className={`min-h-11 md:min-h-10 ${unreadOnly ? 'bg-crx-green-light! text-crx-green!' : ''}`}
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly(!unreadOnly)}
          >
            Unread only
          </Button>
          <p role="status" className="text-sm text-secondary">
            {filtered ? `${visibleNotifications.length.toLocaleString()} matching` : ''}
          </p>
        </div>
      )}

      {loadFailed ? (
        <Card>
          <LoadFailedState title="Notifications could not be loaded" onRetry={() => void fetchNotifications()} />
        </Card>
      ) : notifications.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BellOff className="w-6 h-6 text-gray-400" />}
            title="No notifications"
            description="You're all caught up!"
          />
        </Card>
      ) : visibleNotifications.length === 0 ? (
        <Card>
          <EmptyState
            title="No matching notifications"
            action={<Button variant="secondary" onClick={clearFilters}>Clear filters</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {visibleNotifications.map((n) => (
            <NotificationCard key={n.id} notification={n} onOpen={markAsRead} />
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationCard({
  notification: n,
  onOpen,
}: {
  notification: NotificationType;
  onOpen: (notification: NotificationType) => void;
}) {
  return (
    <Card
      role="button"
      tabIndex={0}
      hover
      className={`cursor-pointer ${!n.is_read ? 'border-crx-green/30 bg-crx-green-tint/30' : ''}`}
      onClick={() => onOpen(n)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(n); } }}
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
            n.is_read ? 'bg-gray-100' : 'bg-crx-green-light'
          }`}
        >
          <Bell className={`w-5 h-5 ${n.is_read ? 'text-gray-400' : 'text-crx-green'}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className={`min-w-0 break-words text-sm ${n.is_read ? 'text-secondary' : 'font-medium text-nav-dark'}`}>
              {n.title}
            </h4>
            {!n.is_read && (
              <span className="w-2 h-2 rounded-full bg-crx-green shrink-0">
                <span className="sr-only">Unread</span>
              </span>
            )}
          </div>
          <p className={`text-xs text-secondary mt-0.5 break-words ${n.notification_type === 'delivery_issue_reported' ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>{n.message}</p>
          {n.sender_name && <p className="text-xs text-secondary mt-0.5">From {n.sender_name}</p>}
          <p className="text-xs text-gray-400 mt-1">
            {new Date(n.created_at).toLocaleString()}
          </p>
        </div>
      </div>
    </Card>
  );
}
