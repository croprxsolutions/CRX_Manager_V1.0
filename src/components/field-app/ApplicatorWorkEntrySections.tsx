import { Gauge, Plus } from 'lucide-react';
import Button from '../ui/Button';
import Dropdown, { type DropdownOption } from '../ui/Dropdown';
import Input from '../ui/Input';
import type {
  ApplicatorPhoneField,
  ApplicatorWorkEntrySummary,
  RestrictedUseFieldDefinition,
  WorkEntryWeatherDraft,
} from './applicatorPhoneApi';
import { formatDate, helperFor, type ResourceState, type SegmentInput } from './applicatorPhoneFormUtils';

export function WorkEntryTimingSection({
  field,
  startedAt,
  finishedAt,
  acresSprayed,
  onStartedAtChange,
  onFinishedAtChange,
  onAcresSprayedChange,
  onStartedAtNow,
  onFinishedAtNow,
}: {
  field: ApplicatorPhoneField;
  startedAt: string;
  finishedAt: string;
  acresSprayed: string;
  onStartedAtChange: (value: string) => void;
  onFinishedAtChange: (value: string) => void;
  onAcresSprayedChange: (value: string) => void;
  onStartedAtNow: () => void;
  onFinishedAtNow: () => void;
}) {
  return (
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
          <Input label="Start time" type="datetime-local" value={startedAt} onChange={(event) => onStartedAtChange(event.target.value)} className="h-11 text-base" />
          <Button variant="secondary" className="h-11 min-w-16" onClick={onStartedAtNow}>Now</Button>
        </div>
        <p className="-mt-2 text-xs text-gray-500">The spray date follows the start time in Central time.</p>
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Input label="Finish time" type="datetime-local" value={finishedAt} onChange={(event) => onFinishedAtChange(event.target.value)} className="h-11 text-base" />
          <Button variant="secondary" className="h-11 min-w-16" onClick={onFinishedAtNow}>Now</Button>
        </div>
        <Input
          label="Acres sprayed"
          type="number"
          inputMode="decimal"
          step="any"
          value={acresSprayed}
          onChange={(event) => onAcresSprayedChange(event.target.value)}
          className="h-12 text-lg font-semibold tabular-nums"
        />
      </div>
    </section>
  );
}

export function LoadSegmentsSection({
  segments,
  loadOptions,
  loadsState,
  segmentAcresDisplay,
  onAddSegment,
  onSegmentChange,
}: {
  segments: SegmentInput[];
  loadOptions: DropdownOption[];
  loadsState: ResourceState;
  segmentAcresDisplay: string | null;
  onAddSegment: () => void;
  onSegmentChange: (index: number, patch: Partial<SegmentInput>) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-labelledby="segments-heading">
      <div className="flex items-center justify-between gap-3 bg-cream-dark px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-crx-green text-white"><Gauge className="h-5 w-5" aria-hidden="true" /></span>
          <h2 id="segments-heading" className="font-heading text-xl font-bold text-nav-dark">Load segments</h2>
        </div>
        <Button variant="secondary" className="min-h-11" icon={<Plus className="h-4 w-4" />} onClick={onAddSegment}>Add segment</Button>
      </div>
      <div className="divide-y divide-gray-100">
        {segments.map((segment, index) => (
          <div key={`segment-${index + 1}`} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[1fr_8rem]">
            <Dropdown
              label={`Load and revision ${index + 1}`}
              value={segment.choiceIndex || null}
              options={loadOptions}
              onChange={(value) => onSegmentChange(index, { choiceIndex: value })}
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
              onChange={(event) => onSegmentChange(index, { acres: event.target.value })}
              disabled={loadsState !== 'ready' || loadOptions.length === 0}
              className="h-11 text-base tabular-nums"
            />
          </div>
        ))}
      </div>
      {segmentAcresDisplay && <p className="border-t border-gray-100 px-4 py-3 text-sm text-secondary">Segment acres total (display only): <strong className="tabular-nums text-nav-dark">{segmentAcresDisplay}</strong></p>}
      {loadsState !== 'ready' && <p className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{helperFor(loadsState, '', 'Load and revision choices are not available yet. Entries stay unsaved until they can be linked.', 'Load and revision choices could not be loaded. Retry after the connection is restored.')}</p>}
    </section>
  );
}

export function GaugeSection({ gaugeOutcome, gallonsLeft, onGaugeOutcomeChange, onGallonsLeftChange }: {
  gaugeOutcome: string;
  gallonsLeft: string;
  onGaugeOutcomeChange: (value: string) => void;
  onGallonsLeftChange: (value: string) => void;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="gauge-heading">
      <h2 id="gauge-heading" className="mb-3 font-heading text-xl font-bold text-nav-dark">Gauge reading</h2>
      <Dropdown
        label="When this load finished"
        value={gaugeOutcome || null}
        options={[{ value: 'ran_dry', label: 'Ran dry' }, { value: 'gallons_left', label: 'Gallons left' }]}
        onChange={onGaugeOutcomeChange}
        placeholder="Choose a reading"
        helper="Record this when a load finishes or the sprayer empties."
      />
      {gaugeOutcome === 'gallons_left' && (
        <Input label="Gallons left" type="number" inputMode="decimal" step="any" value={gallonsLeft} onChange={(event) => onGallonsLeftChange(event.target.value)} className="mt-3 h-11 text-base" />
      )}
    </section>
  );
}

export function WeatherSection({ weather, onWeatherChange }: {
  weather: WorkEntryWeatherDraft;
  onWeatherChange: (field: keyof WorkEntryWeatherDraft, value: string) => void;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="weather-heading">
      <h2 id="weather-heading" className="mb-3 font-heading text-xl font-bold text-nav-dark">Weather at start</h2>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Wind speed (mph)" type="number" inputMode="decimal" step="any" value={weather.windSpeedMph} onChange={(event) => onWeatherChange('windSpeedMph', event.target.value)} className="h-11 text-base" />
        <Input label="Wind direction" value={weather.windDirection} onChange={(event) => onWeatherChange('windDirection', event.target.value)} className="h-11 text-base" />
        <Input label="Temperature (°F)" type="number" inputMode="decimal" step="any" value={weather.temperatureF} onChange={(event) => onWeatherChange('temperatureF', event.target.value)} className="h-11 text-base" />
        <Input label="Humidity (%)" type="number" inputMode="decimal" step="any" value={weather.humidityPercent} onChange={(event) => onWeatherChange('humidityPercent', event.target.value)} className="h-11 text-base" />
      </div>
      <p className="mt-2 text-xs text-gray-500">Weather can be edited. Automatic fill for the start time is awaiting its data contract.</p>
    </section>
  );
}

export function RestrictedUseSection({ field, restrictedState, restrictedFields, values, onValueChange }: {
  field: ApplicatorPhoneField;
  restrictedState: ResourceState;
  restrictedFields: RestrictedUseFieldDefinition[];
  values: Record<string, string>;
  onValueChange: (key: string, value: string) => void;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="restricted-use-heading">
      <h2 id="restricted-use-heading" className="mb-2 font-heading text-xl font-bold text-nav-dark">Restricted-use details</h2>
      <p className="mb-3 text-sm text-secondary">{field.state ? `State: ${field.state}` : 'Field state is not available.'}</p>
      {restrictedState === 'ready' && restrictedFields.length > 0 ? (
        <div className="space-y-3">
          {restrictedFields.map((definition) => (
            <Input key={definition.key} label={definition.label} value={values[definition.key] ?? ''} onChange={(event) => onValueChange(definition.key, event.target.value)} className="h-11 text-base" />
          ))}
        </div>
      ) : (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {helperFor(restrictedState, 'No extra restricted-use fields are set for this state.', 'State-specific fields are not connected yet, so this entry cannot be saved.', 'State-specific fields could not be loaded.')}
        </p>
      )}
    </section>
  );
}

export function NotesSection({ notes, onNotesChange }: { notes: string; onNotesChange: (value: string) => void }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="notes-heading">
      <h2 id="notes-heading" className="mb-2 font-heading text-xl font-bold text-nav-dark">Notes</h2>
      <textarea
        aria-label="Work entry notes"
        value={notes}
        onChange={(event) => onNotesChange(event.target.value)}
        rows={3}
        className="min-h-24 w-full rounded-lg border border-gray-300 px-3 py-2 text-base text-nav-dark placeholder:text-gray-500 focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
        placeholder="Anything unusual to note"
      />
    </section>
  );
}

export function PauseFieldSection({ paused, acresLeft, resumeNote, onToggle, onAcresLeftChange, onResumeNoteChange }: {
  paused: boolean;
  acresLeft: string;
  resumeNote: string;
  onToggle: () => void;
  onAcresLeftChange: (value: string) => void;
  onResumeNoteChange: (value: string) => void;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4" aria-labelledby="pause-heading">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <div>
          <h2 id="pause-heading" className="font-heading text-xl font-bold text-nav-dark">Pause this field</h2>
          <p className="text-sm text-secondary">The job stays open for another day.</p>
        </div>
        <button
          type="button"
          aria-pressed={paused}
          onClick={onToggle}
          className={`min-h-11 rounded-lg border px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green ${paused ? 'border-crx-green bg-crx-green-light text-crx-green' : 'border-gray-300 bg-white text-nav-dark'}`}
        >{paused ? 'Paused' : 'Pause'}</button>
      </div>
      {paused && (
        <div className="mt-3 space-y-3">
          <Input label="Acres left" type="number" inputMode="decimal" step="any" value={acresLeft} onChange={(event) => onAcresLeftChange(event.target.value)} className="h-11 text-base" />
          <label className="block text-sm font-medium text-secondary" htmlFor="resume-note">Resume note</label>
          <textarea
            id="resume-note"
            value={resumeNote}
            onChange={(event) => onResumeNoteChange(event.target.value)}
            rows={2}
            className="min-h-20 w-full rounded-lg border border-gray-300 px-3 py-2 text-base text-nav-dark placeholder:text-gray-500 focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
            placeholder="What should the next applicator know?"
          />
        </div>
      )}
    </section>
  );
}

export function NextLoadProposalSection({ proposalLabel, proposalNote, proposalState }: {
  proposalLabel: string | null;
  proposalNote: string | null;
  proposalState: ResourceState;
}) {
  return (
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
  );
}

export function SavedWorkEntriesSection({ entries, matchingEntries, entriesState, sprayDate }: {
  entries: ApplicatorWorkEntrySummary[];
  matchingEntries: ApplicatorWorkEntrySummary[];
  entriesState: ResourceState;
  sprayDate: string | null;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-labelledby="saved-work-heading">
      <div className="bg-cream-dark px-4 py-3">
        <h2 id="saved-work-heading" className="font-heading text-xl font-bold text-nav-dark">Saved work entries</h2>
      </div>
      {entriesState === 'ready' && entries.length > 0 ? (
        <ul className="divide-y divide-gray-100">
          {entries.map((entry) => (
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
  );
}
