import { useEffect, useMemo, useState } from 'react';
import { Gauge, Plus, Save } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../ui/Toast';
import Button from '../ui/Button';
import Dropdown, { type DropdownOption } from '../ui/Dropdown';
import Input from '../ui/Input';
import {
  loadApplicatorLoadChoices,
  loadApplicatorWorkEntries,
  loadNextLoadProposal,
  loadRestrictedUseFieldDefinitions,
  saveApplicatorWorkEntry,
  ApplicatorPhoneContractPendingError,
  type ApplicatorLoadChoice,
  type ApplicatorPhoneField,
  type ApplicatorPhoneJob,
  type ApplicatorWorkEntrySummary,
  type NextLoadProposal,
  type RestrictedUseFieldDefinition,
  type WorkEntrySegmentDraft,
} from './applicatorPhoneApi';

interface SegmentInput {
  choiceIndex: string;
  acres: string;
}

type ResourceState = 'loading' | 'ready' | 'pending' | 'failed';

function localDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function centralSprayDate(dateTimeValue: string): string | null {
  if (!dateTimeValue) return null;
  const instant = new Date(dateTimeValue);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function formatDate(date: string): string {
  const [year, month, day] = date.split('-');
  return year && month && day ? `${month}/${day}/${year}` : date;
}

function displayError(error: unknown, fallback: string): string {
  return error instanceof ApplicatorPhoneContractPendingError ? error.message : fallback;
}

function errorState(error: unknown): ResourceState {
  return error instanceof ApplicatorPhoneContractPendingError ? 'pending' : 'failed';
}

function helperFor(state: ResourceState, readyText: string, pendingText: string, failedText: string): string {
  if (state === 'ready') return readyText;
  if (state === 'pending') return pendingText;
  if (state === 'failed') return failedText;
  return 'Loading…';
}

export default function ApplicatorWorkEntryForm({
  job,
  field,
  onSaved,
}: {
  job: ApplicatorPhoneJob;
  field: ApplicatorPhoneField;
  onSaved: () => void;
}) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const { getKeyFor, resetKeyFor } = useIdempotencyKey('field_app_work_entry', profile?.id ?? 'signed-out');
  const [startedAt, setStartedAt] = useState(() => localDateTimeValue(new Date()));
  const [finishedAt, setFinishedAt] = useState('');
  const [acresSprayed, setAcresSprayed] = useState(field.plannedAcres === null ? '' : String(field.plannedAcres));
  const [segments, setSegments] = useState<SegmentInput[]>([{ choiceIndex: '', acres: '' }]);
  const [gaugeOutcome, setGaugeOutcome] = useState('');
  const [gallonsLeft, setGallonsLeft] = useState('');
  const [weather, setWeather] = useState({ windSpeedMph: '', windDirection: '', temperatureF: '', humidityPercent: '' });
  const [notes, setNotes] = useState('');
  const [pauseField, setPauseField] = useState(false);
  const [acresLeft, setAcresLeft] = useState('');
  const [resumeNote, setResumeNote] = useState('');
  const [restrictedUseValues, setRestrictedUseValues] = useState<Record<string, string>>({});
  const [savedEntries, setSavedEntries] = useState<ApplicatorWorkEntrySummary[]>([]);
  const [loadChoices, setLoadChoices] = useState<ApplicatorLoadChoice[]>([]);
  const [restrictedFields, setRestrictedFields] = useState<RestrictedUseFieldDefinition[]>([]);
  const [nextLoadProposal, setNextLoadProposal] = useState<NextLoadProposal | null>(null);
  const [entriesState, setEntriesState] = useState<ResourceState>('loading');
  const [loadsState, setLoadsState] = useState<ResourceState>('loading');
  const [restrictedState, setRestrictedState] = useState<ResourceState>('loading');
  const [proposalState, setProposalState] = useState<ResourceState>('loading');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setEntriesState('loading');
    setLoadsState('loading');
    setRestrictedState('loading');
    setProposalState('loading');

    void Promise.allSettled([
      loadApplicatorWorkEntries(job.id, field.fieldId),
      loadApplicatorLoadChoices(job.id),
      loadRestrictedUseFieldDefinitions(field.state),
      loadNextLoadProposal(job.id, field.fieldId),
    ]).then(([entriesResult, loadsResult, restrictedResult, proposalResult]) => {
      if (!active) return;
      if (entriesResult.status === 'fulfilled') {
        setSavedEntries(entriesResult.value);
        setEntriesState('ready');
      } else {
        setEntriesState(errorState(entriesResult.reason));
      }
      if (loadsResult.status === 'fulfilled') {
        setLoadChoices(loadsResult.value);
        setLoadsState('ready');
      } else {
        setLoadsState(errorState(loadsResult.reason));
      }
      if (restrictedResult.status === 'fulfilled') {
        setRestrictedFields(restrictedResult.value);
        setRestrictedState('ready');
      } else {
        setRestrictedState(errorState(restrictedResult.reason));
      }
      if (proposalResult.status === 'fulfilled') {
        setNextLoadProposal(proposalResult.value);
        setProposalState('ready');
      } else {
        setProposalState(errorState(proposalResult.reason));
      }
    });

    return () => { active = false; };
  }, [field.fieldId, field.state, job.id]);

  const loadOptions: DropdownOption[] = useMemo(
    () => loadChoices.map((choice, index) => ({ value: String(index), label: choice.label })),
    [loadChoices],
  );
  const sprayDate = centralSprayDate(startedAt);
  const matchingEntries = useMemo(
    () => savedEntries.filter((entry) => entry.fieldId === field.fieldId && entry.sprayDateCentral === sprayDate),
    [field.fieldId, savedEntries, sprayDate],
  );
  const segmentAcresDisplay = useMemo(() => {
    const values = segments.map((segment) => Number(segment.acres)).filter((value) => Number.isFinite(value));
    if (values.length === 0 || values.length !== segments.length || segments.some((segment) => segment.acres.trim() === '')) return null;
    return values.reduce((sum, value) => sum + value, 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }, [segments]);
  const proposalAcres = pauseField && acresLeft.trim() !== '' ? Number(acresLeft) : null;
  const proposalLabel = proposalAcres !== null && Number.isFinite(proposalAcres)
    ? `${acresLeft} acres to finish on field ${field.fieldName}`
    : nextLoadProposal
      ? `${nextLoadProposal.acresToFinish} acres to finish on field ${nextLoadProposal.fieldName}`
      : null;
  const proposalNote = pauseField ? resumeNote.trim() || null : nextLoadProposal?.resumeNote ?? null;
  const segmentsReady = segments.length > 0 && segments.every((segment) => {
    const choiceIndex = Number(segment.choiceIndex);
    return segment.choiceIndex !== '' && Number.isInteger(choiceIndex) && Boolean(loadChoices[choiceIndex]) && segment.acres.trim() !== '';
  });
  const canSave = entriesState === 'ready'
    && loadsState === 'ready'
    && restrictedState === 'ready'
    && segmentsReady
    && !saving;
  const keyScope = `${job.id}:${field.fieldId}:${sprayDate ?? 'unknown-day'}`;

  function setSegmentValue(index: number, patch: Partial<SegmentInput>) {
    setSegments((current) => current.map((segment, segmentIndex) => segmentIndex === index ? { ...segment, ...patch } : segment));
  }

  function getSegmentDrafts(): WorkEntrySegmentDraft[] {
    return segments.flatMap((segment) => {
      const choiceIndex = Number(segment.choiceIndex);
      const choice = loadChoices[choiceIndex];
      return choice ? [{ loadId: choice.loadId, revisionId: choice.revisionId, acres: segment.acres }] : [];
    });
  }

  async function saveEntry() {
    if (!canSave) return;
    const idempotencyKey = getKeyFor(keyScope);
    setSaving(true);
    try {
      await saveApplicatorWorkEntry({
        jobId: job.id,
        fieldId: field.fieldId,
        startedAt,
        finishedAt,
        acresSprayed,
        segments: getSegmentDrafts(),
        gauge: gaugeOutcome === 'ran_dry' || gaugeOutcome === 'gallons_left'
          ? { outcome: gaugeOutcome, gallonsLeft: gaugeOutcome === 'gallons_left' ? gallonsLeft : '' }
          : null,
        weather,
        restrictedUseValues,
        notes,
        pause: pauseField ? { acresLeft, resumeNote } : null,
      }, idempotencyKey);
      resetKeyFor(keyScope);
      toast('success', 'Work entry saved.');
      onSaved();
    } catch (error) {
      toast('warning', displayError(error, 'Work entry could not be saved. Nothing was saved.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 pb-28">
      <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="today-entry-heading">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="today-entry-heading" className="font-heading text-xl font-bold text-nav-dark">Today's work entry</h2>
            <p className="mt-1 text-sm text-secondary">{field.fieldName}{field.state ? ` · ${field.state}` : ''}</p>
          </div>
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-sm font-semibold tabular-nums text-nav-dark">
            {field.plannedAcres === null ? 'Acres not set' : `${field.plannedAcres} planned acres`}
          </span>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <Input
              label="Start time"
              type="datetime-local"
              value={startedAt}
              onChange={(event) => setStartedAt(event.target.value)}
              className="h-11 text-base"
            />
            <Button variant="secondary" className="h-11 min-w-16" onClick={() => setStartedAt(localDateTimeValue(new Date()))}>Now</Button>
          </div>
          <p className="-mt-2 text-xs text-gray-500">The spray date follows the start time in Central time.</p>

          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <Input
              label="Finish time"
              type="datetime-local"
              value={finishedAt}
              onChange={(event) => setFinishedAt(event.target.value)}
              className="h-11 text-base"
            />
            <Button variant="secondary" className="h-11 min-w-16" onClick={() => setFinishedAt(localDateTimeValue(new Date()))}>Now</Button>
          </div>

          <Input
            label="Acres sprayed"
            type="number"
            inputMode="decimal"
            step="any"
            value={acresSprayed}
            onChange={(event) => setAcresSprayed(event.target.value)}
            className="h-12 text-lg font-semibold tabular-nums"
          />
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-labelledby="segments-heading">
        <div className="flex items-center justify-between gap-3 bg-cream-dark px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-crx-green text-white"><Gauge className="h-5 w-5" aria-hidden="true" /></span>
            <h2 id="segments-heading" className="font-heading text-xl font-bold text-nav-dark">Load segments</h2>
          </div>
          <Button
            variant="secondary"
            className="min-h-11"
            icon={<Plus className="h-4 w-4" />}
            onClick={() => setSegments((current) => [...current, { choiceIndex: '', acres: '' }])}
          >Add segment</Button>
        </div>
        <div className="divide-y divide-gray-100">
          {segments.map((segment, index) => (
            <div key={`segment-${index + 1}`} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[1fr_8rem]">
              <Dropdown
                label={`Load and revision ${index + 1}`}
                value={segment.choiceIndex || null}
                options={loadOptions}
                onChange={(value) => setSegmentValue(index, { choiceIndex: value })}
                disabled={loadsState !== 'ready' || loadOptions.length === 0}
                placeholder={loadsState === 'ready' ? 'No loads available' : 'Load choices unavailable'}
                helper={helperFor(loadsState, 'Select the load revision used on this field.', 'Load choices are not connected yet.', 'Load choices could not be loaded.')}
              />
              <Input
                label="Acres"
                type="number"
                inputMode="decimal"
                step="any"
                value={segment.acres}
                onChange={(event) => setSegmentValue(index, { acres: event.target.value })}
                disabled={loadsState !== 'ready' || loadOptions.length === 0}
                className="h-11 text-base tabular-nums"
              />
            </div>
          ))}
        </div>
        {segmentAcresDisplay && <p className="border-t border-gray-100 px-4 py-3 text-sm text-secondary">Segment acres total (display only): <strong className="tabular-nums text-nav-dark">{segmentAcresDisplay}</strong></p>}
        {loadsState !== 'ready' && <p className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{helperFor(loadsState, '', 'Load and revision choices are not available yet. Entries stay unsaved until they can be linked.', 'Load and revision choices could not be loaded. Retry after the connection is restored.')}</p>}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="gauge-heading">
        <h2 id="gauge-heading" className="mb-3 font-heading text-xl font-bold text-nav-dark">Gauge reading</h2>
        <Dropdown
          label="When this load finished"
          value={gaugeOutcome || null}
          options={[
            { value: 'ran_dry', label: 'Ran dry' },
            { value: 'gallons_left', label: 'Gallons left' },
          ]}
          onChange={(value) => setGaugeOutcome(value)}
          placeholder="Choose a reading"
          helper="Record this when a load finishes or the sprayer empties."
        />
        {gaugeOutcome === 'gallons_left' && (
          <Input
            label="Gallons left"
            type="number"
            inputMode="decimal"
            step="any"
            value={gallonsLeft}
            onChange={(event) => setGallonsLeft(event.target.value)}
            className="mt-3 h-11 text-base"
          />
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="weather-heading">
        <h2 id="weather-heading" className="mb-3 font-heading text-xl font-bold text-nav-dark">Weather at start</h2>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Wind speed (mph)" type="number" inputMode="decimal" step="any" value={weather.windSpeedMph} onChange={(event) => setWeather((current) => ({ ...current, windSpeedMph: event.target.value }))} className="h-11 text-base" />
          <Input label="Wind direction" value={weather.windDirection} onChange={(event) => setWeather((current) => ({ ...current, windDirection: event.target.value }))} className="h-11 text-base" />
          <Input label="Temperature (°F)" type="number" inputMode="decimal" step="any" value={weather.temperatureF} onChange={(event) => setWeather((current) => ({ ...current, temperatureF: event.target.value }))} className="h-11 text-base" />
          <Input label="Humidity (%)" type="number" inputMode="decimal" step="any" value={weather.humidityPercent} onChange={(event) => setWeather((current) => ({ ...current, humidityPercent: event.target.value }))} className="h-11 text-base" />
        </div>
        <p className="mt-2 text-xs text-gray-500">Weather can be edited. Automatic fill for the start time is awaiting its data contract.</p>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="restricted-use-heading">
        <h2 id="restricted-use-heading" className="mb-2 font-heading text-xl font-bold text-nav-dark">Restricted-use details</h2>
        <p className="mb-3 text-sm text-secondary">{field.state ? `State: ${field.state}` : 'Field state is not available.'}</p>
        {restrictedState === 'ready' && restrictedFields.length > 0 ? (
          <div className="space-y-3">
            {restrictedFields.map((definition) => (
              <Input
                key={definition.key}
                label={definition.label}
                value={restrictedUseValues[definition.key] ?? ''}
                onChange={(event) => setRestrictedUseValues((current) => ({ ...current, [definition.key]: event.target.value }))}
                className="h-11 text-base"
              />
            ))}
          </div>
        ) : (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            {helperFor(restrictedState, 'No extra restricted-use fields are set for this state.', 'State-specific fields are not connected yet, so this entry cannot be saved.', 'State-specific fields could not be loaded.')}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="notes-heading">
        <h2 id="notes-heading" className="mb-2 font-heading text-xl font-bold text-nav-dark">Notes</h2>
        <textarea
          aria-label="Work entry notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={3}
          className="min-h-24 w-full rounded-lg border border-gray-300 px-3 py-2 text-base text-nav-dark placeholder:text-gray-500 focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
          placeholder="Anything unusual to note"
        />
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="pause-heading">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <div>
            <h2 id="pause-heading" className="font-heading text-xl font-bold text-nav-dark">Pause this field</h2>
            <p className="text-sm text-secondary">The job stays open for another day.</p>
          </div>
          <button
            type="button"
            aria-pressed={pauseField}
            onClick={() => setPauseField((current) => !current)}
            className={`min-h-11 rounded-lg border px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green ${pauseField ? 'border-crx-green bg-crx-green-light text-crx-green' : 'border-gray-300 bg-white text-nav-dark'}`}
          >{pauseField ? 'Paused' : 'Pause'}</button>
        </div>
        {pauseField && (
          <div className="mt-3 space-y-3">
            <Input label="Acres left" type="number" inputMode="decimal" step="any" value={acresLeft} onChange={(event) => setAcresLeft(event.target.value)} className="h-11 text-base" />
            <label className="block text-sm font-medium text-secondary" htmlFor="resume-note">Resume note</label>
            <textarea
              id="resume-note"
              value={resumeNote}
              onChange={(event) => setResumeNote(event.target.value)}
              rows={2}
              className="min-h-20 w-full rounded-lg border border-gray-300 px-3 py-2 text-base text-nav-dark placeholder:text-gray-500 focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
              placeholder="What should the next applicator know?"
            />
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="next-load-heading">
        <h2 id="next-load-heading" className="font-heading text-xl font-bold text-nav-dark">Next load proposal</h2>
        {proposalLabel ? (
          <div className="mt-2 rounded-lg bg-crx-green-light p-3">
            <p className="font-semibold text-crx-green">{proposalLabel}</p>
            {proposalNote && <p className="mt-1 text-sm text-nav-dark">Resume note: {proposalNote}</p>}
          </div>
        ) : (
          <p className="mt-2 text-sm text-secondary">
            {helperFor(proposalState, 'No remaining acres are proposed for another load.', 'The next-load proposal will appear when work entries are connected.', 'The next-load proposal could not be loaded.')}
          </p>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-labelledby="saved-work-heading">
        <div className="bg-cream-dark px-4 py-3">
          <h2 id="saved-work-heading" className="font-heading text-xl font-bold text-nav-dark">Saved work entries</h2>
        </div>
        {entriesState === 'ready' && savedEntries.length > 0 ? (
          <ul className="divide-y divide-gray-100">
            {savedEntries.map((entry) => (
              <li key={entry.id} className="px-4 py-3">
                <p className="font-semibold text-nav-dark">{formatDate(entry.sprayDateCentral)} · {entry.acresSprayed} acres</p>
                {entry.resumeNote && <p className="mt-1 text-sm text-secondary">Resume note: {entry.resumeNote}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-secondary">
            {helperFor(entriesState, 'No saved work entries for this field yet.', 'Saved work entries and same-day duplicate warnings are not connected yet.', 'Saved work entries could not be loaded.')}
          </p>
        )}
        {matchingEntries.length > 0 && (
          <p role="alert" className="border-t-4 border-amber-500 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
            A work entry already exists for this field on {sprayDate}. The office may need to review this as a second pass.
          </p>
        )}
      </section>

      <div className="fixed inset-x-0 bottom-14 z-20 border-t border-gray-200 bg-white p-3 md:static md:border-0 md:bg-transparent md:p-0">
        <Button
          className="h-14 w-full font-heading text-lg font-bold"
          icon={<Save className="h-5 w-5" aria-hidden="true" />}
          loading={saving}
          disabled={!canSave}
          onClick={() => void saveEntry()}
        >Save work entry</Button>
        {!canSave && <p className="mt-1 text-center text-xs text-secondary">Saving opens when today's entries, load revisions, and state fields are available.</p>}
      </div>
    </div>
  );
}
