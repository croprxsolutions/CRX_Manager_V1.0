import { useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../ui/Toast';
import Button from '../ui/Button';
import { type DropdownOption } from '../ui/Dropdown';
import {
  saveApplicatorWorkEntry,
  type ApplicatorPhoneField,
  type ApplicatorPhoneJob,
  type WorkEntryWeatherDraft,
} from './applicatorPhoneApi';
import {
  GaugeSection,
  LoadSegmentsSection,
  NextLoadProposalSection,
  NotesSection,
  PauseFieldSection,
  RestrictedUseSection,
  SavedWorkEntriesSection,
  WeatherSection,
  WorkEntryTimingSection,
} from './ApplicatorWorkEntrySections';
import useApplicatorWorkEntryResources from './useApplicatorWorkEntryResources';
import {
  areSegmentsReady,
  centralSprayDate,
  displayError,
  formatSegmentAcres,
  getSegmentDrafts,
  localDateTimeValue,
  type SegmentInput,
} from './applicatorPhoneFormUtils';

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
  const [weather, setWeather] = useState<WorkEntryWeatherDraft>({ windSpeedMph: '', windDirection: '', temperatureF: '', humidityPercent: '' });
  const [notes, setNotes] = useState('');
  const [pauseField, setPauseField] = useState(false);
  const [acresLeft, setAcresLeft] = useState('');
  const [resumeNote, setResumeNote] = useState('');
  const [restrictedUseValues, setRestrictedUseValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const {
    savedEntries,
    loadChoices,
    restrictedFields,
    nextLoadProposal,
    entriesState,
    loadsState,
    restrictedState,
    proposalState,
  } = useApplicatorWorkEntryResources(job, field);

  const loadOptions: DropdownOption[] = useMemo(
    () => loadChoices.map((choice, index) => ({ value: String(index), label: choice.label })),
    [loadChoices],
  );
  const sprayDate = centralSprayDate(startedAt);
  const matchingEntries = useMemo(
    () => savedEntries.filter((entry) => entry.fieldId === field.fieldId && entry.sprayDateCentral === sprayDate),
    [field.fieldId, savedEntries, sprayDate],
  );
  const segmentAcresDisplay = useMemo(() => formatSegmentAcres(segments), [segments]);
  const proposalAcres = pauseField && acresLeft.trim() !== '' ? Number(acresLeft) : null;
  const proposalLabel = proposalAcres !== null && Number.isFinite(proposalAcres)
    ? `${acresLeft} acres to finish on field ${field.fieldName}`
    : nextLoadProposal
      ? `${nextLoadProposal.acresToFinish} acres to finish on field ${nextLoadProposal.fieldName}`
      : null;
  const proposalNote = pauseField ? resumeNote.trim() || null : nextLoadProposal?.resumeNote ?? null;
  const canSave = entriesState === 'ready'
    && loadsState === 'ready'
    && restrictedState === 'ready'
    && areSegmentsReady(segments, loadChoices)
    && !saving;
  const keyScope = `${job.id}:${field.fieldId}:${sprayDate ?? 'unknown-day'}`;

  function setSegmentValue(index: number, patch: Partial<SegmentInput>) {
    setSegments((current) => current.map((segment, segmentIndex) => segmentIndex === index ? { ...segment, ...patch } : segment));
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
        segments: getSegmentDrafts(segments, loadChoices),
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
      <WorkEntryTimingSection
        field={field}
        startedAt={startedAt}
        finishedAt={finishedAt}
        acresSprayed={acresSprayed}
        onStartedAtChange={setStartedAt}
        onFinishedAtChange={setFinishedAt}
        onAcresSprayedChange={setAcresSprayed}
        onStartedAtNow={() => setStartedAt(localDateTimeValue(new Date()))}
        onFinishedAtNow={() => setFinishedAt(localDateTimeValue(new Date()))}
      />
      <LoadSegmentsSection
        segments={segments}
        loadOptions={loadOptions}
        loadsState={loadsState}
        segmentAcresDisplay={segmentAcresDisplay}
        onAddSegment={() => setSegments((current) => [...current, { choiceIndex: '', acres: '' }])}
        onSegmentChange={setSegmentValue}
      />
      <GaugeSection gaugeOutcome={gaugeOutcome} gallonsLeft={gallonsLeft} onGaugeOutcomeChange={setGaugeOutcome} onGallonsLeftChange={setGallonsLeft} />
      <WeatherSection
        weather={weather}
        onWeatherChange={(weatherField, value) => setWeather((current) => ({ ...current, [weatherField]: value }))}
      />
      <RestrictedUseSection
        field={field}
        restrictedState={restrictedState}
        restrictedFields={restrictedFields}
        values={restrictedUseValues}
        onValueChange={(key, value) => setRestrictedUseValues((current) => ({ ...current, [key]: value }))}
      />
      <NotesSection notes={notes} onNotesChange={setNotes} />
      <PauseFieldSection
        paused={pauseField}
        acresLeft={acresLeft}
        resumeNote={resumeNote}
        onToggle={() => setPauseField((current) => !current)}
        onAcresLeftChange={setAcresLeft}
        onResumeNoteChange={setResumeNote}
      />
      <NextLoadProposalSection proposalLabel={proposalLabel} proposalNote={proposalNote} proposalState={proposalState} />
      <SavedWorkEntriesSection entries={savedEntries} matchingEntries={matchingEntries} entriesState={entriesState} sprayDate={sprayDate} />
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
