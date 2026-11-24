import { microToPctText } from '../../lib/fieldSplit';
import type { SplitVersion } from '../../lib/fieldSplitLoad';

export default function FieldSplitHistory({ history, inForceId }: { history: SplitVersion[]; inForceId: string | null }) {
  if (history.length === 0) return <p className="text-xs text-secondary">No split saved yet. Until one is, the owner pays 100%.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-secondary border-b border-gray-100">
            <th className="py-2 pr-3 font-medium">Version</th>
            <th className="py-2 pr-3 font-medium">Starts</th>
            <th className="py-2 pr-3 font-medium">Saved by</th>
            <th className="py-2 pr-3 font-medium">Who pays (product / application)</th>
          </tr>
        </thead>
        <tbody>
          {history.map((v) => {
            const imported = !v.history_known;
            return (
              <tr key={v.id} className="border-b border-gray-50 align-top">
                <td className="py-2 pr-3 whitespace-nowrap">
                  {v.version_number}
                  {v.id === inForceId && <span className="ml-2 text-xs text-emerald-700">in force</span>}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">{imported ? 'Imported' : v.effective_from}</td>
                <td className="py-2 pr-3">
                  {imported ? 'Imported' : v.created_by_name ?? 'Unknown'}
                  <div className="text-xs text-secondary">{new Date(v.created_at).toLocaleDateString()}</div>
                </td>
                <td className="py-2 pr-3">
                  {v.payers.map((p) => (
                    <div key={p.customer_id}>
                      {p.customer_name}: {microToPctText(p.product_share_micro_pct)}% / {microToPctText(p.application_share_micro_pct)}%
                    </div>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
