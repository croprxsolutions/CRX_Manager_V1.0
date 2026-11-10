import { useEffect, useRef, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Badge from '../ui/Badge';
import ConfirmModal from '../ui/ConfirmModal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { addUseTimingOption, groupUseTimingOptionsByCrop, setUseTimingOptionActive } from '../../lib/productUseTimings';
import type { CropOption, UseTimingOption } from '../../types';

const CATEGORIES: Array<UseTimingOption['category']> = ['Herbicide', 'Foliar Fertilizer'];
const NEW_TIMING = '__new';
const selectClass = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-nav-dark focus-visible:ring-2 focus-visible:ring-crx-green disabled:opacity-50';
const isRefusal = (error: unknown) => /^USE_TIMING_[A-Z_]+/.test(error instanceof Error ? error.message
  : String((error as { message?: unknown } | null)?.message ?? ''));

/** Admin list of crop + timing choices (USE-1): add one, or turn one off or back on. */
export default function UseTimingChoicesModal({ options, crops, defaultCategory, profileId, onReload, onClose }: {
  options: UseTimingOption[];
  crops: CropOption[];
  defaultCategory: string | null | undefined;
  profileId: string;
  onReload: () => Promise<UseTimingOption[]>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [category, setCategory] = useState<UseTimingOption['category']>(
    CATEGORIES.find((item) => item === defaultCategory) ?? 'Herbicide');
  const [timing, setTiming] = useState('');
  const [newTiming, setNewTiming] = useState('');
  const [crop, setCrop] = useState('');
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState<UseTimingOption | null>(null);
  const addKey = useIdempotencyKey('add_use_timing_option', profileId);
  const toggleKey = useIdempotencyKey('set_use_timing_option_active', profileId);
  // A reply that lands after the box closed is ignored.
  const open = useRef(true);
  useEffect(() => () => { open.current = false; }, []);

  const timingCode = timing === NEW_TIMING ? newTiming.trim() : timing;
  const timingCodes = [...new Set(options.map((option) => option.timing_code))].sort();
  const exampleFor = (code: string) => options.find((option) => option.timing_code === code)?.label;
  const busy = adding || busyCode !== null;
  const canAdd = !busy && timingCode !== '' && label.trim() !== '';

  const reload = async () => {
    try {
      return await onReload();
    } catch (error) {
      if (open.current) toast('error', `The list could not be refreshed: ${sanitizeError(error)}`);
      return null;
    }
  };

  const add = async () => {
    const request = { category, timingCode, crop: crop || null, label: label.trim() };
    // One key per exact request: an edited retry is a new request, an unchanged retry replays the first answer.
    const scope = JSON.stringify(request);
    setAdding(true);
    try {
      const added = await addUseTimingOption({ ...request, key: addKey.getKeyFor(scope) });
      addKey.resetKeyFor(scope);
      await reload();
      if (!open.current) return;
      toast('success', `Added "${added.label}". It is now a choice for ${added.category} products.`);
      setLabel('');
    } catch (error) {
      if (isRefusal(error)) {
        if (open.current) toast('error', sanitizeError(error));
        return;
      }
      // No answer (for example a timeout): the add may have saved. Check before the form unlocks.
      const fresh = await reload();
      if (!open.current) return;
      const saved = fresh?.find((option) => option.label.toLowerCase() === request.label.toLowerCase()
        && option.category === request.category && option.timing_code === request.timingCode
        && (option.crop ?? null) === request.crop);
      if (saved) {
        addKey.resetKeyFor(scope);
        toast('success', `Added "${saved.label}" (confirmed after the connection dropped).`);
        setLabel('');
      } else {
        toast('error', `"${request.label}" is not on the list yet: ${sanitizeError(error)}. Try again; a retry cannot add it twice.`);
      }
    } finally {
      if (open.current) setAdding(false);
    }
  };

  const setActive = async (option: UseTimingOption, isActive: boolean) => {
    setConfirmOff(null);
    if (option.option_version === undefined) {
      toast('error', 'Refresh the page before changing this choice.');
      return;
    }
    const scope = JSON.stringify([option.code, isActive, option.option_version]);
    setBusyCode(option.code);
    try {
      const result = await setUseTimingOptionActive({
        code: option.code, isActive, expectedVersion: option.option_version, key: toggleKey.getKeyFor(scope),
      });
      toggleKey.resetKeyFor(scope);
      if (open.current) {
        toast('success', isActive
          ? `Turned on "${result.label}".`
          : `Turned off "${result.label}". New picks no longer offer it; ${result.sizes_holding} product size(s) and ${result.parents_holding} parent(s) keep it until someone removes it.`);
      }
    } catch (error) {
      if (!open.current) return;
      toast('error', hasRpcCode(error, RpcErrorCodes.USE_TIMING_STALE)
        ? `Someone else just changed "${option.label}". The list is refreshed; check it and try again.`
        : sanitizeError(error));
    } finally {
      // Reload after every answer, so the next click sends the current version.
      await reload();
      if (open.current) setBusyCode(null);
    }
  };

  return (
    <>
      <Modal open onClose={onClose} closeDisabled={busy} title="Crop and timing choices" size="large"
        footer={<Button variant="secondary" onClick={onClose} disabled={busy}>Close</Button>}>
        <div className="space-y-4">
          <fieldset disabled={busy} className="space-y-3 rounded-lg border border-gray-200 p-3">
            <legend className="px-1 text-sm font-semibold text-nav-dark">Add a crop and timing</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="timing-choice-category" className="mb-1 block text-sm font-medium text-secondary">Category</label>
                <select id="timing-choice-category" className={selectClass} value={category}
                  onChange={(event) => setCategory(event.target.value as UseTimingOption['category'])}>
                  {CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="timing-choice-crop" className="mb-1 block text-sm font-medium text-secondary">Crop</label>
                <select id="timing-choice-crop" className={selectClass} value={crop} onChange={(event) => setCrop(event.target.value)}>
                  <option value="">Any crop</option>
                  {crops.filter((item) => item.is_active).map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="timing-choice-timing" className="mb-1 block text-sm font-medium text-secondary">Timing</label>
                <select id="timing-choice-timing" className={selectClass} value={timing} onChange={(event) => setTiming(event.target.value)}>
                  <option value="">-- Select --</option>
                  {timingCodes.map((code) => (
                    <option key={code} value={code}>{code}{exampleFor(code) ? ` (as in ${exampleFor(code)})` : ''}</option>
                  ))}
                  <option value={NEW_TIMING}>A new timing...</option>
                </select>
              </div>
              {timing === NEW_TIMING && (
                <Input label="New timing code" value={newTiming} maxLength={60} placeholder="for example layby"
                  onChange={(event) => setNewTiming(event.target.value)} />
              )}
              <Input label="Name shown on products" value={label} maxLength={60} placeholder="for example Post-Emerge Wheat"
                onChange={(event) => setLabel(event.target.value)} />
            </div>
            <div className="flex justify-end">
              <Button onClick={() => void add()} loading={adding} disabled={!canAdd}>Add choice</Button>
            </div>
          </fieldset>

          {CATEGORIES.map((item) => {
            const groups = groupUseTimingOptionsByCrop(options.filter((option) => option.category === item), crops);
            if (groups.length === 0) return null;
            return (
              <section key={item} aria-label={`${item} choices`}>
                <h3 className="mb-1 text-sm font-semibold text-nav-dark">{item}</h3>
                <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                  {groups.flatMap((group) => group.options.map((option) => (
                    <div key={option.code} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <span className="font-medium text-nav-dark">{option.label}</span>
                        <span className="ml-2 text-secondary">{group.label} · {option.timing_code}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={option.is_active ? 'success' : 'default'}>{option.is_active ? 'On' : 'Off'}</Badge>
                        <Button size="sm" variant="secondary" disabled={busy} loading={busyCode === option.code}
                          onClick={() => (option.is_active ? setConfirmOff(option) : void setActive(option, true))}>
                          {option.is_active ? 'Turn off' : 'Turn on'}
                        </Button>
                      </div>
                    </div>
                  )))}
                </div>
              </section>
            );
          })}
        </div>
      </Modal>
      <ConfirmModal
        open={confirmOff !== null}
        title="Turn off this choice?"
        message={`"${confirmOff?.label ?? ''}" will no longer be offered when picking a use timing. Products that already have it keep it until someone removes it.`}
        confirmLabel="Turn off"
        variant="warning"
        onClose={() => setConfirmOff(null)}
        onConfirm={() => { if (confirmOff) void setActive(confirmOff, false); }}
      />
    </>
  );
}
