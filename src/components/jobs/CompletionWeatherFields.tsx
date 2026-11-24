/**
 * CompletionWeatherFields.tsx — the weather part of the phone Complete Job form (FieldView).
 *
 * Saves exactly what the old typed boxes saved: four strings that FieldView sends to
 * complete_job as before. Wind direction stays free text (the database takes any text up to
 * 64 characters, and Open-Meteo prefills elsewhere write 16-point values like "NNW"), so the
 * compass buttons only write the same short strings an applicator typed ("NW"), and the box
 * still takes anything else. "Use last weather" fills the boxes only when tapped, from the
 * newest weather saved today on one of the applicator's own jobs; nothing is saved until they
 * press Complete Job, so they can check and change every value first.
 */
import { useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { businessDayStartIso, localToday } from '../../lib/dateUtils';
import { chunkIds } from '../../lib/dispatchDisplay';
import { useToast } from '../ui/Toast';

export interface WeatherValues {
  wind_speed: string;
  wind_direction: string;
  temperature: string;
  humidity: string;
}

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

interface LastWeatherRow {
  job_id: string;
  wind_speed: number | null;
  wind_direction: string | null;
  temperature: number | null;
  humidity: number | null;
  updated_at: string;
}

/** The newest weather saved today on any of these jobs, or null when there is none. */
async function readLastWeatherToday(jobIds: string[]): Promise<LastWeatherRow | null> {
  const since = businessDayStartIso(localToday());
  let newest: LastWeatherRow | null = null;
  for (const chunk of chunkIds(jobIds)) {
    const { data, error } = await supabase
      .from('job_applied_info')
      .select('job_id, wind_speed, wind_direction, temperature, humidity, updated_at')
      .in('job_id', chunk)
      .gte('updated_at', since)
      .or('wind_speed.not.is.null,wind_direction.not.is.null,temperature.not.is.null,humidity.not.is.null')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = (data ?? [])[0] as LastWeatherRow | undefined;
    if (row && (!newest || row.updated_at > newest.updated_at)) newest = row;
  }
  return newest;
}

/** Only the values the earlier job has; a blank there never wipes what was typed here. */
function patchFrom(row: LastWeatherRow): Partial<WeatherValues> {
  const patch: Partial<WeatherValues> = {};
  if (row.wind_speed != null) patch.wind_speed = String(row.wind_speed);
  if (row.wind_direction) patch.wind_direction = row.wind_direction;
  if (row.temperature != null) patch.temperature = String(row.temperature);
  if (row.humidity != null) patch.humidity = String(row.humidity);
  return patch;
}

const INPUT_CLASS = 'h-11 w-full bg-white border border-gray-300 rounded-lg px-3 text-base text-nav-dark placeholder:text-gray-500';

function NumberBox({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold text-nav-dark mb-1">{label}</span>
      <input type="number" inputMode="decimal" step="any" value={value} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS} />
    </label>
  );
}

export default function CompletionWeatherFields({ value, onChange, otherJobs }: {
  value: WeatherValues;
  onChange: (patch: Partial<WeatherValues>) => void;
  /** The applicator's other jobs on this screen (the one being completed left out). */
  otherJobs: { job_id: string; job_number: string }[];
}) {
  const { toast } = useToast();
  const [looking, setLooking] = useState(false);

  const fillFromLastWeather = async () => {
    setLooking(true);
    try {
      const row = await readLastWeatherToday(otherJobs.map((j) => j.job_id));
      if (!row) {
        toast('info', 'No weather saved on your jobs today yet.');
      } else {
        onChange(patchFrom(row));
        const jobNumber = otherJobs.find((j) => j.job_id === row.job_id)?.job_number ?? 'your last job';
        const at = new Date(row.updated_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        toast('info', `Filled from ${jobNumber} (${at}). Check it before you complete.`);
      }
    } catch (err) {
      Sentry.captureException(err, { level: 'warning', extra: { context: 'Use last weather read failed' } });
      toast('error', "Couldn't load your last weather. Type it in instead.");
    }
    setLooking(false);
  };

  return (
    <div className="mb-3">
      {otherJobs.length > 0 && (
        <button
          type="button"
          onClick={() => void fillFromLastWeather()}
          disabled={looking}
          className="mb-2 inline-flex h-11 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-base font-semibold text-nav-dark active:scale-[0.99] disabled:opacity-50"
        >
          {looking ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <History className="w-4 h-4" aria-hidden="true" />}
          {looking ? 'Looking…' : 'Use last weather'}
        </button>
      )}
      <div className="grid grid-cols-2 gap-2">
        <NumberBox label="Wind Speed (mph)" value={value.wind_speed} onChange={(v) => onChange({ wind_speed: v })} />
        <NumberBox label="Temperature (°F)" value={value.temperature} onChange={(v) => onChange({ temperature: v })} />
        <NumberBox label="Humidity (%)" value={value.humidity} onChange={(v) => onChange({ humidity: v })} />
        <fieldset className="col-span-2">
          <legend className="block text-sm font-semibold text-nav-dark mb-1">Wind Direction</legend>
          <div className="grid grid-cols-4 gap-1.5 mb-1.5">
            {COMPASS_POINTS.map((point) => {
              const selected = value.wind_direction === point;
              return (
                <button
                  key={point}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onChange({ wind_direction: point })}
                  className={`h-11 rounded-lg border text-base font-semibold active:scale-[0.99] ${
                    selected ? 'border-crx-green bg-crx-green text-white' : 'border-gray-300 bg-white text-nav-dark'
                  }`}
                >
                  {point}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            aria-label="Wind direction (type another)"
            value={value.wind_direction}
            placeholder="Or type, e.g. NNW"
            onChange={(e) => onChange({ wind_direction: e.target.value })}
            className={INPUT_CLASS}
          />
        </fieldset>
      </div>
    </div>
  );
}
