import { useCallback, useEffect, useState } from 'react';
import { Users, ClipboardList } from 'lucide-react';
import { supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import Badge from '../ui/Badge';
import Card from '../ui/Card';
import EmptyState, { LoadFailedState } from '../ui/EmptyState';
import { toSentryError } from '../../lib/sentryError';

interface TeamMemberWorkload {
  id: string;
  full_name: string | null;
  role: string;
  open_tasks: number;
  overdue_tasks: number;
  today_deliveries: number;
  week_deliveries: number;
}

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  sales_rep: 'Sales rep',
  driver: 'Driver',
  applicator: 'Applicator',
};

export default function WorkloadView() {
  const [members, setMembers] = useState<TeamMemberWorkload[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const { data, error } = await supabase.rpc('get_team_workload');
      if (error) throw error;
      setMembers(assertRpcResult<TeamMemberWorkload[]>(data, 'get_team_workload'));
    } catch (err: unknown) {
      Sentry.captureException(toSentryError(err), { extra: { context: 'WorkloadView.load' } });
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="space-y-2" role="status" aria-label="Loading workload">
        {[0, 1, 2].map(row => <div key={row} className="h-16 rounded-lg bg-gray-100 motion-safe:animate-pulse" />)}
      </div>
    );
  }
  if (failed) {
    return (
      <Card><LoadFailedState title="Workload could not load" onRetry={load} /></Card>
    );
  }
  if (!members.length) {
    return <Card><EmptyState icon={<Users className="size-6" />} title="No team members to show" /></Card>;
  }

  const sorted = [...members].sort((a, b) =>
    b.overdue_tasks - a.overdue_tasks || b.open_tasks - a.open_tasks ||
    (a.full_name ?? '').localeCompare(b.full_name ?? ''),
  );
  const totalOverdue = sorted.reduce((sum, member) => sum + member.overdue_tasks, 0);
  const totalOpen = sorted.reduce((sum, member) => sum + member.open_tasks, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-secondary">
        <span className="flex items-center gap-2"><Users className="size-4" />{sorted.length} team {sorted.length === 1 ? 'member' : 'members'}</span>
        <span className="flex items-center gap-2"><ClipboardList className="size-4 text-crx-green" />{totalOpen} open tasks</span>
        <span className={totalOverdue > 0 ? 'font-medium text-red-700' : undefined}>{totalOverdue} overdue</span>
      </div>
      <ul className="space-y-2">
        {sorted.map(member => (
          <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-white px-4 py-3">
            <div className="min-w-0">
              <h3 className="break-words text-sm font-medium text-nav-dark">{member.full_name || 'Unnamed team member'}</h3>
              <p className="text-xs text-secondary">{roleLabels[member.role] ?? member.role}</p>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums text-secondary">
              <span>{member.open_tasks} open</span>
              {member.open_tasks >= 3 && (
                <Badge variant={member.open_tasks >= 6 ? 'error' : 'warning'}>{member.open_tasks >= 6 ? 'Heavy' : 'Moderate'}</Badge>
              )}
              <Badge variant={member.overdue_tasks > 0 ? 'error' : 'default'} normalCase>{member.overdue_tasks} overdue</Badge>
              {(member.role === 'driver' || member.week_deliveries > 0 || member.today_deliveries > 0) && (
                <span>{member.today_deliveries} {member.today_deliveries === 1 ? 'delivery' : 'deliveries'} today · {member.week_deliveries} this week</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
