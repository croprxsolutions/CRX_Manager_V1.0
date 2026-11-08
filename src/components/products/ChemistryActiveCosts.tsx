import { useEffect, useState } from 'react';
import Button from '../ui/Button';
import Select from '../ui/Select';
import { LoadFailedState } from '../ui/EmptyState';
import { useToast } from '../ui/Toast';
import { Sentry } from '../../lib/sentry';
import { BASIS_LABEL, centsText, costReasonText, fetchActiveCostsWithVersion, nutrientLabel, startChemistrySave } from '../../lib/productChemistry';
import { errorOf, reportSaveError, type SaveOutcome } from './chemistryFormHelpers';
import type { ActiveCostRow, ParentActiveCosts, ParentChemistry } from '../../types';

function FigureLine({ row, pricedUnit }: { row: ActiveCostRow; pricedUnit: string | null }) {
  const name = row.kind === 'fertilizer' && row.nutrient ? nutrientLabel(row.nutrient, row.figure.basis) : row.name;
  const text = (figure: ActiveCostRow['figure']) => ('cents' in figure
    ? `${centsText(figure.cents)} per lb ${BASIS_LABEL[figure.basis]}`
    : `${BASIS_LABEL[figure.basis]}: ${costReasonText(figure.reason, pricedUnit)}`);
  return (
    <li>
      <span className="text-nav-dark">{name}:</span> {text(row.figure)}
      {row.converted && <span className="text-secondary"> · {text(row.converted)}</span>}
    </li>
  );
}

function referenceText(costs: ParentActiveCosts, refName: string | undefined): string {
  if (costs.reference.source === 'bulk' && refName) return `Figures use the bulk size, ${refName}.`;
  if (costs.reference.source === 'picked' && refName) return `Figures use the picked size, ${refName}.`;
  return `No figures for the product: ${costReasonText(costs.reference.reason ?? 'REFERENCE_UNSET')}.`;
}

/** Cost per lb of active (admin only; computed by the database, display only). */
export default function ChemistryActiveCosts({ chem, profileId, reloadKey, pending, onSaveSettled }: {
  chem: ParentChemistry; profileId: string; reloadKey: string; pending: boolean; onSaveSettled: (outcome: SaveOutcome) => void;
}) {
  const { toast } = useToast();
  const [loaded, setLoaded] = useState<{ forKey: string; status: 'failed' } | { forKey: string; status: 'loaded'; costs: ParentActiveCosts; refVersion: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState('');
  const [saving, setSaving] = useState(false);
  const forKey = JSON.stringify([chem.parent_id, reloadKey, attempt]);
  const state = loaded?.forKey === forKey ? loaded : null;
  useEffect(() => {
    let cancelled = false;
    fetchActiveCostsWithVersion(chem.parent_id).then(({ costs, refVersion }) => {
      if (cancelled) return;
      setLoaded({ forKey, status: 'loaded', costs, refVersion });
      setPicked(costs.reference.source === 'picked' ? costs.reference.product_id ?? '' : '');
    }).catch((error: unknown) => {
      Sentry.captureException(errorOf(error), { extra: { context: 'get_parent_active_costs' } });
      if (!cancelled) setLoaded({ forKey, status: 'failed' });
    });
    return () => { cancelled = true; };
  }, [chem.parent_id, forKey]);

  if (!state) return <p className="text-sm text-secondary" role="status">Loading cost per lb of active…</p>;
  if (state.status === 'failed') return <LoadFailedState title="Cost per lb of active could not be loaded" onRetry={() => setAttempt((n) => n + 1)} />;
  const { costs, refVersion } = state;
  const refSize = costs.sizes.find((size) => size.product_id === costs.reference.product_id);
  const current = costs.reference.source === 'picked' ? costs.reference.product_id ?? '' : '';

  const saveReference = async () => {
    setSaving(true);
    try {
      await startChemistrySave(profileId, chem.parent_id, 'set_parent_cost_reference', {
        p_parent_id: chem.parent_id, p_reference_product_id: picked || null, p_expected_row_version: refVersion,
      }, `Cost reference size on ${chem.parent_name}`);
      toast('success', 'Reference size saved');
      setAttempt((n) => n + 1);
      onSaveSettled('saved');
    } catch (error) {
      const outcome = reportSaveError(error, toast);
      if (outcome === 'stale') setAttempt((n) => n + 1);
      onSaveSettled(outcome);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-2 border-t border-gray-200 pt-3 text-sm" data-testid="active-costs">
      <h4 className="font-medium text-nav-dark">Cost per lb of active <span className="font-normal text-secondary">({costs.label})</span></h4>
      {chem.product_form === 'liquid' && (
        <p className="text-secondary">
          Weight per gallon: {'lb_per_gal' in costs.density ? `${costs.density.lb_per_gal} lb/gal (approved)` : costReasonText(costs.density.reason)}
        </p>
      )}
      <p className="text-secondary">{referenceText(costs, refSize?.product_name)}</p>
      {costs.reference.source !== 'bulk' && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <Select id="cost-reference" label="Reference size (no active bulk size)" value={picked} disabled={saving || pending}
              options={[{ value: '', label: 'None' }, ...costs.sizes.filter((size) => size.is_active).map((size) => ({ value: size.product_id, label: size.product_name }))]}
              onChange={(event) => setPicked(event.target.value)} />
          </div>
          <Button size="sm" onClick={() => void saveReference()} loading={saving} disabled={pending || picked === current}>Save reference</Button>
        </div>
      )}
      {costs.parent_figures && (costs.parent_figures.length > 0
        ? <ul className="space-y-0.5">{costs.parent_figures.map((row) => <FigureLine key={row.row_id} row={row} pricedUnit={refSize?.priced_unit ?? null} />)}</ul>
        : <p className="text-secondary">No ingredients or nutrients recorded.</p>)}
      {costs.sizes.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-nav-dark">Each size</summary>
          <ul className="space-y-2">
            {costs.sizes.map((size) => (
              <li key={size.product_id} className="rounded-lg border border-gray-200 px-3 py-2">
                <div className="font-medium text-nav-dark">
                  {size.product_name}{size.is_active ? '' : ' (inactive)'}
                  <span className="font-normal text-secondary">
                    {' '}· {size.cost_per_base ? `${centsText(size.cost_per_base.cents)} per ${size.cost_per_base.base}` : costReasonText(size.cost_reason ?? '', size.priced_unit)}
                  </span>
                </div>
                {size.figures.length > 0 && <ul className="space-y-0.5">{size.figures.map((row) => <FigureLine key={row.row_id} row={row} pricedUnit={size.priced_unit} />)}</ul>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
